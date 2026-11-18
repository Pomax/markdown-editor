//! Message box helpers: the
//! unsaved-changes button-to-action mapping, the response resolution
//! that falls back to the box's cancelId when the box is closed, and the
//! box shown for a page's `alert` or `confirm`.

use serde_json::{Value, json};

/// The actions the unsaved-changes box's buttons map to, in order.
pub const CLOSE_ACTIONS: [&str; 4] = ["save", "saveAs", "discard", "cancel"];

/// The box shown when closing a window or a tab with unsaved
/// changes.
pub fn unsaved_changes_box() -> Value {
    json!({
        "type": "warning",
        "buttons": ["Save", "Save As...", "Discard", "Cancel"],
        "defaultId": 0,
        "cancelId": 3,
        "title": "Unsaved Changes",
        "message": "You have unsaved changes. What would you like to do?"
    })
}

/// The action for a response index from the unsaved-changes box, falling
/// back to cancel for an out-of-range index.
pub fn close_action(response: usize) -> &'static str {
    CLOSE_ACTIONS.get(response).copied().unwrap_or("cancel")
}

/// The box asking whether File > Export > HTML may replace the HTML file
/// of that name, Replace being the default.
pub fn export_replace_box(file_name: &str) -> Value {
    json!({
        "type": "warning",
        "title": "Export HTML",
        "message": format!("{file_name} already exists. Do you want to replace it?"),
        "buttons": ["Replace", "Cancel"],
        "defaultId": 0,
        "cancelId": 1
    })
}

/// Whether the export's replace box was answered with Replace.
pub fn export_replaces(response: usize) -> bool {
    response == 0
}

/// The response for a message box: the stubbed answer, or the box's
/// cancelId when none is set, since closing a box returns its cancelId.
#[cfg_attr(not(feature = "test-hooks"), allow(dead_code))]
pub fn resolve_response(stub: Option<usize>, cancel_id: usize) -> usize {
    stub.unwrap_or(cancel_id)
}

/// The message box shown for a page's `alert` or `confirm`: the
/// page's text with OK, or with OK and Cancel, OK being the default.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub fn script_dialog_box(title: &str, message: &str, confirm: bool) -> Value {
    let buttons = if confirm {
        json!(["OK", "Cancel"])
    } else {
        json!(["OK"])
    };
    json!({
        "type": "none",
        "title": title,
        "message": message,
        "buttons": buttons,
        "defaultId": 0,
        "cancelId": if confirm { 1 } else { 0 }
    })
}

/// Whether the box for a page's `alert` or `confirm` was answered with OK.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub fn script_dialog_accepted(response: usize) -> bool {
    response == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_box_maps_the_close_buttons_to_actions() {
        assert_eq!(close_action(0), "save");
        assert_eq!(close_action(1), "saveAs");
        assert_eq!(close_action(2), "discard");
        assert_eq!(close_action(3), "cancel");
        assert_eq!(close_action(7), "cancel");
    }

    #[test]
    fn message_box_resolves_to_the_cancel_id_when_closed() {
        assert_eq!(resolve_response(Some(2), 3), 2);
        assert_eq!(resolve_response(None, 3), 3);
    }

    #[test]
    fn message_box_shows_an_alert_with_ok() {
        assert_eq!(
            script_dialog_box("Markdown Editor", "Saved.", false),
            json!({
                "type": "none",
                "title": "Markdown Editor",
                "message": "Saved.",
                "buttons": ["OK"],
                "defaultId": 0,
                "cancelId": 0
            })
        );
    }

    #[test]
    fn message_box_shows_a_confirm_with_ok_and_cancel() {
        assert_eq!(
            script_dialog_box("Markdown Editor", "Continue?", true),
            json!({
                "type": "none",
                "title": "Markdown Editor",
                "message": "Continue?",
                "buttons": ["OK", "Cancel"],
                "defaultId": 0,
                "cancelId": 1
            })
        );
    }

    #[test]
    fn message_box_accepts_a_page_dialog_only_on_ok() {
        assert!(script_dialog_accepted(0));
        assert!(!script_dialog_accepted(1));
    }
}
