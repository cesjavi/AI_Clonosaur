import { dbQuery, dbRun } from "./db";
import * as chat from "./chat";
import * as llm from "./llm";

export interface Draft {
  id: string;
  contact_name: string | null;
  content: string;
  status: string;
  created_at: string;
}

async function isExcluded(personId: string): Promise<boolean> {
  const rows = await dbQuery("SELECT excluded FROM people WHERE id = ?", [personId]);
  return rows.length > 0 ? Boolean(rows[0].excluded) : false;
}

/** Generates a "written as me" draft using the same context assembly as the
 * RAG chat. Never sends anything through any channel: the result stays in
 * `drafts` with `status = 'pending'` until the user reviews it by hand.
 * If the recipient contact is excluded, the model isn't even called. */
export async function generateDraft(contactPersonId: string | null, instruction: string): Promise<Draft> {
  let contactName: string | null = null;
  if (contactPersonId) {
    if (await isExcluded(contactPersonId)) {
      throw new Error(
        "este contacto está marcado como excluido de la memoria del clon; no se genera ningún borrador para él",
      );
    }
    const rows = await dbQuery("SELECT name FROM people WHERE id = ?", [contactPersonId]);
    contactName = rows.length > 0 ? (rows[0].name as string) : null;
  }

  const history: chat.ChatMessage[] = [{ role: "user", content: instruction }];
  const [messages] = await chat.buildRagMessages(history);
  const content = await llm.chatCompletionMessages(messages);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await dbRun(
    `INSERT INTO drafts (id, contact_person_id, contact_name, content, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    [id, contactPersonId, contactName, content, now, now],
  );

  return { id, contact_name: contactName, content, status: "pending", created_at: now };
}

export async function listDrafts(): Promise<Draft[]> {
  const rows = await dbQuery("SELECT id, contact_name, content, status, created_at FROM drafts ORDER BY created_at DESC");
  return rows.map((r) => ({
    id: r.id as string,
    contact_name: r.contact_name as string | null,
    content: r.content as string,
    status: r.status as string,
    created_at: r.created_at as string,
  }));
}

export async function updateDraftStatus(id: string, status: string, content: string | null): Promise<void> {
  const now = new Date().toISOString();
  if (content !== null) {
    await dbRun("UPDATE drafts SET status = ?, content = ?, updated_at = ? WHERE id = ?", [status, content, now, id]);
  } else {
    await dbRun("UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?", [status, now, id]);
  }
}
