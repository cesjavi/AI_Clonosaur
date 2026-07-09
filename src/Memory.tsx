import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Memory.css";

interface EmbeddingCoverage {
  total_messages: number;
  with_embedding: number;
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

export default function Memory() {
  const [coverage, setCoverage] = useState<EmbeddingCoverage | null>(null);
  const [generating, setGenerating] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MemorySearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function loadCoverage() {
    invoke<EmbeddingCoverage>("get_embedding_coverage").then(setCoverage).catch((e) => setError(String(e)));
  }

  useEffect(loadCoverage, []);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      await invoke<number>("generate_embeddings");
      loadCoverage();
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const found = await invoke<MemorySearchResult[]>("search_memory", { query, limit: 5 });
      setResults(found);
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }

  async function sendFeedback(messageId: string, isUser: boolean) {
    await invoke("record_feedback", { messageId, isUser });
    setResults((prev) =>
      prev.map((r) => (r.message_id === messageId ? { ...r, is_user: isUser } : r)),
    );
  }

  return (
    <div className="memory">
      <div className="memory-coverage">
        {coverage && (
          <p>
            Embeddings: {coverage.with_embedding} / {coverage.total_messages} mensajes indexados
          </p>
        )}
        <button onClick={handleGenerate} disabled={generating}>
          {generating ? "Generando…" : "Generar embeddings pendientes"}
        </button>
      </div>

      <form className="memory-search" onSubmit={handleSearch}>
        <input
          placeholder="Buscar en tu memoria…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <button type="submit" disabled={searching}>
          {searching ? "Buscando…" : "Buscar"}
        </button>
      </form>

      {error && <p className="memory-error">{error}</p>}

      <div className="memory-results">
        {results.map((r) => (
          <div key={r.message_id} className="memory-result">
            <p className="memory-result-text">{r.text}</p>
            <div className="memory-result-meta">
              <span>{r.author ?? "Desconocido"}</span>
              <span>{new Date(r.timestamp).toLocaleString()}</span>
              <span>{r.source_kind}</span>
              <span>score {r.score.toFixed(3)}</span>
              <span>{r.is_user ? "es del usuario" : "de un tercero"}</span>
            </div>
            <div className="memory-result-actions">
              <button onClick={() => sendFeedback(r.message_id, true)}>Esto soy yo</button>
              <button onClick={() => sendFeedback(r.message_id, false)}>No soy yo</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
