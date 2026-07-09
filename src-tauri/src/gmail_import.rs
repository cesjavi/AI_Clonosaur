use base64::Engine;
use chrono::Utc;
use tauri::State;

use crate::db::DbState;
use crate::import_common::{self, ImportSummary};

/// Messages in a .mbox start with a "From " line at the start of the line.
/// The mbox format itself requires that any "From " that genuinely appears in
/// a message body be escaped as ">From " when written, so splitting on those
/// lines is safe.
fn split_mbox_messages(content: &str) -> Vec<&str> {
    let mut boundaries = vec![0usize];
    let mut offset = 0usize;
    for line in content.split_inclusive('\n') {
        if offset != 0 && line.starts_with("From ") {
            boundaries.push(offset);
        }
        offset += line.len();
    }
    boundaries.push(content.len());

    boundaries
        .windows(2)
        .map(|w| &content[w[0]..w[1]])
        .filter(|block| !block.trim().is_empty())
        .collect()
}

fn split_headers_body(raw: &str) -> (&str, &str) {
    if let Some(pos) = raw.find("\r\n\r\n") {
        (&raw[..pos], &raw[pos + 4..])
    } else if let Some(pos) = raw.find("\n\n") {
        (&raw[..pos], &raw[pos + 2..])
    } else {
        (raw, "")
    }
}

/// Parses RFC822 headers respecting "folding" (continuation lines that
/// start with a space or tab belong to the previous header).
fn parse_headers(raw_headers: &str) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in raw_headers.lines() {
        if (line.starts_with(' ') || line.starts_with('\t')) && !headers.is_empty() {
            let last = headers.last_mut().unwrap();
            last.1.push(' ');
            last.1.push_str(line.trim());
        } else if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_lowercase(), v.trim().to_string()));
        }
    }
    headers
}

fn get_header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

fn decode_q_encoding(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '_' => out.push(b' '),
            '=' => {
                let hex: String = chars.by_ref().take(2).collect();
                if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                    out.push(byte);
                }
            }
            _ => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    out
}

/// Decodes MIME header "encoded-words": `=?charset?Q|B?text?=`.
/// The charset is ignored beyond UTF-8 (a reasonable fallback for the MVP).
fn decode_encoded_words(input: &str) -> String {
    let mut result = String::new();
    let mut rest = input;

    while let Some(start) = rest.find("=?") {
        result.push_str(&rest[..start]);
        let after = &rest[start + 2..];

        let parsed = (|| {
            let q1 = after.find('?')?;
            let encoding = &after[q1 + 1..];
            let q2 = encoding.find('?')?;
            let enc_char = encoding[..q2].to_uppercase();
            let after_enc = &encoding[q2 + 1..];
            let end = after_enc.find("?=")?;
            let encoded_text = &after_enc[..end];
            let bytes = match enc_char.as_str() {
                "B" => base64::engine::general_purpose::STANDARD
                    .decode(encoded_text)
                    .unwrap_or_default(),
                "Q" => decode_q_encoding(encoded_text),
                _ => encoded_text.as_bytes().to_vec(),
            };
            let consumed = q1 + 1 + q2 + 1 + end + 2;
            Some((String::from_utf8_lossy(&bytes).to_string(), consumed))
        })();

        match parsed {
            Some((decoded, consumed)) => {
                result.push_str(&decoded);
                rest = &after[consumed..];
            }
            None => {
                result.push_str("=?");
                rest = after;
            }
        }
    }
    result.push_str(rest);
    result
}

fn decode_body(body: &str, transfer_encoding: &str) -> String {
    match transfer_encoding.to_lowercase().trim() {
        "quoted-printable" => quoted_printable::decode(body.as_bytes(), quoted_printable::ParseMode::Robust)
            .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
            .unwrap_or_else(|_| body.to_string()),
        "base64" => {
            let cleaned: String = body.chars().filter(|c| !c.is_whitespace()).collect();
            base64::engine::general_purpose::STANDARD
                .decode(cleaned.as_bytes())
                .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
                .unwrap_or_else(|_| body.to_string())
        }
        _ => body.to_string(),
    }
}

fn strip_html_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn get_boundary(content_type: &str) -> Option<String> {
    let idx = content_type.to_lowercase().find("boundary=")?;
    let rest = content_type[idx + "boundary=".len()..].trim_start();
    if let Some(stripped) = rest.strip_prefix('"') {
        let end = stripped.find('"')?;
        Some(stripped[..end].to_string())
    } else {
        let end = rest
            .find(|c: char| c == ';' || c.is_whitespace())
            .unwrap_or(rest.len());
        Some(rest[..end].trim().to_string())
    }
}

