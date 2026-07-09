# Technical plan: Clonosaur Web

This document is the counterpart to [PLAN_TECNICO.md](PLAN_TECNICO.md) for a
web version of Clonosaur. Same format: phases in dependency order, what each
one builds, and the "done" criterion. It doesn't repeat the product vision
([ROADMAP.md](ROADMAP.md)) or the privacy guarantees
([PRIVACY.md](PRIVACY.md)) — it inherits them, with one adjustment: the
principle "your raw data never leaves your computer" becomes "...never leaves
your computer unencrypted", to allow remote access without sacrificing the
local-first trust model.

## 1. What changes and what doesn't

The desktop version (Tauri) and the web version share almost all the frontend
(React + TypeScript, one component per screen) and 100% of the data model
(`db/schema.sql`). What changes is everything that today lives in
`src-tauri/src/*.rs`: each Tauri command is ported to an equivalent
TypeScript function, with the same signature and the same logic.

| Piece | Desktop (today) | Web |
|---|---|---|
| Database | Native SQLite (`rusqlite`, file on disk) | SQLite compiled to WASM (`wa-sqlite`), persisted in OPFS |
| Backend commands | Rust functions (`#[tauri::command]`) | TypeScript functions, same name/signature |
| File dialog | `tauri-plugin-dialog` | `<input type="file">` + `FileReader` (simpler) |
| HTTP calls | `reqwest` | Native browser `fetch` |
| Chat streaming | `reqwest` stream + `futures-util` | `fetch` + `ReadableStream`/`TextDecoder` |
| Encryption at rest | `aes-gcm` + `argon2` (Rust) | Web Crypto API (`crypto.subtle`) + `hash-wasm` for Argon2id |
| Parsers (zip/mbox/csv) | `zip`, manual MIME parser, `csv` | `fflate` (zip), same MIME parser ported to TS, manual CSV parser (already simple) |
| Voice | `whisper-rs` (native) | `whisper.wasm` or the browser's `SpeechRecognition` (see risks) |
| Remote access | Doesn't exist | End-to-end encrypted sync (optional) |

**Underlying architecture decision:** port the Rust logic to TypeScript,
rather than compiling the Rust crate to WASM with `wasm-bindgen`. Each Tauri
command is already an isolated function (SQL + string parsing + one HTTP
call), so the port is mechanical. Compiling to WASM would save rewriting but
adds real friction: `rusqlite` is native, and `whisper-rs`/parts of
`reqwest`+`tokio` don't compile cleanly to `wasm32-unknown-unknown`. For this
project's size, porting is faster than fighting that toolchain.

## 2. Phase W0 — Web scaffold

**Goal:** the same frontend as today, served as a static site without Tauri.

- New `vite.config.ts` without the Tauri plugin; `npm run dev` serves a
  normal site in the browser.
- Replace every `import { invoke } from "@tauri-apps/api/core"` with an
  import to a local `src/backend/*.ts` module that exposes the same
  signatures (same command name, same parameters) so the React components
  don't change.
- `Import.tsx`: replace `@tauri-apps/plugin-dialog` with a hidden
  `<input type="file">` + `FileReader`.

**Done when:** the app opens in the browser and navigates between screens
(empty, no data yet).

## 3. Phase W1 — Storage: SQLite in WASM + OPFS

**Goal:** the same `schema.sql` running in the browser, persistent
across sessions.

- `wa-sqlite` (not `sql.js`): has a VFS on top of OPFS that gives real
  file persistence, not just IndexedDB — faster and closer to the native
  SQLite you already know.
- Run it in a dedicated Web Worker (SQLite isn't thread-safe, and this
  avoids blocking the UI on long queries — e.g. semantic search across all
  embeddings).
- `src/backend/db.ts`: opens (or creates) the database in OPFS, applies
  `schema.sql` idempotently (same `CREATE TABLE IF NOT EXISTS` pattern as
  today).
- A simple Worker↔UI message-passing layer (or `comlink` to avoid writing
  the protocol by hand) so `src/backend/*.ts` talks to the worker the same
  way it talks to `state.0.lock()` today.

**Done when:** you can insert and read test data in any table of the schema,
and it persists after reloading the page.

## 4. Phase W2 — Porting the commands (same order as PLAN_TECNICO.md)

**Goal:** port each Rust module to its TypeScript equivalent, without
changing logic or signature.

Suggested order (reuses patterns from the previous one, just like the
original plan):

1. `interview.ts`, `profile.ts` — simple CRUD, the most direct port.
2. `sources.ts`, `import_common.ts` + the 6 importers — Gmail's MIME
   parser and WhatsApp's are already pure string-parsing with no heavy
   dependencies, they port almost literally. `zip` (WhatsApp) → `fflate`.
   `csv` (Discord/Reddit) → manual parsing (it was already manual in Rust).
3. `sensitivity.ts` — keyword heuristic, trivial port.
4. `memory.ts` — `ollama_embed` moves from `reqwest` to `fetch`; cosine
   similarity is pure arithmetic, ports unchanged.
5. `candidate_memories.ts`, `contradiction_detector.ts`, `values_model.ts`,
   `decision_model.ts`, `tone_model.ts`, `llm.ts` — same prompts, same
   tolerant JSON parsing (`value_to_text`).
6. `chat.ts`, `sessions.ts` — streaming via `fetch` + `ReadableStream`; the
   `ThinkStreamFilter` is pure buffer logic, ports unchanged.
7. `hybrid.ts`, `copilot.ts`, `metrics.ts`, `deletion.ts` — no surprises.

