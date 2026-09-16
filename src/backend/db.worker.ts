import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite.mjs";
import * as SQLite from "wa-sqlite";
// @ts-expect-error no type declarations for this example VFS
import { AccessHandlePoolVFS } from "wa-sqlite/src/examples/AccessHandlePoolVFS.js";
import { MemoryVFS } from "wa-sqlite/src/examples/MemoryVFS.js";
import * as Comlink from "comlink";
import schemaSql from "../../src-tauri/db/schema.sql?raw";

/**
 * Runs entirely inside a dedicated Worker: OPFS's synchronous access-handle
 * API (what `AccessHandlePoolVFS` uses) is only available off the main
 * thread. `db.ts` talks to this file the same way Rust commands talk to
 * `state.0.lock()` today — one connection, one place, everything else is a
 * method call away (see docs/WEB_VERSION.md, Phase W1).
 *
 * Vault mode (see vault.ts): when a master password is configured, the live
 * database is a `MemoryVFS`-backed in-memory database instead of the
 * OPFS-persisted `AccessHandlePoolVFS` one — this build of wa-sqlite has no
 * `sqlite3_serialize`/`deserialize` bindings, so `MemoryVFS`'s plain
 * `Map<name, {data, size}>` is used instead to get raw bytes in and out
 * (`loadVaultDatabase`/`exportSnapshot`), via a `VACUUM INTO` targeting that
 * VFS by name — SQLite's own supported mechanism for copying a live database
 * to an arbitrary destination VFS. Nothing here ever writes decrypted bytes
 * to OPFS; `vault.ts` handles encrypting `exportSnapshot()`'s output before
 * persisting it.
 */

let sqlite3: SQLiteAPI | null = null;
let db: number | null = null;
let ready: Promise<void> | null = null;

/** Set once `loadVaultDatabase` has switched the live connection to the
 * in-memory vault database — query/run then skip the plaintext OPFS path
 * entirely for the rest of this Worker's lifetime. */
let vaultMode = false;

/** Reference to the plaintext VFS's pool, kept around (instead of only a
 * local inside `open()`) so `wipePlaintextStorage` can release its pooled
 * OPFS access handles before deleting the directory — `AccessHandlePoolVFS`
 * holds those handles open for its whole lifetime once acquired, and OPFS
 * refuses to remove a file/directory that still has one open. */
let plaintextVfs: InstanceType<typeof AccessHandlePoolVFS> | null = null;

function open(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const module = await SQLiteESMFactory();
      sqlite3 = SQLite.Factory(module);
      const vfs = new AccessHandlePoolVFS("clonosaur");
      await vfs.isReady;
      plaintextVfs = vfs;
      sqlite3.vfs_register(vfs, true);
      // SQLITE_OPEN_URI so `exportSnapshot`'s `VACUUM INTO
      // 'file:export.db?vfs=memory'` gets parsed as a URI targeting the
      // named `memory` VFS — without it, the whole string is treated as a
      // literal filename on this connection's own VFS instead.
      db = await sqlite3.open_v2(
        "clonosaur.db",
        SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_URI,
      );
      await sqlite3.exec(db, schemaSql as string);
    })();
  }
  return ready;
}

async function ensureOpen(): Promise<void> {
  if (vaultMode) return;
  await open();
}

// AccessHandlePoolVFS explicitly does not implement SQLite's locking, so
// the *application* has to guarantee only one statement runs at a time
// (see the VFS's own doc comment). Without this, two calls landing
// concurrently on the same wasm instance — e.g. React StrictMode's
// double-invoked effects firing get_interview_answers twice back to
// back — corrupt the wasm heap ("memory access out of bounds") instead of
// just queueing. Every query/run is chained onto this promise so they
// always execute strictly one after another, regardless of how many
// arrive at once.
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => {});
  return result;
}

let memVfs: InstanceType<typeof MemoryVFS> | null = null;

/** Lazily registers a single shared `MemoryVFS` instance (name `"memory"`,
 * matching its own default), reused both as the export scratch space
 * (`export.db`, see `exportSnapshot`) and, once vault mode is active, as the
 * home of the live `clonosaur.db` in-memory database. One instance is
 * enough since neither use needs the other concurrently. */
function getMemVfs(): InstanceType<typeof MemoryVFS> {
  if (!memVfs) {
    memVfs = new MemoryVFS();
    // wa-sqlite's SQLiteVFS type declares xRead/xWrite with a param shape
    // that doesn't match MemoryVFS's actual (correct, runtime-verified
    // against VFS.Base) signature — a type-declaration inaccuracy in the
    // package itself, not a real incompatibility.
    sqlite3!.vfs_register(memVfs as unknown as SQLiteVFS, false);
  }
  return memVfs;
}

