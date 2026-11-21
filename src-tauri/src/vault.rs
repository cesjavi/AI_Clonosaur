use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use argon2::Argon2;
use rand::RngCore;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::db::{self, DbState};

/// Holds the derived AES-256 key in process memory ONLY while the vault is
/// unlocked so `RunEvent::Exit` can automatically re-encrypt and remove the
/// plaintext working copy when the app closes. Cleared on explicit lock/reset.
#[derive(Default)]
pub struct VaultKeyState(pub Mutex<Option<[u8; 32]>>);

fn store_session_key(app: &AppHandle, key: [u8; 32]) {
    if let Some(state) = app.try_state::<VaultKeyState>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(key);
        }
    }
}

fn clear_session_key(app: &AppHandle) {
    if let Some(state) = app.try_state::<VaultKeyState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(ref mut k) = *guard {
                k.fill(0);
            }
            *guard = None;
        }
    }
}

const NONCE_LEN: usize = 12;
const SALT_LEN: usize = 16;

fn vault_marker_path(app: &AppHandle) -> PathBuf {
    db::data_dir(app).join("clonosaur.vault.json")
}

fn encrypted_db_path(app: &AppHandle) -> PathBuf {
    db::data_dir(app).join("clonosaur.db.enc")
}

/// Writes `bytes` to a sibling temp file and atomically renames it over `dest`
/// so a mid-write crash or disk-full error never truncates an existing file.
fn write_atomic(dest: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = dest.with_extension(format!("tmp.{}", uuid::Uuid::new_v4()));
    if let Err(e) = std::fs::write(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    if let Err(e) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// Removes SQLite sidecar files (`-wal`, `-shm`, `-journal`) next to `db_path`
/// if present. Best-effort: missing files are ignored.
fn remove_sqlite_sidecars(db_path: &std::path::Path) {
    let base = db_path.as_os_str();
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = base.to_os_string();
        sidecar.push(suffix);
        let p = PathBuf::from(sidecar);
        if p.exists() {
            let _ = std::fs::remove_file(&p);
        }
    }
}

#[derive(Serialize, Deserialize)]
struct VaultMarker {
    salt_b64: String,
}

/// Whether a master password has ever been set up for this install. Checked
/// by `db::init_db` at startup to tell apart "first run" (no marker: create
/// a fresh plaintext database, same as before this feature existed) from
/// "locked" (marker exists but the plaintext working copy doesn't: needs
/// `unlock_vault` before any real data is available).
pub fn is_configured(app: &AppHandle) -> bool {
    vault_marker_path(app).exists()
}

#[derive(Serialize)]
pub struct VaultStatus {
    pub configured: bool,
    pub locked: bool,
}

#[tauri::command]
pub fn get_vault_status(app: AppHandle) -> VaultStatus {
    let configured = is_configured(&app);
    let locked = configured && !db::db_path(&app).exists();
    VaultStatus { configured, locked }
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("no se pudo derivar la clave a partir de la contraseña: {e}"))?;
    Ok(key)
}

/// `[12-byte random nonce][ciphertext || 16-byte GCM tag]`. A fresh random
/// nonce is generated on every call — required for AES-GCM: reusing a nonce
/// with the same key breaks its security guarantees entirely, so it's never
/// derived from anything reused across encryptions.
fn encrypt_bytes(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("no se pudo cifrar la base: {e}"))?;

    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Wrong password and tampered/corrupted files both surface as the same
/// generic GCM authentication failure — by design, AES-GCM never
/// distinguishes the two, so neither do we.
fn decrypt_bytes(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < NONCE_LEN {
        return Err("el archivo cifrado es inválido o está corrupto".to_string());
    }
    let (nonce_bytes, ciphertext) = data.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "contraseña incorrecta".to_string())
}

/// Sets up encryption at rest for the first time. Does NOT lock the app:
/// the live connection keeps working against the plaintext `clonosaur.db`
/// exactly as before — all this does is write the salt marker and produce
/// an initial `clonosaur.db.enc` snapshot, so the *next* `lock_vault` call
/// (or app close, if that's wired to lock too) has something to fall back
/// to. Only callable once; use `reset_database` to start over.
#[tauri::command]
pub fn setup_master_password(
    app: AppHandle,
    db: State<DbState>,
    password: String,
) -> Result<(), String> {
    if is_configured(&app) {
        return Err("ya hay una contraseña maestra configurada".to_string());
    }
    if password.chars().count() < 8 {
        return Err("la contraseña tiene que tener al menos 8 caracteres".to_string());
    }

    let mut salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let key = derive_key(&password, &salt)?;

    // Keep the DB lock held across checkpoint + file read so no concurrent
    // write can produce a torn SQLite snapshot.
    let plaintext = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").ok();
        std::fs::read(db::db_path(&app)).map_err(|e| e.to_string())?
    };

    let encrypted = encrypt_bytes(&key, &plaintext)?;
    write_atomic(&encrypted_db_path(&app), &encrypted)?;

    let marker = VaultMarker {
        salt_b64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, salt),
    };
    write_atomic(
        &vault_marker_path(&app),
        &serde_json::to_vec(&marker).map_err(|e| e.to_string())?,
    )?;

    store_session_key(&app, key);

    Ok(())
}

