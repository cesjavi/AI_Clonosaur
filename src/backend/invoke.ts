import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import * as interview from "./interview";
import * as profile from "./profile";
import * as sources from "./sources";
import * as whatsapp from "./whatsapp";
import * as generic from "./generic";
import * as twitter from "./twitter";
import * as reddit from "./reddit";
import * as discord from "./discord";
import * as gmail from "./gmail";
import * as settings from "./settings";
import * as memory from "./memory";
import * as feedback from "./feedback";
import * as candidateMemories from "./candidateMemories";
import * as contradictionDetector from "./contradictionDetector";
import * as valuesModel from "./valuesModel";
import * as decisionModel from "./decisionModel";
import * as toneModel from "./toneModel";
import * as sessions from "./sessions";
import * as chat from "./chat";
import * as hybrid from "./hybrid";
import * as metrics from "./metrics";
import * as deletion from "./deletion";
import * as events from "./events";
import * as vault from "./vault";
import * as copilot from "./copilot";
import * as whisperWeb from "./whisperWeb";

/**
 * Phase W0/W2 bridge (see docs/WEB_VERSION.md): every screen already calls
 * `invoke`/`listen` the same way regardless of whether it's running inside
 * the Tauri desktop app or a plain browser tab. Commands are ported to
 * TypeScript one module at a time (Phase W2); `PORTED_COMMANDS` grows as
 * that happens. Everything not yet in that table falls back to a stub
 * (reads) or a clear "not implemented yet" rejection (writes), so the web
 * build never crashes — it just tells you honestly what isn't built yet.
 */

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Real TypeScript implementations, keyed by the exact Tauri command name.
// `args` uses the same camelCase keys Tauri's JS bindings generate from the
// Rust command's snake_case parameters (e.g. `question_id` -> `questionId`).
const PORTED_COMMANDS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  get_interview_answers: () => interview.getInterviewAnswers(),
  save_interview_answer: (a) =>
    interview.saveInterviewAnswer(
      a.module as string,
      a.questionId as string,
      a.questionText as string,
      a.answer as string,
    ),
  list_profile_traits: () => profile.listProfileTraits(),
  create_profile_trait: (a) => profile.createProfileTrait(a.category as string, a.traitName as string, a.value as string),
  update_profile_trait: (a) =>
    profile.updateProfileTrait(a.id as string, a.category as string, a.traitName as string, a.value as string),
  delete_profile_trait: (a) => profile.deleteProfileTrait(a.id as string),
  list_sources: () => sources.listSources(),
  list_people: () => sources.listPeople(),
  set_person_excluded: (a) => sources.setPersonExcluded(a.personId as string, a.excluded as boolean),
  set_person_relationship: (a) => sources.setPersonRelationship(a.personId as string, a.relationship as string | null),
  set_user_person: (a) => sources.setUserPerson(a.personId as string),
  import_whatsapp_file: (a) => whatsapp.importWhatsappFile(a.fileName as string, a.bytes as Uint8Array),
  import_generic_file: (a) => generic.importGenericFile(a.fileName as string, a.bytes as Uint8Array),
  import_twitter_file: (a) =>
    twitter.importTwitterFile(a.fileName as string, a.bytes as Uint8Array, a.username as string),
  import_reddit_file: (a) => reddit.importRedditFile(a.fileName as string, a.bytes as Uint8Array),
  import_discord_file: (a) => discord.importDiscordFile(a.fileName as string, a.bytes as Uint8Array),
  import_gmail_file: (a) => gmail.importGmailFile(a.fileName as string, a.bytes as Uint8Array),
  get_settings: () => settings.getSettings(),
  update_setting: (a) => settings.updateSetting(a.key as string, a.value as string),
  get_embedding_coverage: () => memory.getEmbeddingCoverage(),
  generate_embeddings: () => memory.generateEmbeddings(),
  search_memory: (a) => memory.searchMemory(a.query as string, a.limit as number | undefined),
  record_feedback: (a) => feedback.recordFeedback(a.messageId as string, a.isUser as boolean),
  list_memories: (a) => candidateMemories.listMemories(a.status as string | null | undefined),
  update_memory_status: (a) =>
    candidateMemories.updateMemoryStatus(a.id as string, a.status as string, a.content as string | null | undefined),
  generate_candidate_memories: () => candidateMemories.generateCandidateMemories(),
  detect_contradictions: () => contradictionDetector.detectContradictions(),
  generate_values: () => valuesModel.generateValues(),
  generate_decisions: () => decisionModel.generateDecisions(),
  generate_tone: () => toneModel.generateTone(),
  create_session: (a) => sessions.createSession(a.mode as string),
  close_session: (a) => sessions.closeSession(a.sessionId as string),
  list_chat_turns: () => sessions.listChatTurns(),
  ollama_chat: (a) => chat.ollamaChat(a.sessionId as string, a.history as chat.ChatMessage[]),
  chat_with_memory: (a) => chat.chatWithMemory(a.sessionId as string, a.history as chat.ChatMessage[]),
  send_chat_stream: (a) =>
    chat.sendChatStream(a.sessionId as string, a.mode as string, a.history as chat.ChatMessage[]),
  default_base_url: (a) => Promise.resolve(hybrid.defaultBaseUrl(a.provider as string)),
  save_provider_credentials: (a) =>
    hybrid.saveProviderCredentials(a.provider as string, a.baseUrl as string, a.apiKey as string, a.model as string),
  get_provider_credentials: (a) => hybrid.getProviderCredentials(a.provider as string),
  build_hybrid_preview: (a) =>
    hybrid.buildHybridPreview(a.provider as string, a.history as chat.ChatMessage[], a.anonymize as boolean),
  send_to_external_provider: (a) =>
    hybrid.sendToExternalProvider(
      a.sessionId as string,
      a.provider as string,
      a.messages as chat.ChatMessage[],
      a.renderedText as string,
      a.anonymized as boolean,
    ),
  list_external_send_log: () => hybrid.listExternalSendLog(),
  get_metrics: () => metrics.getMetrics(),
  delete_by_source: (a) => deletion.deleteBySource(a.sourceId as string),
  delete_by_contact: (a) => deletion.deleteByContact(a.personId as string),
  delete_by_date_range: (a) => deletion.deleteByDateRange(a.from as string, a.to as string),
  get_vault_status: () => vault.getVaultStatus(),
  setup_master_password: (a) => vault.setupMasterPassword(a.password as string),
  unlock_vault: (a) => vault.unlockVault(a.password as string),
  lock_vault: (a) => vault.lockVault(a.password as string),
  reset_database: (a) => vault.resetDatabase(a.confirmation as string),
  generate_draft: (a) => copilot.generateDraft(a.contactPersonId as string | null, a.instruction as string),
  list_drafts: () => copilot.listDrafts(),
  update_draft_status: (a) =>
    copilot.updateDraftStatus(a.id as string, a.status as string, a.content as string | null),
  list_whisper_models: () => whisperWeb.listWhisperModels(),
  download_whisper_model: (a) => whisperWeb.downloadWhisperModel(a.model as string),
  transcribe_audio: (a) => whisperWeb.transcribeAudio(a.samples as number[]),
};

