// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{Value, json};
use tauri::{WebviewUrl, WebviewWindowBuilder};

mod file_manager;
mod image_path;
mod ipc_handler;
#[cfg(all(feature = "test-hooks", target_os = "macos"))]
mod mac_input;
mod media_protocol;
mod menu_builder;
mod message_box;
mod settings_manager;
#[cfg(feature = "test-hooks")]
mod test_hooks;
mod web_contents;
mod webview_settings;

/// The bridge, injected before any page script on every load, with the
/// media protocol's origin written in for `__MEDIA_ORIGIN__`.
const PRELOAD: &str = include_str!("preload.js");

/// The media protocol's origin on this platform: WebView2 serves a custom
/// protocol from an http address, the other webviews under its own scheme.
const MEDIA_ORIGIN: &str = if cfg!(windows) {
    "http://media.localhost"
} else {
    "media://localhost"
};

/// Keeps the page's own `alert` and `confirm`, run before the plugins'
/// scripts: the dialog plugin's script replaces them with functions that
/// return a promise, which a caller expecting `confirm`'s answer reads as
/// OK. The page's own dialogs are shown as the app's message box instead
/// (see `webview_settings::route_script_dialogs`).
const KEEP_PAGE_DIALOGS: &str = "for (const name of ['alert', 'confirm']) {
  const own = window[name];
  Object.defineProperty(window, name, { get: () => own, set: () => {}, configurable: false });
}";

