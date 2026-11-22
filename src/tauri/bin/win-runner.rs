//! The Windows runner for the real-input tests. It finds the app's window
//! by the app's process id, brings it to the front, sends real keyboard
//! and mouse input through `SendInput`, and reports the window's title and
//! the menu that is open. It sends keys only while the app's window is in
//! front, and clicks only where the app's window is the one under the
//! point, so input never goes to another program. One command per run;
//! the answer is one JSON line on standard output, an error a message on
//! standard error and exit code 1.
//!
//! Commands:
//! - `window <pid>`: the window's title, whether it is visible and in
//!   front, and its client area on screen, in physical pixels
//! - `focus <pid>`: brings the window to the front
//! - `keys <pid> <combination>...`: presses each key combination in turn,
//!   written as Playwright writes them: `Control+Shift+Z`, `Alt`, `F10`
//! - `type <pid> <text>`: types the text
//! - `click <pid> <x> <y>`: clicks at a point of the client area, in
//!   physical pixels
//! - `menu <pid>`: whether the window's thread is in menu mode, and the
//!   items of the popup menu that is open, if any

use serde_json::Value;

/// The virtual-key code of a modifier key name.
fn modifier_key(name: &str) -> Option<u16> {
    match name.to_ascii_lowercase().as_str() {
        "control" | "ctrl" => Some(0x11),
        "shift" => Some(0x10),
        "alt" => Some(0x12),
        _ => None,
    }
}

/// The virtual-key code of a key name that is not a modifier: a letter or
/// digit, a function key, a punctuation key, or a named key.
fn key_code(name: &str) -> Option<u16> {
    let mut chars = name.chars();
    if let (Some(single), None) = (chars.next(), chars.next()) {
        if single.is_ascii_alphanumeric() {
            return Some(single.to_ascii_uppercase() as u16);
        }
    }
    if let Some(number) = name.strip_prefix('F').and_then(|n| n.parse::<u16>().ok()) {
        if (1..=24).contains(&number) {
            return Some(0x6F + number);
        }
    }
    let code = match name {
        "," | "Comma" => 0xBC,
        "-" | "Minus" => 0xBD,
        "." | "Period" => 0xBE,
        "=" | "Equal" => 0xBB,
        "/" | "Slash" => 0xBF,
        ";" | "Semicolon" => 0xBA,
        "`" | "Backquote" => 0xC0,
        "[" | "BracketLeft" => 0xDB,
        "]" | "BracketRight" => 0xDD,
        "\\" | "Backslash" => 0xDC,
        "'" | "Quote" => 0xDE,
        "Backspace" => 0x08,
        "Tab" => 0x09,
        "Enter" => 0x0D,
        "Escape" => 0x1B,
        "Space" => 0x20,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "End" => 0x23,
        "Home" => 0x24,
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        "Insert" => 0x2D,
        "Delete" => 0x2E,
        _ => return None,
    };
    Some(code)
}

/// A key combination written as `Modifier+...+Key`: the virtual-key codes
/// of the modifiers to hold, and of the key to press. A modifier on its
/// own (`Alt`) is pressed as the key.
fn parse_combo(combo: &str) -> Result<(Vec<u16>, u16), String> {
    let parts: Vec<&str> = combo.split('+').collect();
    let (key, modifiers) = parts
        .split_last()
        .ok_or_else(|| format!("no key in {combo:?}"))?;
    let modifiers = modifiers
        .iter()
        .map(|name| modifier_key(name).ok_or_else(|| format!("unknown modifier {name:?}")))
        .collect::<Result<Vec<u16>, String>>()?;
    let key = modifier_key(key)
        .or_else(|| key_code(key))
        .ok_or_else(|| format!("unknown key {key:?} in {combo:?}"))?;
    Ok((modifiers, key))
}

/// A screen point as `SendInput`'s absolute coordinates, which run from 0
/// to 65535 across the virtual desktop given as left, top, width and
/// height.
fn absolute_point(x: i32, y: i32, desktop: (i32, i32, i32, i32)) -> (i32, i32) {
    let (left, top, width, height) = desktop;
    let scale = |value: i32, origin: i32, size: i32| {
        (i64::from(value - origin) * 65535 / i64::from((size - 1).max(1))) as i32
    };
    (scale(x, left, width), scale(y, top, height))
}

