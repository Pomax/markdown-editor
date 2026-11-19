//! Input for the macOS tests. macOS has no virtual display, so the tests
//! leave the real pointer and keyboard alone: under TESTING the window is
//! on screen but fully transparent, so WebKit keeps rendering the page,
//! and this module builds the key and mouse events AppKit would get and
//! hands them to that window inside the app's process.
//!
//! The commands are the X11 runner's, without the process id: `window`,
//! `focus`, `keys <combination>...`, `type <text>`, `click <x> <y> [count]
//! [button]`, `move <x> <y>`, and `down` and `up <x> <y> [button]`, with
//! points of the client area in physical pixels, and `resize <width>
//! <height>`, which gives the page a size in CSS pixels, and `initScript
//! <source>`, which every later page load runs first. `keys` and `type`
//! answer with the number of key releases the page sees.
//!
//! AppKit drops key commands sent to an app that is not active, and the
//! test app must not take the user's keyboard by becoming active, so under
//! TESTING the app only reports that it is.

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, NSObjectProtocol, Sel};
use objc2::{MainThreadMarker, msg_send, sel};
use objc2_app_kit::{
    NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSView, NSWindow,
    NSWindowDidChangeScreenNotification,
};
use objc2_core_graphics::{CGEvent, CGEventFlags};
use objc2_foundation::{
    NSActivityOptions, NSNotificationCenter, NSPoint, NSProcessInfo, NSRect, NSSize, NSString,
};
use objc2_web_kit::{WKUserScript, WKUserScriptInjectionTime, WKWebView};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicPtr, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// How long a command waits for the main thread.
const MAIN_THREAD_WAIT: Duration = Duration::from_secs(10);

/// The number of the next mouse event.
static EVENT_NUMBER: AtomicIsize = AtomicIsize::new(0);

/// Whether the left button is held, which makes a move a drag.
static LEFT_HELD: AtomicBool = AtomicBool::new(false);

/// Each key of a US keyboard that types a character: the character, the
/// character it types with Shift, and its virtual key code.
const TYPING_KEYS: &[(char, char, u16)] = &[
    ('a', 'A', 0),
    ('s', 'S', 1),
    ('d', 'D', 2),
    ('f', 'F', 3),
    ('h', 'H', 4),
    ('g', 'G', 5),
    ('z', 'Z', 6),
    ('x', 'X', 7),
    ('c', 'C', 8),
    ('v', 'V', 9),
    ('b', 'B', 11),
    ('q', 'Q', 12),
    ('w', 'W', 13),
    ('e', 'E', 14),
    ('r', 'R', 15),
    ('y', 'Y', 16),
    ('t', 'T', 17),
    ('1', '!', 18),
    ('2', '@', 19),
    ('3', '#', 20),
    ('4', '$', 21),
    ('6', '^', 22),
    ('5', '%', 23),
    ('=', '+', 24),
    ('9', '(', 25),
    ('7', '&', 26),
    ('-', '_', 27),
    ('8', '*', 28),
    ('0', ')', 29),
    (']', '}', 30),
    ('o', 'O', 31),
    ('u', 'U', 32),
    ('[', '{', 33),
    ('i', 'I', 34),
    ('p', 'P', 35),
    ('l', 'L', 37),
    ('j', 'J', 38),
    ('\'', '"', 39),
    ('k', 'K', 40),
    (';', ':', 41),
    ('\\', '|', 42),
    (',', '<', 43),
    ('/', '?', 44),
    ('n', 'N', 45),
    ('m', 'M', 46),
    ('.', '>', 47),
    (' ', ' ', 49),
    ('`', '~', 50),
];

/// A modifier key.
#[derive(Clone, Copy, PartialEq)]
enum Modifier {
    Control,
    Shift,
    Option,
    Command,
}

