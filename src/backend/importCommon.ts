import { dbQuery, dbRun } from "./db";
import { classify } from "./sensitivity";

export interface ImportSummary {
  source_id: string;
  imported: number;
  duplicates: number;
  /** Author names detected in the import (useful for the user to later
   * indicate which of them is themself). */
  participants: string[];
}

/** Normalizes a downloaded file's name into a stable conversation
 * fingerprint by stripping the "(1)", "(2)", etc. suffix browsers/OSes
 * append to avoid overwriting a file that already exists on a re-download.
 * Without this, every re-download of the same export (very common — Gmail
 * Takeout, Discord/Reddit exports) looks like a brand new conversation and
 * duplicates every message already imported from it.
 *
 * Trade-off, accepted deliberately: the OS appends the same "(1)" suffix on
 * *any* same-directory name collision, not only on a re-download of the
 * identical file — e.g. two different Discord servers both exported as
 * "general.csv" would have the second saved as "general (1).csv" and get
 * merged into one conversation here. Re-download deduping (the common case)
 * was judged more valuable than guarding against that rarer collision;
 * fixing both would need matching by content (e.g. participants/first
 * message), not just the file name. */
export function fingerprintFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  const dotIdx = lower.lastIndexOf(".");
  const stem = dotIdx === -1 ? lower : lower.slice(0, dotIdx);
  const ext = dotIdx === -1 ? "" : lower.slice(dotIdx);
  const trimmed = stem.trimEnd();
  const match = trimmed.match(/\((\d+)\)$/);
  if (match && match.index !== undefined) {
    return `${trimmed.slice(0, match.index).trimEnd()}${ext}`;
  }
  return lower;
}

export async function createSource(kind: string, fileName: string): Promise<string> {
  const id = crypto.randomUUID();
  await dbRun("INSERT INTO sources (id, kind, file_name, imported_at) VALUES (?, ?, ?, ?)", [
    id,
    kind,
    fileName,
    new Date().toISOString(),
  ]);
  return id;
}

/** Looks for an existing conversation of the same source `kind` by
 * `externalId` (stable fingerprint of the chat/thread) before creating a
 * new one — otherwise every reimport of the same file would land in a
 * different conversation and duplicate detection (scoped per conversation)
 * would never find matches. */
export async function getOrCreateConversation(
  sourceId: string,
  kind: string,
  title: string,
  externalId: string | null,
): Promise<string> {
  if (externalId) {
    const existing = await dbQuery(
      `SELECT c.id FROM conversations c JOIN sources s ON s.id = c.source_id
       WHERE s.kind = ? AND c.external_id = ?`,
      [kind, externalId],
    );
    if (existing.length > 0) {
      return existing[0].id as string;
    }
  }

  const id = crypto.randomUUID();
  await dbRun(
    "INSERT INTO conversations (id, source_id, title, external_id, created_at) VALUES (?, ?, ?, ?, ?)",
    [id, sourceId, title, externalId, new Date().toISOString()],
  );
  return id;
}

/** Looks for a person by exact name; creates it if it doesn't exist. */
export async function getOrCreatePerson(name: string): Promise<string> {
  const existing = await dbQuery("SELECT id FROM people WHERE name = ?", [name]);
  if (existing.length > 0) {
    return existing[0].id as string;
  }
  const id = crypto.randomUUID();
  await dbRun("INSERT INTO people (id, name, is_user, created_at) VALUES (?, ?, 0, ?)", [
    id,
    name,
    new Date().toISOString(),
  ]);
  return id;
}

export async function ensureParticipant(conversationId: string, personId: string): Promise<void> {
  await dbRun(
    "INSERT OR IGNORE INTO conversation_participants (conversation_id, person_id) VALUES (?, ?)",
    [conversationId, personId],
  );
}

function duplicateKey(personId: string | null, timestamp: string, text: string): string {
  return `${personId ?? ""} ${timestamp} ${text}`;
}

export type DuplicateChecker = (personId: string | null, timestamp: string, text: string) => boolean;

