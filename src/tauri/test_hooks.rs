//! Test hook channel, compiled only with the `test-hooks` feature.
//!
//! Reads one JSON request per line from stdin and writes one tagged JSON
//! reply per line to stdout, outside the page, so the Playwright tests can
//! drive the backend. Each
//! reply line is prefixed with a tag so the app's own logging is ignored.

use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, Manager};

/// Prefix marking a hook reply line on stdout.
const TAG: &str = "__HOOK__";

/// URLs that would have gone to the system browser, recorded instead of
/// opened so a test can read them back.
static OPENED_URLS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Items that would have been revealed in the OS file browser, recorded
/// instead of opened.
static REVEALED_ITEMS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// File dialogs shown so far, recorded with the options they were given.
static FILE_DIALOGS: Mutex<Vec<Value>> = Mutex::new(Vec::new());

/// The answer for the next file dialog: `Some(Some(path))` chooses a
/// path, `Some(None)` cancels, and `None` (no stub set) also cancels.
static FILE_DIALOG_RESULT: Mutex<Option<Option<String>>> = Mutex::new(None);

/// Message boxes shown so far, recorded with the options they were given.
static MESSAGE_BOXES: Mutex<Vec<Value>> = Mutex::new(Vec::new());

/// The button index to answer the next message box with, or `None` to
/// close the box (returning its cancelId).
static MESSAGE_BOX_RESPONSE: Mutex<Option<usize>> = Mutex::new(None);

/// Keystrokes the Windows Cut, Copy and Paste items would have sent,
/// recorded instead of sent.
static SENT_KEYSTROKES: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Records a keystroke that would have been sent to the focused window.
pub fn record_keystroke(keys: &str) {
    if let Ok(mut keystrokes) = SENT_KEYSTROKES.lock() {
        keystrokes.push(keys.to_string());
    }
}

/// The points of the page, in CSS pixels, WebView2's own Inspect command
/// was run at.
static INSPECTIONS: Mutex<Vec<(f64, f64)>> = Mutex::new(Vec::new());

/// Records a point WebView2's own Inspect command was run at.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn record_inspection(x: f64, y: f64) {
    if let Ok(mut points) = INSPECTIONS.lock() {
        points.push((x, y));
    }
}

/// An entry of a context menu: its label (none for a separator), its id,
/// and whether it is enabled.
pub type ContextEntry = (Option<String>, String, bool);

/// A context menu that would have popped up: the point of the page it
/// was asked for at, and its entries.
type ContextMenu = (f64, f64, Vec<ContextEntry>);

/// Context menus that would have popped up, recorded instead.
static CONTEXT_MENUS: Mutex<Vec<ContextMenu>> = Mutex::new(Vec::new());

/// Records a context menu that would have popped up at a point of the page.
pub fn record_context_menu(x: f64, y: f64, entries: Vec<ContextEntry>) {
    if let Ok(mut menus) = CONTEXT_MENUS.lock() {
        menus.push((x, y, entries));
    }
}

/// The recorded context menus: where each was asked for, and its items.
fn describe_context_menus() -> Value {
    let Ok(menus) = CONTEXT_MENUS.lock() else {
        return Value::Array(Vec::new());
    };
    menus
        .iter()
        .map(|(x, y, entries)| {
            let items: Vec<Value> = entries
                .iter()
                .map(|(label, _, enabled)| match label {
                    Some(label) => json!({ "label": label, "enabled": enabled }),
                    None => json!({ "type": "separator" }),
                })
                .collect();
            json!({ "x": x, "y": y, "items": items })
        })
        .collect()
}

