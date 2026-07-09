import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Metrics.css";

interface Metrics {
  total_messages: number;
  messages_with_embedding: number;
  sensitive_messages: number;
  memories_candidate: number;
  memories_confirmed: number;
  memories_edited: number;
  memories_rejected: number;
  feedback_count: number;
  drafts_pending: number;
  drafts_approved: number;
  drafts_edited: number;
  drafts_rejected: number;
  interview_answered: number;
  total_sessions: number;
  total_turns: number;
}

function pct(n: number, total: number): string {
  if (total === 0) return "—";
  return `${Math.round((n / total) * 100)}%`;
}

export default function Metrics() {
  const [m, setM] = useState<Metrics | null>(null);

  useEffect(() => {
    invoke<Metrics>("get_metrics").then(setM);
  }, []);

  if (!m) return <p className="metrics-loading">Cargando métricas…</p>;

  const memoriesTotal = m.memories_candidate + m.memories_confirmed + m.memories_edited + m.memories_rejected;
  const memoriesConfirmedRate = pct(m.memories_confirmed + m.memories_edited, memoriesTotal);
  const draftsTotal = m.drafts_pending + m.drafts_approved + m.drafts_edited + m.drafts_rejected;

  return (
    <div className="metrics">
      <div className="metrics-grid">
        <div className="metrics-card">
          <h3>Cobertura de embeddings</h3>
          <p className="metrics-value">
            {m.messages_with_embedding} / {m.total_messages}
          </p>
          <p className="metrics-sub">{pct(m.messages_with_embedding, m.total_messages)} indexado</p>
        </div>

        <div className="metrics-card">
          <h3>Mensajes sensibles</h3>
          <p className="metrics-value">{m.sensitive_messages}</p>
          <p className="metrics-sub">excluidos del contexto automático</p>
        </div>

        <div className="metrics-card">
          <h3>Memorias</h3>
          <p className="metrics-value">{memoriesTotal}</p>
          <p className="metrics-sub">
            {m.memories_candidate} candidatas · {m.memories_confirmed} confirmadas · {m.memories_edited} editadas ·{" "}
            {m.memories_rejected} rechazadas
          </p>
          <p className="metrics-sub">tasa de confirmación: {memoriesConfirmedRate}</p>
        </div>

        <div className="metrics-card">
          <h3>Feedback de atribución</h3>
          <p className="metrics-value">{m.feedback_count}</p>
        </div>

        <div className="metrics-card">
          <h3>Borradores del copiloto</h3>
          <p className="metrics-value">{draftsTotal}</p>
          <p className="metrics-sub">
            {m.drafts_pending} pendientes · {m.drafts_approved} aprobados · {m.drafts_edited} editados ·{" "}
            {m.drafts_rejected} rechazados
          </p>
        </div>

        <div className="metrics-card">
          <h3>Progreso de entrevista</h3>
          <p className="metrics-value">{m.interview_answered}</p>
          <p className="metrics-sub">preguntas respondidas</p>
        </div>

        <div className="metrics-card">
          <h3>Sesiones de chat</h3>
          <p className="metrics-value">{m.total_sessions}</p>
          <p className="metrics-sub">{m.total_turns} turnos totales</p>
        </div>
      </div>
    </div>
  );
}
