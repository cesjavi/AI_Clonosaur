use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use uuid::Uuid;

#[derive(Serialize, Default)]
pub struct ImportSummary {
    pub source_id: String,
    pub imported: usize,
    pub duplicates: usize,
    /// Author names detected in the import (useful for the user to later
    /// indicate which of them is themself).
    pub participants: Vec<String>,
}

pub fn create_source(conn: &Connection, kind: &str, file_name: &str) -> rusqlite::Result<String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO sources (id, kind, file_name, imported_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, kind, file_name, Utc::now().to_rfc3339()],
    )?;
    Ok(id)
}

/// Looks for an existing conversation of the same source `kind` by
/// `external_id` (stable fingerprint of the chat/thread) before creating a
/// new one. Without this, every reimport of the same file would generate a
/// different conversation and duplicate detection — which compares within a
/// conversation — would never find matches.
pub fn get_or_create_conversation(
    conn: &Connection,
    source_id: &str,
    kind: &str,
    title: &str,
    external_id: Option<&str>,
) -> rusqlite::Result<String> {
    if let Some(ext_id) = external_id {
        let existing: Option<String> = conn
            .query_row(
                "SELECT c.id FROM conversations c JOIN sources s ON s.id = c.source_id
                 WHERE s.kind = ?1 AND c.external_id = ?2",
                params![kind, ext_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            return Ok(id);
        }
    }

    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO conversations (id, source_id, title, external_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, source_id, title, external_id, Utc::now().to_rfc3339()],
    )?;
    Ok(id)
}

/// Looks for a person by exact name; creates it if it doesn't exist. Reused by
/// all importers to avoid duplicating contacts across re-imports.
pub fn get_or_create_person(conn: &Connection, name: &str) -> rusqlite::Result<String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM people WHERE name = ?1",
            params![name],
            |row| row.get(0),
        )
        .optional()?;

    if let Some(id) = existing {
        return Ok(id);
    }

    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO people (id, name, is_user, created_at) VALUES (?1, ?2, 0, ?3)",
        params![id, name, Utc::now().to_rfc3339()],
    )?;
    Ok(id)
}

pub fn ensure_participant(
    conn: &Connection,
    conversation_id: &str,
    person_id: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO conversation_participants (conversation_id, person_id) VALUES (?1, ?2)",
        params![conversation_id, person_id],
    )?;
    Ok(())
}

fn find_duplicate_message_id(
    conn: &Connection,
    conversation_id: &str,
    person_id: Option<&str>,
    timestamp: &str,
    text: &str,
) -> rusqlite::Result<Option<String>> {
    match person_id {
        Some(pid) => conn
            .query_row(
                "SELECT id FROM messages WHERE conversation_id = ?1 AND timestamp = ?2 AND text = ?3 AND person_id = ?4",
                params![conversation_id, timestamp, text, pid],
                |row| row.get(0),
            )
            .optional(),
        None => conn
            .query_row(
                "SELECT id FROM messages WHERE conversation_id = ?1 AND timestamp = ?2 AND text = ?3 AND person_id IS NULL",
                params![conversation_id, timestamp, text],
                |row| row.get(0),
            )
            .optional(),
    }
}

/// Tries to parse a timestamp in a few common export formats (Discord,
/// Reddit); if none match, falls back to the current time as a last resort
/// instead of failing the whole import over one row with a weird date.
pub fn normalize_timestamp(raw: &str) -> String {
    let raw = raw.trim();

    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw) {
        return dt.to_rfc3339();
    }

    // Discord (old exports): "MM/DD/YYYY HH:MM AM/PM"
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(raw, "%m/%d/%Y %I:%M %p") {
        return dt.and_utc().to_rfc3339();
    }

    // Reddit: "YYYY-MM-DD HH:MM:SS UTC"
    if let Some(stripped) = raw.strip_suffix("UTC") {
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(stripped.trim(), "%Y-%m-%d %H:%M:%S") {
            return dt.and_utc().to_rfc3339();
        }
    }

    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S") {
        return dt.and_utc().to_rfc3339();
    }

    Utc::now().to_rfc3339()
}

/// Inserts a message if it's not a duplicate (same text + timestamp + author
/// within the same conversation). Returns `true` if it was inserted, `false`
/// if it already existed (reimport of the same source).
pub fn insert_message_if_new(
    conn: &Connection,
    conversation_id: &str,
    source_id: &str,
    person_id: Option<&str>,
    is_user: bool,
    text: &str,
    timestamp: &str,
) -> rusqlite::Result<bool> {
    if find_duplicate_message_id(conn, conversation_id, person_id, timestamp, text)?.is_some() {
        return Ok(false);
    }

    // Sensitivity classification at ingestion time, not as a separate step:
    // this way the RAG chat can filter on it from the day the message exists.
    let sensitivity = crate::sensitivity::classify(text);

    conn.execute(
        "INSERT INTO messages (id, conversation_id, source_id, person_id, is_user, text, timestamp, metadata, sensitivity, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9)",
        params![
            Uuid::new_v4().to_string(),
            conversation_id,
            source_id,
            person_id,
            is_user,
            text,
            timestamp,
            sensitivity,
            Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(true)
}
