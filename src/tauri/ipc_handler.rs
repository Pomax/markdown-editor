//! The Tauri commands the page calls through the bridge.

use std::sync::Mutex;

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::file_manager::FileManager;
use crate::settings_manager::SettingsManager;
use crate::web_contents::WebContents;

/// The managed settings store.
pub type Settings = Mutex<SettingsManager>;

/// The managed web-contents messaging state.
pub type WebContentsState = Mutex<WebContents>;

/// The managed file state.
pub type FileManagerState = Mutex<FileManager>;

/// A file named on the command line, held until the bridge is ready and
/// then sent to the renderer as a `file:loaded` menu action, once.
pub type PendingCliFile = Mutex<Option<Value>>;

/// The document stylesheets embedded for HTML export, in load order.
const EXPORT_CSS: [&str; 4] = [
    include_str!("../web/styles/main.css"),
    include_str!("../web/styles/editor.css"),
    include_str!("../web/styles/writing-view.css"),
    include_str!("../web/styles/image.css"),
];

/// Emits a `menu:action` event with `{ action, args }` to the page, or
/// queues it until the bridge reports ready for the current page.
pub fn emit_menu_action(
    window: &WebviewWindow,
    web_contents: &WebContentsState,
    action: &str,
    args: Vec<Value>,
) {
    emit_queued(
        window,
        web_contents,
        "menu:action",
        json!({ "action": action, "args": args }),
    );
}

/// Emits an event to the page now, or queues it until the bridge reports
/// ready for the current page.
fn emit_queued(
    window: &WebviewWindow,
    web_contents: &WebContentsState,
    event: &str,
    payload: Value,
) {
    let ready = web_contents
        .lock()
        .expect("web contents lock")
        .send(event, payload);
    if let Some((event, payload)) = ready {
        let _ = window.emit(&event, payload);
    }
}

/// `bridge_ready`: the bridge has subscribed to events for this page, so
/// flush the events and evaluations the backend queued before it was
/// ready, in the order they were requested.
#[tauri::command]
pub fn bridge_ready(window: WebviewWindow, web_contents: State<'_, WebContentsState>) {
    let (emits, evals) = web_contents.lock().expect("web contents lock").set_ready();
    for (event, payload) in emits {
        let _ = window.emit(&event, payload);
    }
    for (id, code) in evals {
        let _ = window.eval(crate::web_contents::wrap_eval(id, &code));
    }
}

/// `web_contents_reply`: the page's answer to an evaluation started with
/// `web_contents::execute_javascript`, as `{ ok, value }` or
/// `{ ok: false, error }`.
#[tauri::command]
pub fn web_contents_reply(id: u64, result: Value, web_contents: State<'_, WebContentsState>) {
    let outcome = if result["ok"] == true {
        Ok(result.get("value").cloned().unwrap_or(Value::Null))
    } else {
        Err(result["error"]
            .as_str()
            .unwrap_or("evaluation failed")
            .to_string())
    };
    web_contents
        .lock()
        .expect("web contents lock")
        .resolve(id, outcome);
}

/// `document:undo`: forwards an undo to the renderer.
#[tauri::command]
pub fn document_undo(window: WebviewWindow, web_contents: State<'_, WebContentsState>) -> Value {
    emit_menu_action(&window, &web_contents, "edit:undo", vec![]);
    json!({ "success": true })
}

/// `document:redo`: forwards a redo to the renderer.
#[tauri::command]
pub fn document_redo(window: WebviewWindow, web_contents: State<'_, WebContentsState>) -> Value {
    emit_menu_action(&window, &web_contents, "edit:redo", vec![]);
    json!({ "success": true })
}

/// `view:writing`: switches the renderer to writing view.
#[tauri::command]
pub fn view_writing(window: WebviewWindow, web_contents: State<'_, WebContentsState>) -> Value {
    emit_menu_action(&window, &web_contents, "view:writing", vec![]);
    json!({ "success": true })
}

/// `view:source2`: switches the renderer to source2 view.
#[tauri::command]
pub fn view_source2(window: WebviewWindow, web_contents: State<'_, WebContentsState>) -> Value {
    emit_menu_action(&window, &web_contents, "view:source2", vec![]);
    json!({ "success": true })
}

/// `element:changeType`: changes the current element's type.
#[tauri::command]
pub fn element_change_type(
    element_type: String,
    window: WebviewWindow,
    web_contents: State<'_, WebContentsState>,
) -> Value {
    emit_menu_action(
        &window,
        &web_contents,
        "element:changeType",
        vec![Value::String(element_type)],
    );
    json!({ "success": true })
}

