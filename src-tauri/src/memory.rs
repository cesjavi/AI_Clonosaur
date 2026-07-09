use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DbState;
use crate::settings::{
    self, DEFAULT_EMBEDDING_MODEL, DEFAULT_LOCAL_API_STYLE, DEFAULT_OLLAMA_BASE_URL,
};

#[derive(Deserialize)]
struct OllamaEmbeddingResponse {
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct OpenAiEmbeddingItem {
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct OpenAiEmbeddingResponse {
    data: Vec<OpenAiEmbeddingItem>,
}

/// Generates an embedding against the configured local engine. Supports two
/// API formats (see `settings::DEFAULT_LOCAL_API_STYLE`): native Ollama
/// (`/api/embeddings`) or OpenAI-compatible (`/v1/embeddings`, e.g.
/// Lemonade Server) — both run on the user's machine.
pub(crate) async fn ollama_embed(db: &DbState, text: &str) -> Result<Vec<f32>, String> {
    let base_url = settings::get_setting_from_db(db, "ollama_base_url", DEFAULT_OLLAMA_BASE_URL);
    let model = settings::get_setting_from_db(db, "embedding_model", DEFAULT_EMBEDDING_MODEL);
    let style = settings::get_setting_from_db(db, "local_api_style", DEFAULT_LOCAL_API_STYLE);

    let client = reqwest::Client::new();

    if style == "openai" {
        let res = client
            .post(format!("{base_url}/embeddings"))
            .json(&serde_json::json!({ "model": model, "input": text }))
            .send()
            .await
            .map_err(|e| format!("no se pudo contactar al motor local en {base_url}: {e}"))?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!("El motor local respondió {status}: {body}"));
        }

        let parsed: OpenAiEmbeddingResponse = res
            .json()
            .await
            .map_err(|e| format!("respuesta de embeddings inesperada: {e}"))?;

        return parsed
            .data
            .into_iter()
            .next()
            .map(|item| item.embedding)
            .ok_or_else(|| "el motor local no devolvió ningún embedding".to_string());
    }

    let res = client
        .post(format!("{base_url}/api/embeddings"))
        .json(&serde_json::json!({ "model": model, "prompt": text }))
        .send()
        .await
        .map_err(|e| format!("no se pudo contactar a Ollama en {base_url}: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Ollama respondió {status}: {body}"));
    }

    let parsed: OllamaEmbeddingResponse = res
        .json()
        .await
        .map_err(|e| format!("respuesta de embeddings de Ollama inesperada: {e}"))?;

    Ok(parsed.embedding)
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a * norm_b)
}

/// Own messages that don't have an embedding yet (candidates to index).
fn messages_without_embedding(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.text FROM messages m
         LEFT JOIN embeddings e ON e.message_id = m.id
         WHERE e.message_id IS NULL",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

#[derive(Serialize)]
pub struct EmbeddingCoverage {
    pub total_messages: i64,
    pub with_embedding: i64,
}

#[tauri::command]
pub fn get_embedding_coverage(state: State<DbState>) -> Result<EmbeddingCoverage, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let total_messages: i64 = conn
        .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let with_embedding: i64 = conn
        .query_row("SELECT COUNT(*) FROM embeddings", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    Ok(EmbeddingCoverage {
        total_messages,
        with_embedding,
    })
}

/// Generates embeddings for all messages that don't have one yet.
/// Runs sequentially against local Ollama: sufficient for personal data
/// volumes, and simpler than parallelizing against a single local model.
#[tauri::command]
pub async fn generate_embeddings(state: State<'_, DbState>) -> Result<usize, String> {
    let pending = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        messages_without_embedding(&conn).map_err(|e| e.to_string())?
    };

    let embedding_model =
        settings::get_setting_from_db(state.inner(), "embedding_model", DEFAULT_EMBEDDING_MODEL);

    let mut generated = 0usize;
    for (message_id, text) in pending {
        if text.trim().is_empty() {
            continue;
        }
        let vector = ollama_embed(state.inner(), &text).await?;
        let vector_json = serde_json::to_string(&vector).map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();

        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO embeddings (message_id, model, vector, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(message_id) DO UPDATE SET model = excluded.model, vector = excluded.vector, created_at = excluded.created_at",
            params![message_id, embedding_model, vector_json, now],
        )
        .map_err(|e| e.to_string())?;

        generated += 1;
    }

    Ok(generated)
}

#[derive(Serialize, Clone)]
pub struct MemorySearchResult {
    pub message_id: String,
    pub text: String,
    pub timestamp: String,
    pub author: Option<String>,
    pub is_user: bool,
    pub source_kind: String,
    pub score: f32,
}

/// Core of the semantic search, reused by the `search_memory` command
/// (manual search, includes sensitive messages and excluded contacts) and
/// by the chat's RAG context building (`chat::build_rag_messages`,
/// which excludes both).
pub(crate) fn find_similar_messages(
    conn: &Connection,
    query_vector: &[f32],
    limit: usize,
    exclude_sensitive: bool,
) -> Result<Vec<MemorySearchResult>, String> {
    let sql = if exclude_sensitive {
        "SELECT e.message_id, e.vector, m.text, m.timestamp, m.is_user, p.name, s.kind
         FROM embeddings e
         JOIN messages m ON m.id = e.message_id
         LEFT JOIN people p ON p.id = m.person_id
         JOIN sources s ON s.id = m.source_id
         WHERE m.sensitivity IS NOT 'sensible'
         AND (p.excluded IS NULL OR p.excluded = 0)"
    } else {
        "SELECT e.message_id, e.vector, m.text, m.timestamp, m.is_user, p.name, s.kind
         FROM embeddings e
         JOIN messages m ON m.id = e.message_id
         LEFT JOIN people p ON p.id = m.person_id
         JOIN sources s ON s.id = m.source_id"
    };

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let vector_json: String = row.get(1)?;
            Ok((
                row.get::<_, String>(0)?,
                vector_json,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, bool>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut scored: Vec<MemorySearchResult> = Vec::new();
    for row in rows {
        let (message_id, vector_json, text, timestamp, is_user, author, source_kind) =
            row.map_err(|e| e.to_string())?;
        let vector: Vec<f32> = serde_json::from_str(&vector_json).map_err(|e| e.to_string())?;
        let score = cosine_similarity(query_vector, &vector);
        scored.push(MemorySearchResult {
            message_id,
            text,
            timestamp,
            author,
            is_user,
            source_kind,
            score,
        });
    }

    scored.sort_by(|a, b| b.score.total_cmp(&a.score));
    scored.truncate(limit);
    Ok(scored)
}

/// Searches for the messages semantically most similar to `query`. Unlike
/// the chat's automatic RAG context, this manual search does include
/// messages marked as sensitive (with a warning in the UI).
#[tauri::command]
pub async fn search_memory(
    state: State<'_, DbState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<MemorySearchResult>, String> {
    let query_vector = ollama_embed(state.inner(), &query).await?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    find_similar_messages(&conn, &query_vector, limit.unwrap_or(5), false)
}
