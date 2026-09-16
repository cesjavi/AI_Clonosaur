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
  const headers = rows[0];
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
    const isUserRaw = isUserIdx !== -1 ? row[isUserIdx] : undefined;
    const isUser = isUserRaw === undefined ? null : isUserRaw === "true" || isUserRaw === "1";
    records.push({ text, timestamp, author, is_user: isUser });
  }
  return records;
}

/** Safety-net import: any source without a dedicated parser, as long as it
 * can be expressed as `.json`/`.csv` with columns `text`/`timestamp?`/
 * `author?`/`is_user?`, or plain `.txt` (one line = one of the user's own
 * messages). */
export async function importGenericFile(fileName: string, bytes: Uint8Array): Promise<ImportSummary> {
  const content = new TextDecoder("utf-8").decode(bytes);
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
    records = parsed as GenericRecord[];
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
  // The file name is the "thread" fingerprint: reimporting the same file
  // lands in the same conversation, and duplicate detection avoids
  // repeating messages.
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
  // Caches resolved person ids by author name so a large import with only a
  // handful of distinct authors doesn't issue a person-lookup round trip per
  // message.
  const personIdCache = new Map<string, string>();

  for (const rec of records) {
    const timestamp = rec.timestamp ?? new Date().toISOString();

    let personId: string | null = null;
    let isUser: boolean;
    if (rec.author) {
      if (!participants.includes(rec.author)) participants.push(rec.author);
      const cached = personIdCache.get(rec.author);
      if (cached) {
        personId = cached;
      } else {
        personId = await importCommon.getOrCreatePerson(rec.author);
        await importCommon.ensureParticipant(conversationId, personId);
        personIdCache.set(rec.author, personId);
      }
      isUser = rec.is_user ?? false;
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
    );

    if (inserted) imported += 1;
    else duplicates += 1;
  }

  return { source_id: sourceId, imported, duplicates, participants };
}
