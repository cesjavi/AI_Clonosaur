import { useEffect, useRef, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { invoke, isTauri } from "./backend/invoke";
import "./Settings.css";

// Persists across navigating away from Settings so a user cannot start two
// concurrent downloads of the same Whisper model.
const activeDownloads = new Set<string>();

interface SettingsForm {
  ollama_base_url: string;
  chat_model: string;
  embedding_model: string;
  local_api_style: string;
  whisper_model: string;
  theme: string;
}

interface Props {
  onSaved?: () => void;
}

interface WhisperModelStatus {
  model: string;
  installed: boolean;
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
    whisper_model: "base",
    theme: "system",
  });
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [modelStatus, setModelStatus] = useState<WhisperModelStatus[]>([]);
  const [downloading, setDownloading] = useState<Set<string>>(() => new Set(activeDownloads));
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const [updateState, setUpdateState] = useState<
    "idle" | "checking" | "up-to-date" | "available" | "installing" | "error"
  >("idle");
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingUpdateRef = useRef<Update | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    invoke<Record<string, string>>("get_settings")
      .then((s) => {
        if (!mountedRef.current) return;
        setForm({
          ollama_base_url: s.ollama_base_url ?? "",
          chat_model: s.chat_model ?? "",
          embedding_model: s.embedding_model ?? "",
          local_api_style: s.local_api_style ?? "ollama",
          whisper_model: s.whisper_model ?? "base",
          theme: s.theme ?? "system",
        });
      })
      .catch((e) => {
        if (mountedRef.current) setSaveError(String(e));
      });
    refreshModelStatus();
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      pendingUpdateRef.current?.close().catch(() => { });
      pendingUpdateRef.current = null;
    };
  }, []);

  function refreshModelStatus() {
    invoke<WhisperModelStatus[]>("list_whisper_models")
      .then((list) => {
        if (mountedRef.current) setModelStatus(list);
      })
      .catch((e) => {
        if (mountedRef.current) setDownloadError(String(e));
      });
  }

  async function checkUpdates() {
    setUpdateState("checking");
    setUpdateError(null);
    try {
      const update = await checkForUpdate();
      pendingUpdateRef.current?.close().catch(() => { });
      pendingUpdateRef.current = update;
      if (!mountedRef.current) {
        update?.close().catch(() => { });
        return;
      }
      if (update) {
        setPendingUpdate(update);
        setUpdateState("available");
      } else {
        setPendingUpdate(null);
        setUpdateState("up-to-date");
      }
    } catch (e) {
      if (mountedRef.current) {
        setUpdateError(String(e));
        setUpdateState("error");
      }
    }
  }

  async function installUpdate() {
    if (!pendingUpdate) return;
    setUpdateState("installing");
    setUpdateError(null);
    try {
      await pendingUpdate.downloadAndInstall();
      await relaunch();
    } catch (e) {
      if (mountedRef.current) {
        setUpdateError(String(e));
        setUpdateState("error");
      }
    }
  }

  async function downloadModel(model: string) {
    if (activeDownloads.has(model)) return;
    activeDownloads.add(model);
    setDownloading(new Set(activeDownloads));
    setDownloadError(null);
    try {
      await invoke("download_whisper_model", { model });
      refreshModelStatus();
    } catch (e) {
      if (mountedRef.current) setDownloadError(String(e));
    } finally {
      activeDownloads.delete(model);
      if (mountedRef.current) setDownloading(new Set(activeDownloads));
    }
  }

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
    setSaveError(null);
    try {
      await Promise.all([
        invoke("update_setting", { key: "ollama_base_url", value: form.ollama_base_url }),
        invoke("update_setting", { key: "chat_model", value: form.chat_model }),
        invoke("update_setting", { key: "embedding_model", value: form.embedding_model }),
        invoke("update_setting", { key: "local_api_style", value: form.local_api_style }),
        invoke("update_setting", { key: "whisper_model", value: form.whisper_model }),
        invoke("update_setting", { key: "theme", value: form.theme }),
        invoke("update_setting", { key: "onboarding_completed", value: "true" }),
      ]);
      if (!mountedRef.current) return;
      setSaved(true);
      onSaved?.();
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        setSaved(false);
      }, 2000);
    } catch (err) {
      if (mountedRef.current) setSaveError(String(err));
    }
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
            onChange={(e) => {
              const ollama_base_url = e.currentTarget.value;
              setForm((f) => ({ ...f, ollama_base_url }));
            }}
            placeholder={STYLE_PRESETS[form.local_api_style]?.baseUrl}
          />
        </label>
        <label>
          Modelo de chat
          <input
            value={form.chat_model}
            onChange={(e) => {
              const chat_model = e.currentTarget.value;
              setForm((f) => ({ ...f, chat_model }));
            }}
            placeholder={STYLE_PRESETS[form.local_api_style]?.chatModel}
          />
        </label>
        <label>
          Modelo de embeddings
          <input
            value={form.embedding_model}
            onChange={(e) => {
              const embedding_model = e.currentTarget.value;
              setForm((f) => ({ ...f, embedding_model }));
            }}
            placeholder={STYLE_PRESETS[form.local_api_style]?.embeddingModel}
          />
        </label>
        <label>
          Modelo de voz (transcripción local)
          <select
            value={form.whisper_model}
            onChange={(e) => {
              const whisper_model = e.currentTarget.value;
              setForm((f) => ({ ...f, whisper_model }));
            }}
          >
            <option value="tiny">tiny (más rápido, menos preciso)</option>
            <option value="base">base (recomendado)</option>
            <option value="small">small</option>
            <option value="medium">medium (más preciso, más pesado)</option>
          </select>
        </label>
        <label>
          Tema
          <select
            value={form.theme}
            onChange={(e) => {
              const theme = e.currentTarget.value;
              setForm((f) => ({ ...f, theme }));
            }}
          >
            <option value="system">Sistema</option>
            <option value="light">Claro</option>
            <option value="dark">Oscuro</option>
          </select>
        </label>
        <button type="submit">Guardar</button>
        {saved && <span className="settings-saved">Guardado ✓</span>}
        {saveError && <p className="chat-error">{saveError}</p>}
      </form>

      <div className="settings-voice">
        <h3>Modelos de voz descargados</h3>
        <p className="settings-voice-hint">
          El modelo elegido arriba tiene que estar descargado para poder usar el botón 🎤 del chat.
        </p>
        {downloadError && <p className="chat-error">{downloadError}</p>}
        <ul className="settings-voice-list">
          {modelStatus.map((m) => (
            <li key={m.model}>
              <span>{m.model}</span>
              {m.installed ? (
                <span className="settings-voice-installed">Descargado ✓</span>
              ) : (
                <button onClick={() => downloadModel(m.model)} disabled={downloading.has(m.model)}>
                  {downloading.has(m.model) ? "Descargando…" : "Descargar"}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {isTauri() && (
        <div className="settings-updates">
          <h3>Actualizaciones</h3>
          {updateState === "idle" && <button onClick={checkUpdates}>Buscar actualizaciones</button>}
          {updateState === "checking" && <p>Buscando actualizaciones…</p>}
          {updateState === "up-to-date" && (
            <p>
              Ya tenés la última versión ✓ <button onClick={checkUpdates}>Volver a buscar</button>
            </p>
          )}
          {updateState === "available" && pendingUpdate && (
            <div>
              <p>
                Hay una versión nueva disponible: <strong>{pendingUpdate.version}</strong> (actual:{" "}
                {pendingUpdate.currentVersion})
              </p>
              {pendingUpdate.body && <p className="settings-update-notes">{pendingUpdate.body}</p>}
              <button onClick={installUpdate}>Instalar y reiniciar</button>
            </div>
          )}
          {updateState === "installing" && <p>Descargando e instalando… la app se va a reiniciar sola.</p>}
          {updateState === "error" && (
            <div>
              <p className="chat-error">No se pudo buscar/instalar la actualización: {updateError}</p>
              <button onClick={checkUpdates}>Reintentar</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
