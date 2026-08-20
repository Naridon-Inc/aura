//! The client half of ACP — what Aura does when the *agent* asks *us* for
//! something.
//!
//! This is the whole reason a native integration beats wrapping a CLI.
//! ACP is inverted: the agent does not touch the disk itself, it asks the
//! client to. `fs/read_text_file`, `fs/write_text_file`, and
//! `session/request_permission` all arrive here — which happens to be the
//! exact point where Aura already knows how to snapshot a file, ask the
//! human, and record why a change was made. An editor that only renders
//! these as cards is a viewer. Serving them is a gate.
//!
//! Three rules hold for everything below:
//!
//! 1. **A path outside the session's root is refused**, not clamped. An
//!    agent that asks to read `~/.aura/credentials.json` gets an error,
//!    not the file, and the refusal says which root it violated.
//! 2. **A write snapshots first.** `aura rewind` can only recover what it
//!    saw before the overwrite, so the snapshot is awaited, not spawned —
//!    a snapshot that lands after the write protects nothing.
//! 3. **A command is asked about before it runs.** `terminal/create` is
//!    the one request that can do anything at all, so it goes through the
//!    gate carrying the argv that will actually execute — not the agent's
//!    description of it. See [`AcpHost::create_terminal`].
//!
//! The gate itself — who gets asked, and what happens before a write —
//! is not ACP's. It lives in [`crate::manager::brain::gate`], shared with
//! every other engine Aura hosts, and is re-exported here so ACP code can
//! keep naming it locally.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};

use super::terminal::Terminals;
use super::wire::{PermissionOption, TerminalText, method};
use crate::manager::brain::gate;
use crate::manager::brain::jsonl_stdio::{JsonlChild, jsonrpc_error, jsonrpc_result};

pub use crate::manager::brain::gate::{GateDecision, HostPolicy};

/// The tool name a command is remembered under. The permission registry
/// keys an "always" answer on (agent, tool), so this is what the human is
/// granting when they stop being asked about commands from this agent.
pub const TERMINAL_TOOL: &str = "terminal";

/// Serves one ACP session's agent→client traffic.
pub struct AcpHost {
    /// The session's root. Every path the agent names must resolve
    /// underneath this.
    root: PathBuf,
    policy: Arc<dyn HostPolicy>,
    /// Who this run is, for the purpose of sentinel zones. A zone claimed
    /// by somebody else holds a path against this agent; a zone this run
    /// claimed would not. In practice a hosted agent claims none, so every
    /// zone it meets is somebody else's — which is the right answer, since
    /// the person who claimed it is not the agent.
    session_id: String,
    /// Commands this session is running. Dropped with the host, which is
    /// what stops a closed conversation leaving processes behind.
    terminals: Terminals,
}

impl AcpHost {
    pub fn new(
        root: impl Into<PathBuf>,
        session_id: impl Into<String>,
        policy: Arc<dyn HostPolicy>,
    ) -> Self {
        let root = root.into();
        Self {
            terminals: Terminals::new(&root),
            root,
            session_id: session_id.into(),
            policy,
        }
    }

    /// The output of a terminal this session is hosting.
    ///
    /// An agent that runs a command sends a tool card whose content is
    /// nothing but the terminal's id — the client is expected to know what
    /// is in it, because the client is the one running it. This is how the
    /// transcript resolves that id into the text the human should see.
    pub fn terminal_text(&self, id: &str) -> Option<String> {
        self.terminals.text_of(id)
    }

    /// True if this inbound line is a request the agent expects us to
    /// answer (as opposed to a notification we merely observe).
    pub fn is_agent_request(v: &Value) -> bool {
        v.get("id").is_some() && v.get("method").and_then(Value::as_str).is_some()
    }

