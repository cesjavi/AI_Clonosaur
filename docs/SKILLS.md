# Skills needed for Clonosaur

List of the knowledge and tools required to build the project following [PLAN_TECNICO.md](PLAN_TECNICO.md), grouped by area. Meant as a checklist of capabilities, not of tasks.

## 1. Desktop app (Tauri)

- Tauri v2: commands (`#[tauri::command]`), invocation from the frontend (`invoke`), events (`emit`/`listen`) for asynchronous progress (e.g. chat streaming, model download).
- Tauri packaging/build (`tauri build`) and native toolchain differences per OS (Visual Studio Build Tools + WebView2 on Windows, Xcode CLT on macOS, `webkit2gtk`/`libssl-dev` on Linux).
- Managing the app's local data directory (SQLite path, downloaded Whisper models, etc.) via Tauri's APIs.
- Diagnosing Windows build issues with non-standard C/C++ toolchains (CMake generator not recognized, `libclang.dll` not found by `bindgen`) — needed for dependencies that compile native code (`whisper-rs`, bundled `rusqlite`).

## 2. Frontend (React + TypeScript)

- React 19 + TypeScript + Vite: functional components, hooks (`useState`, `useEffect`), mount/unmount as an effect trigger (opening/closing a chat session).
- Handling controlled form state without a forms library (inline profile editing, field-by-field interview).
- Consuming backend streaming events (updating the UI token by token without a full re-render).
- Plain per-screen CSS (no styling framework) with light/dark theme support via an attribute (`data-theme`) taking priority over `prefers-color-scheme`.
- Browser APIs: `MediaRecorder`/`getUserMedia` (audio recording), `AudioContext`/`OfflineAudioContext` (resampling to 16kHz mono without libraries), `speechSynthesis` (native text-to-speech).

## 3. Backend (Rust)

- Idiomatic Rust for domain logic: parsers, text extraction, error handling with `Result`/`?`.
- `rusqlite` (`bundled` feature) for embedded SQLite with no system dependency.
- `tokio` for blocking work off the UI thread (`spawn_blocking`, relevant for transcription with whisper.cpp).
- `reqwest` (with `stream`) + `futures-util` for HTTP calls and stream consumption (SSE from OpenAI-style providers, NDJSON from Ollama).
- Manual format parsers with no heavy dependencies: RFC822/MIME (`quoted-printable`, `base64`, `=?UTF-8?Q?...?=` headers), CSV (`csv` crate), JSON (`serde_json`), ZIP (`zip` crate, `deflate` feature for WhatsApp exports).
- Designing stateful parsers for fragmented streams (e.g. `ThinkStreamFilter`: a tag can arrive split across two network chunks — you need to buffer until you're sure it's not a half-formed tag).
- Unit testing in Rust (`cargo test`) for parsers and importers — each of the 6 importers and the 3 personality generators has its own test suite.

## 4. Security and cryptography