/// The process id named by a command's first argument.
#[cfg_attr(not(windows), allow(dead_code))]
fn pid_argument(args: &[String]) -> Result<u32, String> {
    args.first()
        .and_then(|pid| pid.parse().ok())
        .ok_or_else(|| "a process id is needed".to_string())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(answer) => println!("{answer}"),
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
}

/// Runs one command.
#[cfg(windows)]
fn run(args: &[String]) -> Result<Value, String> {
    windows_input::run(args)
}

/// The runner sends input through Windows only.
#[cfg(not(windows))]
fn run(_args: &[String]) -> Result<Value, String> {
    let _ = (parse_combo, absolute_point);
    Err("the runner works on Windows only".to_string())
}

#[cfg(windows)]
mod windows_input {
    use super::{absolute_point, parse_combo, pid_argument};
    use serde_json::{Value, json};
    use std::time::Duration;
    use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::HiDpi::{
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC,
        MOUSE_EVENT_FLAGS, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT, MapVirtualKeyW, SendInput,
        VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GA_ROOT, GUI_INMENUMODE, GUITHREADINFO, GetAncestor,
        GetClassNameW, GetClientRect, GetForegroundWindow, GetGUIThreadInfo, GetMenu,
        GetMenuItemCount, GetMenuStringW, GetSystemMetrics, GetWindowTextW,
        GetWindowThreadProcessId, HMENU, IsIconic, IsWindowVisible, MF_BYPOSITION, MN_GETHMENU,
        SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_RESTORE,
        SendMessageW, SetForegroundWindow, ShowWindow, WindowFromPoint,
    };
    use windows::core::BOOL;

    /// How long `focus` waits for the window to come to the front.
    const FOCUS_TRIES: u32 = 50;

    /// Runs one command.
    pub fn run(args: &[String]) -> Result<Value, String> {
        // Safe: sets this process's own DPI awareness before any window
        // call, so coordinates are physical pixels on every monitor.
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        let (command, rest) = args
            .split_first()
            .ok_or_else(|| "a command is needed".to_string())?;
        let pid = pid_argument(rest)?;
        let window = app_window(pid).ok_or_else(|| format!("no app window for process {pid}"))?;
        let arguments = &rest[1..];
        match command.as_str() {
            "window" => Ok(describe_window(window, pid)),
            "focus" => {
                if focus(window, pid) {
                    Ok(describe_window(window, pid))
                } else {
                    Err("the app's window did not come to the front".to_string())
                }
            }
            "keys" => {
                for combo in arguments {
                    let (modifiers, key) = parse_combo(combo)?;
                    require_in_front(pid)?;
                    send_combo(&modifiers, key);
                    std::thread::sleep(Duration::from_millis(50));
                }
                Ok(json!(true))
            }
            "type" => {
                let text = arguments.join(" ");
                require_in_front(pid)?;
                send_text(&text);
                Ok(json!(true))
            }
            "click" => {
                let number = |index: usize| {
                    arguments
                        .get(index)
                        .and_then(|value| value.parse::<f64>().ok())
                        .map(|value| value.round() as i32)
                        .ok_or_else(|| "click needs x and y".to_string())
                };
                click(window, number(0)?, number(1)?)?;
                Ok(json!(true))
            }
            "menu" => Ok(menu_state(window)),
            other => Err(format!("unknown command {other}")),
        }
    }

    /// The process whose thread owns a window.
    fn window_process(window: HWND) -> u32 {
        let mut process = 0u32;
        // Safe: the out-pointer points at a local.
        unsafe {
            GetWindowThreadProcessId(window, Some(&mut process));
        }
        process
    }

    /// What the search for the app's window is looking for, and what it
    /// found.
    struct WindowSearch {
        pid: u32,
        found: Option<HWND>,
    }

