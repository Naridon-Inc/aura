//! The proxy's side effects: a snapshot before each write, one intent row
//! per turn that touched files, and the gate verdict on a permission request.
//!
//! Snapshots and intents go through the `aura` binary itself
//! (`snapshot-file`, `log-intent`) run in the session's repository, so the
//! rows are byte-identical to the ones hooks write and land in the right
//! repo however the client launched the proxy. The gate runs in-process:
//! it is a pure read of policy, strict mode and grants.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

use super::guard::one_line;

/// One prompt turn as the proxy saw it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Turn {
    pub session_id: String,
    pub cwd: String,
    pub prompt: String,
    /// Paths written during the turn, in first-touch order.
    pub writes: Vec<String>,
}

/// A file about to be written.
pub(crate) struct WriteAt<'a> {
    pub path: &'a str,
    pub why: &'a str,
    pub session: &'a str,
    pub cwd: &'a str,
}

/// A tool call the agent wants permission for, in the gate's terms.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GateQuery {
    pub tool: String,
    pub input: Value,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Gate {
    /// Let the client ask its human, as it would without the proxy.
    Pass,
    /// Refuse on the human's standing behalf: policy or a locked strict mode
    /// already said no.
    Deny { title: String, reason: String },
}

pub(crate) trait Effects: Send {
    fn snapshot(&mut self, at: &WriteAt<'_>);
    fn log_turn(&mut self, turn: &Turn, stop_reason: &str);
    fn gate(&mut self, query: &GateQuery) -> Gate;
}

/// The real effects, for `aura acp-proxy`.
pub(crate) struct LiveEffects {
    /// Who the rows are attributed to, e.g. `gemini`.
    agent: String,
    /// The `aura` binary running this proxy.
    exe: PathBuf,
}

impl LiveEffects {
    pub(crate) fn new(agent: String, exe: PathBuf) -> Self {
        Self { agent, exe }
    }

    fn aura(&self, root: &Path) -> Command {
        let mut c = Command::new(&self.exe);
        c.current_dir(root)
            .env("AURA_AGENT", &self.agent)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        c
    }
}

impl Effects for LiveEffects {
    fn snapshot(&mut self, at: &WriteAt<'_>) {
        let root = repo_root(at.cwd);
        let path = repo_relative(&root, at.path);
        let mut c = self.aura(&root);
        c.args(["snapshot-file", "--trigger", "acp_proxy_pre_write", "--agent", &self.agent])
            .args(["--why", at.why]);
        if !at.session.is_empty() {
            c.args(["--session", at.session]);
        }
        // `--` so a path that starts with a dash is still a path.
        c.args(["--", &path]);
        // Awaited: the write must not reach the client until the old
        // content is safe.
        let _ = c.status();
    }

    fn log_turn(&mut self, turn: &Turn, stop_reason: &str) {
        let root = repo_root(&turn.cwd);
        let writes: Vec<String> = turn.writes.iter().map(|w| repo_relative(&root, w)).collect();
        let mut text = one_line(&turn.prompt, 400);
        if text.is_empty() {
            text = format!("{} edited {} file(s) over ACP", self.agent, writes.len());
        }
        if stop_reason != "end_turn" {
            text.push_str(&format!(" (turn ended: {stop_reason})"));
        }
        let mut c = self.aura(&root);
        c.args(["log-intent", "--type", intent_type_for(&turn.prompt)])
            .args(["--source", "acp_proxy", "--tool", "acp-proxy"])
            .args(["--writes", &writes.join(",")]);
        if !turn.session_id.is_empty() {
            c.args(["--session", &turn.session_id]);
        }
        // The person's words may start with a dash; they are still the text.
        c.args(["--", &text]);
        let _ = c.status();
    }

    fn gate(&mut self, query: &GateQuery) -> Gate {
        let v = crate::validate_tool::verdict_for(&query.tool, query.input.clone(), query.cwd.as_deref());
        if v.decision == "deny" {
            Gate::Deny { title: v.title, reason: v.reason }
        } else {
            Gate::Pass
        }
    }
}

fn repo_root(cwd: &str) -> PathBuf {
    crate::validate_tool::resolve_repo_root((!cwd.is_empty()).then_some(cwd))
}

fn repo_relative(root: &Path, path: &str) -> String {
    Path::new(path)
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string())
}

/// The closest canonical intent type for what the person asked. A guess
/// from their words, never left empty: an untyped row shows up in no
/// classification view at all.
pub(crate) fn intent_type_for(prompt: &str) -> &'static str {
    let lower = prompt.to_lowercase();
    let words: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
    let has = |stems: &[&str]| words.iter().any(|w| stems.iter().any(|s| w.starts_with(s)));
    if has(&["revert", "undo", "rollback"]) {
        "Revert"
    } else if has(&["fix", "bug", "broken", "crash", "regression"]) {
        "BugFix"
    } else if has(&["refactor", "rename", "cleanup", "simplif", "reorganiz", "restructur"]) {
        "Refactor"
    } else if has(&["faster", "perf", "optimi", "slow", "latency"]) {
        "Performance"
    } else if has(&["readme", "docs", "document", "comment", "changelog"]) {
        "Docs"
    } else if has(&["upgrade", "bump", "dependenc"]) {
        "Deps"
    } else {
        "FeatureAdd"
    }
}
