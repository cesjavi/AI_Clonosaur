import { dbQuery, dbRun } from "./db";
import * as llm from "./llm";

interface ContradictionFinding {
  content: string;
  evidence?: unknown;
}

/** Compares ALREADY confirmed memories against each other (not candidate
 * memories) looking for real changes of opinion over time, not minor natural
 * evolution. Findings come in as candidate memories (`dinamica` layer),
 * reusing the same review flow instead of a new screen. */
export async function detectContradictions(): Promise<number> {
  const rows = await dbQuery(
    "SELECT content, created_at FROM memories WHERE status IN ('confirmed','edited') ORDER BY created_at",
  );
  const memories: [string, string][] = rows.map((r) => [r.content as string, r.created_at as string]);

  if (memories.length < 2) return 0;

  const evidenceBlock = memories.map(([content, date], i) => `[${i}] (${date}) ${content}`).join("\n");

  const prompt = `Estas son memorias confirmadas sobre una persona, ordenadas por fecha (marcadas [n]). Buscá cambios de opinión REALES a través del tiempo (no evolución natural menor ni matices): casos donde algo que dijo o creía antes contradice claramente algo posterior. Para cada contradicción real que encuentres, devolvé un objeto con: content (describí el cambio, ej. 'Cambió de opinión sobre X: antes creía Y, ahora cree Z'), evidence (citá los fragmentos [n] involucrados). Si no hay contradicciones reales, devolvé un array vacío — no inventes cambios menores. Respondé ÚNICAMENTE un array JSON de objetos con esas 2 claves.

Memorias:
${evidenceBlock}`;

  const response = await llm.chatCompletion(prompt);
  const findings = llm.parseJsonArray<ContradictionFinding>(response);

  const now = new Date().toISOString();
  let created = 0;

  for (const finding of findings) {
    if (!finding.content?.trim()) continue;
    const evidenceText = llm.valueToText(finding.evidence);
    const metadata = JSON.stringify({ evidence: evidenceText });

    await dbRun(
      `INSERT INTO memories (id, layer, status, content, source_message_id, metadata, created_at, updated_at)
       VALUES (?, 'dinamica', 'candidate', ?, NULL, ?, ?, ?)`,
      [crypto.randomUUID(), finding.content, metadata, now, now],
    );

    created += 1;
  }

  return created;
}