    /// Stops at the first top-level window of the process that has a menu
    /// bar.
    unsafe extern "system" fn visit_window(window: HWND, data: LPARAM) -> BOOL {
        // Safe: `data` is the `WindowSearch` that `app_window` passed.
        let search = unsafe { &mut *(data.0 as *mut WindowSearch) };
        // Safe: reads the menu handle of a window being enumerated.
        let has_menu = unsafe { !GetMenu(window).is_invalid() };
        if window_process(window) == search.pid && has_menu {
            search.found = Some(window);
            return BOOL(0);
        }
        BOOL(1)
    }

    /// The app's main window: the process's top-level window with a menu
    /// bar.
    fn app_window(pid: u32) -> Option<HWND> {
        let mut search = WindowSearch { pid, found: None };
        // Safe: the search outlives the enumeration, which is synchronous.
        unsafe {
            let _ = EnumWindows(
                Some(visit_window),
                LPARAM(&mut search as *mut WindowSearch as isize),
            );
        }
        search.found
    }

    /// A window's title.
    fn window_title(window: HWND) -> String {
        let mut buffer = [0u16; 512];
        // Safe: the buffer outlives the call.
        let length = unsafe { GetWindowTextW(window, &mut buffer) };
        String::from_utf16_lossy(&buffer[..length.max(0) as usize])
    }

    /// A window's class name.
    fn class_name(window: HWND) -> String {
        let mut buffer = [0u16; 256];
        // Safe: the buffer outlives the call.
        let length = unsafe { GetClassNameW(window, &mut buffer) };
        String::from_utf16_lossy(&buffer[..length.max(0) as usize])
    }

    /// The window's client area on screen: left, top, width and height.
    fn client_area(window: HWND) -> (i32, i32, i32, i32) {
        let mut rect = RECT::default();
        let mut origin = POINT { x: 0, y: 0 };
        // Safe: both out-pointers point at locals.
        unsafe {
            let _ = GetClientRect(window, &mut rect);
            let _ = ClientToScreen(window, &mut origin);
        }
        (
            origin.x,
            origin.y,
            rect.right - rect.left,
            rect.bottom - rect.top,
        )
    }

    /// The window's title, visibility, whether the app is in front, and
    /// its client area.
    fn describe_window(window: HWND, pid: u32) -> Value {
        let (x, y, width, height) = client_area(window);
        // Safe: reads a window's visibility.
        let visible = unsafe { IsWindowVisible(window).as_bool() };
        json!({
            "title": window_title(window),
            "visible": visible,
            "inFront": app_in_front(pid),
            "client": { "x": x, "y": y, "width": width, "height": height },
        })
    }

    /// Whether the window in front belongs to the process.
    fn app_in_front(pid: u32) -> bool {
        // Safe: reads the foreground window.
        let front = unsafe { GetForegroundWindow() };
        window_process(front) == pid
    }

    /// Refuses input unless the app's window is in front.
    fn require_in_front(pid: u32) -> Result<(), String> {
        if app_in_front(pid) {
            Ok(())
        } else {
            Err("the app's window is not in front; no input was sent".to_string())
        }
    }