/// `element:format`: applies formatting to the current selection.
#[tauri::command]
pub fn element_format(
    format: String,
    window: WebviewWindow,
    web_contents: State<'_, WebContentsState>,
) -> Value {
    emit_menu_action(
        &window,
        &web_contents,
        "element:format",
        vec![Value::String(format)],
    );
    json!({ "success": true })
}

/// Persists the recent files list to the settings database.
pub(crate) fn persist_recent(settings: &State<'_, Settings>, recent: &[String]) {
    let value = serde_json::to_value(recent).unwrap_or(Value::Null);
    settings
        .lock()
        .expect("settings lock")
        .set("recentFiles", &value);
}

/// Reveals a path in the operating system's file browser, recorded under
/// the test-hooks feature instead of opening a window.
#[cfg(feature = "test-hooks")]
fn reveal_item(_app: &AppHandle, path: &str) {
    crate::test_hooks::record_revealed_item(path);
}

/// Reveals a path in the operating system's file browser.
#[cfg(not(feature = "test-hooks"))]
fn reveal_item(_app: &AppHandle, path: &str) {
    let _ = tauri_plugin_opener::reveal_item_in_dir(std::path::PathBuf::from(path));
}

/// Shows an open-file dialog, or under the test-hooks feature records the
/// dialog and answers it from the stub.
#[cfg(feature = "test-hooks")]
pub(crate) fn show_open_dialog(_window: &WebviewWindow, options: Value) -> Option<String> {
    crate::test_hooks::record_file_dialog(options);
    crate::test_hooks::take_file_dialog_result()
}

/// Shows an open-file dialog and returns the chosen path.
#[cfg(not(feature = "test-hooks"))]
pub(crate) fn show_open_dialog(window: &WebviewWindow, options: Value) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut builder = window.dialog().file().set_parent(window);
    if let Some(title) = options.get("title").and_then(Value::as_str) {
        builder = builder.set_title(title);
    }
    builder = add_dialog_filters(builder, &options);
    builder.blocking_pick_file().and_then(file_path_to_string)
}

/// Shows a save-file dialog, or under the test-hooks feature records the
/// dialog and answers it from the stub.
#[cfg(feature = "test-hooks")]
fn show_save_dialog(_window: &WebviewWindow, options: Value) -> Option<String> {
    crate::test_hooks::record_file_dialog(options);
    crate::test_hooks::take_file_dialog_result()
}

/// Shows a save-file dialog and returns the chosen path.
#[cfg(not(feature = "test-hooks"))]
fn show_save_dialog(window: &WebviewWindow, options: Value) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut builder = window.dialog().file().set_parent(window);
    if let Some(title) = options.get("title").and_then(Value::as_str) {
        builder = builder.set_title(title);
    }
    if let Some(default) = options.get("defaultPath").and_then(Value::as_str) {
        builder = builder.set_file_name(default);
    }
    builder = add_dialog_filters(builder, &options);
    builder.blocking_save_file().and_then(file_path_to_string)
}

/// Adds the options' filters to a file dialog builder.
#[cfg(not(feature = "test-hooks"))]
fn add_dialog_filters(
    mut builder: tauri_plugin_dialog::FileDialogBuilder<tauri::Wry>,
    options: &Value,
) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let Some(filters) = options.get("filters").and_then(Value::as_array) else {
        return builder;
    };
    for filter in filters {
        let name = filter.get("name").and_then(Value::as_str).unwrap_or("");
        let extensions: Vec<String> = filter
            .get("extensions")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(name, &refs);
    }
    builder
}

