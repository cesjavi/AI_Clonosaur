import { dbExportSnapshot, dbLoadVaultDatabase, dbWipePlaintextStorage, setOnDbMutated } from "./db";
import { decryptBytes, deriveKey, encryptBytes, randomSalt } from "./vaultCrypto";

/** Web-build vault, mirroring `src-tauri/src/vault.rs`'s public API and
 * on-disk layout as closely as the platform allows — see db.worker.ts's
 * module doc comment for why the underlying mechanism (in-memory `MemoryVFS`
 * database instead of a decrypted OPFS working copy) had to differ.
 *
 * OPFS layout (root of this origin's private filesystem):
 * - `clonosaur.vault.json` — marker file (salt, base64). Presence means a
 *   master password has been configured, same semantics as desktop's marker.
 * - `clonosaur.db.enc` — the encrypted snapshot of the whole database.
 * - `clonosaur/` — the plaintext `AccessHandlePoolVFS` pool directory used
 *   before a vault is configured, and (transiently) between
 *   `setup_master_password` and the first `lock_vault`, exactly like
 *   desktop's plaintext `clonosaur.db` working copy.
 */

const MARKER_NAME = "clonosaur.vault.json";
const BLOB_NAME = "clonosaur.db.enc";

interface VaultMarker {
  saltB64: string;
}

/** Tracks whether *this page session* has a live, trustworthy plaintext
 * database to export — either because it just decrypted one into the
 * Worker's memory (`unlockVault`) or because `setupMasterPassword` was just
 * run against the already-live working copy. There's no OPFS-visible
 * "unlocked" signal to check on a fresh load the way desktop checks "does
 * the plaintext file exist", since nothing plaintext ever touches OPFS here.
 * A fresh page load always starts locked if a vault is configured; unlocking
 * only lasts until the tab closes or reloads. `lockVault` must refuse to run
 * while this is false — otherwise it would export whatever empty/default
 * database `ensureOpen()` happens to open and overwrite the real encrypted
 * blob with it. */
let sessionUnlocked = false;
/** Non-extractable AES-256-GCM key held in memory ONLY while unlocked so every
 * mutation in `MemoryVFS` is automatically persisted (re-encrypted with a fresh
 * nonce) to `clonosaur.db.enc`, preventing silent data loss on tab close/reload.
 * Cleared immediately on `lockVault` and `resetDatabase`. */
let sessionKey: CryptoKey | null = null;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let autosaveInFlight: Promise<void> = Promise.resolve();
let dirty = false;

async function persistEncryptedSnapshot(key: CryptoKey): Promise<void> {
  const plaintext = await dbExportSnapshot();
  const encrypted = await encryptBytes(key, plaintext);
  await writeFile(BLOB_NAME, encrypted);
}

function scheduleAutosave(): void {
  if (!sessionUnlocked || !sessionKey) return;
  dirty = true;
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void flushAutosave();
  }, 400);
}

function flushAutosave(): Promise<void> {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  const key = sessionKey;
  if (!sessionUnlocked || !key || !dirty) return autosaveInFlight;
  dirty = false;
  autosaveInFlight = autosaveInFlight
    .then(() => persistEncryptedSnapshot(key))
    .catch((err) => {
      // Restore dirty flag so a subsequent write or explicit lock retries.
      dirty = true;
      console.error("Error al guardar snapshot cifrado del vault:", err);
    });
  return autosaveInFlight;
}

function enableAutosave(key: CryptoKey): void {
  sessionKey = key;
  sessionUnlocked = true;
  setOnDbMutated(scheduleAutosave);
}

function disableAutosave(): void {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  dirty = false;
  sessionKey = null;
  sessionUnlocked = false;
  setOnDbMutated(null);
}

if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushAutosave();
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (sessionUnlocked && dirty) {
      void flushAutosave();
      e.preventDefault();
    }
  });
}

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

