import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Profile.css";

interface ProfileTrait {
  id: string;
  category: string;
  trait_name: string;
  value: string;
  source: string;
  evidence: string | null;
  created_at: string;
  updated_at: string;
}

type Generator = "values" | "decisions" | "tone" | null;

export default function Profile() {
  const [traits, setTraits] = useState<ProfileTrait[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState("");
  const [traitName, setTraitName] = useState("");
  const [value, setValue] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Generator>(null);
  const [genError, setGenError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    invoke<ProfileTrait[]>("list_profile_traits")
      .then(setTraits)
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  function resetForm() {
    setCategory("");
    setTraitName("");
    setValue("");
    setEditingId(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!category.trim() || !traitName.trim() || !value.trim()) return;

    if (editingId) {
      await invoke("update_profile_trait", {
        id: editingId,
        category,
        traitName: traitName,
        value,
      });
    } else {
      await invoke("create_profile_trait", {
        category,
        traitName: traitName,
        value,
      });
    }
    resetForm();
    load();
  }

  function startEdit(t: ProfileTrait) {
    setEditingId(t.id);
    setCategory(t.category);
    setTraitName(t.trait_name);
    setValue(t.value);
  }

  async function remove(id: string) {
    await invoke("delete_profile_trait", { id });
    if (editingId === id) resetForm();
    load();
  }

  async function runGenerator(generator: Generator, command: string) {
    setBusy(generator);
    setGenError(null);
    try {
      const created = await invoke<number>(command);
      if (created === 0) {
        setGenError("No se generó nada nuevo (sin evidencia suficiente todavía, o ya existía).");
      }
      load();
    } catch (e) {
      setGenError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const grouped = traits.reduce<Record<string, ProfileTrait[]>>((acc, t) => {
    (acc[t.category] ??= []).push(t);
    return acc;
  }, {});

  return (
    <div className="profile">
      <div className="profile-generators">
        <button disabled={busy !== null} onClick={() => runGenerator("values", "generate_values")}>
          {busy === "values" ? "Generando…" : "Generar valores"}
        </button>
        <button disabled={busy !== null} onClick={() => runGenerator("decisions", "generate_decisions")}>
          {busy === "decisions" ? "Generando…" : "Generar patrones de decisión"}
        </button>
        <button disabled={busy !== null} onClick={() => runGenerator("tone", "generate_tone")}>
          {busy === "tone" ? "Generando…" : "Generar tono por contexto"}
        </button>
      </div>
      {genError && <p className="profile-gen-error">{genError}</p>}

      <div className="profile-body">
      <form className="profile-form" onSubmit={handleSubmit}>
        <h2>{editingId ? "Editar rasgo" : "Nuevo rasgo de perfil"}</h2>
        <input
          placeholder="Categoría (ej. valores, gustos, estilo)"
          value={category}
          onChange={(e) => setCategory(e.currentTarget.value)}
        />
        <input
          placeholder="Rasgo (ej. 'sentido del humor')"
          value={traitName}
          onChange={(e) => setTraitName(e.currentTarget.value)}
        />
        <textarea
          placeholder="Valor / descripción"
          rows={2}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
        />
        <div className="profile-form-actions">
          <button type="submit">{editingId ? "Guardar cambios" : "Agregar"}</button>
          {editingId && (
            <button type="button" onClick={resetForm}>
              Cancelar
            </button>
          )}
        </div>
      </form>

      <div className="profile-list">
        {loading && <p>Cargando perfil…</p>}
        {!loading && traits.length === 0 && (
          <p className="profile-empty">Todavía no hay rasgos de perfil guardados.</p>
        )}
        {Object.entries(grouped).map(([cat, items]) => (
          <div key={cat} className="profile-category">
            <h3>{cat}</h3>
            {items.map((t) => (
              <div key={t.id} className="profile-trait">
                <div>
                  <strong>{t.trait_name}</strong>
                  <p>{t.value}</p>
                  {t.evidence && <p className="profile-evidence">Evidencia: "{t.evidence}"</p>}
                  <span className="profile-source">{t.source}</span>
                </div>
                <div className="profile-trait-actions">
                  <button onClick={() => startEdit(t)}>Editar</button>
                  <button onClick={() => remove(t.id)}>Borrar</button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}
