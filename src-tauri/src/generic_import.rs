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
    let find = |name: &str| {
        headers
            .iter()
            .position(|h| h.trim().eq_ignore_ascii_case(name))
    };

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
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let author = author_idx
            .and_then(|i| row.get(i))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let is_user = is_user_idx
            .and_then(|i| row.get(i))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.eq_ignore_ascii_case("true") || s == "1");

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
    let raw_content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let content = raw_content.strip_prefix('\u{FEFF}').unwrap_or(&raw_content);
    let lower = path.to_lowercase();

    let records: Vec<GenericRecord> = if lower.ends_with(".json") {
        let raw_records: Vec<GenericRecord> =
            serde_json::from_str(content).map_err(|e| format!("JSON inválido: {e}"))?;
        raw_records
            .into_iter()
            .filter_map(|mut r| {
                let text = r.text.trim().to_string();
                if text.is_empty() {
                    return None;
                }
                r.text = text;
                r.author = r
                    .author
                    .map(|a| a.trim().to_string())
                    .filter(|a| !a.is_empty());
                r.timestamp = r
                    .timestamp
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty());
                Some(r)
            })
            .collect()
    } else if lower.ends_with(".csv") {
        parse_csv(content)?
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
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let source_id =
        import_common::create_source(&tx, "generic", &file_name).map_err(|e| e.to_string())?;
    let conversation_id = import_common::get_or_create_conversation(
        &tx,
        &source_id,
        "generic",
        &file_name,
        Some(&import_common::fingerprint_file_name(&file_name)),
    )
    .map_err(|e| e.to_string())?;

    let mut imported = 0usize;
    let mut duplicates = 0usize;
    let mut participants: Vec<String> = Vec::new();

    for rec in records {
        let has_timestamp = rec.timestamp.is_some();
        let timestamp = rec
            .timestamp
            .as_deref()
            .map(import_common::normalize_timestamp)
            .unwrap_or_else(|| Utc::now().to_rfc3339());

        let (person_id, is_user) = match &rec.author {
            Some(name) => {
                if !participants.contains(name) {
                    participants.push(name.clone());
                }
                let (pid, person_is_user) =
                    import_common::get_or_create_person_with_flag(&tx, name)
                        .map_err(|e| e.to_string())?;
                import_common::ensure_participant(&tx, &conversation_id, &pid)
                    .map_err(|e| e.to_string())?;
                (Some(pid), rec.is_user.unwrap_or(person_is_user))
            }
            None => (None, rec.is_user.unwrap_or(true)),
        };

        let inserted = import_common::insert_message_if_new_opts(
            &tx,
            &conversation_id,
            &source_id,
            person_id.as_deref(),
            is_user,
            &rec.text,
            &timestamp,
            has_timestamp,
        )
        .map_err(|e| e.to_string())?;

        if inserted {
            imported += 1;
        } else {
            duplicates += 1;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    Ok(ImportSummary {
        source_id,
        imported,
        duplicates,
        participants,
    })
}
