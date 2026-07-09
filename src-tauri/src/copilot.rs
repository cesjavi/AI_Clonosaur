use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::chat::{self, ChatMessage};
use crate::db::DbState;

#[derive(Serialize)]
pub struct Draft {
    pub id: String,
    pub contact_name: Option<String>,
    pub content: String,
    pub status: String,
    pub created_at: String,
}

fn is_excluded(conn: &Connection, person_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT excluded FROM people WHERE id = ?1",
        params![person_id],
        |row| row.get::<_, bool>(0),
    )
    .optional()
    .map(|v| v.unwrap_or(false))
    .map_err(|e| e.to_string())
}

/// Generates a "written as me" draft using the same context assembly as the
/// RAG chat. Never sends anything through any channel: the result stays in
/// `drafts` with `status = 'pending'` until the user reviews it by hand.
/// If the recipient contact is excluded, the model isn't even called.
#[tauri::command]
pub async fn generate_draft(
    state: State<'_, DbState>,
    contact_person_id: Option<String>,
    instruction: String,
) -> Result<Draft, String> {
    let contact_name: Option<String> = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(pid) = &contact_person_id {
            if is_excluded(&conn, pid)? {
                return Err(
                    "este contacto está marcado como excluido de la memoria del clon; no se genera ningún borrador para él"
                        .to_string(),
                );
            }
            conn.query_row("SELECT name FROM people WHERE id = ?1", params![pid], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .map_err(|e| e.to_string())?
        } else {
            None
        }
    };

    let history = vec![ChatMessage {
        role: "user".to_string(),
        content: instruction,
    }];
    let (messages, _sources) = chat::build_rag_messages(state.inner(), &history).await?;
    let content = chat::call_ollama_chat(state.inner(), &messages).await?;

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO drafts (id, contact_person_id, contact_name, content, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5)",
        params![id, contact_person_id, contact_name, content, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(Draft {
        id,
        contact_name,
        content,
        status: "pending".to_string(),
        created_at: now,
    })
}

#[tauri::command]
pub fn list_drafts(state: State<DbState>) -> Result<Vec<Draft>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, contact_name, content, status, created_at FROM drafts ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Draft {
                id: row.get(0)?,
                contact_name: row.get(1)?,
                content: row.get(2)?,
                status: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_draft_status(
    state: State<DbState>,
    id: String,
    status: String,
    content: Option<String>,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    if let Some(c) = content {
        conn.execute(
            "UPDATE drafts SET status = ?1, content = ?2, updated_at = ?3 WHERE id = ?4",
            params![status, c, now, id],
        )
    } else {
        conn.execute(
            "UPDATE drafts SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now, id],
        )
    }
    .map_err(|e| e.to_string())?;

    Ok(())
}