/// Chooses the enabled item with the given label in the last recorded
/// context menu, as a click on it does. Returns whether there was such an
/// item; a disabled item cannot be chosen.
fn click_context_item(app: &AppHandle, label: &str) -> bool {
    let id = CONTEXT_MENUS.lock().ok().and_then(|menus| {
        menus.last().and_then(|(_, _, entries)| {
            entries
                .iter()
                .find(|(entry, _, enabled)| *enabled && entry.as_deref() == Some(label))
                .map(|(_, id, _)| id.clone())
        })
    });
    match id {
        Some(id) => {
            crate::menu_builder::handle_menu_event(app, &id);
            true
        }
        None => false,
    }
}

/// Native menu items built, changed or removed since the count was last
/// read.
static MENU_CHANGES: AtomicUsize = AtomicUsize::new(0);

/// Records native menu items built, changed or removed.
pub fn record_menu_changes(count: usize) {
    MENU_CHANGES.fetch_add(count, Ordering::SeqCst);
}

/// Whether DevTools is open. WebView2 cannot report this, so on Windows
/// the hook asks the test build's DevTools endpoint whether a DevTools
/// front end is among its targets.
fn devtools_open(app: &AppHandle) -> bool {
    if cfg!(windows) {
        if let Ok(port) = std::env::var("TESTING_DEVTOOLS_PORT") {
            return devtools_front_end_listed(&port);
        }
    }
    app.get_webview_window("main")
        .is_some_and(|window| window.is_devtools_open())
}

/// Whether the DevTools endpoint on the port lists a target whose URL is
/// a DevTools front end. The endpoint keeps the connection open, so the
/// body is read by its Content-Length, with a timeout as a guard.
fn devtools_front_end_listed(port: &str) -> bool {
    use std::io::Read;
    let Ok(mut stream) = std::net::TcpStream::connect(format!("127.0.0.1:{port}")) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
    let request = format!("GET /json/list HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut reader = std::io::BufReader::new(stream);
    let mut content_length = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return false;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0; content_length];
    if reader.read_exact(&mut body).is_err() {
        return false;
    }
    serde_json::from_slice::<Vec<Value>>(&body)
        .map(|targets| {
            targets.iter().any(|target| {
                target["url"]
                    .as_str()
                    .is_some_and(|url| url.starts_with("devtools://"))
            })
        })
        .unwrap_or(false)
}

/// The label path named in a request's `labels` parameter.
fn labels_param(params: &Value) -> Vec<String> {
    params
        .get("labels")
        .and_then(Value::as_array)
        .map(|labels| {
            labels
                .iter()
                .filter_map(|label| label.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Records a URL that would have been opened in the system browser.
pub fn record_opened_url(url: &str) {
    if let Ok(mut urls) = OPENED_URLS.lock() {
        urls.push(url.to_string());
    }
}

/// Records a path that would have been revealed in the OS file browser.
pub fn record_revealed_item(path: &str) {
    if let Ok(mut items) = REVEALED_ITEMS.lock() {
        items.push(path.to_string());
    }
}

/// Records a file dialog with the options it was shown with.
pub fn record_file_dialog(dialog: Value) {
    if let Ok(mut dialogs) = FILE_DIALOGS.lock() {
        dialogs.push(dialog);
    }
}

/// Takes the stubbed answer for the next file dialog, cancelling when no
/// path was set.
pub fn take_file_dialog_result() -> Option<String> {
    match FILE_DIALOG_RESULT.lock() {
        Ok(mut result) => result.take().flatten(),
        Err(_) => None,
    }
}

/// Records a message box with the options it was shown with.
pub fn record_message_box(message_box: Value) {
    if let Ok(mut boxes) = MESSAGE_BOXES.lock() {
        boxes.push(message_box);
    }
}

/// Takes the stubbed button index for the next message box.
pub fn take_message_box_response() -> Option<usize> {
    match MESSAGE_BOX_RESPONSE.lock() {
        Ok(mut response) => response.take(),
        Err(_) => None,
    }
}

/// Starts the hook reader on a background thread.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let Ok(request) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let id = request.get("id").cloned().unwrap_or(Value::Null);
            let method = request.get("method").and_then(Value::as_str).unwrap_or("");
            let params = request.get("params").cloned().unwrap_or(Value::Null);
            if matches!(method, "page.evaluate" | "input" | "windowState") {
                let app = app.clone();
                let method = method.to_string();
                std::thread::spawn(move || match waiting_hook(&app, &method, &params) {
                    Ok(result) => respond(&id, result),
                    Err(error) => respond_error(&id, &error),
                });
                continue;
            }
            let result = dispatch(&app, method, &params);
            respond(&id, result);
        }
    });
}

