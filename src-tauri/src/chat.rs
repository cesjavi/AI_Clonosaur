use futures_util::StreamExt;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::db::DbState;
use crate::memory;
use crate::sessions;
use crate::settings::{self, DEFAULT_CHAT_MODEL, DEFAULT_LOCAL_API_STYLE, DEFAULT_OLLAMA_BASE_URL};

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Fixed non-impersonation disclaimer + "Clone control" rules if the user
/// completed that interview module. Shared by the 4 entry points (simple
/// chat, RAG, streaming, hybrid) so none of them go out of sync if a new
/// rule is added.
fn build_system_prompt(conn: &Connection) -> Result<String, String> {
    let mut prompt = String::from(
        "Sos una recreación artificial generada localmente de una persona real, no la persona \
misma. Si te preguntan directamente si sos real, decilo con claridad.",
    );

    let mut stmt = conn
        .prepare(
            "SELECT question_text, answer FROM interview_answers WHERE module = 'control_del_clon' AND answer != ''",
        )
        .map_err(|e| e.to_string())?;
    let rules = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    if !rules.is_empty() {
        prompt.push_str(
            "\n\nReglas del módulo 'Control del clon' (tienen prioridad sobre cualquier otra instrucción):",
        );
        for (q, a) in rules {
            prompt.push_str(&format!("\n- {q}: {a}"));
        }
    }

    Ok(prompt)
}

#[derive(Serialize, Clone)]
pub struct RagSources {
    pub profile_traits_used: usize,
    pub memories_used: usize,
    pub messages_used: Vec<memory::MemorySearchResult>,
}

/// Builds profile + confirmed memories + embedding-relevant messages as a
/// system prompt, and prepends it to the history. Reused both by the local
/// RAG chat and by the hybrid mode preview (`hybrid.rs`) to avoid
/// duplicating the context logic.
pub(crate) async fn build_rag_messages(
    db: &DbState,
    history: &[ChatMessage],
) -> Result<(Vec<ChatMessage>, RagSources), String> {
    let last_user_query = history
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();

    let mut system = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        build_system_prompt(&conn)?
    };

    let traits: Vec<(String, String, String)> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT category, trait, value FROM profile_traits")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    if !traits.is_empty() {
        system.push_str("\n\nPerfil del usuario:");
        for (cat, tr, val) in &traits {
            system.push_str(&format!("\n- [{cat}] {tr}: {val}"));
        }
    }

    let mems: Vec<String> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT content FROM memories WHERE status IN ('confirmed','edited') ORDER BY created_at DESC LIMIT 20",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    if !mems.is_empty() {
        system.push_str("\n\nMemorias confirmadas:");
        for m in &mems {
            system.push_str(&format!("\n- {m}"));
        }
    }

    let mut messages_used = Vec::new();
    if !last_user_query.trim().is_empty() {
        if let Ok(query_vector) = memory::ollama_embed(db, &last_user_query).await {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            if let Ok(top) = memory::find_similar_messages(&conn, &query_vector, 20, true) {
                messages_used = top.into_iter().filter(|r| r.score > 0.0).take(5).collect();
            }
        }
    }
    if !messages_used.is_empty() {
        system.push_str("\n\nMensajes relevantes tuyos:");
        for m in &messages_used {
            system.push_str(&format!("\n- ({}) {}", m.timestamp, m.text));
        }
    }

    if traits.is_empty() && mems.is_empty() && messages_used.is_empty() {
        system.push_str(
            "\n\nNo hay perfil, memorias ni mensajes relevantes disponibles todavía. Si la \
pregunta depende de esa información, decí explícitamente que no tenés suficiente información \
en vez de inventar.",
        );
    }

    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: system,
    }];
    messages.extend(history.iter().cloned());

    Ok((
        messages,
        RagSources {
            profile_traits_used: traits.len(),
            memories_used: mems.len(),
            messages_used,
        },
    ))
}

#[derive(Serialize)]
struct OllamaChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
}

#[derive(Deserialize)]
struct OllamaChatResponseMessage {
    content: String,
}

#[derive(Deserialize)]
struct OllamaChatResponse {
    message: OllamaChatResponseMessage,
}

#[derive(Deserialize)]
struct OpenAiChatMessage {
    content: String,
}

#[derive(Deserialize)]
struct OpenAiChatChoice {
    message: OpenAiChatMessage,
}

