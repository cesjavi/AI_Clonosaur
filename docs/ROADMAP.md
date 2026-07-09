# Roadmap: Clonosaur

## Vision

Clonosaur is a local-first app for creating a personal agent based on the way a person thinks, writes, remembers, and decides. The goal is not to "copy a mind" literally, but to build a private virtual clone that represents the user's communication style, autobiographical memory, preferences, values, and reasoning patterns.

The product's central promise:

> Your raw data never leaves your computer. All gathering, parsing, cleaning, indexing, and initial analysis happens locally. Any external sending requires explicit approval and shows exactly what will be sent.

## Product Principles

- Local-first by default.
- The user can only create their own clone, unless another person gives verifiable consent.
- Raw data from conversations, emails, and personal files is not uploaded to servers.
- The user can review, edit, exclude, and delete any memory.
- The agent must recognize uncertainty and say "I don't know" when it lacks evidence.
- The clone must not impersonate a real human being to third parties.
- The app must clearly separate what the user said from what other people said.
- Memory must be auditable: the user must be able to see why the agent believes something.

## Initial Use Cases

1. Private chat with your virtual clone.
2. Conversational personal memory.
3. Response simulator: "how would I respond?".
4. Exploration of personality and mental patterns.
5. Writing assistant that keeps your tone.

Use cases to avoid in the MVP:

- Automatic sending of messages to third parties.
- Identity impersonation.
- Clones of other people without consent.
- Autonomous agent with broad permissions over email or messaging.

## Local-First Architecture

### Desktop App

Recommended options:

- Tauri + React + TypeScript.
- Electron + React + TypeScript.
- Native app if performance is prioritized from day one.

Initial recommendation: Tauri, because it reduces footprint, allows good local access, and has a reasonable model for a private desktop app.

### Local Processing

Components:

- Local parser per source.
- Message normalizer.
- Local SQLite database.
- Local encryption.
- Local embeddings engine.
- Local semantic search.
- Guided interview.
- Profile generator.
- Chat engine with local LLM or hybrid option.

### Storage

Recommended:

- SQLite for structured data.
- SQLCipher or file-level encryption for privacy.
- sqlite-vec, local LanceDB, local Chroma, or local Qdrant for vector search.
- Encrypted local folder for imported files.

### Models

Private mode:

- Local LLM via Ollama, llama.cpp, or LM Studio.
- Local embeddings with models like `nomic-embed-text`, `bge`, or `e5`.

Optional hybrid mode:

- Memory and raw data remain local.
- The user manually approves each external send.
- The app shows the exact fragment that will be sent.
- Anonymized or summarized prompts are allowed when possible.

## Data Sources

### MVP

- WhatsApp export `.txt` or `.zip`.
- `.txt`, `.json`, `.csv` files.
- Guided interview with the user.

### Later Phase

- Gmail Takeout `.mbox`.
- Outlook `.pst` or `.mbox`.
- Discord data package.
- Reddit data export.
- Twitter/X archive.
- Microsoft Teams export.

### Direct Integrations

API integrations must come after manual imports, because they add legal, technical, and permission complexity. For the initial product it's better to prioritize files exported by the user.

## Common Data Model

All imported messages should be normalized to a common structure:

```json
{
  "id": "msg_123",
  "source": "whatsapp",
  "conversation_id": "conv_456",
  "timestamp": "2026-01-10T12:30:00",
  "author": "Cesar",
  "text": "original message",
  "is_user": true,
  "participants": ["Cesar", "Contact"],
  "metadata": {}
}
```

Main entities:

- `sources`: imported sources.
- `conversations`: conversations or threads.
- `messages`: normalized messages.
- `people`: detected contacts.
- `memories`: structured memories.
- `profile_traits`: style, values, and personality traits.
- `interview_answers`: interview answers.
- `feedback`: user corrections.
- `agent_sessions`: chat sessions.

## Local Ingestion Pipeline

1. Import local file.
2. Detect source and format.
3. Parse messages.
4. Identify the user's author.
5. Separate own messages from third-party messages.
6. Normalize timestamps.
7. Detect duplicates.
8. Classify sensitivity.
9. Save to encrypted SQLite.
10. Generate local embeddings.
11. Extract topics, relationships, and patterns.
12. Create candidate memories.
13. Ask the user for confirmation or correction.

## User Interview

The interview complements what conversations don't reveal.

Modules:

### Identity

- How do you describe yourself?
- What parts of you do others tend to misinterpret?
- What values are non-negotiable for you?
- What things do you feel define you?

### Mental Style

- Do you think more in images, words, structures, sensations, or scenarios?
- Do you decide quickly or process a lot?
- What makes you change your mind?
- How do you react under stress?

### Communication

- Are you direct, diplomatic, ironic, affectionate, or analytical?
- What kind of humor do you use?
- What phrases are very "you"?
- What things would you never say?

### Relationships

- Who are the important people in your life?
- How does your way of speaking change depending on context?
- What boundaries should the agent respect?

### Autobiographical Memory

- Formative moments.
- Important decisions.
- Fears.
- Ambitions.
- Personal contradictions.
- Changes of opinion over time.

### Clone Control

- Can it speak as you?
- Can it give advice on your behalf?
- Can it draft responses for others?
- What topics should it avoid?
- What level of autonomy do you allow?

## The Clone's Memory

Recommended layers:

### Stable Profile

Personality traits, values, general style, persistent preferences.

### Autobiographical Memory

Events, relationships, places, life stages, important decisions.

### Preferences

Likes, dislikes, habits, products, topics, activities, ways of working.

### Linguistic Style

Vocabulary, recurring phrases, message length, humor, formality, rhythm.

