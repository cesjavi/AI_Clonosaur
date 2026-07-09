use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use tauri::State;
use uuid::Uuid;

use crate::db::DbState;
use crate::llm;

#[derive(Deserialize)]
struct DecisionFinding {
    #[serde(rename = "trait")]
    trait_name: String,
    value: String,
    #[serde(default)]
    evidence: serde_json::Value,
}

/// Same pattern as values_model, focused on the interview's "Mental style"
/// and "Autobiographical memory" modules instead of "Identity".
fn gather_decision_evidence(conn: &Connection) -> Result<String, String> {
    let mut blocks = Vec::new();

    let mut stmt = conn
        .prepare(
            "SELECT question_text, answer FROM interview_answers
             WHERE module IN ('estilo_mental', 'memoria_autobiografica') AND answer != ''",
        )
        .map_err(|e| e.to_string())?;
    let answers = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if !answers.is_empty() {
        blocks.push("Entrevista (Estilo mental / Memoria autobiográfica):".to_string());
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
pub async fn generate_decisions(state: State<'_, DbState>) -> Result<usize, String> {
    let evidence = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        gather_decision_evidence(&conn)?
    };

    if evidence.trim().is_empty() {
        return Err(
            "no hay suficiente entrevista, memorias o mensajes propios todavía para generar patrones de decisión"
                .to_string(),
        );
    }

    let prompt = format!(
        "A partir del siguiente contexto sobre una persona, identificá hasta 8 patrones de toma \
de decisiones (cómo decide, qué la hace cambiar de opinión, cómo reacciona bajo presión). Para \
cada uno indicá: trait (nombre corto del patrón, ej. 'decide rápido bajo presión'), value (una \
frase explicando cómo se manifiesta), evidence (cita textual exacta del contexto que lo respalda). \
NO inventes patrones sin respaldo textual claro. Respondé ÚNICAMENTE un array JSON de objetos con \
esas 3 claves.\n\nContexto:\n{evidence}"
    );

    let response = llm::chat_completion(state.inner(), &prompt).await?;
    let findings: Vec<DecisionFinding> = llm::parse_json_array(&response)?;

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
            "toma_decisiones",
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