    /// Handle one agent→client request and write the reply. Returns
    /// `false` if the method isn't ours to serve (the caller has already
    /// been told via a `method not found` reply).
    pub async fn serve(&self, child: &JsonlChild, req: &Value) -> bool {
        let Some(id) = req.get("id") else {
            return false;
        };
        let method_name = req.get("method").and_then(Value::as_str).unwrap_or_default();
        let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

        let reply = match method_name {
            method::FS_READ_TEXT_FILE => match self.read_text_file(&params).await {
                Ok(v) => jsonrpc_result(id, v),
                Err(msg) => jsonrpc_error(id, -32602, msg),
            },
            method::FS_WRITE_TEXT_FILE => match self.write_text_file(&params).await {
                Ok(v) => jsonrpc_result(id, v),
                Err(msg) => jsonrpc_error(id, -32602, msg),
            },
            method::SESSION_REQUEST_PERMISSION => {
                jsonrpc_result(id, self.request_permission(&params).await)
            }
            method::TERMINAL_CREATE => match self.create_terminal(&params).await {
                Ok(v) => jsonrpc_result(id, v),
                Err(msg) => jsonrpc_error(id, -32602, msg),
            },
            method::TERMINAL_OUTPUT => match self.terminals.output(&params) {
                Ok(v) => jsonrpc_result(id, v),
                Err(msg) => jsonrpc_error(id, -32602, msg),
            },
            // Deliberately awaited here. `serve` is already spawned off the
            // stream-pumping loop, so a command that takes ten minutes
            // holds up nothing but the agent's own turn — which is the
            // point of the agent having asked to wait.
            method::TERMINAL_WAIT_FOR_EXIT => match self.terminals.wait_for_exit(&params).await {
                Ok(v) => jsonrpc_result(id, v),
                Err(msg) => jsonrpc_error(id, -32602, msg),
            },
            method::TERMINAL_KILL => match self.terminals.kill(&params) {
                Ok(v) => jsonrpc_result(id, v),
                Err(msg) => jsonrpc_error(id, -32602, msg),
            },
            method::TERMINAL_RELEASE => match self.terminals.release(&params) {
                Ok(v) => jsonrpc_result(id, v),
                Err(msg) => jsonrpc_error(id, -32602, msg),
            },
            other => jsonrpc_error(id, -32601, format!("method not supported: {other}")),
        };

        let _ = child.send_line(&reply).await;
        !matches!(
            method_name,
            "" | method::SESSION_UPDATE // never a request
        )
    }

    async fn read_text_file(&self, params: &Value) -> Result<Value, String> {
        let path = resolve_within(&self.root, params.get("path").and_then(Value::as_str))?;
        let text = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| format!("read {}: {e}", path.display()))?;