impl Modifier {
    /// The modifier a Playwright key name means.
    fn named(name: &str) -> Option<Modifier> {
        match name.to_ascii_lowercase().as_str() {
            "control" | "ctrl" => Some(Modifier::Control),
            "shift" => Some(Modifier::Shift),
            "alt" => Some(Modifier::Option),
            "meta" | "controlormeta" => Some(Modifier::Command),
            _ => None,
        }
    }

    /// The modifier's virtual key code.
    fn code(self) -> u16 {
        match self {
            Modifier::Command => 55,
            Modifier::Shift => 56,
            Modifier::Option => 58,
            Modifier::Control => 59,
        }
    }

    /// The modifier's flag on an event.
    fn flag(self) -> NSEventModifierFlags {
        match self {
            Modifier::Command => NSEventModifierFlags::Command,
            Modifier::Shift => NSEventModifierFlags::Shift,
            Modifier::Option => NSEventModifierFlags::Option,
            Modifier::Control => NSEventModifierFlags::Control,
        }
    }
}

/// A key that is not a modifier.
struct Key {
    code: u16,
    plain: String,
    shifted: String,
    needs_shift: bool,
    function: bool,
}

impl Key {
    /// A key whose character does not change with Shift.
    fn fixed(code: u16, character: char, function: bool) -> Key {
        Key {
            code,
            plain: character.to_string(),
            shifted: character.to_string(),
            needs_shift: false,
            function,
        }
    }

    /// The key that types a character, with Shift when the character needs
    /// it; a character no key types is sent as text.
    fn typing(character: char) -> Key {
        match character {
            '\n' => return Key::fixed(36, '\r', false),
            '\t' => return Key::fixed(48, '\t', false),
            _ => {}
        }
        for (plain, shifted, code) in TYPING_KEYS {
            if character == *plain || character == *shifted {
                return Key {
                    code: *code,
                    plain: plain.to_string(),
                    shifted: shifted.to_string(),
                    needs_shift: character == *shifted && plain != shifted,
                    function: false,
                };
            }
        }
        Key::fixed(0, character, false)
    }

    /// The key a Playwright key name means. A single letter names its key
    /// whatever its case, so Shift is held only when the combination names
    /// it; any other character is typed as it is written.
    fn named(name: &str) -> Option<Key> {
        let mut characters = name.chars();
        if let (Some(single), None) = (characters.next(), characters.next()) {
            let mut key = Key::typing(single);
            key.needs_shift = key.needs_shift && !single.is_ascii_alphabetic();
            return Some(key);
        }
        if let Some(number) = name.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
            const CODES: [u16; 12] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];
            let code = *CODES.get(usize::try_from(number).ok()?.checked_sub(1)?)?;
            let character = char::from_u32(0xf703 + number)?;
            return Some(Key::fixed(code, character, true));
        }
        let typed = match name {
            "Comma" => Some(','),
            "Minus" => Some('-'),
            "Period" => Some('.'),
            "Equal" => Some('='),
            "Slash" => Some('/'),
            "Semicolon" => Some(';'),
            "Backquote" => Some('`'),
            "BracketLeft" => Some('['),
            "BracketRight" => Some(']'),
            "Backslash" => Some('\\'),
            "Quote" => Some('\''),
            "Space" => Some(' '),
            _ => None,
        };
        if let Some(character) = typed {
            return Some(Key::typing(character));
        }
        Some(match name {
            "Backspace" => Key::fixed(51, '\u{7f}', false),
            "Tab" => Key::fixed(48, '\t', false),
            "Enter" => Key::fixed(36, '\r', false),
            "Escape" => Key::fixed(53, '\u{1b}', false),
            "Insert" => Key::fixed(114, '\u{f727}', true),
            "Delete" => Key::fixed(117, '\u{f728}', true),
            "Home" => Key::fixed(115, '\u{f729}', true),
            "End" => Key::fixed(119, '\u{f72b}', true),
            "PageUp" => Key::fixed(116, '\u{f72c}', true),
            "PageDown" => Key::fixed(121, '\u{f72d}', true),
            "ArrowUp" => Key::fixed(126, '\u{f700}', true),
            "ArrowDown" => Key::fixed(125, '\u{f701}', true),
            "ArrowLeft" => Key::fixed(123, '\u{f702}', true),
            "ArrowRight" => Key::fixed(124, '\u{f703}', true),
            _ => return None,
        })
    }
}

