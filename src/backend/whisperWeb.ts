import * as Comlink from "comlink";
import * as settings from "./settings";
import type { WhisperWorkerApi } from "./whisper.worker";

/** Web-build voice transcription, mirroring src-tauri/src/transcription.rs's
 * public API so Settings.tsx and Chat.tsx work unmodified on both builds.
 * See whisper.worker.ts for how the actual model runs. */

/** Same fixed allowlist as transcription.rs — never build a model id from
 * an arbitrary name coming from the frontend. */
const ALLOWED_MODELS = ["tiny", "base", "small", "medium"] as const;

function modelId(model: string): string {
  return `onnx-community/whisper-${model}`;
}

export interface WhisperModelStatus {
  model: string;
  installed: boolean;
}

let workerApi: Comlink.Remote<WhisperWorkerApi> | null = null;

function getWorker(): Comlink.Remote<WhisperWorkerApi> {
  if (!workerApi) {
    const worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
    workerApi = Comlink.wrap<WhisperWorkerApi>(worker);
  }
  return workerApi;
}

/** Asks the worker's actual model cache for each allowed model's status,
 * instead of a separately-tracked settings flag that could drift from
 * reality (e.g. after the browser evicts Cache Storage) — mirrors
 * transcription.rs checking `model_path(...).exists()` directly. */
export async function listWhisperModels(): Promise<WhisperModelStatus[]> {
  const worker = getWorker();
  return Promise.all(
    ALLOWED_MODELS.map(async (model) => ({ model, installed: await worker.isCached(modelId(model)) })),
  );
}

export async function downloadWhisperModel(model: string): Promise<string> {
  if (!(ALLOWED_MODELS as readonly string[]).includes(model)) {
    return Promise.reject(new Error(`modelo '${model}' no reconocido (opciones: ${ALLOWED_MODELS.join(", ")})`));
  }
  await getWorker().preload(modelId(model));
  return model;
}

export async function transcribeAudio(samples: number[]): Promise<string> {
  const model = await settings.getSettingFromDb("whisper_model", settings.DEFAULT_WHISPER_MODEL);
  if (!(ALLOWED_MODELS as readonly string[]).includes(model)) {
    throw new Error(`modelo configurado '${model}' no es válido`);
  }
  const worker = getWorker();
  if (!(await worker.isCached(modelId(model)))) {
    throw new Error(`el modelo '${model}' todavía no está descargado — andá a Configuración para bajarlo`);
  }
  return worker.transcribe(modelId(model), Float32Array.from(samples));
}
