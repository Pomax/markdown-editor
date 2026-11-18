//! Security limits applied to the webview: which pages the main frame may
//! navigate to, what a window.open does, and how permission requests are
//! answered; on Windows and Linux, the routing of the page's `alert` and
//! `confirm` to the app's message box; on Windows, the routing of menu
//! shortcuts pressed while the page has keyboard focus, the WebView2
//! settings and browser arguments; and on Linux, fullscreen turned off.

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Url, Wry};

/// Whether a URL is one of the app's own pages, or the dev server. Any
/// other navigation of the main frame is cancelled.
pub fn is_app_url(url: &Url) -> bool {
    if url.scheme() == "tauri" {
        return true;
    }
    matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some("tauri.localhost") | Some("localhost"))
}

/// Refuses a window.open: http and https URLs go to the system browser
/// (recorded instead of opened in test-hooks builds), everything else is
/// refused, and no app window is ever opened.
pub fn handle_new_window(app: &AppHandle, url: Url) -> NewWindowResponse<Wry> {
    if matches!(url.scheme(), "http" | "https") {
        open_external(app, url.as_str());
    }
    NewWindowResponse::Deny
}

/// Records a URL that would go to the system browser, in test-hooks
/// builds.
#[cfg(feature = "test-hooks")]
pub(crate) fn open_external(_app: &AppHandle, url: &str) {
    crate::test_hooks::record_opened_url(url);
}

/// Opens a URL in the system browser.
#[cfg(not(feature = "test-hooks"))]
pub(crate) fn open_external(app: &AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(url.to_string(), None::<String>);
}

/// Runs the menu item registered for a shortcut pressed while the page has
/// keyboard focus. WebView2 takes keyboard input in its own process, so
/// the window's menu accelerators never see those keys; WebView2 reports
/// them through `AcceleratorKeyPressed` instead. A key press that matches
/// a registered menu shortcut is marked handled, so WebView2 does not act
/// on it as well, and its menu item runs once. Alt plus a top-level menu's
/// access letter is marked handled and passed to the window as the
/// keystroke that opens that menu.
///
/// Ctrl, Alt and Shift are read from the thread's key state, which holds
/// them as they were when the key went down, even when they are released
/// by the time its event is handled.
#[cfg(windows)]
pub fn route_menu_shortcuts(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use tauri::Manager;
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
        COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
    };
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyState, VIRTUAL_KEY, VK_CONTROL, VK_MENU, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, SC_KEYMENU, WM_SYSCOMMAND};

    let app = window.app_handle().clone();
    let hwnd = window.hwnd()?.0 as isize;
    window.with_webview(move |webview| {
        let handler =
            AcceleratorKeyPressedEventHandler::create(Box::new(move |_controller, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND(0);
                let mut key = 0u32;
                // Safe: both out-pointers point at locals that outlive the calls.
                unsafe {
                    args.KeyEventKind(&mut kind)?;
                    args.VirtualKey(&mut key)?;
                }
                let pressed = kind.0 == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN.0
                    || kind.0 == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN.0;
                if !pressed {
                    return Ok(());
                }
                // Safe: GetKeyState only reads the thread's key state.
                let down = |vk: VIRTUAL_KEY| unsafe { GetKeyState(i32::from(vk.0)) } < 0;
                let ctrl = down(VK_CONTROL);
                let alt = down(VK_MENU);
                let shift = down(VK_SHIFT);
                let shortcut = shortcut_for_key(key, ctrl, alt, shift);
                let registered = shortcut
                    .as_deref()
                    .and_then(|shortcut| crate::menu_builder::registered_item(&app, shortcut));
                if let Some(id) = registered {
                    // Safe: `args` is the live event's argument object.
                    unsafe {
                        args.SetHandled(true)?;
                    }
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        crate::menu_builder::handle_menu_event(&handle, &id);
                    });
                    return Ok(());
                }
                let letters = crate::menu_builder::access_letters(&app);
                let Some(letter) = menu_access_key(key, ctrl, alt, &letters) else {
                    return Ok(());
                };
                // Safe: `args` is the live event's argument object, and
                // posting to a window that no longer exists only fails.
                unsafe {
                    args.SetHandled(true)?;
                    PostMessageW(
                        Some(HWND(hwnd as *mut std::ffi::c_void)),
                        WM_SYSCOMMAND,
                        WPARAM(SC_KEYMENU as usize),
                        LPARAM(letter as isize),
                    )?;
                }
                Ok(())
            }));
        let mut token = 0i64;
        // Safe: the handler and the token outlive the call, and the
        // controller keeps its own reference to the handler.
        unsafe {
            let _ = webview
                .controller()
                .add_AcceleratorKeyPressed(&handler, &mut token);
        }
    })
}

