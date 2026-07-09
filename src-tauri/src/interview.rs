use chrono::Utc;
use rusqlite::params;
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::db::DbState;

#[derive(Serialize)]
pub struct InterviewAnswer {
    pub module: String,
    pub question_id: String,
    pub question_text: String,
    pub answer: String,
    pub updated_at: String,
}

/// Returns all saved answers, so the frontend can cross-reference them with
/// `interview/questions.json` and display what has already been answered.
#[tauri::command]
pub fn get_interview_answers(state: State<DbState>) -> Result<Vec<InterviewAnswer>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT module, question_id, question_text, answer, updated_at FROM interview_answers")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(InterviewAnswer {
                module: row.get(0)?,
                question_id: row.get(1)?,
                question_text: row.get(2)?,
                answer: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Persists a single answer. Called when leaving each field (blur),
/// not at the end of the interview, so progress isn't lost on an unexpected close.
#[tauri::command]
pub fn save_interview_answer(
    state: State<DbState>,
    module: String,
    question_id: String,
    question_text: String,
    answer: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO interview_answers (id, module, question_id, question_text, answer, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(module, question_id) DO UPDATE SET
            question_text = excluded.question_text,
            answer = excluded.answer,
            updated_at = excluded.updated_at",
        params![
            Uuid::new_v4().to_string(),
            module,
            question_id,
            question_text,
            answer,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}
