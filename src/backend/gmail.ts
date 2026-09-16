import * as importCommon from "./importCommon";
import type { ImportSummary } from "./importCommon";

type Header = [string, string];

/** Messages in a .mbox start with a "From " line at the start of the line.
 * The mbox format itself requires that any "From " that genuinely appears in
 * a message body be escaped as ">From " when written, so splitting on those
 * lines is safe. Any subsequent "From " line is always preceded by a "\n"
 * (the first line of the file has none), so scanning for "\nFrom " finds
 * every message boundary without having to walk the string char by char. */
export function splitMboxMessages(content: string): string[] {
  const boundaries: number[] = [0];
  let searchFrom = 0;
  for (;;) {
    const idx = content.indexOf("\nFrom ", searchFrom);
    if (idx === -1) break;
    boundaries.push(idx + 1);
    searchFrom = idx + 1;
  }
  boundaries.push(content.length);

  const blocks: string[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const block = content.slice(boundaries[i], boundaries[i + 1]);
    if (block.trim() !== "") blocks.push(block);
  }
  return blocks;
}

function splitHeadersBody(raw: string): [string, string] {
  let pos = raw.indexOf("\r\n\r\n");
  if (pos !== -1) return [raw.slice(0, pos), raw.slice(pos + 4)];
  pos = raw.indexOf("\n\n");
  if (pos !== -1) return [raw.slice(0, pos), raw.slice(pos + 2)];
  return [raw, ""];
}

/** Parses RFC822 headers respecting "folding" (continuation lines that
 * start with a space or tab belong to the previous header). */
function parseHeaders(rawHeaders: string): Header[] {
  const headers: Header[] = [];
  for (const rawLine of rawHeaders.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if ((line.startsWith(" ") || line.startsWith("\t")) && headers.length > 0) {
      headers[headers.length - 1][1] += ` ${line.trim()}`;
    } else {
      const colonIdx = line.indexOf(":");
      if (colonIdx !== -1) {
        headers.push([line.slice(0, colonIdx).trim().toLowerCase(), line.slice(colonIdx + 1).trim()]);
      }
    }
  }
  return headers;
}

function getHeader(headers: Header[], name: string): string | undefined {
  return headers.find(([k]) => k === name)?.[1];
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeQEncoding(text: string): Uint8Array {
  const chars = Array.from(text);
  const out: number[] = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === "_") {
      out.push(0x20);
      i += 1;
      continue;
    }
    if (c === "=") {
      const hex = chars.slice(i + 1, i + 3).join("");
      const byte = parseInt(hex, 16);
      if (!Number.isNaN(byte)) out.push(byte);
      i += 3;
      continue;
    }
    out.push(...new TextEncoder().encode(c));
    i += 1;
  }
  return new Uint8Array(out);
}

/** Decodes MIME header "encoded-words": `=?charset?Q|B?text?=`.
 * The charset is ignored beyond UTF-8 (a reasonable fallback for the MVP). */
function decodeEncodedWords(input: string): string {
  let result = "";
  let rest = input;

  for (;;) {
    const start = rest.indexOf("=?");
    if (start === -1) break;
    result += rest.slice(0, start);
    const after = rest.slice(start + 2);

    const parsed = ((): { decoded: string; consumed: number } | null => {
      const q1 = after.indexOf("?");
      if (q1 === -1) return null;
      const encoding = after.slice(q1 + 1);
      const q2 = encoding.indexOf("?");
      if (q2 === -1) return null;
      const encChar = encoding.slice(0, q2).toUpperCase();
      const afterEnc = encoding.slice(q2 + 1);
      const end = afterEnc.indexOf("?=");
      if (end === -1) return null;
      const encodedText = afterEnc.slice(0, end);

      let bytes: Uint8Array;
      try {
        if (encChar === "B") bytes = base64ToBytes(encodedText);
        else if (encChar === "Q") bytes = decodeQEncoding(encodedText);
        else bytes = new TextEncoder().encode(encodedText);
      } catch {
        bytes = new TextEncoder().encode(encodedText);
      }

      const consumed = q1 + 1 + q2 + 1 + end + 2;
      return { decoded: new TextDecoder("utf-8", { fatal: false }).decode(bytes), consumed };
    })();

    if (parsed) {
      result += parsed.decoded;
      rest = after.slice(parsed.consumed);
    } else {
      result += "=?";
      rest = after;
    }
  }

  result += rest;
  return result;
}

function decodeQuotedPrintable(body: string): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "=") {
      if (body[i + 1] === "\r" && body[i + 2] === "\n") {
        i += 3;
        continue;
      }
      if (body[i + 1] === "\n") {
        i += 2;
        continue;
      }
      const hex = body.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 3;
        continue;
      }
      // Robust mode: invalid escape, emit '=' literally instead of failing.
      out.push(0x3d);
      i += 1;
      continue;
    }
    out.push(c.charCodeAt(0));
    i += 1;
  }
  return new Uint8Array(out);
}

function decodeBody(body: string, transferEncoding: string): string {
  const enc = transferEncoding.toLowerCase().trim();
  if (enc === "quoted-printable") {
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(decodeQuotedPrintable(body));
    } catch {
      return body;
    }
  }
  if (enc === "base64") {
    const cleaned = body.replace(/\s+/g, "");
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(base64ToBytes(cleaned));
    } catch {
      return body;
    }
  }
  return body;
}