fn main() {
    #[cfg(target_os = "macos")]
    webview_settings::use_english_locale();
    tauri::Builder::default()
        .append_invoke_initialization_script(KEEP_PAGE_DIALOGS)
        .register_asynchronous_uri_scheme_protocol("media", |_context, request, responder| {
            std::thread::spawn(move || responder.respond(media_protocol::handle(&request)));
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_menu_event(|app, event| menu_builder::handle_menu_event(app, event.id().as_ref()))
        .on_window_event(track_window_event)
        .invoke_handler(tauri::generate_handler![
            ipc_handler::settings_get,
            ipc_handler::settings_set,
            ipc_handler::settings_get_all,
            ipc_handler::bridge_ready,
            ipc_handler::document_undo,
            ipc_handler::document_redo,
            ipc_handler::view_writing,
            ipc_handler::view_source2,
            ipc_handler::element_change_type,
            ipc_handler::element_format,
            ipc_handler::file_new,
            ipc_handler::file_load,
            ipc_handler::file_save,
            ipc_handler::file_save_as,
            ipc_handler::file_export_html,
            ipc_handler::file_set_unsaved_changes,
            ipc_handler::file_get_recent_files,
            ipc_handler::file_load_path,
            ipc_handler::image_browse,
            ipc_handler::image_rename,
            ipc_handler::path_to_relative,
            ipc_handler::file_confirm_close,
            ipc_handler::dialog_confirm,
            ipc_handler::view_open_files_changed,
            ipc_handler::app_reload,
            ipc_handler::web_contents_reply,
            ipc_handler::context_menu,
        ])
        .setup(|app| {
            use tauri::Manager;
            #[cfg(all(feature = "test-hooks", target_os = "macos"))]
            if std::env::var("TESTING").is_ok() {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            app.manage(std::sync::Mutex::new(web_contents::WebContents::new()));
            app.manage(std::sync::Mutex::new(menu_builder::MenuBuilder::default()));
            app.manage(WindowTrackerState::default());
            init_settings(app);
            init_file_manager(app);
            create_window(app.handle())?;
            let cli_file = cli_file_path();
            if cli_file.is_none() && std::env::var("TESTING").is_err() {
                restore_on_next_load();
            }
            let pending = cli_file.and_then(|file_path| load_recent_file(app.handle(), &file_path));
            app.manage(std::sync::Mutex::new(pending));
            menu_builder::install_menu(app.handle());
            fit_main_window(app.handle())?;
            #[cfg(all(feature = "test-hooks", target_os = "macos"))]
            mac_input::show_unseen(app.handle());
            #[cfg(feature = "test-hooks")]
            test_hooks::start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                reopen_main_window(_app);
            }
        });
}

/// Opens the main window again, sized as at startup and shown on its first
/// page load, when the app is reopened (its Dock icon clicked) without
/// one. The menu is the app's, so
/// the new window has it too.
#[cfg(target_os = "macos")]
fn reopen_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if app.get_webview_window("main").is_some() {
        return;
    }
    app.state::<WindowTrackerState>()
        .lock()
        .expect("window tracker lock")
        .shown = false;
    if create_window(app).is_ok() {
        let _ = fit_main_window(app);
    }
}

/// Opens the settings database (honouring the TESTING settings-directory
/// override) and makes it available to the commands.
fn init_settings(app: &tauri::App) {
    use tauri::Manager;
    let testing = std::env::var("TESTING").is_ok();
    let testing_dir = std::env::var("TESTING_SETTINGS_DIR").ok();
    let config_dir = app.path().app_config_dir().expect("app config directory");
    let path = settings_manager::db_path(&config_dir, testing, testing_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let settings =
        settings_manager::SettingsManager::open(&path).expect("open the settings database");
    app.manage(std::sync::Mutex::new(settings));
}

/// Seeds the file manager with the recent files list stored in settings.
fn init_file_manager(app: &tauri::App) {
    use tauri::Manager;
    let recent = {
        let settings = app.state::<ipc_handler::Settings>();
        let manager = settings.lock().expect("settings lock");
        match manager.get("recentFiles") {
            Some(Value::Array(items)) => items
                .into_iter()
                .filter_map(|item| match item {
                    Value::String(path) => Some(path),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        }
    };
    app.manage(std::sync::Mutex::new(file_manager::FileManager::new(
        recent,
    )));
}

/// The first existing file named on the command line.
fn cli_file_path() -> Option<String> {
    let mut args = std::env::args();
    args.next();
    for arg in args {
        if arg.starts_with('-') {
            continue;
        }
        if std::path::Path::new(&arg).is_file() {
            return Some(arg);
        }
    }
    None
}

/// Loads a file: sets it as the current
/// document and records it as recent, returning the `file:loaded` result
/// for the renderer, or nothing when it cannot be read.
fn load_recent_file(app: &tauri::AppHandle, file_path: &str) -> Option<Value> {
    use tauri::Manager;
    let bytes = std::fs::read(file_path).ok()?;
    let content = file_manager::read_utf8_lossy(&bytes);
    let recent = {
        let state = app.state::<ipc_handler::FileManagerState>();
        let mut manager = state.lock().expect("file manager lock");
        manager.current_file_path = Some(file_path.to_string());
        manager.has_unsaved_changes = false;
        file_manager::add_recent(&mut manager.recent_files, file_path);
        manager.recent_files.clone()
    };
    {
        let settings = app.state::<ipc_handler::Settings>();
        let value = serde_json::to_value(&recent).unwrap_or(Value::Null);
        settings
            .lock()
            .expect("settings lock")
            .set("recentFiles", &value);
    }
    Some(json!({ "success": true, "content": content, "filePath": file_path }))
}

/// Creates the main window, hidden until `fit_main_window` sizes it and
/// the first page load shows it, with the injected bridge. Under TESTING
/// the window is never shown, and has its WebView2
/// data folder and a remote debugging port so Playwright can attach over
/// CDP, and background throttling and occlusion tracking disabled so the
/// hidden page keeps rendering.
fn create_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    #[cfg(windows)]
    if let Ok(dir) = std::env::var("TESTING_WEBVIEW_DIR") {
        // Safe: set at startup, before any other thread reads the environment.
        unsafe {
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", dir);
        }
    }

    let mut builder =
        WebviewWindowBuilder::new(app, "main", WebviewUrl::App("web/index.html".into()))
            .title("Markdown Editor")
            .initialization_script(&PRELOAD.replace("__MEDIA_ORIGIN__", MEDIA_ORIGIN))
            .visible(false);

    let app_handle = app.clone();
    builder = builder
        .on_navigation(webview_settings::is_app_url)
        .on_new_window(move |url, _features| webview_settings::handle_new_window(&app_handle, url))
        .on_permission_request(|_webview, _kind| tauri::webview::PermissionResponse::Deny)
        .on_page_load(|window, payload| {
            use tauri::{Emitter, Manager};
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => {
                    if let Some(state) = window.try_state::<ipc_handler::WebContentsState>() {
                        state.lock().expect("web contents lock").on_unload();
                    }
                }
                tauri::webview::PageLoadEvent::Finished => {
                    if record_startup_timing(&window) {
                        return;
                    }
                    show_on_first_load(&window);
                    // Deliver a file named on the command line only once the
                    // page's own listeners are set up.
                    let pending = window
                        .try_state::<ipc_handler::PendingCliFile>()
                        .and_then(|state| state.lock().expect("pending cli file lock").take());
                    if let Some(result) = pending {
                        if let Some(state) = window.try_state::<ipc_handler::WebContentsState>() {
                            let payload = json!({ "action": "file:loaded", "args": [result] });
                            let ready = state
                                .lock()
                                .expect("web contents lock")
                                .send("menu:action", payload);
                            if let Some((event, payload)) = ready {
                                let _ = window.emit(&event, payload);
                            }
                        }
                    }
                    if RESTORE_ON_LOAD.swap(false, std::sync::atomic::Ordering::SeqCst) {
                        let app = window.app_handle().clone();
                        std::thread::spawn(move || restore_saved_open_files(&app));
                    }
                }
            }
        });

    #[cfg(windows)]
    {
        let port = testing_devtools_port(std::env::var("TESTING").is_ok());
        let args = webview_settings::browser_arguments(port.as_deref());
        webview_settings::record_browser_arguments(&args);
        builder = builder.additional_browser_args(&args);
    }

    let window = builder.build()?;
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    webview_settings::handle_page_requests(&window)?;
    #[cfg(windows)]
    webview_settings::apply_webview_settings(&window)?;
    #[cfg(windows)]
    webview_settings::route_menu_shortcuts(&window)?;
    #[cfg(windows)]
    webview_settings::route_script_dialogs(&window)?;
    #[cfg(windows)]
    webview_settings::answer_context_menus(&window)?;
    Ok(())
}

/// The DevTools port the webview opens under TESTING, so Playwright can
/// attach to the test build. A build without the test hooks opens none.
#[cfg_attr(not(windows), allow(dead_code))]
fn testing_devtools_port(testing: bool) -> Option<String> {
    (testing && cfg!(feature = "test-hooks"))
        .then(|| std::env::var("TESTING_DEVTOOLS_PORT").unwrap_or_default())
}

/// Whether the next page load restores the open files saved in the
/// settings: the first page load, and the one after a reload.
static RESTORE_ON_LOAD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Has the next page load restore the open files saved in the settings.
pub fn restore_on_next_load() {
    RESTORE_ON_LOAD.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Restores the open files saved in the settings that still exist on disk.
fn restore_saved_open_files(app: &tauri::AppHandle) {
    use tauri::Manager;
    let saved = app
        .state::<ipc_handler::Settings>()
        .lock()
        .expect("settings lock")
        .get("openFiles");
    let entries: Vec<Value> = match saved {
        Some(Value::Array(entries)) => entries
            .into_iter()
            .filter(|entry| {
                entry["filePath"]
                    .as_str()
                    .is_some_and(|path| std::path::Path::new(path).exists())
            })
            .collect(),
        _ => Vec::new(),
    };
    restore_open_files(app, &entries);
}

/// Restores open files from a previous session: the files that can still be read are loaded,
/// the first into the page's own tab and the rest as new tabs; the tab
/// that was active is switched to; and the cursor and table-of-contents
/// positions are handed to the page. It waits for the page, so it must not
/// run on the main thread.
pub fn restore_open_files(app: &tauri::AppHandle, entries: &[Value]) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let loaded: Vec<(&Value, String, String)> = entries
        .iter()
        .filter_map(|entry| {
            let result = load_recent_file(app, entry["filePath"].as_str()?)?;
            let path = result["filePath"].as_str()?.to_string();
            let content = result["content"].as_str()?.to_string();
            Some((entry, path, content))
        })
        .collect();
    let Some(first) = loaded.first() else {
        return;
    };
    let web_contents = app.state::<ipc_handler::WebContentsState>();
    let load_first = format!(
        "(function () {{
            function tryRestore() {{
                var api = window.editorAPI;
                if (!api) {{ setTimeout(tryRestore, 50); return; }}
                window.__editorFilePath = {path};
                api.setContent({content});
            }}
            tryRestore();
        }})()",
        path = web_contents::js_string(&first.1),
        content = web_contents::js_string(&first.2),
    );
    let _ = web_contents::execute_javascript(&window, web_contents.inner(), &load_first);
    for (_, path, content) in &loaded[1..] {
        ipc_handler::emit_menu_action(
            &window,
            web_contents.inner(),
            "file:loaded",
            vec![json!({ "success": true, "content": content, "filePath": path })],
        );
    }
    let active = loaded
        .iter()
        .find(|(entry, ..)| entry["active"] == true)
        .unwrap_or(first);
    ipc_handler::emit_menu_action(
        &window,
        web_contents.inner(),
        "view:switchFile",
        vec![json!({ "filePath": active.1 })],
    );
    let positions: Vec<Value> = loaded
        .iter()
        .filter(|(entry, ..)| !entry["cursorPath"].is_null() || !entry["tocHeadingPath"].is_null())
        .map(|(entry, path, _)| {
            let mut position = json!({ "filePath": path, "active": entry["active"] });
            for key in ["cursorPath", "tocHeadingPath"] {
                if !entry[key].is_null() {
                    position[key] = entry[key].clone();
                }
            }
            position
        })
        .collect();
    if !positions.is_empty() {
        ipc_handler::emit_menu_action(
            &window,
            web_contents.inner(),
            "session:restore",
            vec![Value::Array(positions)],
        );
    }
    menu_builder::refresh_menu(app);
}

