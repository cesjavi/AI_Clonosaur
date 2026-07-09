use chrono::Utc;
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::db::DbState;

/// Called when mounting "Chat" or "Hybrid Chat"; closed on unmount. Doesn't
/// affect the context the model receives — it's purely so we can measure
/// later (sessions, turns) in a future Metrics screen.
#[tauri::command]
pub fn create_session(state: State<DbState>, mode: String) -> Result<String, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO agent_sessions (id, mode, started_at, ended_at) VALUES (?1, ?2, ?3, NULL)",
        params![id, mode, Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn close_session(state: State<DbState>, session_id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE agent_sessions SET ended_at = ?1 WHERE id = ?2",
        params![Utc::now().to_rfc3339(), session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Records a turn (user or assistant) within a session. Reused
/// by the 4 chat/send modes to avoid duplicating the INSERT.
pub(crate) fn record_turn(
    conn: &Connection,
    session_id: &str,
    role: &str,
    content: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO chat_turns (id, session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            Uuid::new_v4().to_string(),
            session_id,
            role,
            content,
            Utc::now().to_rfc3339()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
pub struct ChatTurn {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

/// Loads the last 200 turns (from any session) when mounting "Chat".
/// Known limitation: it doesn't persist which "Sources used" each
/// historical RAG-mode response had, only the text — see IDENTITY.md section 3.
#[tauri::command]
pub fn list_chat_turns(state: State<DbState>) -> Result<Vec<ChatTurn>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, role, content, created_at FROM chat_turns ORDER BY created_at DESC LIMIT 200")
        .map_err(|e| e.to_string())?;

    let mut rows = stmt
        .query_map([], |row| {
            Ok(ChatTurn {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    rows.reverse();
    Ok(rows)
}
