//! Backend-to-page messaging: events sent to the page, and script
//! evaluated in it.
//!
//! Tauri's JS `listen` registers asynchronously, so events and eval calls
//! made before the bridge reports ready for the current page are held here
//! and flushed, in order, once it does. The ready flag resets on every
//! page load. Each eval is keyed by an id; the page posts the resolved
//! value back and the matching pending call is resolved, and any calls
//! still pending when the page unloads are rejected.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;
use tauri::WebviewWindow;

/// Callback invoked with an eval's result (or an error).
type ReplyCallback = Box<dyn FnOnce(Result<Value, String>) + Send>;

/// Holds the readiness flag, the buffered events and evals, and the
/// pending eval callbacks for one window.
pub struct WebContents {
    ready: bool,
    queued_emits: Vec<(String, Value)>,
    queued_evals: Vec<(u64, String)>,
    pending: HashMap<u64, ReplyCallback>,
    next_id: u64,
}

impl WebContents {
    /// Creates an empty, not-yet-ready web contents.
    pub fn new() -> Self {
        Self {
            ready: false,
            queued_emits: Vec::new(),
            queued_evals: Vec::new(),
            pending: HashMap::new(),
            next_id: 1,
        }
    }

    /// Marks the bridge ready and returns the buffered emits and evals to
    /// run now, in the order they were requested.
    pub fn set_ready(&mut self) -> (Vec<(String, Value)>, Vec<(u64, String)>) {
        self.ready = true;
        (
            std::mem::take(&mut self.queued_emits),
            std::mem::take(&mut self.queued_evals),
        )
    }

    /// Emits an event now when ready, or queues it until then.
    pub fn send(&mut self, event: &str, payload: Value) -> Option<(String, Value)> {
        if self.ready {
            Some((event.to_string(), payload))
        } else {
            self.queued_emits.push((event.to_string(), payload));
            None
        }
    }

    /// Registers a pending eval, returning its id and, when ready, the
    /// code to evaluate now.
    pub fn eval(&mut self, code: &str, callback: ReplyCallback) -> (u64, Option<(u64, String)>) {
        let id = self.next_id;
        self.next_id += 1;
        self.pending.insert(id, callback);
        if self.ready {
            (id, Some((id, code.to_string())))
        } else {
            self.queued_evals.push((id, code.to_string()));
            (id, None)
        }
    }

    /// Resolves a pending eval by id.
    pub fn resolve(&mut self, id: u64, result: Result<Value, String>) {
        if let Some(callback) = self.pending.remove(&id) {
            callback(result);
        }
    }

    /// Rejects every pending eval and clears the queues when the page
    /// unloads.
    pub fn on_unload(&mut self) {
        self.ready = false;
        self.queued_emits.clear();
        self.queued_evals.clear();
        for (_, callback) in self.pending.drain() {
            callback(Err("page unloaded".to_string()));
        }
    }
}

/// JSON-encodes a string for safe embedding in evaluated code.
pub fn js_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// Wraps code so the page evaluates it, awaits its value and posts the
/// outcome back through the `web_contents_reply` command under `id`.
pub fn wrap_eval(id: u64, code: &str) -> String {
    format!(
        "(async () => {{ const reply = (result) => window.__TAURI_INTERNALS__.invoke(\"web_contents_reply\", {{ id: {id}, result }}); try {{ const value = await ({code}); reply({{ ok: true, value: value === undefined ? null : value }}); }} catch (error) {{ reply({{ ok: false, error: String(error) }}); }} }})();"
    )
}

/// Evaluates code in the page and waits for its resolved value; the call is held until the bridge
/// is ready and rejected if the page unloads first. It blocks the calling
/// thread, so it must not run on the main thread, which delivers the
/// page's reply.
pub fn execute_javascript(
    window: &WebviewWindow,
    state: &Mutex<WebContents>,
    code: &str,
) -> Result<Value, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let callback: ReplyCallback = Box::new(move |result| {
        let _ = sender.send(result);
    });
    let (_id, now) = state
        .lock()
        .expect("web contents lock")
        .eval(code, callback);
    if let Some((id, code)) = now {
        if let Err(error) = window.eval(wrap_eval(id, &code)) {
            state
                .lock()
                .expect("web contents lock")
                .resolve(id, Err(error.to_string()));
        }
    }
    receiver
        .recv()
        .unwrap_or_else(|_| Err("page unloaded".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::mpsc;

    fn recorder() -> (ReplyCallback, mpsc::Receiver<Result<Value, String>>) {
        let (tx, rx) = mpsc::channel();
        let callback: ReplyCallback = Box::new(move |result| {
            let _ = tx.send(result);
        });
        (callback, rx)
    }

    #[test]
    fn holds_messages_and_calls_until_ready_and_flushes_in_order() {
        let mut wc = WebContents::new();
        assert!(
            wc.send("menu:action", json!({ "action": "first" }))
                .is_none()
        );
        let (cb, _rx) = recorder();
        let (_id, now) = wc.eval("code-a", cb);
        assert!(now.is_none());
        assert!(
            wc.send("menu:action", json!({ "action": "second" }))
                .is_none()
        );

        let (emits, evals) = wc.set_ready();
        assert_eq!(emits[0].1["action"], "first");
        assert_eq!(emits[1].1["action"], "second");
        assert_eq!(evals.len(), 1);
        assert_eq!(evals[0].1, "code-a");

        // Once ready, a send is returned immediately rather than queued.
        assert!(
            wc.send("menu:action", json!({ "action": "third" }))
                .is_some()
        );
    }

    #[test]
    fn resolves_replies_by_id() {
        let mut wc = WebContents::new();
        wc.set_ready();
        let (cb1, rx1) = recorder();
        let (cb2, rx2) = recorder();
        let (id1, _) = wc.eval("a", cb1);
        let (id2, _) = wc.eval("b", cb2);
        assert_ne!(id1, id2);
        wc.resolve(id2, Ok(json!("two")));
        wc.resolve(id1, Ok(json!("one")));
        assert_eq!(rx1.recv().unwrap(), Ok(json!("one")));
        assert_eq!(rx2.recv().unwrap(), Ok(json!("two")));
    }

    #[test]
    fn rejects_pending_calls_on_unload() {
        let mut wc = WebContents::new();
        wc.set_ready();
        let (cb, rx) = recorder();
        wc.eval("a", cb);
        wc.on_unload();
        assert!(rx.recv().unwrap().is_err());
    }

    #[test]
    fn json_encodes_strings_for_eval() {
        assert_eq!(js_string("plain"), "\"plain\"");
        assert_eq!(js_string("a\"b"), "\"a\\\"b\"");
        assert_eq!(js_string("line\nbreak"), "\"line\\nbreak\"");
    }
}
