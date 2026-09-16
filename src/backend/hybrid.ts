import { dbQuery, dbRun } from "./db";
import * as chat from "./chat";
import * as sessions from "./sessions";

const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Suggested base URL per known provider, so the UI can preload it and no one
 * accidentally ends up on the OpenAI URL when the provider is Groq
 * (or another compatible one). */
export function defaultBaseUrl(provider: string): string {
  if (provider === "groq") return DEFAULT_GROQ_BASE_URL;
  if (provider === "openai") return DEFAULT_OPENAI_BASE_URL;
  return "";
}

export async function saveProviderCredentials(
  provider: string,
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<void> {
  await dbRun(
    `INSERT INTO provider_credentials (provider, base_url, api_key, model, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
        base_url = excluded.base_url, api_key = excluded.api_key,
        model = excluded.model, updated_at = excluded.updated_at`,
    [provider, baseUrl, apiKey, model, new Date().toISOString()],
  );
}

export interface ProviderInfo {
  provider: string;
  base_url: string;
  model: string;
  has_api_key: boolean;
}

/** Never returns the API key to the frontend once saved, only whether one is configured. */
export async function getProviderCredentials(provider: string): Promise<ProviderInfo | null> {
  const rows = await dbQuery("SELECT provider, base_url, model, api_key FROM provider_credentials WHERE provider = ?", [
    provider,
  ]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    provider: row.provider as string,
    base_url: row.base_url as string,
    model: row.model as string,
    has_api_key: (row.api_key as string).length > 0,
  };
}

export interface HybridPreview {
  provider: string;
  model: string;
  messages: chat.ChatMessage[];
  rendered_text: string;
}

function renderMessages(messages: chat.ChatMessage[]): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
}

/** Builds the EXACT message that would be sent, without making any network
 * call. Reuses `buildRagMessages` (same context logic as the local chat)
 * and offers to anonymize contact names before showing the preview. */
export async function buildHybridPreview(
  provider: string,
  history: chat.ChatMessage[],
  anonymize: boolean,
): Promise<HybridPreview> {
  const [messages] = await chat.buildRagMessages(history);

  if (anonymize) {
    const rows = await dbQuery("SELECT name FROM people WHERE is_user = 0");
    const names = rows.map((r) => r.name as string);
    for (const m of messages) {
      for (const name of names) {
        if (name.trim()) {
          m.content = m.content.split(name).join("[contacto]");
        }
      }
    }
  }

  const modelRows = await dbQuery("SELECT model FROM provider_credentials WHERE provider = ?", [provider]);
  if (modelRows.length === 0) {
    throw new Error(`no hay credenciales guardadas para el proveedor '${provider}'`);
  }
  const model = modelRows[0].model as string;

  const renderedText = renderMessages(messages);

  return { provider, model, messages, rendered_text: renderedText };
}

/** The actual network call. Only fires when the user explicitly confirms
 * the preview built by `buildHybridPreview`; never the other way around.
 * It gets logged in `external_send_log` with the exact text sent. */
export async function sendToExternalProvider(
  sessionId: string,
  provider: string,
  messages: chat.ChatMessage[],
  renderedText: string,
  anonymized: boolean,
): Promise<string> {
  const rows = await dbQuery("SELECT base_url, api_key, model FROM provider_credentials WHERE provider = ?", [
    provider,
  ]);
  if (rows.length === 0) {
    throw new Error(`no hay credenciales guardadas para '${provider}'`);
  }
  const baseUrl = rows[0].base_url as string;
  const apiKey = rows[0].api_key as string;
  const model = rows[0].model as string;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages }),
  }).catch((e) => {
    throw new Error(`no se pudo contactar a ${baseUrl}: ${e}`);
  });

  if (!res.ok) {
    throw new Error(`${provider} respondió ${res.status}: ${await res.text()}`);
  }

  const parsed = await res.json();
  const reply: string = parsed?.choices?.[0]?.message?.content ?? "";

  await dbRun(
    `INSERT INTO external_send_log (id, provider, model, anonymized, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), provider, model, anonymized ? 1 : 0, renderedText, new Date().toISOString()],
  );

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser) await sessions.recordTurn(sessionId, "user", lastUser.content);
  await sessions.recordTurn(sessionId, "assistant", reply);

  return reply;
}

export interface SendLogEntry {
  provider: string;
  model: string;
  anonymized: boolean;
  content: string;
  created_at: string;
}

export async function listExternalSendLog(): Promise<SendLogEntry[]> {
  const rows = await dbQuery(
    "SELECT provider, model, anonymized, content, created_at FROM external_send_log ORDER BY created_at DESC",
  );
  return rows.map((row) => ({
    provider: row.provider as string,
    model: row.model as string,
    anonymized: Boolean(row.anonymized),
    content: row.content as string,
    created_at: row.created_at as string,
  }));
}
