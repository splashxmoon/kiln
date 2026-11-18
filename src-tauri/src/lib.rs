mod agent;
mod clipboard;
mod clis;
mod mcp;
mod storage;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use agent::{AgentHub, SharedHub, EVENT_CALL};
use clis::SharedRuns;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hub: SharedHub = Arc::new(AgentHub::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(hub.clone())
        .manage(SharedRuns::default())
        .setup(move |app| {
            let handle = app.handle().clone();
            hub.set_emitter(Box::new(move |event, payload| {
                // Tool calls go to the main window (which owns the canvas);
                // activity events are broadcast so any UI can show them.
                let res = if event == EVENT_CALL {
                    handle.emit_to("main", event, payload)
                } else {
                    handle.emit(event, payload)
                };
                res.map_err(|e| e.to_string())
            }));
            tauri::async_runtime::spawn(mcp::serve(hub.clone()));
            // Warm the login-shell PATH used to find agent CLIs (can take a few seconds).
            std::thread::spawn(|| {
                clis::agent_path();
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            storage::list_files,
            storage::load_file,
            storage::save_file,
            storage::delete_file,
            storage::list_projects,
            storage::create_project,
            storage::update_project,
            storage::remove_project,
            storage::move_file,
            storage::list_trash,
            storage::restore_trash,
            storage::purge_trash,
            storage::reveal_files_folder,
            storage::export_to_folder,
            agent::agent_register_tools,
            agent::agent_respond,
            agent::agent_status,
            clis::agent_cli_detect,
            clis::agent_cli_models,
            clis::agent_cli_run,
            clis::agent_cli_cancel,
            clis::agent_cli_connect,
            clis::agent_cli_connect_snippets,
            clipboard::clipboard_read_text,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Kiln")
        .run(|app, event| {
            // Agent CLIs run in their own process groups, so they would outlive Kiln.
            if let tauri::RunEvent::Exit = event {
                app.state::<SharedRuns>().kill_all();
            }
        });
}