/// Reloads the page bypassing the cache: on Windows through the DevTools protocol's
/// `Page.reload` with `ignoreCache`.
pub fn reload_ignoring_cache(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        let _ = window.with_webview(|webview| {
            use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
            let handler =
                CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
            // Safe: the strings are static, and WebView2 keeps its own
            // reference to the handler.
            unsafe {
                if let Ok(core) = webview.controller().CoreWebView2() {
                    let _ = core.CallDevToolsProtocolMethod(
                        windows::core::w!("Page.reload"),
                        windows::core::w!("{\"ignoreCache\":true}"),
                        &handler,
                    );
                }
            }
        });
    }
    #[cfg(not(windows))]
    {
        let _ = window.reload();
    }
}

/// The point of the page, in CSS pixels, an Inspect Element waits to be
/// run at.
#[cfg(windows)]
static INSPECT_AT: std::sync::Mutex<Option<(f64, f64)>> = std::sync::Mutex::new(None);

/// Opens DevTools on the element at a point of the page. WebView2 has no call for this, but its own
/// context menu's Inspect command does it for the point the menu was
/// asked for. So the point is kept, the page is told to let its next
/// right-click through, and a right-click at the point is sent through
/// the DevTools protocol; `answer_context_menus` then runs the Inspect
/// command for it.
#[cfg(windows)]
pub fn inspect_element(window: &tauri::WebviewWindow, x: f64, y: f64) {
    *INSPECT_AT.lock().expect("inspect lock") = Some((x, y));
    let _ = window.with_webview(move |webview| {
        // Safe: reads the live webview's core object.
        let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else {
            return;
        };
        let mouse = |kind: &str| {
            format!(r#"{{"type":"{kind}","x":{x},"y":{y},"button":"right","clickCount":1}}"#)
        };
        let pressed = mouse("mousePressed");
        let released = mouse("mouseReleased");
        let press_on = core.clone();
        let release_on = core.clone();
        call_devtools(
            &core,
            "Runtime.evaluate",
            r#"{"expression":"window.__inspectNextContextMenu = true"}"#,
            Box::new(move || {
                call_devtools(
                    &press_on,
                    "Input.dispatchMouseEvent",
                    &pressed,
                    Box::new(move || {
                        call_devtools(
                            &release_on,
                            "Input.dispatchMouseEvent",
                            &released,
                            Box::new(|| {}),
                        );
                    }),
                );
            }),
        );
    });
}

/// Runs a DevTools protocol method on the page, then `then` once it has
/// answered.
#[cfg(windows)]
fn call_devtools(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    method: &str,
    params: &str,
    then: Box<dyn FnOnce()>,
) {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::{HSTRING, PCWSTR};
    let method = HSTRING::from(method);
    let params = HSTRING::from(params);
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |_, _| {
        then();
        Ok(())
    }));
    // Safe: the strings outlive the call, and WebView2 keeps its own
    // reference to the handler.
    unsafe {
        let _ = core.CallDevToolsProtocolMethod(
            PCWSTR(method.as_ptr()),
            PCWSTR(params.as_ptr()),
            &handler,
        );
    }
}

