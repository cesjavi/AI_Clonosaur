import { dbQuery, dbRun } from "./db";
import * as llm from "./llm";
import * as settings from "./settings";

/** Generates an embedding against the configured local engine. Supports
 * two API formats (see settings.DEFAULT_LOCAL_API_STYLE): native Ollama
 * (`/api/embeddings`) or OpenAI-compatible (`/v1/embeddings`, e.g.
 * Lemonade Server) — both run on the user's machine. `fetch` replaces
 * `reqwest`; the browser handles CORS itself (see docs/WEB_VERSION.md,
 * Phase W3, for what that requires from the local engine). */
export async function ollamaEmbed(text: string): Promise<number[]> {
  const { baseUrl, style } = await llm.getEngineBaseUrlAndStyle();
  const model = await settings.getSettingFromDb("embedding_model", settings.DEFAULT_EMBEDDING_MODEL);
  const isOpenAiStyle = style === "openai";

  const parsed = await llm.postLocalEngine(
    baseUrl,
    style,
    isOpenAiStyle ? "/embeddings" : "/api/embeddings",
    isOpenAiStyle ? { model, input: text } : { model, prompt: text },
  );

  const embedding = isOpenAiStyle
    ? (parsed as { data?: { embedding?: number[] }[] })?.data?.[0]?.embedding
    : (parsed as { embedding?: number[] })?.embedding;
  if (!embedding) {
    throw new Error(
      isOpenAiStyle ? "el motor local no devolvió ningún embedding" : "respuesta de embeddings de Ollama inesperada",
    );
  }
  return embedding;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface EmbeddingCoverage {
  total_messages: number;
  with_embedding: number;
}

export async function getEmbeddingCoverage(): Promise<EmbeddingCoverage> {
  const [[totalRow], [withRow]] = await Promise.all([
    dbQuery("SELECT COUNT(*) as n FROM messages"),
    dbQuery("SELECT COUNT(*) as n FROM embeddings"),
  ]);
  return { total_messages: totalRow.n as number, with_embedding: withRow.n as number };
}

/** Generates embeddings for all messages that don't have one yet. Runs
 * sequentially against the local engine: sufficient for personal data
 * volumes, and simpler than parallelizing against a single local model. */
export async function generateEmbeddings(): Promise<number> {
  const pending = await dbQuery(
    `SELECT m.id, m.text FROM messages m
     LEFT JOIN embeddings e ON e.message_id = m.id
     WHERE e.message_id IS NULL`,
  );

  const embeddingModel = await settings.getSettingFromDb("embedding_model", settings.DEFAULT_EMBEDDING_MODEL);

  let generated = 0;
  for (const row of pending) {
    const messageId = row.id as string;
    const text = row.text as string;
    if (!text.trim()) continue;

    const vector = await ollamaEmbed(text);
    const vectorJson = JSON.stringify(vector);
    const now = new Date().toISOString();

    await dbRun(
      `INSERT INTO embeddings (message_id, model, vector, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET model = excluded.model, vector = excluded.vector, created_at = excluded.created_at`,
      [messageId, embeddingModel, vectorJson, now],
    );

    generated += 1;
  }

  return generated;
}

export interface MemorySearchResult {
  message_id: string;
  text: string;
  timestamp: string;
  author: string | null;
  is_user: boolean;
  source_kind: string;
  score: number;
}

/** Core of the semantic search, reused by `searchMemory` (manual search,
 * includes sensitive messages and excluded contacts) and by the chat's
 * RAG context building (which excludes both). */
export async function findSimilarMessages(
  queryVector: number[],
  limit: number,
  excludeSensitive: boolean,
): Promise<MemorySearchResult[]> {
  const sql = excludeSensitive
    ? `SELECT e.message_id, e.vector, m.text, m.timestamp, m.is_user, p.name as author, s.kind as source_kind
       FROM embeddings e
       JOIN messages m ON m.id = e.message_id
       LEFT JOIN people p ON p.id = m.person_id
       JOIN sources s ON s.id = m.source_id
       WHERE m.sensitivity IS NOT 'sensible'
       AND (p.excluded IS NULL OR p.excluded = 0)`
    : `SELECT e.message_id, e.vector, m.text, m.timestamp, m.is_user, p.name as author, s.kind as source_kind
       FROM embeddings e
       JOIN messages m ON m.id = e.message_id
       LEFT JOIN people p ON p.id = m.person_id
       JOIN sources s ON s.id = m.source_id`;

  const rows = await dbQuery(sql);

  const scored: MemorySearchResult[] = rows.map((row) => {
    const vector = JSON.parse(row.vector as string) as number[];
    return {
      message_id: row.message_id as string,
      text: row.text as string,
      timestamp: row.timestamp as string,
      author: row.author as string | null,
      is_user: Boolean(row.is_user),
      source_kind: row.source_kind as string,
      score: cosineSimilarity(queryVector, vector),
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Searches for the messages semantically most similar to `query`. Unlike
 * the chat's automatic RAG context, this manual search does include
 * messages marked as sensitive (with a warning in the UI). */
export async function searchMemory(query: string, limit = 5): Promise<MemorySearchResult[]> {
  const queryVector = await ollamaEmbed(query);
  return findSimilarMessages(queryVector, limit, false);
}