/// A combination written as `Modifier+...+Key`: the modifiers to hold, and
/// the key to press, which a modifier on its own (`Alt`) does not have.
fn parse_combo(combo: &str) -> Result<(Vec<Modifier>, Option<Key>), String> {
    let parts: Vec<&str> = combo.split('+').collect();
    let (last, held) = parts
        .split_last()
        .ok_or_else(|| format!("no key in {combo:?}"))?;
    let mut modifiers = held
        .iter()
        .map(|name| Modifier::named(name).ok_or_else(|| format!("unknown modifier {name:?}")))
        .collect::<Result<Vec<Modifier>, String>>()?;
    if let Some(modifier) = Modifier::named(last) {
        modifiers.push(modifier);
        return Ok((modifiers, None));
    }
    let key = Key::named(last).ok_or_else(|| format!("unknown key {last:?} in {combo:?}"))?;
    Ok((modifiers, Some(key)))
}

/// The seconds since startup that events are stamped with.
fn timestamp() -> f64 {
    NSProcessInfo::processInfo().systemUptime()
}

/// Builds a key event for the window.
fn key_event(
    window: &NSWindow,
    kind: NSEventType,
    flags: NSEventModifierFlags,
    code: u16,
    text: &str,
    unmodified: &str,
) -> Result<Retained<NSEvent>, String> {
    let characters = NSString::from_str(text);
    let ignoring = NSString::from_str(unmodified);
    NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        kind,
        NSPoint::new(0.0, 0.0),
        flags,
        timestamp(),
        window.windowNumber(),
        None,
        &characters,
        &ignoring,
        false,
        code,
    )
    .ok_or_else(|| "AppKit made no key event".to_string())
}

/// Builds a key press or release that carries its text, which AppKit's
/// text input reads from a Core Graphics event instead of working it out
/// from the key code and the keyboard's real modifier state. The event is
/// only built here, and never posted to the system.
fn text_key_event(
    pressed: bool,
    flags: NSEventModifierFlags,
    code: u16,
    text: &str,
) -> Result<Retained<NSEvent>, String> {
    let event = CGEvent::new_keyboard_event(None, code, pressed)
        .ok_or_else(|| "Core Graphics made no key event".to_string())?;
    let units: Vec<u16> = text.encode_utf16().collect();
    CGEvent::set_flags(Some(&event), CGEventFlags(flags.0 as u64));
    // Safe: the pointer and length describe `units`, which outlives the call.
    unsafe {
        CGEvent::keyboard_set_unicode_string(Some(&event), units.len() as _, units.as_ptr());
    }
    NSEvent::eventWithCGEvent(&event).ok_or_else(|| "AppKit took no key event".to_string())
}

/// Hands a key press to AppKit: a press with Command goes to the page first
/// as a key equivalent, and anything else, or a press nothing took, to the
/// window's first responder.
fn deliver_key_down(window: &NSWindow, event: &NSEvent, command: bool) {
    if !command || !window.performKeyEquivalent(event) {
        window.sendEvent(event);
    }
}