/// The narrowest page the toolbar row fits in at full size: its padding,
/// the file buttons and the toolbar, as `file-buttons.spec.js` measures it.
const MIN_PAGE_WIDTH: f64 = if cfg!(target_os = "macos") {
    1003.0
} else {
    998.0
};

/// The page width the window starts with.
const PAGE_WIDTH: f64 = 1216.0;

/// What the window's bounds are saved from: the bounds it last had while
/// neither maximized nor minimized, whether it is maximized (kept as is
/// while the window is hidden, and applied when it is shown), whether it
/// has been shown, and a count of moves and resizes, so that only the last
/// of a run of them saves. Also the smallest page the window may have, in
/// physical pixels, which Windows applies only while the user drags the
/// window's edges.
#[derive(Default)]
pub struct WindowTracker {
    normal: Option<LogicalBounds>,
    pub maximized: bool,
    shown: bool,
    changes: u64,
    minimum: Option<(u32, u32)>,
}

/// The managed window tracker.
pub type WindowTrackerState = std::sync::Mutex<WindowTracker>;

/// Gives the main window its saved bounds, or with none saved a page `PAGE_WIDTH` wide and 1131
/// high for the whole window, frame and menu bar included; and a page
/// `MIN_PAGE_WIDTH` wide and 848 high at least. The window is made no
/// larger than the work area of the primary monitor, whose work area
/// the position is restored against, and is moved inside it. A
/// saved maximized state is kept for when the window is shown.
fn fit_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::{Manager, PhysicalPosition, PhysicalSize};
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let scale = window.scale_factor()?;
    let physical = |logical: f64| (logical * scale).round() as u32;
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    let frame_width = outer.width.saturating_sub(inner.width);
    let frame_height = outer.height.saturating_sub(inner.height);
    let monitor = match window.primary_monitor()? {
        Some(monitor) => Some(monitor),
        None => window.current_monitor()?,
    };
    let work_area = monitor.map(|monitor| screen_rect(monitor.work_area()));
    let saved = app
        .state::<ipc_handler::Settings>()
        .lock()
        .expect("settings lock")
        .get("windowBounds");
    let start = (
        f64::from(physical(PAGE_WIDTH) + frame_width) / scale,
        (800.0 * std::f64::consts::SQRT_2).round(),
    );
    let restored = restored_bounds(
        saved.as_ref(),
        work_area.map_or(start_area(start), |area| logical_bounds(area, scale)),
        start,
    );
    let position = window.outer_position()?;
    let wanted = ScreenRect {
        x: restored
            .position
            .map_or(position.x, |(x, _)| (x * scale).round() as i32),
        y: restored
            .position
            .map_or(position.y, |(_, y)| (y * scale).round() as i32),
        width: (restored.width * scale).round() as u32,
        height: (restored.height * scale).round() as u32,
    };
    let placed = work_area.map_or(wanted, |area| fit_window(wanted, area));
    let minimum = (
        physical(MIN_PAGE_WIDTH),
        physical(848.0).saturating_sub(frame_height),
    );
    app.state::<WindowTrackerState>()
        .lock()
        .expect("window tracker lock")
        .minimum = Some(minimum);
    window.set_min_size(Some(PhysicalSize::new(minimum.0, minimum.1)))?;
    window.set_size(PhysicalSize::new(
        placed.width.saturating_sub(frame_width),
        placed.height.saturating_sub(frame_height),
    ))?;
    window.set_position(PhysicalPosition::new(placed.x, placed.y))?;
    let tracker = app.state::<WindowTrackerState>();
    let mut tracker = tracker.lock().expect("window tracker lock");
    tracker.normal = Some(logical_bounds(placed, scale));
    tracker.maximized = restored.maximized;
    Ok(())
}

