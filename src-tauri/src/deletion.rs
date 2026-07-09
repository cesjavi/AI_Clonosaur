use rusqlite::params;
use tauri::State;

use crate::db::DbState;

/// Real deletion (not just hidden in the UI): clears references in `memories`
/// before deleting the messages so nothing is left orphaned, following the
/// order required by PLAN_TECNICO.md.
#[tauri::command]
pub fn delete_by_source(state: State<DbState>, source_id: String) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE memories SET source_message_id = NULL
         WHERE source_message_id IN (SELECT id FROM messages WHERE source_id = ?1)",
        params![source_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM embeddings WHERE message_id IN (SELECT id FROM messages WHERE source_id = ?1)",
        params![source_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM feedback WHERE message_id IN (SELECT id FROM messages WHERE source_id = ?1)",
        params![source_id],
    )
    .map_err(|e| e.to_string())?;

    let deleted = conn
        .execute("DELETE FROM messages WHERE source_id = ?1", params![source_id])
        .map_err(|e| e.to_string())?;

    // Conversations left without any message (orphaned from this source) are
    // also deleted, but their participants must be released first or the
    // DELETE on conversations violates the foreign key.
    conn.execute(
        "DELETE FROM conversation_participants WHERE conversation_id IN (
            SELECT id FROM conversations WHERE source_id = ?1
            AND id NOT IN (SELECT DISTINCT conversation_id FROM messages)
        )",
        params![source_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM conversations WHERE source_id = ?1
         AND id NOT IN (SELECT DISTINCT conversation_id FROM messages)",
        params![source_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM sources WHERE id = ?1", params![source_id])
        .map_err(|e| e.to_string())?;

    Ok(deleted)
}

#[tauri::command]
pub fn delete_by_contact(state: State<DbState>, person_id: String) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE memories SET source_message_id = NULL
         WHERE source_message_id IN (SELECT id FROM messages WHERE person_id = ?1)",
        params![person_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM embeddings WHERE message_id IN (SELECT id FROM messages WHERE person_id = ?1)",
        params![person_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM feedback WHERE message_id IN (SELECT id FROM messages WHERE person_id = ?1)",
        params![person_id],
    )
    .map_err(|e| e.to_string())?;

    let deleted = conn
        .execute("DELETE FROM messages WHERE person_id = ?1", params![person_id])
        .map_err(|e| e.to_string())?;

    conn.execute(
        "DELETE FROM conversation_participants WHERE person_id = ?1",
        params![person_id],
    )
    .map_err(|e| e.to_string())?;
    // Copilot drafts addressed to this contact keep their text and
    // `contact_name` as a historical record; only the reference is released
    // so deleting the person doesn't violate the foreign key.
    conn.execute(
        "UPDATE drafts SET contact_person_id = NULL WHERE contact_person_id = ?1",
        params![person_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM people WHERE id = ?1", params![person_id])
        .map_err(|e| e.to_string())?;

    Ok(deleted)
}

/// `from`/`to` are ISO8601 timestamps (same format as `messages.timestamp`).
#[tauri::command]
pub fn delete_by_date_range(state: State<DbState>, from: String, to: String) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE memories SET source_message_id = NULL
         WHERE source_message_id IN (SELECT id FROM messages WHERE timestamp BETWEEN ?1 AND ?2)",
        params![from, to],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM embeddings WHERE message_id IN (SELECT id FROM messages WHERE timestamp BETWEEN ?1 AND ?2)",
        params![from, to],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM feedback WHERE message_id IN (SELECT id FROM messages WHERE timestamp BETWEEN ?1 AND ?2)",
        params![from, to],
    )
    .map_err(|e| e.to_string())?;

    let deleted = conn
        .execute(
            "DELETE FROM messages WHERE timestamp BETWEEN ?1 AND ?2",
            params![from, to],
        )
        .map_err(|e| e.to_string())?;

    Ok(deleted)
}
