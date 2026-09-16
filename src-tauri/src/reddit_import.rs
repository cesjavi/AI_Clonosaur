use tauri::State;

use crate::db::DbState;
use crate::import_common::{self, ImportSummary};

/// Reddit's `posts.csv` has both a title and a body (self-text posts can have
/// an empty body); `comments.csv` only has a body. Joins whichever of the two
/// are present with a blank line between them; `None` if both are empty
/// (nothing worth importing for that row).
fn combine_title_body(title: &str, body: &str) -> Option<String> {
    match (title.is_empty(), body.is_empty()) {
        (false, false) => Some(format!("{title}\n\n{body}")),
        (false, true) => Some(title.to_string()),
        (true, false) => Some(body.to_string()),
        (true, true) => None,
    }
}

/// Reddit exports `comments.csv` and `posts.csv` with different schemas; which
/// one it is gets detected by the presence of the 'title' column (only in posts).
/// Same as Twitter/Discord, the content is assumed to be the user's own.
#[tauri::command]
pub fn import_reddit_file(state: State<DbState>, path: String) -> Result<ImportSummary, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut reader = csv::ReaderBuilder::new().from_reader(content.as_bytes());
    let headers = reader.headers().map_err(|e| e.to_string())?.clone();
    let find = |name: &str| headers.iter().position(|h| h.eq_ignore_ascii_case(name));

    let date_idx = find("date").ok_or("el CSV necesita una columna 'date'")?;
    let body_idx = find("body");
    let title_idx = find("title");

    if body_idx.is_none() && title_idx.is_none() {
        return Err(
            "el CSV no tiene columnas 'title' ni 'body' reconocibles (comments.csv o posts.csv de Reddit)"
                .to_string(),
        );
    }

    let file_name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let source_id =
        import_common::create_source(&conn, "reddit", &file_name).map_err(|e| e.to_string())?;
    let conversation_id = import_common::get_or_create_conversation(
        &conn,
        &source_id,
        "reddit",
        &file_name,
        Some(&import_common::fingerprint_file_name(&file_name)),
    )
    .map_err(|e| e.to_string())?;

    let mut imported = 0usize;
    let mut duplicates = 0usize;

    for result in reader.records() {
        let row = result.map_err(|e| e.to_string())?;
        let title = title_idx.and_then(|i| row.get(i)).unwrap_or("").trim();
        let body = body_idx.and_then(|i| row.get(i)).unwrap_or("").trim();

        let text = match combine_title_body(title, body) {
            Some(t) => t,
            None => continue,
        };

        let timestamp = import_common::normalize_timestamp(row.get(date_idx).unwrap_or(""));

        let inserted = import_common::insert_message_if_new(
            &conn,
            &conversation_id,
            &source_id,
            None,
            true,
            &text,
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
    fn combines_title_and_body_when_both_present() {
        assert_eq!(
            combine_title_body("My post title", "the body text"),
            Some("My post title\n\nthe body text".to_string())
        );
    }

    #[test]
    fn uses_title_alone_when_body_is_empty() {
        assert_eq!(
            combine_title_body("Just a title", ""),
            Some("Just a title".to_string())
        );
    }

    #[test]
    fn uses_body_alone_when_title_is_empty() {
        // comments.csv rows have no title column at all.
        assert_eq!(
            combine_title_body("", "just a comment"),
            Some("just a comment".to_string())
        );
    }

    #[test]
    fn returns_none_when_both_are_empty() {
        assert_eq!(combine_title_body("", ""), None);
    }
}