/// Runs the Edit menu's command for a letter on the focused text field, as
/// the menu does for a shortcut the page leaves alone.
fn run_edit_command(letter: &str, marker: MainThreadMarker) -> Result<Value, String> {
    let action = match letter {
        "a" => sel!(selectAll:),
        "x" => sel!(cut:),
        "c" => sel!(copy:),
        "v" => sel!(paste:),
        other => return Err(format!("no edit command for {other:?}")),
    };
    let application = NSApplication::sharedApplication(marker);
    let nobody = std::ptr::null_mut::<AnyObject>();
    // Safe: a nil target and sender are what `sendAction:to:from:` takes for
    // the responder chain.
    let _: Bool = unsafe { msg_send![&*application, sendAction: action, to: nobody, from: nobody] };
    Ok(json!(0))
}

/// Presses a key with the modifiers held, or just the modifiers, and
/// returns how many key releases the page sees: WebKit reports no release
/// of a key pressed while Command is held.
fn press(window: &NSWindow, modifiers: &[Modifier], key: Option<&Key>) -> Result<u32, String> {
    let mut held = modifiers.to_vec();
    if key.is_some_and(|key| key.needs_shift) && !held.contains(&Modifier::Shift) {
        held.push(Modifier::Shift);
    }
    let mut flags = NSEventModifierFlags::empty();
    for modifier in &held {
        flags |= modifier.flag();
        let event = key_event(
            window,
            NSEventType::FlagsChanged,
            flags,
            modifier.code(),
            "",
            "",
        )?;
        window.sendEvent(&event);
    }
    let command = held.contains(&Modifier::Command);
    let mut released = held.len() as u32;
    if let Some(key) = key {
        let shift = held.contains(&Modifier::Shift);
        let text = if shift { &key.shifted } else { &key.plain };
        let mut key_flags = flags;
        if key.function {
            key_flags |= NSEventModifierFlags::Function;
        }
        let down = text_key_event(true, key_flags, key.code, text)?;
        deliver_key_down(window, &down, command);
        let up = text_key_event(false, key_flags, key.code, text)?;
        window.sendEvent(&up);
        if !command {
            released += 1;
        }
    }
    for modifier in held.iter().rev() {
        flags &= !modifier.flag();
        let event = key_event(
            window,
            NSEventType::FlagsChanged,
            flags,
            modifier.code(),
            "",
            "",
        )?;
        window.sendEvent(&event);
    }
    Ok(released)
}

/// A point of the client area, in physical pixels, in the window's own
/// coordinates, which count up from its bottom left corner in points.
fn window_point(window: &NSWindow, x: f64, y: f64) -> Result<NSPoint, String> {
    let scale = window.backingScaleFactor();
    let content = content_view(window)?;
    Ok(NSPoint::new(
        x / scale,
        content.frame().size.height - y / scale,
    ))
}

/// The window's content view.
fn content_view(window: &NSWindow) -> Result<Retained<NSView>, String> {
    window
        .contentView()
        .ok_or_else(|| "the window has no content view".to_string())
}

/// Builds a mouse event at a point of the window.
fn mouse_event(
    window: &NSWindow,
    kind: NSEventType,
    location: NSPoint,
    clicks: isize,
) -> Result<Retained<NSEvent>, String> {
    let pressure = if matches!(
        kind,
        NSEventType::LeftMouseDown | NSEventType::RightMouseDown | NSEventType::OtherMouseDown
    ) {
        1.0
    } else {
        0.0
    };
    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        kind,
        location,
        NSEventModifierFlags::empty(),
        timestamp(),
        window.windowNumber(),
        None,
        EVENT_NUMBER.fetch_add(1, Ordering::SeqCst),
        clicks,
        pressure,
    )
    .ok_or_else(|| "AppKit made no mouse event".to_string())
}

/// The press and release event types of a button.
fn button_events(name: &str) -> Result<(NSEventType, NSEventType), String> {
    match name {
        "left" => Ok((NSEventType::LeftMouseDown, NSEventType::LeftMouseUp)),
        "right" => Ok((NSEventType::RightMouseDown, NSEventType::RightMouseUp)),
        "middle" => Ok((NSEventType::OtherMouseDown, NSEventType::OtherMouseUp)),
        _ => Err(format!("unknown button {name:?}")),
    }
}

