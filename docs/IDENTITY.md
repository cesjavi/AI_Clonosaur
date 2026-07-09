# How the clone's identity is generated in Clonosaur

This document explains, in concrete terms, **where** the clone's "identity" comes from, **how it's built** step by step, and **what data is used** at each stage — including what leaves your computer and when. It's the technical companion to [PRIVACY.md](PRIVACY.md) (what guarantees the app makes) and [ROADMAP.md](ROADMAP.md) (product vision).

There isn't "one" identity stored in a single place. It's the combination of several independent layers, all in your local SQLite (`clonosaur.db`), that fill in as you use the app. The clone is never more faithful than the quantity and quality of the data you gave it.

**Encryption at rest.** When the app is closed or you lock it manually, the only thing left on disk is `clonosaur.db.enc` — the file encrypted with AES-256-GCM, with the key derived from your master password via Argon2id (`src-tauri/src/encryption.rs`). While the app is open, an unencrypted working copy exists (`clonosaur.db`) because SQLite needs to be able to read/write the file normally — this is the same thing that happens with any app that uses "encryption at rest": it protects a stolen backup or a lost USB drive, not someone with access to your active session. There's no password recovery: if you lose it, the data is unrecoverable (this isn't an accidental limitation, it's the consequence of not storing the password or the key anywhere).

## 1. The identity layers and where they live

| Layer | SQLite table | How it's filled | Manually editable |
|---|---|---|---|
| Guided interview answers | `interview_answers` (fixed `module`) | You answer fixed questions from `interview/questions.json` | Yes, by re-answering |
| Adaptive interview answers | `interview_answers` (`module = 'adaptativa'`) | The local LLM generates follow-up questions based on what you've already answered | Yes |
| Imported messages | `messages`, `conversations`, `people`, `sources` | You import WhatsApp/Gmail/Twitter/Discord/Reddit/generic | Not directly; corrected via feedback or deletion |
| Candidate and confirmed memories | `memories` | The LLM extracts facts/preferences from your messages; you confirm/edit/reject | Yes, before and after confirming |
| Profile traits (manual) | `profile_traits` (`source = 'manual'`) | You write them directly in "Profile" | Yes |
| Values | `profile_traits` (`category = 'valores'`, `source = 'inferred'`) | The LLM analyzes interview + memories + your own messages | Yes |
| Decision patterns | `profile_traits` (`category = 'toma_decisiones'`) | Same as values, with a different focus | Yes |
| Tone by context | `profile_traits` (`category = 'tono_contextual'`) | The LLM groups your messages by conversation and describes the tone of each one | Yes |
| Message embeddings | `embeddings` | Generated on demand, via a local embeddings model (Ollama) | No (regenerated if you delete the message) |
| Attribution feedback | `feedback` | You mark "this is me" / "this isn't me" on imported messages | — |

None of these tables sync to any server. They live entirely in the `clonosaur.db` file that Tauri creates in the app's local data directory.

## 2. The pipeline, step by step

### Step 1 — Import raw data

You upload a file (`.txt`/`.zip` from WhatsApp, `.mbox` from Gmail, `tweet.js` from Twitter/X, `.csv`/`.json` from Discord/Reddit, or a generic `.json`/`.csv`/`.txt`). Each importer (`src-tauri/src/*_import.rs`) runs **entirely on your machine**: it parses the format, separates author/date/text, and stores it in `sources` → `conversations` → `people` → `messages`. It marks `is_user = true` on messages it identifies as yours (by name, by email, or because the exported format only contains your own messages, as with Twitter/Discord/Reddit).

None of this calls an LLM or leaves the local database.

### Step 2 — Tell the app who you are (interview)

The guided interview (`interview/questions.json`) has fixed questions grouped into modules: identity, mental style, communication, relationships, autobiographical memory, clone control. Each answer is saved exactly as you wrote it, without passing through any model.