    /// Brings the window to the front, borrowing the input state of the
    /// window in front, as Windows lets only that one hand the front on.
    fn focus(window: HWND, pid: u32) -> bool {
        // Safe: plain window calls on live window handles; the input
        // attachment is undone before returning.
        unsafe {
            if IsIconic(window).as_bool() {
                let _ = ShowWindow(window, SW_RESTORE);
            }
            let front = GetForegroundWindow();
            let front_thread = GetWindowThreadProcessId(front, None);
            let this_thread = GetCurrentThreadId();
            let attached = front_thread != 0
                && front_thread != this_thread
                && AttachThreadInput(this_thread, front_thread, true).as_bool();
            let _ = BringWindowToTop(window);
            let _ = SetForegroundWindow(window);
            if attached {
                let _ = AttachThreadInput(this_thread, front_thread, false);
            }
        }
        for _ in 0..FOCUS_TRIES {
            if app_in_front(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    /// Whether a virtual key is one of the extended keys, which `SendInput`
    /// must mark so they are not taken for their number-pad twins.
    fn is_extended(key: u16) -> bool {
        matches!(key, 0x21..=0x28 | 0x2D | 0x2E)
    }

    /// One keyboard event for a virtual key.
    fn key_event(key: u16, up: bool) -> INPUT {
        // Safe: maps a virtual key to its scan code.
        let scan = unsafe { MapVirtualKeyW(u32::from(key), MAPVK_VK_TO_VSC) } as u16;
        let mut flags = KEYBD_EVENT_FLAGS(0);
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        if is_extended(key) {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(key),
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    /// Sends input events.
    fn send(inputs: &[INPUT]) {
        // Safe: every entry is a fully initialized input of the size passed.
        unsafe {
            SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    /// Presses a key combination: the modifiers down, the key down and up,
    /// the modifiers up.
    fn send_combo(modifiers: &[u16], key: u16) {
        let mut inputs: Vec<INPUT> = modifiers.iter().map(|&m| key_event(m, false)).collect();
        inputs.push(key_event(key, false));
        inputs.push(key_event(key, true));
        inputs.extend(modifiers.iter().rev().map(|&m| key_event(m, true)));
        send(&inputs);
    }

    /// Types text as Unicode key events.
    fn send_text(text: &str) {
        let inputs: Vec<INPUT> = text
            .encode_utf16()
            .flat_map(|unit| {
                [false, true].map(|up| {
                    let mut flags = KEYEVENTF_UNICODE;
                    if up {
                        flags |= KEYEVENTF_KEYUP;
                    }
                    INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: VIRTUAL_KEY(0),
                                wScan: unit,
                                dwFlags: flags,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    }
                })
            })
            .collect();
        send(&inputs);
    }

    /// One mouse event at absolute coordinates.
    fn mouse_event(x: i32, y: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: x,
                    dy: y,
                    mouseData: 0,
                    dwFlags: flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    /// Clicks at a point of the window's client area, if the window is the
    /// one under that point.
    fn click(window: HWND, x: i32, y: i32) -> Result<(), String> {
        let mut point = POINT { x, y };
        // Safe: plain window and metrics calls; the out-pointer points at a
        // local.
        let (under, desktop) = unsafe {
            let _ = ClientToScreen(window, &mut point);
            let under = GetAncestor(WindowFromPoint(point), GA_ROOT);
            let desktop = (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            );
            (under, desktop)
        };
        if under != window {
            return Err("another window covers that point; no click was sent".to_string());
        }
        let (ax, ay) = absolute_point(point.x, point.y, desktop);
        send(&[
            mouse_event(ax, ay, MOUSEEVENTF_MOVE),
            mouse_event(ax, ay, MOUSEEVENTF_LEFTDOWN),
            mouse_event(ax, ay, MOUSEEVENTF_LEFTUP),
        ]);
        Ok(())
    }

    /// What the search for an open popup menu is looking for, and what it
    /// found.
    struct MenuSearch {
        thread: u32,
        found: Option<HWND>,
    }

    /// Stops at the first visible popup menu window of the thread.
    unsafe extern "system" fn visit_menu(window: HWND, data: LPARAM) -> BOOL {
        // Safe: `data` is the `MenuSearch` that `open_popup` passed.
        let search = unsafe { &mut *(data.0 as *mut MenuSearch) };
        // Safe: reads a window's thread and visibility.
        let (thread, visible) = unsafe {
            (
                GetWindowThreadProcessId(window, None),
                IsWindowVisible(window).as_bool(),
            )
        };
        if thread == search.thread && visible && class_name(window) == "#32768" {
            search.found = Some(window);
            return BOOL(0);
        }
        BOOL(1)
    }

    /// The visible popup menu window of a thread, if one is open.
    fn open_popup(thread: u32) -> Option<HWND> {
        let mut search = MenuSearch {
            thread,
            found: None,
        };
        // Safe: the search outlives the enumeration, which is synchronous.
        unsafe {
            let _ = EnumWindows(
                Some(visit_menu),
                LPARAM(&mut search as *mut MenuSearch as isize),
            );
        }
        search.found
    }

    /// The item texts of a menu, as Windows holds them (`&` before the
    /// access letter, the shortcut after a tab), separators as empty
    /// strings.
    fn menu_items(menu: HMENU) -> Vec<String> {
        // Safe: reads the items of a live menu into a local buffer.
        unsafe {
            let count = GetMenuItemCount(Some(menu)).max(0);
            (0..count)
                .map(|index| {
                    let mut buffer = [0u16; 256];
                    let length =
                        GetMenuStringW(menu, index as u32, Some(&mut buffer), MF_BYPOSITION);
                    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
                })
                .collect()
        }
    }

    /// Whether the window's thread is in menu mode, and the items of the
    /// popup menu that is open, if any.
    fn menu_state(window: HWND) -> Value {
        // Safe: reads the window's thread and that thread's GUI state into
        // a local.
        let (thread, active) = unsafe {
            let thread = GetWindowThreadProcessId(window, None);
            let mut info = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            let active = GetGUIThreadInfo(thread, &mut info).is_ok()
                && (info.flags.0 & GUI_INMENUMODE.0) != 0;
            (thread, active)
        };
        let items = open_popup(thread).map(|popup| {
            // Safe: asks the popup menu window for its menu.
            let menu = unsafe { SendMessageW(popup, MN_GETHMENU, None, None) };
            menu_items(HMENU(menu.0 as *mut std::ffi::c_void))
        });
        json!({ "active": active, "items": items })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win_runner_reads_a_key_with_modifiers() {
        assert_eq!(parse_combo("Control+Z"), Ok((vec![0x11], 0x5A)));
        assert_eq!(parse_combo("Control+Shift+R"), Ok((vec![0x11, 0x10], 0x52)));
        assert_eq!(parse_combo("Alt+F4"), Ok((vec![0x12], 0x73)));
        assert_eq!(parse_combo("Control+1"), Ok((vec![0x11], 0x31)));
        assert_eq!(parse_combo("control+a"), Ok((vec![0x11], 0x41)));
    }

    #[test]
    fn win_runner_reads_a_modifier_and_named_keys_on_their_own() {
        assert_eq!(parse_combo("Alt"), Ok((vec![], 0x12)));
        assert_eq!(parse_combo("F10"), Ok((vec![], 0x79)));
        assert_eq!(parse_combo("F12"), Ok((vec![], 0x7B)));
        assert_eq!(parse_combo("Escape"), Ok((vec![], 0x1B)));
        assert_eq!(parse_combo("End"), Ok((vec![], 0x23)));
        assert_eq!(parse_combo("ArrowLeft"), Ok((vec![], 0x25)));
    }

    #[test]
    fn win_runner_reads_punctuation_keys() {
        assert_eq!(parse_combo("Control+,"), Ok((vec![0x11], 0xBC)));
        assert_eq!(parse_combo("Control+Comma"), Ok((vec![0x11], 0xBC)));
        assert_eq!(parse_combo("Control+`"), Ok((vec![0x11], 0xC0)));
        assert_eq!(parse_combo("Control+Shift+-"), Ok((vec![0x11, 0x10], 0xBD)));
    }

    #[test]
    fn win_runner_refuses_what_it_cannot_press() {
        assert!(parse_combo("").is_err());
        assert!(parse_combo("Control+Banana").is_err());
        assert!(parse_combo("Hyper+A").is_err());
        assert!(parse_combo("Control+").is_err());
    }

    #[test]
    fn win_runner_scales_a_point_across_the_virtual_desktop() {
        let primary = (0, 0, 1920, 1080);
        assert_eq!(absolute_point(0, 0, primary), (0, 0));
        assert_eq!(absolute_point(1919, 1079, primary), (65535, 65535));
        let two = (-1920, 0, 3840, 1080);
        assert_eq!(absolute_point(-1920, 0, two), (0, 0));
        assert_eq!(absolute_point(1919, 1079, two), (65535, 65535));
        assert_eq!(absolute_point(0, 540, two).0, 32776);
    }
}
