import { dbRun } from "./db";

/** Real deletion (not just hidden in the UI): clears references in `memories`
 * before deleting the messages so nothing is left orphaned, following the
 * order required by PLAN_TECNICO.md. */
export async function deleteBySource(sourceId: string): Promise<number> {
  await dbRun(
    `UPDATE memories SET source_message_id = NULL
     WHERE source_message_id IN (SELECT id FROM messages WHERE source_id = ?)`,
    [sourceId],
  );
  await dbRun("DELETE FROM embeddings WHERE message_id IN (SELECT id FROM messages WHERE source_id = ?)", [sourceId]);
  await dbRun("DELETE FROM feedback WHERE message_id IN (SELECT id FROM messages WHERE source_id = ?)", [sourceId]);

  const deleted = await dbRun("DELETE FROM messages WHERE source_id = ?", [sourceId]);

  // Conversations left without any message (orphaned from this source) are
  // also deleted, but their participants must be released first or the
  // DELETE on conversations violates the foreign key.
  await dbRun(
    `DELETE FROM conversation_participants WHERE conversation_id IN (
        SELECT id FROM conversations WHERE source_id = ?
        AND id NOT IN (SELECT DISTINCT conversation_id FROM messages)
    )`,
    [sourceId],
  );
  await dbRun(
    `DELETE FROM conversations WHERE source_id = ?
     AND id NOT IN (SELECT DISTINCT conversation_id FROM messages)`,
    [sourceId],
  );
  await dbRun("DELETE FROM sources WHERE id = ?", [sourceId]);

  return deleted;
}

export async function deleteByContact(personId: string): Promise<number> {
  await dbRun(
    `UPDATE memories SET source_message_id = NULL
     WHERE source_message_id IN (SELECT id FROM messages WHERE person_id = ?)`,
    [personId],
  );
  await dbRun("DELETE FROM embeddings WHERE message_id IN (SELECT id FROM messages WHERE person_id = ?)", [personId]);
  await dbRun("DELETE FROM feedback WHERE message_id IN (SELECT id FROM messages WHERE person_id = ?)", [personId]);

  const deleted = await dbRun("DELETE FROM messages WHERE person_id = ?", [personId]);

  await dbRun("DELETE FROM conversation_participants WHERE person_id = ?", [personId]);
  // Copilot drafts addressed to this contact keep their text and
  // `contact_name` as a historical record; only the reference is released
  // so deleting the person doesn't violate the foreign key.
  await dbRun("UPDATE drafts SET contact_person_id = NULL WHERE contact_person_id = ?", [personId]);
  await dbRun("DELETE FROM people WHERE id = ?", [personId]);

  return deleted;
}

/** `from`/`to` are ISO8601 timestamps (same format as `messages.timestamp`). */
export async function deleteByDateRange(from: string, to: string): Promise<number> {
  await dbRun(
    `UPDATE memories SET source_message_id = NULL
     WHERE source_message_id IN (SELECT id FROM messages WHERE timestamp BETWEEN ? AND ?)`,
    [from, to],
  );
  await dbRun(
    "DELETE FROM embeddings WHERE message_id IN (SELECT id FROM messages WHERE timestamp BETWEEN ? AND ?)",
    [from, to],
  );
  await dbRun("DELETE FROM feedback WHERE message_id IN (SELECT id FROM messages WHERE timestamp BETWEEN ? AND ?)", [
    from,
    to,
  ]);

  return dbRun("DELETE FROM messages WHERE timestamp BETWEEN ? AND ?", [from, to]);
}
