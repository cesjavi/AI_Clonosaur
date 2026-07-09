use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::db::DbState;
use crate::llm;

#[derive(Serialize)]
pub struct MemoryItem {
    pub id: String,
    pub layer: String,
    pub status: String,
    pub content: String,
    pub evidence: Option<String>,
    pub created_at: String,
}

fn row_to_memory(
    id: String,
    layer: String,
    status: String,
    content: String,
    metadata: Option<String>,
    created_at: String,
) -> MemoryItem {
    let evidence = metadata.as_deref().and_then(|m| {
        serde_json::from_str::<serde_json::Value>(m)
            .ok()
            .and_then(|v| v.get("evidence").and_then(|e| e.as_str()).map(|s| s.to_string()))
    });
    MemoryItem {
        id,
        layer,
        status,
        content,
        evidence,
        created_at,
    }
}

#[tauri::command]
pub fn list_memories(state: State<DbState>, status: Option<String>) -> Result<Vec<MemoryItem>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, layer, status, content, metadata, created_at FROM memories
             WHERE (?1 IS NULL OR status = ?1) ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![status], |row| {
            Ok(row_to_memory(
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_memory_status(
    state: State<DbState>,
    id: String,
    status: String,
    content: Option<String>,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    if let Some(new_content) = content {
        conn.execute(
            "UPDATE memories SET status = ?1, content = ?2, updated_at = ?3 WHERE id = ?4",
            params![status, new_content, now, id],
        )
    } else {
        conn.execute(
            "UPDATE memories SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now, id],
        )
    }
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Deserialize)]
struct ExtractedFact {
    #[serde(default)]
    index: Option<usize>,
    layer: String,
    content: String,
    #[serde(default)]
    evidence: serde_json::Value,
}

/// Takes a sample of the user's own messages that don't have an associated
/// memory yet, asks the local LLM to extract facts/preferences/traits citing
/// textual evidence, and saves them as `candidate` memories. Never confirms
/// anything automatically: the user reviews each one in the Memories screen.
#[tauri::command]
pub async fn generate_candidate_memories(state: State<'_, DbState>) -> Result<usize, String> {
    let messages: Vec<(String, String)> = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.text FROM messages m
                 WHERE m.is_user = 1
                 AND m.id NOT IN (SELECT source_message_id FROM memories WHERE source_message_id IS NOT NULL)
                 ORDER BY RANDOM() LIMIT 30",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };

    if messages.is_empty() {
        return Ok(0);
    }

    let evidence_block = messages
        .iter()
        .enumerate()
        .map(|(i, (_, text))| format!("[{i}] {text}"))
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
        "Analizá los siguientes mensajes de una persona (cada uno marcado con [n]) y extraé \
hechos, preferencias o rasgos concretos sobre ella. Para cada uno indicá: \
index (el número [n] del mensaje que lo respalda), \
layer (uno de: preferencias, autobiografica, estilo_linguistico, perfil_estable), \
content (el hecho, en una oración, en tercera persona), \
evidence (copia textual del fragmento del mensaje que lo respalda). \
NO inventes nada que no esté respaldado por el texto. Si un mensaje no aporta nada claro, ignoralo. \
Respondé ÚNICAMENTE un array JSON de objetos con esas 4 claves, sin texto adicional.\n\nMensajes:\n{evidence_block}"
    );

    let response = llm::chat_completion(state.inner(), &prompt).await?;
    let facts: Vec<ExtractedFact> = llm::parse_json_array(&response)?;

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let mut created = 0usize;

    for fact in facts {
        if fact.content.trim().is_empty() {
            continue;
        }
        let source_message_id = fact.index.and_then(|i| messages.get(i)).map(|(id, _)| id.clone());
        let evidence_text = llm::value_to_text(&fact.evidence);
        let metadata = serde_json::json!({ "evidence": evidence_text }).to_string();

        conn.execute(
            "INSERT INTO memories (id, layer, status, content, source_message_id, metadata, created_at, updated_at)
             VALUES (?1, ?2, 'candidate', ?3, ?4, ?5, ?6, ?6)",
            params![
                Uuid::new_v4().to_string(),
                fact.layer,
                fact.content,
                source_message_id,
                metadata,
                now,
            ],
        )
        .map_err(|e| e.to_string())?;

        created += 1;
    }

    Ok(created)
}