/// Handles a hook that waits for the page or the main thread, which runs
/// on a thread of its own so other hooks can be answered meanwhile.
fn waiting_hook(app: &AppHandle, method: &str, params: &Value) -> Result<Value, String> {
    if method == "input" {
        return run_input(app, params);
    }
    if method == "windowState" {
        return window_state_on_main_thread(app);
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "the app has no window".to_string())?;
    let expression = params
        .get("expression")
        .and_then(Value::as_str)
        .unwrap_or("undefined");
    let web_contents = app.state::<crate::ipc_handler::WebContentsState>();
    crate::web_contents::execute_javascript(&window, web_contents.inner(), expression)
}

/// Runs one input command in the app's process.
#[cfg(target_os = "macos")]
fn run_input(app: &AppHandle, params: &Value) -> Result<Value, String> {
    crate::mac_input::run(app, params)
}

/// Input through the hook channel exists on macOS only.
#[cfg(not(target_os = "macos"))]
fn run_input(_app: &AppHandle, _params: &Value) -> Result<Value, String> {
    Err("the input hook works on macOS only".to_string())
}

/// Handles one hook request and returns its result. Unknown hooks return
/// null until their Phase 3 step implements them.
fn dispatch(app: &AppHandle, method: &str, params: &Value) -> Value {
    match method {
        "windowCount" => json!(app.webview_windows().len()),
        "setWindowBounds" => {
            if let Some(window) = app.get_webview_window("main") {
                set_window_bounds(&window, params.get("bounds").unwrap_or(&Value::Null));
            }
            json!(true)
        }
        "maximize" => {
            maximize(app);
            json!(true)
        }
        "requestClose" => {
            if params.get("testing").and_then(Value::as_bool) == Some(false) {
                crate::use_close_flow();
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
            json!(true)
        }
        "saveOpenFiles" => {
            crate::ipc_handler::save_open_files(app);
            json!(true)
        }
        "restoreOpenFiles" => {
            let entries = params
                .get("entries")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            crate::restore_open_files(app, &entries);
            json!(true)
        }
        "settings.get" => {
            let key = params.get("key").and_then(Value::as_str).unwrap_or("");
            app.state::<crate::ipc_handler::Settings>()
                .lock()
                .expect("settings lock")
                .get(key)
                .unwrap_or(Value::Null)
        }
        "settings.set" => {
            let key = params.get("key").and_then(Value::as_str).unwrap_or("");
            let value = params.get("value").cloned().unwrap_or(Value::Null);
            app.state::<crate::ipc_handler::Settings>()
                .lock()
                .expect("settings lock")
                .set(key, &value);
            json!(true)
        }
        "close" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
            json!(true)
        }
        "recordOpenedUrls" => {
            if let Ok(mut urls) = OPENED_URLS.lock() {
                urls.clear();
            }
            json!(true)
        }
        "openedUrl" => match OPENED_URLS.lock() {
            Ok(urls) => urls.last().cloned().map(Value::from).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        },
        "recordRevealedItems" => {
            if let Ok(mut items) = REVEALED_ITEMS.lock() {
                items.clear();
            }
            json!(true)
        }
        "revealedItem" => match REVEALED_ITEMS.lock() {
            Ok(items) => items
                .last()
                .cloned()
                .map(Value::from)
                .unwrap_or(Value::Null),
            Err(_) => Value::Null,
        },
        "setFileDialogResult" => {
            let answer = match params.get("path") {
                Some(Value::String(path)) => Some(Some(path.clone())),
                _ => Some(None),
            };
            if let Ok(mut result) = FILE_DIALOG_RESULT.lock() {
                *result = answer;
            }
            json!(true)
        }
        "fileDialogs" => match FILE_DIALOGS.lock() {
            Ok(dialogs) => Value::Array(dialogs.clone()),
            Err(_) => Value::Array(Vec::new()),
        },
        "setMessageBoxResponse" => {
            let response = params
                .get("response")
                .and_then(Value::as_u64)
                .map(|value| value as usize);
            if let Ok(mut stub) = MESSAGE_BOX_RESPONSE.lock() {
                *stub = response;
            }
            json!(true)
        }
        "messageBoxes" => match MESSAGE_BOXES.lock() {
            Ok(boxes) => Value::Array(boxes.clone()),
            Err(_) => Value::Array(Vec::new()),
        },
        "menu.items" => crate::menu_builder::describe_menu(app),
        "menu.isEnabled" => crate::menu_builder::item_enabled(app, &labels_param(params))
            .map(Value::from)
            .unwrap_or(Value::Null),
        "menu.click" => json!(crate::menu_builder::click_item(app, &labels_param(params))),
        "menu.changes" => json!(MENU_CHANGES.swap(0, Ordering::SeqCst)),
        "clipboard.writeText" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let text = params.get("text").and_then(Value::as_str).unwrap_or("");
            json!(app.clipboard().write_text(text.to_string()).is_ok())
        }
        "clipboard.readText" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            app.clipboard()
                .read_text()
                .map(Value::from)
                .unwrap_or(Value::Null)
        }
        "sentKeystrokes" => match SENT_KEYSTROKES.lock() {
            Ok(keystrokes) => json!(*keystrokes),
            Err(_) => Value::Array(Vec::new()),
        },
        "dropFiles" => {
            use tauri::Emitter;
            let paths = params.get("paths").cloned().unwrap_or_else(|| json!([]));
            let position = params
                .get("position")
                .cloned()
                .unwrap_or_else(|| json!({ "x": 0, "y": 0 }));
            let payload = json!({ "paths": paths, "position": position });
            json!(app.emit("tauri://drag-drop", payload).is_ok())
        }
        "webviewSettings" => match app.get_webview_window("main") {
            Some(window) => crate::webview_settings::describe_settings(&window),
            None => Value::Null,
        },
        "contextMenus" => describe_context_menus(),
        "contextMenu.click" => {
            let label = params.get("label").and_then(Value::as_str).unwrap_or("");
            json!(click_context_item(app, label))
        }
        "inspections" => match INSPECTIONS.lock() {
            Ok(points) => points
                .iter()
                .map(|(x, y)| json!({ "x": x, "y": y }))
                .collect(),
            Err(_) => Value::Array(Vec::new()),
        },
        "isDevtoolsOpen" => json!(devtools_open(app)),
        "sendMenuAction" => {
            let action = params.get("action").and_then(Value::as_str).unwrap_or("");
            let args = params
                .get("args")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Some(window) = app.get_webview_window("main") {
                let state = app.state::<crate::ipc_handler::WebContentsState>();
                crate::ipc_handler::emit_menu_action(&window, state.inner(), action, args);
            }
            json!(true)
        }
        _ => Value::Null,
    }
}

