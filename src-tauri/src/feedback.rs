use chrono::Utc;
use rusqlite::params;
use tauri::State;
use uuid::Uuid;

use crate::db::DbState;

/// Fixes a message's author attribution ("this is me" / "this is not me")
/// and leaves an auditable record of the change in `feedback`.
#[tauri::command]
pub fn record_feedback(
    state: State<DbState>,
    message_id: String,
    is_user: bool,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let updated = conn
        .execute(
            "UPDATE messages SET is_user = ?1 WHERE id = ?2",
            params![is_user, message_id],
        )
        .map_err(|e| e.to_string())?;

    if updated == 0 {
        return Err(format!("no existe un mensaje con id {message_id}"));
    }

    conn.execute(
        "INSERT INTO feedback (id, message_id, is_user, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![Uuid::new_v4().to_string(), message_id, is_user, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}
