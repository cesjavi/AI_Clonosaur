import { dbQuery, dbRun } from "./db";
import * as llm from "./llm";

/** Groups own messages by conversation and asks the LLM to describe the
 * tone of each one separately (not a general tone), saving each
 * result as `profile_traits` (`category = 'tono_contextual'`). */
export async function generateTone(): Promise<number> {
  const convRows = await dbQuery(
    `SELECT c.id, c.title FROM conversations c
     WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.is_user = 1)`,
  );

  const conversations: [string, string[]][] = [];
  for (const row of convRows) {
    const convId = row.id as string;
    const title = (row.title as string | null) ?? "";
    const msgRows = await dbQuery(
      "SELECT text FROM messages WHERE conversation_id = ? AND is_user = 1 AND sensitivity IS NOT 'sensible' ORDER BY timestamp LIMIT 20",
      [convId],
    );
    const msgs = msgRows.map((r) => r.text as string);
    if (msgs.length >= 3) {
      const label = title.trim() ? title : `Conversación ${convId.slice(0, 8)}`;
      conversations.push([label, msgs]);
    }
  }

  if (conversations.length === 0) {
    throw new Error("no hay conversaciones con suficientes mensajes propios todavía para describir el tono");
  }

  const now = new Date().toISOString();
  let created = 0;

  for (const [label, msgs] of conversations) {
    const existing = await dbQuery("SELECT id FROM profile_traits WHERE category = 'tono_contextual' AND trait = ?", [
      label,
    ]);
    if (existing.length > 0) continue;

    const sample = msgs.map((m) => `- ${m}`).join("\n");
    const prompt = `Estos son mensajes propios de una persona en una sola conversación ('${label}'). Describí en una o dos frases el tono que usa en este contexto específico (ej. formal, cariñoso, directo, en broma, distante). Basate solo en lo que ves acá, no generalices a otros contextos. Respondé solo texto plano, sin JSON ni comillas.

Mensajes:
${sample}`;

    const rawTone = await llm.chatCompletion(prompt);
    const tone = rawTone.trim().replace(/^"+|"+$/g, "");
    if (!tone) continue;

    await dbRun(
      `INSERT INTO profile_traits (id, category, trait, value, source, created_at, updated_at)
       VALUES (?, 'tono_contextual', ?, ?, 'inferred', ?, ?)`,
      [crypto.randomUUID(), label, tone, now, now],
    );

    created += 1;
  }

  return created;
}
