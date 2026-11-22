//! Message box helpers: the
//! unsaved-changes button-to-action mapping, the response resolution
//! that falls back to the box's cancelId when the box is closed, the
//! box shown for a page's `alert` or `confirm`, and the dialog plugin's
//! buttons for a box and the button index for its answer.

use serde_json::{Value, json};
use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogResult};

/// The actions the unsaved-changes box's buttons map to, in order.
pub const CLOSE_ACTIONS: [&str; 3] = ["save", "discard", "cancel"];

/// The box shown when closing a window or a tab with unsaved
/// changes. Save falls back to Save As for a document with no file.
pub fn unsaved_changes_box() -> Value {
    json!({
        "type": "warning",
        "buttons": ["Save", "Discard", "Cancel"],
        "defaultId": 0,
        "cancelId": 2,
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

/// A box's button labels, in order.
#[cfg_attr(feature = "test-hooks", allow(dead_code))]
pub fn button_labels(options: &Value) -> Vec<String> {
    options
        .get("buttons")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|button| button.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The dialog plugin's buttons for a box's labels, in the box's order.
/// The plugin shows at most three, so every box the app shows must have
/// three or fewer, which `shows_every_button` checks.
#[cfg_attr(feature = "test-hooks", allow(dead_code))]
pub fn dialog_buttons(labels: &[String]) -> MessageDialogButtons {
    match labels {
        [] => MessageDialogButtons::Ok,
        [ok] => MessageDialogButtons::OkCustom(ok.clone()),
        [ok, cancel] => MessageDialogButtons::OkCancelCustom(ok.clone(), cancel.clone()),
        [yes, no, cancel, ..] => {
            MessageDialogButtons::YesNoCancelCustom(yes.clone(), no.clone(), cancel.clone())
        }
    }
}

/// The index of the button chosen in a box with these labels: the
/// clicked label's place, or the box's cancelId when it was closed.
#[cfg_attr(feature = "test-hooks", allow(dead_code))]
pub fn chosen_button(labels: &[String], result: &MessageDialogResult, cancel_id: usize) -> usize {
    match result {
        MessageDialogResult::Custom(label) => labels
            .iter()
            .position(|button| button == label)
            .unwrap_or(cancel_id),
        MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
        MessageDialogResult::No => 1,
        MessageDialogResult::Cancel => cancel_id,
    }
}

/// Whether the real dialog shows every one of a box's buttons.
#[cfg(test)]
pub fn shows_every_button(options: &Value) -> bool {
    let labels = button_labels(options);
    let shown = match dialog_buttons(&labels) {
        MessageDialogButtons::OkCustom(ok) => vec![ok],
        MessageDialogButtons::OkCancelCustom(ok, cancel) => vec![ok, cancel],
        MessageDialogButtons::YesNoCancelCustom(yes, no, cancel) => vec![yes, no, cancel],
        _ => vec!["OK".to_string()],
    };
    shown == labels
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
        assert_eq!(close_action(1), "discard");
        assert_eq!(close_action(2), "cancel");
        assert_eq!(close_action(7), "cancel");
    }

    #[test]
    fn message_box_offers_save_discard_and_cancel_when_closing() {
        let unsaved = unsaved_changes_box();
        assert_eq!(unsaved["buttons"], json!(["Save", "Discard", "Cancel"]));
        assert_eq!(unsaved["defaultId"], 0);
        assert_eq!(unsaved["cancelId"], 2);
    }

    #[test]
    fn message_box_shows_every_button_of_every_box() {
        assert!(shows_every_button(&unsaved_changes_box()));
        assert!(shows_every_button(&export_replace_box("notes.html")));
        assert!(shows_every_button(&script_dialog_box(
            "Markdown Editor",
            "Saved.",
            false
        )));
        assert!(shows_every_button(&script_dialog_box(
            "Markdown Editor",
            "Continue?",
            true
        )));
    }

    #[test]
    fn message_box_does_not_show_a_fourth_button() {
        assert!(!shows_every_button(
            &json!({ "buttons": ["A", "B", "C", "D"] })
        ));
    }

    #[test]
    fn message_box_maps_the_clicked_label_to_its_button() {
        let labels: Vec<String> = button_labels(&unsaved_changes_box());
        let clicked = |label: &str| MessageDialogResult::Custom(label.to_string());
        assert_eq!(chosen_button(&labels, &clicked("Save"), 2), 0);
        assert_eq!(chosen_button(&labels, &clicked("Discard"), 2), 1);
        assert_eq!(chosen_button(&labels, &clicked("Cancel"), 2), 2);
        assert_eq!(chosen_button(&labels, &clicked("Elsewhere"), 2), 2);
        assert_eq!(chosen_button(&labels, &MessageDialogResult::Cancel, 2), 2);
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
