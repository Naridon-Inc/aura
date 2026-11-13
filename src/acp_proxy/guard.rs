//! What the proxy does with one frame.
//!
//! Pure bookkeeping: every side effect (a snapshot, an intent row, a gate
//! verdict) goes through [`Effects`], so each rule here is tested without a
//! process. A frame the guard has nothing to say about is passed on exactly
//! as it was read.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use super::effects::{Effects, Gate, GateQuery, Turn, WriteAt};

/// A line the proxy itself sends, and to which side.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum To {
    Client(String),
    Agent(String),
}

/// What to do with one frame.
#[derive(Debug, PartialEq)]
pub(crate) struct Step {
    /// Forward the frame, byte for byte, to the other side.
    pub pass: bool,
    /// Lines the proxy sends of its own accord, after the frame.
    pub extra: Vec<To>,
}

impl Step {
    fn pass() -> Self {
        Self { pass: true, extra: Vec::new() }
    }
}

/// Tool-call kinds that change files on disk.
const WRITE_KINDS: [&str; 3] = ["edit", "delete", "move"];

pub(crate) struct Guard<E> {
    effects: E,
    /// Working directory of each session, from `session/new` / `session/load`.
    cwd: HashMap<String, String>,
    /// `session/new` requests still waiting for their session id.
    opening: HashMap<String, String>,
    /// `session/prompt` requests in flight, by request id.
    turns: HashMap<String, Turn>,
    /// The prompt in flight on each session.
    active: HashMap<String, String>,
    /// The kind each tool call announced, so an update that leaves it out
    /// still counts as the write it is.
    kinds: HashMap<String, String>,
    /// (tool call, path) pairs already snapshotted this turn.
    snapped: HashSet<(String, String)>,
    /// Paths snapshotted for a tool call whose write has not arrived yet.
    /// The `fs/write_text_file` that carries it out finds the old content
    /// already kept, and does not keep it twice.
    awaiting: HashSet<String>,
}

impl<E: Effects> Guard<E> {
    pub(crate) fn new(effects: E) -> Self {
        Self {
            effects,
            cwd: HashMap::new(),
            opening: HashMap::new(),
            turns: HashMap::new(),
            active: HashMap::new(),
            kinds: HashMap::new(),
            snapped: HashSet::new(),
            awaiting: HashSet::new(),
        }
    }

    /// A frame the client sent toward the agent.
    pub(crate) fn from_client(&mut self, frame: &str) -> Step {
        let Ok(msg) = serde_json::from_str::<Value>(frame.trim()) else {
            return Step::pass();
        };
        let (Some(id), Some(method)) = (msg.get("id"), msg.get("method").and_then(Value::as_str))
        else {
            return Step::pass();
        };
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        match method {
            "session/new" => {
                self.opening.insert(key(id), text(&params, "cwd"));
            }
            "session/load" => {
                let sid = text(&params, "sessionId");
                if !sid.is_empty() {
                    self.cwd.insert(sid, text(&params, "cwd"));
                }
            }
            "session/prompt" => {
                let sid = text(&params, "sessionId");
                let turn = Turn {
                    session_id: sid.clone(),
                    cwd: self.cwd.get(&sid).cloned().unwrap_or_default(),
                    prompt: prompt_text(&params),
                    writes: Vec::new(),
                };
                self.turns.insert(key(id), turn);
                self.active.insert(sid, key(id));
            }
            _ => {}
        }
        Step::pass()
    }

    /// A frame the agent sent toward the client.
    pub(crate) fn from_agent(&mut self, frame: &str) -> Step {
        let Ok(msg) = serde_json::from_str::<Value>(frame.trim()) else {
            return Step::pass();
        };
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        match (msg.get("method").and_then(Value::as_str), msg.get("id")) {
            (Some("fs/write_text_file"), _) => {
                let path = text(&params, "path");
                if !path.is_empty() {
                    self.before_write(&text(&params, "sessionId"), None, &path, true);
                }
                Step::pass()
            }
            (Some("session/update"), None) => {
                self.on_update(&params);
                Step::pass()
            }
            (Some("session/request_permission"), Some(id)) => self.on_permission(id, &params),
            (Some(_), _) => Step::pass(),
            (None, Some(id)) => {
                self.on_response(id, &msg);
                Step::pass()
            }
            (None, None) => Step::pass(),
        }
    }

