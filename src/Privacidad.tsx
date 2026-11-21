import { useEffect, useState } from "react";
import { invoke } from "./backend/invoke";
import { VaultSecurity } from "./Vault";
import "./Privacidad.css";

interface VaultStatus {
  configured: boolean;
  locked: boolean;
}

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

interface SendLogEntry {
  provider: string;
  model: string;
  anonymized: boolean;
  content: string;
  created_at: string;
}

export default function Privacidad() {
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [sendLog, setSendLog] = useState<SendLogEntry[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<
    | { kind: "source"; id: string; label: string }
    | { kind: "contact"; id: string; label: string }
    | { kind: "dateRange"; fromUtc: string; toUtc: string; label: string }
    | null
  >(null);
  const [deleting, setDeleting] = useState(false);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);

  function load() {
    invoke<SourceSummary[]>("list_sources")
      .then(setSources)
      .catch((e) => setError(String(e)));
    invoke<PersonSummary[]>("list_people")
      .then((all) => setPeople(all.filter((p) => !p.is_user)))
      .catch((e) => setError(String(e)));
    invoke<VaultStatus>("get_vault_status")
      .then(setVaultStatus)
      .catch(() => setVaultStatus(null));
    invoke<SendLogEntry[]>("list_external_send_log")
      .then(setSendLog)
      .catch((e) => setError(String(e)));
  }

  useEffect(load, []);

  async function toggleExcluded(personId: string, excluded: boolean) {
    setError(null);
    try {
      await invoke("set_person_excluded", { personId, excluded });
      load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function confirmDelete() {
    if (!confirming || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      if (confirming.kind === "source") {
        const n = await invoke<number>("delete_by_source", { sourceId: confirming.id });
        setMessage(`Se borraron ${n} mensajes de "${confirming.label}".`);
      } else if (confirming.kind === "contact") {
        const n = await invoke<number>("delete_by_contact", { personId: confirming.id });
        setMessage(`Se borraron ${n} mensajes de "${confirming.label}".`);
      } else {
        const n = await invoke<number>("delete_by_date_range", {
          from: confirming.fromUtc,
          to: confirming.toUtc,
        });
        setMessage(`Se borraron ${n} mensajes (${confirming.label}).`);
      }
      setConfirming(null);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(false);
    }
  }

  function requestDeleteByDateRange(e: React.FormEvent) {
    e.preventDefault();
    if (!from || !to) return;
    setError(null);
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      setError("Las fechas ingresadas no son válidas.");
      return;
    }
    // Include the full selected end minute (`:59.999`) so messages during the
    // end minute are not excluded by lexicographic comparison.
    const toInclusive = new Date(toDate.getTime() + 59_999);
    if (fromDate > toInclusive) {
      setError("La fecha 'desde' no puede ser posterior a 'hasta'.");
      return;
    }
    setConfirming({
      kind: "dateRange",
      fromUtc: fromDate.toISOString(),
      toUtc: toInclusive.toISOString(),
      label: `entre ${fromDate.toLocaleString()} y ${toDate.toLocaleString()}`,
    });
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
            <button onClick={confirmDelete} disabled={deleting}>
              {deleting ? "Borrando…" : "Sí, borrar"}
            </button>
            <button onClick={() => setConfirming(null)} disabled={deleting}>
              Cancelar
            </button>
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
      <form className="privacidad-daterange" onSubmit={requestDeleteByDateRange}>
        <input type="datetime-local" value={from} onChange={(e) => setFrom(e.currentTarget.value)} required />
        <span>hasta</span>
        <input type="datetime-local" value={to} onChange={(e) => setTo(e.currentTarget.value)} required />
        <button type="submit">Borrar rango</button>
      </form>

      <h2>Historial de envíos externos</h2>
      {sendLog.length === 0 && <p className="privacidad-empty">No se registró ningún envío a proveedores externos.</p>}
      <div className="privacidad-list">
        {sendLog.map((entry, idx) => (
          <details key={`${entry.created_at}-${idx}`} className="privacidad-item">
            <summary>
              <strong>{entry.provider}</strong> · {entry.model} ·{" "}
              {entry.anonymized ? "anonimizado" : "sin anonimizar"} · {new Date(entry.created_at).toLocaleString()}
            </summary>
            <pre>{entry.content}</pre>
          </details>
        ))}
      </div>

      {vaultStatus && <VaultSecurity status={vaultStatus} onStatusChange={load} />}
    </div>
  );
}
