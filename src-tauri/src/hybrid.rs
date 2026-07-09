use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::chat::{self, ChatMessage};
use crate::db::DbState;
use crate::sessions;

const DEFAULT_GROQ_BASE_URL: &str = "https://api.groq.com/openai/v1";
const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

/// Suggested base URL per known provider, so the UI can preload it and no one
/// accidentally ends up on the OpenAI URL when the provider is Groq
/// (or another compatible one).
#[tauri::command]
pub fn default_base_url(provider: String) -> String {
    match provider.as_str() {
        "groq" => DEFAULT_GROQ_BASE_URL.to_string(),
        "openai" => DEFAULT_OPENAI_BASE_URL.to_string(),
        _ => String::new(),
    }
}

#[tauri::command]
pub fn save_provider_credentials(
    state: State<DbState>,
    provider: String,
    base_url: String,
    api_key: String,
    model: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO provider_credentials (provider, base_url, api_key, model, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(provider) DO UPDATE SET
            base_url = excluded.base_url, api_key = excluded.api_key,
            model = excluded.model, updated_at = excluded.updated_at",
        params![provider, base_url, api_key, model, Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
pub struct ProviderInfo {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub has_api_key: bool,
}

/// Never returns the API key to the frontend once saved, only whether one is configured.
#[tauri::command]
pub fn get_provider_credentials(
    state: State<DbState>,
    provider: String,
) -> Result<Option<ProviderInfo>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT provider, base_url, model, api_key FROM provider_credentials WHERE provider = ?1",
        params![provider],
        |row| {
            let api_key: String = row.get(3)?;
            Ok(ProviderInfo {
                provider: row.get(0)?,
                base_url: row.get(1)?,
                model: row.get(2)?,
                has_api_key: !api_key.is_empty(),
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct HybridPreview {
    pub provider: String,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    /// The exact text as shown to the user, to review before confirming.
    /// No network call is made until this preview is confirmed.
    pub rendered_text: String,
}

fn render_messages(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .map(|m| format!("[{}]\n{}", m.role, m.content))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Builds the EXACT message that would be sent, without making any network
/// call. Reuses `build_rag_messages` (same context logic as the local chat)
/// and offers to anonymize contact names before showing the preview.
#[tauri::command]
pub async fn build_hybrid_preview(
    state: State<'_, DbState>,
    provider: String,
    history: Vec<ChatMessage>,
    anonymize: bool,
) -> Result<HybridPreview, String> {
    let (mut messages, _sources) = chat::build_rag_messages(state.inner(), &history).await?;

    if anonymize {
        let names: Vec<String> = {
            let conn = state.0.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare("SELECT name FROM people WHERE is_user = 0")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        for m in messages.iter_mut() {
            for name in &names {
                if !name.trim().is_empty() {
                    m.content = m.content.replace(name.as_str(), "[contacto]");
                }
            }
        }
    }

    let model = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT model FROM provider_credentials WHERE provider = ?1",
            params![provider],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| format!("no hay credenciales guardadas para el proveedor '{provider}'"))?
    };

    let rendered_text = render_messages(&messages);

    Ok(HybridPreview {
        provider,
        model,
        messages,
        rendered_text,
    })
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessage,
}

#[derive(Deserialize)]
struct OpenAiMessage {
    content: String,
}

#[derive(Deserialize)]
struct OpenAiChatResponse {
    choices: Vec<OpenAiChoice>,
}

/// The actual network call. Only fires when the user explicitly confirms
/// the preview built by `build_hybrid_preview`; never the other way around.
/// It gets logged in `external_send_log` with the exact text sent.
#[tauri::command]
pub async fn send_to_external_provider(
    state: State<'_, DbState>,
    session_id: String,
    provider: String,
    messages: Vec<ChatMessage>,
    rendered_text: String,
    anonymized: bool,
) -> Result<String, String> {
    let (base_url, api_key, model) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT base_url, api_key, model FROM provider_credentials WHERE provider = ?1",
            params![provider],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .map_err(|_| format!("no hay credenciales guardadas para '{provider}'"))?
    };

    let client = reqwest::Client::new();
    let body = serde_json::json!({ "model": model, "messages": messages });
    let res = client
        .post(format!("{base_url}/chat/completions"))
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("no se pudo contactar a {base_url}: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("{provider} respondió {status}: {text}"));
    }

    let parsed: OpenAiChatResponse = res
        .json()
        .await
        .map_err(|e| format!("respuesta de {provider} inesperada: {e}"))?;
    let reply = parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .unwrap_or_default();

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO external_send_log (id, provider, model, anonymized, content, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            Uuid::new_v4().to_string(),
            provider,
            model,
            anonymized,
            rendered_text,
            Utc::now().to_rfc3339()
        ],
    )
    .map_err(|e| e.to_string())?;

    if let Some(last_user) = messages.iter().rev().find(|m| m.role == "user") {
        sessions::record_turn(&conn, &session_id, "user", &last_user.content)?;
    }
    sessions::record_turn(&conn, &session_id, "assistant", &reply)?;

    Ok(reply)
}

#[derive(Serialize)]
pub struct SendLogEntry {
    pub provider: String,
    pub model: String,
    pub anonymized: bool,
    pub content: String,
    pub created_at: String,
}

#[tauri::command]
pub fn list_external_send_log(state: State<DbState>) -> Result<Vec<SendLogEntry>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT provider, model, anonymized, content, created_at FROM external_send_log ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(SendLogEntry {
                provider: row.get(0)?,
                model: row.get(1)?,
                anonymized: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
