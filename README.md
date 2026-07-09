# Clonosaur

A local-first desktop app (Tauri + React + TypeScript + Rust) for creating a
personal agent based on your way of writing, remembering, and deciding. See
[docs/ROADMAP.md](docs/ROADMAP.md) for the product vision and
[docs/PLAN_TECNICO.md](docs/PLAN_TECNICO.md) for the phase-by-phase build order.

Your raw data (imported messages, interview, memories, profile) lives
entirely in a local SQLite database (`clonosaur.db`) and never leaves your
machine unless you explicitly enable hybrid mode (see
[docs/PRIVACY.md](docs/PRIVACY.md)).

## Current status

| Phase | Content | Status |
|---|---|---|
| 0 — Scaffold | Tauri + React + TS app that opens | Done |
| 1 — Schema and persistence | Local SQLite, guided interview, manually editable profile | Done |
| 2 — Memory and search | Embeddings via Ollama (`nomic-embed-text`), cosine similarity search, attribution feedback | Done |
| 3 — More local sources | WhatsApp, Gmail Takeout, Twitter/X, Discord, Reddit, and generic importers; duplicate detection; contact classification | Done |
| 4 — Advanced personality | Candidate memories, values/decisions/tone models, contradiction detection | Done |
| 5 — Chat and hybrid mode | Local chat, RAG, streaming, external provider with mandatory preview | Done |
| 6 — Copilot and safeguards | "Write like me", sensitivity, metrics, selective deletion | Partial (encryption at rest missing) |
| 7 — Voice and startup UX | Local transcription, splash/onboarding, centralized settings | Partial (voice missing) |

**You can already talk to your clone.** The app lets you import your data,
answer the interview, edit your profile, semantically search your memory,
generate embeddings, review candidate memories extracted by the LLM (with
cited evidence), detect contradictions over time, generate
values/decision patterns/tone by context, chat with the clone in three
modes (simple, with RAG memory with streaming and visible "sources used", and
hybrid with mandatory preview before any send), ask the
copilot to draft "as you" (it never sends anything on its own), see
quality metrics calculated in real time, and delete data by source,
contact, or date range. Messages are classified by sensitivity
(keyword heuristic) when imported, and those are automatically excluded
from the context the model receives.

There's a Settings screen (Ollama URL, default chat/embeddings models,
theme) that's been centralized since day one of the project — none of this
is hardcoded across several files. The app starts with a brief splash; the
first time you save Settings, the navigation collapses to "focused
mode" (only Chat, everything else behind "Advanced options").

What's missing: encryption at rest (Phase 6, deliberately postponed due to
its scope — it touches nearly the whole backend), and local voice
transcription with whisper.cpp (Phase 7, postponed because it requires a
delicate native C++ build on Windows).

## Requirements

- Node.js 20.19+ / 22.12+ and npm.
- Stable Rust + Cargo.
- [Ollama](https://ollama.com) running on `localhost:11434`, with at least:
  - `nomic-embed-text` (embeddings/semantic search).
  - A chat model (e.g. `gemma3:4b` or similar) for the Phase 4
    personality generators.

## Development

```sh
npm install
npm run tauri dev
```

The local database is created in the app's data directory (`clonosaur.db`),
managed automatically by Tauri — no manual configuration required.

## Repo structure

```text
src/                  React + TypeScript frontend (one screen per file)
src-tauri/
  src/                Rust backend: one module per area (db, interview,
                       profile, memory, feedback, importers, etc.)
  db/schema.sql        Core SQLite schema, applied idempotently
docs/                  Product documentation and technical plan
vercel-backend/        Optional Vercel proxy for hybrid mode (see
                       docs/VERCEL_GROQ_SETUP.md)
```

## Privacy

Local-first by default: all parsing, indexing, and analysis runs on your
machine. No raw data is uploaded to any server unless you enable hybrid
mode and explicitly confirm each send. See
[docs/PRIVACY.md](docs/PRIVACY.md) for the full detail of guarantees.
