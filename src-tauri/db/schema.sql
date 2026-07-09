-- Clonosaur - core schema (Phase 1) + memory and semantic search (Phase 2)
-- Dependency order: sources -> conversations -> people -> messages -> conversation_participants
-- interview_answers and profile_traits are independent of the import pipeline.
-- All statements are idempotent (CREATE TABLE IF NOT EXISTS) so they can be applied
-- on every app startup without a versioned migration system (see PLAN_TECNICO.md).

CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL, -- whatsapp | gmail | twitter | discord | reddit | generic
    file_name TEXT,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_user INTEGER NOT NULL DEFAULT 0, -- 1 if this person is the clone's owner
    relationship TEXT, -- manual classification: familia | pareja | amigo | trabajo | conocido | otro
    excluded INTEGER NOT NULL DEFAULT 0, -- 1: excluded from the clone's memory (RAG, copilot)
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id),
    title TEXT,
    external_id TEXT, -- id/name of the conversation in the original format, if present
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_participants (
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    person_id TEXT NOT NULL REFERENCES people(id),
    PRIMARY KEY (conversation_id, person_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    source_id TEXT NOT NULL REFERENCES sources(id),
    person_id TEXT REFERENCES people(id), -- author; NULL if it couldn't be identified
    is_user INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    metadata TEXT, -- Free-form JSON per source
    sensitivity TEXT, -- 'sensible' | NULL; Phase 6 heuristic, the RAG chat already filters on this
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_person ON messages(person_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

CREATE TABLE IF NOT EXISTS interview_answers (
    id TEXT PRIMARY KEY,
    module TEXT NOT NULL, -- identidad | estilo_mental | comunicacion | relaciones | memoria_autobiografica | control_del_clon | adaptativa
    question_id TEXT NOT NULL,
    question_text TEXT NOT NULL,
    answer TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (module, question_id)
);

-- Generic table reusable by all future personality generators
-- (values, decision patterns, tone), instead of one table per generator.
CREATE TABLE IF NOT EXISTS profile_traits (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL, -- e.g. 'valores', 'toma_decisiones', 'tono_contextual', or free-form for manual traits
    trait TEXT NOT NULL,
    value TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual', -- manual | inferred
    evidence TEXT, -- textual citation that supports an inferred trait (auditability); NULL for manual traits
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_traits_category ON profile_traits(category);

-- Serialized vector (JSON of floats) per message. Without a vector extension:
-- cosine similarity is computed in memory, sufficient for personal data volumes.
CREATE TABLE IF NOT EXISTS embeddings (
    message_id TEXT PRIMARY KEY REFERENCES messages(id),
    model TEXT NOT NULL,
    vector TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Structured memory. Designed to receive entries from more than one source:
-- candidate memories extracted by the LLM (Phase 4) and contradiction detection (Phase 4),
-- plus the ones loaded by hand.
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    layer TEXT NOT NULL, -- perfil_estable | autobiografica | preferencias | estilo_linguistico | reglas_limites | dinamica
    status TEXT NOT NULL DEFAULT 'candidate', -- candidate | confirmed | edited | rejected
    content TEXT NOT NULL,
    source_message_id TEXT REFERENCES messages(id),
    metadata TEXT, -- Free-form JSON (e.g. cited evidence)
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);

-- Correction of author attribution on an already imported message
-- ("this is me" / "this is not me"), with an auditable history.
CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id),
    is_user INTEGER NOT NULL, -- corrected value: 1 = belongs to the user, 0 = it doesn't
    created_at TEXT NOT NULL
);

-- One session per mount of the Chat screen (or Hybrid chat); doesn't affect
-- the context the model receives, it's purely for future metrics.
CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL, -- simple | rag | hybrid
    started_at TEXT NOT NULL,
    ended_at TEXT
);

CREATE TABLE IF NOT EXISTS chat_turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id),
    role TEXT NOT NULL, -- user | assistant
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_turns_session ON chat_turns(session_id);

-- External provider credentials for hybrid mode. Stored in local SQLite
-- without field-level encryption (full-file database encryption is a
-- Phase 6 guarantee, not yet implemented).
CREATE TABLE IF NOT EXISTS provider_credentials (
    provider TEXT PRIMARY KEY, -- e.g. 'groq', 'openai', 'custom'
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Audit of every confirmed send to an external provider: what was sent,
-- to whom, and whether it was anonymized. See "Privacidad" -> "Historial de envíos".
CREATE TABLE IF NOT EXISTS external_send_log (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    anonymized INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL, -- the exact text sent, as shown to the user before confirming
    created_at TEXT NOT NULL
);

-- Copilot drafts ("write as me"). Never sent on their own: the user
-- copies the text by hand and then marks the draft as approved,
-- edited, or rejected.
CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    contact_person_id TEXT REFERENCES people(id),
    contact_name TEXT,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | edited | rejected
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);

-- Centralized configuration: Ollama URL, default models, theme,
-- onboarding progress. Generic key/value instead of fixed columns so
-- there's no need to migrate the schema every time a new preference is added.
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
