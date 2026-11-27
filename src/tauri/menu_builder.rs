//! The application menu, ported from menu-builder.js. The menu and the
//! context menu are first built as plain `Value` templates, so their items
//! can be compared in tests, and then turned into Tauri menus. After the
//! first build, the native menu is brought in line with each new template
//! by changing only the items that differ. Choosing an item runs its
//! action. The Gather Images scan
//! is a pure function with the file-system operations passed in, and the
//! texts of the menu's message boxes are built by plain functions.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::thread::ThreadId;
use std::time::Duration;

use serde_json::{Value, json};
use tauri::menu::{
    CheckMenuItemBuilder, IsMenuItem, Menu, MenuBuilder as TauriMenuBuilder, MenuItem,
    MenuItemBuilder, MenuItemKind, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Manager, Wry};

#[cfg(all(windows, not(feature = "test-hooks")))]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput,
    VIRTUAL_KEY, VK_CONTROL,
};

use crate::ipc_handler::{FileManagerState, Settings, WebContentsState};

/// Path separator used to build and compare paths, matching the host.
const SEP: char = std::path::MAIN_SEPARATOR;

/// The repository the About box links to.
const REPOSITORY_URL: &str = "https://github.com/Pomax/Pomax-s-Markdown-Editor";

/// The Edit shortcuts the page handles itself. On Windows and Linux the
/// page sees a key before the menu, so these are not registered there,
/// or they would fire twice or bypass the editor.
const PAGE_HANDLED: [&str; 6] = [
    "CmdOrCtrl+Z",
    "CmdOrCtrl+Y",
    "CmdOrCtrl+X",
    "CmdOrCtrl+C",
    "CmdOrCtrl+V",
    "CmdOrCtrl+A",
];

/// An open file as the renderer reports it for the View menu.
pub struct OpenFile {
    pub id: String,
    pub label: String,
    pub active: bool,
}

/// What a built menu item does, kept beside the Tauri menu (whose items
/// cannot report their accelerators) so menu events can be routed and the
/// test hooks can describe the menu.
#[derive(Clone, Default)]
struct ItemInfo {
    action: Option<String>,
    action_arg: Option<String>,
    role: Option<String>,
    #[cfg_attr(not(any(windows, feature = "test-hooks")), allow(dead_code))]
    accelerator: Option<String>,
    #[cfg_attr(not(any(windows, feature = "test-hooks")), allow(dead_code))]
    registered: bool,
}

/// The menu builder's state: the open files the renderer reported, for the
/// View menu and as reported, for saving the session; what each item of
/// the current menu does; and the template the native menu was last
/// brought in line with. Item ids are derived from what the item does, so
/// a click on an item that has just been replaced still runs.
#[derive(Default)]
pub struct MenuBuilder {
    pub open_files: Vec<OpenFile>,
    pub reported_files: Vec<Value>,
    items: HashMap<String, ItemInfo>,
    template: Value,
}

/// The main thread, recorded when the menu is installed.
static MAIN_THREAD: OnceLock<ThreadId> = OnceLock::new();

/// One step in bringing a built submenu's children in line with a new
/// template. Positions are those of the children as they stand when the
/// step runs.
#[derive(Debug, PartialEq)]
enum ChildStep {
    /// The child at `position`, built from old entry `old_index`, stands
    /// for new entry `new_index` and is changed where the two differ.
    Keep {
        position: usize,
        old_index: usize,
        new_index: usize,
    },
    /// The child at `position` has no counterpart in the new template.
    Remove { position: usize },
    /// New entry `new_index` has no counterpart among the old entries and
    /// is built at `position`.
    Insert { position: usize, new_index: usize },
}

/// The managed menu builder.
pub type MenuState = Mutex<MenuBuilder>;

/// The result of a Gather Images scan: the rewritten markdown, how many
/// references changed, a line of detail for each, and the files to copy.
#[derive(Debug, PartialEq)]
pub struct GatherPlan {
    pub updated_markdown: String,
    pub changed_count: usize,
    pub details: Vec<String>,
    pub copies: Vec<(String, String)>,
}

/// The whole menu template: File, Edit, View and Help, each label marking
/// its first letter with `&` so that Alt plus that letter opens it on
/// Windows.
pub fn build_menu(
    current_file_path: Option<&str>,
    recent_files: &[String],
    open_files: &[OpenFile],
) -> Value {
    json!([
        build_file_menu(current_file_path, recent_files),
        build_edit_menu(),
        build_view_menu(open_files),
        build_help_menu(),
    ])
}

/// The File menu template.
pub fn build_file_menu(current_file_path: Option<&str>, recent_files: &[String]) -> Value {
    json!({
        "label": "&File",
        "submenu": [
            item("New", "CmdOrCtrl+N", "file:new"),
            item("Load...", "CmdOrCtrl+O", "file:load"),
            submenu("Open Recent", build_recent_submenu(recent_files)),
            separator(),
            item("Save", "CmdOrCtrl+S", "file:save"),
            item("Save As...", "CmdOrCtrl+Shift+S", "file:saveAs"),
            submenu("Export", vec![item_plain("HTML", "file:exportHtml")]),
            separator(),
            item("Close", "CmdOrCtrl+W", "file:close"),
            separator(),
            submenu(
                "Restructure",
                vec![item_plain("Headings", "file:restructureHeadings")],
            ),
            submenu(
                "Utilities",
                vec![
                    item_plain("Word Count", "file:wordCount"),
                    copy_path_item(current_file_path),
                ],
            ),
            separator(),
            exit_item(),
        ]
    })
}

/// The label of the Edit menu's preferences item: Settings… on macOS,
/// spelled as macOS spells it, and Preferences elsewhere.
pub const PREFERENCES_LABEL: &str = if cfg!(target_os = "macos") {
    "Settings…"
} else {
    "Preferences"
};

/// The Edit menu template.
pub fn build_edit_menu() -> Value {
    json!({
        "label": "&Edit",
        "submenu": [
            item("Undo", "CmdOrCtrl+Z", "edit:undo"),
            item("Redo", "CmdOrCtrl+Y", "edit:redo"),
            separator(),
            role_item("Cut", "CmdOrCtrl+X", "cut"),
            role_item("Copy", "CmdOrCtrl+C", "copy"),
            role_item("Paste", "CmdOrCtrl+V", "paste"),
            separator(),
            role_item("Select All", "CmdOrCtrl+A", "selectAll"),
            separator(),
            submenu("Images", vec![item_plain("Gather", "edit:gatherImages")]),
            separator(),
            item(PREFERENCES_LABEL, "CmdOrCtrl+,", "edit:preferences"),
        ]
    })
}

/// The View menu template, with an entry for each open file.
pub fn build_view_menu(open_files: &[OpenFile]) -> Value {
    let mut items = vec![
        item("Writing View", "CmdOrCtrl+1", "view:writing"),
        item("Source View", "CmdOrCtrl+2", "view:source2"),
    ];
    if !open_files.is_empty() {
        items.push(separator());
        for file in open_files {
            items.push(json!({
                "label": file.label,
                "type": "checkbox",
                "checked": file.active,
                "enabled": true,
                "action": "view:switchFile",
                "actionArg": file.id
            }));
        }
    }
    json!({ "label": "&View", "submenu": items })
}

/// The Help menu template.
pub fn build_help_menu() -> Value {
    json!({
        "label": "&Help",
        "submenu": [
            item("Reload", "CmdOrCtrl+Shift+R", "app:reload"),
            separator(),
            item("Debug", "F12", "app:debug"),
            separator(),
            item_plain("About", "help:about"),
        ]
    })
}

/// The right-click context menu template.
pub fn build_context_menu() -> Value {
    json!([
        role_item_plain("Copy", "copy"),
        role_item_plain("Cut", "cut"),
        role_item_plain("Paste", "paste"),
        separator(),
        item_plain("Inspect Element", "context:inspect"),
    ])
}

/// The context menu of a tab in the tab bar: Copy File Path, which copies
/// the tab's file path, disabled for a tab that has no file.
pub fn build_tab_context_menu(file_path: Option<&str>) -> Value {
    let mut copy_path = json!({
        "label": "Copy File Path",
        "enabled": file_path.is_some(),
        "action": "tab:copyPath"
    });
    if let Some(path) = file_path {
        copy_path["actionArg"] = json!(path);
    }
    json!([copy_path])
}

/// The About box text.
pub fn about_box(version: &str) -> Value {
    let repo = REPOSITORY_URL;
    json!({
        "type": "info",
        "title": "About Markdown Editor",
        "message": format!("Pomax's Markdown Editor v{version}"),
        "detail": format!(
            "This is a free, public domain open source markdown editor.\n\nVisit {repo} for more information"
        ),
        "buttons": ["Visit GitHub", "OK"],
        "defaultId": 1,
        "cancelId": 1
    })
}

/// The "save the document first" box shown by Gather Images.
pub fn gather_save_first_box() -> Value {
    json!({
        "type": "info",
        "title": "Gather Images",
        "message": "Please save your document first",
        "buttons": ["Cancel", "Save"],
        "defaultId": 1,
        "cancelId": 0
    })
}