/// A work area to restore against when no monitor is known: one as large
/// as the starting window, at the origin.
fn start_area(start: (f64, f64)) -> LogicalBounds {
    LogicalBounds {
        x: 0.0,
        y: 0.0,
        width: start.0,
        height: start.1,
    }
}

/// A monitor rectangle as a `ScreenRect`.
fn screen_rect(rect: &tauri::PhysicalRect<i32, u32>) -> ScreenRect {
    ScreenRect {
        x: rect.position.x,
        y: rect.position.y,
        width: rect.size.width,
        height: rect.size.height,
    }
}

/// A rectangle in physical pixels as logical bounds at a scale factor.
fn logical_bounds(rect: ScreenRect, scale: f64) -> LogicalBounds {
    LogicalBounds {
        x: f64::from(rect.x) / scale,
        y: f64::from(rect.y) / scale,
        width: f64::from(rect.width) / scale,
        height: f64::from(rect.height) / scale,
    }
}

/// The outer bounds of a window, in physical pixels. On Linux, on the main
/// thread, they are read from GDK at the time of asking: tao keeps the
/// frame bounds GDK gave on the window's last configure event, and on the
/// one that first shows the window those are GDK's 1×1 fallback. Bounds
/// smaller than the window's inner size give way to its inner bounds.
fn outer_rect<R: tauri::Runtime>(window: &tauri::Window<R>) -> Option<ScreenRect> {
    let inner = window.inner_size().ok()?;
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
    let mut rect = ScreenRect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    #[cfg(target_os = "linux")]
    if let Some(frame) = gdk_frame_rect(window) {
        rect = frame;
    }
    if rect.width < inner.width || rect.height < inner.height {
        let position = window.inner_position().ok()?;
        rect = ScreenRect {
            x: position.x,
            y: position.y,
            width: inner.width,
            height: inner.height,
        };
    }
    Some(rect)
}

