import { dbQuery, dbRun } from "./db";
import * as llm from "./llm";

export interface MemoryItem {
  id: string;
  layer: string;
  status: string;
  content: string;
  evidence: string | null;
  created_at: string;
}

function rowToMemory(row: Record<string, unknown>): MemoryItem {
  let evidence: string | null = null;
  const metadata = row.metadata as string | null;
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata);
      if (typeof parsed?.evidence === "string") evidence = parsed.evidence;
    } catch {
      // metadata not valid JSON: leave evidence as null, same as Rust's .ok()
    }
  }
  return {
    id: row.id as string,
    layer: row.layer as string,
    status: row.status as string,
    content: row.content as string,
    evidence,
    created_at: row.created_at as string,
  };
}

export async function listMemories(status?: string | null): Promise<MemoryItem[]> {
  const rows = await dbQuery(
    "SELECT id, layer, status, content, metadata, created_at FROM memories WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC",
    [status ?? null, status ?? null],
  );
  return rows.map(rowToMemory);
}

export async function updateMemoryStatus(id: string, status: string, content?: string | null): Promise<void> {
  const now = new Date().toISOString();
  if (content !== undefined && content !== null) {
    await dbRun("UPDATE memories SET status = ?, content = ?, updated_at = ? WHERE id = ?", [status, content, now, id]);
  } else {
    await dbRun("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?", [status, now, id]);
  }
}

interface ExtractedFact {
  index?: number;
  layer: string;
  content: string;
  evidence?: unknown;
}

/** Takes a sample of the user's own messages that don't have an associated
 * memory yet, asks the local LLM to extract facts/preferences/traits citing
 * textual evidence, and saves them as `candidate` memories. Never confirms
 * anything automatically: the user reviews each one in the Memories screen. */
export async function generateCandidateMemories(): Promise<number> {
  const rows = await dbQuery(
    `SELECT m.id, m.text FROM messages m
     WHERE m.is_user = 1
     AND m.sensitivity IS NOT 'sensible'
     AND m.id NOT IN (SELECT source_message_id FROM memories WHERE source_message_id IS NOT NULL)
     ORDER BY RANDOM() LIMIT 30`,
  );
  const messages: [string, string][] = rows.map((r) => [r.id as string, r.text as string]);

  if (messages.length === 0) return 0;

  const evidenceBlock = messages.map(([, text], i) => `[${i}] ${text}`).join("\n");

  const prompt = `Analizá los siguientes mensajes de una persona (cada uno marcado con [n]) y extraé hechos, preferencias o rasgos concretos sobre ella. Para cada uno indicá: index (el número [n] del mensaje que lo respalda), layer (uno de: preferencias, autobiografica, estilo_linguistico, perfil_estable), content (el hecho, en una oración, en tercera persona), evidence (copia textual del fragmento del mensaje que lo respalda). NO inventes nada que no esté respaldado por el texto. Si un mensaje no aporta nada claro, ignoralo. Respondé ÚNICAMENTE un array JSON de objetos con esas 4 claves, sin texto adicional.

Mensajes:
${evidenceBlock}`;

  const response = await llm.chatCompletion(prompt);
  const facts = llm.parseJsonArray<ExtractedFact>(response);

  const now = new Date().toISOString();
  let created = 0;

  for (const fact of facts) {
    if (!fact.content?.trim()) continue;
    const sourceMessageId = fact.index !== undefined ? messages[fact.index]?.[0] ?? null : null;
    const evidenceText = llm.valueToText(fact.evidence);
    const metadata = JSON.stringify({ evidence: evidenceText });

    await dbRun(
      `INSERT INTO memories (id, layer, status, content, source_message_id, metadata, created_at, updated_at)
       VALUES (?, ?, 'candidate', ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), fact.layer, fact.content, sourceMessageId, metadata, now, now],
    );

    created += 1;
  }

  return created;
}
