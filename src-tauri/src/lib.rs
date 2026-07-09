mod candidate_memories;
mod chat;
mod contradiction_detector;
mod copilot;
mod db;
mod decision_model;
mod deletion;
mod discord_import;
mod feedback;
mod generic_import;
mod gmail_import;
mod hybrid;
mod import_common;
mod interview;
mod llm;
mod memory;
mod metrics;
mod profile;
mod reddit_import;
mod sensitivity;
mod sessions;
mod settings;
mod sources;
mod tone_model;
mod twitter_import;
mod values_model;
mod whatsapp;

use db::DbState;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let conn = db::init_db(app.handle());
            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            interview::get_interview_answers,
            interview::save_interview_answer,
            profile::list_profile_traits,
            profile::create_profile_trait,
            profile::update_profile_trait,
            profile::delete_profile_trait,
            memory::get_embedding_coverage,
            memory::generate_embeddings,
            memory::search_memory,
            feedback::record_feedback,
            whatsapp::import_whatsapp_file,
            generic_import::import_generic_file,
            gmail_import::import_gmail_file,
            twitter_import::import_twitter_file,
            discord_import::import_discord_file,
            reddit_import::import_reddit_file,
            sources::list_sources,
            sources::list_people,
            sources::set_user_person,
            sources::set_person_relationship,
            sources::set_person_excluded,
            candidate_memories::list_memories,
            candidate_memories::update_memory_status,
            candidate_memories::generate_candidate_memories,
            contradiction_detector::detect_contradictions,
            values_model::generate_values,
            decision_model::generate_decisions,
            tone_model::generate_tone,
            chat::ollama_chat,
            chat::chat_with_memory,
            chat::send_chat_stream,
            sessions::create_session,
            sessions::close_session,
            sessions::list_chat_turns,
            hybrid::default_base_url,
            hybrid::save_provider_credentials,
            hybrid::get_provider_credentials,
            hybrid::build_hybrid_preview,
            hybrid::send_to_external_provider,
            hybrid::list_external_send_log,
            copilot::generate_draft,
            copilot::list_drafts,
            copilot::update_draft_status,
            metrics::get_metrics,
            deletion::delete_by_source,
            deletion::delete_by_contact,
            deletion::delete_by_date_range,
            settings::get_settings,
            settings::update_setting,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
