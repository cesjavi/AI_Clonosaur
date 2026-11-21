use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::db::DbState;
use crate::settings::{self, DEFAULT_CHAT_MODEL, DEFAULT_LOCAL_API_STYLE, DEFAULT_OLLAMA_BASE_URL};

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    stream: bool,
}

#[derive(Deserialize)]
struct ChatResponseMessage {
    content: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    message: ChatResponseMessage,
}

#[derive(Deserialize)]
struct OpenAiMessage {
    content: String,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessage,
}

#[derive(Deserialize)]
struct OpenAiResponse {
    choices: Vec<OpenAiChoice>,
}

/// Non-streaming chat call against the configured local engine (Ollama or
/// OpenAI-compatible, e.g. Lemonade Server). Returns the raw text of the
/// model's response (not parsed yet).
pub async fn chat_completion(db: &DbState, prompt: &str) -> Result<String, String> {
    let base_url = settings::get_setting_from_db(db, "ollama_base_url", DEFAULT_OLLAMA_BASE_URL);
    let base_url = base_url.trim_end_matches('/');
    let model = settings::get_setting_from_db(db, "chat_model", DEFAULT_CHAT_MODEL);
    let style = settings::get_setting_from_db(db, "local_api_style", DEFAULT_LOCAL_API_STYLE);

    let client = reqwest::Client::new();
    let body = ChatRequest {
        model: &model,
        messages: vec![ChatMessage {
            role: "user",
            content: prompt,
        }],
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

        let parsed: OpenAiResponse = res
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

    let parsed: ChatResponse = res
        .json()
        .await
        .map_err(|e| format!("respuesta de chat de Ollama inesperada: {e}"))?;

    Ok(parsed.message.content)
}

/// Models sometimes return an "evidence" field as a string and
/// sometimes as an array of several quotes, depending on how many fragments it
/// considers relevant. Accepting both forms avoids breaking parsing over this
/// variation instead of forcing a strict type that the model doesn't always respect.
pub fn value_to_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => arr
            .iter()
            .map(value_to_text)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("; "),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Removes `<think>...</think>` blocks emitted by reasoning models (as well as
/// any truncated unclosed trailing `<think>...` block).
pub fn strip_think_blocks(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find("<think>") {
        out.push_str(&rest[..start]);
        let after_open = &rest[start + "<think>".len()..];
        match after_open.find("</think>") {
            Some(end) => rest = &after_open[end + "</think>".len()..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// Models often wrap the requested JSON in prose, `<think>` blocks, or
/// ```json``` code blocks — and may cite `[0]`/`[1]` in preamble prose before
/// the actual JSON array. Strips `<think>` blocks first, then tries candidate
/// `[` starts against the last `]` so earlier bracketed citations don't break
/// parsing.
pub fn parse_json_array<T: DeserializeOwned>(raw: &str) -> Result<Vec<T>, String> {
    let cleaned = strip_think_blocks(raw);
    let Some(end) = cleaned.rfind(']') else {
        return Err("el modelo no devolvió un array JSON reconocible".to_string());
    };

    let mut last_err = None;
    for (idx, ch) in cleaned[..=end].char_indices() {
        if ch != '[' {
            continue;
        }
        match serde_json::from_str::<Vec<T>>(&cleaned[idx..=end]) {
            Ok(parsed) => return Ok(parsed),
            Err(err) => last_err = Some(err),
        }
    }

    match last_err {
        Some(err) => Err(format!(
            "no se pudo interpretar la respuesta del modelo como JSON: {err}"
        )),
        None => Err("el modelo no devolvió un array JSON reconocible".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_think_blocks_removes_closed_and_unclosed_blocks() {
        assert_eq!(strip_think_blocks("<think>abc</think>Hola"), "Hola");
        assert_eq!(strip_think_blocks("A<think>x</think>B<think>y"), "AB");
    }

    #[test]
    fn parse_json_array_handles_think_blocks_and_bracket_citations() {
        let raw = r#"<think>Revisando [0] y [1]</think>Según [0]: [{"a": 1}]"#;
        let parsed: Vec<serde_json::Value> = parse_json_array(raw).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["a"], 1);
    }
}
