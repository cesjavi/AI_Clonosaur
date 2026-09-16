import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// The web build's WASM voice transcription (whisperWeb.ts + whisper.worker.ts,
// via @huggingface/transformers/onnxruntime-web) is only ever reached
// through invoke.ts's `!isTauri()` branch — the desktop app always uses the
// native whisper.cpp/Rust path (transcription.rs) instead. Vite still
// bundles the worker chunk and its ~24MB onnxruntime-web WASM runtime into
// dist/ because it's statically reachable from the shared invoke.ts, even
// though desktop never loads it at runtime. Tauri's bundler embeds the
// whole dist/ folder verbatim into the installer, so left alone this would
// add ~24MB of genuinely dead weight to every desktop install.
//
// Runs only as part of the Tauri build (see tauri.conf.json's
// beforeBuildCommand → "build:tauri") — the plain `npm run build` used for
// the standalone web deployment keeps these files, since it needs them.
const assetsDir = join(process.cwd(), "dist", "assets");
const patterns = [/^ort-.*\.wasm$/, /^whisper\.worker-.*\.js$/];

for (const file of readdirSync(assetsDir)) {
  if (patterns.some((p) => p.test(file))) {
    rmSync(join(assetsDir, file));
    console.log(`pruned ${file} (web-only whisper WASM runtime, unused on desktop)`);
  }
}
