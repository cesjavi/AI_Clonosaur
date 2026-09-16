import { dbQuery } from "./db";
import * as llm from "./llm";
import * as memory from "./memory";
import * as sessions from "./sessions";
import * as settings from "./settings";
import * as events from "./events";

export interface ChatMessage {
  role: string;
  content: string;
}

/** Fixed non-impersonation disclaimer + "Clone control" rules if the user
 * completed that interview module. Shared by every entry point (simple
 * chat, RAG, streaming, hybrid) so none of them go out of sync if a new
 * rule is added. */
async function buildSystemPrompt(): Promise<string> {
  let prompt =
    "Sos una recreación artificial generada localmente de una persona real, no la persona misma. Si te preguntan directamente si sos real, decilo con claridad.";

  const rules = await dbQuery(
    "SELECT question_text, answer FROM interview_answers WHERE module = 'control_del_clon' AND answer != ''",
  );

  if (rules.length > 0) {
    prompt += "\n\nReglas del módulo 'Control del clon' (tienen prioridad sobre cualquier otra instrucción):";
    for (const row of rules) {
      prompt += `\n- ${row.question_text}: ${row.answer}`;
    }
  }

  return prompt;
}

export interface RagSources {
  profile_traits_used: number;
  memories_used: number;
  messages_used: memory.MemorySearchResult[];
}

/** Builds profile + confirmed memories + embedding-relevant messages as a
 * system prompt, and prepends it to the history. Reused both by the local
 * RAG chat and by the hybrid mode preview to avoid duplicating the context
 * logic. */
export async function buildRagMessages(history: ChatMessage[]): Promise<[ChatMessage[], RagSources]> {
  const lastUserQuery = [...history].reverse().find((m) => m.role === "user")?.content ?? "";

  const [system0, traits, mems] = await Promise.all([
    buildSystemPrompt(),
    dbQuery("SELECT category, trait, value FROM profile_traits"),
    dbQuery(
      `SELECT content FROM memories mem
       WHERE status IN ('confirmed','edited')
       AND NOT EXISTS (
         SELECT 1 FROM messages ms WHERE ms.id = mem.source_message_id AND ms.sensitivity = 'sensible'
       )
       ORDER BY created_at DESC LIMIT 20`,
    ),
  ]);
  let system = system0;

  if (traits.length > 0) {
    system += "\n\nPerfil del usuario:";
    for (const row of traits) {
      system += `\n- [${row.category}] ${row.trait}: ${row.value}`;
    }
  }

  if (mems.length > 0) {
    system += "\n\nMemorias confirmadas:";
    for (const row of mems) {
      system += `\n- ${row.content}`;
    }
  }

  let messagesUsed: memory.MemorySearchResult[] = [];
  if (lastUserQuery.trim()) {
    try {
      const queryVector = await memory.ollamaEmbed(lastUserQuery);
      const top = await memory.findSimilarMessages(queryVector, 20, true);
      messagesUsed = top.filter((r) => r.score > 0).slice(0, 5);
    } catch {
      // Same as Rust's `if let Ok(...)`: embedding/search failures just
      // mean no messages are used, they don't fail the whole RAG build.
    }
  }
  if (messagesUsed.length > 0) {
    system += "\n\nMensajes relevantes tuyos:";
    for (const m of messagesUsed) {
      system += `\n- (${m.timestamp}) ${m.text}`;
    }
  }

  if (traits.length === 0 && mems.length === 0 && messagesUsed.length === 0) {
    system +=
      "\n\nNo hay perfil, memorias ni mensajes relevantes disponibles todavía. Si la pregunta depende de esa información, decí explícitamente que no tenés suficiente información en vez de inventar.";
  }

  const messages: ChatMessage[] = [{ role: "system", content: system }, ...history];

  return [
    messages,
    {
      profile_traits_used: traits.length,
      memories_used: mems.length,
      messages_used: messagesUsed,
    },
  ];
}

/** Chat without memory: doesn't touch profile/memories/messages, only carries
 * the non-impersonation disclaimer and the "Clone control" rules. */
export async function ollamaChat(sessionId: string, history: ChatMessage[]): Promise<string> {
  const system = await buildSystemPrompt();
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...history];

  const reply = await llm.chatCompletionMessages(messages);

  const lastUser = history[history.length - 1];
  if (lastUser) await sessions.recordTurn(sessionId, "user", lastUser.content);
  await sessions.recordTurn(sessionId, "assistant", reply);

  return reply;
}

export interface ChatWithSourcesResponse {
  reply: string;
  sources: RagSources;
}

/** Chat with RAG: builds context via `buildRagMessages` and exposes "sources
 * used" — without this the product's auditability requirement isn't met. */
