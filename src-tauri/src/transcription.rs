use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::db::DbState;
use crate::settings;

/// Fixed allowlist of model names, mapped to the exact upstream file. Never
/// build this URL from an arbitrary name coming from the frontend — a
/// hardcoded map is the whole point, not an inconvenience.
const ALLOWED_MODELS: &[&str] = &["tiny", "base", "small", "medium"];

fn model_url(model: &str) -> String {
    format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{model}.bin")
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("whisper-models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn model_path(app: &AppHandle, model: &str) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(format!("ggml-{model}.bin")))
}

/// Cache of loaded whisper.cpp contexts, keyed by model name. Loading a
/// model from disk takes real time (hundreds of ms to seconds depending on
/// size), so this avoids re-loading it on every single transcription.
#[derive(Default)]
pub struct TranscriptionState(pub Mutex<HashMap<String, std::sync::Arc<WhisperContext>>>);

#[derive(Serialize)]
pub struct WhisperModelStatus {
    pub model: String,
    pub installed: bool,
}

#[tauri::command]
pub fn list_whisper_models(app: AppHandle) -> Result<Vec<WhisperModelStatus>, String> {
    let mut out = Vec::new();
    for &model in ALLOWED_MODELS {
        let installed = model_path(&app, model)?.exists();
        out.push(WhisperModelStatus {
            model: model.to_string(),
            installed,
        });
    }
    Ok(out)
}

/// Downloads one of the fixed allowlisted ggml models to the app's data
/// directory. Rejects anything not in `ALLOWED_MODELS` before it ever
/// touches the network.
#[tauri::command]
pub async fn download_whisper_model(app: AppHandle, model: String) -> Result<String, String> {
    if !ALLOWED_MODELS.contains(&model.as_str()) {
        return Err(format!(
            "modelo '{model}' no reconocido (opciones: {})",
            ALLOWED_MODELS.join(", ")
        ));
    }

    let dest = model_path(&app, &model)?;
    let url = model_url(&model);

    let client = reqwest::Client::new();
    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("no se pudo descargar el modelo: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("descarga del modelo respondió {}", res.status()));
    }

    let tmp_dest = dest.with_extension("part");
    {
        let mut file = std::fs::File::create(&tmp_dest).map_err(|e| e.to_string())?;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("descarga interrumpida: {e}"))?;
            std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
        }
    }
    std::fs::rename(&tmp_dest, &dest).map_err(|e| e.to_string())?;

    // Drop any cached in-memory context for this model: otherwise
    // `transcribe_audio` keeps serving the stale pre-redownload version
    // (e.g. if the previous file was corrupted) until the app restarts.
    if let Some(state) = app.try_state::<TranscriptionState>() {
        state.0.lock().map_err(|e| e.to_string())?.remove(&model);
    }

    Ok(model.clone())
}

/// Runs a full transcription pass over already-resampled 16kHz mono f32
/// samples (the frontend does the resampling via AudioContext — no audio
/// codec dependencies on the Rust side). Loading the model and running
/// inference both happen inside `spawn_blocking`: whisper.cpp is
/// synchronous, CPU-bound, and not `Send`-cheap to run directly on the
/// async runtime's worker threads.
#[tauri::command]
pub async fn transcribe_audio(
    app: AppHandle,
    db: State<'_, DbState>,
    samples: Vec<f32>,
) -> Result<String, String> {
    let model =
        settings::get_setting_from_db(db.inner(), "whisper_model", settings::DEFAULT_WHISPER_MODEL);

    if !ALLOWED_MODELS.contains(&model.as_str()) {
        return Err(format!("modelo configurado '{model}' no es válido"));
    }

    let path = model_path(&app, &model)?;
    if !path.exists() {
        return Err(format!(
            "el modelo '{model}' todavía no está descargado — andá a Configuración para bajarlo"
        ));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let ctx = {
            let state = app.state::<TranscriptionState>();
            let mut cache = state.0.lock().map_err(|e| e.to_string())?;
            if let Some(existing) = cache.get(&model) {
                existing.clone()
            } else {
                let loaded = WhisperContext::new_with_params(
                    path.to_str().ok_or("ruta de modelo inválida")?,
                    WhisperContextParameters::default(),
                )
                .map_err(|e| format!("no se pudo cargar el modelo de voz: {e}"))?;
                let loaded = std::sync::Arc::new(loaded);
                cache.insert(model.clone(), loaded.clone());
                loaded
            }
        };

        let mut whisper_state = ctx
            .create_state()
            .map_err(|e| format!("no se pudo iniciar la sesión de transcripción: {e}"))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(4);
        params.set_translate(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_language(None); // auto-detect, instead of forcing Spanish

        whisper_state
            .full(params, &samples)
            .map_err(|e| format!("no se pudo transcribir el audio: {e}"))?;

        let mut text = String::new();
        for i in 0..whisper_state.full_n_segments() {
            if let Some(segment) = whisper_state.get_segment(i) {
                if let Ok(segment_text) = segment.to_str() {
                    text.push_str(segment_text);
                }
            }
        }
        Ok(text.trim().to_string())
    })
    .await
    .map_err(|e| format!("la transcripción no terminó correctamente: {e}"))?
}