/// The confirmation box shown by Gather Images.
pub fn gather_confirm_box() -> Value {
    json!({
        "type": "question",
        "title": "Gather Images",
        "message": "Gather all images?",
        "detail": "This will copy all externally-referenced images into the document's folder and update image paths to be relative.",
        "buttons": ["No", "Yes"],
        "defaultId": 1,
        "cancelId": 0
    })
}

/// The "nothing to gather" box.
pub fn gather_nothing_box() -> Value {
    json!({
        "type": "info",
        "title": "Gather Images",
        "message": "Nothing to gather",
        "detail": "All images are already relative to the document.",
        "buttons": ["OK"]
    })
}

/// The box summarising a completed gather.
pub fn gather_done_box(changed_count: usize, details: &[String]) -> Value {
    let plural = if changed_count == 1 { "" } else { "s" };
    json!({
        "type": "info",
        "title": "Gather Images",
        "message": format!("Gathered {changed_count} image{plural}"),
        "detail": details.join("\n"),
        "buttons": ["OK"]
    })
}

/// Scans the markdown for image references that are not relative to
/// `doc_dir`, copies those files into it, and rewrites the references to
/// relative paths. `exists` answers whether a destination already exists,
/// `same_size` whether two files have the same size, and `copy` copies a
/// file; a failed copy leaves its reference alone and adds a line of
/// detail.
pub fn gather_images(
    markdown: &str,
    doc_dir: &str,
    exists: impl Fn(&str) -> bool,
    same_size: impl Fn(&str, &str) -> bool,
    copy: impl Fn(&str, &str) -> Result<(), String>,
) -> GatherPlan {
    let mut updated_markdown = markdown.to_string();
    let mut changed_count = 0;
    let mut details: Vec<String> = Vec::new();
    let mut copies: Vec<(String, String)> = Vec::new();
    let doc_prefix = format!("{doc_dir}{SEP}");

    for (full_match, src) in find_images(markdown) {
        if is_url(&src) {
            continue;
        }
        let mut src_path =
            normalize_path(&crate::image_path::percent_decode(&strip_file_prefix(&src)));

        if !is_absolute_path(&src_path) {
            let resolved = resolve_path(doc_dir, &src_path);
            if relative_under(doc_dir, &resolved).is_some() || resolved == doc_dir {
                continue;
            }
            src_path = resolved;
        }

        // The source path is absolute from here on.
        if let Some(rel) = relative_under(doc_dir, &src_path) {
            updated_markdown = rewrite(&updated_markdown, &full_match, &src, &rel);
            changed_count += 1;
            details.push(format!("{} → {}", basename(&src_path), rel));
            continue;
        }

        let base_name = basename(&src_path);
        let ext = crate::file_manager::node_extname(&base_name);
        let stem = &base_name[..base_name.len() - ext.len()];
        let mut dest_path = format!("{doc_prefix}{base_name}");
        let mut counter = 2;
        while exists(&dest_path) {
            if same_size(&src_path, &dest_path) {
                break;
            }
            dest_path = format!("{doc_prefix}{stem}-{counter}{ext}");
            counter += 1;
        }
        if !exists(&dest_path) || !same_size(&src_path, &dest_path) {
            if let Err(error) = copy(&src_path, &dest_path) {
                details.push(format!("Failed to copy {src_path}: {error}"));
                continue;
            }
            copies.push((src_path.clone(), dest_path.clone()));
        }
        let rel = relative_under(doc_dir, &dest_path).unwrap_or_default();
        updated_markdown = rewrite(&updated_markdown, &full_match, &src, &rel);
        changed_count += 1;
        details.push(format!("{src_path} → {rel}"));
    }

    GatherPlan {
        updated_markdown: normalize_newlines(&updated_markdown),
        changed_count,
        details,
        copies,
    }
}

