use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

const SCHEMA: &str = include_str!("../db/schema.sql");

/// Shared state of the SQLite connection, managed by Tauri (`app.manage(...)`).
/// While the vault is locked, this holds a throwaway in-memory connection
/// (empty schema, no real data) instead of `None` — every existing command
/// already assumes a live `Connection` is always here, and changing that
/// would mean touching every one of them. `vault::unlock` swaps the real,
/// decrypted connection in; `vault::lock` swaps it back out. See vault.rs.
pub struct DbState(pub Mutex<Connection>);

pub(crate) fn db_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("clonosaur.db")
}

pub(crate) fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("no se pudo resolver el directorio de datos de la app");
    std::fs::create_dir_all(&dir).expect("no se pudo crear el directorio de datos de la app");
    dir
}

/// Applies the core schema (idempotent) plus the ad-hoc patches accumulated
/// for databases created before certain columns existed. Shared by the
/// normal startup path, `vault::unlock` (after decrypting), and
/// `vault::reset_database` (fresh empty database) so all three stay in sync.
pub(crate) fn apply_schema(conn: &Connection) {
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

    seed_default_groq_provider(conn);
}

/// Opens (or creates) the local database and applies the core schema idempotently.
/// If the vault is configured (see `vault::is_configured`) but currently
/// locked — meaning the plaintext working copy doesn't exist yet, only the
/// encrypted file does — this deliberately does NOT create a fresh empty
/// `clonosaur.db`: that would silently orphan the real (encrypted) data
/// instead of prompting to unlock it. An in-memory placeholder is returned
/// instead, and the frontend gates every other screen behind the unlock
/// screen until `vault::unlock` swaps in the real connection.
pub fn init_db(app: &AppHandle) -> Connection {
    if crate::vault::is_configured(app) && !db_path(app).exists() {
        let conn =
            Connection::open_in_memory().expect("no se pudo abrir la base temporal en memoria");
        apply_schema(&conn);
        return conn;
    }

    let conn = Connection::open(db_path(app)).expect("no se pudo abrir clonosaur.db");
    apply_schema(&conn);
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