/// Answers WebView2's own context menu requests, which come only for a
/// right-click the page let through: WebView2's menu is never shown, and
/// when an Inspect Element waits, the request runs WebView2's Inspect
/// command, which opens DevTools on the element at its point.
#[cfg(windows)]
pub fn answer_context_menus(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        let _ = add_context_menu_handler(&webview.controller());
    })
}

/// Adds the handler for WebView2's own context menu requests.
#[cfg(windows)]
fn add_context_menu_handler(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_11;
    use webview2_com::{ContextMenuRequestedEventHandler, take_pwstr};
    use windows::core::{Interface, PWSTR};

    let handler = ContextMenuRequestedEventHandler::create(Box::new(|_sender, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let inspect_at = INSPECT_AT.lock().expect("inspect lock").take();
        // Safe: `args` is the live event's argument object, and every
        // out-pointer points at a local that outlives its call.
        unsafe {
            if let Some((x, y)) = inspect_at {
                let items = args.MenuItems()?;
                let mut count = 0u32;
                items.Count(&mut count)?;
                for index in 0..count {
                    let item = items.GetValueAtIndex(index)?;
                    let mut name = PWSTR::null();
                    item.Name(&mut name)?;
                    if take_pwstr(name) == "inspectElement" {
                        let mut id = 0i32;
                        item.CommandId(&mut id)?;
                        args.SetSelectedCommandId(id)?;
                        #[cfg(feature = "test-hooks")]
                        crate::test_hooks::record_inspection(x, y);
                        break;
                    }
                }
                let _ = (x, y);
            }
            args.SetHandled(true)?;
        }
        Ok(())
    }));
    let mut token = 0i64;
    // Safe: the handler and the token outlive the calls, and WebView2
    // keeps its own reference to the handler.
    unsafe {
        let core: ICoreWebView2_11 = controller.CoreWebView2()?.cast()?;
        core.add_ContextMenuRequested(&handler, &mut token)?;
    }
    Ok(())
}

/// The page dialogs waiting for their box to be answered, by number. They
/// stay on the main thread, where WebView2 raised them and where their
/// objects must be used.
#[cfg(windows)]
type PendingDialogs = std::collections::HashMap<
    u64,
    (
        webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ScriptDialogOpeningEventArgs,
        webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral,
    ),
>;

#[cfg(windows)]
thread_local! {
    static PENDING_DIALOGS: std::cell::RefCell<PendingDialogs> = std::cell::RefCell::default();
}

/// The number given to the next page dialog.
#[cfg(any(windows, target_os = "linux"))]
static NEXT_DIALOG: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Shows a page's `alert` or `confirm` as the app's message box on a
/// worker thread, since a blocking box cannot be shown on the main thread,
/// then calls `finish` back on the main thread with whether OK was chosen.
#[cfg(any(windows, target_os = "linux"))]
fn ask_script_dialog(
    window: &tauri::WebviewWindow,
    message: &str,
    confirm: bool,
    finish: impl FnOnce(bool) + Send + 'static,
) {
    let title = window.title().unwrap_or_default();
    let options = crate::message_box::script_dialog_box(&title, message, confirm);
    let shown_on = window.clone();
    std::thread::spawn(move || {
        let response = crate::ipc_handler::show_message_box(&shown_on, &options);
        let accepted = crate::message_box::script_dialog_accepted(response);
        let _ = shown_on.run_on_main_thread(move || finish(accepted));
    });
}

/// Shows the page's `alert` and `confirm` as the app's message box
/// instead of WebView2's own dialog. WebView2 waits for
/// the answer through a deferral: the box is shown on a worker thread,
/// since a blocking box cannot be shown on the main thread, and the
/// deferral is completed back on the main thread, accepting the dialog when
/// OK was chosen. Any other page dialog is left unanswered, which cancels
/// it.
#[cfg(windows)]
pub fn route_script_dialogs(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let target = window.clone();
    window.with_webview(move |webview| {
        let _ = handle_script_dialogs(&webview.controller(), target);
    })
}