/// Brings the application menu in line with the current file, the recent
/// files and the open files, changing only the
/// native items that differ from the menu as it stands. The work runs on
/// the main thread, so refreshes asked for from other threads run one at
/// a time, in order, and the call returns once the menu is up to date.
pub fn refresh_menu(app: &AppHandle) {
    if MAIN_THREAD.get() == Some(&std::thread::current().id()) {
        apply_menu(app);
        return;
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    let handle = app.clone();
    let queued = app.run_on_main_thread(move || {
        apply_menu(&handle);
        let _ = sender.send(());
    });
    if queued.is_ok() {
        let _ = receiver.recv();
    }
}

/// Builds and sets the first menu, recording the main thread it is set
/// on. It must be called on the main thread.
pub fn install_menu(app: &AppHandle) {
    let _ = MAIN_THREAD.set(std::thread::current().id());
    apply_menu(app);
}

/// Builds the template for the current state and brings the native menu
/// in line with it: by changing only the items that differ from the last
/// template, or, when there is no menu yet or the menu does not match the
/// last template, by building and setting a new one.
fn apply_menu(app: &AppHandle) {
    let (old, new) = {
        let file_manager = app.state::<FileManagerState>();
        let file_manager = file_manager.lock().expect("file manager lock");
        let menu_state = app.state::<MenuState>();
        let mut menu_state = menu_state.lock().expect("menu lock");
        let new = build_menu(
            file_manager.current_file_path.as_deref(),
            &file_manager.recent_files,
            &menu_state.open_files,
        );
        menu_state.items.clear();
        record_items(&new, &mut menu_state.items);
        let old = std::mem::replace(&mut menu_state.template, new.clone());
        (old, new)
    };
    let updated = app
        .menu()
        .is_some_and(|menu| update_menu(app, &menu, &old, &new).unwrap_or(false));
    if !updated {
        if let Ok(menu) = build_tauri_menu(app, &new) {
            count_changes(entry_count(&new));
            let _ = app.set_menu(menu);
        }
    }
}

/// Brings a built menu in line with a new template. Returns false when the
/// built menu does not match the old template, so it has to be rebuilt.
fn update_menu(app: &AppHandle, menu: &Menu<Wry>, old: &Value, new: &Value) -> tauri::Result<bool> {
    let built = menu.items()?;
    let (Some(old), Some(new)) = (old.as_array(), new.as_array()) else {
        return Ok(false);
    };
    if built.len() != old.len() || old.len() != new.len() {
        return Ok(false);
    }
    for ((built, old), new) in built.iter().zip(old).zip(new) {
        let MenuItemKind::Submenu(submenu) = built else {
            return Ok(false);
        };
        if !update_submenu(app, submenu, old, new)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Brings a built submenu in line with a new template, changing its text
/// and enabled state only where they differ, keeping every child that
/// still has a counterpart, and building or removing only the children
/// that were added or removed. Returns false when the submenu does not
/// match the old template.
fn update_submenu(
    app: &AppHandle,
    submenu: &Submenu<Wry>,
    old: &Value,
    new: &Value,
) -> tauri::Result<bool> {
    let old_children = children(old);
    let new_children = children(new);
    let mut built = submenu.items()?;
    if built.len() != old_children.len() {
        return Ok(false);
    }
    let relabel = old["label"] != new["label"];
    let enable = old["enabled"] != new["enabled"];
    if relabel {
        submenu.set_text(entry_label(new))?;
    }
    if enable {
        submenu.set_enabled(entry_enabled(new))?;
    }
    if relabel || enable {
        count_changes(1);
    }
    for step in plan_children(old_children, new_children) {
        match step {
            ChildStep::Keep {
                position,
                old_index,
                new_index,
            } => {
                let kept = update_child(
                    app,
                    &built[position],
                    &old_children[old_index],
                    &new_children[new_index],
                )?;
                if !kept {
                    return Ok(false);
                }
            }
            ChildStep::Remove { position } => {
                submenu.remove_at(position)?;
                built.remove(position);
                count_changes(1);
            }
            ChildStep::Insert {
                position,
                new_index,
            } => {
                let child = build_child(app, &new_children[new_index])?;
                submenu.insert(&*child, position)?;
                built.insert(position, child.kind());
                count_changes(1);
            }
        }
    }
    Ok(true)
}

/// Changes a built child where its entry differs. A check item is
/// compared with its actual state, since choosing it toggles it. Returns
/// false when a nested submenu does not match the old template.
fn update_child(
    app: &AppHandle,
    built: &MenuItemKind<Wry>,
    old: &Value,
    new: &Value,
) -> tauri::Result<bool> {
    let relabel = old["label"] != new["label"];
    let enable = old["enabled"] != new["enabled"];
    let changed = match built {
        MenuItemKind::Submenu(submenu) => return update_submenu(app, submenu, old, new),
        MenuItemKind::MenuItem(item) => {
            if relabel {
                item.set_text(item_text(new).0)?;
            }
            if enable {
                item.set_enabled(entry_enabled(new))?;
            }
            relabel || enable
        }
        MenuItemKind::Check(check) => {
            let checked = new["checked"] == true;
            let recheck = check.is_checked()? != checked;
            if relabel {
                check.set_text(entry_label(new))?;
            }
            if enable {
                check.set_enabled(entry_enabled(new))?;
            }
            if recheck {
                check.set_checked(checked)?;
            }
            relabel || enable || recheck
        }
        MenuItemKind::Predefined(_) | MenuItemKind::Icon(_) => false,
    };
    if changed {
        count_changes(1);
    }
    Ok(true)
}

/// Matches a submenu's old entries to its new ones, in order, by what each
/// does, so that an entry added to or removed from a list adds or removes
/// only that entry and every other entry is kept.
fn plan_children(old: &[Value], new: &[Value]) -> Vec<ChildStep> {
    let mut steps = Vec::new();
    let mut next_old = 0;
    for (position, entry) in new.iter().enumerate() {
        let found = old[next_old..]
            .iter()
            .position(|candidate| same_slot(candidate, entry));
        match found {
            Some(skipped) => {
                steps.extend((0..skipped).map(|_| ChildStep::Remove { position }));
                next_old += skipped;
                steps.push(ChildStep::Keep {
                    position,
                    old_index: next_old,
                    new_index: position,
                });
                next_old += 1;
            }
            None => steps.push(ChildStep::Insert {
                position,
                new_index: position,
            }),
        }
    }
    let position = new.len();
    steps.extend((next_old..old.len()).map(|_| ChildStep::Remove { position }));
    steps
}

/// Whether a built child can stand for a new entry by changing only its
/// text, enabled state or check: the same kind of entry doing the same
/// thing with the same accelerator.
fn same_slot(old: &Value, new: &Value) -> bool {
    entry_kind(old) == entry_kind(new)
        && item_id(old) == item_id(new)
        && old["accelerator"] == new["accelerator"]
}

/// The kind of native item an entry is built as.
fn entry_kind(entry: &Value) -> &'static str {
    if entry["type"] == "separator" {
        "separator"
    } else if entry.get("submenu").is_some() {
        "submenu"
    } else if entry["type"] == "checkbox" {
        "checkbox"
    } else {
        "item"
    }
}

/// The entries of a submenu template.
fn children(entry: &Value) -> &[Value] {
    entry["submenu"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// An entry's label.
fn entry_label(entry: &Value) -> &str {
    entry["label"].as_str().unwrap_or("")
}

/// Whether an entry is enabled.
fn entry_enabled(entry: &Value) -> bool {
    entry["enabled"].as_bool().unwrap_or(true)
}

/// The id of the menu item whose accelerator is registered as the given
/// shortcut.
#[cfg(windows)]
pub fn registered_item(app: &AppHandle, shortcut: &str) -> Option<String> {
    let menu_state = app.state::<MenuState>();
    let menu_state = menu_state.lock().expect("menu lock");
    find_registered(&menu_state.items, shortcut)
}

/// The id of the item in `items` whose accelerator is registered as the
/// given shortcut.
#[cfg_attr(not(windows), allow(dead_code))]
fn find_registered(items: &HashMap<String, ItemInfo>, shortcut: &str) -> Option<String> {
    items
        .iter()
        .find(|(_, info)| info.registered && info.accelerator.as_deref() == Some(shortcut))
        .map(|(id, _)| id.clone())
}

/// The access letters of the top-level menus, in lower case.
#[cfg(windows)]
pub fn access_letters(app: &AppHandle) -> Vec<char> {
    let menu_state = app.state::<MenuState>();
    let menu_state = menu_state.lock().expect("menu lock");
    top_level_letters(&menu_state.template)
}

/// The access letters a template's top-level labels mark, in lower case.
#[cfg_attr(not(windows), allow(dead_code))]
fn top_level_letters(template: &Value) -> Vec<char> {
    template
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| access_letter(entry_label(entry)))
        .collect()
}

/// The letter a label marks with `&`, in lower case. `&&` marks none.
#[cfg_attr(not(windows), allow(dead_code))]
fn access_letter(label: &str) -> Option<char> {
    let mut chars = label.chars();
    while let Some(c) = chars.next() {
        if c == '&' {
            match chars.next() {
                Some('&') => {}
                next => return next.map(|letter| letter.to_ascii_lowercase()),
            }
        }
    }
    None
}

/// Records what each item of a template does under its id.
fn record_items(entries: &Value, items: &mut HashMap<String, ItemInfo>) {
    for entry in entries.as_array().into_iter().flatten() {
        match entry_kind(entry) {
            "separator" => {}
            "submenu" => record_items(&entry["submenu"], items),
            _ => {
                let registered = item_text(entry).1.is_some();
                items.insert(item_id(entry), item_info(entry, registered));
            }
        }
    }
}

/// Counts native menu items built, changed or removed, for the test hooks.
fn count_changes(count: usize) {
    #[cfg(feature = "test-hooks")]
    crate::test_hooks::record_menu_changes(count);
    #[cfg(not(feature = "test-hooks"))]
    let _ = count;
}

/// How many entries a template holds, counting each submenu and every
/// entry inside it.
fn entry_count(entries: &Value) -> usize {
    entries
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| 1 + entry_count(&entry["submenu"]))
        .sum()
}

/// Turns a menu template into a Tauri menu.
fn build_tauri_menu(app: &AppHandle, template: &Value) -> tauri::Result<Menu<Wry>> {
    let mut menu = TauriMenuBuilder::new(app);
    for entry in template.as_array().into_iter().flatten() {
        menu = menu.item(&build_submenu(app, entry)?);
    }
    menu.build()
}

/// Turns a submenu template into a Tauri submenu.
fn build_submenu(app: &AppHandle, entry: &Value) -> tauri::Result<Submenu<Wry>> {
    let mut builder = SubmenuBuilder::new(app, entry_label(entry)).enabled(entry_enabled(entry));
    for child in children(entry) {
        builder = builder.item(&*build_child(app, child)?);
    }
    builder.build()
}

/// Turns one entry of a submenu template into a Tauri menu item.
fn build_child(app: &AppHandle, entry: &Value) -> tauri::Result<Box<dyn IsMenuItem<Wry>>> {
    let child: Box<dyn IsMenuItem<Wry>> = match entry_kind(entry) {
        "separator" => Box::new(PredefinedMenuItem::separator(app)?),
        "submenu" => Box::new(build_submenu(app, entry)?),
        "checkbox" => Box::new(
            CheckMenuItemBuilder::with_id(item_id(entry), entry_label(entry))
                .checked(entry["checked"] == true)
                .enabled(entry_enabled(entry))
                .build(app)?,
        ),
        _ => match predefined_role(app, entry["role"].as_str())? {
            Some(predefined) => Box::new(predefined),
            None => Box::new(build_item(app, entry)?),
        },
    };
    Ok(child)
}

/// Turns an item template into a Tauri menu item, applying the
/// accelerator policy.
fn build_item(app: &AppHandle, entry: &Value) -> tauri::Result<MenuItem<Wry>> {
    let (text, register) = item_text(entry);
    let mut builder = MenuItemBuilder::with_id(item_id(entry), text).enabled(entry_enabled(entry));
    if let Some(accelerator) = &register {
        builder = builder.accelerator(accelerator);
    }
    builder.build(app)
}

/// An item's text and the accelerator to register for it.
fn item_text(entry: &Value) -> (String, Option<String>) {
    let label = entry_label(entry);
    match entry["accelerator"].as_str() {
        Some(accelerator) => present_accelerator(label, accelerator),
        None => (label.to_string(), None),
    }
}

/// An item's id, derived from what it does: its role, or its action and
/// argument, or for an item that does nothing, its label.
fn item_id(entry: &Value) -> String {
    match (
        entry["role"].as_str(),
        entry["action"].as_str(),
        entry["actionArg"].as_str(),
    ) {
        (Some(role), _, _) => format!("role:{role}"),
        (None, Some(action), Some(arg)) => format!("{action}|{arg}"),
        (None, Some(action), None) => action.to_string(),
        (None, None, _) => format!("label:{}", entry["label"].as_str().unwrap_or("")),
    }
}

/// What an item template does, and whether its accelerator is registered.
fn item_info(entry: &Value, registered: bool) -> ItemInfo {
    ItemInfo {
        action: entry["action"].as_str().map(str::to_string),
        action_arg: entry["actionArg"].as_str().map(str::to_string),
        role: entry["role"].as_str().map(str::to_string),
        accelerator: entry["accelerator"].as_str().map(str::to_string),
        registered,
    }
}

/// The item text and the accelerator to register. The Edit shortcuts the
/// page handles itself are not registered on Windows and Linux; on Windows
/// their shortcut is written after a tab in the item text, where Win32
/// shows it right-aligned like an accelerator, and GTK cannot show it
/// without registering it.
fn present_accelerator(label: &str, accelerator: &str) -> (String, Option<String>) {
    if cfg!(target_os = "macos") || !PAGE_HANDLED.contains(&accelerator) {
        return (label.to_string(), Some(accelerator.to_string()));
    }
    if cfg!(windows) {
        let shown = accelerator.replace("CmdOrCtrl", "Ctrl");
        (format!("{label}\t{shown}"), None)
    } else {
        (label.to_string(), None)
    }
}

/// The predefined item for an edit role on macOS, which uses the
/// native selectors there.
#[cfg(target_os = "macos")]
fn predefined_role(
    app: &AppHandle,
    role: Option<&str>,
) -> tauri::Result<Option<PredefinedMenuItem<Wry>>> {
    Ok(match role {
        Some("cut") => Some(PredefinedMenuItem::cut(app, None)?),
        Some("copy") => Some(PredefinedMenuItem::copy(app, None)?),
        Some("paste") => Some(PredefinedMenuItem::paste(app, None)?),
        Some("selectAll") => Some(PredefinedMenuItem::select_all(app, None)?),
        _ => None,
    })
}

/// Edit roles are custom items on Windows and Linux.
#[cfg(not(target_os = "macos"))]
fn predefined_role(
    _app: &AppHandle,
    _role: Option<&str>,
) -> tauri::Result<Option<PredefinedMenuItem<Wry>>> {
    Ok(None)
}

/// Runs the item with the given id, from the menu bar or the context
/// menu.
pub fn handle_menu_event(app: &AppHandle, id: &str) {
    let info = app
        .state::<MenuState>()
        .lock()
        .expect("menu lock")
        .items
        .get(id)
        .cloned()
        .or_else(|| context_item(id));
    if let Some(info) = info {
        run_item(app, &info);
    }
}

/// What the item with the given id in the last popped-up menu does.
fn context_item(id: &str) -> Option<ItemInfo> {
    POPUP_ITEMS
        .lock()
        .expect("popup items lock")
        .as_ref()
        .and_then(|items| items.get(id).cloned())
}

/// What each item of the last popped-up menu does, by id.
static POPUP_ITEMS: std::sync::Mutex<Option<HashMap<String, ItemInfo>>> =
    std::sync::Mutex::new(None);

/// The point of the page, in CSS pixels, the last context menu was asked
/// for, where its Inspect Element inspects.
static CONTEXT_POINT: std::sync::Mutex<Option<(f64, f64)>> = std::sync::Mutex::new(None);

/// Shows the document's context menu at a point of the page, in CSS
/// pixels.
pub fn show_context_menu(window: &tauri::WebviewWindow, x: f64, y: f64) {
    *CONTEXT_POINT.lock().expect("context point lock") = Some((x, y));
    show_popup(window, x, y, &build_context_menu());
}

/// Shows a tab's context menu at a point of the page, in CSS pixels, for
/// the tab's file, or for a tab that has no file.
pub fn show_tab_context_menu(
    window: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    file_path: Option<&str>,
) {
    show_popup(window, x, y, &build_tab_context_menu(file_path));
}

/// Pops up a menu built from a template at a point of the page, in CSS
/// pixels, keeping what its items do. The test build records the menu and
/// the point instead of popping it up.
fn show_popup(window: &tauri::WebviewWindow, x: f64, y: f64, template: &Value) {
    let mut items = HashMap::new();
    record_items(template, &mut items);
    *POPUP_ITEMS.lock().expect("popup items lock") = Some(items);
    let Ok(menu) = build_popup_menu(window.app_handle(), template) else {
        return;
    };
    #[cfg(feature = "test-hooks")]
    crate::test_hooks::record_context_menu(x, y, context_entries(&menu));
    #[cfg(not(feature = "test-hooks"))]
    let _ = window.popup_menu_at(&menu, tauri::LogicalPosition::new(x, y));
}

/// Turns a menu template with no submenus into a Tauri menu to pop up.
fn build_popup_menu(app: &AppHandle, template: &Value) -> tauri::Result<Menu<Wry>> {
    let mut menu = TauriMenuBuilder::new(app);
    for entry in template.as_array().into_iter().flatten() {
        menu = menu.item(&*build_child(app, entry)?);
    }
    menu.build()
}

/// Each entry of a built context menu: its label, or none for a
/// separator, its id, and whether it is enabled.
#[cfg(feature = "test-hooks")]
fn context_entries(menu: &Menu<Wry>) -> Vec<crate::test_hooks::ContextEntry> {
    menu.items()
        .unwrap_or_default()
        .iter()
        .map(|kind| {
            let label = label_of(kind).filter(|label| !label.is_empty());
            (
                label,
                kind.id().0.clone(),
                kind_enabled(kind).unwrap_or(true),
            )
        })
        .collect()
}

/// Runs what an item does. Handlers that show a dialog run on the async
/// runtime's blocking pool, since a blocking dialog on the main thread
/// would stall the event loop that menu events arrive on.
fn run_item(app: &AppHandle, info: &ItemInfo) {
    if let Some(role) = info.role.as_deref() {
        run_role(app, role);
        return;
    }
    let arg = info.action_arg.clone().unwrap_or_default();
    match info.action.as_deref() {
        Some("file:load") => run_in_background(app, handle_load),
        Some("file:loadRecent") => handle_load_recent(app, &arg),
        Some("file:clearRecent") => clear_recent_files(app),
        Some("file:copyPath") => copy_file_path(app),
        Some("tab:copyPath") if !arg.is_empty() => copy_to_clipboard(app, &arg),
        Some("app:exit") => handle_exit(app),
        Some("app:reload") => handle_reload(app),
        Some("app:debug") => handle_debug(app),
        Some("context:inspect") => handle_inspect(app),
        Some("help:about") => run_in_background(app, handle_about),
        Some("edit:gatherImages") => run_in_background(app, handle_gather_images),
        Some("view:switchFile") => send_menu_action(app, "view:switchFile", vec![json!(arg)]),
        Some(action) => send_menu_action(app, action, Vec::new()),
        None => {}
    }
}

/// Runs a handler on the async runtime's blocking pool.
fn run_in_background(app: &AppHandle, handler: fn(&AppHandle)) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || handler(&app));
}

