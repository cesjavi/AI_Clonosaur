use rusqlite::{params, Connection};
use tauri::State;

use crate::db::DbState;

fn delete_by_source_tx(conn: &Connection, source_id: &str) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "UPDATE memories SET source_message_id = NULL
         WHERE source_message_id IN (SELECT id FROM messages WHERE source_id = ?1)",
        params![source_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM embeddings WHERE message_id IN (SELECT id FROM messages WHERE source_id = ?1)",
        params![source_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM feedback WHERE message_id IN (SELECT id FROM messages WHERE source_id = ?1)",
        params![source_id],
    )
    .map_err(|e| e.to_string())?;

    let deleted = tx
        .execute(
            "DELETE FROM messages WHERE source_id = ?1",
            params![source_id],
        )
        .map_err(|e| e.to_string())?;

    // If a conversation originally created by this source was reused by a
    // subsequent re-import (so it still holds messages from another source),
    // re-home its `source_id` to one of the remaining sources before deleting
    // this source so the FK constraint stays valid and future re-imports still
    // find the conversation.
    tx.execute(
        "UPDATE conversations
         SET source_id = (
             SELECT m.source_id FROM messages m
             WHERE m.conversation_id = conversations.id
             LIMIT 1
         )
         WHERE source_id = ?1
           AND id IN (SELECT DISTINCT conversation_id FROM messages)",
        params![source_id],
    )
    .map_err(|e| e.to_string())?;

    // Conversations left without any message (orphaned from this source) are
    // also deleted, releasing their participants first to satisfy the FK.
    tx.execute(
        "DELETE FROM conversation_participants WHERE conversation_id IN (
            SELECT id FROM conversations WHERE source_id = ?1
            AND id NOT IN (SELECT DISTINCT conversation_id FROM messages)
        )",
        params![source_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM conversations WHERE source_id = ?1
         AND id NOT IN (SELECT DISTINCT conversation_id FROM messages)",
        params![source_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sources WHERE id = ?1", params![source_id])
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(deleted)
}

/// Real deletion (not just hidden in the UI): clears references in `memories`
/// before deleting the messages so nothing is left orphaned, following the
/// order required by PLAN_TECNICO.md.
#[tauri::command]
pub fn delete_by_source(state: State<DbState>, source_id: String) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    delete_by_source_tx(&conn, &source_id)
}

#[tauri::command]
pub fn delete_by_contact(state: State<DbState>, person_id: String) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "UPDATE memories SET source_message_id = NULL
         WHERE source_message_id IN (SELECT id FROM messages WHERE person_id = ?1)",
        params![person_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM embeddings WHERE message_id IN (SELECT id FROM messages WHERE person_id = ?1)",
        params![person_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM feedback WHERE message_id IN (SELECT id FROM messages WHERE person_id = ?1)",
        params![person_id],
    )
    .map_err(|e| e.to_string())?;

    let deleted = tx
        .execute(
            "DELETE FROM messages WHERE person_id = ?1",
            params![person_id],
        )
        .map_err(|e| e.to_string())?;

    tx.execute(
        "DELETE FROM conversation_participants WHERE person_id = ?1",
        params![person_id],
    )
    .map_err(|e| e.to_string())?;
    // Copilot drafts addressed to this contact keep their text and
    // `contact_name` as a historical record; only the reference is released
    // so deleting the person doesn't violate the foreign key.
    tx.execute(
        "UPDATE drafts SET contact_person_id = NULL WHERE contact_person_id = ?1",
        params![person_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM people WHERE id = ?1", params![person_id])
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(deleted)
}

/// `from`/`to` are ISO8601 UTC timestamps (same format as `messages.timestamp`).
#[tauri::command]
pub fn delete_by_date_range(
    state: State<DbState>,
    from: String,
    to: String,
) -> Result<usize, String> {
    if from > to {
        return Err("la fecha 'desde' no puede ser posterior a 'hasta'".to_string());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "UPDATE memories SET source_message_id = NULL
         WHERE source_message_id IN (SELECT id FROM messages WHERE timestamp BETWEEN ?1 AND ?2)",
        params![from, to],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM embeddings WHERE message_id IN (SELECT id FROM messages WHERE timestamp BETWEEN ?1 AND ?2)",
        params![from, to],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM feedback WHERE message_id IN (SELECT id FROM messages WHERE timestamp BETWEEN ?1 AND ?2)",
        params![from, to],
    )
    .map_err(|e| e.to_string())?;

    let deleted = tx
        .execute(
            "DELETE FROM messages WHERE timestamp BETWEEN ?1 AND ?2",
            params![from, to],
        )
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::apply_schema;

    #[test]
    fn delete_by_source_rehomes_shared_conversation_after_reimport() {
        let conn = Connection::open_in_memory().unwrap();
        apply_schema(&conn).unwrap();

        conn.execute(
            "INSERT INTO sources (id, kind, file_name, imported_at) VALUES ('s1', 'whatsapp', 'chat.txt', '2025-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sources (id, kind, file_name, imported_at) VALUES ('s2', 'whatsapp', 'chat.txt', '2025-01-02T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO conversations (id, source_id, title, external_id, created_at) VALUES ('c1', 's1', 'chat.txt', 'ana|juan', '2025-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, conversation_id, source_id, is_user, text, timestamp, created_at) VALUES ('m1', 'c1', 's1', 1, 'hola', '2025-01-01T10:00:00Z', '2025-01-01T10:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, conversation_id, source_id, is_user, text, timestamp, created_at) VALUES ('m2', 'c1', 's2', 1, 'chau', '2025-01-02T10:00:00Z', '2025-01-02T10:00:00Z')",
            [],
        )
        .unwrap();

        let deleted = delete_by_source_tx(&conn, "s1").expect("should not violate FK");
        assert_eq!(deleted, 1);

        let new_owner: String = conn
            .query_row(
                "SELECT source_id FROM conversations WHERE id = 'c1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(new_owner, "s2");
    }
}