/// The window's frame bounds as GDK gives them now, in physical pixels,
/// or None off the main thread, where GTK must not be called.
#[cfg(target_os = "linux")]
fn gdk_frame_rect<R: tauri::Runtime>(window: &tauri::Window<R>) -> Option<ScreenRect> {
    use gtk::prelude::WidgetExt;
    if !gtk::is_initialized_main_thread() {
        return None;
    }
    let frame = window.gtk_window().ok()?.window()?.frame_extents();
    let scale = window.scale_factor().ok()?;
    let physical = |value: i32| (f64::from(value) * scale).round() as i32;
    Some(ScreenRect {
        x: physical(frame.x()),
        y: physical(frame.y()),
        width: physical(frame.width()).max(0) as u32,
        height: physical(frame.height()).max(0) as u32,
    })
}

/// The outer bounds of a window, in logical pixels.
fn outer_bounds<R: tauri::Runtime>(window: &tauri::Window<R>) -> Option<LogicalBounds> {
    let rect = outer_rect(window)?;
    let scale = window.scale_factor().ok()?;
    Some(logical_bounds(rect, scale))
}

/// The work area of the monitor a window is on, in logical pixels.
fn work_area_of<R: tauri::Runtime>(window: &tauri::Window<R>) -> Option<LogicalBounds> {
    let monitor = window.current_monitor().ok()??;
    Some(logical_bounds(
        screen_rect(monitor.work_area()),
        monitor.scale_factor(),
    ))
}