/// Moves the pointer to a point of the window: a drag while the left
/// button is held, and otherwise a move, which goes to the view under the
/// point, as AppKit's tracking areas send it there.
fn move_pointer(window: &NSWindow, location: NSPoint) -> Result<(), String> {
    if LEFT_HELD.load(Ordering::SeqCst) {
        let event = mouse_event(window, NSEventType::LeftMouseDragged, location, 1)?;
        window.sendEvent(&event);
        return Ok(());
    }
    let event = mouse_event(window, NSEventType::MouseMoved, location, 0)?;
    match content_view(window)?.hitTest(location) {
        Some(view) => view.mouseMoved(&event),
        None => window.sendEvent(&event),
    }
    Ok(())
}

/// The x and y of a command's arguments, as a point of the window.
fn point_argument(window: &NSWindow, arguments: &[String]) -> Result<NSPoint, String> {
    let number = |index: usize| {
        arguments
            .get(index)
            .and_then(|value| value.parse::<f64>().ok())
            .ok_or_else(|| "x and y are needed".to_string())
    };
    window_point(window, number(0)?, number(1)?)
}

/// The window's title, whether it is visible and key, and its client area
/// in physical pixels.
fn describe(window: &NSWindow) -> Result<Value, String> {
    let scale = window.backingScaleFactor();
    let size = content_view(window)?.frame().size;
    Ok(json!({
        "title": window.title().to_string(),
        "visible": window.isVisible(),
        "inFront": window.isKeyWindow(),
        "alpha": window.alphaValue(),
        "takesClicks": !window.ignoresMouseEvents(),
        "client": {
            "x": 0,
            "y": 0,
            "width": size.width * scale,
            "height": size.height * scale,
        },
    }))
}

/// Makes the window the key window and the page the first responder.
fn focus(window: &NSWindow) -> Result<(), String> {
    window.makeKeyAndOrderFront(None);
    announce_screen(window);
    let content = content_view(window)?;
    let size = content.frame().size;
    let middle = NSPoint::new(size.width / 2.0, size.height / 2.0);
    if let Some(view) = content.hitTest(middle) {
        window.makeFirstResponder(Some(&view));
    }
    Ok(())
}

/// Runs one command on the main thread.
fn run_command(
    window: &NSWindow,
    command: &str,
    arguments: &[String],
    marker: MainThreadMarker,
) -> Result<Value, String> {
    match command {
        "window" => describe(window),
        "edit" => run_edit_command(arguments.first().map_or("", String::as_str), marker),
        "resize" => {
            let number = |index: usize| {
                arguments
                    .get(index)
                    .and_then(|value| value.parse::<f64>().ok())
                    .ok_or_else(|| "a width and a height are needed".to_string())
            };
            let title_bar = window.frame().size.height - window.contentLayoutRect().size.height;
            window.setContentSize(NSSize::new(number(0)?, number(1)? - title_bar));
            announce_screen(window);
            Ok(json!(true))
        }
        "focus" => {
            focus(window)?;
            describe(window)
        }
        "keys" => {
            let mut released = 0;
            for combo in arguments {
                let (modifiers, key) = parse_combo(combo)?;
                released += press(window, &modifiers, key.as_ref())?;
            }
            Ok(json!(released))
        }
        "type" => {
            let mut released = 0;
            for character in arguments.join(" ").chars() {
                released += press(window, &[], Some(&Key::typing(character)))?;
            }
            Ok(json!(released))
        }
        "click" => {
            let location = point_argument(window, arguments)?;
            let count = match arguments.get(2) {
                Some(count) => count
                    .parse::<isize>()
                    .map_err(|_| format!("bad click count {count:?}"))?,
                None => 1,
            };
            let button = arguments.get(3).map_or("left", String::as_str);
            let (down, up) = button_events(button)?;
            move_pointer(window, location)?;
            for click in 1..=count {
                window.sendEvent(&*mouse_event(window, down, location, click)?);
                window.sendEvent(&*mouse_event(window, up, location, click)?);
            }
            Ok(json!(true))
        }
        "move" => {
            move_pointer(window, point_argument(window, arguments)?)?;
            Ok(json!(true))
        }
        "down" | "up" => {
            let location = point_argument(window, arguments)?;
            let button = arguments.get(2).map_or("left", String::as_str);
            let (down, up) = button_events(button)?;
            move_pointer(window, location)?;
            let pressing = command == "down";
            let kind = if pressing { down } else { up };
            window.sendEvent(&*mouse_event(window, kind, location, 1)?);
            if button == "left" {
                LEFT_HELD.store(pressing, Ordering::SeqCst);
            }
            Ok(json!(true))
        }
        other => Err(format!("unknown command {other}")),
    }
}