/// Turns off WebView2's own page dialogs and adds the handler that shows
/// `alert` and `confirm` as the app's message box.
#[cfg(windows)]
fn handle_script_dialogs(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    window: tauri::WebviewWindow,
) -> windows::core::Result<()> {
    use std::sync::atomic::Ordering;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_SCRIPT_DIALOG_KIND, COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT,
        COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM,
    };
    use webview2_com::{ScriptDialogOpeningEventHandler, take_pwstr};
    use windows::core::PWSTR;

    let handler = ScriptDialogOpeningEventHandler::create(Box::new(move |_sender, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut kind = COREWEBVIEW2_SCRIPT_DIALOG_KIND(0);
        let mut message = PWSTR::null();
        // Safe: both out-pointers point at locals that outlive the calls.
        unsafe {
            args.Kind(&mut kind)?;
            args.Message(&mut message)?;
        }
        let message = take_pwstr(message);
        let confirm = kind.0 == COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM.0;
        if !confirm && kind.0 != COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT.0 {
            return Ok(());
        }
        // Safe: `args` is the live event's argument object.
        let deferral = unsafe { args.GetDeferral()? };
        let id = NEXT_DIALOG.fetch_add(1, Ordering::SeqCst);
        PENDING_DIALOGS.with(|pending| pending.borrow_mut().insert(id, (args, deferral)));
        ask_script_dialog(&window, &message, confirm, move |accepted| {
            finish_script_dialog(id, accepted)
        });
        Ok(())
    }));
    let mut token = 0i64;
    // Safe: the handler and the token outlive the calls, and WebView2
    // keeps its own reference to the handler.
    unsafe {
        let core = controller.CoreWebView2()?;
        core.Settings()?.SetAreDefaultScriptDialogsEnabled(false)?;
        core.add_ScriptDialogOpening(&handler, &mut token)?;
    }
    Ok(())
}

/// Answers a waiting page dialog: accepts it when OK was chosen, then lets
/// the page continue.
#[cfg(windows)]
fn finish_script_dialog(id: u64, accepted: bool) {
    let Some((args, deferral)) = PENDING_DIALOGS.with(|pending| pending.borrow_mut().remove(&id))
    else {
        return;
    };
    // Safe: both objects belong to this thread, where WebView2 raised the
    // event.
    unsafe {
        if accepted {
            let _ = args.Accept();
        }
        let _ = deferral.Complete();
    }
}

#[cfg(target_os = "linux")]
thread_local! {
    /// The page dialogs waiting for their box to be answered, by number.
    /// They stay on the main thread, where WebKitGTK raised them.
    static PENDING_SCRIPT_DIALOGS: std::cell::RefCell<
        std::collections::HashMap<u64, webkit2gtk::ScriptDialog>,
    > = std::cell::RefCell::default();
}

/// Turns off fullscreen, so the page cannot request it, and shows the
/// page's `alert` and `confirm` as the app's message box instead of
/// WebKitGTK's own dialog. WebKitGTK waits for a dialog the app keeps
/// until the app closes it, so it is closed once its box is answered,
/// confirmed when OK was chosen. Any other page dialog is closed
/// unanswered, which cancels it.
#[cfg(target_os = "linux")]
pub fn handle_page_requests(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let target = window.clone();
    window.with_webview(move |webview| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        let view = webview.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_fullscreen(false);
        }
        view.connect_script_dialog(move |_, dialog| {
            use std::sync::atomic::Ordering;
            use webkit2gtk::ScriptDialogType;
            let confirm = match dialog.dialog_type() {
                ScriptDialogType::Alert => false,
                ScriptDialogType::Confirm => true,
                _ => return true,
            };
            let message = dialog.message().map(String::from).unwrap_or_default();
            let id = NEXT_DIALOG.fetch_add(1, Ordering::SeqCst);
            PENDING_SCRIPT_DIALOGS.with(|pending| pending.borrow_mut().insert(id, dialog.clone()));
            ask_script_dialog(&target, &message, confirm, move |accepted| {
                finish_page_dialog(id, accepted)
            });
            true
        });
    })
}

