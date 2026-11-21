import { dbRunBatch } from "./db";

/** Real deletion (not just hidden in the UI): clears references in `memories`
 * before deleting the messages so nothing is left orphaned, following the
 * order required by PLAN_TECNICO.md. Runs atomically in a single transaction. */
export async function deleteBySource(sourceId: string): Promise<number> {
  const counts = await dbRunBatch([
    {
      sql: `UPDATE memories SET source_message_id = NULL
            WHERE source_message_id IN (SELECT id FROM messages WHERE source_id = ?)`,
      params: [sourceId],
    },
    {
      sql: "DELETE FROM embeddings WHERE message_id IN (SELECT id FROM messages WHERE source_id = ?)",
      params: [sourceId],
    },
    {
      sql: "DELETE FROM feedback WHERE message_id IN (SELECT id FROM messages WHERE source_id = ?)",
      params: [sourceId],
    },
    {
      sql: "DELETE FROM messages WHERE source_id = ?",
      params: [sourceId],
    },
    // Re-home shared conversations (reused across re-imports) to a remaining
    // source before deleting this source so foreign keys stay valid.
    {
      sql: `UPDATE conversations
            SET source_id = (
              SELECT m.source_id FROM messages m
              WHERE m.conversation_id = conversations.id
              LIMIT 1
            )
            WHERE source_id = ?
              AND id IN (SELECT DISTINCT conversation_id FROM messages)`,
      params: [sourceId],
    },
    {
      sql: `DELETE FROM conversation_participants WHERE conversation_id IN (
              SELECT id FROM conversations WHERE source_id = ?
              AND id NOT IN (SELECT DISTINCT conversation_id FROM messages)
            )`,
      params: [sourceId],
    },
    {
      sql: `DELETE FROM conversations WHERE source_id = ?
            AND id NOT IN (SELECT DISTINCT conversation_id FROM messages)`,
      params: [sourceId],
    },
    {
      sql: "DELETE FROM sources WHERE id = ?",
      params: [sourceId],
    },
  ]);

  return counts[3];
}

export async function deleteByContact(personId: string): Promise<number> {
  const counts = await dbRunBatch([
    {
      sql: `UPDATE memories SET source_message_id = NULL
            WHERE source_message_id IN (SELECT id FROM messages WHERE person_id = ?)`,
      params: [personId],
    },
    {
      sql: "DELETE FROM embeddings WHERE message_id IN (SELECT id FROM messages WHERE person_id = ?)",
      params: [personId],
    },
    {
      sql: "DELETE FROM feedback WHERE message_id IN (SELECT id FROM messages WHERE person_id = ?)",
      params: [personId],
    },
    {
      sql: "DELETE FROM messages WHERE person_id = ?",
      params: [personId],
    },
    {
      sql: "DELETE FROM conversation_participants WHERE person_id = ?",
      params: [personId],
    },
    // Copilot drafts addressed to this contact keep their text and
    // `contact_name` as a historical record; only the reference is released
    // so deleting the person doesn't violate the foreign key.
    {
      sql: "UPDATE drafts SET contact_person_id = NULL WHERE contact_person_id = ?",
      params: [personId],
    },
    {
      sql: "DELETE FROM people WHERE id = ?",
      params: [personId],
    },
  ]);

  return counts[3];
}

/** `from`/`to` are ISO8601 UTC timestamps (same format as `messages.timestamp`). */
export async function deleteByDateRange(from: string, to: string): Promise<number> {
  if (from > to) {
    throw new Error("la fecha 'desde' no puede ser posterior a 'hasta'");
  }
  const counts = await dbRunBatch([
    {
      sql: `UPDATE memories SET source_message_id = NULL
            WHERE source_message_id IN (SELECT id FROM messages WHERE timestamp BETWEEN ? AND ?)`,
      params: [from, to],
    },
    {
      sql: "DELETE FROM embeddings WHERE message_id IN (SELECT id FROM messages WHERE timestamp BETWEEN ? AND ?)",
      params: [from, to],
    },
    {
      sql: "DELETE FROM feedback WHERE message_id IN (SELECT id FROM messages WHERE timestamp BETWEEN ? AND ?)",
      params: [from, to],
    },
    {
      sql: "DELETE FROM messages WHERE timestamp BETWEEN ? AND ?",
      params: [from, to],
    },
  ]);

  return counts[3];
}