/// Runs a closure with the app's window, on the main thread.
fn with_window<T>(
    app: &AppHandle,
    action: impl FnOnce(&NSWindow, MainThreadMarker) -> Result<T, String>,
) -> Result<T, String> {
    let marker = MainThreadMarker::new().ok_or_else(|| "not on the main thread".to_string())?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "the app has no window".to_string())?;
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    // Safe: Tauri hands out the live NSWindow of a window that exists, and
    // this runs on the main thread, where it is used.
    let ns_window = unsafe { &*pointer.cast::<NSWindow>() };
    action(ns_window, marker)
}

/// The window's answer to AppKit asking it to keep a frame on the screen:
/// the frame as it is.
extern "C-unwind" fn unconstrained_frame(
    _window: *mut AnyObject,
    _selector: Sel,
    frame: NSRect,
    _screen: *mut AnyObject,
) -> NSRect {
    frame
}

/// The test window, which the app reports as its key and main window.
static TEST_WINDOW: AtomicPtr<AnyObject> = AtomicPtr::new(std::ptr::null_mut());

/// The application's answer when asked for its key or main window.
extern "C-unwind" fn reported_window(
    _application: *mut AnyObject,
    _selector: Sel,
) -> *mut AnyObject {
    TEST_WINDOW.load(Ordering::SeqCst)
}

/// The answer when asked whether the app is active, or the window key.
extern "C-unwind" fn reported_yes(_object: *mut AnyObject, _selector: Sel) -> Bool {
    Bool::YES
}

/// Adds a method to a class, for the selector whose signature it has.
fn add_method(class: *const AnyClass, selector: Sel, method: *const (), types: &std::ffi::CStr) {
    // Safe: each caller passes a function with the selector's signature,
    // which the encoding spells out, and the class outlives the process.
    unsafe {
        objc2::ffi::class_addMethod(
            class.cast_mut(),
            selector,
            std::mem::transmute::<*const (), Imp>(method),
            types.as_ptr(),
        );
    }
}

/// Lets the window grow past the screen, as the tests' standard viewport
/// is taller than many screens.
fn allow_frames_past_the_screen(window: &NSWindow) {
    add_method(
        window.class(),
        sel!(constrainFrameRect:toScreen:),
        unconstrained_frame as *const (),
        c"{CGRect={CGPoint=dd}{CGSize=dd}}@:{CGRect={CGPoint=dd}{CGSize=dd}}@",
    );
}

/// Has the app report itself active with this as its key window, without
/// taking the keyboard from the app the user is in.
fn report_as_active(window: &NSWindow, marker: MainThreadMarker) {
    TEST_WINDOW.store(
        std::ptr::from_ref(window).cast::<AnyObject>().cast_mut(),
        Ordering::SeqCst,
    );
    let application = NSApplication::sharedApplication(marker);
    let class: *const AnyClass = application.class();
    add_method(class, sel!(keyWindow), reported_window as *const (), c"@@:");
    add_method(
        class,
        sel!(mainWindow),
        reported_window as *const (),
        c"@@:",
    );
    add_method(class, sel!(isActive), reported_yes as *const (), c"c@:");
    add_method(
        window.class(),
        sel!(isKeyWindow),
        reported_yes as *const (),
        c"c@:",
    );
    add_method(
        window.class(),
        sel!(isMainWindow),
        reported_yes as *const (),
        c"c@:",
    );
}