function stripHtmlTags(html: string): string {
  let out = "";
  let inTag = false;
  for (const c of html) {
    if (c === "<") {
      inTag = true;
    } else if (c === ">") {
      inTag = false;
    } else if (!inTag) {
      out += c;
    }
  }
  return out
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function getBoundary(contentType: string): string | undefined {
  const idx = contentType.toLowerCase().indexOf("boundary=");
  if (idx === -1) return undefined;
  const rest = contentType.slice(idx + "boundary=".length).replace(/^\s+/, "");
  if (rest.startsWith('"')) {
    const stripped = rest.slice(1);
    const end = stripped.indexOf('"');
    if (end === -1) return undefined;
    return stripped.slice(0, end);
  }
  const match = rest.match(/[;\s]/);
  const end = match ? (match.index ?? rest.length) : rest.length;
  return rest.slice(0, end).trim();
}

/** Extracts the plain text from a MIME message, preferring text/plain over
 * text/html, recursing down through multipart/* (e.g. multipart/mixed
 * containing a multipart/alternative inside). */
function extractPlainText(contentType: string, transferEncoding: string, body: string): string | undefined {
  const ctLower = contentType.toLowerCase();

  if (ctLower.startsWith("multipart/")) {
    const boundary = getBoundary(contentType);
    if (!boundary) return undefined;
    const delimiter = `--${boundary}`;

    let plain: string | undefined;
    let html: string | undefined;

    for (const rawPart of body.split(delimiter)) {
      const part = rawPart.replace(/^[\r\n]+/, "");
      if (!part.trim() || part.trimStart().startsWith("--")) continue;

      const [partHeadersRaw, partBody] = splitHeadersBody(part);
      const partHeaders = parseHeaders(partHeadersRaw);
      const partCt = getHeader(partHeaders, "content-type") ?? "text/plain";
      const partCte = getHeader(partHeaders, "content-transfer-encoding") ?? "7bit";

      if (partCt.toLowerCase().startsWith("multipart/")) {
        if (plain === undefined) {
          const nested = extractPlainText(partCt, partCte, partBody);
          if (nested !== undefined) plain = nested;
        }
        continue;
      }

      const decoded = decodeBody(partBody, partCte);
      if (partCt.toLowerCase().startsWith("text/plain") && plain === undefined) {
        plain = decoded;
      } else if (partCt.toLowerCase().startsWith("text/html") && html === undefined) {
        html = decoded;
      }
    }

    if (plain !== undefined) return plain;
    if (html !== undefined) return stripHtmlTags(html);
    return undefined;
  }

  const decoded = decodeBody(body, transferEncoding);
  return ctLower.startsWith("text/html") ? stripHtmlTags(decoded) : decoded;
}

export function parseFromHeader(raw: string): string {
  const decoded = decodeEncodedWords(raw);
  const lt = decoded.indexOf("<");
  if (lt !== -1) {
    const gt = decoded.indexOf(">");
    if (gt !== -1) {
      const name = decoded.slice(0, lt).trim().replace(/^"+|"+$/g, "");
      const email = decoded.slice(lt + 1, gt).trim();
      return name === "" ? email : name;
    }
  }
  return decoded.trim();
}

export function parseGmailDate(raw: string): string | undefined {
  const idx = raw.indexOf("(");
  const cleaned = (idx !== -1 ? raw.slice(0, idx) : raw).trim();
  const parsed = new Date(cleaned);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export async function importGmailFile(fileName: string, bytes: Uint8Array): Promise<ImportSummary> {
  const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

  const blocks = splitMboxMessages(content);
  if (blocks.length === 0) {
    throw new Error("no se encontraron mensajes en el archivo .mbox");
  }

  const sourceId = await importCommon.createSource("gmail", fileName);
  const conversationId = await importCommon.getOrCreateConversation(
    sourceId,
    "gmail",
    fileName,
    importCommon.fingerprintFileName(fileName),
  );
  const isDuplicate = await importCommon.createDuplicateChecker(conversationId);

  let imported = 0;
  let duplicates = 0;
  const participants: string[] = [];
  // Caches resolved person ids by display name so a mailbox with many
  // messages from the same few senders doesn't issue a person-lookup round
  // trip per message — only once per distinct sender.
  const personIdCache = new Map<string, string>();

  for (const block of blocks) {
    const newlineIdx = block.indexOf("\n");
    if (newlineIdx === -1) continue;
    const afterFromLine = block.slice(newlineIdx + 1);
    const [headersRaw, body] = splitHeadersBody(afterFromLine);
    const headers = parseHeaders(headersRaw);

    const contentType = getHeader(headers, "content-type") ?? "text/plain";
    const transferEncoding = getHeader(headers, "content-transfer-encoding") ?? "7bit";

    const text = extractPlainText(contentType, transferEncoding, body);
    if (text === undefined || !text.trim()) continue;
    const trimmedText = text.trim();

    const dateHeader = getHeader(headers, "date");
    const timestamp = (dateHeader && parseGmailDate(dateHeader)) || new Date().toISOString();

    const labels = getHeader(headers, "x-gmail-labels") ?? "";
    const isUser = labels
      .toLowerCase()
      .split(",")
      .some((l) => l.trim() === "sent");

    let personId: string | null = null;
    if (!isUser) {
      const fromRaw = getHeader(headers, "from") ?? "Desconocido";
      const display = parseFromHeader(fromRaw);
      if (!participants.includes(display)) participants.push(display);
      const cached = personIdCache.get(display);
      if (cached) {
        personId = cached;
      } else {
        personId = await importCommon.getOrCreatePerson(display);
        await importCommon.ensureParticipant(conversationId, personId);
        personIdCache.set(display, personId);
      }
    }

    const inserted = await importCommon.insertMessageIfNew(
      conversationId,
      sourceId,
      personId,
      isUser,
      trimmedText,
      timestamp,
      isDuplicate,
    );

    if (inserted) imported += 1;
    else duplicates += 1;
  }

  return { source_id: sourceId, imported, duplicates, participants };
}