// Every read-only command any screen calls on mount, with the same shape
// its real Rust counterpart returns for an empty database. Only commands
// NOT YET in PORTED_COMMANDS need an entry here.
const READ_DEFAULTS: Record<string, unknown> = {};

// Commands that are safe to silently no-op in the web scaffold (cleanup
// calls, mostly) instead of rejecting.
const SILENT_NOOPS = new Set<string>([]);

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    return tauriInvoke<T>(cmd, args);
  }

  if (cmd in PORTED_COMMANDS) {
    return PORTED_COMMANDS[cmd](args ?? {}) as Promise<T>;
  }
  if (cmd in READ_DEFAULTS) {
    return structuredClone(READ_DEFAULTS[cmd]) as T;
  }
  if (SILENT_NOOPS.has(cmd)) {
    return undefined as T;
  }

  throw new Error(
    `"${cmd}" todavía no está implementado en la versión web (Fase W2 en progreso — ver docs/WEB_VERSION.md).`,
  );
}

export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  if (isTauri()) {
    return tauriListen<T>(event, handler);
  }
  // Ported commands (e.g. chat.ts's streaming) publish through events.ts;
  // wrap it in the same `{ event, id, payload }` shape Tauri's real
  // `listen` delivers so handlers don't need to know which backend it is.
  return events.on(event, (payload) => handler({ event, id: 0, payload: payload as T }));
}