/// Answers a waiting page dialog: confirms a `confirm` when OK was chosen,
/// then closes the dialog, which lets the page continue.
#[cfg(target_os = "linux")]
fn finish_page_dialog(id: u64, accepted: bool) {
    let Some(dialog) = PENDING_SCRIPT_DIALOGS.with(|pending| pending.borrow_mut().remove(&id))
    else {
        return;
    };
    if dialog.dialog_type() == webkit2gtk::ScriptDialogType::Confirm {
        dialog.confirm_set_confirmed(accepted);
    }
    dialog.close();
}

/// The browser arguments: the Chromium features Tauri's own arguments turn
/// off (passing any arguments replaces Tauri's), the JavaScript heap limit
/// lifted, the English locale, and autoplay without a user gesture; under test also the DevTools
/// port and the switches that keep a hidden page rendering. Chromium
/// honours only the last `--disable-features`, so every disabled feature
/// goes in one switch.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn browser_arguments(testing_port: Option<&str>) -> String {
    let mut features = vec!["msWebOOUI", "msPdfOOUI", "msSmartScreenProtection"];
    let mut arguments = vec![
        "--js-flags=--max-old-space-size=0".to_string(),
        "--lang=en-US".to_string(),
        "--autoplay-policy=no-user-gesture-required".to_string(),
    ];
    if let Some(port) = testing_port {
        features.push("CalculateNativeWinOcclusion");
        arguments.push(format!("--remote-debugging-port={port}"));
        arguments.push("--disable-backgrounding-occluded-windows".to_string());
        arguments.push("--disable-background-timer-throttling".to_string());
        arguments.push("--disable-renderer-backgrounding".to_string());
    }
    arguments.insert(0, format!("--disable-features={}", features.join(",")));
    arguments.join(" ")
}

/// Turns off the WebView2 features the app does not use: the status
/// bar, the browser's own accelerator keys, zoom and pinch zoom, swipe
/// navigation, and general and password autofill; and sets the profile's
/// tracking prevention to none. The built-in
/// context menu stays on, so WebView2 raises its requests, which
/// `answer_context_menus` answers without ever showing it.
#[cfg(windows)]
pub fn apply_webview_settings(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        let _ = set_webview_settings(&webview.controller());
    })
}

/// Sets each WebView2 setting and the tracking prevention level.
#[cfg(windows)]
fn set_webview_settings(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_NONE, ICoreWebView2_13, ICoreWebView2Profile3,
        ICoreWebView2Settings6,
    };
    use windows::core::Interface;

    // Safe: plain setters on the live webview's settings and profile.
    unsafe {
        let core = controller.CoreWebView2()?;
        let settings: ICoreWebView2Settings6 = core.Settings()?.cast()?;
        settings.SetIsStatusBarEnabled(false)?;
        settings.SetAreBrowserAcceleratorKeysEnabled(false)?;
        settings.SetIsZoomControlEnabled(false)?;
        settings.SetIsPinchZoomEnabled(false)?;
        settings.SetAreDefaultContextMenusEnabled(true)?;
        settings.SetIsSwipeNavigationEnabled(false)?;
        settings.SetIsGeneralAutofillEnabled(false)?;
        settings.SetIsPasswordAutosaveEnabled(false)?;
        let profile: ICoreWebView2Profile3 = core.cast::<ICoreWebView2_13>()?.Profile()?.cast()?;
        profile.SetPreferredTrackingPreventionLevel(COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_NONE)?;
    }
    Ok(())
}