### Rules And Limits

Permissions, forbidden topics, excluded contacts, allowed behavior.

### Dynamic Memory

Information learned after the clone is created, always editable by the user.

## Roadmap By Phases

### Phase 0: Product Foundation

Estimated duration: 2 to 4 weeks.

Goals:

- Define the main use case.
- Choose the desktop stack.
- Define the privacy contract.
- Design the common data model.
- Prototype the interview.
- Define threats and abuses to prevent.

Deliverables:

- Product document.
- Initial database schema.
- Interview prototype.
- Initial local-first privacy policy.

### Phase 1: Local MVP

Estimated duration: 4 to 8 weeks.

Goals:

- Create desktop app.
- Import WhatsApp export.
- Parse messages locally.
- Save data to SQLite.
- Identify the user's messages.
- Create basic interview.
- Generate editable profile.
- Private chat with local LLM.

Deliverables:

- WhatsApp importer.
- Local database.
- Interview screen.
- Profile screen.
- First chat with the clone.

### Phase 2: Memory And Search

Estimated duration: 4 to 8 weeks.

Goals:

- Add local embeddings.
- Implement local semantic search.
- Create candidate memories.
- Show sources used by the agent.
- Add feedback: "this is me" / "this isn't me".
- Allow deletion by source, contact, or date.

Deliverables:

- Local vector search.
- Structured memory.
- Memory review panel.
- Feedback loop.

### Phase 3: More Local Sources

Estimated duration: 2 to 4 months.

Goals:

- Gmail Takeout `.mbox`.
- Discord data package.
- Reddit export.
- Twitter/X archive.
- Outlook export.
- Generic text import.

Deliverables:

- Per-source importers.
- More robust normalizer.
- Duplicate detection.
- Contact and conversation classification.

### Phase 4: Advanced Personality

Estimated duration: 3 to 6 months.

Goals:

- Adaptive interview.
- Values model.
- Decision-making model.
- Tone detection by context.
- Detection of contradictions and changes over time.
- Clone fidelity evaluation.

Deliverables:

- Deep personality profile.
- Communication style engine.
- Evaluation system.
- Continuous feedback tuning.

### Phase 5: Optional Hybrid Mode

Estimated duration: 2 to 4 months.

Goals:

- Allow optional use of external models.
- Show exact preview of data sent.
- Add local anonymization.
- Keep raw data always local.
- Create controls per task and provider.

Deliverables:

- Local/hybrid mode selector.
- Per-send consent.
- Prompt preview.
- Auditable logs.

### Phase 6: Personal Copilot

Estimated duration: 6 to 12 months.

Goals:

- Suggest replies for emails and messages.
- Draft in the user's tone.
- Keep human approval required before sending.
- Add permissions per contact and context.
- Integrate calendar/documents only if the user enables it.

Deliverables:

- "Write like me" mode.
- Approvable drafts.
- Granular permissions.
- Action history.

## Recommended MVP

The first usable product should include:

1. Local desktop app.
2. WhatsApp importer.
3. Guided interview.
4. Editable profile.
5. Encrypted local memory.
6. Chat with local LLM via Ollama.
7. Feedback per response.
8. Panel to delete data.
9. Visible sources for each response.

Do not include in the first MVP:

- WhatsApp API.
- Automatic sending to third parties.
- Cloud sync.
- Clones of third parties.
- Complex enterprise integrations.

## Main Risks

### Technical Risk

The agent can invent memories, exaggerate traits, or confuse third-party messages with the user's own thoughts.

Mitigation:

- Separate authors.
- Show sources.
- Use structured memory.
- Allow user correction.
- Make the agent state uncertainty.

### Privacy Risk

Conversations contain information about third parties.

Mitigation:

- Local processing.
- Per-contact exclusion.
- Selective deletion.
- Sensitivity classification.
- Clear policy of not uploading raw data.

### Impersonation Risk

A clone could be used to deceive other people.

Mitigation:

- Identify the agent as artificial.
- Do not allow clones of third parties without consent.
- Require human approval before sending messages.
- Add per-context limits.

### Quality Risk

The clone can end up sounding like a caricature.

Mitigation:

- Continuous feedback.
- In-depth interview.
- Style evaluation.
- Editable memory.
- Differentiate casual, work, family, and intimate tone.

## Quality Metrics

- Style similarity as perceived by the user.
- Accuracy of memories.
- Autobiographical hallucination rate.
- Number of corrections per session.
- Ability to say "I don't know".
- Respect for configured limits.
- User satisfaction with generated responses.

## Initial Backlog

- Create base app.
- Create SQLite database.
- Design initial schema.
- WhatsApp parser.
- File importer.
- Imported sources screen.
- Interview screen.
- Profile generator.
- Ollama integration.
- Local embeddings.
- Semantic search.
- Editable memory.
- Chat with sources.
- Feedback buttons.
- Privacy panel.
- Full deletion.

## Suggested Initial Stack

- Desktop: Tauri.
- Frontend: React + TypeScript.
- UI: Tailwind or CSS modules, depending on preference.
- Local backend: Tauri Rust commands or a Node/Python sidecar.
- DB: SQLite.
- Encryption: SQLCipher or file-level encryption.
- Vector search: sqlite-vec or local LanceDB.
- Local LLM: Ollama.
- Embeddings: `nomic-embed-text` or `bge`.

## Next Decision

The first important technical decision is to choose between:

1. Tauri with a Rust core.
2. Tauri with a Node/Python sidecar.
3. Electron with Node.

To move fast, the most practical option is usually Tauri + React + a Node/Python sidecar for parsers and initial experimentation. Once the pipeline is clear, critical parts can be moved to Rust.
