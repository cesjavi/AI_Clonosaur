import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Privacidad.css";

interface SourceSummary {
  id: string;
  kind: string;
  file_name: string | null;
  imported_at: string;
  message_count: number;
}

interface PersonSummary {
  id: string;
  name: string;
  is_user: boolean;
  relationship: string | null;
  excluded: boolean;
  message_count: number;
}

export default function Privacidad() {
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ kind: "source" | "contact"; id: string; label: string } | null>(
    null,
  );

  function load() {
    invoke<SourceSummary[]>("list_sources").then(setSources);
    invoke<PersonSummary[]>("list_people").then((all) => setPeople(all.filter((p) => !p.is_user)));
  }

  useEffect(load, []);

  async function toggleExcluded(personId: string, excluded: boolean) {
    await invoke("set_person_excluded", { personId, excluded });
    load();
  }

  async function confirmDelete() {
    if (!confirming) return;
    setError(null);
    try {
      if (confirming.kind === "source") {
        const n = await invoke<number>("delete_by_source", { sourceId: confirming.id });
        setMessage(`Se borraron ${n} mensajes de "${confirming.label}".`);
      } else {
        const n = await invoke<number>("delete_by_contact", { personId: confirming.id });
        setMessage(`Se borraron ${n} mensajes de "${confirming.label}".`);
      }
      setConfirming(null);
      load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteByDateRange(e: React.FormEvent) {
    e.preventDefault();
    if (!from || !to) return;
    setError(null);
    try {
      const n = await invoke<number>("delete_by_date_range", { from, to });
      setMessage(`Se borraron ${n} mensajes entre ${from} y ${to}.`);
      load();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="privacidad">
      {message && <p className="privacidad-message">{message}</p>}
      {error && <p className="privacidad-error">{error}</p>}

      {confirming && (
        <div className="privacidad-confirm">
          <p>
            ¿Seguro que querés borrar todo lo asociado a "{confirming.label}"? Esta acción es irreversible: elimina
            los mensajes, embeddings y feedback relacionados.
          </p>
          <div className="privacidad-confirm-actions">
            <button onClick={confirmDelete}>Sí, borrar</button>
            <button onClick={() => setConfirming(null)}>Cancelar</button>
          </div>
        </div>
      )}

      <h2>Fuentes importadas</h2>
      {sources.length === 0 && <p className="privacidad-empty">No hay fuentes importadas.</p>}
      <div className="privacidad-list">
        {sources.map((s) => (
          <div key={s.id} className="privacidad-item">
            <strong>{s.file_name ?? s.kind}</strong>
            <span>{s.kind}</span>
            <span>{s.message_count} mensajes</span>
            <button
              onClick={() => setConfirming({ kind: "source", id: s.id, label: s.file_name ?? s.kind })}
            >
              Borrar esta fuente
            </button>
          </div>
        ))}
      </div>

      <h2>Contactos</h2>
      {people.length === 0 && <p className="privacidad-empty">No hay contactos detectados.</p>}
      <div className="privacidad-list">
        {people.map((p) => (
          <div key={p.id} className="privacidad-item">
            <strong>{p.name}</strong>
            <span>{p.message_count} mensajes</span>
            <label>
              <input
                type="checkbox"
                checked={p.excluded}
                onChange={(e) => toggleExcluded(p.id, e.currentTarget.checked)}
              />
              Excluir de la memoria del clon
            </label>
            <button onClick={() => setConfirming({ kind: "contact", id: p.id, label: p.name })}>
              Borrar este contacto
            </button>
          </div>
        ))}
      </div>

      <h2>Borrar por rango de fechas</h2>
      <form className="privacidad-daterange" onSubmit={deleteByDateRange}>
        <input type="datetime-local" value={from} onChange={(e) => setFrom(e.currentTarget.value)} required />
        <span>hasta</span>
        <input type="datetime-local" value={to} onChange={(e) => setTo(e.currentTarget.value)} required />
        <button type="submit">Borrar rango</button>
      </form>
    </div>
  );
}
