import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Interview from "./Interview";
import Profile from "./Profile";
import Memory from "./Memory";
import Import from "./Import";
import Memories from "./Memories";
import Chat from "./Chat";
import Copilot from "./Copilot";
import Metrics from "./Metrics";
import Privacidad from "./Privacidad";
import Settings from "./Settings";
import SplashScreen from "./Splash";
import "./App.css";

type Screen =
  | "chat"
  | "interview"
  | "profile"
  | "memory"
  | "import"
  | "candidateMemories"
  | "copilot"
  | "metrics"
  | "privacidad"
  | "settings";

const ADVANCED_SCREENS: { key: Screen; label: string }[] = [
  { key: "import", label: "Importar" },
  { key: "interview", label: "Entrevista" },
  { key: "profile", label: "Perfil" },
  { key: "memory", label: "Memoria" },
  { key: "candidateMemories", label: "Memorias candidatas" },
  { key: "copilot", label: "Copiloto" },
  { key: "metrics", label: "Métricas" },
  { key: "privacidad", label: "Privacidad" },
  { key: "settings", label: "Configuración" },
];

function applyTheme(theme: string) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.setAttribute("data-theme", theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [screen, setScreen] = useState<Screen>("chat");
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  function loadSettings() {
    invoke<Record<string, string>>("get_settings").then((s) => {
      setOnboardingCompleted(s.onboarding_completed === "true");
      applyTheme(s.theme ?? "system");
    });
  }

  useEffect(loadSettings, []);

  if (showSplash) {
    return <SplashScreen onFinish={() => setShowSplash(false)} />;
  }

  const focusedMode = onboardingCompleted === true;

  return (
    <div className="app">
      <header className="app-header">
        <h1>Clonosaur</h1>
        <nav className="app-nav">
          <button className={screen === "chat" ? "active" : ""} onClick={() => setScreen("chat")}>
            Chat
          </button>
          {focusedMode ? (
            <button onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? "Ocultar opciones avanzadas" : "Opciones avanzadas"}
            </button>
          ) : (
            ADVANCED_SCREENS.map((s) => (
              <button key={s.key} className={screen === s.key ? "active" : ""} onClick={() => setScreen(s.key)}>
                {s.label}
              </button>
            ))
          )}
        </nav>
      </header>

      {focusedMode && showAdvanced && (
        <div className="app-advanced-bar">
          {ADVANCED_SCREENS.map((s) => (
            <button
              key={s.key}
              className={screen === s.key ? "active" : ""}
              onClick={() => {
                setScreen(s.key);
                setShowAdvanced(false);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      <main className="app-main">
        {screen === "chat" && <Chat />}
        {screen === "import" && <Import />}
        {screen === "interview" && <Interview />}
        {screen === "profile" && <Profile />}
        {screen === "memory" && <Memory />}
        {screen === "candidateMemories" && <Memories />}
        {screen === "copilot" && <Copilot />}
        {screen === "metrics" && <Metrics />}
        {screen === "privacidad" && <Privacidad />}
        {screen === "settings" && <Settings onSaved={loadSettings} />}
      </main>
    </div>
  );
}

export default App;
