import * as importCommon from "./importCommon";
import type { ImportSummary } from "./importCommon";

/** Reddit exports `comments.csv` and `posts.csv` with different schemas;
 * which one it is gets detected by the presence of the 'title' column
 * (only in posts). Same as Twitter/Discord, the content is assumed to be
 * the user's own. */
export async function importRedditFile(fileName: string, bytes: Uint8Array): Promise<ImportSummary> {
  const content = new TextDecoder("utf-8").decode(bytes);
  const rows = importCommon.parseCsv(content);
  if (rows.length === 0) {
    throw new Error("el CSV necesita una columna 'date'");
  }

  const headers = rows[0].map((h) => h.toLowerCase());
  const find = (name: string) => headers.indexOf(name.toLowerCase());

  const dateIdx = find("date");
  if (dateIdx === -1) throw new Error("el CSV necesita una columna 'date'");
  const bodyIdx = find("body");
  const titleIdx = find("title");

  if (bodyIdx === -1 && titleIdx === -1) {
    throw new Error(
      "el CSV no tiene columnas 'title' ni 'body' reconocibles (comments.csv o posts.csv de Reddit)",
    );
  }

  const sourceId = await importCommon.createSource("reddit", fileName);
  const conversationId = await importCommon.getOrCreateConversation(
    sourceId,
    "reddit",
    fileName,
    importCommon.fingerprintFileName(fileName),
  );
  const isDuplicate = await importCommon.createDuplicateChecker(conversationId);

  let imported = 0;
  let duplicates = 0;

  for (const row of rows.slice(1)) {
    const title = titleIdx !== -1 ? (row[titleIdx] ?? "").trim() : "";
    const body = bodyIdx !== -1 ? (row[bodyIdx] ?? "").trim() : "";

    let text: string;
    if (title && body) text = `${title}\n\n${body}`;
    else if (title) text = title;
    else if (body) text = body;
    else continue;

    const timestamp = importCommon.normalizeTimestamp(row[dateIdx] ?? "");

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
