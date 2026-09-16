import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Manual harness for Phase W1 (SQLite in OPFS) — see src/backend/dbTest.ts.
// Dev-only: gated on import.meta.env.DEV so a stray "?dbtest" query string
// (tracker, link shortener, bookmark) can never replace the app in a
// production build.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("dbtest")) {
  import("./backend/dbTest").then((m) => m.runDbTest());
} else {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