/// Converts a chosen dialog path to a string, dropping non-filesystem
/// URLs.
#[cfg(not(feature = "test-hooks"))]
fn file_path_to_string(path: tauri_plugin_dialog::FilePath) -> Option<String> {
    path.into_path()
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

/// `file:new`: clears the current document and resets the renderer.
#[tauri::command]
pub fn file_new(
    window: WebviewWindow,
    web_contents: State<'_, WebContentsState>,
    file_manager: State<'_, FileManagerState>,
) -> Value {
    {
        let mut manager = file_manager.lock().expect("file manager lock");
        manager.current_file_path = None;
        manager.has_unsaved_changes = false;
    }
    emit_queued(&window, &web_contents, "document:reset", Value::Null);
    json!({ "success": true })
}

/// `file:setUnsavedChanges`: records whether the document has unsaved
/// changes.
#[tauri::command]
pub fn file_set_unsaved_changes(has_changes: bool, file_manager: State<'_, FileManagerState>) {
    file_manager
        .lock()
        .expect("file manager lock")
        .has_unsaved_changes = has_changes;
}

/// `file:getRecentFiles`: returns the recent files list.
#[tauri::command]
pub fn file_get_recent_files(file_manager: State<'_, FileManagerState>) -> Value {
    let files = file_manager
        .lock()
        .expect("file manager lock")
        .recent_files
        .clone();
    json!({ "success": true, "files": files })
}

/// `file:loadPath`: loads a file by path, without a dialog, and rebuilds
/// the menu when it loaded.
#[tauri::command]
pub fn file_load_path(file_path: String, app: AppHandle) -> Value {
    let result = load_path(&app, &file_path);
    if result["success"] == true {
        crate::menu_builder::refresh_menu(&app);
    }
    result
}

/// Loads a file by path: it becomes the
/// current file and moves to the front of the recent files, and a file
/// that fails to load is dropped from them.
pub(crate) fn load_path(app: &AppHandle, file_path: &str) -> Value {
    let file_manager = app.state::<FileManagerState>();
    match std::fs::read(file_path) {
        Ok(bytes) => {
            let content = crate::file_manager::read_utf8_lossy(&bytes);
            let recent = {
                let mut manager = file_manager.lock().expect("file manager lock");
                manager.current_file_path = Some(file_path.to_string());
                manager.has_unsaved_changes = false;
                crate::file_manager::add_recent(&mut manager.recent_files, file_path);
                manager.recent_files.clone()
            };
            persist_recent(&app.state::<Settings>(), &recent);
            json!({ "success": true, "content": content, "filePath": file_path })
        }
        Err(error) => {
            let recent = {
                let mut manager = file_manager.lock().expect("file manager lock");
                crate::file_manager::remove_recent(&mut manager.recent_files, file_path);
                manager.recent_files.clone()
            };
            persist_recent(&app.state::<Settings>(), &recent);
            json!({ "success": false, "message": format!("Failed to load file: {error}") })
        }
    }
}

/// `file:exportHtml`: writes the HTML and a default.css next to the
/// current document, then reveals the HTML file. When the HTML file
/// already exists, a box first asks whether to replace it, and Cancel
/// writes nothing. Takes the app handle rather than the managed state,
/// because an async command's future may not borrow it.
#[tauri::command]
pub async fn file_export_html(
    html: String,
    extra_css: String,
    window: WebviewWindow,
    app: AppHandle,
) -> Value {
    let current = app
        .state::<FileManagerState>()
        .lock()
        .expect("file manager lock")
        .current_file_path
        .clone();
    let Some(current) = current else {
        return json!({ "success": false, "message": "Save the document before exporting" });
    };
    let current = std::path::Path::new(&current);
    let html_path = crate::file_manager::export_html_path(current);
    let css_path = crate::file_manager::export_css_path(current);
    if html_path.exists() {
        let name = html_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let response = show_message_box(&window, &crate::message_box::export_replace_box(&name));
        if !crate::message_box::export_replaces(response) {
            return json!({ "success": false, "message": "Export canceled" });
        }
    }
    let sheets: Vec<String> = EXPORT_CSS.iter().map(|sheet| sheet.to_string()).collect();
    let css = crate::file_manager::assemble_css(&sheets, &extra_css);
    if let Err(error) = std::fs::write(&css_path, css) {
        return json!({ "success": false, "message": format!("Failed to export HTML: {error}") });
    }
    if let Err(error) = std::fs::write(&html_path, html) {
        return json!({ "success": false, "message": format!("Failed to export HTML: {error}") });
    }
    let html_path = html_path.to_string_lossy().into_owned();
    reveal_item(&app, &html_path);
    json!({ "success": true, "filePath": html_path })
}

/// `file:load`: opens a file dialog and loads the chosen markdown file.
/// Takes the app handle rather than the managed states, because an async
/// command's future may not borrow them.
#[tauri::command]
pub async fn file_load(window: WebviewWindow, app: AppHandle) -> Value {
    load_with_dialog(&window, &app)
}

/// Shows the Load dialog and loads the chosen file.
pub(crate) fn load_with_dialog(window: &WebviewWindow, app: &AppHandle) -> Value {
    let options = json!({
        "type": "open",
        "title": "Load Markdown File",
        "filters": [
            { "name": "Markdown Files", "extensions": ["md", "markdown"] },
            { "name": "All Files", "extensions": ["*"] }
        ],
        "properties": ["openFile"]
    });
    let Some(file_path) = show_open_dialog(window, options) else {
        return json!({ "success": false, "message": "Load canceled" });
    };
    match std::fs::read(&file_path) {
        Ok(bytes) => {
            let content = crate::file_manager::read_utf8_lossy(&bytes);
            let file_manager = app.state::<FileManagerState>();
            let recent = {
                let mut manager = file_manager.lock().expect("file manager lock");
                manager.current_file_path = Some(file_path.clone());
                manager.has_unsaved_changes = false;
                crate::file_manager::add_recent(&mut manager.recent_files, &file_path);
                manager.recent_files.clone()
            };
            persist_recent(&app.state::<Settings>(), &recent);
            json!({ "success": true, "content": content, "filePath": file_path })
        }
        Err(error) => {
            json!({ "success": false, "message": format!("Failed to load file: {error}") })
        }
    }
}

/// `file:save`: writes to the current file, or shows a Save As dialog
/// when no file is open, and rebuilds the menu when it saved.
#[tauri::command]
pub async fn file_save(content: String, window: WebviewWindow, app: AppHandle) -> Value {
    let result = save(content, &window, &app);
    if result["success"] == true {
        crate::menu_builder::refresh_menu(&app);
    }
    result
}

/// Writes to the current file, or falls back to Save As when there is
/// none.
pub(crate) fn save(content: String, window: &WebviewWindow, app: &AppHandle) -> Value {
    let current = app
        .state::<FileManagerState>()
        .lock()
        .expect("file manager lock")
        .current_file_path
        .clone();
    if let Some(path) = current {
        return match std::fs::write(&path, &content) {
            Ok(()) => {
                app.state::<FileManagerState>()
                    .lock()
                    .expect("file manager lock")
                    .has_unsaved_changes = false;
                json!({ "success": true, "filePath": path })
            }
            Err(error) => {
                json!({ "success": false, "message": format!("Failed to save file: {error}") })
            }
        };
    }
    save_as(content, window, app)
}

/// `file:saveAs`: shows a Save As dialog and writes the chosen file, and
/// rebuilds the menu when it saved.
#[tauri::command]
pub async fn file_save_as(content: String, window: WebviewWindow, app: AppHandle) -> Value {
    let result = save_as(content, &window, &app);
    if result["success"] == true {
        crate::menu_builder::refresh_menu(&app);
    }
    result
}

/// Shows a Save As dialog, writes the chosen file (appending `.md` when
/// it has no extension) and records it as the current file.
pub(crate) fn save_as(content: String, window: &WebviewWindow, app: &AppHandle) -> Value {
    let file_manager = app.state::<FileManagerState>();
    let default_path = file_manager
        .lock()
        .expect("file manager lock")
        .current_file_path
        .clone()
        .unwrap_or_else(|| "untitled.md".to_string());
    let options = json!({
        "type": "save",
        "title": "Save Markdown File",
        "defaultPath": default_path,
        "filters": [
            { "name": "Markdown Files", "extensions": ["md"] },
            { "name": "All Files", "extensions": ["*"] }
        ]
    });
    let Some(picked) = show_save_dialog(window, options) else {
        return json!({ "success": false, "message": "Save canceled" });
    };
    let file_path = crate::file_manager::save_as_path(&picked);
    match std::fs::write(&file_path, &content) {
        Ok(()) => {
            let recent = {
                let mut manager = file_manager.lock().expect("file manager lock");
                manager.current_file_path = Some(file_path.clone());
                manager.has_unsaved_changes = false;
                crate::file_manager::add_recent(&mut manager.recent_files, &file_path);
                manager.recent_files.clone()
            };
            persist_recent(&app.state::<Settings>(), &recent);
            json!({ "success": true, "filePath": file_path })
        }
        Err(error) => {
            json!({ "success": false, "message": format!("Failed to save file: {error}") })
        }
    }
}

/// Shows a message box and returns the index of the button chosen, or
/// under the test-hooks feature records the box and answers it from the
/// stub (its cancelId when no answer is set).
#[cfg(feature = "test-hooks")]
pub(crate) fn show_message_box(_window: &WebviewWindow, options: &Value) -> usize {
    crate::test_hooks::record_message_box(options.clone());
    let cancel_id = options.get("cancelId").and_then(Value::as_u64).unwrap_or(0) as usize;
    crate::message_box::resolve_response(crate::test_hooks::take_message_box_response(), cancel_id)
}

/// Shows a message box and returns the index of the button chosen.
#[cfg(not(feature = "test-hooks"))]
pub(crate) fn show_message_box(window: &WebviewWindow, options: &Value) -> usize {
    use crate::message_box::{button_labels, chosen_button, dialog_buttons};
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let labels = button_labels(options);
    let title = options.get("title").and_then(Value::as_str).unwrap_or("");
    let message = options.get("message").and_then(Value::as_str).unwrap_or("");
    let cancel_id = options.get("cancelId").and_then(Value::as_u64).unwrap_or(0) as usize;
    let kind = match options.get("type").and_then(Value::as_str) {
        Some("error") => MessageDialogKind::Error,
        Some("warning") => MessageDialogKind::Warning,
        _ => MessageDialogKind::Info,
    };
    let result = window
        .dialog()
        .message(message)
        .title(title)
        .kind(kind)
        .buttons(dialog_buttons(&labels))
        .parent(window)
        .blocking_show_with_result();
    chosen_button(&labels, &result, cancel_id)
}

/// `file:confirmClose`: the unsaved-changes prompt, returning the chosen
/// action.
#[tauri::command]
pub async fn file_confirm_close(window: WebviewWindow) -> Value {
    let response = show_message_box(&window, &crate::message_box::unsaved_changes_box());
    json!({ "action": crate::message_box::close_action(response) })
}

/// `dialog:confirm`: a confirmation prompt from the renderer, filling in
/// the defaults for any missing fields.
#[tauri::command]
pub async fn dialog_confirm(options: Value, window: WebviewWindow) -> Value {
    let normalized = json!({
        "type": options.get("type").and_then(Value::as_str).unwrap_or("warning"),
        "title": options.get("title").and_then(Value::as_str).unwrap_or("Confirm"),
        "message": options.get("message").and_then(Value::as_str).unwrap_or(""),
        "detail": options.get("detail").cloned().unwrap_or(Value::Null),
        "buttons": options
            .get("buttons")
            .cloned()
            .unwrap_or_else(|| json!(["OK", "Cancel"])),
        "defaultId": options.get("defaultId").and_then(Value::as_u64).unwrap_or(0),
        "cancelId": options.get("cancelId").and_then(Value::as_u64).unwrap_or(1)
    });
    let response = show_message_box(&window, &normalized);
    json!({ "response": response })
}

/// `image:browse`: opens a file dialog to choose an image.
#[tauri::command]
pub async fn image_browse(window: WebviewWindow) -> Value {
    let options = json!({
        "type": "open",
        "title": "Select Image",
        "filters": [
            {
                "name": "Images",
                "extensions": ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"]
            },
            { "name": "All Files", "extensions": ["*"] }
        ],
        "properties": ["openFile"]
    });
    match show_open_dialog(&window, options) {
        Some(file_path) => json!({ "success": true, "filePath": file_path }),
        None => json!({ "success": false }),
    }
}

/// `image:rename`: renames an image within its folder. The new name must
/// be a plain file name, and an existing target is refused.
#[tauri::command]
pub fn image_rename(old_path: String, new_name: String) -> Value {
    if !crate::image_path::is_plain_file_name(&new_name) {
        return json!({ "success": false, "message": "Invalid file name" });
    }
    match rename_image_on_disk(&old_path, &new_name) {
        Ok(new_path) => json!({ "success": true, "newPath": new_path }),
        Err(message) => json!({ "success": false, "message": message }),
    }
}

/// Renames an image on disk within its folder, as both image renames do.
fn rename_image_on_disk(old_path: &str, new_name: &str) -> Result<String, String> {
    crate::image_path::rename_image(
        old_path,
        new_name,
        |path| path.exists(),
        |from, to| std::fs::rename(from, to),
    )
}

/// `path:toRelative`: converts an image path to one relative to the
/// document when it sits at or below the document's folder.
#[tauri::command]
pub fn path_to_relative(image_path: String, document_path: String) -> String {
    crate::image_path::to_relative(&image_path, &document_path)
}

/// `view:openFilesChanged`: records the renderer's open files for the
/// View menu, makes the active one the current file, persists the list
/// so it survives an ungraceful exit, and rebuilds the menu.
#[tauri::command]
pub fn view_open_files_changed(files: Option<Value>, app: AppHandle) -> Value {
    let files: Vec<Value> = files
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let open_files = files.iter().map(open_file_entry).collect();
    {
        let state = app.state::<crate::menu_builder::MenuState>();
        let mut menu = state.lock().expect("menu lock");
        menu.open_files = open_files;
        menu.reported_files = files.clone();
    }
    if let Some(active) = files.iter().find(|file| file["active"] == true) {
        app.state::<FileManagerState>()
            .lock()
            .expect("file manager lock")
            .current_file_path = active["filePath"].as_str().map(str::to_string);
    }
    persist_open_files(&app.state::<Settings>(), &files);
    crate::menu_builder::refresh_menu(&app);
    json!({ "success": true })
}

/// An open file as the View menu lists it; a file without a label is
/// listed as Untitled.
fn open_file_entry(file: &Value) -> crate::menu_builder::OpenFile {
    crate::menu_builder::OpenFile {
        id: file["id"].as_str().unwrap_or_default().to_string(),
        label: file["label"].as_str().unwrap_or("Untitled").to_string(),
        active: file["active"] == true,
    }
}

/// Persists the open files that have a path. An empty list leaves the stored one alone, so a
/// previous session's files are not wiped before they can be restored.
fn persist_open_files(settings: &State<'_, Settings>, files: &[Value]) {
    let entries: Vec<Value> = files
        .iter()
        .filter(|file| {
            file["filePath"]
                .as_str()
                .is_some_and(|path| !path.is_empty())
        })
        .map(persisted_open_file)
        .collect();
    if !entries.is_empty() {
        settings
            .lock()
            .expect("settings lock")
            .set("openFiles", &Value::Array(entries));
    }
}

/// Saves the open files on close: the
/// ones the renderer last reported that have a path, or no setting at all
/// when none has.
pub fn save_open_files(app: &AppHandle) {
    let files = app
        .state::<crate::menu_builder::MenuState>()
        .lock()
        .expect("menu lock")
        .reported_files
        .clone();
    let entries: Vec<Value> = files
        .iter()
        .filter(|file| {
            file["filePath"]
                .as_str()
                .is_some_and(|path| !path.is_empty())
        })
        .map(persisted_open_file)
        .collect();
    let settings = app.state::<Settings>();
    let manager = settings.lock().expect("settings lock");
    if entries.is_empty() {
        manager.delete("openFiles");
    } else {
        manager.set("openFiles", &Value::Array(entries));
    }
}

/// One persisted open-files entry: the path, whether it was active, the
/// cursor offset, content hash and scroll position (zero when missing),
/// and the cursor and table-of-contents paths when present.
fn persisted_open_file(file: &Value) -> Value {
    let mut entry = json!({
        "filePath": file["filePath"],
        "cursorOffset": number_or_zero(&file["cursorOffset"]),
        "contentHash": number_or_zero(&file["contentHash"]),
        "scrollTop": number_or_zero(&file["scrollTop"]),
    });
    for key in ["active", "cursorPath", "tocHeadingPath"] {
        if !file[key].is_null() {
            entry[key] = file[key].clone();
        }
    }
    entry
}

/// The value, or zero when it is missing, as `?? 0` gave.
fn number_or_zero(value: &Value) -> Value {
    if value.is_null() {
        json!(0)
    } else {
        value.clone()
    }
}

/// `app:reload`: reloads the page.
#[tauri::command]
pub fn app_reload(app: AppHandle) -> Value {
    crate::menu_builder::handle_reload(&app);
    json!({ "success": true })
}

/// Shows the context menu at a point of the page, in CSS pixels, for a
/// right-click the page did not prevent.
#[tauri::command]
pub fn context_menu(x: f64, y: f64, window: WebviewWindow) {
    crate::menu_builder::show_context_menu(&window, x, y);
}

/// `settings:get`: returns `{ success, value? }`, omitting value when the
/// key is absent and keeping a stored null.
#[tauri::command]
pub fn settings_get(key: String, settings: State<'_, Settings>) -> Value {
    let manager = settings.lock().expect("settings lock");
    match manager.get(&key) {
        Some(value) => json!({ "success": true, "value": value }),
        None => json!({ "success": true }),
    }
}

/// `settings:set`: stores a value and returns `{ success }`.
#[tauri::command]
pub fn settings_set(key: String, value: Value, settings: State<'_, Settings>) -> Value {
    settings.lock().expect("settings lock").set(&key, &value);
    json!({ "success": true })
}

/// `settings:getAll`: returns `{ success, settings }`.
#[tauri::command]
pub fn settings_get_all(settings: State<'_, Settings>) -> Value {
    let all = settings.lock().expect("settings lock").get_all();
    json!({ "success": true, "settings": all })
}
