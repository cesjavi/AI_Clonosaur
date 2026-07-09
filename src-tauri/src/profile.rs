use chrono::Utc;
use rusqlite::params;
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::db::DbState;

#[derive(Serialize)]
pub struct ProfileTrait {
    pub id: String,
    pub category: String,
    pub trait_name: String,
    pub value: String,
    pub source: String,
    pub evidence: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
pub fn list_profile_traits(state: State<DbState>) -> Result<Vec<ProfileTrait>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, category, trait, value, source, evidence, created_at, updated_at
             FROM profile_traits ORDER BY category, created_at",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ProfileTrait {
                id: row.get(0)?,
                category: row.get(1)?,
                trait_name: row.get(2)?,
                value: row.get(3)?,
                source: row.get(4)?,
                evidence: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Manual creation of a trait. Traits with `source = 'inferred'` are created by the
/// automatic generators in Phase 4 (not yet implemented).
#[tauri::command]
pub fn create_profile_trait(
    state: State<DbState>,
    category: String,
    trait_name: String,
    value: String,
) -> Result<String, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO profile_traits (id, category, trait, value, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'manual', ?5, ?5)",
        params![id, category, trait_name, value, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(id)
}

#[tauri::command]
pub fn update_profile_trait(
    state: State<DbState>,
    id: String,
    category: String,
    trait_name: String,
    value: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let updated = conn
        .execute(
            "UPDATE profile_traits SET category = ?1, trait = ?2, value = ?3, updated_at = ?4
             WHERE id = ?5",
            params![category, trait_name, value, now, id],
        )
        .map_err(|e| e.to_string())?;

    if updated == 0 {
        return Err(format!("no existe un rasgo de perfil con id {id}"));
    }

    Ok(())
}

#[tauri::command]
pub fn delete_profile_trait(state: State<DbState>, id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM profile_traits WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