/// Whether the window can be seen: on macOS the test window is on screen
/// but fully transparent, so it never can.
fn is_seen(window: &tauri::WebviewWindow) -> bool {
    !cfg!(target_os = "macos") && window.is_visible().unwrap_or(false)
}

/// The main window's state, or null with no window, read on the main
/// thread, where `outer_rect` asks GTK for the window's frame as it is now.
fn window_state_on_main_thread(app: &AppHandle) -> Result<Value, String> {
    let handle = app.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let state = handle
            .get_webview_window("main")
            .map_or(Value::Null, |window| window_state(&handle, &window));
        let _ = sender.send(state);
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .map_err(|_| "the main thread did not answer".to_string())
}

/// The window's state: whether it is visible, maximized (the tracked
/// state, which a hidden window is given when it is shown) and fullscreen, its outer
/// bounds, its page size and its monitor's work area in logical pixels,
/// and its title.
fn window_state(app: &AppHandle, window: &tauri::WebviewWindow) -> Value {
    let scale = window.scale_factor().unwrap_or(1.0);
    let outer = crate::outer_rect(&window.as_ref().window());
    let inner = window.inner_size().ok();
    let maximized = app
        .try_state::<crate::WindowTrackerState>()
        .is_some_and(|tracker| tracker.lock().expect("window tracker lock").maximized);
    let work_area = window.current_monitor().ok().flatten().map(|monitor| {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        json!({
            "x": f64::from(area.position.x) / scale,
            "y": f64::from(area.position.y) / scale,
            "width": f64::from(area.size.width) / scale,
            "height": f64::from(area.size.height) / scale,
        })
    });
    json!({
        "visible": is_seen(window),
        "maximized": maximized,
        "fullscreen": window.is_fullscreen().unwrap_or(false),
        "x": outer.map(|rect| f64::from(rect.x) / scale),
        "y": outer.map(|rect| f64::from(rect.y) / scale),
        "width": outer.map(|rect| f64::from(rect.width) / scale),
        "height": outer.map(|rect| f64::from(rect.height) / scale),
        "innerWidth": inner.map(|s| f64::from(s.width) / scale),
        "innerHeight": inner.map(|s| f64::from(s.height) / scale),
        "workArea": work_area,
        "title": window.title().unwrap_or_default(),
    })
}

