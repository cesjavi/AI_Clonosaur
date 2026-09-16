import * as importCommon from "./importCommon";
import type { ImportSummary } from "./importCommon";

/** The per-channel Discord export (`messages.csv`) is treated as the user's
 * own content, same as Twitter/Reddit, to simplify the MVP: no attempt is
 * made to distinguish speakers within the CSV. */
export async function importDiscordFile(fileName: string, bytes: Uint8Array): Promise<ImportSummary> {
  const content = new TextDecoder("utf-8").decode(bytes);
  const rows = importCommon.parseCsv(content);
  if (rows.length === 0) {
    throw new Error("el CSV necesita una columna 'Timestamp' o 'Date'");
  }

  const headers = rows[0].map((h) => h.toLowerCase());
  const find = (name: string) => headers.indexOf(name.toLowerCase());

  const timestampIdx = find("Timestamp") !== -1 ? find("Timestamp") : find("Date");
  if (timestampIdx === -1) throw new Error("el CSV necesita una columna 'Timestamp' o 'Date'");
  const contentsIdx = find("Contents") !== -1 ? find("Contents") : find("Content");
  if (contentsIdx === -1) throw new Error("el CSV necesita una columna 'Contents' o 'Content'");

  const sourceId = await importCommon.createSource("discord", fileName);
  const conversationId = await importCommon.getOrCreateConversation(
    sourceId,
    "discord",
    fileName,
    importCommon.fingerprintFileName(fileName),
  );
  const isDuplicate = await importCommon.createDuplicateChecker(conversationId);

  let imported = 0;
  let duplicates = 0;

  for (const row of rows.slice(1)) {
    const text = (row[contentsIdx] ?? "").trim();
    if (!text) continue;

    const timestamp = importCommon.normalizeTimestamp(row[timestampIdx] ?? "");

    const inserted = await importCommon.insertMessageIfNew(
      conversationId,
      sourceId,
      null,
      true,
      text,
      timestamp,
      isDuplicate,
    );

    if (inserted) imported += 1;
    else duplicates += 1;
  }

  return { source_id: sourceId, imported, duplicates, participants: [] };
}
