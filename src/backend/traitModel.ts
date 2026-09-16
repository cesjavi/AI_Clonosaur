import { dbQuery, dbRun } from "./db";

/** Saves a finding in `profile_traits`, avoiding duplication by name if one
 * already exists with the same category + trait (it isn't overwritten: the
 * user may have edited it by hand). Shared by decisionModel and valuesModel,
 * which infer different categories from the same underlying pattern. */
export async function insertTraitIfNew(
  category: string,
  traitName: string,
  value: string,
  evidence: string,
  now: string,
): Promise<boolean> {
  const existing = await dbQuery("SELECT id FROM profile_traits WHERE category = ? AND trait = ?", [
    category,
    traitName,
  ]);
  if (existing.length > 0) return false;

  await dbRun(
    `INSERT INTO profile_traits (id, category, trait, value, source, evidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'inferred', ?, ?, ?)`,
    [crypto.randomUUID(), category, traitName, value, evidence, now, now],
  );
  return true;
}

/** Gathers the context used to infer profile traits: interview answers from
 * the given module(s), already-confirmed memories (excluding ones sourced
 * from a message flagged sensitive), and a sample of the user's own messages
 * (excluding sensitive ones). Sensitive messages are kept out of every
 * evidence block that can end up quoted in `profile_traits.evidence` or
 * `memories.content` — both of which flow into the RAG context that hybrid
 * mode can send to an external LLM provider. Shared by decisionModel and
 * valuesModel, which only differ in which interview module(s) they read. */
export async function gatherModuleEvidence(modules: string[], moduleLabel: string): Promise<string> {
  const blocks: string[] = [];

  const placeholders = modules.map(() => "?").join(", ");
  const answers = await dbQuery(
    `SELECT question_text, answer FROM interview_answers
     WHERE module IN (${placeholders}) AND answer != ''`,
    modules,
  );
  if (answers.length > 0) {
    blocks.push(`Entrevista (${moduleLabel}):`);
    for (const row of answers) {
      blocks.push(`P: ${row.question_text}\nR: ${row.answer}`);
    }
  }

  const mems = await dbQuery(
    `SELECT content FROM memories mem
     WHERE status IN ('confirmed','edited')
     AND NOT EXISTS (
       SELECT 1 FROM messages ms WHERE ms.id = mem.source_message_id AND ms.sensitivity = 'sensible'
     )
     LIMIT 40`,
  );
  if (mems.length > 0) {
    blocks.push("\nMemorias confirmadas:");
    for (const row of mems) {
      blocks.push(`- ${row.content}`);
    }
  }

  const msgs = await dbQuery(
    "SELECT text FROM messages WHERE is_user = 1 AND sensitivity IS NOT 'sensible' ORDER BY RANDOM() LIMIT 20",
  );
  if (msgs.length > 0) {
    blocks.push("\nMensajes propios (muestra):");
    for (const row of msgs) {
      blocks.push(`- ${row.text}`);
    }
  }

  return blocks.join("\n");
}