const api = {
  query(sql: string, params: SQLiteCompatibleType[] = []): Promise<Record<string, unknown>[]> {
    return serialize(async () => {
      await ensureOpen();
      const { rows, columns } = await sqlite3!.execWithParams(db!, sql, params);
      return rows.map((row: unknown[]) => Object.fromEntries(columns.map((c: string, i: number) => [c, row[i]])));
    });
  },

  /** Returns the number of rows affected, same reason Rust callers check
   * `conn.execute(...)`'s return value (e.g. to reject updates to a
   * nonexistent id). */
  run(sql: string, params: SQLiteCompatibleType[] = []): Promise<number> {
    return serialize(async () => {
      await ensureOpen();
      await sqlite3!.run(db!, sql, params);
      return sqlite3!.changes(db!);
    });
  },

  /** Copies the current live database (whichever mode is active) out as raw
   * bytes via `VACUUM INTO` a throwaway `MemoryVFS` entry. Used both for the
   * one-time plaintext→encrypted transition (`setup_master_password`, while
   * still in the default OPFS-backed mode) and for ongoing vault snapshots
   * (`lock_vault`/autosave, once in vault mode) — the mechanism is identical
   * either way; only what `db` currently points at differs. */
  exportSnapshot(): Promise<Uint8Array> {
    return serialize(async () => {
      await ensureOpen();
      const vfs = getMemVfs();
      for (const key of [...vfs.mapNameToFile.keys()]) {
        if (key.startsWith("export.db")) vfs.mapNameToFile.delete(key);
      }
      await sqlite3!.exec(db!, "VACUUM INTO 'file:export.db?vfs=memory'");
      // Not a plain `.get("export.db")`: this wasm build's URI handling
      // doesn't strip the "?vfs=memory" query string before handing the
      // name to the target VFS's `xOpen`, so the file actually lands under
      // the literal key "export.db?vfs=memory" — the VFS *routing* itself
      // (picking `memVfs` over the source connection's own VFS) works
      // correctly, only the stored key is mangled. Matching by prefix keeps
      // this robust to whichever exact key the quirk produces.
      const exportKey = [...vfs.mapNameToFile.keys()].find((k) => k.startsWith("export.db"));
      const file = exportKey ? vfs.mapNameToFile.get(exportKey) : undefined;
      if (!file || exportKey === undefined) {
        throw new Error(
          `VACUUM INTO no produjo el archivo esperado (keys: ${JSON.stringify([...vfs.mapNameToFile.keys()])})`,
        );
      }
      const bytes = new Uint8Array(file.data, 0, file.size).slice();
      vfs.mapNameToFile.delete(exportKey);
      return bytes;
    });
  },

  /** Loads decrypted bytes as the live `clonosaur.db`, backed by the shared
   * `MemoryVFS` instead of OPFS, and switches `query`/`run` to use it from
   * here on — see the module doc comment for why. Closes any previously
   * open plaintext connection first (defensive: shouldn't normally happen,
   * since the app gates rendering behind the vault-unlock screen before any
   * query can run, but this keeps a stray double-call from leaking a
   * connection). */
  async loadVaultDatabase(bytes: Uint8Array): Promise<void> {
    return serialize(async () => {
      if (!sqlite3) {
        const module = await SQLiteESMFactory();
        sqlite3 = SQLite.Factory(module);
      }
      if (db !== null) {
        await sqlite3.close(db);
        db = null;
      }
      const vfs = getMemVfs();
      const copy = bytes.slice();
      vfs.mapNameToFile.set("clonosaur.db", {
        name: "clonosaur.db",
        flags: 0,
        size: copy.byteLength,
        data: copy.buffer,
      });
      // Same SQLITE_OPEN_URI requirement as the plaintext open() above — a
      // `lock_vault` after this unlock also goes through `exportSnapshot`'s
      // `VACUUM INTO 'file:...?vfs=...'`.
      db = await sqlite3.open_v2(
        "clonosaur.db",
        SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_URI,
        "memory",
      );
      await sqlite3.exec(db, schemaSql as string);
      vaultMode = true;
      ready = Promise.resolve();
    });
  },

  /** Deletes the plaintext OPFS storage — used by `lock_vault` (once an
   * encrypted snapshot is safely written, no plaintext copy should remain)
   * and `reset_database`. Runs entirely inside this Worker, the same
   * context that opened the pool's sync access handles, so it can close
   * them (`plaintextVfs.close()`) before removing the directory — OPFS
   * refuses `removeEntry` on a directory with files still held open, and
   * that release can only happen from wherever the handles were acquired. */
  async wipePlaintextStorage(): Promise<void> {
    return serialize(async () => {
      if (db !== null && !vaultMode && sqlite3) {
        await sqlite3.close(db).catch(() => {});
        db = null;
      }
      if (plaintextVfs) {
        await plaintextVfs.close();
        plaintextVfs = null;
      }
      const root = await navigator.storage.getDirectory();
      await root.removeEntry("clonosaur", { recursive: true }).catch(() => {});
      ready = null;
    });
  },
};

export type DbWorkerApi = typeof api;

Comlink.expose(api);