The adaptive interview (`src-tauri/src/adaptive_interview.rs`) does use a local LLM: it gathers up to 40 previous answers (from both interviews), asks the model for a new follow-up question that isn't repetitive, and saves it. You answer it like any other.

In both interviews you can answer by speaking instead of typing: the 🎤 button records your voice and transcribes it locally with whisper.cpp (`src-tauri/src/transcription.rs`, via `whisper-rs`), without sending audio to any external service. The 🔊 button reads the question aloud using the operating system's own speech synthesis (`speechSynthesis`), also without leaving the machine. Voice transcription requires you to set the path to a Whisper model in "Settings" — it doesn't come bundled.

### Step 3 — Turn messages into structured memory

"Candidate memories" (`src-tauri/src/candidate_memories.rs`) takes a sample of your own messages that don't have an associated memory yet, sends it to the local LLM asking it to extract facts/preferences/traits in JSON format, and saves each one in `memories` with `status = 'candidate'`. **Nothing is confirmed automatically.** You review each one on the screen of the same name: confirm, edit, or reject.

"Detect contradictions" does the same thing but comparing *already confirmed* memories against each other, looking for real changes of opinion over time; the findings also come in as candidate memories (`dinamica` layer) so you review them the same way.

### Step 4 — Generate personality profile from the above

Three generators (`values_model.rs`, `decision_model.rs`, `tone_model.rs`) do the same kind of work with a different focus:

1. They gather relevant existing context: answers from certain interview modules + confirmed memories + a sample of your own messages (or, in the case of tone, your messages grouped by conversation).
2. They ask the local LLM to identify a concrete pattern (a value, a decision pattern, a tone) **citing textual evidence** — the prompt explicitly asks it not to make anything up without support.
3. They save each result as a new row in `profile_traits`, avoiding duplicates by name if one already exists.

All of this remains editable and deletable from "Profile" or from each one's specific screen.

### Step 5 — Semantic search (so the clone "remembers")

"Memory and search" (`src-tauri/src/memory.rs`) generates an embedding (numeric vector) for each message via an embeddings model that runs on Ollama (e.g. `nomic-embed-text`), and saves it in `embeddings`. When something is searched for (manually, or automatically during chat with RAG), cosine similarity is calculated between the question's embedding and all stored ones, entirely in memory, without any external library or service.

## 3. What exactly happens when you talk to the clone

There are three ways to chat, and they use identity differently:

### Simple chat (`ollama_chat`)

Doesn't touch the profile, memories, or messages. It's a direct call to a local Ollama model, but it still carries a minimal system message (`build_minimal_system_message`) with two fixed things: the reminder that the clone is an artificial recreation (not the real person) and, if they exist, the rules from the "Clone Control" interview module. Beyond that, the clone doesn't "know you" in this mode.

### Chat with memory / RAG (`chat_with_memory`, in `chat.rs`)

Before responding:

0. The system prompt always starts with the same fixed reminder: the clone is an artificial recreation, not the real person, and must say so if asked directly. If you answered the "Clone Control" interview module (which topics to avoid, what autonomy you allow), those answers get injected here as rules the model must follow above any other instruction.
1. It reads **all** the `profile_traits` (category, trait, value) and puts them into a "User profile" block.
2. It reads the last 20 `memories` with `status` `confirmed` or `edited` and puts them into a "Confirmed memories" block.
3. It takes your last message, generates an embedding for it, and looks for your own messages that are most semantically similar via `embeddings` (over the top 20 candidates by score, **discarding those classified as `sensitivity = 'sensible'`**, and keeping the best 5 that pass that filter) — it puts them into a "Relevant messages" block.
4. It concatenates all of this as a system prompt, adds your conversation, and sends it to the Ollama chat model.
5. The response comes with "Sources used": exactly which profile/memories/messages were used, visible in a collapsible `<details>` in the UI.