- Authenticated symmetric encryption: AES-256-GCM (`aes-gcm` crate) to encrypt the entire database file.
- Key derivation from password: Argon2id (`argon2` crate) — understanding memory/time cost parameters and why it's preferable to PBKDF2/bcrypt for this threat model.
- The "encryption at rest" vs. "encryption in use" model: knowing how to articulate the real guarantee (protects a stolen file/lost USB, not a compromised active session) so as not to overpromise in user-facing documentation.
- Safe file handling on Windows: releasing open connections before deleting/replacing a file (SQLite doesn't allow deleting a file with an open handle on that OS).
- The "never send without explicit confirmation" principle applied to a two-step flow (network-free preview → confirmation → actual send) — a security design pattern, not just UX.

## 5. LLM integration

- Ollama API (`/api/chat`, `/api/tags`, `/api/embeddings` or equivalent): chat, listing installed models, generating embeddings, all via a backend proxy to avoid browser CORS.
- OpenAI-style Chat Completions API (and its SSE variant for streaming: `data: {...}` per line, ending in `data: [DONE]`) — needed to support multiple compatible providers (OpenAI, Groq, OpenRouter, own backend) with a single client.
- Prompt engineering for structured extraction tasks with cited evidence (candidate memories, values, decision patterns, tone) — designing prompts that lean on asking for JSON and rejecting invention without textual support.
- Homegrown RAG (retrieval-augmented generation) without a library: manually building the system prompt from profile + memories + semantic search results, and exposing what was used ("Sources used") as an auditability requirement, not an optional feature.
- Filtering "thinking" blocks (`<think>...</think>`) emitted by some reasoning models, both in streaming and non-streaming mode.
- Whisper.cpp via `whisper-rs` for 100% local voice transcription: loading `.bin` (ggml) models, inference, managing model downloads from Hugging Face with a fixed allowlist (never build the download URL from arbitrary user input).

## 6. Semantic search and embeddings

- Generating embeddings via a local model (e.g. `nomic-embed-text`) and storing them serialized in SQLite.
- Hand-implemented cosine similarity (no vector extension) — sufficient and simpler for personal-data volumes; knowing when a dedicated vector database *isn't* needed.
- Relevance criteria with exclusion (top-N candidates, filter by sensitivity classification before keeping the best ones) instead of a blind top-K.

## 7. Parsing personal data export formats

- WhatsApp: `.txt`/`.zip` export (Android and iOS formats differ).
- Gmail Takeout: `.mbox` (RFC822/MIME).
- Twitter/X: `data/tweet.js` (JS with a variable assignment wrapping a JSON array).
- Discord: `messages.csv` per channel/DM.
- Reddit: `comments.csv`/`posts.csv` with type detection by which columns are present.
- General criterion: when an export can only contain the user's own content (Twitter/Discord/Reddit), simplify by marking everything `is_user = true` instead of trying to infer authorship.
- Knowing when it's *not* worth writing a custom parser (e.g. Outlook's `.pst`: proprietary binary format) and documenting a conversion alternative instead of risking silent data corruption.

## 8. Data modeling and migrations

- Designing a normalized SQLite schema for conversational data (`sources` → `conversations` → `people` → `messages`) reusable across multiple heterogeneous sources.
- State tables with an explicit lifecycle (`memories.status`: candidate/confirmed/edited/rejected; `drafts.status`: pending/approved/rejected) instead of loose booleans.
- Duplicate detection via a composite fingerprint (text + timestamp + author) when re-ingesting the same source.
- Awareness of the debt of not having versioned migrations (ad-hoc `ALTER TABLE ... ADD COLUMN` patches) and when it's worth introducing a real system from the start.

## 9. Product and privacy design ("local-first")

- Translating product principles (local-first, auditable, no impersonation, real deletion) into concrete technical decisions — not as marketing disclaimers but as code invariants (e.g. the system prompt of *every* chat mode shares the same rules function).
- Designing irreversible flows with proportional friction (one-click confirmation for deletion by source/contact/date range; an exact phrase to type for a full database reset).
- A quality metrics panel calculated 100% from real local data (embedding coverage, memory confirmation rate as a proxy for hallucination) — without making up numbers or depending on external analytics services.

## 10. Optional backend deployment (Vercel)

- Next.js (Edge runtime) for a thin, authenticated proxy to an external LLM provider.
- Environment variables and how they only apply to new deploys (manual redeploy or via a deploy hook after changing config).
- Simple authentication via admin panel password + shared token for the client app (avoiding distributing the provider's real key with every install).
- Programmatic use of the Vercel API (token + project ID) to persist configuration from a custom UI, given that Vercel doesn't offer persistent storage by default.

## Cross-cutting development tools

- Node.js 20.19+/22.12+ and npm.
- Stable Rust + `cargo`.
- CMake (for dependencies that compile C/C++, e.g. `whisper-rs`).
- Git for version control of the monorepo (frontend + `src-tauri/` + `sidecar/` + `vercel-backend/` as projects with different lifecycles but versioned together).
