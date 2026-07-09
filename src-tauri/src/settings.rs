use rusqlite::params;
use std::collections::HashMap;
use tauri::State;

use crate::db::DbState;

pub const DEFAULT_OLLAMA_BASE_URL: &str = "http://localhost:11434";
pub const DEFAULT_CHAT_MODEL: &str = "gemma3:4b";
pub const DEFAULT_EMBEDDING_MODEL: &str = "nomic-embed-text";
/// "ollama" (native Ollama API: /api/chat, /api/embeddings, NDJSON) or
/// "openai" (local engines compatible with the OpenAI API, e.g. Lemonade
/// Server: /v1/chat/completions, /v1/embeddings, SSE). Both run on the
/// user's machine; this is not the hybrid mode, it's just the API
/// format that the local engine speaks.
pub const DEFAULT_LOCAL_API_STYLE: &str = "ollama";

/// One-off read of a preference, with fallback to the default if it isn't
/// saved yet or if the database is momentarily inaccessible. This was
/// built BEFORE the Ollama URL got hardcoded in more
/// places — see PLAN_TECNICO.md, Phase 7.
pub fn get_setting_from_db(db: &DbState, key: &str, default: &str) -> String {
    let Ok(conn) = db.0.lock() else {
        return default.to_string();
    };
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .unwrap_or_else(|_| default.to_string())
}

#[tauri::command]
pub fn get_settings(state: State<DbState>) -> Result<HashMap<String, String>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM app_settings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;

    let mut map = HashMap::new();
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        map.insert(k, v);
    }

    map.entry("ollama_base_url".to_string())
        .or_insert_with(|| DEFAULT_OLLAMA_BASE_URL.to_string());
    map.entry("chat_model".to_string())
        .or_insert_with(|| DEFAULT_CHAT_MODEL.to_string());
    map.entry("embedding_model".to_string())
        .or_insert_with(|| DEFAULT_EMBEDDING_MODEL.to_string());
    map.entry("local_api_style".to_string())
        .or_insert_with(|| DEFAULT_LOCAL_API_STYLE.to_string());
    map.entry("theme".to_string()).or_insert_with(|| "system".to_string());
    map.entry("onboarding_completed".to_string())
        .or_insert_with(|| "false".to_string());

    Ok(map)
}

#[tauri::command]
pub fn update_setting(state: State<DbState>, key: String, value: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