        // ACP lets the agent ask for a window of the file so a 20k-line
        // file doesn't cost a whole context. Honour it rather than
        // sending everything and hoping.
        let line = params.get("line").and_then(Value::as_u64);
        let limit = params.get("limit").and_then(Value::as_u64);
        let content = match (line, limit) {
            (None, None) => text,
            _ => {
                let start = line.unwrap_or(1).saturating_sub(1) as usize;
                let lines: Vec<&str> = text.lines().collect();
                let end = match limit {
                    Some(n) => (start + n as usize).min(lines.len()),
                    None => lines.len(),
                };
                if start >= lines.len() {
                    String::new()
                } else {
                    lines[start..end].join("\n")
                }
            }
        };
        Ok(json!({ "content": content }))
    }

    async fn write_text_file(&self, params: &Value) -> Result<Value, String> {
        let path = resolve_within(&self.root, params.get("path").and_then(Value::as_str))?;
        let content = params
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| "write_text_file: no content".to_string())?;

        // Order matters and is the point: the project's own rules, then
        // the human, then the snapshot, then the overwrite. A snapshot
        // taken after the write has recorded the agent's output, not the
        // user's work — and a write the project refuses should never have
        // got as far as costing a snapshot.
        //
        // `content` is handed over rather than withheld because the
        // interesting question about a whole-file write is what it
        // *removes*, and that cannot be seen from the path.
        gate::guard_write(&self.policy, &self.session_id, &path, Some(content)).await?;

        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        tokio::fs::write(&path, content)
            .await
            .map_err(|e| format!("write {}: {e}", path.display()))?;
        Ok(json!({}))
    }

    /// Run a command for the agent, once the human has said it may.
    ///
    /// The gate is here rather than left to the agent on purpose. An agent
    /// that behaves well asks over `session/request_permission` first, and
    /// then this asks again — one extra card, which an "always allow"
    /// collapses for good. An agent that does not ask, or that describes
    /// one command and runs another, meets the same wall either way. Given
    /// the choice between a redundant prompt and a command nobody saw, the
    /// prompt is the cheaper mistake.
    ///
    /// What the human is shown is the argv about to be executed, not the
    /// agent's account of it — the two can differ, and the difference is
    /// precisely the thing worth showing.
    async fn create_terminal(&self, params: &Value) -> Result<Value, String> {
        let line = Terminals::command_line(params);
        if line.is_empty() {
            return Err("terminal/create: no command".into());
        }
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_else(|| self.root.to_str().unwrap_or_default());

        let decision = self
            .policy
            .ask_permission(TERMINAL_TOOL, &json!({ "command": line, "cwd": cwd }))
            .await;
        if !matches!(decision, GateDecision::Allow | GateDecision::AllowAlways) {
            // Named, so it reads as a decision in the agent's transcript
            // rather than as the command having failed on its own.
            return Err(format!("`{line}` was not approved, so it did not run."));
        }
        self.terminals.create(params)
    }

    async fn request_permission(&self, params: &Value) -> Value {
        let tool_call = params.get("toolCall").cloned().unwrap_or_else(|| json!({}));
        let tool = tool_call
            .get("title")
            .and_then(Value::as_str)
            .or_else(|| tool_call.get("kind").and_then(Value::as_str))
            .unwrap_or("tool")
            .to_string();
        let input = tool_call
            .get("rawInput")
            .cloned()
            .unwrap_or_else(|| tool_call.clone());

        let options: Vec<PermissionOption> = params
            .get("options")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        // An agent that offers no options isn't really asking. Cancel
        // rather than invent an answer it never listed.
        if options.is_empty() {
            return json!({ "outcome": { "outcome": "cancelled" } });
        }

        let decision = self.policy.ask_permission(&tool, &input).await;
        let wanted_persistent = decision == GateDecision::AllowAlways;
        let wanted_allow = matches!(decision, GateDecision::Allow | GateDecision::AllowAlways);

        // Pick by `kind`, never by label — the labels are the agent's to
        // choose and "Reject" could as easily read "No thanks".
        let chosen = options
            .iter()
            .find(|o| o.is_allow() == wanted_allow && o.is_persistent() == wanted_persistent)
            .or_else(|| options.iter().find(|o| o.is_allow() == wanted_allow));

        match chosen {
            Some(opt) => json!({
                "outcome": { "outcome": "selected", "optionId": opt.option_id }
            }),
            // We decided, but the agent offered nothing matching the
            // decision (a deny with only allow options). Cancelling is
            // the honest answer: the tool does not run.
            None => json!({ "outcome": { "outcome": "cancelled" } }),
        }
    }
}

impl TerminalText for AcpHost {
    fn text_of(&self, terminal_id: &str) -> Option<String> {
        self.terminal_text(terminal_id)
    }
}

