use chrono::Utc;
use serde::Deserialize;
use tauri::State;

use crate::db::DbState;
use crate::import_common::{self, ImportSummary};

#[derive(Deserialize)]
struct TweetWrapper {
    tweet: TweetData,
}

#[derive(Deserialize, Debug)]
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

/// A Twitter/X archive only contains the tweets of whoever requested the
/// export — there's no username inside `tweet.js` itself — so the frontend
/// asks which account this archive belongs to before importing. That
/// person is attributed to every tweet (not hardcoded as the clone's
/// owner): reusing the same "mark as me" flow the other importers already
/// have lets this double as a way to import a contact's own archive too,
/// under the same consent model as everything else (see PRIVACY.md).
#[tauri::command]
pub fn import_twitter_file(
    state: State<DbState>,
    path: String,
    username: String,
) -> Result<ImportSummary, String> {
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
    // Fingerprinted by username, not file name: an archive only ever
    // contains one account's tweets, so the username is a stable identity
    // for the conversation across re-downloads (which commonly get renamed
    // with a "(1)" suffix or a different export timestamp), unlike the file
    // name.
    let conversation_id = import_common::get_or_create_conversation(
        &conn,
        &source_id,
        "twitter",
        &file_name,
        Some(&username.to_lowercase()),
    )
    .map_err(|e| e.to_string())?;
    let person_id =
        import_common::get_or_create_person(&conn, &username).map_err(|e| e.to_string())?;
    import_common::ensure_participant(&conn, &conversation_id, &person_id)
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
            Some(&person_id),
            false,
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
        participants: vec![username],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, Timelike};

    #[test]
    fn parses_the_window_ytd_tweet_wrapper() {
        let content = r#"window.YTD.tweet.part0 = [{"tweet":{"created_at":"Wed Oct 10 20:19:24 +0000 2018","full_text":"hola"}}]"#;
        let tweets = parse_twitter_archive(content).expect("should parse");
        assert_eq!(tweets.len(), 1);
        assert_eq!(tweets[0].full_text, "hola");
        assert_eq!(tweets[0].created_at, "Wed Oct 10 20:19:24 +0000 2018");
    }

    #[test]
    fn rejects_the_whole_archive_on_a_malformed_entry() {
        // Unlike the web build's TS mirror (which skips bad entries), the
        // Rust side deserializes the whole array in one shot: one entry with
        // an unexpected shape fails the entire parse rather than silently
        // dropping just that entry.
        let content = r#"[{"tweet":{"created_at":"Wed Oct 10 20:19:24 +0000 2018","full_text":"ok"}},{"notATweet":true}]"#;
        assert!(parse_twitter_archive(content).is_err());
    }

    #[test]
    fn errors_with_a_friendly_message_when_no_array_is_found() {
        let err = parse_twitter_archive("not a tweet export").unwrap_err();
        assert!(
            err.contains("no se encontró el array"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn parses_the_twitter_archive_date_format() {
        let result =
            parse_twitter_timestamp("Wed Oct 10 20:19:24 +0000 2018").expect("should parse");
        let dt = chrono::DateTime::parse_from_rfc3339(&result).expect("valid rfc3339 output");
        assert_eq!((dt.year(), dt.month(), dt.day()), (2018, 10, 10));
        assert_eq!((dt.hour(), dt.minute(), dt.second()), (20, 19, 24));
    }

    #[test]
    fn applies_a_non_zero_utc_offset() {
        // 17:19:24 -03:00 == 20:19:24 UTC
        let result =
            parse_twitter_timestamp("Wed Oct 10 17:19:24 -0300 2018").expect("should parse");
        let dt = chrono::DateTime::parse_from_rfc3339(&result)
            .expect("valid rfc3339 output")
            .with_timezone(&Utc);
        assert_eq!((dt.year(), dt.month(), dt.day()), (2018, 10, 10));
        assert_eq!((dt.hour(), dt.minute(), dt.second()), (20, 19, 24));
    }

    #[test]
    fn returns_none_for_unrecognized_timestamp_format() {
        assert_eq!(parse_twitter_timestamp("2018-10-10"), None);
    }
}