    fn on_update(&mut self, params: &Value) {
        let update = params.get("update").cloned().unwrap_or(Value::Null);
        let kind_of_update = text(&update, "sessionUpdate");
        if kind_of_update != "tool_call" && kind_of_update != "tool_call_update" {
            return;
        }
        let call = text(&update, "toolCallId");
        if let Some(kind) = update.get("kind").and_then(Value::as_str) {
            self.kinds.insert(call.clone(), kind.to_string());
        }
        if !self.is_write(&call, &update) {
            return;
        }
        // A call reported finished has already written: what is on disk is
        // the new content, so snapshotting it would label the result as the
        // state before. The write is still counted for the turn's intent.
        let status = text(&update, "status");
        let before = !matches!(status.as_str(), "completed" | "failed");
        let sid = text(params, "sessionId");
        for path in locations(&update) {
            self.before_write(&sid, Some(&call), &path, before);
        }
    }

    fn on_permission(&mut self, id: &Value, params: &Value) -> Step {
        let call = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let call_id = text(&call, "toolCallId");
        if let Some(kind) = call.get("kind").and_then(Value::as_str) {
            self.kinds.insert(call_id.clone(), kind.to_string());
        }
        let sid = text(params, "sessionId");
        let kind = self.kinds.get(&call_id).cloned().unwrap_or_default();
        let cwd = self.cwd.get(&sid).cloned().filter(|c| !c.is_empty());
        let (tool, input) = tool_for(&call, &kind, cwd.as_deref());

        if let Gate::Deny { title, reason } = self.effects.gate(&GateQuery { tool, input, cwd }) {
            let notice = format!("\n\n> **Aura blocked this step — {title}.** {reason}\n\n");
            let to_client = json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": sid,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": notice }
                    }
                }
            });
            let to_agent = json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": refusal(params) } });
            return Step {
                pass: false,
                extra: vec![To::Client(to_client.to_string()), To::Agent(to_agent.to_string())],
            };
        }

        // Asking means the call has not run yet: this is the last moment
        // the files it names still hold what they held before it.
        if self.is_write(&call_id, &call) {
            for path in locations(&call) {
                self.before_write(&sid, Some(&call_id), &path, true);
            }
        }
        Step::pass()
    }

    fn on_response(&mut self, id: &Value, msg: &Value) {
        let k = key(id);
        if let Some(cwd) = self.opening.remove(&k) {
            if let Some(sid) = msg.pointer("/result/sessionId").and_then(Value::as_str) {
                self.cwd.insert(sid.to_string(), cwd);
            }
        }
        let Some(turn) = self.turns.remove(&k) else { return };
        if self.active.get(&turn.session_id) == Some(&k) {
            self.active.remove(&turn.session_id);
        }
        if self.turns.is_empty() {
            self.snapped.clear();
            self.kinds.clear();
            self.awaiting.clear();
        }
        if turn.writes.is_empty() {
            return;
        }
        let stop = msg
            .pointer("/result/stopReason")
            .and_then(Value::as_str)
            .unwrap_or(if msg.get("error").is_some() { "error" } else { "end_turn" });
        self.effects.log_turn(&turn, stop);
    }

    fn is_write(&self, call_id: &str, call: &Value) -> bool {
        let kind = call
            .get("kind")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| self.kinds.get(call_id).cloned())
            .unwrap_or_default();
        WRITE_KINDS.contains(&kind.as_str())
    }

    /// Count `path` as written this turn, snapshotting it first when its
    /// content is still the content from before the write.
    fn before_write(&mut self, sid: &str, call: Option<&str>, path: &str, snapshot: bool) {
        match call {
            Some(call) => {
                if !self.snapped.insert((call.to_string(), path.to_string())) {
                    return;
                }
            }
            // The write a tool call announced: its old content is kept.
            None if self.awaiting.remove(path) => return,
            None => {}
        }
        if call.is_some() && snapshot {
            self.awaiting.insert(path.to_string());
        }
        let turn = self.active.get(sid).and_then(|k| self.turns.get(k));
        let prompt = turn.map(|t| t.prompt.clone()).unwrap_or_default();
        let cwd = self.cwd.get(sid).cloned().unwrap_or_default();
        if snapshot {
            let why = why_for(&prompt);
            self.effects.snapshot(&WriteAt { path, why: &why, session: sid, cwd: &cwd });
        }
        if let Some(turn) = self.active.get(sid).and_then(|k| self.turns.get_mut(k)) {
            if !turn.writes.iter().any(|w| w == path) {
                turn.writes.push(path.to_string());
            }
        }
    }
}

