import * as Comlink from "comlink";
import type { DbWorkerApi } from "./db.worker";

/**
 * Main-thread handle to the SQLite Worker (see db.worker.ts). One worker,
 * one connection, created lazily on first use and reused after that —
 * matches the single `DbState` connection the desktop app keeps.
 */
let workerApi: Comlink.Remote<DbWorkerApi> | null = null;

function getWorker(): Comlink.Remote<DbWorkerApi> {
  if (!workerApi) {
    const worker = new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module" });
    workerApi = Comlink.wrap<DbWorkerApi>(worker);
  }
  return workerApi;
}

export function dbQuery(sql: string, params: SQLiteCompatibleType[] = []): Promise<Record<string, unknown>[]> {
  return getWorker().query(sql, params);
}

/** Resolves to the number of rows affected. */
export function dbRun(sql: string, params: SQLiteCompatibleType[] = []): Promise<number> {
  return getWorker().run(sql, params);
}

/** Vault support (see vault.ts) — exports the live database as raw bytes,
 * and loads decrypted bytes as a fresh in-memory database. See
 * db.worker.ts's module doc comment for why this exists instead of using
 * `sqlite3_serialize`/`deserialize` directly. */
export function dbExportSnapshot(): Promise<Uint8Array> {
  return getWorker().exportSnapshot();
}

export function dbLoadVaultDatabase(bytes: Uint8Array): Promise<void> {
  return getWorker().loadVaultDatabase(bytes);
}

export function dbWipePlaintextStorage(): Promise<void> {
  return getWorker().wipePlaintextStorage();
}

if (typeof window !== "undefined") {
  // Manual debugging aid for the web build — inspect any table from the
  // browser console with `await __clonosaurDb.query("SELECT * FROM ...")`.
  (window as unknown as { __clonosaurDb: unknown }).__clonosaurDb = { dbQuery, dbRun };
}
