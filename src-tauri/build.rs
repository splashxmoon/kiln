fn main() {
    // Declaring the app commands generates `allow-<command>` permissions, so each
    // command must be granted explicitly in capabilities/default.json.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "list_files",
            "load_file",
            "save_file",
            "delete_file",
            "reveal_files_folder",
            "export_to_folder",
            "agent_register_tools",
            "agent_respond",
            "agent_status",
            "agent_cli_detect",
            "agent_cli_run",
            "agent_cli_cancel",
            "agent_cli_connect",
            "agent_cli_connect_snippets",
            "clipboard_read_text",
            "list_projects",
            "create_project",
            "update_project",
            "remove_project",
            "move_file",
            "list_trash",
            "restore_trash",
            "purge_trash",
            "agent_cli_models",
        ]),
    ))
    .expect("failed to run tauri-build");
}
