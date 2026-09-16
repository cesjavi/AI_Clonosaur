use tauri::State;

use crate::db::DbState;
use crate::import_common::{self, ImportSummary};

/// Case-insensitive header lookup: Discord's CSV exporters aren't
/// consistent about capitalization ("Timestamp" vs "timestamp") across
/// versions/locales, so an exact match would silently reject valid exports.
fn find_column_ci(headers: &csv::StringRecord, name: &str) -> Option<usize> {
    headers.iter().position(|h| h.eq_ignore_ascii_case(name))
}

/// The per-channel Discord export (`messages.csv`) is treated as the user's
/// own content, same as Twitter/Reddit, to simplify the MVP: no attempt is
/// made to distinguish speakers within the CSV.
#[tauri::command]
pub fn import_discord_file(state: State<DbState>, path: String) -> Result<ImportSummary, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut reader = csv::ReaderBuilder::new().from_reader(content.as_bytes());
    let headers = reader.headers().map_err(|e| e.to_string())?.clone();

    let timestamp_idx = find_column_ci(&headers, "Timestamp")
        .or_else(|| find_column_ci(&headers, "Date"))
        .ok_or("el CSV necesita una columna 'Timestamp' o 'Date'")?;
    let contents_idx = find_column_ci(&headers, "Contents")
        .or_else(|| find_column_ci(&headers, "Content"))
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
        Some(&import_common::fingerprint_file_name(&file_name)),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_column_case_insensitively() {
        let headers = csv::StringRecord::from(vec!["AUTHOR", "Timestamp", "Contents"]);
        assert_eq!(find_column_ci(&headers, "timestamp"), Some(1));
        assert_eq!(find_column_ci(&headers, "CONTENTS"), Some(2));
    }

    #[test]
    fn returns_none_for_a_missing_column() {
        let headers = csv::StringRecord::from(vec!["AUTHOR", "Date"]);
        assert_eq!(find_column_ci(&headers, "Timestamp"), None);
    }

    #[test]
    fn falls_back_to_the_alternate_column_name() {
        // Older Discord exports use "Date"/"Content" instead of
        // "Timestamp"/"Contents" — the .or_else() fallback chain in
        // import_discord_file relies on find_column_ci returning None
        // (not panicking) for the missing primary name.
        let headers = csv::StringRecord::from(vec!["Author", "Date", "Content"]);
        let timestamp_idx =
            find_column_ci(&headers, "Timestamp").or_else(|| find_column_ci(&headers, "Date"));
        let contents_idx =
            find_column_ci(&headers, "Contents").or_else(|| find_column_ci(&headers, "Content"));
        assert_eq!(timestamp_idx, Some(1));
        assert_eq!(contents_idx, Some(2));
    }
}
