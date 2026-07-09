use rusqlite::params;
use serde::Serialize;
use tauri::State;

use crate::db::DbState;

#[derive(Serialize)]
pub struct Metrics {
    pub total_messages: i64,
    pub messages_with_embedding: i64,
    pub sensitive_messages: i64,
    pub memories_candidate: i64,
    pub memories_confirmed: i64,
    pub memories_edited: i64,
    pub memories_rejected: i64,
    pub feedback_count: i64,
    pub drafts_pending: i64,
    pub drafts_approved: i64,
    pub drafts_edited: i64,
    pub drafts_rejected: i64,
    pub interview_answered: i64,
    pub total_sessions: i64,
    pub total_turns: i64,
}

/// Everything is calculated in real time from the local database, never hardcoded — see
/// PLAN_TECNICO.md ("metrics panel... never hardcoded").
#[tauri::command]
pub fn get_metrics(state: State<DbState>) -> Result<Metrics, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let count = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, [], |row| row.get(0)).map_err(|e| e.to_string())
    };
    let count_status = |table: &str, status: &str| -> Result<i64, String> {
        conn.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE status = ?1"),
            params![status],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())
    };

    Ok(Metrics {
        total_messages: count("SELECT COUNT(*) FROM messages")?,
        messages_with_embedding: count("SELECT COUNT(*) FROM embeddings")?,
        sensitive_messages: count("SELECT COUNT(*) FROM messages WHERE sensitivity = 'sensible'")?,
        memories_candidate: count_status("memories", "candidate")?,
        memories_confirmed: count_status("memories", "confirmed")?,
        memories_edited: count_status("memories", "edited")?,
        memories_rejected: count_status("memories", "rejected")?,
        feedback_count: count("SELECT COUNT(*) FROM feedback")?,
        drafts_pending: count_status("drafts", "pending")?,
        drafts_approved: count_status("drafts", "approved")?,
        drafts_edited: count_status("drafts", "edited")?,
        drafts_rejected: count_status("drafts", "rejected")?,
        interview_answered: count("SELECT COUNT(*) FROM interview_answers WHERE answer != ''")?,
        total_sessions: count("SELECT COUNT(*) FROM agent_sessions")?,
        total_turns: count("SELECT COUNT(*) FROM chat_turns")?,
    })
}
