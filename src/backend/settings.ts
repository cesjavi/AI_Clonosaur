import { dbQuery, dbRun } from "./db";

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_CHAT_MODEL = "gemma3:4b";
export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
/** "ollama" (native Ollama API) or "openai" (OpenAI-compatible local
 * engines, e.g. Lemonade Server) — both run on the user's machine; this
 * isn't hybrid mode, just the API shape the local engine speaks. */
export const DEFAULT_LOCAL_API_STYLE = "ollama";
export const DEFAULT_WHISPER_MODEL = "base";

/** One-off read of a preference, with fallback to the default if it isn't
 * saved yet. */
export async function getSettingFromDb(key: string, defaultValue: string): Promise<string> {
  const rows = await dbQuery("SELECT value FROM app_settings WHERE key = ?", [key]);
  return rows.length > 0 ? (rows[0].value as string) : defaultValue;
}

export async function getSettings(): Promise<Record<string, string>> {
  const rows = await dbQuery("SELECT key, value FROM app_settings");
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.key as string] = row.value as string;
  }

  map.ollama_base_url ??= DEFAULT_OLLAMA_BASE_URL;
  map.chat_model ??= DEFAULT_CHAT_MODEL;
  map.embedding_model ??= DEFAULT_EMBEDDING_MODEL;
  map.local_api_style ??= DEFAULT_LOCAL_API_STYLE;
  map.whisper_model ??= DEFAULT_WHISPER_MODEL;
  map.theme ??= "system";
  map.onboarding_completed ??= "false";

  return map;
}

export async function updateSetting(key: string, value: string): Promise<void> {
  await dbRun(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}
