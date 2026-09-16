import { dbQuery } from "./db";

export interface Metrics {
  total_messages: number;
  messages_with_embedding: number;
  sensitive_messages: number;
  memories_candidate: number;
  memories_confirmed: number;
  memories_edited: number;
  memories_rejected: number;
  feedback_count: number;
  drafts_pending: number;
  drafts_approved: number;
  drafts_edited: number;
  drafts_rejected: number;
  interview_answered: number;
  total_sessions: number;
  total_turns: number;
}

/** Everything is calculated in real time from the local database, never
 * hardcoded — see PLAN_TECNICO.md ("metrics panel... never hardcoded").
 *
 * A single query with scalar subqueries instead of 15 separate `COUNT(*)`
 * round trips: on the web build every query is a full round trip through
 * db.worker.ts's single-queue wasm SQLite instance, so `Promise.all` over 15
 * queries still runs them one after another (only the postMessage dispatch
 * overlaps, not execution) — one statement returning all 15 counts pays that
 * overhead once. */
export async function getMetrics(): Promise<Metrics> {
  const rows = await dbQuery(`SELECT
    (SELECT COUNT(*) FROM messages) AS total_messages,
    (SELECT COUNT(*) FROM embeddings) AS messages_with_embedding,
    (SELECT COUNT(*) FROM messages WHERE sensitivity = 'sensible') AS sensitive_messages,
    (SELECT COUNT(*) FROM memories WHERE status = 'candidate') AS memories_candidate,
    (SELECT COUNT(*) FROM memories WHERE status = 'confirmed') AS memories_confirmed,
    (SELECT COUNT(*) FROM memories WHERE status = 'edited') AS memories_edited,
    (SELECT COUNT(*) FROM memories WHERE status = 'rejected') AS memories_rejected,
    (SELECT COUNT(*) FROM feedback) AS feedback_count,
    (SELECT COUNT(*) FROM drafts WHERE status = 'pending') AS drafts_pending,
    (SELECT COUNT(*) FROM drafts WHERE status = 'approved') AS drafts_approved,
    (SELECT COUNT(*) FROM drafts WHERE status = 'edited') AS drafts_edited,
    (SELECT COUNT(*) FROM drafts WHERE status = 'rejected') AS drafts_rejected,
    (SELECT COUNT(*) FROM interview_answers WHERE answer != '') AS interview_answered,
    (SELECT COUNT(*) FROM agent_sessions) AS total_sessions,
    (SELECT COUNT(*) FROM chat_turns) AS total_turns`);

  const row = rows[0];
  return {
    total_messages: row.total_messages as number,
    messages_with_embedding: row.messages_with_embedding as number,
    sensitive_messages: row.sensitive_messages as number,
    memories_candidate: row.memories_candidate as number,
    memories_confirmed: row.memories_confirmed as number,
    memories_edited: row.memories_edited as number,
    memories_rejected: row.memories_rejected as number,
    feedback_count: row.feedback_count as number,
    drafts_pending: row.drafts_pending as number,
    drafts_approved: row.drafts_approved as number,
    drafts_edited: row.drafts_edited as number,
    drafts_rejected: row.drafts_rejected as number,
    interview_answered: row.interview_answered as number,
    total_sessions: row.total_sessions as number,
    total_turns: row.total_turns as number,
  };
}