/// Keeps the tracker in step with the window and saves its bounds:
/// half a second after the last of a run of moves and
/// resizes, and at once when the window is asked to close. While the
/// window is hidden its maximized state is the saved one, kept for when it
/// is shown. A resize below the minimum page is undone.
fn track_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    use tauri::Manager;
    match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            let Some(tracker) = window.try_state::<WindowTrackerState>() else {
                return;
            };
            let minimized = window.is_minimized().unwrap_or(false);
            let maximized = window.is_maximized().unwrap_or(false);
            if let (tauri::WindowEvent::Resized(size), false) = (event, minimized) {
                let minimum = tracker.lock().expect("window tracker lock").minimum;
                if let Some((width, height)) = minimum {
                    if size.width < width || size.height < height {
                        let _ = window.set_size(tauri::PhysicalSize::new(
                            size.width.max(width),
                            size.height.max(height),
                        ));
                        return;
                    }
                }
            }
            let changes = {
                let mut tracker = tracker.lock().expect("window tracker lock");
                if tracker.shown {
                    tracker.maximized = maximized;
                }
                if !tracker.maximized && !minimized {
                    tracker.normal = outer_bounds(window);
                }
                tracker.changes += 1;
                tracker.changes
            };
            save_bounds_later(window.app_handle(), changes);
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            save_window_bounds(window.app_handle());
            let testing = std::env::var("TESTING").is_ok();
            if testing && !CLOSE_FLOW.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            api.prevent_close();
            let app = window.app_handle().clone();
            std::thread::spawn(move || close_main_window(&app));
        }
        _ => {}
    }
}

/// Whether a close request runs the close flow under TESTING, where a
/// window otherwise closes at once.
static CLOSE_FLOW: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Has close requests run the close flow under TESTING too.
#[cfg_attr(not(feature = "test-hooks"), allow(dead_code))]
pub fn use_close_flow() {
    CLOSE_FLOW.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Closes the window: the page's open
/// files are flushed and saved, and a window with unsaved changes first
/// asks whether to save them (Save, Discard, Cancel), staying open
/// on Cancel and when the save does not happen. It waits for the page and
/// the box, so it must not run on the main thread.
fn close_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let web_contents = app.state::<ipc_handler::WebContentsState>();
    let evaluate =
        |code: &str| web_contents::execute_javascript(&window, web_contents.inner(), code).ok();
    let _ = evaluate("window.__flushOpenFiles?.()");
    ipc_handler::save_open_files(app);
    let unsaved = evaluate("window.editorAPI?.hasUnsavedChanges() ?? false")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if !unsaved {
        let _ = window.destroy();
        return;
    }
    let response = ipc_handler::show_message_box(&window, &message_box::unsaved_changes_box());
    let content = evaluate("window.editorAPI?.getContent() ?? \"\"")
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    let closes = match message_box::close_action(response) {
        "save" => ipc_handler::save(content, &window, app)["success"] == true,
        "discard" => true,
        _ => false,
    };
    if closes {
        let _ = window.destroy();
    }
}

/// Saves the window's bounds half a second from now, unless the window
/// moves or resizes again before then.
fn save_bounds_later(app: &tauri::AppHandle, changes: u64) {
    use tauri::Manager;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let latest = app
            .try_state::<WindowTrackerState>()
            .map(|tracker| tracker.lock().expect("window tracker lock").changes);
        if latest == Some(changes) {
            save_window_bounds(&app);
        }
    });
}

/// Saves the `windowBounds` setting: the bounds the window restores to, as
/// ratios of the work area of the monitor it is on, and whether it is
/// maximized.
fn save_window_bounds(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(webview_window) = app.get_webview_window("main") else {
        return;
    };
    let window = webview_window.as_ref().window();
    let Some(tracker) = app.try_state::<WindowTrackerState>() else {
        return;
    };
    let (normal, maximized) = {
        let tracker = tracker.lock().expect("window tracker lock");
        (tracker.normal, tracker.maximized)
    };
    let Some(bounds) = normal.or_else(|| outer_bounds(&window)) else {
        return;
    };
    let Some(work_area) = work_area_of(&window) else {
        return;
    };
    let setting = bounds_setting(bounds, work_area, maximized);
    app.state::<ipc_handler::Settings>()
        .lock()
        .expect("settings lock")
        .set("windowBounds", &setting);
}