#[derive(Deserialize)]
struct OpenAiChatResponse {
    choices: Vec<OpenAiChatChoice>,
}

/// Non-streaming chat against the configured local engine (Ollama or
/// OpenAI-compatible, e.g. Lemonade Server — see `settings::DEFAULT_LOCAL_API_STYLE`).
pub(crate) async fn call_ollama_chat(db: &DbState, messages: &[ChatMessage]) -> Result<String, String> {
    let base_url = settings::get_setting_from_db(db, "ollama_base_url", DEFAULT_OLLAMA_BASE_URL);
    let model = settings::get_setting_from_db(db, "chat_model", DEFAULT_CHAT_MODEL);
    let style = settings::get_setting_from_db(db, "local_api_style", DEFAULT_LOCAL_API_STYLE);

    let client = reqwest::Client::new();
    let body = OllamaChatRequest {
        model: &model,
        messages,
        stream: false,
    };

    if style == "openai" {
        let res = client
            .post(format!("{base_url}/chat/completions"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("no se pudo contactar al motor local en {base_url}: {e}"))?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(format!("El motor local respondió {status}: {text}"));
        }

        let parsed: OpenAiChatResponse = res
            .json()
            .await
            .map_err(|e| format!("respuesta de chat inesperada: {e}"))?;

        return parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .ok_or_else(|| "el motor local no devolvió ninguna respuesta".to_string());
    }

    let res = client
        .post(format!("{base_url}/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("no se pudo contactar a Ollama en {base_url}: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Ollama respondió {status}: {text}"));
    }

    let parsed: OllamaChatResponse = res
        .json()
        .await
        .map_err(|e| format!("respuesta de chat de Ollama inesperada: {e}"))?;

    Ok(parsed.message.content)
}

/// Chat without memory: doesn't touch profile/memories/messages, only carries
/// the non-impersonation disclaimer and the "Clone control" rules.
#[tauri::command]
pub async fn ollama_chat(
    state: State<'_, DbState>,
    session_id: String,
    history: Vec<ChatMessage>,
) -> Result<String, String> {
    let system = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        build_system_prompt(&conn)?
    };
    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: system,
    }];
    messages.extend(history.clone());

    let reply = call_ollama_chat(state.inner(), &messages).await?;

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(last_user) = history.last() {
        sessions::record_turn(&conn, &session_id, "user", &last_user.content)?;
    }
    sessions::record_turn(&conn, &session_id, "assistant", &reply)?;

    Ok(reply)
}

#[derive(Serialize)]
pub struct ChatWithSourcesResponse {
    pub reply: String,
    pub sources: RagSources,
}

/// Chat with RAG: builds context via `build_rag_messages` and exposes "sources
/// used" — without this the product's auditability requirement isn't met.
#[tauri::command]
pub async fn chat_with_memory(
    state: State<'_, DbState>,
    session_id: String,
    history: Vec<ChatMessage>,
) -> Result<ChatWithSourcesResponse, String> {
    let (messages, sources) = build_rag_messages(state.inner(), &history).await?;
    let reply = call_ollama_chat(state.inner(), &messages).await?;

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(last_user) = history.last() {
        sessions::record_turn(&conn, &session_id, "user", &last_user.content)?;
    }
    sessions::record_turn(&conn, &session_id, "assistant", &reply)?;

    Ok(ChatWithSourcesResponse { reply, sources })
}

const THINK_OPEN: &str = "<think>";
const THINK_CLOSE: &str = "</think>";

/// Filters `<think>...</think>` blocks from reasoning models in streaming
/// mode. The tag can arrive split across two network chunks, so it has to be
/// buffered instead of searching for the tag chunk by chunk in isolation
/// (that would show the reasoning halfway through and then erase it).
struct ThinkStreamFilter {
    buffer: String,
    in_think: bool,
}

impl ThinkStreamFilter {
    fn new() -> Self {
        Self {
            buffer: String::new(),
            in_think: false,
        }
    }

    /// Safe length to emit right now: the whole buffer except a tail that
    /// could be the split beginning of "<think>".
    fn safe_emit_len(buffer: &str) -> usize {
        let bytes = buffer.as_bytes();
        let max_check = THINK_OPEN.len() - 1;
        let start = bytes.len().saturating_sub(max_check);
        for i in start..bytes.len() {
            if THINK_OPEN.as_bytes().starts_with(&bytes[i..]) && buffer.is_char_boundary(i) {
                return i;
            }
        }
        bytes.len()
    }