/// Map an ACP tool call onto the tool name and input the gate classifies,
/// so a `delete` here meets the same rules as a hook-reported `rm`.
pub(crate) fn tool_for(call: &Value, kind: &str, cwd: Option<&str>) -> (String, Value) {
    let mut input = call
        .get("rawInput")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let paths: Vec<String> = locations(call).into_iter().map(|p| relative(&p, cwd)).collect();
    let name = match kind {
        "delete" => "delete_file",
        "execute" => "bash",
        "move" => {
            if input.get("command").is_none() && paths.len() >= 2 {
                input["command"] = json!(format!("mv {} {}", paths[0], paths[1]));
            }
            "bash"
        }
        "edit" => {
            let whole = input.get("content").is_some()
                && input.get("old_string").is_none()
                && input.get("oldText").is_none();
            if whole { "write" } else { "edit" }
        }
        "read" => "read",
        "search" => "search",
        "fetch" => "web_fetch",
        "think" => "think",
        _ => "acp_tool",
    };
    if let Some(first) = paths.first() {
        if crate::tool_normalize::first_path_field(&input).is_none() {
            input["file_path"] = json!(first);
        }
    }
    (name.to_string(), input)
}

/// The option that says no: rejecting once, then always, and when the agent
/// offered neither, cancelling — never an option that allows.
fn refusal(params: &Value) -> Value {
    let options = params.get("options").and_then(Value::as_array).cloned().unwrap_or_default();
    for kind in ["reject_once", "reject_always"] {
        if let Some(id) = options
            .iter()
            .find(|o| o.get("kind").and_then(Value::as_str) == Some(kind))
            .and_then(|o| o.get("optionId"))
        {
            return json!({ "outcome": "selected", "optionId": id });
        }
    }
    json!({ "outcome": "cancelled" })
}

fn why_for(prompt: &str) -> String {
    let p = one_line(prompt, 160);
    if p.is_empty() {
        "edited by an ACP agent through aura acp-proxy".to_string()
    } else {
        format!("asked: {p}")
    }
}

pub(crate) fn one_line(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let cut: String = flat.chars().take(max).collect();
    format!("{cut}…")
}

fn relative(path: &str, cwd: Option<&str>) -> String {
    let Some(root) = cwd else { return path.to_string() };
    let root = crate::validate_tool::resolve_repo_root(Some(root));
    std::path::Path::new(path)
        .strip_prefix(&root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string())
}

fn locations(v: &Value) -> Vec<String> {
    v.get("locations")
        .and_then(Value::as_array)
        .map(|ls| {
            ls.iter()
                .filter_map(|l| l.get("path").and_then(Value::as_str))
                .filter(|p| !p.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn prompt_text(params: &Value) -> String {
    params
        .get("prompt")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn text(v: &Value, field: &str) -> String {
    v.get(field).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// Request ids may be numbers or strings; their JSON spelling keys both.
fn key(id: &Value) -> String {
    id.to_string()
}
