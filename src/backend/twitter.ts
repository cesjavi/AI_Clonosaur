import * as importCommon from "./importCommon";
import type { ImportSummary } from "./importCommon";

interface TweetData {
  created_at: string;
  full_text: string;
}

/** `data/tweet.js` isn't pure JSON: it's a JS variable assignment
 * ("window.YTD.tweet.part0 = [ ... ]"). Everything before the first '['
 * is trimmed to keep only the array, without needing a JS parser. */
export function parseTwitterArchive(content: string): TweetData[] {
  const jsonStart = content.indexOf("[");
  if (jsonStart === -1) throw new Error("no se encontró el array de tweets en el archivo");
  let wrappers: unknown[];
  try {
    wrappers = JSON.parse(content.slice(jsonStart));
  } catch (e) {
    throw new Error(`JSON de tweets inválido: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  // Entries with an unexpected shape (missing/malformed "tweet" key) are
  // skipped instead of crashing the whole import — a single corrupted or
  // unrecognized entry shouldn't lose every tweet that parsed correctly.
  return wrappers
    .map((w) => (w as { tweet?: TweetData })?.tweet)
    .filter((t): t is TweetData => typeof t?.full_text === "string");
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Twitter format: "Wed Oct 10 20:19:24 +0000 2018" */
export function parseTwitterTimestamp(createdAt: string): string | null {
  const match = createdAt.match(/^\w+ (\w+) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/);
  if (!match) return null;
  const [, monName, day, h, mi, s, offset, year] = match;
  const month = MONTHS[monName];
  if (month === undefined) return null;
  const offsetSign = offset[0] === "-" ? 1 : -1; // invert to convert *to* UTC
  const offsetHours = parseInt(offset.slice(1, 3), 10);
  const offsetMinutes = parseInt(offset.slice(3, 5), 10);
  const date = new Date(
    Date.UTC(Number(year), month, Number(day), Number(h), Number(mi), Number(s)),
  );
  date.setUTCMinutes(date.getUTCMinutes() + offsetSign * (offsetHours * 60 + offsetMinutes));
  return date.toISOString();
}

/** A Twitter/X archive only contains the tweets of whoever requested the
 * export — there's no username inside `tweet.js` itself — so the caller
 * supplies which account this archive belongs to. That person is
 * attributed to every tweet (not hardcoded as the clone's owner): reusing
 * the same "mark as me" flow the other importers already have lets this
 * double as a way to import a contact's own archive too, under the same
 * consent model as everything else (see PRIVACY.md). */
export async function importTwitterFile(
  fileName: string,
  bytes: Uint8Array,
  username: string,
): Promise<ImportSummary> {
  const content = new TextDecoder("utf-8").decode(bytes);
  const tweets = parseTwitterArchive(content);

  if (tweets.length === 0) {
    throw new Error("no se encontraron tweets en el archivo");
  }

  const sourceId = await importCommon.createSource("twitter", fileName);
  // Fingerprinted by username, not file name: an archive only ever contains
  // one account's tweets, so the username is a stable identity for the
  // conversation across re-downloads (which commonly get renamed with a
  // "(1)" suffix or a different export timestamp), unlike the file name.
  const conversationId = await importCommon.getOrCreateConversation(
    sourceId,
    "twitter",
    fileName,
    username.toLowerCase(),
  );
  const personId = await importCommon.getOrCreatePerson(username);
  await importCommon.ensureParticipant(conversationId, personId);
  const isDuplicate = await importCommon.createDuplicateChecker(conversationId);

  let imported = 0;
  let duplicates = 0;

  for (const tweet of tweets) {
    const text = tweet.full_text.trim();
    if (!text) continue;
    const timestamp = parseTwitterTimestamp(tweet.created_at) ?? new Date().toISOString();

    const inserted = await importCommon.insertMessageIfNew(
      conversationId,
      sourceId,
      personId,
      false,
      text,
      timestamp,
      isDuplicate,
    );

    if (inserted) imported += 1;
    else duplicates += 1;
  }

  return { source_id: sourceId, imported, duplicates, participants: [username] };
}
