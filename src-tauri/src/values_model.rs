use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use tauri::State;
use uuid::Uuid;

use crate::db::DbState;
use crate::llm;

#[derive(Deserialize)]
struct ValueFinding {
    #[serde(rename = "trait")]
    trait_name: String,
    value: String,
    #[serde(default)]
    evidence: serde_json::Value,
}

/// Gathers the relevant context to infer values: answers from the
/// interview's "Identity" module, already-confirmed memories, and a sample of
/// own messages. Same pattern used by decision_model and tone_model.
fn gather_identity_evidence(conn: &Connection) -> Result<String, String> {
    let mut blocks = Vec::new();

    let mut stmt = conn
        .prepare("SELECT question_text, answer FROM interview_answers WHERE module = 'identidad' AND answer != ''")
        .map_err(|e| e.to_string())?;
    let answers = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if !answers.is_empty() {
        blocks.push("Entrevista (módulo Identidad):".to_string());
        for (q, a) in answers {
            blocks.push(format!("P: {q}\nR: {a}"));
        }
    }

    let mut stmt2 = conn
        .prepare("SELECT content FROM memories WHERE status IN ('confirmed','edited') LIMIT 40")
        .map_err(|e| e.to_string())?;
    let mems = stmt2
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if !mems.is_empty() {
        blocks.push("\nMemorias confirmadas:".to_string());
        for m in mems {
            blocks.push(format!("- {m}"));
        }
    }

    let mut stmt3 = conn
        .prepare("SELECT text FROM messages WHERE is_user = 1 ORDER BY RANDOM() LIMIT 20")
        .map_err(|e| e.to_string())?;
    let msgs = stmt3
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if !msgs.is_empty() {
        blocks.push("\nMensajes propios (muestra):".to_string());
        for m in msgs {
            blocks.push(format!("- {m}"));
        }
    }

    Ok(blocks.join("\n"))
}

/// Saves a finding in `profile_traits`, avoiding duplication by name if one
/// already exists with the same category + trait (it isn't overwritten: the user
/// may have edited it by hand).
fn insert_trait_if_new(
    conn: &Connection,
    category: &str,
    trait_name: &str,
    value: &str,
    evidence: &str,
    now: &str,
) -> Result<bool, String> {
    let exists: Option<String> = conn
        .query_row(
            "SELECT id FROM profile_traits WHERE category = ?1 AND trait = ?2",
            params![category, trait_name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if exists.is_some() {
        return Ok(false);
    }

    conn.execute(
        "INSERT INTO profile_traits (id, category, trait, value, source, evidence, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'inferred', ?5, ?6, ?6)",
        params![Uuid::new_v4().to_string(), category, trait_name, value, evidence, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(true)
}

#[tauri::command]
pub async fn generate_values(state: State<'_, DbState>) -> Result<usize, String> {
    let evidence = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        gather_identity_evidence(&conn)?
    };

    if evidence.trim().is_empty() {
        return Err(
            "no hay suficiente entrevista, memorias o mensajes propios todavía para generar valores"
                .to_string(),
        );
    }

    let prompt = format!(
        "A partir del siguiente contexto sobre una persona, identificá hasta 8 valores que no \
negocia o que la definen. Para cada uno indicá: trait (nombre corto del valor, ej. 'honestidad'), \
value (una frase explicando cómo se manifiesta en ella), evidence (cita textual exacta del \
contexto que lo respalda). NO inventes valores sin respaldo textual claro. Respondé ÚNICAMENTE \
un array JSON de objetos con esas 3 claves.\n\nContexto:\n{evidence}"
    );

    let response = llm::chat_completion(state.inner(), &prompt).await?;
    let findings: Vec<ValueFinding> = llm::parse_json_array(&response)?;

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let mut created = 0usize;

    for finding in findings {
        if finding.trait_name.trim().is_empty() || finding.value.trim().is_empty() {
            continue;
        }
        let evidence_text = llm::value_to_text(&finding.evidence);
        if insert_trait_if_new(
            &conn,
            "valores",
            &finding.trait_name,
            &finding.value,
            &evidence_text,
            &now,
        )? {
            created += 1;
        }
    }

    Ok(created)
}
