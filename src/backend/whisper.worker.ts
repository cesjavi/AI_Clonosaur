import { pipeline, ModelRegistry, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import * as Comlink from "comlink";

/**
 * Runs entirely inside a dedicated Worker (WASM inference is CPU-heavy and
 * would otherwise block the UI thread, same reason db.worker.ts exists as
 * its own Worker). Mirrors src-tauri/src/transcription.rs: this is the web
 * build's answer to whisper.cpp — `@huggingface/transformers` runs the
 * actual Whisper model as ONNX via `onnxruntime-web` (WASM), fully
 * client-side, keeping the same "never leaves your machine" guarantee as
 * the desktop build. `device: "wasm"` pins it to CPU/WASM explicitly rather
 * than letting the library try WebGPU, so behavior is predictable across
 * browsers instead of depending on WebGPU support/quality.
 */

// One pipeline instance per model, cached the same reason
// TranscriptionState caches a loaded WhisperContext on desktop: loading a
// model (fetching + compiling the ONNX graph) takes real time.
const pipelines = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();

function loadPipeline(modelId: string): Promise<AutomaticSpeechRecognitionPipeline> {
  let promise = pipelines.get(modelId);
  if (!promise) {
    promise = pipeline("automatic-speech-recognition", modelId, {
      device: "wasm",
      dtype: "q8",
    }) as Promise<AutomaticSpeechRecognitionPipeline>;
    pipelines.set(modelId, promise);
  }
  return promise;
}

const api = {
  /** Triggers the model download (if not already cached by the browser)
   * and keeps the loaded pipeline around for subsequent calls — the
   * web-build equivalent of `download_whisper_model` actually fetching
   * the file, except here "downloaded" and "loaded" happen together. */
  async preload(modelId: string): Promise<void> {
    await loadPipeline(modelId);
  },

  /** Asks the browser's actual model cache whether every file this pipeline
   * needs is present, instead of trusting a separately-tracked "installed"
   * flag that can drift from it (e.g. after the browser evicts Cache Storage
   * under storage pressure) — the web-build equivalent of transcription.rs
   * checking `model_path(...).exists()` directly against the real thing. */
  async isCached(modelId: string): Promise<boolean> {
    if (pipelines.has(modelId)) return true;
    return ModelRegistry.is_cached(modelId, { dtype: "q8" });
  },

  async transcribe(modelId: string, samples: Float32Array): Promise<string> {
    const transcriber = await loadPipeline(modelId);
    // No `language` option: lets Whisper auto-detect it, same as desktop's
    // transcription.rs (see its own fix away from a hardcoded "es").
    const result = await transcriber(samples, { task: "transcribe" });
    const first = Array.isArray(result) ? result[0] : result;
    return (first?.text ?? "").trim();
  },
};

export type WhisperWorkerApi = typeof api;

Comlink.expose(api);
