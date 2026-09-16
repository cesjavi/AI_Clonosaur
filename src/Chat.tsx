import { useEffect, useRef, useState } from "react";
import { invoke, listen } from "./backend/invoke";
import "./Chat.css";

interface ChatMessage {
  role: string;
  content: string;
}

interface MemorySearchResult {
  message_id: string;
  text: string;
  timestamp: string;
  author: string | null;
  is_user: boolean;
  source_kind: string;
  score: number;
}

interface RagSources {
  profile_traits_used: number;
  memories_used: number;
  messages_used: MemorySearchResult[];
}

interface DisplayMessage extends ChatMessage {
  sources?: RagSources;
}

type Mode = "simple" | "rag" | "hybrid";

interface HybridPreview {
  provider: string;
  model: string;
  messages: ChatMessage[];
  rendered_text: string;
}

interface ProviderInfo {
  provider: string;
  base_url: string;
  model: string;
  has_api_key: boolean;
}

export default function Chat() {
  const [mode, setMode] = useState<Mode>("rag");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState<string | null>(null);

  const [anonymize, setAnonymize] = useState(false);
  const [preview, setPreview] = useState<HybridPreview | null>(null);
  const [providerForm, setProviderForm] = useState({ provider: "groq", baseUrl: "", apiKey: "", model: "" });
  const [providerInfo, setProviderInfo] = useState<ProviderInfo | null>(null);
  const [showProviderConfig, setShowProviderConfig] = useState(false);

  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    // `cancelled` guards against React StrictMode's dev-mode
    // mount→cleanup→remount: if cleanup runs before create_session resolves,
    // sessionIdRef.current is still null (nothing for the cleanup below to
    // close), so the just-created session would otherwise leak — orphaned in
    // agent_sessions with no ended_at. Catching that here closes it directly
    // instead of relying on the ref having already been set.
    let cancelled = false;
    invoke<string>("create_session", { mode }).then((id) => {
      if (cancelled) {
        invoke("close_session", { sessionId: id });
        return;
      }
      sessionIdRef.current = id;
      setSessionId(id);
    });

    return () => {
      cancelled = true;
      if (sessionIdRef.current) {
        invoke("close_session", { sessionId: sessionIdRef.current });
        sessionIdRef.current = null;
      }
    };
  }, [mode]);

  useEffect(() => {
    // Same StrictMode race as above: `listen()` resolves asynchronously, so
    // if cleanup runs first, unlistenRef.current is still null and the
    // subscription registered by the resolving promise would otherwise leak
    // and duplicate every streamed token. `cancelled` catches that case and
    // unregisters it immediately instead of only relying on the ref.
    let cancelled = false;
    listen<string>("chat-stream-delta", (event) => {
      setStreamingText((prev) => (prev ?? "") + event.payload);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }
      unlistenRef.current = unlisten;
    });
    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (mode === "hybrid") {
      loadProviderInfo(providerForm.provider);
    }
    // Intentionally re-runs only on switching into "hybrid" mode, not on
    // every keystroke in the provider config form — `saveProvider` already
    // reloads provider info after an edit is actually submitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Releases the microphone if this screen unmounts (e.g. the user
  // navigates away) while a recording is still in progress — otherwise the
  // MediaStream/MediaRecorder are orphaned and the mic keeps recording with
  // nothing left able to stop it. Bypasses the normal onstop transcription
  // flow (no point starting an async transcription for a component that's
  // already gone).
  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stream.getTracks().forEach((t) => t.stop());
        recorder.stop();
      }
    };
  }, []);

  function loadProviderInfo(provider: string) {
    invoke<ProviderInfo | null>("get_provider_credentials", { provider }).then((info) => {
      setProviderInfo(info);
      if (info) {
        setProviderForm((f) => ({ ...f, baseUrl: info.base_url, model: info.model }));
        // If it's already preloaded (Groq by default) but still doesn't have an
        // API key, we open the form directly: all that's left is pasting the key.
        if (!info.has_api_key) {
          setShowProviderConfig(true);
        }
      }
    });
  }

  async function prefillDefault(provider: string) {
    const baseUrl = await invoke<string>("default_base_url", { provider });
    setProviderForm((f) => ({ ...f, provider, baseUrl }));
  }

  async function saveProvider(e: React.FormEvent) {
    e.preventDefault();
    await invoke("save_provider_credentials", {
      provider: providerForm.provider,
      baseUrl: providerForm.baseUrl,
      apiKey: providerForm.apiKey,
      model: providerForm.model,
    });
    loadProviderInfo(providerForm.provider);
    setShowProviderConfig(false);
  }

  async function sendSimpleOrRag() {
    if (!input.trim() || !sessionId) return;
    const history = [...messages, { role: "user", content: input }];
    setMessages(history);
    setInput("");
    setBusy(true);
    setError(null);
    setStreamingText("");

    try {
      const result = await invoke<{ reply: string; sources: RagSources | null }>("send_chat_stream", {
        sessionId,
        mode,
        history: history.map((m) => ({ role: m.role, content: m.content })),
      });
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: result.reply, sources: result.sources ?? undefined },
      ]);
    } catch (e) {
      setError(String(e));
    } finally {
      setStreamingText(null);
      setBusy(false);
    }
  }

  async function requestHybridPreview() {
    if (!input.trim() || !sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const history = [...messages, { role: "user", content: input }].map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const p = await invoke<HybridPreview>("build_hybrid_preview", {
        provider: providerForm.provider,
        history,
        anonymize,
      });
      setPreview(p);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmHybridSend() {
    if (!preview || !sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const reply = await invoke<string>("send_to_external_provider", {
        sessionId,
        provider: preview.provider,
        messages: preview.messages,
        renderedText: preview.rendered_text,
        anonymized: anonymize,
      });
      setMessages((prev) => [...prev, { role: "user", content: input }, { role: "assistant", content: reply }]);
      setInput("");
      setPreview(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function resampleTo16kMono(buffer: AudioBuffer): Promise<Float32Array> {
    const targetRate = 16000;
    if (buffer.sampleRate === targetRate && buffer.numberOfChannels === 1) {
      return buffer.getChannelData(0);
    }
    const offlineCtx = new OfflineAudioContext(1, Math.ceil(buffer.duration * targetRate), targetRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    const rendered = await offlineCtx.startRendering();
    return rendered.getChannelData(0);
  }

  async function toggleRecording() {
    if (recording) {
      mediaRecorderRef.current?.stop();
      setRecording(false);
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setTranscribing(true);
        try {
          const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
          const arrayBuffer = await blob.arrayBuffer();
          const audioCtx = new AudioContext();
          const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
          const samples = await resampleTo16kMono(audioBuffer);
          await audioCtx.close();
          const text = await invoke<string>("transcribe_audio", { samples: Array.from(samples) });
          if (text.trim()) {
            setInput((prev) => (prev ? `${prev} ${text.trim()}` : text.trim()));
          }
        } catch (e) {
          setError(String(e));
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch (e) {
      setError(String(e));
    }
  }

  function speak(text: string) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "es-ES";
    window.speechSynthesis.speak(utterance);
  }

  return (
    <div className="chat">
      <div className="chat-mode">
        <button className={mode === "simple" ? "active" : ""} onClick={() => setMode("simple")}>
          Simple
        </button>
        <button className={mode === "rag" ? "active" : ""} onClick={() => setMode("rag")}>
          Con memoria (RAG)
        </button>
        <button className={mode === "hybrid" ? "active" : ""} onClick={() => setMode("hybrid")}>
          Híbrido
        </button>
      </div>

      {mode === "hybrid" && (
        <div className="chat-hybrid-config">
          <p className="chat-hybrid-disclaimer">
            Híbrido manda tu mensaje y el contexto (perfil/memorias) a un proveedor externo en la
            nube — nunca en automático: siempre vas a ver el preview exacto y confirmar antes de
            que se envíe algo.
          </p>
          <button onClick={() => setShowProviderConfig((v) => !v)}>
            {showProviderConfig ? "Ocultar configuración" : "Configurar proveedor externo"}
          </button>
          {providerInfo ? (
            <span className="chat-provider-status">
              {providerInfo.provider} · {providerInfo.model} · {providerInfo.has_api_key ? "con API key" : "sin API key"}
            </span>
          ) : (
            <span className="chat-provider-status">Sin configurar todavía</span>
          )}
          <label>
            <input type="checkbox" checked={anonymize} onChange={(e) => setAnonymize(e.currentTarget.checked)} />
            Anonimizar contactos
          </label>

          {showProviderConfig && (
            <form className="chat-provider-form" onSubmit={saveProvider}>
              <select
                value={providerForm.provider}
                onChange={(e) => prefillDefault(e.currentTarget.value)}
              >
                <option value="groq">groq</option>
                <option value="openai">openai</option>
                <option value="custom">custom</option>
              </select>
              <input
                placeholder="Base URL"
                value={providerForm.baseUrl}
                onChange={(e) => {
                  const baseUrl = e.currentTarget.value;
                  setProviderForm((f) => ({ ...f, baseUrl }));
                }}
              />
              <input
                placeholder="Modelo (ej. llama-3.3-70b-versatile)"
                value={providerForm.model}
                onChange={(e) => {
                  const model = e.currentTarget.value;
                  setProviderForm((f) => ({ ...f, model }));
                }}
              />
              <input
                type="password"
                placeholder="API key"
                value={providerForm.apiKey}
                onChange={(e) => {
                  const apiKey = e.currentTarget.value;
                  setProviderForm((f) => ({ ...f, apiKey }));
                }}
              />
              <button type="submit">Guardar</button>
              {providerForm.provider === "groq" && (
                <span className="chat-provider-hint">Conseguí tu API key en console.groq.com/keys</span>
              )}
            </form>
          )}
        </div>
      )}

      {error && <p className="chat-error">{error}</p>}

      <div className="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className={`chat-bubble chat-${m.role}`}>
            <p>{m.content}</p>
            {m.role === "assistant" && (
              <button className="chat-speak" onClick={() => speak(m.content)} title="Escuchar">
                🔊
              </button>
            )}
            {m.sources && (
              <details className="chat-sources">
                <summary>Fuentes usadas</summary>
                <p>
                  {m.sources.profile_traits_used} rasgos de perfil, {m.sources.memories_used} memorias confirmadas
                </p>
                {m.sources.messages_used.map((s) => (
                  <div key={s.message_id} className="chat-source-item">
                    <span>{s.text}</span>
                    <span className="chat-source-meta">
                      {s.author ?? "Desconocido"} · {new Date(s.timestamp).toLocaleString()} · score {s.score.toFixed(3)}
                    </span>
                  </div>
                ))}
              </details>
            )}
          </div>
        ))}
        {streamingText !== null && (
          <div className="chat-bubble chat-assistant chat-streaming">
            <p>{streamingText || "…"}</p>
          </div>
        )}
      </div>

      {mode === "hybrid" && preview && (
        <div className="chat-preview">
          <p>Esto es exactamente lo que se enviaría a {preview.provider} ({preview.model}):</p>
          <pre>{preview.rendered_text}</pre>
          <div className="chat-preview-actions">
            <button onClick={confirmHybridSend} disabled={busy}>
              Confirmar y enviar
            </button>
            <button onClick={() => setPreview(null)}>Cancelar</button>
          </div>
        </div>
      )}

      {!(mode === "hybrid" && preview) && (
        <div className="chat-input">
          <button
            className={recording ? "chat-mic recording" : "chat-mic"}
            onClick={toggleRecording}
            disabled={busy || transcribing}
            title={recording ? "Detener grabación" : "Grabar mensaje de voz"}
          >
            {recording ? "⏹" : "🎤"}
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) {
                if (mode === "hybrid") requestHybridPreview();
                else sendSimpleOrRag();
              }
            }}
            placeholder={transcribing ? "Transcribiendo…" : "Escribí un mensaje…"}
            disabled={busy || transcribing}
          />
          <button
            onClick={mode === "hybrid" ? requestHybridPreview : sendSimpleOrRag}
            disabled={busy || transcribing || !input.trim()}
          >
            {mode === "hybrid" ? "Ver preview" : "Enviar"}
          </button>
        </div>
      )}
    </div>
  );
}