/// Sends a menu action to the renderer.
fn send_menu_action(app: &AppHandle, action: &str, args: Vec<Value>) {
    if let Some(window) = app.get_webview_window("main") {
        let web_contents = app.state::<WebContentsState>();
        crate::ipc_handler::emit_menu_action(&window, web_contents.inner(), action, args);
    }
}

/// The current file, if any.
fn current_file_path(app: &AppHandle) -> Option<String> {
    app.state::<FileManagerState>()
        .lock()
        .expect("file manager lock")
        .current_file_path
        .clone()
}

/// File > Load...: shows the Load dialog and opens the chosen file.
fn handle_load(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let result = crate::ipc_handler::load_with_dialog(&window, app);
    if result["success"] == true {
        send_menu_action(app, "file:loaded", vec![result]);
        refresh_menu(app);
    }
}

/// File > Open Recent > a file: opens it. The menu is rebuilt either way,
/// since a file that failed to load leaves the recent files list.
fn handle_load_recent(app: &AppHandle, file_path: &str) {
    let result = crate::ipc_handler::load_path(app, file_path);
    if result["success"] == true {
        send_menu_action(app, "file:loaded", vec![result]);
    }
    refresh_menu(app);
}

/// File > Open Recent > Clear Recent.
fn clear_recent_files(app: &AppHandle) {
    app.state::<FileManagerState>()
        .lock()
        .expect("file manager lock")
        .recent_files
        .clear();
    crate::ipc_handler::persist_recent(&app.state::<Settings>(), &[]);
    refresh_menu(app);
}

/// File > Utilities > Copy File Path: copies the current file's path to
/// the system clipboard.
fn copy_file_path(app: &AppHandle) {
    if let Some(path) = current_file_path(app) {
        copy_to_clipboard(app, &path);
    }
}

/// Copies text to the system clipboard.
fn copy_to_clipboard(app: &AppHandle, text: &str) {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let _ = app.clipboard().write_text(text.to_string());
}

/// File > Exit: closes the window.
fn handle_exit(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
}

/// Help > Reload: reloads the page bypassing the cache, then restores the
/// open files saved in the settings.
pub fn handle_reload(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        crate::restore_on_next_load();
        crate::webview_settings::reload_ignoring_cache(&window);
    }
}

/// Help > Debug: opens DevTools.
fn handle_debug(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.open_devtools();
    }
}

/// Context menu > Inspect Element: opens DevTools on the element the menu
/// was asked for; where the webview
/// cannot inspect a point, it opens DevTools.
fn handle_inspect(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let point = *CONTEXT_POINT.lock().expect("context point lock");
    #[cfg(any(windows, target_os = "macos"))]
    if let Some((x, y)) = point {
        crate::webview_settings::inspect_element(&window, x, y);
        return;
    }
    let _ = point;
    window.open_devtools();
}

/// Help > About: shows the About box; Visit GitHub opens the repository
/// in the system browser.
fn handle_about(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let version = app.package_info().version.to_string();
    if crate::ipc_handler::show_message_box(&window, &about_box(&version)) == 0 {
        crate::webview_settings::open_external(app, REPOSITORY_URL);
    }
}

