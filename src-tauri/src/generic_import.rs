use chrono::Utc;
use serde::Deserialize;
use tauri::State;

use crate::db::DbState;
use crate::import_common::{self, ImportSummary};

#[derive(Deserialize)]
struct GenericRecord {
    text: String,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    is_user: Option<bool>,
}

fn parse_csv(content: &str) -> Result<Vec<GenericRecord>, String> {
    let mut reader = csv::ReaderBuilder::new().from_reader(content.as_bytes());
    let headers = reader.headers().map_err(|e| e.to_string())?.clone();
    let find = |name: &str| headers.iter().position(|h| h == name);

    let text_idx = find("text").ok_or("el CSV necesita una columna 'text'")?;
    let timestamp_idx = find("timestamp");
    let author_idx = find("author");
    let is_user_idx = find("is_user");

    let mut records = Vec::new();
    for result in reader.records() {
        let row = result.map_err(|e| e.to_string())?;
        let text = row.get(text_idx).unwrap_or("").trim().to_string();
        if text.is_empty() {
            continue;
        }
        let timestamp = timestamp_idx
            .and_then(|i| row.get(i))
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let author = author_idx
            .and_then(|i| row.get(i))
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let is_user = is_user_idx
            .and_then(|i| row.get(i))
            .map(|s| s == "true" || s == "1");

        records.push(GenericRecord {
            text,
            timestamp,
            author,
            is_user,
        });
    }
    Ok(records)
}

/// Safety-net import: any source without a dedicated parser, as long as it
/// can be expressed as `.json`/`.csv` with columns `text`/`timestamp?`/
/// `author?`/`is_user?`, or plain `.txt` (one line = one of the user's own messages).
#[tauri::command]
pub fn import_generic_file(state: State<DbState>, path: String) -> Result<ImportSummary, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let lower = path.to_lowercase();

    let records: Vec<GenericRecord> = if lower.ends_with(".json") {
        serde_json::from_str(&content).map_err(|e| format!("JSON inválido: {e}"))?
    } else if lower.ends_with(".csv") {
        parse_csv(&content)?
    } else {
        content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| GenericRecord {
                text: l.trim().to_string(),
                timestamp: None,
                author: None,
                is_user: Some(true),
            })
            .collect()
    };

    if records.is_empty() {
        return Err("no se encontraron mensajes en el archivo".to_string());
    }

    let file_name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let source_id =
        import_common::create_source(&conn, "generic", &file_name).map_err(|e| e.to_string())?;
    // The file name is the "thread" fingerprint: reimporting the same file
    // lands in the same conversation, and duplicate detection avoids repeating messages.
    let conversation_id = import_common::get_or_create_conversation(
        &conn,
        &source_id,
        "generic",
        &file_name,
        Some(&file_name.to_lowercase()),
    )
    .map_err(|e| e.to_string())?;

    let mut imported = 0usize;
    let mut duplicates = 0usize;
    let mut participants: Vec<String> = Vec::new();

    for rec in records {
        let timestamp = rec.timestamp.unwrap_or_else(|| Utc::now().to_rfc3339());

        let (person_id, is_user) = match &rec.author {
            Some(name) => {
                if !participants.contains(name) {
                    participants.push(name.clone());
                }
                let pid = import_common::get_or_create_person(&conn, name)
                    .map_err(|e| e.to_string())?;
                import_common::ensure_participant(&conn, &conversation_id, &pid)
                    .map_err(|e| e.to_string())?;
                (Some(pid), rec.is_user.unwrap_or(false))
            }
            None => (None, rec.is_user.unwrap_or(true)),
        };

        let inserted = import_common::insert_message_if_new(
            &conn,
            &conversation_id,
            &source_id,
            person_id.as_deref(),
            is_user,
            &rec.text,
            &timestamp,
        )
        .map_err(|e| e.to_string())?;

        if inserted {
            imported += 1;
        } else {
            duplicates += 1;
        }
    }

    Ok(ImportSummary {
        source_id,
        imported,
        duplicates,
        participants,
    })
}
