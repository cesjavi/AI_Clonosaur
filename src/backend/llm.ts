import * as settings from "./settings";

// Local copy of invoke.ts's isTauri() check — importing invoke.ts here would
// create a cycle (invoke.ts -> chat.ts -> llm.ts -> invoke.ts).
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface LlmChatMessage {
  role: string;
  content: string;
}

/** Base URL + API style shared by every call to the local engine (chat,
 * embeddings, streaming chat) — the only two settings that aren't specific
 * to one kind of call. */
export async function getEngineBaseUrlAndStyle(): Promise<{ baseUrl: string; style: string }> {
  const baseUrl = await settings.getSettingFromDb("ollama_base_url", settings.DEFAULT_OLLAMA_BASE_URL);
  const style = await settings.getSettingFromDb("local_api_style", settings.DEFAULT_LOCAL_API_STYLE);
  return { baseUrl, style };
}

/** Does the actual fetch to the configured local engine (native Ollama or
 * OpenAI-compatible, e.g. Lemonade Server), returning the raw `Response`.
 * "Can't reach the engine" and "engine responded with an error status" are
 * wrapped into one consistent, Spanish-language error either way — shared by
 * every caller, streaming or not, so this error handling (including which
 * engine name shows up in the message) only exists in one place instead of
 * being re-typed per caller. */
export async function fetchLocalEngine(
  baseUrl: string,
  style: string,
  path: string,
  body: unknown,
): Promise<Response> {
  const isOpenAiStyle = style === "openai";
  const engineLabel = isOpenAiStyle ? "el motor local" : "Ollama";

  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const res = await fetch(`${normalizedBaseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((e) => {
    // In the browser build (not Tauri, which has no CORS restriction),
    // `fetch` throws a generic "Failed to fetch" TypeError both when the
    // engine is simply down AND when it's up but refusing the browser's
    // origin — the two are indistinguishable from JS, so we always show the
    // OLLAMA_ORIGINS fix alongside the plain "can't reach it" explanation
    // (see Phase W3 in docs/WEB_VERSION.md) instead of a bare network error.
    const corsHint =
      !isTauri() && e instanceof TypeError
        ? ` — si ${engineLabel} está corriendo pero seguís viendo este error, probablemente sea CORS: iniciá Ollama con la variable de entorno OLLAMA_ORIGINS="*" (o con el origen de esta página) para permitir que el navegador se conecte`
        : "";
    throw new Error(`no se pudo contactar a ${engineLabel} en ${baseUrl}: ${e}${corsHint}`);
  });
  if (!res.ok) {
    throw new Error(`${isOpenAiStyle ? "El motor local" : "Ollama"} respondió ${res.status}: ${await res.text()}`);
  }
  return res;
}

/** Same as `fetchLocalEngine`, but for non-streaming callers that just want
 * the parsed JSON body (chat completion, embeddings). */
export async function postLocalEngine(baseUrl: string, style: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetchLocalEngine(baseUrl, style, path, body);
  return res.json();
}

/** Non-streaming chat call against the configured local engine, given a
 * full message list. Shared by `chatCompletion` (single-prompt callers like
 * the profile-modeling generators) and chat.ts's `ollamaChat`/`chatWithMemory`
 * (which need to pass a real conversation history). */
export async function chatCompletionMessages(messages: LlmChatMessage[]): Promise<string> {
  const { baseUrl, style } = await getEngineBaseUrlAndStyle();
  const model = await settings.getSettingFromDb("chat_model", settings.DEFAULT_CHAT_MODEL);
  const isOpenAiStyle = style === "openai";

  const parsed = await postLocalEngine(
    baseUrl,
    style,
    isOpenAiStyle ? "/chat/completions" : "/api/chat",
    { model, messages, stream: false },
  );

  const content = isOpenAiStyle
    ? (parsed as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content
    : (parsed as { message?: { content?: unknown } })?.message?.content;
  if (typeof content !== "string") {
    throw new Error(
      isOpenAiStyle ? "el motor local no devolvió ninguna respuesta" : "respuesta de chat de Ollama inesperada",
    );
  }
  return stripThinkBlocks(content).trim();
}

/** Non-streaming chat call against the configured local engine (Ollama or
 * OpenAI-compatible, e.g. Lemonade Server). Returns the raw text of the
 * model's response (not parsed yet). */
export async function chatCompletion(prompt: string): Promise<string> {
  return chatCompletionMessages([{ role: "user", content: prompt }]);
}

/** Removes `<think>...</think>` blocks emitted by reasoning models (as well as
 * any truncated trailing `<think>...`). */
export function stripThinkBlocks(raw: string): string {
  let out = "";
  let rest = raw;
  for (;;) {
    const start = rest.indexOf("<think>");
    if (start === -1) break;
    out += rest.slice(0, start);
    const afterOpen = rest.slice(start + "<think>".length);
    const end = afterOpen.indexOf("</think>");
    if (end === -1) return out;
    rest = afterOpen.slice(end + "</think>".length);
  }
  return out + rest;
}

/** Models sometimes return an "evidence" field as a string and
 * sometimes as an array of several quotes, depending on how many fragments it
 * considers relevant. Accepting both forms avoids breaking parsing over this
 * variation instead of forcing a strict type that the model doesn't always respect. */
export function valueToText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map(valueToText)
      .filter((s) => s.length > 0)
      .join("; ");
  }
  if (v === null || v === undefined) return "";
  return String(v);
}

/** Models often wrap the requested JSON in prose, `<think>` blocks, or
 * ```json``` code blocks — and may cite `[0]`/`[1]` in preamble prose before
 * the actual JSON array. Strips `<think>` blocks first, then tries candidate
 * `[` starts against the last `]`. */
export function parseJsonArray<T>(raw: string): T[] {
  const cleaned = stripThinkBlocks(raw);
  const end = cleaned.lastIndexOf("]");
  if (end === -1) {
    throw new Error("el modelo no devolvió un array JSON reconocible");
  }
  let lastErr: unknown = null;
  let foundBracket = false;
  for (let i = 0; i <= end; i++) {
    if (cleaned[i] !== "[") continue;
    foundBracket = true;
    try {
      const parsed = JSON.parse(cleaned.slice(i, end + 1));
      if (Array.isArray(parsed)) return parsed as T[];
    } catch (err) {
      lastErr = err;
    }
  }
  if (!foundBracket) {
    throw new Error("el modelo no devolvió un array JSON reconocible");
  }
  throw new Error(`no se pudo interpretar la respuesta del modelo como JSON: ${lastErr}`, { cause: lastErr });
}
