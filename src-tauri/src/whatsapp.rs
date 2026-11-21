use std::io::Read;
use tauri::State;

use crate::db::DbState;
use crate::import_common::{self, ImportSummary};

struct ParsedMessage {
    author: String,
    text: String,
    timestamp: String,
}

/// Android header: "12/1/23, 10:15 - rest". iOS header: "[12/1/23, 10:15:00 AM] rest".
/// iOS is tried first because its delimiter ('[' ... ']') is unambiguous.
fn split_ios_header(line: &str) -> Option<(&str, &str)> {
    if !line.starts_with('[') {
        return None;
    }
    let end = line.find(']')?;
    let header = &line[1..end];
    if !header.contains(',') {
        return None;
    }
    Some((header, line[end + 1..].trim_start()))
}

fn split_android_header(line: &str) -> Option<(&str, &str)> {
    let idx = line.find(" - ")?;
    let header = &line[..idx];
    if !header.contains(',') {
        return None;
    }
    Some((header, &line[idx + 3..]))
}

/// The day/month order is ambiguous in WhatsApp exports (it depends on the region
/// of the phone that generated the backup); dd/mm is assumed, the most common format
/// outside the United States.
fn parse_whatsapp_timestamp(date_str: &str, time_str: &str) -> Option<String> {
    let date_bits: Vec<&str> = date_str.trim().split(['/', '.']).collect();
    if date_bits.len() != 3 {
        return None;
    }
    let day: u32 = date_bits[0].parse().ok()?;
    let month: u32 = date_bits[1].parse().ok()?;
    let mut year: i32 = date_bits[2].parse().ok()?;
    if year < 100 {
        year += 2000;
    }

    // Normalize non-breaking / narrow-no-break spaces used by Android/iOS
    // Spanish exports ("10:15\u{202f}p.\u{00a0}m.") to plain ASCII spaces.
    let time_normalized: String = time_str
        .trim()
        .chars()
        .map(|c| match c {
            '\u{00A0}' | '\u{202F}' | '\u{2007}' => ' ',
            _ => c,
        })
        .collect();
    let time_lower = time_normalized.to_lowercase();
    let (time_main, meridiem) = if let Some(s) = time_lower
        .strip_suffix("a. m.")
        .or_else(|| time_lower.strip_suffix("a.m."))
        .or_else(|| time_lower.strip_suffix("am"))
    {
        (s.trim(), Some(false))
    } else if let Some(s) = time_lower
        .strip_suffix("p. m.")
        .or_else(|| time_lower.strip_suffix("p.m."))
        .or_else(|| time_lower.strip_suffix("pm"))
    {
        (s.trim(), Some(true))
    } else {
        (time_lower.as_str(), None)
    };

    let time_bits: Vec<&str> = time_main.split(':').collect();
    if time_bits.len() < 2 {
        return None;
    }
    let mut hour: u32 = time_bits[0].parse().ok()?;
    let minute: u32 = time_bits[1].parse().ok()?;
    let second: u32 = time_bits.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);

    if let Some(is_pm) = meridiem {
        if is_pm && hour != 12 {
            hour += 12;
        }
        if !is_pm && hour == 12 {
            hour = 0;
        }
    }

    let date = chrono::NaiveDate::from_ymd_opt(year, month, day)?;
    let time = chrono::NaiveTime::from_hms_opt(hour, minute, second)?;
    Some(
        chrono::NaiveDateTime::new(date, time)
            .and_utc()
            .to_rfc3339(),
    )
}

fn parse_header_datetime(header: &str) -> Option<String> {
    let (date_part, time_part) = header.split_once(", ")?;
    parse_whatsapp_timestamp(date_part, time_part)
}