If there's nothing relevant (empty memory, no embeddings generated), the system prompt explicitly asks the model to say so instead of making things up. Sensitive messages aren't completely inaccessible: they still appear if you search for them manually in "Memory" (marked with a warning label), they're just excluded from what's automatically sent to the model.

### Hybrid chat (external provider, `hybrid.rs`)

Same context-building mechanism as local RAG (reuses the same `build_rag_messages` function), but with two important differences:

- **Nothing is sent until you confirm it.** `build_hybrid_preview` assembles the complete message and shows it to you in full on screen, without making any network call. Only when you tap "Confirmar y enviar" is `send_to_external_provider` called, which makes the actual HTTP request to the API of the provider you configured (OpenAI or any compatible service).
- You can enable "Anonimizar contactos": it replaces your contacts' names (from the `people` table, excluding your own) with `[contacto]` before assembling the text to be sent.
- Every confirmed send gets logged in `external_send_log` (provider, model, whether it was anonymized, and the exact text).

The provider's API key is stored in local SQLite (`provider_credentials`) and never uploaded anywhere except in the authentication header of the HTTP call you yourself confirmed.

### Copilot ("write like me")

Same context assembly (profile + memory) as chat with RAG, but the result isn't a chat response — it's a **draft** saved in `drafts` with `status = 'pending'`. The app doesn't send anything on any channel — you copy the text and use it manually, then mark the draft as approved, edited, or rejected. If the recipient contact is marked `excluded` in "Privacy", the draft isn't even generated.

### Persisted sessions and turns

From when "Chat" and "Hybrid chat" are mounted until they're unmounted (you switch screens), they run inside a session (`agent_sessions`) that logs each user and assistant turn in `chat_turns`. This doesn't affect the context the model receives — it's purely so that later, in "Metrics", things like how many sessions you had or how many times the clone said "I don't know" instead of making something up can be measured.

## 4. Summary of what leaves your computer, and when

- **Never**, unless you explicitly enable hybrid mode: your raw data, memories, profile, and imported messages are never uploaded to any server.
- Calls to **Ollama** (`http://localhost:11434`) are local — they don't leave your machine, although technically they're HTTP requests, they go to a process running on `localhost`.
- The **only** real path out to the internet is hybrid mode (`Hybrid chat`), and only after you see the exact text and confirm. It all stays in the auditable log.
- The copilot, the adaptive interview, the candidate memories, and the values/decisions/tone models use exclusively local Ollama — they have no path to external services in the current code.

## 5. How "faithful" the clone is, and how it's measured

"Evaluate fidelity of this conversation" (`fidelity_eval.rs`) takes the clone's responses in the current chat and a sample of your real messages, and asks a "judge" LLM to score from 0 to 100 how similar the style is (not the content). It's read-only — it doesn't persist anything or feed back into any other layer automatically. If the score is low, the levers to improve it are the ones from the previous sections: more interview answered, more memories confirmed, more messages imported, better embedding quality.

The "Metrics" screen (`metrics.rs`) complements this with aggregate signals calculated directly from the local database: embedding coverage, memory confirmation rate (a proxy for how much of what the LLM infers ends up being correct according to you), attribution feedback, copilot drafts by status, and interview progress. It's honest about its limits: it doesn't calculate "corrections per chat session" or "ability to say I don't know" because chat conversations aren't saved in any table — they live only in React state while the screen is open.

## 6. Identity safeguards (what prevents the clone from impersonating the real person)

- The system prompt of **all** chat modes and the copilot always includes a fixed instruction: the clone is an artificial recreation generated locally, not the real person, and must say so if asked directly.
- If you completed the "Clone Control" interview module, those answers (topics to avoid, allowed level of autonomy) are read from `interview_answers` and injected as mandatory rules in the same prompt — previously they were saved but never used anywhere.
- The copilot never sends anything on any channel; it always requires you to copy the draft manually and approve it.
- Messages classified as sensitive stay out of the chat's automatic context (see section 3).
