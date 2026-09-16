import { dbQuery, dbRun } from "./db";

/** Called when mounting "Chat" or "Hybrid Chat"; closed on unmount. Doesn't
 * affect the context the model receives — it's purely so we can measure
 * later (sessions, turns) in a future Metrics screen. */
export async function createSession(mode: string): Promise<string> {
  const id = crypto.randomUUID();
  await dbRun("INSERT INTO agent_sessions (id, mode, started_at, ended_at) VALUES (?, ?, ?, NULL)", [
    id,
    mode,
    new Date().toISOString(),
  ]);
  return id;
}

export async function closeSession(sessionId: string): Promise<void> {
  await dbRun("UPDATE agent_sessions SET ended_at = ? WHERE id = ?", [new Date().toISOString(), sessionId]);
}

/** Records a turn (user or assistant) within a session. Reused
 * by the chat/send modes to avoid duplicating the INSERT. */
export async function recordTurn(sessionId: string, role: string, content: string): Promise<void> {
  await dbRun("INSERT INTO chat_turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)", [
    crypto.randomUUID(),
    sessionId,
    role,
    content,
    new Date().toISOString(),
  ]);
}

export interface ChatTurn {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

/** Loads the last 200 turns (from any session) when mounting "Chat".
 * Known limitation: it doesn't persist which "Sources used" each
 * historical RAG-mode response had, only the text. */
export async function listChatTurns(): Promise<ChatTurn[]> {
  const rows = await dbQuery("SELECT id, role, content, created_at FROM chat_turns ORDER BY created_at DESC LIMIT 200");
  const turns = rows.map((r) => ({
    id: r.id as string,
    role: r.role as string,
    content: r.content as string,
    created_at: r.created_at as string,
  }));
  turns.reverse();
  return turns;
}
