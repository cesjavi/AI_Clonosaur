use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use tauri::State;
use uuid::Uuid;

use crate::db::DbState;
use crate::llm;

/// Groups own messages by conversation and asks the LLM to describe the
/// tone of each one separately (not a general tone), saving each
/// result as `profile_traits` (`category = 'tono_contextual'`).
///
/// Unlike values_model/decision_model (a single LLM call), here there's
/// one call per conversation, so the connection lock is acquired and
/// released on each iteration: keeping it held during a `.await` doesn't compile
/// (MutexGuard isn't Send) and would also block the DB for the whole generator.
#[tauri::command]
pub async fn generate_tone(state: State<'_, DbState>) -> Result<usize, String> {
    let conversations: Vec<(String, Vec<String>)> = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.title FROM conversations c
                 WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.is_user = 1)",
            )
            .map_err(|e| e.to_string())?;
        let convs = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        let mut result = Vec::new();
        for (conv_id, title) in convs {
            let mut mstmt = conn
                .prepare(
                    "SELECT text FROM messages WHERE conversation_id = ?1 AND is_user = 1 ORDER BY timestamp LIMIT 20",
                )
                .map_err(|e| e.to_string())?;
            let msgs = mstmt
                .query_map(params![conv_id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            if msgs.len() >= 3 {
                let label = if title.trim().is_empty() {
                    format!("Conversación {}", &conv_id[..8.min(conv_id.len())])
                } else {
                    title
                };
                result.push((label, msgs));
            }
        }
        result
    };

    if conversations.is_empty() {
        return Err(
            "no hay conversaciones con suficientes mensajes propios todavía para describir el tono"
                .to_string(),
        );
    }

    let now = Utc::now().to_rfc3339();
    let mut created = 0usize;

    for (label, msgs) in conversations {
        let exists: Option<String> = {
            let conn = state.0.lock().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT id FROM profile_traits WHERE category = 'tono_contextual' AND trait = ?1",
                params![label],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        };
        if exists.is_some() {
            continue;
        }

        let sample = msgs.iter().map(|m| format!("- {m}")).collect::<Vec<_>>().join("\n");
        let prompt = format!(
            "Estos son mensajes propios de una persona en una sola conversación ('{label}'). \
Describí en una o dos frases el tono que usa en este contexto específico (ej. formal, cariñoso, \
directo, en broma, distante). Basate solo en lo que ves acá, no generalices a otros contextos. \
Respondé solo texto plano, sin JSON ni comillas.\n\nMensajes:\n{sample}"
        );

        let tone = llm::chat_completion(state.inner(), &prompt).await?;
        let tone = tone.trim().trim_matches('"').to_string();
        if tone.is_empty() {
            continue;
        }

        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO profile_traits (id, category, trait, value, source, created_at, updated_at)
             VALUES (?1, 'tono_contextual', ?2, ?3, 'inferred', ?4, ?4)",
            params![Uuid::new_v4().to_string(), label, tone, now],
        )
        .map_err(|e| e.to_string())?;

        created += 1;
    }

    Ok(created)
}
