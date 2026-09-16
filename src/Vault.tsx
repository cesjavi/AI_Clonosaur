import { useState } from "react";
import { invoke } from "./backend/invoke";
import "./Vault.css";

interface VaultStatus {
  configured: boolean;
  locked: boolean;
}

interface UnlockScreenProps {
  onUnlocked: () => void;
}

export function UnlockScreen({ onUnlocked }: UnlockScreenProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await invoke("unlock_vault", { password });
      onUnlocked();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vault-lock-screen">
      <form onSubmit={unlock}>
        <h1>Clonosaur está bloqueado</h1>
        <p>Ingresá tu contraseña maestra para descifrar tu base local.</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          placeholder="Contraseña maestra"
          autoFocus
        />
        <button type="submit" disabled={busy || !password}>
          {busy ? "Descifrando…" : "Desbloquear"}
        </button>
        {error && <p className="vault-error">{error}</p>}
        <p className="vault-hint">No hay forma de recuperar esta contraseña si la olvidás.</p>
      </form>
    </div>
  );
}

interface VaultSecurityProps {
  status: VaultStatus;
  onStatusChange: () => void;
}

export function VaultSecurity({ status, onStatusChange }: VaultSecurityProps) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [lockPassword, setLockPassword] = useState("");
  const [showLockForm, setShowLockForm] = useState(false);
  const [resetPhrase, setResetPhrase] = useState("");
  const [showResetForm, setShowResetForm] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function setupPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (newPassword !== confirmPassword) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setBusy(true);
    try {
      await invoke("setup_master_password", { password: newPassword });
      setNewPassword("");
      setConfirmPassword("");
      setMessage("Contraseña maestra configurada. La base queda cifrada la próxima vez que la bloquees.");
      onStatusChange();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doLock(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await invoke("lock_vault", { password: lockPassword });
      window.location.reload();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  async function doReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await invoke("reset_database", { confirmation: resetPhrase });
      window.location.reload();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  return (
    <div className="vault-security">
      <h2>Seguridad</h2>
      {message && <p className="vault-message">{message}</p>}
      {error && <p className="vault-error">{error}</p>}

      {!status.configured && (
        <form className="vault-form" onSubmit={setupPassword}>
          <p className="vault-hint">
            Todavía no configuraste una contraseña maestra: tu base vive sin cifrar en disco. Esto la cifra
            (AES-256-GCM + Argon2id) para que solo se pueda leer con esta contraseña. No hay forma de
            recuperarla si la olvidás.
          </p>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.currentTarget.value)}
            placeholder="Nueva contraseña maestra (mínimo 8 caracteres)"
          />
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.currentTarget.value)}
            placeholder="Repetir contraseña"
          />
          <button type="submit" disabled={busy || !newPassword}>
            Configurar contraseña maestra
          </button>
        </form>
      )}

      {status.configured && (
        <div className="vault-configured">
          <p className="vault-hint">Cifrado en reposo activado.</p>

          {!showLockForm ? (
            <button onClick={() => setShowLockForm(true)}>Bloquear ahora</button>
          ) : (
            <form className="vault-form" onSubmit={doLock}>
              <input
                type="password"
                value={lockPassword}
                onChange={(e) => setLockPassword(e.currentTarget.value)}
                placeholder="Contraseña maestra"
                autoFocus
              />
              <button type="submit" disabled={busy || !lockPassword}>
                Confirmar bloqueo
              </button>
              <button type="button" onClick={() => setShowLockForm(false)}>
                Cancelar
              </button>
            </form>
          )}
        </div>
      )}

      <div className="vault-danger">
        <h3>Zona de riesgo</h3>
        {!showResetForm ? (
          <button className="vault-danger-button" onClick={() => setShowResetForm(true)}>
            Borrar toda la base y empezar de cero
          </button>
        ) : (
          <form className="vault-form" onSubmit={doReset}>
            <p className="vault-hint">
              Esto borra permanentemente todo: mensajes, perfil, memorias, configuración. Escribí exactamente{" "}
              <strong>ELIMINAR TODO</strong> para confirmar.
            </p>
            <input
              value={resetPhrase}
              onChange={(e) => setResetPhrase(e.currentTarget.value)}
              placeholder="ELIMINAR TODO"
            />
            <button className="vault-danger-button" type="submit" disabled={busy || resetPhrase !== "ELIMINAR TODO"}>
              Confirmar borrado total
            </button>
            <button type="button" onClick={() => setShowResetForm(false)}>
              Cancelar
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