/// Shows the window on the first page load, maximized if it was, and
/// gives it the focus; under
/// TESTING only when the test build is asked to with `TESTING_VISIBLE`.
fn show_on_first_load(window: &tauri::WebviewWindow) {
    use tauri::Manager;
    let testing = std::env::var("TESTING").is_ok()
        && !(cfg!(feature = "test-hooks") && std::env::var("TESTING_VISIBLE").is_ok());
    let Some(tracker) = window.try_state::<WindowTrackerState>() else {
        return;
    };
    let maximized = {
        let mut tracker = tracker.lock().expect("window tracker lock");
        if !shows_on_page_load(testing, tracker.shown) {
            return;
        }
        tracker.shown = true;
        tracker.maximized
    };
    let _ = window.show();
    if maximized {
        let _ = window.maximize();
    }
    let _ = window.set_focus();
}

/// A rectangle on screen, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ScreenRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Where the whole window goes: no larger than the work area, and moved so
/// that all of it lies inside the work area.
fn fit_window(window: ScreenRect, work_area: ScreenRect) -> ScreenRect {
    let width = window.width.min(work_area.width);
    let height = window.height.min(work_area.height);
    let max_x = work_area.x + (work_area.width - width) as i32;
    let max_y = work_area.y + (work_area.height - height) as i32;
    ScreenRect {
        x: window.x.clamp(work_area.x, max_x),
        y: window.y.clamp(work_area.y, max_y),
        width,
        height,
    }
}

/// A window's outer bounds in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
struct LogicalBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// The `windowBounds` setting: the
/// position as ratios of the work area, the size, and whether the window
/// was maximized, in which case the bounds are those it restores to.
fn bounds_setting(bounds: LogicalBounds, work_area: LogicalBounds, maximized: bool) -> Value {
    json!({
        "xRatio": (bounds.x - work_area.x) / work_area.width,
        "yRatio": (bounds.y - work_area.y) / work_area.height,
        "width": bounds.width,
        "height": bounds.height,
        "isMaximized": maximized
    })
}

/// The size, position and maximized state a window starts with.
#[derive(Debug, PartialEq)]
struct RestoredBounds {
    width: f64,
    height: f64,
    position: Option<(f64, f64)>,
    maximized: bool,
}