/// The browser arguments the webview was created with.
#[cfg(windows)]
static BROWSER_ARGUMENTS: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Records the browser arguments the webview is created with.
#[cfg(windows)]
pub fn record_browser_arguments(arguments: &str) {
    let _ = BROWSER_ARGUMENTS.set(arguments.to_string());
}

/// The WebView2 settings in effect, read back from the webview, and the
/// browser arguments it was created with, as the test hooks report them;
/// without WebView2, nothing.
#[cfg(feature = "test-hooks")]
pub fn describe_settings(window: &tauri::WebviewWindow) -> serde_json::Value {
    let settings = read_settings(window).unwrap_or_else(|| serde_json::json!({}));
    #[cfg(windows)]
    let settings = {
        let mut settings = settings;
        settings["browserArguments"] =
            serde_json::json!(BROWSER_ARGUMENTS.get().cloned().unwrap_or_default());
        settings
    };
    settings
}

/// Reads the settings back on the main thread, where the webview lives.
#[cfg(all(windows, feature = "test-hooks"))]
fn read_settings(window: &tauri::WebviewWindow) -> Option<serde_json::Value> {
    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            let _ = sender.send(settings_of(&webview.controller()).ok());
        })
        .ok()?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .ok()
        .flatten()
}

/// Only WebView2 has these settings.
#[cfg(all(not(windows), feature = "test-hooks"))]
fn read_settings(_window: &tauri::WebviewWindow) -> Option<serde_json::Value> {
    None
}

/// Each WebView2 setting the app changes from its default, and
/// the profile's tracking prevention level.
#[cfg(all(windows, feature = "test-hooks"))]
fn settings_of(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
) -> windows::core::Result<serde_json::Value> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_TRACKING_PREVENTION_LEVEL, ICoreWebView2_13, ICoreWebView2Profile3,
        ICoreWebView2Settings6,
    };
    use windows::core::{BOOL, Interface};

    /// Reads one boolean setting through its getter.
    fn flag(
        get: impl FnOnce(*mut BOOL) -> windows::core::Result<()>,
    ) -> windows::core::Result<bool> {
        let mut value = BOOL::default();
        get(&mut value)?;
        Ok(value.as_bool())
    }

    // Safe: every out-pointer points at a local that outlives its call.
    unsafe {
        let core = controller.CoreWebView2()?;
        let settings: ICoreWebView2Settings6 = core.Settings()?.cast()?;
        let profile: ICoreWebView2Profile3 = core.cast::<ICoreWebView2_13>()?.Profile()?.cast()?;
        let mut level = COREWEBVIEW2_TRACKING_PREVENTION_LEVEL::default();
        profile.PreferredTrackingPreventionLevel(&mut level)?;
        Ok(serde_json::json!({
            "statusBar": flag(|value| settings.IsStatusBarEnabled(value))?,
            "browserAcceleratorKeys": flag(|value| settings.AreBrowserAcceleratorKeysEnabled(value))?,
            "zoomControl": flag(|value| settings.IsZoomControlEnabled(value))?,
            "pinchZoom": flag(|value| settings.IsPinchZoomEnabled(value))?,
            "defaultContextMenus": flag(|value| settings.AreDefaultContextMenusEnabled(value))?,
            "swipeNavigation": flag(|value| settings.IsSwipeNavigationEnabled(value))?,
            "generalAutofill": flag(|value| settings.IsGeneralAutofillEnabled(value))?,
            "passwordAutosave": flag(|value| settings.IsPasswordAutosaveEnabled(value))?,
            "defaultScriptDialogs": flag(|value| settings.AreDefaultScriptDialogsEnabled(value))?,
            "trackingPrevention": tracking_level_name(level.0),
        }))
    }
}

