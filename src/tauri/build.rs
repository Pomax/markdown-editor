fn main() {
    // Declare the app's commands here so they are deny-by-default: a
    // command is callable only when a capability grants its permission.
    // Each Phase 3 command is added to this list and to the capability.
    let attributes = tauri_build::Attributes::new()
        .capabilities_path_pattern("./src/tauri/capabilities/**/*")
        .windows_attributes(
            tauri_build::WindowsAttributes::new().window_icon_path("src/tauri/icons/icon.ico"),
        )
        .app_manifest(tauri_build::AppManifest::new().commands(&[
            "settings_get",
            "settings_set",
            "settings_get_all",
            "bridge_ready",
            "document_undo",
            "document_redo",
            "view_writing",
            "view_source2",
            "element_change_type",
            "element_format",
            "file_new",
            "file_load",
            "file_save",
            "file_save_as",
            "file_export_html",
            "file_set_unsaved_changes",
            "file_get_recent_files",
            "file_load_path",
            "image_browse",
            "image_rename",
            "path_to_relative",
            "window_minimum",
            "file_confirm_close",
            "dialog_confirm",
            "view_open_files_changed",
            "app_reload",
            "web_contents_reply",
            "context_menu",
            "tab_context_menu",
        ]));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