/// Moves and resizes the window to outer bounds given in logical pixels:
/// `width` and `height`, and `x` and `y` when both are given.
fn set_window_bounds(window: &tauri::WebviewWindow, bounds: &Value) {
    let number = |key: &str| bounds.get(key).and_then(Value::as_f64);
    let scale = window.scale_factor().unwrap_or(1.0);
    let (Ok(outer), Ok(inner)) = (window.outer_size(), window.inner_size()) else {
        return;
    };
    let frame_width = f64::from(outer.width.saturating_sub(inner.width)) / scale;
    let frame_height = f64::from(outer.height.saturating_sub(inner.height)) / scale;
    if let (Some(width), Some(height)) = (number("width"), number("height")) {
        let _ = window.set_size(tauri::LogicalSize::new(
            (width - frame_width).max(0.0),
            (height - frame_height).max(0.0),
        ));
    }
    if let (Some(x), Some(y)) = (number("x"), number("y")) {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
}

/// Maximizes the window. A hidden window, which maximizing would show, is
/// marked maximized instead, as the tracker keeps a saved maximized state
/// for when the window is shown, and its bounds are saved.
fn maximize(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if is_seen(&window) {
        let _ = window.maximize();
        return;
    }
    let Some(tracker) = app.try_state::<crate::WindowTrackerState>() else {
        return;
    };
    let changes = {
        let mut tracker = tracker.lock().expect("window tracker lock");
        tracker.maximized = true;
        tracker.changes += 1;
        tracker.changes
    };
    crate::save_bounds_later(app, changes);
}

/// Writes one tagged reply line to stdout.
fn respond(id: &Value, result: Value) {
    write_reply(json!({ "id": id, "result": result }));
}

/// Writes one tagged reply line that fails the request to stdout.
fn respond_error(id: &Value, error: &str) {
    write_reply(json!({ "id": id, "error": error }));
}

/// Writes a reply to stdout as one tagged line.
fn write_reply(message: Value) {
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    let _ = writeln!(lock, "{TAG}{message}");
    let _ = lock.flush();
}