/// The name of a WebView2 tracking prevention level.
#[cfg(all(windows, feature = "test-hooks"))]
fn tracking_level_name(level: i32) -> &'static str {
    match level {
        0 => "none",
        1 => "basic",
        2 => "balanced",
        _ => "strict",
    }
}

/// The shortcut a key press makes, written the way the menu template
/// writes accelerators: `CmdOrCtrl`, `Alt` and `Shift`, in that order,
/// then the key. A letter, digit or comma pressed without Ctrl or Alt is
/// typing, not a shortcut.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn shortcut_for_key(virtual_key: u32, ctrl: bool, alt: bool, shift: bool) -> Option<String> {
    let key = match virtual_key {
        0x30..=0x39 | 0x41..=0x5A => char::from_u32(virtual_key)?.to_string(),
        0xBC => ",".to_string(),
        0x70..=0x87 => format!("F{}", virtual_key - 0x6F),
        _ => return None,
    };
    let function_key = (0x70..=0x87).contains(&virtual_key);
    if !function_key && !ctrl && !alt {
        return None;
    }
    let mut shortcut = String::new();
    if ctrl {
        shortcut.push_str("CmdOrCtrl+");
    }
    if alt {
        shortcut.push_str("Alt+");
    }
    if shift {
        shortcut.push_str("Shift+");
    }
    shortcut.push_str(&key);
    Some(shortcut)
}

/// The menu letter a key press opens: a letter pressed with Alt and
/// without Ctrl, when it is one of the top-level menus' access letters.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn menu_access_key(virtual_key: u32, ctrl: bool, alt: bool, letters: &[char]) -> Option<char> {
    if ctrl || !alt || !(0x41..=0x5A).contains(&virtual_key) {
        return None;
    }
    let letter = char::from_u32(virtual_key)?.to_ascii_lowercase();
    letters.contains(&letter).then_some(letter)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_key_pressed_with_ctrl_as_the_menu_template_does() {
        assert_eq!(
            shortcut_for_key(0x4E, true, false, false).as_deref(),
            Some("CmdOrCtrl+N")
        );
        assert_eq!(
            shortcut_for_key(0x53, true, false, true).as_deref(),
            Some("CmdOrCtrl+Shift+S")
        );
        assert_eq!(
            shortcut_for_key(0xBC, true, false, false).as_deref(),
            Some("CmdOrCtrl+,")
        );
        assert_eq!(
            shortcut_for_key(0x31, true, false, false).as_deref(),
            Some("CmdOrCtrl+1")
        );
    }

    #[test]
    fn names_function_keys_with_and_without_alt() {
        assert_eq!(
            shortcut_for_key(0x7B, false, false, false).as_deref(),
            Some("F12")
        );
        assert_eq!(
            shortcut_for_key(0x73, false, true, false).as_deref(),
            Some("Alt+F4")
        );
    }

    #[test]
    fn plain_typing_and_unnamed_keys_are_not_shortcuts() {
        assert_eq!(shortcut_for_key(0x4E, false, false, false), None);
        assert_eq!(shortcut_for_key(0x4E, false, false, true), None);
        assert_eq!(shortcut_for_key(0x11, true, false, false), None);
    }

    #[test]
    fn names_the_menu_letter_pressed_with_alt() {
        let letters = ['f', 'e', 'v', 'h'];
        assert_eq!(menu_access_key(0x46, false, true, &letters), Some('f'));
        assert_eq!(menu_access_key(0x48, false, true, &letters), Some('h'));
    }

    #[test]
    fn opens_no_menu_without_alt_with_ctrl_or_for_another_key() {
        let letters = ['f', 'e', 'v', 'h'];
        assert_eq!(menu_access_key(0x46, false, false, &letters), None);
        assert_eq!(menu_access_key(0x46, true, true, &letters), None);
        assert_eq!(menu_access_key(0x51, false, true, &letters), None);
        assert_eq!(menu_access_key(0x73, false, true, &letters), None);
    }
}
