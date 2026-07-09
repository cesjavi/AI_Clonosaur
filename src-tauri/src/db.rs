use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

const SCHEMA: &str = include_str!("../db/schema.sql");

/// Shared state of the SQLite connection, managed by Tauri (`app.manage(...)`).
pub struct DbState(pub Mutex<Connection>);

fn db_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("no se pudo resolver el directorio de datos de la app");
    std::fs::create_dir_all(&dir).expect("no se pudo crear el directorio de datos de la app");
    dir.join("clonosaur.db")
}

/// Opens (or creates) the local database and applies the core schema idempotently.
pub fn init_db(app: &AppHandle) -> Connection {
    let conn = Connection::open(db_path(app)).expect("no se pudo abrir clonosaur.db");
    conn.pragma_update(None, "foreign_keys", true)
        .expect("no se pudo activar foreign_keys");
    conn.execute_batch(SCHEMA)
        .expect("no se pudo aplicar el schema de clonosaur.db");

    // Ad-hoc patch for databases created before this column was added: CREATE
    // TABLE IF NOT EXISTS doesn't alter tables that already exist. Expected
    // error (duplicate column) if the database already has it; ignored on purpose.
    let _ = conn.execute("ALTER TABLE people ADD COLUMN relationship TEXT", []);
    let _ = conn.execute("ALTER TABLE profile_traits ADD COLUMN evidence TEXT", []);
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN sensitivity TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE people ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0",
        [],
    );

    seed_default_groq_provider(&conn);

    conn
}

/// Preloads Groq as the suggested provider for hybrid mode (base URL + model),
/// without an API key — the user only has to paste their key in "Hybrid chat"
/// instead of filling in all three fields by hand. Never overwrites an
/// existing row (if the user already configured something, be it Groq or
/// another provider, it's respected).
fn seed_default_groq_provider(conn: &Connection) {
    let _ = conn.execute(
        "INSERT OR IGNORE INTO provider_credentials (provider, base_url, api_key, model, updated_at)
         VALUES ('groq', 'https://api.groq.com/openai/v1', '', 'llama-3.3-70b-versatile', datetime('now'))",
        [],
    );
}