**Done when:** the TS functions pass the same cases already manually tested
on the desktop version (WhatsApp import with dedupe, RAG citing sources,
candidate memories with evidence, etc.).

## 5. Phase W3 — Ollama from the browser

**Goal:** get local chat working the same way as on desktop.

- **Real CORS blocker:** a browser can't hit
  `http://localhost:11434` unless Ollama has `OLLAMA_ORIGINS` configured
  to include the site's origin (or `*` for development).
  Document this explicitly in the README — it's the same problem Open
  WebUI and similar projects have, it's not specific to Clonosaur.
- Without this, "Simple chat" and "Chat with memory" will never be able to
  connect, so it's worth detecting the connection failure and showing
  concrete instructions in the UI (not just a generic network error).

**Done when:** simple chat and chat with RAG respond against a local Ollama
with `OLLAMA_ORIGINS` configured.

## 6. Phase W4 — Encryption at rest (simpler than in Tauri)

**Goal:** the database encrypted in OPFS, with a master password.

- `crypto.subtle.encrypt`/`decrypt` with AES-256-GCM — native to the
  browser, no external crate.
- Key derivation: Argon2id via `hash-wasm` (small WASM, doesn't drag in a
  heavy runtime).
- Same pattern as the original plan: the file in OPFS stays encrypted
  at all times; when unlocking, it's decrypted into an in-memory buffer
  that `wa-sqlite` uses as a working copy; "Lock now" re-encrypts and
  discards the buffer. No password recovery, documented the same as today.

**Done when:** the database only exists encrypted on disk (OPFS) outside
of an unlocked session, and "Lock now" works without having to close the
tab.

## 7. Phase W5 — Remote access: end-to-end encrypted sync

**Goal:** be able to use the same clone from another device, without any
server seeing plaintext data.

- The client encrypts the whole database file (or a delta) with the same
  key derived from the master password, and uploads the encrypted blob to
  simple storage — it can be as small as the `vercel-backend/` that
  already exists for hybrid mode, extended with two routes: `PUT /sync`
  (upload blob) and `GET /sync` (download blob). The server never has the
  key: it only moves bytes.
- **Deliberate decision for the MVP:** one active device at a time
  ("last one to sync wins"), no concurrent-edit conflict resolution.
  That's a separate project if it's needed later.
- Simple login (backend username + password, not the encryption master
  password — they're two distinct secrets on purpose) only to know which
  blob to upload/download, not to authorize access to the data itself.

**Done when:** you can encrypt+upload the database from one device, and
download+decrypt it from another, with the master password as the only
secret that unlocks the data.

## 8. Phase W6 — PWA (installable, works offline)

**Goal:** make it feel like an app, not a tab.

- `manifest.json` + service worker (Vite PWA plugin) to install and cache
  the static bundle.
- Chat with Ollama and hybrid mode need network access just like today
  (there's no way to make them work offline); everything else (interview,
  profile, importing, already-generated candidate memories, metrics) does
  work without network once cached.

**Done when:** the browser offers "install app", and opening it without
a connection shows the UI and the already-saved data (even if chat doesn't
respond).

## 9. Phase W7 (optional) — Voice

**Goal:** keep transcription and speech synthesis.

- Synthesis (🔊): `speechSynthesis` is already a native web API — no changes.
- Transcription (🎤): two options with different trade-offs:
  1. `whisper.wasm` (official whisper.cpp build to WASM): keeps the
     "never leaves your machine" guarantee, but it's several MB of bundle
     weight and slower than native.
  2. Browser `SpeechRecognition`: lightweight and fast, but in Chrome the
     audio is sent to Google's servers for processing — **breaks the
     local privacy guarantee** if used by default. Only offer it as an
     explicit opt-in, never as a default, and document it with the same
     clarity as `IDENTITY.md` documents encryption at rest today.

**Done when:** recording and transcribing works with at least one of the
two options, with the chosen one (and its privacy trade-off) visible in
the UI.

## Summary order

```text
Phase W0 (scaffold without Tauri)
  └─ Phase W1 (SQLite WASM + OPFS)
       └─ Phase W2 (port Rust commands → TS)
            ├─ Phase W3 (Ollama + CORS)
            ├─ Phase W4 (encryption at rest)
            │    └─ Phase W5 (encrypted sync, remote access)
            ├─ Phase W6 (PWA)
            └─ Phase W7 (voice, optional)
```

## Deliberate decisions (and the alternatives ruled out)

- **Porting to TS instead of compiling Rust to WASM:** see section 1. Less
  elegant on paper, faster in practice for this project's size.
- **`wa-sqlite` instead of `sql.js`:** `sql.js` doesn't have real file
  persistence (it keeps everything in memory and you have to serialize to
  IndexedDB by hand); `wa-sqlite` with an OPFS VFS behaves much closer to
  native SQLite.
- **End-to-end encrypted sync instead of a backend with access to the data:**
  the obvious alternative ("upload the database to your own server as-is")
  is simpler to implement but breaks the central product principle. The
  extra cost of client-side encryption is low with Web Crypto; it's not
  worth skipping.
- **One active device at a time in sync (Phase W5):** resolving merges of
  concurrent edits across devices is a serious problem (CRDTs or
  similar). Postponing it avoids months of work for a use case
  (simultaneous editing from two devices) that's uncommon in a single-user
  product.
- **`SpeechRecognition` never as default:** documented above. Only offer
  it opt-in if `whisper.wasm` turns out too heavy for the use case.
