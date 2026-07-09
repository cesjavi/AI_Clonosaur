use chrono::Utc;
use rusqlite::params;
use serde::Deserialize;
use tauri::State;
use uuid::Uuid;

use crate::db::DbState;
use crate::llm;

#[derive(Deserialize)]
struct ContradictionFinding {
    content: String,
    #[serde(default)]
    evidence: serde_json::Value,
}

/// Compares ALREADY confirmed memories against each other (not candidate
/// memories) looking for real changes of opinion over time, not minor natural
/// evolution. Findings come in as candidate memories (`dinamica` layer),
/// reusing the same review flow instead of a new screen.
#[tauri::command]
pub async fn detect_contradictions(state: State<'_, DbState>) -> Result<usize, String> {
    let memories: Vec<(String, String)> = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT content, created_at FROM memories WHERE status IN ('confirmed','edited') ORDER BY created_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };

    if memories.len() < 2 {
        return Ok(0);
    }

    let evidence_block = memories
        .iter()
        .enumerate()
        .map(|(i, (content, date))| format!("[{i}] ({date}) {content}"))
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
        "Estas son memorias confirmadas sobre una persona, ordenadas por fecha (marcadas [n]). \
Buscá cambios de opinión REALES a través del tiempo (no evolución natural menor ni matices): \
casos donde algo que dijo o creía antes contradice claramente algo posterior. \
Para cada contradicción real que encuentres, devolvé un objeto con: \
content (describí el cambio, ej. 'Cambió de opinión sobre X: antes creía Y, ahora cree Z'), \
evidence (citá los fragmentos [n] involucrados). \
Si no hay contradicciones reales, devolvé un array vacío — no inventes cambios menores. \
Respondé ÚNICAMENTE un array JSON de objetos con esas 2 claves.\n\nMemorias:\n{evidence_block}"
    );

    let response = llm::chat_completion(state.inner(), &prompt).await?;
    let findings: Vec<ContradictionFinding> = llm::parse_json_array(&response)?;

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let mut created = 0usize;

    for finding in findings {
        if finding.content.trim().is_empty() {
            continue;
        }
        let evidence_text = llm::value_to_text(&finding.evidence);
        let metadata = serde_json::json!({ "evidence": evidence_text }).to_string();

        conn.execute(
            "INSERT INTO memories (id, layer, status, content, source_message_id, metadata, created_at, updated_at)
             VALUES (?1, 'dinamica', 'candidate', ?2, NULL, ?3, ?4, ?4)",
            params![Uuid::new_v4().to_string(), finding.content, metadata, now],
        )
        .map_err(|e| e.to_string())?;

        created += 1;
    }

    Ok(created)
}