/// Keeps the page rendering and taking input while nothing shows it: WebKit
/// stops a page whose window is covered or whose app is inactive, and macOS
/// puts an app no one can see to sleep.
fn keep_page_awake(app: &AppHandle) {
    /// `WKInactiveSchedulingPolicyNone`: an inactive page keeps running.
    const KEEP_RUNNING: isize = 2;
    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiated | NSActivityOptions::LatencyCritical,
        &NSString::from_str("running the integration tests"),
    );
    std::mem::forget(activity);
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.with_webview(|webview| {
        // Safe: Tauri hands out the live WKWebView, on the main thread, and
        // the policy is set only where the preferences have it.
        unsafe {
            let view = &*webview.inner().cast::<WKWebView>();
            let _: () = msg_send![view, _setWindowOcclusionDetectionEnabled: false];
            let preferences = view.configuration().preferences();
            if preferences.respondsToSelector(sel!(setInactiveSchedulingPolicy:)) {
                let _: () = msg_send![&*preferences, setInactiveSchedulingPolicy: KEEP_RUNNING];
            }
        }
    });
}

/// Tells WebKit which screen the window is on, without which it schedules
/// no rendering for the page.
fn announce_screen(window: &NSWindow) {
    // Safe: the name is AppKit's own, and the window is live.
    unsafe {
        NSNotificationCenter::defaultCenter()
            .postNotificationName_object(NSWindowDidChangeScreenNotification, Some(window));
    }
}

/// Adds a script that every later page load runs before the page's own.
fn add_init_script(app: &AppHandle, source: String) -> Result<Value, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "the app has no window".to_string())?;
    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            let Some(marker) = MainThreadMarker::new() else {
                return;
            };
            // Safe: Tauri hands out the live WKWebView, on the main thread.
            unsafe {
                let view = &*webview.inner().cast::<WKWebView>();
                let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                    marker.alloc(),
                    &NSString::from_str(&source),
                    WKUserScriptInjectionTime::AtDocumentStart,
                    true,
                );
                view.configuration()
                    .userContentController()
                    .addUserScript(&script);
            }
            let _ = sender.send(());
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(MAIN_THREAD_WAIT)
        .map_err(|_| "the main thread did not answer".to_string())?;
    Ok(json!(true))
}

/// Puts the window on screen fully transparent under TESTING, where it
/// cannot be seen or take a click, so WebKit keeps rendering the page. It
/// runs on the main thread.
pub fn show_unseen(app: &AppHandle) {
    if std::env::var("TESTING").is_err() {
        return;
    }
    keep_page_awake(app);
    let _ = with_window(app, |window, marker| {
        allow_frames_past_the_screen(window);
        report_as_active(window, marker);
        window.setAlphaValue(0.0);
        window.setIgnoresMouseEvents(true);
        window.orderFrontRegardless();
        Ok(())
    });
}

/// Runs one input command, named with its arguments in a request's
/// parameters, on the main thread, and waits for its answer.
pub fn run(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let command = params
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| "a command is needed".to_string())?
        .to_string();
    let arguments: Vec<String> = params
        .get("args")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if command == "initScript" {
        return add_init_script(app, arguments.join(""));
    }
    let handle = app.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let answer = with_window(&handle, |window, marker| {
            run_command(window, &command, &arguments, marker)
        });
        let _ = sender.send(answer);
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(MAIN_THREAD_WAIT)
        .map_err(|_| "the main thread did not answer".to_string())?
}
