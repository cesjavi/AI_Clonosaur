import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// Tauri's CLI sets this (and other TAURI_ENV_*) when it invokes this build
// as its `beforeBuildCommand`/`beforeDevCommand` — absent for a plain `vite
// build` (the standalone web deployment).
// @ts-expect-error process is a nodejs global
const isTauriBuild = process.env.TAURI_ENV_PLATFORM !== undefined;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    // Web build only (see docs/WEB_VERSION.md, Phase W6): a service worker
    // inside the Tauri desktop webview would risk serving stale cached
    // assets after the auto-updater replaces the app bundle on disk,
    // defeating the whole point of auto-update.
    ...(isTauriBuild
      ? []
      : [
          VitePWA({
            registerType: "autoUpdate",
            includeAssets: ["icon-192.png", "icon-512.png"],
            manifest: {
              name: "Clonosaur",
              short_name: "Clonosaur",
              description: "Agente personal local-first",
              theme_color: "#1a1a2e",
              background_color: "#1a1a2e",
              display: "standalone",
              start_url: "/",
              icons: [
                { src: "/icon-192.png", sizes: "256x256", type: "image/png" },
                { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
              ],
            },
            workbox: {
              // Precaches the SPA shell (JS/CSS/HTML) and wa-sqlite's .wasm
              // so the app opens and serves already-imported/-generated
              // data offline — chat/hybrid mode still need the network to
              // reach Ollama or an external provider either way, same as
              // online (see the "Done when" note in WEB_VERSION.md).
              //
              // `onnxruntime-web`'s inference engine (`ort-wasm-*.wasm`,
              // ~24MB — the WASM runtime itself, not the Whisper model
              // weights, which are fetched separately and cached by
              // `@huggingface/transformers` on first voice use) is
              // deliberately excluded: it's only ever needed once someone
              // actually uses the mic, and precaching 24MB on every install
              // would make "add to home screen" unreasonably slow for a
              // feature most sessions never touch.
              globPatterns: ["**/*.{js,css,html,wasm,png,svg,ico}"],
              globIgnores: ["**/ort-*.wasm"],
            },
          }),
        ]),
  ],

  // wa-sqlite's Emscripten loader (wa-sqlite.mjs) fetches its .wasm file
  // from a path relative to itself. Vite's dependency pre-bundling copies
  // the .mjs into node_modules/.vite/deps/ without its sibling .wasm,
  // breaking that lookup (the request silently falls back to Vite's SPA
  // index.html instead of 404ing, which is what actually failed here).
  // Excluding it from pre-bundling keeps both files together.
  optimizeDeps: {
    exclude: ["wa-sqlite"],
  },
  worker: {
    format: "es",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