/// Extracts the plain text from a MIME message, preferring text/plain over
/// text/html, recursing down through multipart/* (e.g. multipart/mixed
/// containing a multipart/alternative inside).
fn extract_plain_text(content_type: &str, transfer_encoding: &str, body: &str) -> Option<String> {
    let ct_lower = content_type.to_lowercase();

    if ct_lower.starts_with("multipart/") {
        let boundary = get_boundary(content_type)?;
        let delimiter = format!("--{boundary}");

        let mut plain: Option<String> = None;
        let mut html: Option<String> = None;

        for part in body.split(delimiter.as_str()) {
            let part = part.trim_start_matches(['\r', '\n']);
            if part.trim().is_empty() || part.trim_start().starts_with("--") {
                continue;
            }
            let (part_headers_raw, part_body) = split_headers_body(part);
            let part_headers = parse_headers(part_headers_raw);
            let part_ct = get_header(&part_headers, "content-type")
                .unwrap_or("text/plain")
                .to_string();
            let part_cte = get_header(&part_headers, "content-transfer-encoding")
                .unwrap_or("7bit")
                .to_string();

            if part_ct.to_lowercase().starts_with("multipart/") {
                if plain.is_none() {
                    if let Some(nested) = extract_plain_text(&part_ct, &part_cte, part_body) {
                        plain = Some(nested);
                    }
                }
                continue;
            }

            let decoded = decode_body(part_body, &part_cte);
            if part_ct.to_lowercase().starts_with("text/plain") && plain.is_none() {
                plain = Some(decoded);
            } else if part_ct.to_lowercase().starts_with("text/html") && html.is_none() {
                html = Some(decoded);
            }
        }

        plain.or_else(|| html.map(|h| strip_html_tags(&h)))
    } else {
        let decoded = decode_body(body, transfer_encoding);
        if ct_lower.starts_with("text/html") {
            Some(strip_html_tags(&decoded))
        } else {
            Some(decoded)
        }
    }
}

fn parse_from_header(raw: &str) -> String {
    let decoded = decode_encoded_words(raw);
    if let Some(lt) = decoded.find('<') {
        if let Some(gt) = decoded.find('>') {
            let name = decoded[..lt].trim().trim_matches('"').to_string();
            let email = decoded[lt + 1..gt].trim().to_string();
            return if name.is_empty() { email } else { name };
        }
    }
    decoded.trim().to_string()
}

fn parse_gmail_date(raw: &str) -> Option<String> {
    let cleaned = match raw.find('(') {
        Some(idx) => raw[..idx].trim(),
        None => raw.trim(),
    };
    chrono::DateTime::parse_from_rfc2822(cleaned)
        .ok()
        .map(|dt| dt.to_rfc3339())
}

#[tauri::command]
pub fn import_gmail_file(state: State<DbState>, path: String) -> Result<ImportSummary, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let content = String::from_utf8_lossy(&bytes).to_string();

    let blocks = split_mbox_messages(&content);
    if blocks.is_empty() {
        return Err("no se encontraron mensajes en el archivo .mbox".to_string());
    }

    let file_name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let source_id =
        import_common::create_source(&conn, "gmail", &file_name).map_err(|e| e.to_string())?;
    let conversation_id = import_common::get_or_create_conversation(
        &conn,
        &source_id,
        "gmail",
        &file_name,
        Some(&file_name.to_lowercase()),
    )
    .map_err(|e| e.to_string())?;

    let mut imported = 0usize;
    let mut duplicates = 0usize;
    let mut participants: Vec<String> = Vec::new();

    for block in blocks {
        let after_from_line = match block.find('\n') {
            Some(i) => &block[i + 1..],
            None => continue,
        };
        let (headers_raw, body) = split_headers_body(after_from_line);
        let headers = parse_headers(headers_raw);

        let content_type = get_header(&headers, "content-type")
            .unwrap_or("text/plain")
            .to_string();
        let transfer_encoding = get_header(&headers, "content-transfer-encoding")
            .unwrap_or("7bit")
            .to_string();

        let text = match extract_plain_text(&content_type, &transfer_encoding, body) {
            Some(t) if !t.trim().is_empty() => t.trim().to_string(),
            _ => continue,
        };

        let timestamp = get_header(&headers, "date")
            .and_then(parse_gmail_date)
            .unwrap_or_else(|| Utc::now().to_rfc3339());

        let labels = get_header(&headers, "x-gmail-labels").unwrap_or("");
        let is_user = labels
            .to_lowercase()
            .split(',')
            .any(|l| l.trim() == "sent");

        let person_id = if is_user {
            None
        } else {
            let from_raw = get_header(&headers, "from").unwrap_or("Desconocido");
            let display = parse_from_header(from_raw);
            if !participants.contains(&display) {
                participants.push(display.clone());
            }
            let pid = import_common::get_or_create_person(&conn, &display)
                .map_err(|e| e.to_string())?;
            import_common::ensure_participant(&conn, &conversation_id, &pid)
                .map_err(|e| e.to_string())?;
            Some(pid)
        };

        let inserted = import_common::insert_message_if_new(
            &conn,
            &conversation_id,
            &source_id,
            person_id.as_deref(),
            is_user,
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
        participants,
    })
}
