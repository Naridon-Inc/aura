//! Aura's own slash commands, run as ACP turns.
//!
//! Each turn runs on its own thread and streams what it does: a tool call
//! the client can show as "in progress", the command's output as message
//! chunks, the tool call's end, then the prompt response. Because the turn
//! is off the reading thread, the `session/cancel` that names it is read
//! while it runs and answered at once with `stopReason: "cancelled"`; the
//! command's late output is then dropped, never sent after the turn ended.

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

use super::{chunk_frame, result_frames, run_verb, split_verb, write_frame};
use crate::acp_proxy::lock;

/// The client's stdout, shared with whatever else writes frames to it.
pub(crate) type Out = Arc<Mutex<dyn Write + Send>>;

/// The commands Aura answers itself: name, description, input hint.
pub(crate) const COMMANDS: [(&str, &str, Option<&str>); 3] = [
    ("prove", "Check that a user-facing behaviour is actually wired up in this code", Some("the behaviour, e.g. User can log in")),
    ("review", "Semantic review of this branch: deletions, layer violations, drift", Some("base branch (default main)")),
    ("impacts", "Changes on other branches that break code this branch depends on", None),
];

/// A `session/update` advertising Aura's commands, then `engine`'s own
/// (minus any Aura's names already take).
pub(crate) fn available_commands(session_id: &str, engine: &[Value]) -> Value {
    let mut list: Vec<Value> = COMMANDS
        .iter()
        .map(|(name, description, hint)| {
            let mut c = json!({ "name": name, "description": description });
            if let Some(hint) = hint {
                c["input"] = json!({ "hint": hint });
            }
            c
        })
        .collect();
    for c in engine {
        let name = c.get("name").and_then(Value::as_str).unwrap_or("");
        if !name.is_empty() && !COMMANDS.iter().any(|(own, _, _)| *own == name) {
            list.push(c.clone());
        }
    }
    json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": { "sessionUpdate": "available_commands_update", "availableCommands": list }
        }
    })
}

/// `"/prove x"` → `Some(("prove", "x"))`, for Aura's own commands only.
/// With an engine behind Aura, anything else — `/help` included — is the
/// engine's to answer.
pub(crate) fn own_command(text: &str) -> Option<(String, String)> {
    let text = text.trim();
    if !text.starts_with('/') {
        return None;
    }
    let (verb, rest) = split_verb(text);
    COMMANDS.iter().any(|(name, _, _)| *name == verb).then_some((verb, rest))
}

const RUNNING: u8 = 0;
const FINISHED: u8 = 1;
const CANCELLED: u8 = 2;

struct Running {
    id: Value,
    call: Option<String>,
    state: Arc<AtomicU8>,
}

/// What runs a verb: [`run_verb`] in the binary, a stand-in under test.
type Runner = Arc<dyn Fn(&str, &str) -> Value + Send + Sync>;

/// Local turns in flight, one per session at most (ACP allows one prompt
/// per session at a time).
#[derive(Clone)]
pub(crate) struct LocalTurns {
    out: Out,
    running: Arc<Mutex<HashMap<String, Running>>>,
    run: Runner,
}

impl LocalTurns {
    pub(crate) fn new(out: Out) -> Self {
        Self::with_runner(out, Arc::new(run_verb))
    }

    pub(crate) fn with_runner(out: Out, run: Runner) -> Self {
        Self { out, running: Arc::new(Mutex::new(HashMap::new())), run }
    }

    pub(crate) fn is_running(&self, session_id: &str) -> bool {
        lock(&self.running).contains_key(session_id)
    }

    /// Run the prompt `text` as request `id` on `session_id`.
    pub(crate) fn start(&self, id: Value, session_id: String, text: String) {
        let (verb, rest) = split_verb(&text);
        // Only a command that does work gets a tool call; help and "that
        // needs an argument" are just said.
        let works = match verb.as_str() {
            "prove" => !rest.is_empty(),
            "review" | "impacts" => true,
            _ => false,
        };
        let call = works.then(|| format!("aura-{verb}-{}", uuid::Uuid::new_v4()));
        let state = Arc::new(AtomicU8::new(RUNNING));
        lock(&self.running).insert(
            session_id.clone(),
            Running { id: id.clone(), call: call.clone(), state: state.clone() },
        );

        // Said before the worker starts, so a cancel read straight after the
        // prompt always ends a tool call the client has already seen.
        if let Some(call) = &call {
            self.emit(&tool_call(&session_id, call, &verb, &rest));
        }
        let this = self.clone();
        thread::spawn(move || {
            let result = (this.run)(&verb, &rest);
            if state.compare_exchange(RUNNING, FINISHED, Ordering::SeqCst, Ordering::SeqCst).is_err() {
                return; // cancelled: the turn was already answered
            }
            let failed = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
            let mut frames = result_frames(&session_id, &result);
            if frames.is_empty() {
                frames.push(chunk_frame(&session_id, "(nothing to report)"));
            }
            for f in &frames {
                this.emit(f);
            }
            if let Some(call) = &call {
                this.emit(&call_done(&session_id, call, if failed { "failed" } else { "completed" }));
            }
            this.finish(&session_id, &state);
            this.emit(&json!({ "jsonrpc": "2.0", "id": id, "result": { "stopReason": "end_turn" } }));
        });
    }

    /// Stop the local turn on `session_id`, if there is one. Returns whether
    /// there was.
    pub(crate) fn cancel(&self, session_id: &str) -> bool {
        let Some(turn) = lock(&self.running).remove(session_id) else {
            return false;
        };
        if turn.state.compare_exchange(RUNNING, CANCELLED, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            if let Some(call) = &turn.call {
                self.emit(&call_done(session_id, call, "failed"));
            }
            self.emit(&json!({ "jsonrpc": "2.0", "id": turn.id, "result": { "stopReason": "cancelled" } }));
        }
        true
    }

    fn finish(&self, session_id: &str, state: &Arc<AtomicU8>) {
        let mut running = lock(&self.running);
        if running.get(session_id).is_some_and(|r| Arc::ptr_eq(&r.state, state)) {
            running.remove(session_id);
        }
    }

    fn emit(&self, frame: &Value) {
        write_frame(&mut *lock(&self.out), frame);
    }
}

fn tool_call(session_id: &str, call: &str, verb: &str, rest: &str) -> Value {
    let title = match verb {
        "prove" => format!("Proving: {rest}"),
        "review" => format!("Reviewing against {}", if rest.is_empty() { "main" } else { rest }),
        _ => "Checking cross-branch impacts".to_string(),
    };
    json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": call,
                "title": title,
                "kind": if verb == "prove" { "think" } else { "search" },
                "status": "in_progress"
            }
        }
    })
}

fn call_done(session_id: &str, call: &str, status: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": { "sessionUpdate": "tool_call_update", "toolCallId": call, "status": status }
        }
    })
}