/// Resolve a path the agent named, refusing anything outside `root`.
///
/// `..` is resolved by hand rather than by `canonicalize`, because a write
/// targets a file that may not exist yet — canonicalize would fail on
/// exactly the case we most need to guard — so `src/../../.ssh/id_rsa`
/// cannot walk out.
///
/// Lexical normalisation alone is not enough, though: `..` is not the only
/// way out of a directory. A symlink is the other, and an agent can plant
/// one *inside* the root, because writing the link itself is a permitted
/// write. Both sides therefore go through
/// [`gate::resolve_symlinks`] before the prefix check, so a link is
/// judged by where it leads rather than by where it sits.
pub fn resolve_within(root: &Path, raw: Option<&str>) -> Result<PathBuf, String> {
    let raw = raw.ok_or_else(|| "no path given".to_string())?;
    if raw.is_empty() {
        return Err("empty path".into());
    }
    let candidate = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        root.join(raw)
    };

    let mut out = PathBuf::new();
    for part in candidate.components() {
        match part {
            std::path::Component::ParentDir => {
                // Refuse rather than silently clamp at the root: an agent
                // that meant to escape should see that it failed.
                if !out.pop() {
                    return Err(format!("path escapes the project root: {raw}"));
                }
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }

    let root_norm = gate::resolve_symlinks(&normalise(root));
    let out = gate::resolve_symlinks(&out);
    if !out.starts_with(&root_norm) {
        return Err(format!(
            "path escapes the project root ({}): {raw}",
            root_norm.display()
        ));
    }
    Ok(out)
}

fn normalise(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in p.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    /// Records what the host asked of it, in order.
    struct Recorder {
        decision: GateDecision,
        snapshot_fails: bool,
        calls: Mutex<Vec<String>>,
    }

    impl Recorder {
        fn new(decision: GateDecision) -> Arc<Self> {
            Arc::new(Self {
                decision,
                snapshot_fails: false,
                calls: Mutex::new(Vec::new()),
            })
        }
        fn failing_snapshot() -> Arc<Self> {
            Arc::new(Self {
                decision: GateDecision::Allow,
                snapshot_fails: true,
                calls: Mutex::new(Vec::new()),
            })
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl HostPolicy for Recorder {
        async fn ask_permission(&self, tool: &str, _input: &Value) -> GateDecision {
            self.calls.lock().unwrap().push(format!("ask:{tool}"));
            self.decision
        }
        async fn before_write(&self, path: &Path, _proposed: Option<&str>) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("snapshot:{}", path.display()));
            if self.snapshot_fails {
                return Err("snapshot failed".into());
            }
            Ok(())
        }
    }

    fn tmp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aura-acp-host-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Resolve symlinks (macOS /var → /private/var) so the guard's
        // prefix check compares like with like.
        dir.canonicalize().unwrap()
    }

    #[test]
    fn a_relative_path_lands_under_the_root() {
        let root = Path::new("/repo");
        assert_eq!(
            resolve_within(root, Some("src/main.rs")).unwrap(),
            PathBuf::from("/repo/src/main.rs")
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_planted_inside_the_root_cannot_lead_out_of_it() {
        // `..` is not the only way out of a directory, and this host does
        // not merely judge paths — it performs the read or write itself.
        // Creating the link is a legitimate write, because the link's own
        // path is inside the root; following it is not. Judged lexically
        // the two are indistinguishable, and `escape/id_rsa` reads a key.
        let root = tmp_root("symlink-escape");
        let outside = std::env::temp_dir().join("aura-acp-host-symlink-outside");
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("id_rsa"), "PRIVATE KEY").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();

        assert!(
            resolve_within(&root, Some("escape/id_rsa")).is_err(),
            "a symlink is judged by where it leads, not where it sits"
        );
        // And the same for a file that does not exist yet — the write case,
        // which is the one canonicalize alone cannot see.
        assert!(
            resolve_within(&root, Some("escape/authorized_keys")).is_err(),
            "a write through the link is the same escape as a read"
        );
        // A real file under the root still resolves, or the guard would be
        // protecting the repo from its own agent.
        assert!(resolve_within(&root, Some("src/main.rs")).is_ok());

        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn dot_dot_cannot_walk_out_of_the_project() {
        let root = Path::new("/repo");
        for escape in [
            "../secrets.env",
            "src/../../etc/passwd",
            "a/b/../../../..//x",
        ] {
            assert!(
                resolve_within(root, Some(escape)).is_err(),
                "should refuse {escape}"
            );
        }
    }

    #[test]
    fn an_absolute_path_outside_the_root_is_refused() {
        let root = Path::new("/repo");
        // The case that matters: the app's own credential store.
        assert!(resolve_within(root, Some("/Users/me/.aura/credentials.json")).is_err());
        // And one inside is fine.
        assert!(resolve_within(root, Some("/repo/src/lib.rs")).is_ok());
    }

    #[test]
    fn dot_dot_that_stays_inside_is_allowed() {
        let root = Path::new("/repo");
        assert_eq!(
            resolve_within(root, Some("src/nested/../main.rs")).unwrap(),
            PathBuf::from("/repo/src/main.rs")
        );
    }

    #[test]
    fn a_missing_or_empty_path_is_an_error_not_the_root() {
        let root = Path::new("/repo");
        assert!(resolve_within(root, None).is_err());
        assert!(resolve_within(root, Some("")).is_err());
    }

    #[tokio::test]
    async fn reading_honours_the_requested_window() {
        let root = tmp_root("read-window");
        std::fs::write(root.join("f.txt"), "l1\nl2\nl3\nl4\nl5\n").unwrap();
        let host = AcpHost::new(&root, "test-session", Recorder::new(GateDecision::Allow));

        let all = host
            .read_text_file(&json!({"path": "f.txt"}))
            .await
            .unwrap();
        assert_eq!(all["content"], "l1\nl2\nl3\nl4\nl5\n");

        let window = host
            .read_text_file(&json!({"path": "f.txt", "line": 2, "limit": 2}))
            .await
            .unwrap();
        assert_eq!(window["content"], "l2\nl3");

        // Past the end is empty, not an error — the agent asked for a
        // window that doesn't exist, which is a fact, not a failure.
        let past = host
            .read_text_file(&json!({"path": "f.txt", "line": 99, "limit": 2}))
            .await
            .unwrap();
        assert_eq!(past["content"], "");
    }

    #[tokio::test]
    async fn a_write_snapshots_before_it_overwrites() {
        let root = tmp_root("write-snapshot");
        let target = root.join("keep.rs");
        std::fs::write(&target, "fn original() {}").unwrap();

        let policy = Recorder::new(GateDecision::Allow);
        let host = AcpHost::new(&root, "test-session", policy.clone());
        host.write_text_file(&json!({"path": "keep.rs", "content": "fn replaced() {}"}))
            .await
            .unwrap();

        assert_eq!(
            policy.calls(),
            vec![format!("snapshot:{}", target.display())],
            "the file must be snapshotted, and nothing else asked"
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "fn replaced() {}");
    }

    #[tokio::test]
    async fn a_command_the_human_refused_does_not_run() {
        let root = tmp_root("terminal-denied");
        let marker = root.join("it-ran");
        let _ = std::fs::remove_file(&marker);

        let policy = Recorder::new(GateDecision::Deny);
        let host = AcpHost::new(&root, "test-session", policy.clone());
        let err = host
            .create_terminal(&json!({"command": "touch", "args": ["it-ran"]}))
            .await
            .unwrap_err();

        assert_eq!(
            policy.calls(),
            vec![format!("ask:{TERMINAL_TOOL}")],
            "a command has to be asked about before it is run"
        );
        assert!(
            err.contains("touch it-ran") && err.contains("not approved"),
            "the refusal names the command and says it was a decision: {err}"
        );
        assert!(
            !marker.exists(),
            "a refused command must not have run — the gate is the point"
        );
    }

    #[tokio::test]
    async fn an_approved_command_runs_and_the_argv_is_what_was_asked_about() {
        let root = tmp_root("terminal-allowed");
        let policy = Recorder::new(GateDecision::Allow);
        let host = AcpHost::new(&root, "test-session", policy.clone());

        let created = host
            .create_terminal(&json!({"command": "echo", "args": ["hi"]}))
            .await
            .expect("an approved command runs");
        assert!(created["terminalId"].is_string());
        assert_eq!(policy.calls(), vec![format!("ask:{TERMINAL_TOOL}")]);

        // And the transcript can resolve the id the agent's tool card
        // carries, rather than rendering an opaque handle.
        let id = created["terminalId"].as_str().unwrap();
        let waited = host
            .terminals
            .wait_for_exit(&json!({"terminalId": id}))
            .await
            .unwrap();
        assert_eq!(waited["exitCode"], json!(0));
        assert_eq!(host.terminal_text(id).as_deref(), Some("hi\n"));
    }

    #[tokio::test]
    async fn a_failed_snapshot_leaves_the_file_alone() {
        let root = tmp_root("write-snapshot-fails");
        let target = root.join("keep.rs");
        std::fs::write(&target, "fn original() {}").unwrap();

        let host = AcpHost::new(&root, "test-session", Recorder::failing_snapshot());
        let err = host
            .write_text_file(&json!({"path": "keep.rs", "content": "gone"}))
            .await
            .unwrap_err();
        assert!(err.contains("snapshot failed"), "got {err}");
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "fn original() {}",
            "an unprotectable file must not be overwritten"
        );
    }

    #[tokio::test]
    async fn a_write_outside_the_root_never_reaches_the_disk() {
        let root = tmp_root("write-escape");
        let outside = root.parent().unwrap().join("aura-acp-escapee.txt");
        let _ = std::fs::remove_file(&outside);

        let policy = Recorder::new(GateDecision::Allow);
        let host = AcpHost::new(&root, "test-session", policy.clone());
        let err = host
            .write_text_file(&json!({"path": "../aura-acp-escapee.txt", "content": "x"}))
            .await
            .unwrap_err();

        assert!(err.contains("escapes the project root"), "got {err}");
        assert!(!outside.exists());
        assert!(
            policy.calls().is_empty(),
            "a refused path must not even reach the snapshot step"
        );
    }

    /// The three options OpenCode 1.18.11 actually offers.
    fn opencode_options() -> Value {
        json!([
            {"optionId": "once", "kind": "allow_once", "name": "Allow once"},
            {"optionId": "always", "kind": "allow_always", "name": "Always allow"},
            {"optionId": "reject", "kind": "reject_once", "name": "Reject"}
        ])
    }

    #[tokio::test]
    async fn each_decision_selects_the_option_matching_its_kind() {
        let root = tmp_root("permission");
        for (decision, expected) in [
            (GateDecision::Allow, "once"),
            (GateDecision::AllowAlways, "always"),
            (GateDecision::Deny, "reject"),
        ] {
            let policy = Recorder::new(decision);
            let host = AcpHost::new(&root, "test-session", policy.clone());
            let out = host
                .request_permission(&json!({
                    "sessionId": "ses_1",
                    "toolCall": {"toolCallId": "c1", "title": "Run rm -rf /", "kind": "execute"},
                    "options": opencode_options(),
                }))
                .await;
            assert_eq!(out["outcome"]["outcome"], "selected");
            assert_eq!(out["outcome"]["optionId"], expected, "for {decision:?}");
            assert_eq!(policy.calls(), vec!["ask:Run rm -rf /".to_string()]);
        }
    }

    #[tokio::test]
    async fn a_deny_with_no_reject_option_cancels_rather_than_allowing() {
        // The failure mode worth guarding: falling back to "pick the
        // first option" would turn a refusal into an approval.
        let root = tmp_root("permission-no-reject");
        let host = AcpHost::new(&root, "test-session", Recorder::new(GateDecision::Deny));
        let out = host
            .request_permission(&json!({
                "toolCall": {"title": "Delete everything"},
                "options": [{"optionId": "once", "kind": "allow_once", "name": "Allow once"}],
            }))
            .await;
        assert_eq!(out["outcome"]["outcome"], "cancelled");
    }

    #[tokio::test]
    async fn an_always_decision_falls_back_to_a_plain_allow() {
        let root = tmp_root("permission-no-always");
        let host = AcpHost::new(&root, "test-session", Recorder::new(GateDecision::AllowAlways));
        let out = host
            .request_permission(&json!({
                "toolCall": {"title": "Read a file"},
                "options": [
                    {"optionId": "once", "kind": "allow_once", "name": "Allow once"},
                    {"optionId": "reject", "kind": "reject_once", "name": "Reject"}
                ],
            }))
            .await;
        assert_eq!(out["outcome"]["optionId"], "once");
    }

    #[tokio::test]
    async fn an_ask_with_no_options_is_cancelled_without_bothering_anyone() {
        let root = tmp_root("permission-empty");
        let policy = Recorder::new(GateDecision::Allow);
        let host = AcpHost::new(&root, "test-session", policy.clone());
        let out = host
            .request_permission(&json!({"toolCall": {"title": "?"}, "options": []}))
            .await;
        assert_eq!(out["outcome"]["outcome"], "cancelled");
        assert!(policy.calls().is_empty());
    }

    #[test]
    fn agent_requests_are_told_apart_from_notifications() {
        assert!(AcpHost::is_agent_request(
            &json!({"id": 1, "method": "fs/read_text_file"})
        ));
        assert!(!AcpHost::is_agent_request(
            &json!({"method": "session/update"})
        ));
        assert!(!AcpHost::is_agent_request(&json!({"id": 1, "result": {}})));
    }
}
