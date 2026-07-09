import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Memories.css";

interface MemoryItem {
  id: string;
  layer: string;
  status: string;
  content: string;
  evidence: string | null;
  created_at: string;
}

export default function Memories() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [busy, setBusy] = useState<"generate" | "contradictions" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  function load() {
    invoke<MemoryItem[]>("list_memories", { status: "candidate" })
      .then(setMemories)
      .catch((e) => setError(String(e)));
  }

  useEffect(load, []);

  async function generate() {
    setBusy("generate");
    setError(null);
    try {
      const created = await invoke<number>("generate_candidate_memories");
      if (created === 0) {
        setError("No se generaron memorias nuevas (sin mensajes propios pendientes, o el modelo no encontró nada claro).");
      }
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function findContradictions() {
    setBusy("contradictions");
    setError(null);
    try {
      const created = await invoke<number>("detect_contradictions");
      if (created === 0) {
        setError("No se encontraron contradicciones (o todavía no hay suficientes memorias confirmadas).");
      }
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(id: string, status: string, content?: string) {
    await invoke("update_memory_status", { id, status, content: content ?? null });
    load();
  }

  function startEdit(m: MemoryItem) {
    setEditingId(m.id);
    setEditingText(m.content);
  }

  async function saveEdit(id: string) {
    await setStatus(id, "edited", editingText);
    setEditingId(null);
  }

  return (
    <div className="memories">
      <div className="memories-actions">
        <button disabled={busy !== null} onClick={generate}>
          {busy === "generate" ? "Generando…" : "Generar memorias candidatas"}
        </button>
        <button disabled={busy !== null} onClick={findContradictions}>
          {busy === "contradictions" ? "Buscando…" : "Detectar contradicciones"}
        </button>
      </div>

      {error && <p className="memories-error">{error}</p>}

      {memories.length === 0 && !error && (
        <p className="memories-empty">No hay memorias candidatas pendientes de revisión.</p>
      )}

      <div className="memories-list">
        {memories.map((m) => (
          <div key={m.id} className="memories-item">
            <span className="memories-layer">{m.layer}</span>
            {editingId === m.id ? (
              <textarea
                value={editingText}
                onChange={(e) => setEditingText(e.currentTarget.value)}
                rows={2}
              />
            ) : (
              <p className="memories-content">{m.content}</p>
            )}
            {m.evidence && <p className="memories-evidence">Evidencia: "{m.evidence}"</p>}
            <div className="memories-item-actions">
              {editingId === m.id ? (
                <>
                  <button onClick={() => saveEdit(m.id)}>Guardar</button>
                  <button onClick={() => setEditingId(null)}>Cancelar</button>
                </>
              ) : (
                <>
                  <button onClick={() => setStatus(m.id, "confirmed")}>Confirmar</button>
                  <button onClick={() => startEdit(m)}>Editar</button>
                  <button onClick={() => setStatus(m.id, "rejected")}>Rechazar</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
