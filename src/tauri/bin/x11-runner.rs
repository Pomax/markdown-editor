//! The X11 runner for the Linux tests. It finds the app's window on the X
//! display that `DISPLAY` names, by the app's process id, gives it the
//! input focus, and sends real keyboard and mouse input through the XTEST
//! extension. It sends keys only while the app's window has the input
//! focus, and moves the pointer only where one of the app's windows, or
//! the window manager's frame around it, is the one under the point, so
//! input never goes to another program. One command per run; the answer
//! is one JSON line on standard output, an error a message on standard
//! error and exit code 1. Run as `serve`, it runs commands until standard
//! input ends instead, each a line holding the JSON array of one run's
//! arguments, and answers each with a JSON line on standard output:
//! `{"ok": answer}`, or `{"error": message}`.
//!
//! Commands:
//! - `window <pid>`: the window's title, whether it is mapped and has the
//!   input focus, and its client area on the screen
//! - `focus <pid>`: gives the window the input focus
//! - `keys <pid> <combination>...`: presses each key combination in turn,
//!   written as Playwright writes them: `Control+Shift+Z`, `Alt`, `F10`
//! - `type <pid> <text>`: types the text
//! - `click <pid> <x> <y> [count] [button]`: clicks a button, `left`,
//!   `middle` or `right`, at a point of the client area, `count` times;
//!   once with the left button when they are not given
//! - `move <pid> <x> <y>`: moves the pointer to a point of the client area
//! - `down <pid> <x> <y> [button]` and `up <pid> <x> <y> [button]`: moves
//!   the pointer to a point of the client area, and presses or releases a
//!   button there, the left one when it is not given
//!
//! `keys` and `type` answer with the number of keys they released, so a
//! caller can wait until the page has seen every release; the other input
//! commands answer `true`.

use serde_json::{Value, json};
use std::io::{BufRead, Write};

/// The keysym of a modifier key name.
fn modifier_keysym(name: &str) -> Option<u32> {
    match name.to_ascii_lowercase().as_str() {
        "control" | "ctrl" => Some(0xffe3),
        "shift" => Some(0xffe1),
        "alt" => Some(0xffe9),
        "meta" => Some(0xffeb),
        _ => None,
    }
}

/// The keysym that types a character: a newline is Return, a tab is Tab,
/// a Latin-1 character is its own keysym, and every other character is
/// its Unicode keysym.
fn char_keysym(character: char) -> u32 {
    let code = character as u32;
    match character {
        '\n' => 0xff0d,
        '\t' => 0xff09,
        _ if (0x20..=0x7e).contains(&code) || (0xa0..=0xff).contains(&code) => code,
        _ => 0x0100_0000 | code,
    }
}

/// The keysym of a key name that is not a modifier: a single character
/// (a letter whatever its case, as on Windows, so Shift is pressed only
/// when the combination names it), a function key, a punctuation key's
/// name, or a named key.
fn key_keysym(name: &str) -> Option<u32> {
    let mut chars = name.chars();
    if let (Some(single), None) = (chars.next(), chars.next()) {
        return Some(char_keysym(single.to_ascii_lowercase()));
    }
    if let Some(number) = name.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
        if (1..=24).contains(&number) {
            return Some(0xffbd + number);
        }
    }
    let keysym = match name {
        "Comma" => 0x2c,
        "Minus" => 0x2d,
        "Period" => 0x2e,
        "Equal" => 0x3d,
        "Slash" => 0x2f,
        "Semicolon" => 0x3b,
        "Backquote" => 0x60,
        "BracketLeft" => 0x5b,
        "BracketRight" => 0x5d,
        "Backslash" => 0x5c,
        "Quote" => 0x27,
        "Space" => 0x20,
        "Backspace" => 0xff08,
        "Tab" => 0xff09,
        "Enter" => 0xff0d,
        "Escape" => 0xff1b,
        "Home" => 0xff50,
        "ArrowLeft" => 0xff51,
        "ArrowUp" => 0xff52,
        "ArrowRight" => 0xff53,
        "ArrowDown" => 0xff54,
        "PageUp" => 0xff55,
        "PageDown" => 0xff56,
        "End" => 0xff57,
        "Insert" => 0xff63,
        "Delete" => 0xffff,
        _ => return None,
    };
    Some(keysym)
}