/// Parses the full text of a WhatsApp export. System messages
/// (someone joined, changed the icon, etc.) don't have "Name: text" and are
/// discarded; multi-line messages are appended to the last real message.
fn parse_whatsapp_text(content: &str) -> Vec<ParsedMessage> {
    let mut messages: Vec<ParsedMessage> = Vec::new();
    let mut in_system_message = false;

    for raw_line in content.lines() {
        // Strip trailing CR and leading UTF-8 BOM / Unicode directional marks
        // (iOS exports routinely prefix lines with U+200E LRM).
        let line = raw_line.trim_end_matches('\r').trim_start_matches([
            '\u{FEFF}', '\u{200E}', '\u{200F}', '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}',
            '\u{202E}',
        ]);
        if line.trim().is_empty() {
            continue;
        }

        let header_and_rest = split_ios_header(line).or_else(|| split_android_header(line));

        if let Some((header, rest)) = header_and_rest {
            if let Some(timestamp) = parse_header_datetime(header) {
                if let Some((name, text)) = rest.split_once(": ") {
                    messages.push(ParsedMessage {
                        author: name.trim().to_string(),
                        text: text.trim().to_string(),
                        timestamp,
                    });
                    in_system_message = false;
                } else {
                    in_system_message = true;
                }
                continue;
            }
        }

        if !in_system_message {
            if let Some(last) = messages.last_mut() {
                last.text.push('\n');
                last.text.push_str(line.trim());
            }
        }
    }

    messages
}

const MAX_ZIP_TEXT_BYTES: u64 = 100 * 1024 * 1024; // 100 MiB safety cap

fn read_whatsapp_content(path: &str) -> Result<String, String> {
    if path.to_lowercase().ends_with(".zip") {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        for i in 0..archive.len() {
            let entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let entry_name = entry.name().to_string();
            let base_name = entry_name.rsplit('/').next().unwrap_or(&entry_name);
            if entry_name.starts_with("__MACOSX/") || base_name.starts_with("._") {
                continue;
            }
            if entry_name.to_lowercase().ends_with(".txt") {
                let mut buf = Vec::new();
                std::io::Read::read_to_end(&mut entry.take(MAX_ZIP_TEXT_BYTES + 1), &mut buf)
                    .map_err(|e| e.to_string())?;
                if buf.len() as u64 > MAX_ZIP_TEXT_BYTES {
                    return Err(
                        "el archivo .txt dentro del .zip supera el límite de 100 MB".to_string()
                    );
                }
                return Ok(String::from_utf8_lossy(&buf).to_string());
            }
        }
        Err("el .zip no contiene ningún archivo .txt".to_string())
    } else {
        std::fs::read_to_string(path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn import_whatsapp_file(state: State<DbState>, path: String) -> Result<ImportSummary, String> {
    let content = read_whatsapp_content(&path)?;
    let parsed = parse_whatsapp_text(&content);

    if parsed.is_empty() {
        return Err(
            "no se reconoció ningún mensaje en el archivo (formato de WhatsApp no soportado)"
                .to_string(),
        );
    }

    let file_name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    // Stable fingerprint of the chat (independent of the file name, which can
    // vary between exports of the same chat): the sorted set of authors.
    // This way a re-import of the same chat lands in the same conversation and
    // duplicate detection can do its job.
    let mut participants: Vec<String> = Vec::new();
    for msg in &parsed {
        if !participants.contains(&msg.author) {
            participants.push(msg.author.clone());
        }
    }
    let mut fingerprint_parts = participants.clone();
    fingerprint_parts.sort();
    let external_id = fingerprint_parts.join("|").to_lowercase();

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let source_id =
        import_common::create_source(&tx, "whatsapp", &file_name).map_err(|e| e.to_string())?;
    let conversation_id = import_common::get_or_create_conversation(
        &tx,
        &source_id,
        "whatsapp",
        &file_name,
        Some(&external_id),
    )
    .map_err(|e| e.to_string())?;

    let mut imported = 0usize;
    let mut duplicates = 0usize;

    for msg in parsed {
        let (person_id, is_user) = import_common::get_or_create_person_with_flag(&tx, &msg.author)
            .map_err(|e| e.to_string())?;
        import_common::ensure_participant(&tx, &conversation_id, &person_id)
            .map_err(|e| e.to_string())?;

        let inserted = import_common::insert_message_if_new(
            &tx,
            &conversation_id,
            &source_id,
            Some(&person_id),
            is_user,
            &msg.text,
            &msg.timestamp,
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
