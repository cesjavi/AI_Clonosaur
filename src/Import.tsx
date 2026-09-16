import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "./backend/invoke";
import { open } from "@tauri-apps/plugin-dialog";
import "./Import.css";

interface ImportSummary {
  source_id: string;
  imported: number;
  duplicates: number;
  participants: string[];
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

type ImportCommand =
  | "import_whatsapp_file"
  | "import_generic_file"
  | "import_gmail_file"
  | "import_twitter_file"
  | "import_discord_file"
  | "import_reddit_file";

const RELATIONSHIP_OPTIONS = ["familia", "pareja", "amigo", "trabajo", "conocido", "otro"];

const IMPORT_BUTTONS: {
  command: ImportCommand;
  label: string;
  filters: { name: string; extensions: string[] }[];
  needsUsername?: boolean;
}[] = [
  {
    command: "import_whatsapp_file",
    label: "Importar chat de WhatsApp (.txt / .zip)",
    filters: [{ name: "WhatsApp", extensions: ["txt", "zip"] }],
  },
  {
    command: "import_gmail_file",
    label: "Importar Gmail Takeout (.mbox)",
    filters: [{ name: "Gmail", extensions: ["mbox"] }],
  },
  {
    command: "import_twitter_file",
    label: "Importar archive de Twitter/X (tweet.js)",
    filters: [{ name: "Twitter/X", extensions: ["js"] }],
    // The archive itself has no username inside tweet.js — every tweet
    // needs a person to attribute to, whether that's the user themself or
    // a contact who shared their own export (see twitter.ts).
    needsUsername: true,
  },
  {
    command: "import_discord_file",
    label: "Importar canal de Discord (messages.csv)",
    filters: [{ name: "Discord", extensions: ["csv"] }],
  },
  {
    command: "import_reddit_file",
    label: "Importar Reddit (comments.csv / posts.csv)",
    filters: [{ name: "Reddit", extensions: ["csv"] }],
  },
  {
    command: "import_generic_file",
    label: "Importar archivo genérico (.json / .csv / .txt)",
    filters: [{ name: "Genérico", extensions: ["json", "csv", "txt"] }],
  },
];

export default function Import() {
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<ImportSummary | null>(null);
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingCommandRef = useRef<ImportCommand | null>(null);
  const pendingUsernameRef = useRef<string | null>(null);
  const [usernamePrompt, setUsernamePrompt] = useState<{
    command: ImportCommand;
    filters: { name: string; extensions: string[] }[];
    value: string;
  } | null>(null);

  function loadSources() {
    invoke<SourceSummary[]>("list_sources").then(setSources).catch((e) => setError(String(e)));
  }

  function loadPeople() {
    invoke<PersonSummary[]>("list_people").then(setPeople).catch((e) => setError(String(e)));
  }

  useEffect(() => {
    loadSources();
    loadPeople();
  }, []);

  // "cancel" fires on the native file dialog when the user closes it without
  // picking a file — not in React's InputHTMLAttributes typings, so it's
  // wired up manually instead of via onCancel= in JSX. Without this, a
  // username set by confirmUsernamePrompt right before the dialog opened
  // would stay stuck in the ref and leak into the next, unrelated import.
  useEffect(() => {
    const input = fileInputRef.current;
    if (!input) return;
    const onCancel = () => {
      pendingCommandRef.current = null;
      pendingUsernameRef.current = null;
    };
    input.addEventListener("cancel", onCancel);
    return () => input.removeEventListener("cancel", onCancel);
  }, []);

  async function runImport(command: ImportCommand, args: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setLastSummary(null);
    try {
      const summary = await invoke<ImportSummary>(command, args);
      setLastSummary(summary);
      loadSources();
      loadPeople();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickAndImport(
    command: ImportCommand,
    filters: { name: string; extensions: string[] }[],
  ) {
    if (isTauri()) {
      const path = await open({ multiple: false, filters });
      if (!path || Array.isArray(path)) {
        pendingUsernameRef.current = null;
        return;
      }
      await runImport(command, { path, ...(pendingUsernameRef.current ? { username: pendingUsernameRef.current } : {}) });
      pendingUsernameRef.current = null;
      return;
    }

    // Web build: no native file dialog — a hidden <input type="file"> reads
    // the file's bytes directly, since the browser never gets a real
    // filesystem path to hand to a backend command.
    pendingCommandRef.current = command;
    if (fileInputRef.current) {
      fileInputRef.current.accept = filters.flatMap((f) => f.extensions.map((ext) => `.${ext}`)).join(",");
      fileInputRef.current.click();
    }
  }

  function startImport(
    command: ImportCommand,
    filters: { name: string; extensions: string[] }[],
    needsUsername?: boolean,
  ) {
    if (needsUsername) {
      setUsernamePrompt({ command, filters, value: "" });
      return;
    }
    pickAndImport(command, filters);
  }

  function confirmUsernamePrompt(e: React.FormEvent) {
    e.preventDefault();
    if (!usernamePrompt || !usernamePrompt.value.trim()) return;
    pendingUsernameRef.current = usernamePrompt.value.trim();
    const { command, filters } = usernamePrompt;
    setUsernamePrompt(null);
    pickAndImport(command, filters);
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const command = pendingCommandRef.current;
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!command || !file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const username = pendingUsernameRef.current;
    pendingUsernameRef.current = null;
    await runImport(command, { fileName: file.name, bytes, ...(username ? { username } : {}) });
  }

  async function markAsMe(name: string) {
    const person = people.find((p) => p.name === name);
    if (!person) {
      setError(`no se encontró a "${name}" entre los contactos guardados`);
      return;
    }
    await invoke("set_user_person", { personId: person.id });
    loadPeople();
    loadSources();
  }

  async function changeRelationship(personId: string, relationship: string) {
    await invoke("set_person_relationship", {
      personId,
      relationship: relationship === "" ? null : relationship,
    });
    loadPeople();
  }

  return (
    <div className="import">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileSelected}
        style={{ display: "none" }}
      />
      <div className="import-actions">
        {IMPORT_BUTTONS.map((b) => (
          <button
            key={b.command}
            disabled={busy}
            onClick={() => startImport(b.command, b.filters, b.needsUsername)}
          >
            {b.label}
          </button>
        ))}
      </div>

      {usernamePrompt && (
        <form className="import-username-prompt" onSubmit={confirmUsernamePrompt}>
          <p>¿De quién es este archivo? (usuario de Twitter/X, sin @)</p>
          <input
            autoFocus
            value={usernamePrompt.value}
            onChange={(e) => {
              const nextValue = e.currentTarget.value;
              setUsernamePrompt((p) => (p ? { ...p, value: nextValue } : p));
            }}
            placeholder="usuario"
          />
          <button type="submit" disabled={!usernamePrompt.value.trim()}>
            Continuar
          </button>
          <button type="button" onClick={() => setUsernamePrompt(null)}>
            Cancelar
          </button>
        </form>
      )}

      {busy && <p>Importando…</p>}
      {error && <p className="import-error">{error}</p>}

      {lastSummary && (
        <div className="import-summary">
          <p>
            {lastSummary.imported} mensajes importados, {lastSummary.duplicates} duplicados omitidos.
          </p>
          {lastSummary.participants.length > 0 && (
            <div className="import-who-am-i">
              <p>¿Cuál de estos participantes sos vos?</p>
              <p className="import-who-am-i-warning">
                Mientras no lo confirmes, estos mensajes no se van a usar para generar tu perfil, memorias ni
                contexto del chat.
              </p>
              <div className="import-participants">
                {lastSummary.participants.map((name) => {
                  const person = people.find((p) => p.name === name);
                  return (
                    <button
                      key={name}
                      className={person?.is_user ? "active" : ""}
                      onClick={() => markAsMe(name)}
                    >
                      {name}
                      {person?.is_user ? " ✓" : ""}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <h2>Fuentes importadas</h2>
      {sources.length === 0 && <p className="import-empty">Todavía no importaste nada.</p>}
      <div className="import-sources">
        {sources.map((s) => (
          <div key={s.id} className="import-source">
            <strong>{s.file_name ?? s.kind}</strong>
            <span>{s.kind}</span>
            <span>{s.message_count} mensajes</span>
            <span>{new Date(s.imported_at).toLocaleString()}</span>
          </div>
        ))}
      </div>

      <h2>Contactos</h2>
      {people.length === 0 && <p className="import-empty">Todavía no hay contactos detectados.</p>}
      <div className="import-people">
        {people
          .filter((p) => !p.is_user)
          .map((p) => (
            <div key={p.id} className="import-person">
              <strong>{p.name}</strong>
              {p.excluded && <span className="import-excluded-tag">excluido</span>}
              <span>{p.message_count} mensajes</span>
              <select
                value={p.relationship ?? ""}
                onChange={(e) => changeRelationship(p.id, e.currentTarget.value)}
              >
                <option value="">Sin clasificar</option>
                {RELATIONSHIP_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          ))}
      </div>
    </div>
  );
}