/** Loads every (person_id, timestamp, text) key already present in a
 * conversation once, so `insertMessageIfNew` can check duplicates against an
 * in-memory Set instead of running a `SELECT` per message. On the web build
 * each `dbQuery`/`dbRun` is a full round-trip to the serialized SQLite
 * worker; for a large import (tens of thousands of rows) that turns 2×N
 * sequential round-trips into one query plus N inserts. Matches within the
 * same import (a file containing the same message twice) are still caught,
 * since a key is added to the set as soon as it's seen — mirroring the old
 * per-row DB check, which would have found the just-inserted row too. */
export async function createDuplicateChecker(conversationId: string): Promise<DuplicateChecker> {
  const rows = await dbQuery("SELECT person_id, timestamp, text FROM messages WHERE conversation_id = ?", [
    conversationId,
  ]);
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(duplicateKey(row.person_id as string | null, row.timestamp as string, row.text as string));
  }
  return (personId, timestamp, text) => {
    const key = duplicateKey(personId, timestamp, text);
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function toRfc3339Utc(y: number, mo: number, d: number, h: number, mi: number, s: number): string {
  // mo is 1-indexed here, matching how callers read it from the source text.
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.000Z`;
}

/** Tries to parse a timestamp in a few common export formats (Discord,
 * Reddit); if none match, falls back to the current time as a last resort
 * instead of failing the whole import over one row with a weird date. */
export function normalizeTimestamp(raw: string): string {
  const trimmed = raw.trim();

  // Requires an explicit "Z" or numeric offset, matching Rust's
  // `DateTime::parse_from_rfc3339` (strict, offset-mandatory) on the desktop
  // side. Without this, an offset-less "2024-03-04T10:15:00" would be handed
  // to `new Date(...)`, which the JS spec parses as *local* time — the same
  // file imported on machines in different timezones would then store
  // different UTC timestamps for the same message. An offset-less value now
  // falls through to the fallback below instead, exactly like the Rust side.
  const rfc3339 = new Date(trimmed);
  if (
    !Number.isNaN(rfc3339.getTime()) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
  ) {
    return rfc3339.toISOString();
  }

  // Discord (old exports): "MM/DD/YYYY HH:MM AM/PM"
  const discordMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (discordMatch) {
    const [, mo, d, y, hRaw, mi, meridiem] = discordMatch;
    let h = parseInt(hRaw, 10) % 12;
    if (meridiem.toUpperCase() === "PM") h += 12;
    return toRfc3339Utc(Number(y), Number(mo), Number(d), h, Number(mi), 0);
  }

  // Reddit: "YYYY-MM-DD HH:MM:SS UTC"
  const redditMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*UTC$/i);
  if (redditMatch) {
    const [, y, mo, d, h, mi, s] = redditMatch;
    return toRfc3339Utc(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s));
  }

  // Plain "YYYY-MM-DD HH:MM:SS"
  const plainMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (plainMatch) {
    const [, y, mo, d, h, mi, s] = plainMatch;
    return toRfc3339Utc(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s));
  }

  return new Date().toISOString();
}

/** Minimal RFC4180-ish CSV parser (quoted fields, "" as an escaped quote,
 * CRLF/LF line endings) — shared by every importer that reads a CSV
 * export (generic, Discord, Reddit) instead of each re-implementing it. */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const text = content.replace(/\r\n/g, "\n");

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      endField();
      i += 1;
      continue;
    }
    if (c === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field !== "" || row.length > 0) endRow();

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Inserts a message if it's not a duplicate (same text + timestamp + author
 * within the same conversation). Returns `true` if it was inserted, `false`
 * if it already existed (reimport of the same source). `isDuplicate` comes
 * from `createDuplicateChecker`, built once per import instead of querying
 * per row. */
export async function insertMessageIfNew(
  conversationId: string,
  sourceId: string,
  personId: string | null,
  isUser: boolean,
  text: string,
  timestamp: string,
  isDuplicate: DuplicateChecker,
): Promise<boolean> {
  if (isDuplicate(personId, timestamp, text)) {
    return false;
  }

  // Sensitivity classification at ingestion time, not as a separate step —
  // this way RAG chat can filter on it from the day the message exists.
  const sensitivity = classify(text);

  await dbRun(
    `INSERT INTO messages (id, conversation_id, source_id, person_id, is_user, text, timestamp, metadata, sensitivity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [crypto.randomUUID(), conversationId, sourceId, personId, isUser ? 1 : 0, text, timestamp, sensitivity, new Date().toISOString()],
  );
  return true;
}