/// A key combination written as `Modifier+...+Key`: the keysyms of the
/// modifiers to hold, and of the key to press. A modifier on its own
/// (`Alt`) is pressed as the key.
fn parse_combo(combo: &str) -> Result<(Vec<u32>, u32), String> {
    let parts: Vec<&str> = combo.split('+').collect();
    let (key, modifiers) = parts
        .split_last()
        .ok_or_else(|| format!("no key in {combo:?}"))?;
    let modifiers = modifiers
        .iter()
        .map(|name| modifier_keysym(name).ok_or_else(|| format!("unknown modifier {name:?}")))
        .collect::<Result<Vec<u32>, String>>()?;
    let key = modifier_keysym(key)
        .or_else(|| key_keysym(key))
        .ok_or_else(|| format!("unknown key {key:?} in {combo:?}"))?;
    Ok((modifiers, key))
}

/// The X button number of a button name: 1 for `left`, 2 for `middle`,
/// 3 for `right`.
fn button_number(name: &str) -> Result<u8, String> {
    match name {
        "left" => Ok(1),
        "middle" => Ok(2),
        "right" => Ok(3),
        _ => Err(format!("unknown button {name:?}")),
    }
}

/// The keyboard mapping: the first keycode, how many keysyms each keycode
/// has, and those keysyms, keycode by keycode.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct Keymap {
    first: u8,
    per_keycode: usize,
    keysyms: Vec<u32>,
}