/// Edit > Images > Gather: copies every image outside the document's
/// folder into it and rewrites the references, asking for the document to
/// be saved first when it has no file.
fn handle_gather_images(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if current_file_path(app).is_none() {
        if crate::ipc_handler::show_message_box(&window, &gather_save_first_box()) == 0 {
            return;
        }
        send_menu_action(app, "file:save", Vec::new());
        std::thread::sleep(Duration::from_millis(500));
        let mut waited = 0;
        while current_file_path(app).is_none() && waited < 10_000 {
            std::thread::sleep(Duration::from_millis(200));
            waited += 200;
        }
    }
    let Some(current) = current_file_path(app) else {
        return;
    };
    if crate::ipc_handler::show_message_box(&window, &gather_confirm_box()) == 0 {
        return;
    }

    let web_contents = app.state::<WebContentsState>();
    let markdown = crate::web_contents::execute_javascript(
        &window,
        web_contents.inner(),
        "window.editorAPI?.getContent() ?? \"\"",
    )
    .ok()
    .and_then(|value| value.as_str().map(str::to_string))
    .unwrap_or_default();
    if markdown.is_empty() {
        return;
    }

    let doc_dir = Path::new(&current)
        .parent()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_default();
    let plan = gather_images(&markdown, &doc_dir, path_exists, same_file_size, copy_file);
    if plan.changed_count == 0 {
        crate::ipc_handler::show_message_box(&window, &gather_nothing_box());
        return;
    }

    let set_content = format!(
        "window.editorAPI?.setContent({})",
        crate::web_contents::js_string(&plan.updated_markdown)
    );
    let _ = crate::web_contents::execute_javascript(&window, web_contents.inner(), &set_content);
    let _ = crate::web_contents::execute_javascript(
        &window,
        web_contents.inner(),
        "window.editorAPI?.setUnsavedChanges(true)",
    );
    crate::ipc_handler::show_message_box(
        &window,
        &gather_done_box(plan.changed_count, &plan.details),
    );
}

/// Whether a file exists.
fn path_exists(path: &str) -> bool {
    Path::new(path).exists()
}

/// Whether two files have the same size, Gather Images' quick equality
/// check.
fn same_file_size(first: &str, second: &str) -> bool {
    match (std::fs::metadata(first), std::fs::metadata(second)) {
        (Ok(first), Ok(second)) => first.len() == second.len(),
        _ => false,
    }
}

/// Copies a file.
fn copy_file(source: &str, destination: &str) -> Result<(), String> {
    std::fs::copy(source, destination)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Runs an edit role: Select All selects the page's content natively, and
/// Cut, Copy and Paste send their keystroke, which the webview turns into
/// the native clipboard command exactly as a key press does.
fn run_role(app: &AppHandle, role: &str) {
    match role {
        "selectAll" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("document.execCommand(\"selectAll\")");
            }
        }
        "cut" => send_keystroke(app, 'X'),
        "copy" => send_keystroke(app, 'C'),
        "paste" => send_keystroke(app, 'V'),
        _ => {}
    }
}

/// Records the keystroke instead of sending it, since under test it
/// would go to whatever window has the user's focus.
#[cfg(feature = "test-hooks")]
fn send_keystroke(_app: &AppHandle, key: char) {
    crate::test_hooks::record_keystroke(&format!("Ctrl+{key}"));
}

/// Sends Ctrl and the key to the focused window, which after a menu click
/// is the webview.
#[cfg(all(windows, not(feature = "test-hooks")))]
fn send_keystroke(_app: &AppHandle, key: char) {
    let letter = VIRTUAL_KEY(key as u16);
    let inputs = [
        keyboard_input(VK_CONTROL, KEYBD_EVENT_FLAGS(0)),
        keyboard_input(letter, KEYBD_EVENT_FLAGS(0)),
        keyboard_input(letter, KEYEVENTF_KEYUP),
        keyboard_input(VK_CONTROL, KEYEVENTF_KEYUP),
    ];
    // Safe: every entry is a fully initialized keyboard input of the size
    // passed.
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// One keyboard event for `SendInput`.
#[cfg(all(windows, not(feature = "test-hooks")))]
fn keyboard_input(key: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Sends the editing command down AppKit's responder chain, as the Edit
/// menu's own items do: WebKit refuses a paste asked for from script.
#[cfg(all(target_os = "macos", not(feature = "test-hooks")))]
fn send_keystroke(app: &AppHandle, key: char) {
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, sel};
    let action = match key {
        'X' => sel!(cut:),
        'C' => sel!(copy:),
        _ => sel!(paste:),
    };
    let _ = app.run_on_main_thread(move || {
        let Some(class) = AnyClass::get(c"NSApplication") else {
            return;
        };
        let nobody = std::ptr::null_mut::<AnyObject>();
        // Safe: this runs on the main thread, and a nil target and sender
        // are what `sendAction:to:from:` takes for the responder chain.
        unsafe {
            let application: *mut AnyObject = msg_send![class, sharedApplication];
            let _: Bool = msg_send![application, sendAction: action, to: nobody, from: nobody];
        }
    });
}

/// Runs the editing command directly where no keystroke is sent.
#[cfg(all(target_os = "linux", not(feature = "test-hooks")))]
fn send_keystroke(app: &AppHandle, key: char) {
    let command = match key {
        'X' => "cut",
        'C' => "copy",
        _ => "paste",
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(format!("document.execCommand({command:?})"));
    }
}

/// The built menu as the test hooks describe it: each entry's label, its
/// accelerator and whether that is registered, and its enabled and
/// checked state.
#[cfg(feature = "test-hooks")]
pub fn describe_menu(app: &AppHandle) -> Value {
    let Some(menu) = app.menu() else {
        return Value::Array(Vec::new());
    };
    let items = app
        .state::<MenuState>()
        .lock()
        .expect("menu lock")
        .items
        .clone();
    Value::Array(describe_items(&menu.items().unwrap_or_default(), &items))
}

/// Describes a list of menu entries.
#[cfg(feature = "test-hooks")]
fn describe_items(kinds: &[MenuItemKind<Wry>], items: &HashMap<String, ItemInfo>) -> Vec<Value> {
    kinds
        .iter()
        .filter_map(|kind| describe_kind(kind, items))
        .collect()
}

/// Describes one menu entry.
#[cfg(feature = "test-hooks")]
fn describe_kind(kind: &MenuItemKind<Wry>, items: &HashMap<String, ItemInfo>) -> Option<Value> {
    match kind {
        MenuItemKind::Submenu(submenu) => Some(json!({
            "label": without_access_marker(&submenu.text().unwrap_or_default()),
            "enabled": submenu.is_enabled().unwrap_or(false),
            "submenu": describe_items(&submenu.items().unwrap_or_default(), items),
        })),
        MenuItemKind::MenuItem(item) => {
            let mut entry = json!({
                "label": shown_label(&item.text().unwrap_or_default()),
                "enabled": item.is_enabled().unwrap_or(false),
            });
            if let Some(info) = items.get(&item.id().0) {
                if let Some(accelerator) = &info.accelerator {
                    entry["accelerator"] = json!(accelerator);
                    entry["registered"] = json!(info.registered);
                }
            }
            Some(entry)
        }
        MenuItemKind::Check(item) => Some(json!({
            "label": item.text().unwrap_or_default(),
            "type": "checkbox",
            "checked": item.is_checked().unwrap_or(false),
            "enabled": item.is_enabled().unwrap_or(false),
        })),
        MenuItemKind::Predefined(item) => {
            let text = item.text().unwrap_or_default();
            if text.is_empty() {
                return Some(json!({ "type": "separator" }));
            }
            let mut entry = json!({ "label": text, "enabled": true });
            let info =
                predefined_item_role(&text).and_then(|role| items.get(&format!("role:{role}")));
            if let Some(accelerator) = info.and_then(|info| info.accelerator.as_ref()) {
                entry["accelerator"] = json!(accelerator);
                entry["registered"] = json!(true);
            }
            Some(entry)
        }
        MenuItemKind::Icon(_) => None,
    }
}

/// The edit role of a predefined item, by the label it shows.
#[cfg(feature = "test-hooks")]
fn predefined_item_role(label: &str) -> Option<&'static str> {
    match label {
        "Cut" => Some("cut"),
        "Copy" => Some("copy"),
        "Paste" => Some("paste"),
        "Select All" => Some("selectAll"),
        _ => None,
    }
}

/// An item's label without the shortcut text written after a tab.
#[cfg(feature = "test-hooks")]
fn shown_label(text: &str) -> String {
    text.split('\t').next().unwrap_or_default().to_string()
}

/// A submenu label as Windows shows it: the `&` that marks the access
/// letter is not shown, and `&&` shows as `&`.
#[cfg(feature = "test-hooks")]
fn without_access_marker(text: &str) -> String {
    let mut shown = String::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '&' {
            shown.extend(chars.next());
        } else {
            shown.push(c);
        }
    }
    shown
}

