use chrono::Utc;
use serde::Deserialize;
use tauri::State;

use crate::db::DbState;
use crate::import_common::{self, ImportSummary};

#[derive(Deserialize)]
struct TweetWrapper {
    tweet: TweetData,
}

#[derive(Deserialize)]
struct TweetData {
    created_at: String,
    full_text: String,
}

/// `data/tweet.js` isn't pure JSON: it's a JS variable assignment
/// ("window.YTD.tweet.part0 = [ ... ]"). Everything before the first '[' is trimmed
/// to keep only the array, without needing a JS parser.
fn parse_twitter_archive(content: &str) -> Result<Vec<TweetData>, String> {
    let json_start = content
        .find('[')
        .ok_or("no se encontró el array de tweets en el archivo")?;
    let wrappers: Vec<TweetWrapper> = serde_json::from_str(&content[json_start..])
        .map_err(|e| format!("JSON de tweets inválido: {e}"))?;
    Ok(wrappers.into_iter().map(|w| w.tweet).collect())
}

fn parse_twitter_timestamp(created_at: &str) -> Option<String> {
    // Twitter format: "Wed Oct 10 20:19:24 +0000 2018"
    chrono::DateTime::parse_from_str(created_at, "%a %b %d %H:%M:%S %z %Y")
        .ok()
        .map(|dt| dt.to_rfc3339())
}

/// The Twitter/X archive only contains the user's own tweets, so
/// they're always marked `is_user = true` without creating any person.
#[tauri::command]
pub fn import_twitter_file(state: State<DbState>, path: String) -> Result<ImportSummary, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let tweets = parse_twitter_archive(&content)?;

    if tweets.is_empty() {
        return Err("no se encontraron tweets en el archivo".to_string());
    }

    let file_name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let source_id =
        import_common::create_source(&conn, "twitter", &file_name).map_err(|e| e.to_string())?;
    let conversation_id = import_common::get_or_create_conversation(
        &conn,
        &source_id,
        "twitter",
        &file_name,
        Some(&file_name.to_lowercase()),
    )
    .map_err(|e| e.to_string())?;

    let mut imported = 0usize;
    let mut duplicates = 0usize;

    for tweet in tweets {
        let text = tweet.full_text.trim();
        if text.is_empty() {
            continue;
        }
        let timestamp =
            parse_twitter_timestamp(&tweet.created_at).unwrap_or_else(|| Utc::now().to_rfc3339());

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