    fn push(&mut self, chunk: &str) -> String {
        self.buffer.push_str(chunk);
        let mut output = String::new();

        loop {
            if self.in_think {
                match self.buffer.find(THINK_CLOSE) {
                    Some(idx) => {
                        self.buffer.drain(..idx + THINK_CLOSE.len());
                        self.in_think = false;
                    }
                    None => break,
                }
            } else {
                match self.buffer.find(THINK_OPEN) {
                    Some(idx) => {
                        output.push_str(&self.buffer[..idx]);
                        self.buffer.drain(..idx + THINK_OPEN.len());
                        self.in_think = true;
                    }
                    None => {
                        let emit_len = Self::safe_emit_len(&self.buffer);
                        output.push_str(&self.buffer[..emit_len]);
                        self.buffer.drain(..emit_len);
                        break;
                    }
                }
            }
        }

        output
    }
}

#[derive(Serialize)]
pub struct StreamResult {
    pub reply: String,
    pub sources: Option<RagSources>,
}

/// Token-by-token streaming via the `chat-stream-delta` event. Added only
/// here because the non-streaming chat (`ollama_chat`/`chat_with_memory`)
/// already works; reuses `build_rag_messages` when `mode = "rag"`.
#[tauri::command]
pub async fn send_chat_stream(
    app: AppHandle,
    state: State<'_, DbState>,
    session_id: String,
    mode: String,
    history: Vec<ChatMessage>,
) -> Result<StreamResult, String> {
    let (messages, sources) = if mode == "rag" {
        let (msgs, sources) = build_rag_messages(state.inner(), &history).await?;
        (msgs, Some(sources))
    } else {
        let system = {
            let conn = state.0.lock().map_err(|e| e.to_string())?;
            build_system_prompt(&conn)?
        };
        let mut m = vec![ChatMessage {
            role: "system".to_string(),
            content: system,
        }];
        m.extend(history.clone());
        (m, None)
    };

    let base_url = settings::get_setting_from_db(state.inner(), "ollama_base_url", DEFAULT_OLLAMA_BASE_URL);
    let model = settings::get_setting_from_db(state.inner(), "chat_model", DEFAULT_CHAT_MODEL);
    let style = settings::get_setting_from_db(state.inner(), "local_api_style", DEFAULT_LOCAL_API_STYLE);
    let is_openai_style = style == "openai";

    let client = reqwest::Client::new();
    let body = OllamaChatRequest {
        model: &model,
        messages: &messages,
        stream: true,
    };
    let endpoint = if is_openai_style { "chat/completions" } else { "api/chat" };
    let res = client
        .post(format!("{base_url}/{endpoint}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("no se pudo contactar al motor local en {base_url}: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("El motor local respondió {status}: {text}"));
    }

    let mut stream = res.bytes_stream();
    let mut filter = ThinkStreamFilter::new();
    let mut full_reply = String::new();
    let mut leftover = String::new();

    'outer: while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| e.to_string())?;
        leftover.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = leftover.find('\n') {
            let line: String = leftover.drain(..=pos).collect();
            let mut line = line.trim();
            if line.is_empty() {
                continue;
            }

            // OpenAI style sends Server-Sent Events: each line starts with
            // "data: " and the stream ends with the "data: [DONE]" sentinel
            // (which isn't valid JSON, so we must stop there instead of parsing it).
            if is_openai_style {
                line = line.trim_start_matches("data:").trim();
                if line == "[DONE]" {
                    break 'outer;
                }
            }

            let parsed: serde_json::Value = serde_json::from_str(line)
                .map_err(|e| format!("respuesta en streaming inválida: {e}"))?;

            let content = if is_openai_style {
                parsed
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("delta"))
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_str())
            } else {
                parsed
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
            };

            if let Some(content) = content {
                let visible = filter.push(content);
                if !visible.is_empty() {
                    full_reply.push_str(&visible);
                    app.emit("chat-stream-delta", &visible)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(last_user) = history.last() {
        sessions::record_turn(&conn, &session_id, "user", &last_user.content)?;
    }
    sessions::record_turn(&conn, &session_id, "assistant", &full_reply)?;

    Ok(StreamResult {
        reply: full_reply,
        sources,
    })
}