/// The label an entry shows.
#[cfg(feature = "test-hooks")]
fn label_of(kind: &MenuItemKind<Wry>) -> Option<String> {
    match kind {
        MenuItemKind::Submenu(submenu) => {
            submenu.text().ok().map(|text| without_access_marker(&text))
        }
        MenuItemKind::MenuItem(item) => item.text().ok().map(|text| shown_label(&text)),
        MenuItemKind::Check(item) => item.text().ok(),
        MenuItemKind::Predefined(item) => item.text().ok(),
        MenuItemKind::Icon(item) => item.text().ok(),
    }
}

/// The entry reached by following a path of labels from the menu bar.
#[cfg(feature = "test-hooks")]
fn find_item(app: &AppHandle, labels: &[String]) -> Option<MenuItemKind<Wry>> {
    let mut kinds = app.menu()?.items().ok()?;
    for (index, label) in labels.iter().enumerate() {
        let found = kinds
            .into_iter()
            .find(|kind| label_of(kind).as_deref() == Some(label.as_str()))?;
        if index + 1 == labels.len() {
            return Some(found);
        }
        kinds = found.as_submenu()?.items().ok()?;
    }
    None
}

/// Whether the entry at a label path is enabled.
#[cfg(feature = "test-hooks")]
pub fn item_enabled(app: &AppHandle, labels: &[String]) -> Option<bool> {
    kind_enabled(&find_item(app, labels)?)
}

/// Whether a built menu entry is enabled, for the kinds that can be
/// disabled.
#[cfg(feature = "test-hooks")]
fn kind_enabled(kind: &MenuItemKind<Wry>) -> Option<bool> {
    match kind {
        MenuItemKind::Submenu(submenu) => submenu.is_enabled().ok(),
        MenuItemKind::MenuItem(item) => item.is_enabled().ok(),
        MenuItemKind::Check(item) => item.is_enabled().ok(),
        _ => None,
    }
}

/// Chooses the entry at a label path.
#[cfg(feature = "test-hooks")]
pub fn click_item(app: &AppHandle, labels: &[String]) -> bool {
    match find_item(app, labels) {
        Some(MenuItemKind::Predefined(item)) => {
            if let Some(role) = predefined_item_role(&item.text().unwrap_or_default()) {
                run_role(app, role);
            }
            true
        }
        Some(kind) => {
            handle_menu_event(app, &kind.id().0);
            true
        }
        None => false,
    }
}

/// A separator entry.
fn separator() -> Value {
    json!({ "type": "separator" })
}

/// An item with an accelerator that sends a menu action.
fn item(label: &str, accelerator: &str, action: &str) -> Value {
    json!({ "label": label, "accelerator": accelerator, "enabled": true, "action": action })
}

/// An item with no accelerator that sends a menu action.
fn item_plain(label: &str, action: &str) -> Value {
    json!({ "label": label, "enabled": true, "action": action })
}

/// An item backed by a Tauri predefined role.
fn role_item(label: &str, accelerator: &str, role: &str) -> Value {
    json!({ "label": label, "accelerator": accelerator, "enabled": true, "role": role })
}

/// A role item with no accelerator (the context menu's edit items).
#[cfg_attr(not(test), allow(dead_code))]
fn role_item_plain(label: &str, role: &str) -> Value {
    json!({ "label": label, "enabled": true, "role": role })
}

/// A submenu container item.
fn submenu(label: &str, items: Vec<Value>) -> Value {
    json!({ "label": label, "enabled": true, "submenu": items })
}

/// The Open Recent submenu items for a recent files list.
fn build_recent_submenu(recent_files: &[String]) -> Vec<Value> {
    if recent_files.is_empty() {
        return vec![json!({ "label": "No Recent Files", "enabled": false })];
    }
    let mut items: Vec<Value> = recent_files
        .iter()
        .map(|path| {
            json!({
                "label": path,
                "enabled": true,
                "action": "file:loadRecent",
                "actionArg": path
            })
        })
        .collect();
    items.push(separator());
    items.push(item_plain("Clear Recent", "file:clearRecent"));
    items
}

/// The Copy File Path item, enabled only when a file is open.
fn copy_path_item(current_file_path: Option<&str>) -> Value {
    json!({
        "label": "Copy File Path",
        "enabled": current_file_path.is_some(),
        "action": "file:copyPath"
    })
}

/// The Exit item, with the platform's accelerator.
fn exit_item() -> Value {
    let accelerator = if cfg!(target_os = "macos") {
        "Cmd+Q"
    } else {
        "Alt+F4"
    };
    json!({ "label": "Exit", "accelerator": accelerator, "enabled": true, "action": "app:exit" })
}

/// Whether a source is a URL that Gather Images leaves alone.
fn is_url(src: &str) -> bool {
    let lower = src.to_lowercase();
    lower.starts_with("http:")
        || lower.starts_with("https:")
        || lower.starts_with("data:")
        || lower.starts_with("blob:")
}

/// Strips a `file://` prefix, and the slash after it when a drive follows,
/// as in `file:///C:/`, keeping the leading slash of a POSIX path.
fn strip_file_prefix(src: &str) -> String {
    let Some(rest) = src.strip_prefix("file://") else {
        return src.to_string();
    };
    let (drive, _) = crate::image_path::split_path(rest);
    if drive.is_empty() {
        rest.to_string()
    } else {
        rest.trim_start_matches('/').to_string()
    }
}

/// Joins the drive and segments back into a host-style path, with a
/// leading separator only after a drive.
fn join_segments(drive: &str, segments: &[String]) -> String {
    let mut path = drive.to_string();
    for (index, segment) in segments.iter().enumerate() {
        if index > 0 || !drive.is_empty() {
            path.push(SEP);
        }
        path.push_str(segment);
    }
    path
}

/// Rewrites the first occurrence of an image match, replacing the first
/// occurrence of its source within it.
fn rewrite(markdown: &str, full_match: &str, src: &str, rel: &str) -> String {
    let new_match = full_match.replacen(src, rel, 1);
    markdown.replacen(full_match, &new_match, 1)
}

/// Node's `path.normalize` for comparison: resolves `.`/`..`, uses the
/// host separator, and keeps the leading separator of a path that starts
/// with one and has no drive.
fn normalize_path(path: &str) -> String {
    let (drive, segments) = crate::image_path::split_path(path);
    let joined = join_segments(&drive, &segments);
    if drive.is_empty() && (path.starts_with('/') || path.starts_with('\\')) {
        format!("{SEP}{joined}")
    } else {
        joined
    }
}

/// Whether a path is absolute (has a drive, or a leading separator).
fn is_absolute_path(path: &str) -> bool {
    let (drive, _) = crate::image_path::split_path(path);
    !drive.is_empty() || path.starts_with('/') || path.starts_with('\\')
}

/// Node's `path.resolve(base, rel)` for the paths this scan sees.
fn resolve_path(base: &str, rel: &str) -> String {
    normalize_path(&format!("{base}{SEP}{rel}"))
}

/// The final path segment.
fn basename(path: &str) -> String {
    let (_, segments) = crate::image_path::split_path(path);
    segments.last().cloned().unwrap_or_default()
}

/// The path relative to `base` when `target` sits under it, as a POSIX
/// string, or None when it does not.
fn relative_under(base: &str, target: &str) -> Option<String> {
    let (base_drive, base_segments) = crate::image_path::split_path(base);
    let (target_drive, target_segments) = crate::image_path::split_path(target);
    if !base_drive.eq_ignore_ascii_case(&target_drive)
        || target_segments.len() < base_segments.len()
    {
        return None;
    }
    for (base_segment, target_segment) in base_segments.iter().zip(target_segments.iter()) {
        if !base_segment.eq_ignore_ascii_case(target_segment) {
            return None;
        }
    }
    Some(target_segments[base_segments.len()..].join("/"))
}

/// The `![alt](src)` images in the markdown, as (full match, src) pairs,
/// by these rules: alt without `]`, a non-empty src without
/// `)`.
fn find_images(markdown: &str) -> Vec<(String, String)> {
    let bytes = markdown.as_bytes();
    let mut images = Vec::new();
    let mut index = 0;
    while index + 1 < bytes.len() {
        if bytes[index] == b'!' && bytes[index + 1] == b'[' {
            if let Some(alt_end) = find_byte(bytes, b']', index + 2) {
                if bytes.get(alt_end + 1) == Some(&b'(') {
                    if let Some(src_end) = find_byte(bytes, b')', alt_end + 2) {
                        if src_end > alt_end + 2 {
                            images.push((
                                markdown[index..=src_end].to_string(),
                                markdown[alt_end + 2..src_end].to_string(),
                            ));
                            index = src_end + 1;
                            continue;
                        }
                    }
                }
            }
        }
        index += 1;
    }
    images
}

/// The index of the first `byte` at or after `from`.
fn find_byte(bytes: &[u8], byte: u8, from: usize) -> Option<usize> {
    bytes[from..]
        .iter()
        .position(|&candidate| candidate == byte)
        .map(|offset| from + offset)
}

