import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Settings.css";

interface SettingsForm {
  ollama_base_url: string;
  chat_model: string;
  embedding_model: string;
  local_api_style: string;
  theme: string;
}

interface Props {
  onSaved?: () => void;
}

const STYLE_PRESETS: Record<string, { baseUrl: string; chatModel: string; embeddingModel: string }> = {
  ollama: {
    baseUrl: "http://localhost:11434",
    chatModel: "gemma3:4b",
    embeddingModel: "nomic-embed-text",
  },
  openai: {
    baseUrl: "http://localhost:1234/v1",
    chatModel: "gemma-4-e2b-it",
    embeddingModel: "text-embedding-nomic-embed-text-v1.5",
  },
};

export default function Settings({ onSaved }: Props) {
  const [form, setForm] = useState<SettingsForm>({
    ollama_base_url: "",
    chat_model: "",
    embedding_model: "",
    local_api_style: "ollama",
    theme: "system",
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    invoke<Record<string, string>>("get_settings").then((s) => {
      setForm({
        ollama_base_url: s.ollama_base_url ?? "",
        chat_model: s.chat_model ?? "",
        embedding_model: s.embedding_model ?? "",
        local_api_style: s.local_api_style ?? "ollama",
        theme: s.theme ?? "system",
      });
    });
  }, []);

  function changeStyle(style: string) {
    const preset = STYLE_PRESETS[style];
    setForm((f) => ({
      ...f,
      local_api_style: style,
      ollama_base_url: preset?.baseUrl ?? f.ollama_base_url,
      chat_model: preset?.chatModel ?? f.chat_model,
      embedding_model: preset?.embeddingModel ?? f.embedding_model,
    }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    await Promise.all([
      invoke("update_setting", { key: "ollama_base_url", value: form.ollama_base_url }),
      invoke("update_setting", { key: "chat_model", value: form.chat_model }),
      invoke("update_setting", { key: "embedding_model", value: form.embedding_model }),
      invoke("update_setting", { key: "local_api_style", value: form.local_api_style }),
      invoke("update_setting", { key: "theme", value: form.theme }),
      invoke("update_setting", { key: "onboarding_completed", value: "true" }),
    ]);
    setSaved(true);
    onSaved?.();
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="settings">
      <form onSubmit={save}>
        <label>
          Motor local
          <select value={form.local_api_style} onChange={(e) => changeStyle(e.currentTarget.value)}>
            <option value="ollama">Ollama</option>
            <option value="openai">Compatible con OpenAI (ej. Lemonade Server, LM Studio)</option>
          </select>
        </label>
        <label>
          URL del motor local
          <input
            value={form.ollama_base_url}
            onChange={(e) => setForm((f) => ({ ...f, ollama_base_url: e.currentTarget.value }))}
            placeholder={STYLE_PRESETS[form.local_api_style]?.baseUrl}
          />
        </label>
        <label>
          Modelo de chat
          <input
            value={form.chat_model}
            onChange={(e) => setForm((f) => ({ ...f, chat_model: e.currentTarget.value }))}
            placeholder={STYLE_PRESETS[form.local_api_style]?.chatModel}
          />
        </label>
        <label>
          Modelo de embeddings
          <input
            value={form.embedding_model}
            onChange={(e) => setForm((f) => ({ ...f, embedding_model: e.currentTarget.value }))}
            placeholder={STYLE_PRESETS[form.local_api_style]?.embeddingModel}
          />
        </label>
        <label>
          Tema
          <select value={form.theme} onChange={(e) => setForm((f) => ({ ...f, theme: e.currentTarget.value }))}>
            <option value="system">Sistema</option>
            <option value="light">Claro</option>
            <option value="dark">Oscuro</option>
          </select>
        </label>
        <button type="submit">Guardar</button>
        {saved && <span className="settings-saved">Guardado ✓</span>}
      </form>
    </div>
  );
}