async function readFile(name: string): Promise<Uint8Array | null> {
  try {
    const root = await getRoot();
    const handle = await root.getFileHandle(name, { create: false });
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

async function writeFile(name: string, data: Uint8Array): Promise<void> {
  const root = await getRoot();
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data as BufferSource);
  await writable.close();
}

async function deleteFile(name: string): Promise<void> {
  const root = await getRoot();
  await root.removeEntry(name).catch(() => {});
}

async function readMarker(): Promise<VaultMarker | null> {
  const bytes = await readFile(MARKER_NAME);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as VaultMarker;
  } catch {
    return null;
  }
}

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface VaultStatus {
  configured: boolean;
  locked: boolean;
}

export async function getVaultStatus(): Promise<VaultStatus> {
  const marker = await readMarker();
  const configured = marker !== null;
  return { configured, locked: configured && !sessionUnlocked };
}

/** Sets up encryption at rest for the first time. Does NOT lock the app —
 * mirrors vault.rs exactly: the live (still-plaintext) database keeps
 * working as before, this only writes the marker and an initial encrypted
 * snapshot so the *next* `lockVault` call has something to fall back to. */
export async function setupMasterPassword(password: string): Promise<void> {
  if (await readMarker()) {
    throw new Error("ya hay una contraseña maestra configurada");
  }
  if ([...password].length < 8) {
    throw new Error("la contraseña tiene que tener al menos 8 caracteres");
  }

  const salt = randomSalt();
  const key = await deriveKey(password, salt);

  const plaintext = await dbExportSnapshot();
  const encrypted = await encryptBytes(key, plaintext);

  await writeFile(BLOB_NAME, encrypted);
  await writeFile(MARKER_NAME, new TextEncoder().encode(JSON.stringify({ saltB64: bytesToB64(salt) })));

  // Immediately move the live session into in-memory vault mode and wipe
  // plaintext OPFS storage so edits made after setup are autosaved into
  // `clonosaur.db.enc` (never lost on reload) and no plaintext lingers on disk.
  await dbWipePlaintextStorage();
  await dbLoadVaultDatabase(plaintext);
  enableAutosave(key);
}

/** Decrypts the stored snapshot and loads it as the live in-memory
 * database for this page session (see db.worker.ts). */
export async function unlockVault(password: string): Promise<void> {
  if (sessionUnlocked) {
    throw new Error("el vault ya está desbloqueado");
  }
  const marker = await readMarker();
  if (!marker) {
    throw new Error("el vault no está configurado");
  }
  const encrypted = await readFile(BLOB_NAME);
  if (!encrypted) {
    throw new Error("no se encontró la base cifrada");
  }

  const key = await deriveKey(password, b64ToBytes(marker.saltB64));
  const plaintext = await decryptBytes(key, encrypted); // throws "contraseña incorrecta" on failure

  await dbLoadVaultDatabase(plaintext);
  enableAutosave(key);
}

/** "Lock now": re-derives the key from the password, verifies it against the
 * *previous* snapshot before touching anything, flushes/writes a fresh
 * encrypted snapshot, then wipes all in-memory and plaintext OPFS state. */
export async function lockVault(password: string): Promise<void> {
  if (!sessionUnlocked) {
    throw new Error("el vault no está desbloqueado en esta sesión");
  }
  const marker = await readMarker();
  if (!marker) {
    throw new Error("todavía no configuraste una contraseña maestra");
  }
  const salt = b64ToBytes(marker.saltB64);
  const key = await deriveKey(password, salt);

  await flushAutosave();

  const previousEncrypted = await readFile(BLOB_NAME);
  if (!previousEncrypted) {
    throw new Error("no se encontró la base cifrada");
  }
  await decryptBytes(key, previousEncrypted); // verification only; throws on wrong password

  await persistEncryptedSnapshot(key);

  disableAutosave();
  await dbWipePlaintextStorage();
}

/** Full reset: requires typing an exact confirmation phrase (checked
 * verbatim, not just "non-empty") so it's never triggered by a stray click. */
export async function resetDatabase(confirmation: string): Promise<void> {
  const REQUIRED_PHRASE = "ELIMINAR TODO";
  if (confirmation.trim() !== REQUIRED_PHRASE) {
    throw new Error(`escribí exactamente "${REQUIRED_PHRASE}" para confirmar`);
  }

  disableAutosave();
  await autosaveInFlight.catch(() => {});
  await dbWipePlaintextStorage();
  await deleteFile(BLOB_NAME);
  await deleteFile(MARKER_NAME);
}
