import { dbRun } from "./db";

/** Fixes a message's author attribution ("this is me" / "this is not
 * me") and leaves an auditable record of the change in `feedback`. */
export async function recordFeedback(messageId: string, isUser: boolean): Promise<void> {
  const updated = await dbRun("UPDATE messages SET is_user = ? WHERE id = ?", [isUser ? 1 : 0, messageId]);
  if (updated === 0) {
    throw new Error(`no existe un mensaje con id ${messageId}`);
  }
  await dbRun("INSERT INTO feedback (id, message_id, is_user, created_at) VALUES (?, ?, ?, ?)", [
    crypto.randomUUID(),
    messageId,
    isUser ? 1 : 0,
    new Date().toISOString(),
  ]);
}