/// Turns CRLF and lone CR into LF, as a JS template literal did to the
/// gathered text.
fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(menu: &Value) -> Vec<String> {
        menu["submenu"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                entry["label"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("<{}>", entry["type"].as_str().unwrap_or("?")))
            })
            .collect()
    }

    #[test]
    fn menu_builder_file_menu_without_a_file_or_recents() {
        let menu = build_file_menu(None, &[]);
        assert_eq!(menu["label"], "&File");
        assert_eq!(
            labels(&menu),
            vec![
                "New",
                "Load...",
                "Open Recent",
                "<separator>",
                "Save",
                "Save As...",
                "Export",
                "<separator>",
                "Close",
                "<separator>",
                "Restructure",
                "Utilities",
                "<separator>",
                "Exit",
            ]
        );
        let submenu = menu["submenu"].as_array().unwrap();
        assert_eq!(submenu[0]["accelerator"], "CmdOrCtrl+N");
        assert_eq!(submenu[0]["action"], "file:new");
        assert_eq!(submenu[1]["accelerator"], "CmdOrCtrl+O");
        assert_eq!(
            submenu[2]["submenu"],
            json!([{ "label": "No Recent Files", "enabled": false }])
        );
        let utilities = submenu[11]["submenu"].as_array().unwrap();
        assert_eq!(utilities[1]["label"], "Copy File Path");
        assert_eq!(utilities[1]["enabled"], false);
        assert_eq!(submenu[13]["label"], "Exit");
    }

    #[test]
    fn menu_builder_file_menu_with_a_file_and_recents() {
        let recents = vec!["C:\\a.md".to_string(), "C:\\b.md".to_string()];
        let menu = build_file_menu(Some("C:\\a.md"), &recents);
        let submenu = menu["submenu"].as_array().unwrap();
        let recent = submenu[2]["submenu"].as_array().unwrap();
        assert_eq!(recent[0]["label"], "C:\\a.md");
        assert_eq!(recent[0]["action"], "file:loadRecent");
        assert_eq!(recent[0]["actionArg"], "C:\\a.md");
        assert_eq!(recent[1]["label"], "C:\\b.md");
        assert_eq!(recent[2]["type"], "separator");
        assert_eq!(recent[3]["label"], "Clear Recent");
        let utilities = submenu[11]["submenu"].as_array().unwrap();
        assert_eq!(utilities[1]["enabled"], true);
    }

    #[test]
    fn menu_builder_edit_menu_items_and_roles() {
        let menu = build_edit_menu();
        assert_eq!(menu["label"], "&Edit");
        assert_eq!(
            labels(&menu),
            vec![
                "Undo",
                "Redo",
                "<separator>",
                "Cut",
                "Copy",
                "Paste",
                "<separator>",
                "Select All",
                "<separator>",
                "Images",
                "<separator>",
                PREFERENCES_LABEL,
            ]
        );
        let submenu = menu["submenu"].as_array().unwrap();
        assert_eq!(submenu[0]["action"], "edit:undo");
        assert_eq!(submenu[3]["role"], "cut");
        assert_eq!(submenu[3]["accelerator"], "CmdOrCtrl+X");
        assert_eq!(submenu[7]["role"], "selectAll");
        assert_eq!(submenu[9]["submenu"][0]["label"], "Gather");
        assert_eq!(submenu[9]["submenu"][0]["action"], "edit:gatherImages");
        assert_eq!(submenu[11]["accelerator"], "CmdOrCtrl+,");
    }

    #[test]
    fn menu_builder_view_menu_lists_open_files_with_checkmarks() {
        let open = vec![
            OpenFile {
                id: "t1".to_string(),
                label: "a.md".to_string(),
                active: true,
            },
            OpenFile {
                id: "t2".to_string(),
                label: "b.md".to_string(),
                active: false,
            },
        ];
        let menu = build_view_menu(&open);
        let submenu = menu["submenu"].as_array().unwrap();
        assert_eq!(submenu[0]["label"], "Writing View");
        assert_eq!(submenu[0]["accelerator"], "CmdOrCtrl+1");
        assert_eq!(submenu[1]["accelerator"], "CmdOrCtrl+2");
        assert_eq!(submenu[2]["type"], "separator");
        assert_eq!(submenu[3]["label"], "a.md");
        assert_eq!(submenu[3]["type"], "checkbox");
        assert_eq!(submenu[3]["checked"], true);
        assert_eq!(submenu[3]["action"], "view:switchFile");
        assert_eq!(submenu[3]["actionArg"], "t1");
        assert_eq!(submenu[4]["checked"], false);
    }

    #[test]
    fn menu_builder_view_menu_without_open_files_has_no_separator() {
        let menu = build_view_menu(&[]);
        assert_eq!(menu["submenu"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn menu_builder_help_menu_items() {
        let menu = build_help_menu();
        assert_eq!(
            labels(&menu),
            vec!["Reload", "<separator>", "Debug", "<separator>", "About"]
        );
        let submenu = menu["submenu"].as_array().unwrap();
        assert_eq!(submenu[0]["accelerator"], "CmdOrCtrl+Shift+R");
        assert_eq!(submenu[0]["action"], "app:reload");
        assert_eq!(submenu[2]["accelerator"], "F12");
        assert_eq!(submenu[4]["action"], "help:about");
    }

    #[test]
    fn menu_builder_tab_context_menu_copies_that_tab_s_path() {
        assert_eq!(
            build_tab_context_menu(Some("/docs/notes.md")),
            json!([{
                "label": "Copy File Path",
                "enabled": true,
                "action": "tab:copyPath",
                "actionArg": "/docs/notes.md"
            }])
        );
        assert_eq!(
            build_tab_context_menu(None),
            json!([{ "label": "Copy File Path", "enabled": false, "action": "tab:copyPath" }])
        );
    }

    #[test]
    fn menu_builder_context_menu_items() {
        let menu = build_context_menu();
        let items = menu.as_array().unwrap();
        assert_eq!(items[0]["role"], "copy");
        assert_eq!(items[1]["role"], "cut");
        assert_eq!(items[2]["role"], "paste");
        assert_eq!(items[3]["type"], "separator");
        assert_eq!(items[4]["label"], "Inspect Element");
        assert_eq!(items[4]["action"], "context:inspect");
    }

    #[test]
    fn menu_builder_about_box_text() {
        let about = about_box("2.2.1");
        assert_eq!(about["title"], "About Markdown Editor");
        assert_eq!(about["message"], "Pomax's Markdown Editor v2.2.1");
        assert_eq!(about["buttons"], json!(["Visit GitHub", "OK"]));
        assert_eq!(about["defaultId"], 1);
        assert_eq!(about["cancelId"], 1);
        assert!(
            about["detail"]
                .as_str()
                .unwrap()
                .contains("github.com/Pomax/Pomax-s-Markdown-Editor")
        );
    }

    #[test]
    fn menu_builder_gather_box_texts() {
        assert_eq!(
            gather_save_first_box()["buttons"],
            json!(["Cancel", "Save"])
        );
        assert_eq!(gather_save_first_box()["defaultId"], 1);
        assert_eq!(gather_save_first_box()["cancelId"], 0);
        assert_eq!(gather_confirm_box()["message"], "Gather all images?");
        assert_eq!(gather_confirm_box()["buttons"], json!(["No", "Yes"]));
        assert_eq!(gather_nothing_box()["message"], "Nothing to gather");
        assert_eq!(
            gather_done_box(1, &["a".to_string()])["message"],
            "Gathered 1 image"
        );
        assert_eq!(
            gather_done_box(2, &["a".to_string(), "b".to_string()])["message"],
            "Gathered 2 images"
        );
        assert_eq!(
            gather_done_box(2, &["a".to_string(), "b".to_string()])["detail"],
            "a\nb"
        );
    }

    #[test]
    fn menu_builder_boxes_show_every_button() {
        use crate::message_box::shows_every_button;
        assert!(shows_every_button(&about_box("2.2.1")));
        assert!(shows_every_button(&gather_save_first_box()));
        assert!(shows_every_button(&gather_confirm_box()));
        assert!(shows_every_button(&gather_nothing_box()));
        assert!(shows_every_button(&gather_done_box(1, &["a".to_string()])));
    }

    /// A folder outside the document's, written as an absolute path the way
    /// the platform writes one.
    #[cfg(windows)]
    const EXT: &str = "C:\\ext";
    #[cfg(not(windows))]
    const EXT: &str = "/ext";

    /// The document's folder, written as an absolute path the way the
    /// platform writes one.
    #[cfg(windows)]
    const DOCS: &str = "C:\\docs";
    #[cfg(not(windows))]
    const DOCS: &str = "/docs";

    /// `EXT` written as a file URL.
    #[cfg(windows)]
    const EXT_URL: &str = "file:///C:/ext";
    #[cfg(not(windows))]
    const EXT_URL: &str = "file:///ext";

    #[test]
    fn menu_builder_gather_copies_an_image_given_as_a_file_url() {
        let plan = gather_images(
            &format!("![cat]({EXT_URL}/cat.png)"),
            DOCS,
            |_path| false,
            |_a, _b| false,
            |_src, _dest| Ok(()),
        );
        assert_eq!(plan.changed_count, 1);
        assert_eq!(
            plan.copies,
            vec![(format!("{EXT}{SEP}cat.png"), format!("{DOCS}{SEP}cat.png"))]
        );
        assert!(plan.updated_markdown.contains("(cat.png)"));
    }

    #[test]
    fn menu_builder_gather_copies_with_a_collision_name() {
        let source = format!("{EXT}{SEP}cat.png");
        let plan = gather_images(
            &format!("![cat]({source})"),
            DOCS,
            |path| path.eq_ignore_ascii_case(&format!("{DOCS}{SEP}cat.png")),
            |_a, _b| false,
            |_src, _dest| Ok(()),
        );
        assert_eq!(plan.changed_count, 1);
        assert_eq!(
            plan.copies,
            vec![(source.clone(), format!("{DOCS}{SEP}cat-2.png"))]
        );
        assert!(plan.updated_markdown.contains("(cat-2.png)"));
        assert_eq!(plan.details, vec![format!("{source} → cat-2.png")]);
    }

    #[test]
    fn menu_builder_gather_reuses_a_same_size_file() {
        let plan = gather_images(
            &format!("![cat]({EXT}{SEP}cat.png)"),
            DOCS,
            |path| path.eq_ignore_ascii_case(&format!("{DOCS}{SEP}cat.png")),
            |_a, _b| true,
            |_src, _dest| Ok(()),
        );
        assert_eq!(plan.changed_count, 1);
        assert!(plan.copies.is_empty());
        assert!(plan.updated_markdown.contains("(cat.png)"));
    }

    #[test]
    fn menu_builder_gather_skips_images_already_relative_to_the_document() {
        let plan = gather_images(
            "![cat](images/cat.png)",
            "C:\\docs",
            |_path| false,
            |_a, _b| false,
            |_src, _dest| Ok(()),
        );
        assert_eq!(plan.changed_count, 0);
        assert!(plan.copies.is_empty());
        assert_eq!(plan.updated_markdown, "![cat](images/cat.png)");
    }

    #[test]
    fn menu_builder_gather_normalizes_newlines_to_lf() {
        let markdown = "one\r\n![cat](C:\\ext\\cat.png)\rthree";
        let plan = gather_images(
            markdown,
            "C:\\docs",
            |_path| false,
            |_a, _b| false,
            |_src, _dest| Ok(()),
        );
        assert!(!plan.updated_markdown.contains('\r'));
        assert!(plan.updated_markdown.contains("one\n"));
    }

    #[test]
    fn menu_builder_gather_leaves_a_reference_whose_copy_failed() {
        let source = format!("{EXT}{SEP}cat.png");
        let markdown = format!("![cat]({source})");
        let plan = gather_images(
            &markdown,
            DOCS,
            |_path| false,
            |_a, _b| false,
            |_src, _dest| Err("access denied".to_string()),
        );
        assert_eq!(plan.changed_count, 0);
        assert!(plan.copies.is_empty());
        assert_eq!(plan.updated_markdown, markdown);
        assert_eq!(
            plan.details,
            vec![format!("Failed to copy {source}: access denied")]
        );
    }

    fn open_file(id: &str, label: &str, active: bool) -> OpenFile {
        OpenFile {
            id: id.to_string(),
            label: label.to_string(),
            active,
        }
    }

    fn keep(index: usize) -> ChildStep {
        ChildStep::Keep {
            position: index,
            old_index: index,
            new_index: index,
        }
    }

    #[test]
    fn menu_builder_keeps_every_child_of_an_unchanged_submenu() {
        let menu = build_file_menu(None, &[]);
        let steps = plan_children(children(&menu), children(&menu));
        assert_eq!(
            steps,
            (0..children(&menu).len()).map(keep).collect::<Vec<_>>()
        );
    }

    #[test]
    fn menu_builder_keeps_a_child_whose_label_or_check_changed() {
        let old = build_view_menu(&[open_file("t1", "a.md", true)]);
        let new = build_view_menu(&[open_file("t1", "b.md", false)]);
        let steps = plan_children(children(&old), children(&new));
        assert_eq!(steps, vec![keep(0), keep(1), keep(2), keep(3)]);
    }

    #[test]
    fn menu_builder_adds_only_the_entry_of_an_opened_file() {
        let old = build_view_menu(&[open_file("t1", "a.md", true)]);
        let new = build_view_menu(&[
            open_file("t1", "a.md", false),
            open_file("t2", "b.md", true),
        ]);
        let steps = plan_children(children(&old), children(&new));
        let added = ChildStep::Insert {
            position: 4,
            new_index: 4,
        };
        assert_eq!(steps, vec![keep(0), keep(1), keep(2), keep(3), added]);
    }

    #[test]
    fn menu_builder_removes_only_the_entry_of_a_closed_file() {
        let old = build_view_menu(&[
            open_file("t1", "a.md", false),
            open_file("t2", "b.md", true),
            open_file("t3", "c.md", false),
        ]);
        let new = build_view_menu(&[
            open_file("t1", "a.md", true),
            open_file("t3", "c.md", false),
        ]);
        let steps = plan_children(children(&old), children(&new));
        let removed = ChildStep::Remove { position: 4 };
        let moved_up = ChildStep::Keep {
            position: 4,
            old_index: 5,
            new_index: 4,
        };
        assert_eq!(
            steps,
            vec![keep(0), keep(1), keep(2), keep(3), removed, moved_up]
        );
    }

    #[test]
    fn menu_builder_adds_the_separator_and_entry_of_a_first_file() {
        let old = build_view_menu(&[]);
        let new = build_view_menu(&[open_file("t1", "a.md", true)]);
        let steps = plan_children(children(&old), children(&new));
        let separator = ChildStep::Insert {
            position: 2,
            new_index: 2,
        };
        let entry = ChildStep::Insert {
            position: 3,
            new_index: 3,
        };
        assert_eq!(steps, vec![keep(0), keep(1), separator, entry]);
    }

    #[test]
    fn menu_builder_rebuilds_a_child_whose_accelerator_changed() {
        let old = vec![item("Exit", "Alt+F4", "app:exit")];
        let new = vec![item("Exit", "Cmd+Q", "app:exit")];
        let rebuilt = ChildStep::Insert {
            position: 0,
            new_index: 0,
        };
        assert_eq!(
            plan_children(&old, &new),
            vec![rebuilt, ChildStep::Remove { position: 1 }]
        );
    }

    #[test]
    fn menu_builder_marks_an_access_letter_in_each_top_level_menu() {
        let menu = build_menu(None, &[], &[]);
        let top: Vec<&str> = menu
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["label"].as_str().unwrap())
            .collect();
        assert_eq!(top, vec!["&File", "&Edit", "&View", "&Help"]);
    }

    #[test]
    fn menu_builder_reads_the_access_letter_of_each_top_level_menu() {
        assert_eq!(
            top_level_letters(&build_menu(None, &[], &[])),
            vec!['f', 'e', 'v', 'h']
        );
    }

    #[test]
    fn menu_builder_reads_no_access_letter_from_an_escaped_ampersand() {
        assert_eq!(access_letter("&File"), Some('f'));
        assert_eq!(access_letter("Save && quit"), None);
        assert_eq!(access_letter("File"), None);
    }

    #[cfg(windows)]
    #[test]
    fn menu_builder_finds_the_item_registered_for_a_shortcut() {
        let mut items = HashMap::new();
        record_items(&build_menu(None, &[], &[]), &mut items);
        assert_eq!(
            find_registered(&items, "CmdOrCtrl+N").as_deref(),
            Some("file:new")
        );
        assert_eq!(
            find_registered(&items, "CmdOrCtrl+,").as_deref(),
            Some("edit:preferences")
        );
        assert_eq!(
            find_registered(&items, "Alt+F4").as_deref(),
            Some("app:exit")
        );
        assert_eq!(find_registered(&items, "CmdOrCtrl+Z"), None);
        assert_eq!(find_registered(&items, "CmdOrCtrl+Q"), None);
    }

    #[cfg(windows)]
    #[test]
    fn menu_builder_every_registered_shortcut_is_named_by_a_key() {
        let mut items = HashMap::new();
        let template = build_menu(
            Some("C:\\docs\\a.md"),
            &["C:\\docs\\a.md".to_string()],
            &[open_file("t1", "a.md", true)],
        );
        record_items(&template, &mut items);
        let named: Vec<String> = (0..256u32)
            .flat_map(|key| {
                (0..8u32).filter_map(move |mods| {
                    crate::webview_settings::shortcut_for_key(
                        key,
                        mods & 1 != 0,
                        mods & 2 != 0,
                        mods & 4 != 0,
                    )
                })
            })
            .collect();
        let registered: Vec<&str> = items
            .values()
            .filter(|info| info.registered)
            .filter_map(|info| info.accelerator.as_deref())
            .collect();
        assert_eq!(registered.len(), 11);
        for shortcut in registered {
            assert!(named.iter().any(|name| name == shortcut), "{shortcut}");
        }
    }
}
