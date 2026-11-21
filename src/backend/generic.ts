import * as importCommon from "./importCommon";
import type { ImportSummary } from "./importCommon";

interface GenericRecord {
  text: string;
  timestamp?: string | null;
  author?: string | null;
  is_user?: boolean | null;
}

function parseCsvRecords(content: string): GenericRecord[] {
  const rows = importCommon.parseCsv(content);
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const textIdx = headers.indexOf("text");
  if (textIdx === -1) throw new Error("el CSV necesita una columna 'text'");
  const timestampIdx = headers.indexOf("timestamp");
  const authorIdx = headers.indexOf("author");
  const isUserIdx = headers.indexOf("is_user");

  const records: GenericRecord[] = [];
  for (const row of rows.slice(1)) {
    const text = (row[textIdx] ?? "").trim();
    if (!text) continue;
    const timestamp = timestampIdx !== -1 ? row[timestampIdx]?.trim() || null : null;
    const author = authorIdx !== -1 ? row[authorIdx]?.trim() || null : null;
    const isUserRaw = isUserIdx !== -1 ? row[isUserIdx]?.trim() : undefined;
    const isUser =
      !isUserRaw ? null : isUserRaw.toLowerCase() === "true" || isUserRaw === "1";
    records.push({ text, timestamp, author, is_user: isUser });
  }
  return records;
}

/** Safety-net import: any source without a dedicated parser, as long as it
 * can be expressed as `.json`/`.csv` with columns `text`/`timestamp?`/
 * `author?`/`is_user?`, or plain `.txt` (one line = one of the user's own
 * messages). */
export async function importGenericFile(fileName: string, bytes: Uint8Array): Promise<ImportSummary> {
  const content = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  const lower = fileName.toLowerCase();

  let records: GenericRecord[];
  if (lower.endsWith(".json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error(`JSON inválido: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    if (!Array.isArray(parsed)) {
      throw new Error("el JSON tiene que ser un array de registros");
    }
    records = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object" || typeof (item as { text?: unknown }).text !== "string") {
        throw new Error("cada registro del JSON necesita un campo 'text' de tipo string");
      }
      const r = item as { text: string; timestamp?: unknown; author?: unknown; is_user?: unknown };
      const text = r.text.trim();
      if (!text) continue;
      records.push({
        text,
        timestamp: typeof r.timestamp === "string" && r.timestamp.trim() ? r.timestamp.trim() : null,
        author: typeof r.author === "string" && r.author.trim() ? r.author.trim() : null,
        is_user: typeof r.is_user === "boolean" ? r.is_user : null,
      });
    }
  } else if (lower.endsWith(".csv")) {
    records = parseCsvRecords(content);
  } else {
    records = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .map((text) => ({ text, timestamp: null, author: null, is_user: true }));
  }

  if (records.length === 0) {
    throw new Error("no se encontraron mensajes en el archivo");
  }

  const sourceId = await importCommon.createSource("generic", fileName);
  const conversationId = await importCommon.getOrCreateConversation(
    sourceId,
    "generic",
    fileName,
    importCommon.fingerprintFileName(fileName),
  );
  const isDuplicate = await importCommon.createDuplicateChecker(conversationId);

  let imported = 0;
  let duplicates = 0;
  const participants: string[] = [];
  const personCache = new Map<string, { id: string; isUser: boolean }>();

  for (const rec of records) {
    const hasTimestamp = Boolean(rec.timestamp);
    const timestamp = rec.timestamp ? importCommon.normalizeTimestamp(rec.timestamp) : new Date().toISOString();

    let personId: string | null = null;
    let isUser: boolean;
    if (rec.author) {
      if (!participants.includes(rec.author)) participants.push(rec.author);
      let person = personCache.get(rec.author);
      if (!person) {
        person = await importCommon.getOrCreatePersonWithFlag(rec.author);
        await importCommon.ensureParticipant(conversationId, person.id);
        personCache.set(rec.author, person);
      }
      personId = person.id;
      isUser = rec.is_user ?? person.isUser;
    } else {
      isUser = rec.is_user ?? true;
    }

    const inserted = await importCommon.insertMessageIfNew(
      conversationId,
      sourceId,
      personId,
      isUser,
      rec.text,
      timestamp,
      isDuplicate,
      hasTimestamp,
    );

    if (inserted) imported += 1;
    else duplicates += 1;
  }

  return { source_id: sourceId, imported, duplicates, participants };
}