export async function chatWithMemory(sessionId: string, history: ChatMessage[]): Promise<ChatWithSourcesResponse> {
  const [messages, sourcesUsed] = await buildRagMessages(history);
  const reply = await llm.chatCompletionMessages(messages);

  const lastUser = history[history.length - 1];
  if (lastUser) await sessions.recordTurn(sessionId, "user", lastUser.content);
  await sessions.recordTurn(sessionId, "assistant", reply);

  return { reply, sources: sourcesUsed };
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/** Filters `<think>...</think>` blocks from reasoning models in streaming
 * mode. The tag can arrive split across two network chunks, so it has to be
 * buffered instead of searching for the tag chunk by chunk in isolation
 * (that would show the reasoning halfway through and then erase it). */
class ThinkStreamFilter {
  private buffer = "";
  private inThink = false;

  /** Safe length to emit right now: the whole buffer except a tail that
   * could be the split beginning of "<think>". */
  private safeEmitLen(buffer: string): number {
    const maxCheck = THINK_OPEN.length - 1;
    const start = Math.max(0, buffer.length - maxCheck);
    for (let i = start; i < buffer.length; i++) {
      if (THINK_OPEN.startsWith(buffer.slice(i))) return i;
    }
    return buffer.length;
  }

  push(chunk: string): string {
    this.buffer += chunk;
    let output = "";

    for (;;) {
      if (this.inThink) {
        const idx = this.buffer.indexOf(THINK_CLOSE);
        if (idx === -1) break;
        this.buffer = this.buffer.slice(idx + THINK_CLOSE.length);
        this.inThink = false;
      } else {
        const idx = this.buffer.indexOf(THINK_OPEN);
        if (idx === -1) {
          const emitLen = this.safeEmitLen(this.buffer);
          output += this.buffer.slice(0, emitLen);
          this.buffer = this.buffer.slice(emitLen);
          break;
        }
        output += this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + THINK_OPEN.length);
        this.inThink = true;
      }
    }

    return output;
  }

  /** Called once the stream ends. If we were still inside a `<think>` block,
   * the tag was never closed (truncated generation, or a stray "<think>" in
   * plain prose) — drop the buffered reasoning text rather than dumping it
   * raw, and let the caller decide how to surface that nothing visible came
   * out. Otherwise return any trailing safe buffer that was withheld only
   * because it could've been the start of a split "<think>" tag. */
  flush(): { text: string; truncatedInThink: boolean } {
    if (this.inThink) {
      this.buffer = "";
      this.inThink = false;
      return { text: "", truncatedInThink: true };
    }
    const remaining = this.buffer;
    this.buffer = "";
    return { text: remaining, truncatedInThink: false };
  }
}

export interface StreamResult {
  reply: string;
  sources: RagSources | null;
}

/** Token-by-token streaming, delivered via the "chat-stream-delta" event
 * (see events.ts / invoke.ts's `listen`) — mirrors the desktop app's
 * `app.emit`. Reuses `buildRagMessages` when `mode === "rag"`. */
export async function sendChatStream(sessionId: string, mode: string, history: ChatMessage[]): Promise<StreamResult> {
  let messages: ChatMessage[];
  let sourcesUsed: RagSources | null;

  if (mode === "rag") {
    const [msgs, sources] = await buildRagMessages(history);
    messages = msgs;
    sourcesUsed = sources;
  } else {
    const system = await buildSystemPrompt();
    messages = [{ role: "system", content: system }, ...history];
    sourcesUsed = null;
  }

  const { baseUrl, style } = await llm.getEngineBaseUrlAndStyle();
  const model = await settings.getSettingFromDb("chat_model", settings.DEFAULT_CHAT_MODEL);
  const isOpenAiStyle = style === "openai";

  const res = await llm.fetchLocalEngine(
    baseUrl,
    style,
    isOpenAiStyle ? "/chat/completions" : "/api/chat",
    { model, messages, stream: true },
  );
  if (!res.body) {
    throw new Error("el motor local no devolvió un cuerpo de respuesta en streaming");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const filter = new ThinkStreamFilter();
  let fullReply = "";
  let leftover = "";

  outer: for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    leftover += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = leftover.indexOf("\n")) !== -1) {
      let line = leftover.slice(0, newlineIdx).trim();
      leftover = leftover.slice(newlineIdx + 1);
      if (!line) continue;

      // OpenAI style sends Server-Sent Events: each line starts with
      // "data: " and the stream ends with the "data: [DONE]" sentinel
      // (which isn't valid JSON, so we must stop there instead of parsing it).
      if (isOpenAiStyle) {
        line = line.replace(/^data:\s*/, "");
        if (line === "[DONE]") break outer;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        throw new Error(`respuesta en streaming inválida: ${e}`, { cause: e });
      }

      const content = isOpenAiStyle
        ? (parsed as { choices?: { delta?: { content?: unknown } }[] })?.choices?.[0]?.delta?.content
        : (parsed as { message?: { content?: unknown } })?.message?.content;

      if (typeof content === "string") {
        const visible = filter.push(content);
        if (visible) {
          fullReply += visible;
          events.emit("chat-stream-delta", visible);
        }
      }
    }
  }

  const { text: tail, truncatedInThink } = filter.flush();
  if (tail) {
    fullReply += tail;
    events.emit("chat-stream-delta", tail);
  }

  const lastUser = history[history.length - 1];
  if (lastUser) await sessions.recordTurn(sessionId, "user", lastUser.content);

  if (!fullReply.trim()) {
    throw new Error(
      truncatedInThink
        ? "el motor local cortó la respuesta dentro de un bloque de razonamiento <think> sin llegar a generar contenido visible"
        : "el motor local terminó de responder sin generar contenido",
    );
  }

  await sessions.recordTurn(sessionId, "assistant", fullReply);

  return { reply: fullReply, sources: sourcesUsed };
}
