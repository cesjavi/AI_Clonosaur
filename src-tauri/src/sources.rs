use rusqlite::params;
use serde::Serialize;
use tauri::State;

use crate::db::DbState;

#[derive(Serialize)]
pub struct SourceSummary {
    pub id: String,
    pub kind: String,
    pub file_name: Option<String>,
    pub imported_at: String,
    pub message_count: i64,
}

#[tauri::command]
pub fn list_sources(state: State<DbState>) -> Result<Vec<SourceSummary>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.kind, s.file_name, s.imported_at, COUNT(m.id)
             FROM sources s LEFT JOIN messages m ON m.source_id = s.id
             GROUP BY s.id ORDER BY s.imported_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(SourceSummary {
                id: row.get(0)?,
                kind: row.get(1)?,
                file_name: row.get(2)?,
                imported_at: row.get(3)?,
                message_count: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct PersonSummary {
    pub id: String,
    pub name: String,
    pub is_user: bool,
    pub relationship: Option<String>,
    pub excluded: bool,
    pub message_count: i64,
}

#[tauri::command]
pub fn list_people(state: State<DbState>) -> Result<Vec<PersonSummary>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.name, p.is_user, p.relationship, p.excluded, COUNT(m.id)
             FROM people p LEFT JOIN messages m ON m.person_id = p.id
             GROUP BY p.id ORDER BY p.name",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(PersonSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                is_user: row.get(2)?,
                relationship: row.get(3)?,
                excluded: row.get(4)?,
                message_count: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Excluding a contact removes them from the clone's memory: the RAG chat and the
/// copilot stop citing their messages (see `chat::build_rag_messages` and
/// `copilot::generate_draft`).
#[tauri::command]
pub fn set_person_excluded(state: State<DbState>, person_id: String, excluded: bool) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE people SET excluded = ?1 WHERE id = ?2",
        params![excluded, person_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Manual contact classification (familia/pareja/amigo/trabajo/conocido/otro
/// — i.e. family/partner/friend/work/acquaintance/other).
/// `relationship = None` clears the classification.
#[tauri::command]
pub fn set_person_relationship(
    state: State<DbState>,
    person_id: String,
    relationship: Option<String>,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE people SET relationship = ?1 WHERE id = ?2",
        params![relationship, person_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Marks a person as the clone's owner and retroactively fixes
/// `is_user` on all their already-imported messages. Used after an import
/// when the format doesn't allow automatically inferring who the user is.
#[tauri::command]
pub fn set_user_person(state: State<DbState>, person_id: String) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE people SET is_user = 1 WHERE id = ?1",
        params![person_id],
    )
    .map_err(|e| e.to_string())?;

    let updated = conn
        .execute(
            "UPDATE messages SET is_user = 1 WHERE person_id = ?1",
            params![person_id],
        )
        .map_err(|e| e.to_string())?;

    Ok(updated)
}
