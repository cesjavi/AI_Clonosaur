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
/** Only populated once `loadPipeline` actually resolves, so an in-progress or
 * failed download never makes `isCached()` falsely report `true`. */
const loadedPipelines = new Set<string>();

function loadPipeline(modelId: string): Promise<AutomaticSpeechRecognitionPipeline> {
  let promise = pipelines.get(modelId);
  if (!promise) {
    promise = (
      pipeline("automatic-speech-recognition", modelId, {
        device: "wasm",
        dtype: "q8",
      }) as Promise<AutomaticSpeechRecognitionPipeline>
    ).then(
      (instance) => {
        loadedPipelines.add(modelId);
        return instance;
      },
      (err) => {
        // Evict failed promises so retries work after transient network errors.
        pipelines.delete(modelId);
        loadedPipelines.delete(modelId);
        throw err;
      },
    );
    pipelines.set(modelId, promise);
  }
  return promise;
}

async function isCachedOfflineFallback(modelId: string): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    const cache = await caches.open("transformers-cache");
    const keys = await cache.keys();
    let hasConfig = false;
    let hasOnnx = false;
    for (const req of keys) {
      if (!req.url.includes(modelId)) continue;
      if (req.url.endsWith("/config.json")) hasConfig = true;
      if (req.url.endsWith(".onnx")) hasOnnx = true;
      if (hasConfig && hasOnnx) return true;
    }
  } catch {
    return false;
  }
  return false;
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
   * needs is present, falling back to Cache Storage inspection when offline
   * (since `ModelRegistry.is_cached` queries metadata over the network). */
  async isCached(modelId: string): Promise<boolean> {
    if (loadedPipelines.has(modelId)) return true;
    try {
      return await ModelRegistry.is_cached(modelId, { dtype: "q8", device: "wasm" });
    } catch {
      return isCachedOfflineFallback(modelId);
    }
  },

  async transcribe(modelId: string, samples: Float32Array): Promise<string> {
    const transcriber = await loadPipeline(modelId);
    // Chunked decoding (`chunk_length_s: 30`) prevents silently truncating
    // voice notes longer than Whisper's 30-second window.
    const result = await transcriber(samples, {
      task: "transcribe",
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const first = Array.isArray(result) ? result[0] : result;
    return (first?.text ?? "").trim();
  },
};

export type WhisperWorkerApi = typeof api;

Comlink.expose(api);