impl Keymap {
    /// The keycode that types a keysym, and whether it needs Shift: the
    /// first keycode with the keysym unshifted, or else the first with it
    /// shifted.
    fn find(&self, keysym: u32) -> Option<(u8, bool)> {
        if self.per_keycode == 0 {
            return None;
        }
        for level in 0..self.per_keycode.min(2) {
            for (index, keysyms) in self.keysyms.chunks(self.per_keycode).enumerate() {
                if keysyms.get(level) == Some(&keysym) {
                    let keycode = u8::try_from(usize::from(self.first) + index).ok()?;
                    return Some((keycode, level == 1));
                }
            }
        }
        None
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["serve"] {
        if let Err(error) = serve(std::io::stdin().lock(), std::io::stdout().lock(), run) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    match run(&args) {
        Ok(answer) => println!("{answer}"),
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
}

/// Runs the commands that arrive on `input` until it ends, each a line
/// holding the JSON array of one run's arguments, and answers each with a
/// line on `output`: `{"ok": answer}`, or `{"error": message}`.
fn serve(
    input: impl BufRead,
    mut output: impl Write,
    run: impl Fn(&[String]) -> Result<Value, String>,
) -> std::io::Result<()> {
    for line in input.lines() {
        let line = line?;
        let answer = match serde_json::from_str::<Vec<String>>(&line) {
            Ok(args) => match run(&args) {
                Ok(answer) => json!({ "ok": answer }),
                Err(message) => json!({ "error": message }),
            },
            Err(error) => json!({ "error": format!("{line:?} is not a command: {error}") }),
        };
        writeln!(output, "{answer}")?;
        output.flush()?;
    }
    Ok(())
}

/// Runs one command.
#[cfg(target_os = "linux")]
fn run(args: &[String]) -> Result<Value, String> {
    x11_input::run(args)
}

/// The runner sends input through X11 on Linux only.
#[cfg(not(target_os = "linux"))]
fn run(_args: &[String]) -> Result<Value, String> {
    let _ = (parse_combo, char_keysym, button_number, Keymap::find);
    Err("the runner works on Linux only".to_string())
}

#[cfg(target_os = "linux")]
mod x11_input {
    use super::{Keymap, button_number, char_keysym, parse_combo};
    use serde_json::{Value, json};
    use std::time::Duration;
    use x11rb::CURRENT_TIME;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{
        AtomEnum, BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ClientMessageEvent, ConfigureWindowAux,
        ConnectionExt as _, EventMask, InputFocus, KEY_PRESS_EVENT, KEY_RELEASE_EVENT,
        MOTION_NOTIFY_EVENT, MapState, StackMode, Window,
    };
    use x11rb::protocol::xtest::ConnectionExt as _;
    use x11rb::rust_connection::RustConnection;
    use x11rb::wrapper::ConnectionExt as _;

    /// The keysym of the left Shift key.
    const SHIFT: u32 = 0xffe1;

    /// How often `focus` checks that the window has the input focus, 10 ms
    /// apart.
    const FOCUS_TRIES: u32 = 50;

    /// The input focus value that means the focus follows the pointer, as
    /// it does before any window has taken the focus.
    const POINTER_ROOT: Window = 1;

    /// The message of a failed X11 request.
    fn failed(error: impl std::fmt::Display) -> String {
        format!("X11 request failed: {error}")
    }

    /// An atom by name.
    fn atom(connection: &RustConnection, name: &[u8]) -> Result<u32, String> {
        Ok(connection
            .intern_atom(false, name)
            .map_err(failed)?
            .reply()
            .map_err(failed)?
            .atom)
    }

    /// The process id a window's `_NET_WM_PID` names.
    fn window_pid(connection: &RustConnection, window: Window, pid_atom: u32) -> Option<u32> {
        let reply = connection
            .get_property(false, window, pid_atom, AtomEnum::CARDINAL, 0, 1)
            .ok()?
            .reply()
            .ok()?;
        reply.value32()?.next()
    }

    /// The top-level windows: the window manager's list of the windows it
    /// manages, when one runs, or else the root window's children.
    fn top_level_windows(connection: &RustConnection, root: Window) -> Result<Vec<Window>, String> {
        let client_list = atom(connection, b"_NET_CLIENT_LIST")?;
        let managed = connection
            .get_property(false, root, client_list, AtomEnum::WINDOW, 0, 4096)
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        let managed: Vec<Window> = managed.value32().map(Iterator::collect).unwrap_or_default();
        if !managed.is_empty() {
            return Ok(managed);
        }
        Ok(connection
            .query_tree(root)
            .map_err(failed)?
            .reply()
            .map_err(failed)?
            .children)
    }

    /// The process's main window: its largest mapped top-level window
    /// that is not a popup.
    fn app_window(
        connection: &RustConnection,
        root: Window,
        pid: u32,
        pid_atom: u32,
    ) -> Result<Option<Window>, String> {
        let mut largest: Option<(Window, u32)> = None;
        for child in top_level_windows(connection, root)? {
            if window_pid(connection, child, pid_atom) != Some(pid) {
                continue;
            }
            let Ok(attributes) = connection
                .get_window_attributes(child)
                .map_err(failed)?
                .reply()
            else {
                continue;
            };
            if attributes.map_state != MapState::VIEWABLE || attributes.override_redirect {
                continue;
            }
            let Ok(geometry) = connection.get_geometry(child).map_err(failed)?.reply() else {
                continue;
            };
            let area = u32::from(geometry.width) * u32::from(geometry.height);
            if largest.is_none_or(|(_, size)| area > size) {
                largest = Some((child, area));
            }
        }
        Ok(largest.map(|(window, _)| window))
    }

    /// The point of a command's x and y arguments.
    fn point(arguments: &[String]) -> Result<(i32, i32), String> {
        let number = |index: usize| {
            arguments
                .get(index)
                .and_then(|value| value.parse::<f64>().ok())
                .map(|value| value.round() as i32)
                .ok_or_else(|| "x and y are needed".to_string())
        };
        Ok((number(0)?, number(1)?))
    }

    /// The display, and the app's process and main window on it.
    struct App {
        connection: RustConnection,
        root: Window,
        pid: u32,
        pid_atom: u32,
        window: Window,
    }

    impl App {
        /// Opens the display and finds the process's main window on it.
        fn open(pid: u32) -> Result<App, String> {
            let (connection, screen) = x11rb::connect(None)
                .map_err(|error| format!("cannot open the X display: {error}"))?;
            let root = connection.setup().roots[screen].root;
            let pid_atom = atom(&connection, b"_NET_WM_PID")?;
            let window = app_window(&connection, root, pid, pid_atom)?
                .ok_or_else(|| format!("no app window for process {pid}"))?;
            Ok(App {
                connection,
                root,
                pid,
                pid_atom,
                window,
            })
        }

        /// The window's title, from `_NET_WM_NAME` or else `WM_NAME`.
        fn title(&self) -> Result<String, String> {
            let utf8 = atom(&self.connection, b"UTF8_STRING")?;
            let net_name = atom(&self.connection, b"_NET_WM_NAME")?;
            for (property, kind) in [
                (net_name, utf8),
                (AtomEnum::WM_NAME.into(), AtomEnum::STRING.into()),
            ] {
                let reply = self
                    .connection
                    .get_property(false, self.window, property, kind, 0, 1024)
                    .map_err(failed)?
                    .reply()
                    .map_err(failed)?;
                if !reply.value.is_empty() {
                    return Ok(String::from_utf8_lossy(&reply.value).into_owned());
                }
            }
            Ok(String::new())
        }

        /// Whether the input focus is on the window or inside it.
        fn has_focus(&self) -> Result<bool, String> {
            let mut current = self
                .connection
                .get_input_focus()
                .map_err(failed)?
                .reply()
                .map_err(failed)?
                .focus;
            while current != x11rb::NONE && current != POINTER_ROOT && current != self.root {
                if current == self.window {
                    return Ok(true);
                }
                current = self
                    .connection
                    .query_tree(current)
                    .map_err(failed)?
                    .reply()
                    .map_err(failed)?
                    .parent;
            }
            Ok(false)
        }

        /// The window's title, whether it is mapped and has the input
        /// focus, and its client area on the screen.
        fn describe(&self) -> Result<Value, String> {
            let attributes = self
                .connection
                .get_window_attributes(self.window)
                .map_err(failed)?
                .reply()
                .map_err(failed)?;
            let geometry = self
                .connection
                .get_geometry(self.window)
                .map_err(failed)?
                .reply()
                .map_err(failed)?;
            let origin = self
                .connection
                .translate_coordinates(self.window, self.root, 0, 0)
                .map_err(failed)?
                .reply()
                .map_err(failed)?;
            Ok(json!({
                "title": self.title()?,
                "visible": attributes.map_state == MapState::VIEWABLE,
                "inFront": self.has_focus()?,
                "client": {
                    "x": origin.dst_x,
                    "y": origin.dst_y,
                    "width": geometry.width,
                    "height": geometry.height,
                },
            }))
        }

        /// Whether a window manager runs on the display.
        fn has_window_manager(&self) -> Result<bool, String> {
            let check = atom(&self.connection, b"_NET_SUPPORTING_WM_CHECK")?;
            let reply = self
                .connection
                .get_property(false, self.root, check, AtomEnum::WINDOW, 0, 1)
                .map_err(failed)?
                .reply()
                .map_err(failed)?;
            Ok(!reply.value.is_empty())
        }

        /// The window and the windows it sits in below the root window:
        /// with a window manager, the frame around it.
        fn with_frames(&self) -> Result<Vec<Window>, String> {
            let mut chain = vec![self.window];
            let mut current = self.window;
            loop {
                let parent = self
                    .connection
                    .query_tree(current)
                    .map_err(failed)?
                    .reply()
                    .map_err(failed)?
                    .parent;
                if parent == self.root || parent == x11rb::NONE {
                    return Ok(chain);
                }
                chain.push(parent);
                current = parent;
            }
        }

        /// Whether the window manager has taken the window over, which it
        /// marks by setting the window's `_NET_FRAME_EXTENTS`.
        fn is_managed(&self) -> Result<bool, String> {
            let extents = atom(&self.connection, b"_NET_FRAME_EXTENTS")?;
            let reply = self
                .connection
                .get_property(false, self.window, extents, AtomEnum::CARDINAL, 0, 4)
                .map_err(failed)?
                .reply()
                .map_err(failed)?;
            Ok(!reply.value.is_empty())
        }

        /// Raises the window and gives it the input focus, then waits until
        /// it has the focus. When a window manager runs, it first waits
        /// until the window manager has taken the window over, and asks it
        /// to activate the window.
        fn focus(&self) -> Result<(), String> {
            if self.has_window_manager()? {
                let mut tries = 0;
                while !self.is_managed()? {
                    tries += 1;
                    if tries > FOCUS_TRIES {
                        return Err("the window manager did not take the window over".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                let active = atom(&self.connection, b"_NET_ACTIVE_WINDOW")?;
                let request =
                    ClientMessageEvent::new(32, self.window, active, [2, CURRENT_TIME, 0, 0, 0]);
                self.connection
                    .send_event(
                        false,
                        self.root,
                        EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                        request,
                    )
                    .map_err(failed)?;
            } else {
                self.connection
                    .configure_window(
                        self.window,
                        &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
                    )
                    .map_err(failed)?;
            }
            self.connection
                .set_input_focus(InputFocus::PARENT, self.window, CURRENT_TIME)
                .map_err(failed)?;
            self.connection.sync().map_err(failed)?;
            for _ in 0..FOCUS_TRIES {
                if self.has_focus()? {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err("the app's window did not take the input focus".to_string())
        }

        /// Fails unless the window has the input focus.
        fn require_focus(&self) -> Result<(), String> {
            if self.has_focus()? {
                Ok(())
            } else {
                Err("the app's window does not have the input focus".to_string())
            }
        }

        /// The display's keyboard mapping.
        fn keymap(&self) -> Result<Keymap, String> {
            let setup = self.connection.setup();
            let (first, last) = (setup.min_keycode, setup.max_keycode);
            let reply = self
                .connection
                .get_keyboard_mapping(first, last - first + 1)
                .map_err(failed)?
                .reply()
                .map_err(failed)?;
            Ok(Keymap {
                first,
                per_keycode: usize::from(reply.keysyms_per_keycode),
                keysyms: reply.keysyms,
            })
        }

        /// Sends one fake key or button event.
        fn fake(&self, kind: u8, detail: u8) -> Result<(), String> {
            self.connection
                .xtest_fake_input(kind, detail, CURRENT_TIME, x11rb::NONE, 0, 0, 0)
                .map_err(failed)?;
            Ok(())
        }

        /// Presses a key with the modifiers held, and Shift as well when the
        /// key's keysym needs it, and returns how many keys it released.
        fn press(&self, keymap: &Keymap, modifiers: &[u32], key: u32) -> Result<u32, String> {
            let (keycode, shifted) = keymap
                .find(key)
                .ok_or_else(|| format!("no key types keysym {key:#x}"))?;
            let implied_shift = (shifted && !modifiers.contains(&SHIFT)).then_some(SHIFT);
            let mut held = Vec::new();
            for modifier in modifiers.iter().copied().chain(implied_shift) {
                let (code, _) = keymap
                    .find(modifier)
                    .ok_or_else(|| format!("no key for modifier {modifier:#x}"))?;
                held.push(code);
            }
            for code in &held {
                self.fake(KEY_PRESS_EVENT, *code)?;
            }
            self.fake(KEY_PRESS_EVENT, keycode)?;
            self.fake(KEY_RELEASE_EVENT, keycode)?;
            for code in held.iter().rev() {
                self.fake(KEY_RELEASE_EVENT, *code)?;
            }
            self.connection.sync().map_err(failed)?;
            Ok(held.len() as u32 + 1)
        }

        /// Moves the pointer to a point of the client area, when one of the
        /// app's windows, or the frame around its window, is the one under
        /// it.
        fn move_pointer(&self, x: i32, y: i32) -> Result<(), String> {
            let origin = self
                .connection
                .translate_coordinates(self.window, self.root, 0, 0)
                .map_err(failed)?
                .reply()
                .map_err(failed)?;
            let on_screen = |offset: i16, value: i32| {
                i16::try_from(i32::from(offset) + value)
                    .map_err(|_| "the point is off the screen".to_string())
            };
            let (root_x, root_y) = (on_screen(origin.dst_x, x)?, on_screen(origin.dst_y, y)?);
            let under = self
                .connection
                .translate_coordinates(self.root, self.root, root_x, root_y)
                .map_err(failed)?
                .reply()
                .map_err(failed)?
                .child;
            if !self.with_frames()?.contains(&under)
                && window_pid(&self.connection, under, self.pid_atom) != Some(self.pid)
            {
                return Err("the app's window is not under the point".to_string());
            }
            self.connection
                .xtest_fake_input(
                    MOTION_NOTIFY_EVENT,
                    0,
                    CURRENT_TIME,
                    self.root,
                    root_x,
                    root_y,
                    0,
                )
                .map_err(failed)?;
            self.connection.sync().map_err(failed)?;
            Ok(())
        }

        /// Presses or releases a button where the pointer is.
        fn button(&self, kind: u8, number: u8) -> Result<(), String> {
            self.fake(kind, number)?;
            self.connection.sync().map_err(failed)?;
            Ok(())
        }
    }

    /// Runs one command.
    pub fn run(args: &[String]) -> Result<Value, String> {
        let (command, rest) = args
            .split_first()
            .ok_or_else(|| "a command is needed".to_string())?;
        let pid = rest
            .first()
            .and_then(|pid| pid.parse::<u32>().ok())
            .ok_or_else(|| "a process id is needed".to_string())?;
        let arguments = &rest[1..];
        let app = App::open(pid)?;
        match command.as_str() {
            "window" => app.describe(),
            "focus" => {
                app.focus()?;
                app.describe()
            }
            "keys" => {
                app.require_focus()?;
                let keymap = app.keymap()?;
                let mut released = 0;
                for combo in arguments {
                    let (modifiers, key) = parse_combo(combo)?;
                    released += app.press(&keymap, &modifiers, key)?;
                }
                Ok(json!(released))
            }
            "type" => {
                app.require_focus()?;
                let keymap = app.keymap()?;
                let mut released = 0;
                for character in arguments.join(" ").chars() {
                    released += app.press(&keymap, &[], char_keysym(character))?;
                }
                Ok(json!(released))
            }
            "click" => {
                let (x, y) = point(arguments)?;
                let count = match arguments.get(2) {
                    Some(count) => count
                        .parse::<u32>()
                        .map_err(|_| format!("bad click count {count:?}"))?,
                    None => 1,
                };
                let number = button_number(arguments.get(3).map_or("left", String::as_str))?;
                app.move_pointer(x, y)?;
                for _ in 0..count {
                    app.button(BUTTON_PRESS_EVENT, number)?;
                    app.button(BUTTON_RELEASE_EVENT, number)?;
                }
                Ok(json!(true))
            }
            "move" => {
                let (x, y) = point(arguments)?;
                app.move_pointer(x, y)?;
                Ok(json!(true))
            }
            "down" | "up" => {
                let (x, y) = point(arguments)?;
                let number = button_number(arguments.get(2).map_or("left", String::as_str))?;
                app.move_pointer(x, y)?;
                let kind = if command == "down" {
                    BUTTON_PRESS_EVENT
                } else {
                    BUTTON_RELEASE_EVENT
                };
                app.button(kind, number)?;
                Ok(json!(true))
            }
            other => Err(format!("unknown command {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONTROL: u32 = 0xffe3;
    const SHIFT: u32 = 0xffe1;
    const ALT: u32 = 0xffe9;

    #[test]
    fn x11_runner_reads_a_key_with_modifiers() {
        assert_eq!(parse_combo("Control+Z"), Ok((vec![CONTROL], 0x7a)));
        assert_eq!(
            parse_combo("Control+Shift+R"),
            Ok((vec![CONTROL, SHIFT], 0x72))
        );
        assert_eq!(parse_combo("Alt+F4"), Ok((vec![ALT], 0xffc1)));
        assert_eq!(parse_combo("Control+1"), Ok((vec![CONTROL], 0x31)));
        assert_eq!(parse_combo("control+a"), Ok((vec![CONTROL], 0x61)));
    }

    #[test]
    fn x11_runner_reads_a_modifier_and_named_keys_on_their_own() {
        assert_eq!(parse_combo("Alt"), Ok((vec![], ALT)));
        assert_eq!(parse_combo("F10"), Ok((vec![], 0xffc7)));
        assert_eq!(parse_combo("Escape"), Ok((vec![], 0xff1b)));
        assert_eq!(parse_combo("Enter"), Ok((vec![], 0xff0d)));
        assert_eq!(parse_combo("Backspace"), Ok((vec![], 0xff08)));
        assert_eq!(parse_combo("Delete"), Ok((vec![], 0xffff)));
        assert_eq!(parse_combo("Home"), Ok((vec![], 0xff50)));
        assert_eq!(parse_combo("End"), Ok((vec![], 0xff57)));
        assert_eq!(parse_combo("ArrowLeft"), Ok((vec![], 0xff51)));
        assert_eq!(parse_combo("Shift+Tab"), Ok((vec![SHIFT], 0xff09)));
    }

    #[test]
    fn x11_runner_reads_punctuation_keys() {
        assert_eq!(parse_combo("Control+,"), Ok((vec![CONTROL], 0x2c)));
        assert_eq!(parse_combo("Control+Comma"), Ok((vec![CONTROL], 0x2c)));
        assert_eq!(parse_combo("Control+\\"), Ok((vec![CONTROL], 0x5c)));
        assert_eq!(parse_combo("Control+/"), Ok((vec![CONTROL], 0x2f)));
        assert_eq!(
            parse_combo("Control+Shift+-"),
            Ok((vec![CONTROL, SHIFT], 0x2d))
        );
    }

    #[test]
    fn x11_runner_refuses_what_it_cannot_press() {
        assert!(parse_combo("").is_err());
        assert!(parse_combo("Control+Banana").is_err());
        assert!(parse_combo("Hyper+A").is_err());
        assert!(parse_combo("Control+").is_err());
    }

    #[test]
    fn x11_runner_types_characters_as_their_keysyms() {
        assert_eq!(char_keysym('a'), 0x61);
        assert_eq!(char_keysym('A'), 0x41);
        assert_eq!(char_keysym(' '), 0x20);
        assert_eq!(char_keysym('\n'), 0xff0d);
        assert_eq!(char_keysym('\t'), 0xff09);
        assert_eq!(char_keysym('é'), 0xe9);
        assert_eq!(char_keysym('€'), 0x0100_20ac);
    }

    #[test]
    fn x11_runner_numbers_the_buttons_it_clicks() {
        assert_eq!(button_number("left"), Ok(1));
        assert_eq!(button_number("middle"), Ok(2));
        assert_eq!(button_number("right"), Ok(3));
        assert!(button_number("back").is_err());
    }

    #[test]
    fn x11_runner_finds_the_keycode_and_shift_level_of_a_keysym() {
        let keymap = Keymap {
            first: 8,
            per_keycode: 2,
            keysyms: vec![0, 0, 0x61, 0x41, 0x31, 0x21, 0x41, 0],
        };
        assert_eq!(keymap.find(0x61), Some((9, false)));
        assert_eq!(keymap.find(0x21), Some((10, true)));
        assert_eq!(keymap.find(0x41), Some((11, false)));
        assert_eq!(keymap.find(0x7a), None);
    }

    #[test]
    fn x11_runner_serves_one_answer_line_per_command_line() {
        let input = "[\"keys\",\"7\",\"a\",\"b\"]\n[\"move\",\"7\"]\n".as_bytes();
        let mut output = Vec::new();
        serve(input, &mut output, |args: &[String]| {
            if args[0] == "keys" {
                Ok(serde_json::json!(args.len()))
            } else {
                Err(format!("no {} here", args[0]))
            }
        })
        .unwrap();
        assert_eq!(
            String::from_utf8(output).unwrap(),
            "{\"ok\":4}\n{\"error\":\"no move here\"}\n"
        );
    }

    #[test]
    fn x11_runner_answers_a_line_that_is_not_a_command_with_an_error() {
        let mut output = Vec::new();
        serve("keys a\n".as_bytes(), &mut output, |_: &[String]| {
            Ok(serde_json::json!(true))
        })
        .unwrap();
        let answer: Value = serde_json::from_slice(&output).unwrap();
        assert!(answer["error"].as_str().unwrap().contains("keys a"));
    }
}
