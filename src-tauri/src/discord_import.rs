use tauri::State;

use crate::db::DbState;
use crate::import_common::{self, ImportSummary};

/// The per-channel Discord export (`messages.csv`) is treated as the user's
/// own content, same as Twitter/Reddit, to simplify the MVP: no attempt is
/// made to distinguish speakers within the CSV.
#[tauri::command]
pub fn import_discord_file(state: State<DbState>, path: String) -> Result<ImportSummary, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut reader = csv::ReaderBuilder::new().from_reader(content.as_bytes());
    let headers = reader.headers().map_err(|e| e.to_string())?.clone();
    let find = |name: &str| headers.iter().position(|h| h.eq_ignore_ascii_case(name));

    let timestamp_idx = find("Timestamp")
        .or_else(|| find("Date"))
        .ok_or("el CSV necesita una columna 'Timestamp' o 'Date'")?;
    let contents_idx = find("Contents")
        .or_else(|| find("Content"))
        .ok_or("el CSV necesita una columna 'Contents' o 'Content'")?;

    let file_name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let source_id =
        import_common::create_source(&conn, "discord", &file_name).map_err(|e| e.to_string())?;
    let conversation_id = import_common::get_or_create_conversation(
        &conn,
        &source_id,
        "discord",
        &file_name,
        Some(&file_name.to_lowercase()),
    )
    .map_err(|e| e.to_string())?;

    let mut imported = 0usize;
    let mut duplicates = 0usize;

    for result in reader.records() {
        let row = result.map_err(|e| e.to_string())?;
        let text = row.get(contents_idx).unwrap_or("").trim();
        if text.is_empty() {
            continue;
        }
        let timestamp = import_common::normalize_timestamp(row.get(timestamp_idx).unwrap_or(""));

        let inserted = import_common::insert_message_if_new(
            &conn,
            &conversation_id,
            &source_id,
            None,
            true,
            text,
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
        participants: Vec::new(),
    })
}
