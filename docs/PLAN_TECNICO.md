# Technical plan: Clonosaur

This document is a technical implementation guide, intended for someone (person or agent) who has never seen the repo and needs to build it from scratch. It is not the product roadmap (see [ROADMAP.md](ROADMAP.md)) nor the explanation of the clone's identity (see [IDENTITY.md](IDENTITY.md)) — it's the **build order**: what to implement first so each phase can build on the previous one without rework. It covers the desktop version (Tauri); for a web version see [WEB_VERSION.md](WEB_VERSION.md).

Each phase states: the goal, which files/modules it creates, what it depends on, and the "done" criterion (what you should be able to do once it's finished).

## Phase 0 — Scaffold and stack decisions

**Goal:** have a desktop app that opens an empty window.

- `npm create tauri-app@latest` with the React + TypeScript + Vite template.
- Choose Tauri (not Electron): smaller footprint, better story for local filesystem/SQLite access without an embedded Node runtime.
- Create `src-tauri/Cargo.toml` with lib name `clonosaur_lib` (the `_lib` suffix avoids a collision with the binary on Windows).
- Base dependencies in `Cargo.toml`: `tauri`, `tauri-plugin-opener`, `serde`/`serde_json`, `uuid`, `chrono`.
- An empty Node sidecar (`sidecar/`) with just a health check, meant for heavy parsers down the line (skip it if that need isn't anticipated).

**Done when:** `npm run tauri dev` opens a window with a button that calls a test Tauri command (`invoke`).

## Phase 1 — Data schema and persistence (local MVP)

**Goal:** local SQLite working, with the data model that **everything else** will extend.

- `db/schema.sql`: design the core tables first, in this dependency order:
  1. `sources` (where an imported piece of data comes from) → `conversations` → `people` → `messages` → `conversation_participants`.
  2. `interview_answers` (module, question, answer).
  3. `profile_traits` (category, trait, value, source) — design it from day 1 as a generic table reusable by *all* future personality generators (values, decisions, tone), not one table per generator.
- `src-tauri/src/db.rs`: open the SQLite connection via `rusqlite` (`bundled` feature, no dependency on a system SQLite install), apply `schema.sql` on startup (`CREATE TABLE IF NOT EXISTS`, idempotent).
- Decide the "duplicate" criterion (text + timestamp + author) early, even though the detection function (`find_duplicate_message_id`) is only implemented in Phase 3 — this avoids re-modeling `messages` later.
- `interview/questions.json` + `Interview.tsx` screen: fixed questions grouped by module (identity, mental style, communication, relationships, autobiographical memory, clone control). Persist answer by answer when leaving each field, not at the end.
- `Profile.tsx` + `profile.rs`: manual create/edit/delete of `profile_traits`. This is intentionally manual before any automatic generator exists.

**Done when:** the guided interview persists answers across app restarts, and the profile can be edited by hand.

## Phase 2 — Memory and semantic search

**Goal:** be able to search imported content by meaning, not just exact text.

Depends on having at least one importer (Phase 3) to have data, but the engine itself doesn't depend on any specific importer — it can be built against manually inserted test data.

- `embeddings` table (`message_id`, serialized vector).
- `src-tauri/src/memory.rs`: generate embeddings via a local model (Ollama, `nomic-embed-text` by default) for messages that don't have one yet; search by **in-memory cosine similarity** (no vector extension — a deliberate decision for this project's personal-data volumes, not for arbitrary scale).
- `memories` table (`status`: candidate/confirmed/edited/rejected, `layer`, `metadata`) — design it already anticipating it will receive entries from more than one source (candidate memories from the LLM in Phase 3, contradictions in Phase 4).
- `feedback` table + "this is me"/"not me" buttons on search results (`feedback.rs`): fixes author attribution when an importer got it wrong.

**Done when:** "Memory" indexes messages and returns relevant results for a natural-language search, with author/date/source visible.

## Phase 3 — More local sources (importers)

**Goal:** ingest the user's real data. Build in this order because each one reuses patterns from the previous one:

1. **WhatsApp** (`whatsapp.rs`): first because it's simple structured plain text (`.txt` or `.zip`), Android/iOS format. Establishes the pipeline pattern: parse → `sources` → `conversations` → `people` → `messages`.
2. **Generic** (`generic_import.rs`): `.json`/`.csv`/`.txt` with fixed columns (`text`, `timestamp?`, `author?`, `is_user?`). Serves as a safety net for any source without a dedicated parser, and as the reference for the minimal interface every importer must produce.
3. **Gmail Takeout** (`gmail_import.rs`): the most complex one — manual RFC822/MIME parser (`=?UTF-8?Q?...?=`/`=?UTF-8?B?...?=` headers, multipart, `quoted-printable`/`base64`, `text/plain` preferred over `text/html`). Deliberately no external email dependencies (smaller, more auditable attack/parsing surface).
4. **Twitter/X, Discord, Reddit** (`twitter_import.rs`, `discord_import.rs`, `reddit_import.rs`): the three exports that only contain the user's own content, so `is_user = true` always — simpler than Gmail/WhatsApp because there's no need to distinguish other participants.
5. **Duplicate detection** (`db::find_duplicate_message_id`, pipeline step 7): add the text+timestamp+author check to all 6 importers before inserting. Do this last, once all 6 parsers exist, to write it once in a shared way instead of duplicating it per importer.
6. **Contact classification** (`people.relationship`): manual field in `people`, UI in "Privacy" → "Contacts".

**Done when:** all 6 sources import without duplicating data on re-imports, and each detected person can be tagged by relationship type.

## Phase 4 — Advanced personality

**Goal:** generate profile layers automatically from interview + memories + messages, instead of only manual editing.

Depends on Phases 1–3 (needs interview, confirmed memories, and own messages as evidence).

- **Candidate memories** (`candidate_memories.rs`): the LLM extracts facts/preferences/traits from own messages without an associated memory yet → `memories` with `status = 'candidate'`. Never moves to `confirmed` without explicit user approval — this auditability principle repeats across all following generators.
- **Contradiction detection** (`contradiction_detector.rs`): compares *already confirmed* memories against each other by date, looks for real changes of opinion (not minor natural evolution). Reuses the same candidate-memory review flow (`dinamica` layer) instead of creating a new screen — building it this way saves a whole screen.
- **Values model** (`values_model.rs`): analyzes the "Identity" interview module + memories + own messages → up to 8 values with cited evidence, saved in `profile_traits` (`category = 'valores'`).
- **Decision model** (`decision_model.rs`): same pattern as values, over the "Mental style" and "Autobiographical memory" modules.
- **Tone by context** (`tone_model.rs`): groups own messages by conversation, describes the tone of each one → `profile_traits` (`category = 'tono_contextual'`).

The three generators share a structure (gather evidence → prompt that requires citing evidence → save to `profile_traits` avoiding duplicates by name) — build the first one (values) completely, and clone the pattern for the other two instead of prematurely generalizing into a "generators" framework.

**Done when:** all three screens (Values, Decisions, Tone) generate results citing real evidence, editable from "Profile".

## Phase 5 — Chat and hybrid mode

**Goal:** talk to the clone, first locally, then with external providers under explicit user control.

- **Simple chat** (`chat.rs::ollama_chat`): Tauri proxy against Ollama's `http://localhost:11434/api/chat` (avoids CORS). Minimal system message: non-impersonation disclaimer + "Clone Control" rules if they exist.
- **Chat with RAG** (`chat_with_memory`): assembles context (full profile + last 20 confirmed/edited memories + top-5 relevant messages by embedding, excluding `sensitivity = 'sensible'`) and prepends it as a system prompt. Exposes "Sources used" in the UI — without this, the auditability product principle isn't met.
- **Streaming** (`send_chat_stream`, `chat-stream-delta` event): add this only once non-streaming chat already works. The tricky part is filtering `<think>...</think>` blocks from reasoning models with state (`ThinkStreamFilter`), because the tag can split across two network chunks — designing the filter with a buffer from the start avoids the flicker of showing the reasoning and then erasing it.
- **Sessions and turns** (`sessions.rs`, `agent_sessions`/`chat_turns` tables): create a session when the chat screen mounts, close it when it unmounts, log each turn. Without this, "Metrics" can't calculate anything per session.
- **Persistent history** (`sessions::list_chat_turns`): load the last 200 turns when "Chat" mounts — known limitation: the historical RAG context ("Sources used") isn't persisted, only the text.
- **Hybrid mode** (`hybrid.rs`): external provider compatible with OpenAI Chat Completions. Mandatory two-step flow: `build_hybrid_preview` (assembles the exact message, no network) → user reviews → `send_to_external_provider` (the actual call) → logged in `external_send_log`. Build the preview *before* the actual send, never the other way around — this is hybrid mode's privacy guarantee. Reuse `build_rag_messages`, shared with local chat, instead of duplicating the context logic.
- **First-class Groq support**: specific base URL default (`https://api.groq.com/openai/v1`) so it doesn't accidentally fall back to the OpenAI URL when the provider is something else.
- **Own backend on Vercel** (`vercel-backend/`, separate Next.js): thin authenticated proxy (`CLONOSAUR_SHARED_SECRET`) to a real provider, so the real key doesn't have to be distributed with every install. Build this only if you need to avoid putting the provider's API key on every machine — it's optional and decoupled from the rest of the project.

**Done when:** local chat, RAG, streaming, and hybrid (with mandatory preview) all work, and every external send is logged.

## Phase 6 — Personal copilot and cross-cutting safeguards

**Goal:** a drafting assistant, and closing the privacy/quality gaps found during audit.

- **Copilot** (`copilot.rs`): same context assembly as chat with RAG, but the result is a draft in `drafts` (`status = 'pending'`), never an automatic send. Check `people.excluded` *before* calling the model, not after.
- **Sensitivity classification** (`sensitivity.rs`): keyword heuristic (no LLM) applied to each imported message at ingestion time, not as a separate step — so chat with RAG can filter by `sensitivity = 'sensible'` from the day it exists.
- **Applied clone control** (`build_system_prompt` in `chat.rs`): answers from the "Clone Control" interview module must be injected into **all** chat modes and the copilot, not just saved. Easy to leave half-done if built module by module — verify at the end that all 4 entry points (simple chat, RAG, hybrid, copilot) read the same function.
- **Quality metrics** (`metrics.rs`): embedding coverage, memories by status, attribution feedback, drafts by status, interview progress, sessions/turns — all calculated from the local database in real time, never hardcoded.
- **Encryption at rest** (`encryption.rs` + `vault.rs`): if SQLCipher doesn't compile on the target environment (typical on Windows without native Perl), use pure-Rust AES-256-GCM + Argon2id (`aes-gcm`, `argon2`) over the whole file instead of SQLite page-level encryption. Pattern: `clonosaur.db.enc` on disk always; when unlocking, decrypt to a `clonosaur.db` working copy that SQLite uses normally; "Lock now" re-encrypts and deletes the working copy. Explicitly document that there's no password recovery.
- **Full reset** (`vault::reset_database`): requires typing an exact confirmation phrase, not just a single click. Release the active SQLite connection before deleting the file (necessary on Windows).
- **Selective deletion** (`deletion.rs`): by source, by contact, or by date range — clean up references in `memories` before deleting messages so nothing is left orphaned.

**Done when:** the copilot generates drafts without sending anything, all 4 chat modes respect "Clone Control" and sensitivity, and the database can be encrypted/locked/deleted safely.

## Phase 7 — Voice and startup UX

**Goal:** voice input/output, and a coherent first impression (not a 20-tab form from the very first use).

- **Local transcription** (`transcription.rs` + `whisper-rs`): 🎤 button records (`MediaRecorder`/`getUserMedia`), resamples to 16kHz mono **in the frontend** (`AudioContext`/`OfflineAudioContext`, no codecs in Rust), sends samples to a Tauri command that runs whisper.cpp. 🔊 button uses the browser's native `speechSynthesis` — zero new dependencies for that half. Cache the loaded model in memory (`WhisperState`) and run the transcription in `spawn_blocking` so it doesn't block the UI.
  - Platform note: on Windows with a Visual Studio preview, `whisper-rs` (CMake) can fail to detect the generator or `libclang.dll`. If that happens, use `dev.bat`/`build.bat` wrappers that load `vcvars64.bat` and force `CMAKE_GENERATOR`/`LIBCLANG_PATH` before invoking the npm commands — simpler than debugging CMake toolchain detection.
  - Model download (`download_whisper_model`): restrict to a fixed allowlist on the backend (tiny/base/small/medium), never build the URL from an arbitrary name from the frontend.
- **Splash + onboarding + focused mode** (`Splash.tsx`, `App.tsx`): brief brand screen within the same window (avoids the complexity of a second native Tauri window). If nothing has ever been saved in "Settings", show full navigation starting on that screen; after the first save (`onboarding_completed`), collapse to "focused mode" (chat only, advanced options behind a `<details>`).
- **Centralized settings** (`settings.rs`, `app_settings` table): Ollama URL, default chat/embeddings model, visual theme. Build this **before** the Ollama URL ends up hardcoded in 11 different places, not as a later refactor — avoids the "centralize settings" rework that happened in this project.

**Done when:** a new user reaches a working chat in under a minute after the master password, without having to understand 20 screens first.

## Summary order (strong dependencies)

```
Phase 0 (scaffold)
  └─ Phase 1 (schema + interview + manual profile)
       ├─ Phase 2 (embeddings + search) ──┐
       └─ Phase 3 (importers)  ───────────┤
                                            └─ Phase 4 (personality generators)
                                                   └─ Phase 5 (local chat → RAG → streaming → hybrid)
                                                          └─ Phase 6 (copilot + safeguards + encryption)
                                                                 └─ Phase 7 (voice + startup UX)
```

Centralized settings (part of Phase 7) is worth moving up to Phase 1 — it's the only decision in this list that, done late, forces you to touch 11 files instead of 1.

## Deliberate decisions (and the alternatives ruled out)

- Outlook `.pst`: a conscious decision not to support it (proprietary binary format, high parsing risk). Document the alternative (Thunderbird + ImportExportTools NG → `.mbox` → Gmail importer) instead of writing a custom parser.
- Schema migrations: using ad-hoc patches (`ALTER TABLE ... ADD COLUMN`, ignoring the error if it already exists) is acceptable for a small schema, but if many schema changes are anticipated, it's worth introducing a versioned migration system from Phase 1 instead of repeating the patch.
