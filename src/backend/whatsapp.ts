import { unzipSync } from "fflate";
import * as importCommon from "./importCommon";
import type { ImportSummary } from "./importCommon";

interface ParsedMessage {
  author: string;
  text: string;
  timestamp: string;
}

/** Android header: "12/1/23, 10:15 - rest". iOS header: "[12/1/23, 10:15:00 AM] rest".
 * iOS is tried first because its delimiter ('[' ... ']') is unambiguous. */
function splitIosHeader(line: string): [string, string] | null {
  if (!line.startsWith("[")) return null;
  const end = line.indexOf("]");
  if (end === -1) return null;
  const header = line.slice(1, end);
  if (!header.includes(",")) return null;
  return [header, line.slice(end + 1).trimStart()];
}

function splitAndroidHeader(line: string): [string, string] | null {
  const idx = line.indexOf(" - ");
  if (idx === -1) return null;
  const header = line.slice(0, idx);
  if (!header.includes(",")) return null;
  return [header, line.slice(idx + 3)];
}

/** The day/month order is ambiguous in WhatsApp exports (it depends on the
 * region of the phone that generated the backup); dd/mm is assumed, the
 * most common format outside the United States. */
export function parseWhatsappTimestamp(dateStr: string, timeStr: string): string | null {
  const dateBits = dateStr.trim().split(/[/.]/);
  if (dateBits.length !== 3) return null;
  let day = parseInt(dateBits[0], 10);
  let month = parseInt(dateBits[1], 10);
  let year = parseInt(dateBits[2], 10);
  if ([day, month, year].some(Number.isNaN)) return null;
  if (year < 100) year += 2000;

  // dd/mm is assumed above, but that's invalid for a US-locale export
  // (mm/dd/yyyy) whenever the first field is > 12 — the classic case
  // (day <= 12) is silently ambiguous either way and can't be recovered,
  // but this at least catches and fixes the unambiguous case instead of
  // rolling over into a wrong-but-valid date via Date.UTC's normalization.
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    if (day >= 1 && day <= 12 && month >= 1 && month <= 31) {
      [day, month] = [month, day];
    } else {
      return null;
    }
  }

  let timeMain = timeStr.trim();
  let meridiem: boolean | null = null;
  if (/am$/i.test(timeMain) || /a\.\s*m\.$/i.test(timeMain)) {
    timeMain = timeMain.replace(/am$/i, "").replace(/a\.\s*m\.$/i, "").trim();
    meridiem = false;
  } else if (/pm$/i.test(timeMain) || /p\.\s*m\.$/i.test(timeMain)) {
    timeMain = timeMain.replace(/pm$/i, "").replace(/p\.\s*m\.$/i, "").trim();
    meridiem = true;
  }

  const timeBits = timeMain.split(":");
  if (timeBits.length < 2) return null;
  let hour = parseInt(timeBits[0], 10);
  const minute = parseInt(timeBits[1], 10);
  const second = timeBits.length > 2 ? parseInt(timeBits[2], 10) : 0;
  if ([hour, minute].some(Number.isNaN)) return null;

  if (meridiem !== null) {
    if (meridiem && hour !== 12) hour += 12;
    if (!meridiem && hour === 12) hour = 0;
  }

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseHeaderDatetime(header: string): string | null {
  const idx = header.indexOf(", ");
  if (idx === -1) return null;
  return parseWhatsappTimestamp(header.slice(0, idx), header.slice(idx + 2));
}

/** Parses the full text of a WhatsApp export. System messages (someone
 * joined, changed the icon, etc.) don't have "Name: text" and are
 * discarded; multi-line messages are appended to the last real message. */
export function parseWhatsappText(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;

    const headerAndRest = splitIosHeader(line) ?? splitAndroidHeader(line);

    if (headerAndRest) {
      const [header, rest] = headerAndRest;
      const timestamp = parseHeaderDatetime(header);
      if (timestamp) {
        const sepIdx = rest.indexOf(": ");
        if (sepIdx !== -1) {
          messages.push({
            author: rest.slice(0, sepIdx).trim(),
            text: rest.slice(sepIdx + 2).trim(),
            timestamp,
          });
        }
        continue;
      }
    }

    const last = messages[messages.length - 1];
    if (last) {
      last.text += "\n" + line.trim();
    }
  }

  return messages;
}

function readWhatsappContent(fileName: string, bytes: Uint8Array): string {
  if (fileName.toLowerCase().endsWith(".zip")) {
    const entries = unzipSync(bytes);
    for (const [name, data] of Object.entries(entries)) {
      if (name.toLowerCase().endsWith(".txt")) {
        return new TextDecoder("utf-8").decode(data);
      }
    }
    throw new Error("el .zip no contiene ningún archivo .txt");
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export async function importWhatsappFile(fileName: string, bytes: Uint8Array): Promise<ImportSummary> {
  const content = readWhatsappContent(fileName, bytes);
  const parsed = parseWhatsappText(content);

  if (parsed.length === 0) {
    throw new Error("no se reconoció ningún mensaje en el archivo (formato de WhatsApp no soportado)");
  }

  // Stable fingerprint of the chat (independent of the file name, which can
  // vary between exports of the same chat): the sorted set of authors. This
  // way a re-import of the same chat lands in the same conversation and
  // duplicate detection can do its job.
  const participants: string[] = [];
  for (const msg of parsed) {
    if (!participants.includes(msg.author)) participants.push(msg.author);
  }
  const externalId = [...participants].sort().join("|").toLowerCase();

  const sourceId = await importCommon.createSource("whatsapp", fileName);
  const conversationId = await importCommon.getOrCreateConversation(sourceId, "whatsapp", fileName, externalId);
  const isDuplicate = await importCommon.createDuplicateChecker(conversationId);

  // Resolve each unique author once instead of once per message — a 10k
  // message chat between 2 people otherwise issues ~10k serialized
  // person-lookup round trips through the worker queue for only 2 distinct
  // names.
  const personIds = new Map<string, string>();
  for (const name of participants) {
    const personId = await importCommon.getOrCreatePerson(name);
    await importCommon.ensureParticipant(conversationId, personId);
    personIds.set(name, personId);
  }

  let imported = 0;
  let duplicates = 0;

  for (const msg of parsed) {
    const personId = personIds.get(msg.author)!;

    const inserted = await importCommon.insertMessageIfNew(
      conversationId,
      sourceId,
      personId,
      false,
      msg.text,
      msg.timestamp,
      isDuplicate,
    );

    if (inserted) imported += 1;
    else duplicates += 1;
  }

  return { source_id: sourceId, imported, duplicates, participants };
}