/// What a `windowBounds` setting restores: the saved size, or the starting size when none is
/// saved; the position from the saved ratios, kept inside the work area
/// when the window fits in it, or left to the operating system when none
/// is saved; and whether the window was maximized.
fn restored_bounds(
    setting: Option<&Value>,
    work_area: LogicalBounds,
    start: (f64, f64),
) -> RestoredBounds {
    let number = |key: &str| {
        setting
            .and_then(|saved| saved.get(key))
            .and_then(Value::as_f64)
    };
    let width = number("width").unwrap_or(start.0);
    let height = number("height").unwrap_or(start.1);
    let position = number("xRatio")
        .zip(number("yRatio"))
        .map(|(x_ratio, y_ratio)| {
            let x = (x_ratio * work_area.width).round() + work_area.x;
            let y = (y_ratio * work_area.height).round() + work_area.y;
            (
                work_area
                    .x
                    .max(x.min(work_area.x + work_area.width - width)),
                work_area
                    .y
                    .max(y.min(work_area.y + work_area.height - height)),
            )
        });
    let maximized = setting
        .and_then(|saved| saved.get("isMaximized"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    RestoredBounds {
        width,
        height,
        position,
        maximized,
    }
}

/// The time `STARTUP_TIMING` records: the local
/// time's hours, minutes and seconds, and its milliseconds.
fn startup_timing_text(time: chrono::NaiveTime) -> String {
    time.format("%H:%M:%S%.3f").to_string()
}

/// Writes the local time of the first page load to the file
/// `STARTUP_TIMING` names and exits, before the window is shown. Returns whether it did.
fn record_startup_timing(window: &tauri::WebviewWindow) -> bool {
    use tauri::Manager;
    let Some(path) = std::env::var("STARTUP_TIMING")
        .ok()
        .filter(|path| !path.is_empty())
    else {
        return false;
    };
    let _ = std::fs::write(path, startup_timing_text(chrono::Local::now().time()));
    window.app_handle().exit(0);
    true
}

/// Whether a page load shows the window: the first one does, unless
/// TESTING is set.
fn shows_on_page_load(testing: bool, shown: bool) -> bool {
    !testing && !shown
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work_area() -> LogicalBounds {
        LogicalBounds {
            x: 0.0,
            y: 40.0,
            width: 1920.0,
            height: 1000.0,
        }
    }

    #[test]
    fn bounds_are_saved_as_ratios_of_the_work_area() {
        let bounds = LogicalBounds {
            x: 480.0,
            y: 290.0,
            width: 1300.0,
            height: 900.0,
        };
        assert_eq!(
            bounds_setting(bounds, work_area(), true),
            json!({
                "xRatio": 0.25,
                "yRatio": 0.25,
                "width": 1300.0,
                "height": 900.0,
                "isMaximized": true
            })
        );
    }

    #[test]
    fn bounds_restore_the_saved_size_position_and_maximized_state() {
        let saved = json!({
            "xRatio": 0.25,
            "yRatio": 0.25,
            "width": 1300.0,
            "height": 600.0,
            "isMaximized": true
        });
        assert_eq!(
            restored_bounds(Some(&saved), work_area(), (1232.0, 1131.0)),
            RestoredBounds {
                width: 1300.0,
                height: 600.0,
                position: Some((480.0, 290.0)),
                maximized: true,
            }
        );
    }

    #[test]
    fn bounds_restore_a_position_kept_inside_the_work_area() {
        let saved = json!({
            "xRatio": 0.9,
            "yRatio": -0.5,
            "width": 1300.0,
            "height": 900.0,
            "isMaximized": false
        });
        assert_eq!(
            restored_bounds(Some(&saved), work_area(), (1232.0, 1131.0)).position,
            Some((620.0, 40.0))
        );
    }

    #[test]
    fn bounds_without_a_saved_setting_start_at_the_starting_size() {
        let fresh = RestoredBounds {
            width: 1232.0,
            height: 1131.0,
            position: None,
            maximized: false,
        };
        assert_eq!(restored_bounds(None, work_area(), (1232.0, 1131.0)), fresh);
        assert_eq!(
            restored_bounds(Some(&Value::Null), work_area(), (1232.0, 1131.0)),
            fresh
        );
    }

    #[test]
    #[cfg(not(feature = "test-hooks"))]
    fn a_build_without_the_test_hooks_opens_no_devtools_port_under_testing() {
        assert_eq!(testing_devtools_port(true), None);
        assert_eq!(testing_devtools_port(false), None);
    }

    #[test]
    fn startup_timing_is_written_as_hours_minutes_seconds_and_milliseconds() {
        let time = chrono::NaiveTime::from_hms_milli_opt(9, 5, 7, 42).expect("a valid time");
        assert_eq!(startup_timing_text(time), "09:05:07.042");
    }

    #[test]
    fn bounds_window_is_shown_on_the_first_page_load_unless_testing() {
        assert!(shows_on_page_load(false, false));
        assert!(!shows_on_page_load(false, true));
        assert!(!shows_on_page_load(true, false));
    }

    fn rect(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn a_window_that_fits_the_work_area_stays_as_it_is() {
        assert_eq!(
            fit_window(rect(100, 50, 800, 1131), rect(0, 0, 2560, 1400)),
            rect(100, 50, 800, 1131)
        );
    }

    #[test]
    fn a_window_taller_than_the_work_area_is_made_as_tall_as_it_and_moved_into_it() {
        assert_eq!(
            fit_window(rect(100, 50, 800, 1131), rect(0, 0, 1920, 1040)),
            rect(100, 0, 800, 1040)
        );
    }

    #[test]
    fn a_window_past_the_work_area_edges_is_moved_inside_it() {
        assert_eq!(
            fit_window(rect(1500, 300, 800, 900), rect(0, 0, 1920, 1040)),
            rect(1120, 140, 800, 900)
        );
        assert_eq!(
            fit_window(rect(10, 20, 800, 900), rect(0, 40, 1920, 1040)),
            rect(10, 40, 800, 900)
        );
    }
}