/// Decrypts `clonosaur.db.enc` into a working `clonosaur.db` and swaps the
/// real connection into `DbState`, replacing the empty in-memory placeholder
/// that `db::init_db` used while locked.
#[tauri::command]
pub fn unlock_vault(app: AppHandle, db: State<DbState>, password: String) -> Result<(), String> {
    if is_configured(&app) && db::db_path(&app).exists() {
        return Err("el vault ya está desbloqueado".to_string());
    }

    let marker: VaultMarker = serde_json::from_slice(
        &std::fs::read(vault_marker_path(&app))
            .map_err(|_| "el vault no está configurado".to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let salt = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, marker.salt_b64)
        .map_err(|e| e.to_string())?;
    let key = derive_key(&password, &salt)?;

    let encrypted = std::fs::read(encrypted_db_path(&app)).map_err(|e| e.to_string())?;
    let plaintext = decrypt_bytes(&key, &encrypted)?;

    let path = db::db_path(&app);
    write_atomic(&path, &plaintext)?;

    let new_conn = Connection::open(&path).map_err(|e| {
        let _ = std::fs::remove_file(&path);
        e.to_string()
    })?;
    if let Err(e) = db::apply_schema(&new_conn) {
        drop(new_conn);
        let _ = std::fs::remove_file(&path);
        remove_sqlite_sidecars(&path);
        return Err(e);
    }

    let mut guard = db.0.lock().map_err(|e| e.to_string())?;
    *guard = new_conn;
    drop(guard);

    store_session_key(&app, key);

    Ok(())
}

/// "Lock now": re-derives the key from the password (never cached between
/// calls, so it has to be typed again here), re-encrypts the live database,
/// then drops the plaintext file and swaps `DbState` back to an empty
/// in-memory placeholder.
#[tauri::command]
pub fn lock_vault(app: AppHandle, db: State<DbState>, password: String) -> Result<(), String> {
    if !is_configured(&app) {
        return Err("todavía no configuraste una contraseña maestra".to_string());
    }
    let path = db::db_path(&app);
    if !path.exists() {
        return Err("el vault ya está bloqueado".to_string());
    }

    let marker: VaultMarker =
        serde_json::from_slice(&std::fs::read(vault_marker_path(&app)).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let salt = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, marker.salt_b64)
        .map_err(|e| e.to_string())?;
    let key = derive_key(&password, &salt)?;

    let previous_encrypted = std::fs::read(encrypted_db_path(&app)).map_err(|e| e.to_string())?;
    decrypt_bytes(&key, &previous_encrypted)?;

    // Hold the DB lock across snapshot read, atomic encrypted write, connection
    // swap, and plaintext deletion so no concurrent command can slip a write in
    // between snapshot and deletion (TOCTOU data loss).
    let mut guard = db.0.lock().map_err(|e| e.to_string())?;
    guard.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").ok();
    let plaintext = std::fs::read(&path).map_err(|e| e.to_string())?;

    let encrypted = encrypt_bytes(&key, &plaintext)?;
    write_atomic(&encrypted_db_path(&app), &encrypted)?;

    let placeholder = Connection::open_in_memory().map_err(|e| e.to_string())?;
    db::apply_schema(&placeholder)?;
    let real_conn = std::mem::replace(&mut *guard, placeholder);
    drop(real_conn);

    if let Err(e) = std::fs::remove_file(&path) {
        // Restore the live connection so the app is never left in a half-locked
        // state (plaintext still on disk but DbState pointing to an empty memory DB).
        if let Ok(reopened) = Connection::open(&path) {
            if db::apply_schema(&reopened).is_ok() {
                *guard = reopened;
            }
        }
        return Err(format!(
            "se guardó la copia cifrada pero no se pudo borrar el archivo sin cifrar (queda sin cifrar en disco, reintentá bloquear): {e}"
        ));
    }
    remove_sqlite_sidecars(&path);
    clear_session_key(&app);

    Ok(())
}

/// Best-effort automatic lock called on `RunEvent::Exit`: re-encrypts the live
/// database using the in-memory session key, closes the SQLite connection, and
/// removes the plaintext working copy so closing the app never leaves the
/// vault unlocked on disk.
pub fn lock_on_exit(app: &AppHandle) {
    if !is_configured(app) {
        return;
    }
    let path = db::db_path(app);
    if !path.exists() {
        clear_session_key(app);
        return;
    }
    let key = app.try_state::<VaultKeyState>().and_then(|state| {
        state.0.lock().ok().and_then(|mut guard| {
            let k = *guard;
            if let Some(ref mut existing) = *guard {
                existing.fill(0);
            }
            *guard = None;
            k
        })
    });
    let Some(mut key) = key else {
        return;
    };

    if let Some(db_state) = app.try_state::<DbState>() {
        if let Ok(mut guard) = db_state.0.lock() {
            guard.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").ok();
            match std::fs::read(&path)
                .map_err(|e| e.to_string())
                .and_then(|plaintext| encrypt_bytes(&key, &plaintext))
                .and_then(|encrypted| write_atomic(&encrypted_db_path(app), &encrypted))
            {
                Ok(()) => {
                    if let Ok(placeholder) = Connection::open_in_memory() {
                        let real_conn = std::mem::replace(&mut *guard, placeholder);
                        drop(real_conn);
                        if let Err(e) = std::fs::remove_file(&path) {
                            eprintln!("clonosaur: no se pudo borrar clonosaur.db al salir: {e}");
                        } else {
                            remove_sqlite_sidecars(&path);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("clonosaur: no se pudo cifrar el vault al salir: {e}");
                }
            }
        }
    }
    key.fill(0);
}

/// Full reset: requires typing an exact confirmation phrase (checked
/// verbatim, not just "non-empty") so it's never triggered by a stray
/// click. Releases the active connection before deleting anything —
/// necessary on Windows, where an open file can't be deleted.
#[tauri::command]
pub fn reset_database(
    app: AppHandle,
    db: State<DbState>,
    confirmation: String,
) -> Result<(), String> {
    const REQUIRED_PHRASE: &str = "ELIMINAR TODO";
    if confirmation.trim() != REQUIRED_PHRASE {
        return Err(format!(
            "escribí exactamente \"{REQUIRED_PHRASE}\" para confirmar"
        ));
    }

    clear_session_key(&app);

    let mut guard = db.0.lock().map_err(|e| e.to_string())?;
    let placeholder = Connection::open_in_memory().map_err(|e| e.to_string())?;
    db::apply_schema(&placeholder)?;
    let old = std::mem::replace(&mut *guard, placeholder);
    drop(old);

    let db_file = db::db_path(&app);
    for path in [
        db_file.clone(),
        encrypted_db_path(&app),
        vault_marker_path(&app),
    ] {
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("no se pudo borrar {}: {e}", path.display()))?;
        }
    }
    remove_sqlite_sidecars(&db_file);

    let new_conn = Connection::open(&db_file).map_err(|e| e.to_string())?;
    db::apply_schema(&new_conn)?;
    *guard = new_conn;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_then_decrypt_round_trips_the_plaintext() {
        let key = derive_key("correct horse battery staple", b"0123456789abcdef").unwrap();
        let plaintext: &[u8] = b"hello vault";
        let encrypted = encrypt_bytes(&key, plaintext).unwrap();
        let decrypted = decrypt_bytes(&key, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext.to_vec());
    }

    #[test]
    fn decrypt_fails_with_the_wrong_password() {
        let salt = b"0123456789abcdef";
        let right_key = derive_key("right password", salt).unwrap();
        let wrong_key = derive_key("wrong password", salt).unwrap();
        let encrypted = encrypt_bytes(&right_key, b"secret data").unwrap();
        assert!(decrypt_bytes(&wrong_key, &encrypted).is_err());
    }

    #[test]
    fn decrypt_fails_on_truncated_or_corrupt_data() {
        let key = derive_key("password", b"0123456789abcdef").unwrap();
        assert!(decrypt_bytes(&key, b"too short").is_err());
    }

    #[test]
    fn two_encryptions_of_the_same_plaintext_produce_different_ciphertext() {
        // Each call must use a fresh random nonce — reusing one with the
        // same key would break AES-GCM's security guarantees entirely.
        let key = derive_key("password", b"0123456789abcdef").unwrap();
        let a = encrypt_bytes(&key, b"same plaintext").unwrap();
        let b = encrypt_bytes(&key, b"same plaintext").unwrap();
        assert_ne!(a, b);
    }
}
