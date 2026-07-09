import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Copilot.css";

interface PersonSummary {
  id: string;
  name: string;
  is_user: boolean;
  relationship: string | null;
  excluded: boolean;
  message_count: number;
}

interface Draft {
  id: string;
  contact_name: string | null;
  content: string;
  status: string;
  created_at: string;
}

export default function Copilot() {
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [contactId, setContactId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  function loadPeople() {
    invoke<PersonSummary[]>("list_people").then((all) => setPeople(all.filter((p) => !p.is_user)));
  }

  function loadDrafts() {
    invoke<Draft[]>("list_drafts").then(setDrafts);
  }

  useEffect(() => {
    loadPeople();
    loadDrafts();
  }, []);

  async function generate() {
    if (!instruction.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("generate_draft", {
        contactPersonId: contactId || null,
        instruction,
      });
      setInstruction("");
      loadDrafts();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: string, content?: string) {
    await invoke("update_draft_status", { id, status, content: content ?? null });
    loadDrafts();
  }

  function startEdit(d: Draft) {
    setEditingId(d.id);
    setEditingText(d.content);
  }

  async function saveEdit(id: string) {
    await setStatus(id, "edited", editingText);
    setEditingId(null);
  }

  return (
    <div className="copilot">
      <div className="copilot-form">
        <select value={contactId} onChange={(e) => setContactId(e.currentTarget.value)}>
          <option value="">General (sin destinatario)</option>
          {people.map((p) => (
            <option key={p.id} value={p.id} disabled={p.excluded}>
              {p.name} {p.excluded ? "(excluido)" : ""}
            </option>
          ))}
        </select>
        <textarea
          placeholder="¿Qué querés redactar? ej. 'Respondele a Ana que llego tarde a la cena'"
          rows={3}
          value={instruction}
          onChange={(e) => setInstruction(e.currentTarget.value)}
        />
        <button onClick={generate} disabled={busy || !instruction.trim()}>
          {busy ? "Generando…" : "Generar borrador"}
        </button>
      </div>

      {error && <p className="copilot-error">{error}</p>}

      <h2>Borradores</h2>
      {drafts.length === 0 && <p className="copilot-empty">Todavía no generaste ningún borrador.</p>}
      <div className="copilot-list">
        {drafts.map((d) => (
          <div key={d.id} className="copilot-draft">
            <div className="copilot-draft-meta">
              <span>{d.contact_name ?? "General"}</span>
              <span className={`copilot-status copilot-status-${d.status}`}>{d.status}</span>
            </div>
            {editingId === d.id ? (
              <textarea
                value={editingText}
                onChange={(e) => setEditingText(e.currentTarget.value)}
                rows={3}
              />
            ) : (
              <p>{d.content}</p>
            )}
            <div className="copilot-draft-actions">
              {editingId === d.id ? (
                <>
                  <button onClick={() => saveEdit(d.id)}>Guardar</button>
                  <button onClick={() => setEditingId(null)}>Cancelar</button>
                </>
              ) : (
                <>
                  <button onClick={() => setStatus(d.id, "approved")}>Aprobar</button>
                  <button onClick={() => startEdit(d)}>Editar</button>
                  <button onClick={() => setStatus(d.id, "rejected")}>Rechazar</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
