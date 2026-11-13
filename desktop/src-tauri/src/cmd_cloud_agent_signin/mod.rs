//! One click to sign an agent in for cloud workspaces.
//!
//! The member's own computer does the signing in, with the agent's own CLI,
//! and the result goes straight to the cloud through the signed-in client —
//! the renderer only ever sees where the flow is, never a token.
//!
//! - Claude: `claude setup-token` in a PTY. It opens the browser, and once the
//!   member signs in it prints a long-lived token, which is saved as
//!   `claude_code_oauth_token`. If the browser cannot hand the sign-in back,
//!   the CLI asks for the code the page shows, and the app asks the member.
//! - Codex: `codex login` with a throwaway `CODEX_HOME` and the credential
//!   store forced to a file, so the member's own Codex sign-in on this computer
//!   is never touched. The browser sign-in comes first; when Codex can't start
//!   its sign-in server here, the device-code sign-in is offered instead. The
//!   `auth.json` it writes is saved as `codex_chatgpt_auth` and the directory
//!   is removed.
//!
//! The renderer starts a flow, polls its status, and can cancel it or hand it
//! the code. One flow per agent at a time: starting another cancels the first.

mod claude;
mod codex;
pub(crate) mod text;

use std::collections::HashMap;
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

pub use text::CodePrompt;

/// How long a sign-in may wait on the member before it is given up.
const SIGN_IN_LIMIT: Duration = Duration::from_secs(15 * 60);

/// How long a pasted code sits in Claude Code's box before Enter is pressed:
/// long enough for it to take the code in as typing first.
const CODE_SETTLE: Duration = Duration::from_millis(300);

const NOT_WAITING: &str = "The sign-in isn't waiting for a code any more. Start it again.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
    Claude,
    Codex,
}

impl Agent {
    fn parse(s: &str) -> Result<Agent, String> {
        match s {
            "claude" => Ok(Agent::Claude),
            "codex" => Ok(Agent::Codex),
            _ => Err(format!("not an agent that signs in here: {s:?}")),
        }
    }

    fn cli(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
        }
    }

    fn missing(self) -> &'static str {
        match self {
            Agent::Claude => "Claude Code isn't installed on this computer, so it can't sign in from here.",
            Agent::Codex => "Codex isn't installed on this computer, so it can't sign in from here.",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    #[default]
    Starting,
    /// Waiting on the member in their browser.
    Browser,
    /// Waiting on the member to enter `code` at `url`.
    DeviceCode,
    Saving,
    Connected,
    Failed,
    Cancelled,
}

impl Phase {
    fn is_over(self) -> bool {
        matches!(self, Phase::Connected | Phase::Failed | Phase::Cancelled)
    }
}

/// What the renderer is shown. Never a token.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: Phase,
    /// The sign-in page, when the CLI printed one on the agent's own site.
    pub url: Option<String>,
    /// The one-time code to enter at `url` (Codex's device sign-in).
    pub code: Option<String>,
    /// Claude is asking for the code its sign-in page shows.
    pub code_prompt: Option<CodePrompt>,
    /// Who it signed in as, when the sign-in says (Codex: `email · Plan`).
    pub account: Option<String>,
    pub error: Option<String>,
    /// The agent's CLI is not on this computer.
    pub missing_cli: bool,
}

/// Why a sign-in ended without a credential.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Fail {
    Cancelled,
    /// Codex could not start its local sign-in server.
    PortBusy,
    Message(String),
}

impl From<String> for Fail {
    fn from(s: String) -> Fail {
        Fail::Message(s)
    }
}

/// A finished sign-in: what to save, and who it is.
pub(crate) struct Got {
    pub name: &'static str,
    pub value: String,
    pub account: Option<String>,
}

/// One sign-in in progress.
#[derive(Default)]
pub(crate) struct Flow {
    status: Mutex<Status>,
    cancelled: AtomicBool,
    cancel: tokio::sync::Notify,
    /// Claude's terminal, for the code the member pastes.
    input: Mutex<Option<Box<dyn Write + Send>>>,
    /// Stops Claude's PTY child.
    killer: Mutex<Option<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
    /// The member has handed over the code; the prompt still on screen is
    /// the one they answered.
    code_sent: AtomicBool,
}

impl Flow {
    pub(crate) fn set(&self, f: impl FnOnce(&mut Status)) {
        if let Ok(mut s) = self.status.lock() {
            if !s.phase.is_over() {
                f(&mut s);
            }
        }
    }

    pub(crate) fn status(&self) -> Status {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub(crate) async fn cancelled(&self) {
        loop {
            let wait = self.cancel.notified();
            if self.is_cancelled() {
                return;
            }
            wait.await;
        }
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.cancel.notify_waiters();
        if let Ok(mut k) = self.killer.lock() {
            if let Some(k) = k.as_mut() {
                let _ = k.kill();
            }
        }
        self.set(|s| *s = Status { phase: Phase::Cancelled, ..Status::default() });
    }

    fn finish(&self, end: Status) {
        if let Ok(mut s) = self.status.lock() {
            if !s.phase.is_over() {
                *s = end;
            }
        }
        if let Ok(mut i) = self.input.lock() {
            *i = None;
        }
        if let Ok(mut k) = self.killer.lock() {
            *k = None;
        }
    }

    /// Hand Claude the code its sign-in page showed.
    ///
    /// The code and the Enter that submits it go in as two writes, apart.
    /// Claude Code's code box is a full-screen input: a code and an Enter that
    /// arrive in one read are taken as one burst of typing, and the Enter
    /// never submits what was typed, so the sign-in just keeps waiting.
    pub(crate) async fn send_code(&self, code: &str) -> Result<(), String> {
        let code = code.trim();
        if code.is_empty() || code.len() > 512 || code.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err("That code doesn't look right. Copy it again from the sign-in page.".into());
        }
        self.type_in(code.as_bytes())?;
        tokio::time::sleep(CODE_SETTLE).await;
        // Marked before the Enter, so whatever Claude Code says back is read
        // as its answer to this code.
        self.code_sent.store(true, Ordering::SeqCst);
        if let Err(e) = self.type_in(b"\r") {
            self.code_sent.store(false, Ordering::SeqCst);
            return Err(e);
        }
        self.set(|s| s.code_prompt = None);
        Ok(())
    }

    fn type_in(&self, bytes: &[u8]) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|_| NOT_WAITING.to_string())?;
        let w = input.as_mut().ok_or(NOT_WAITING)?;
        w.write_all(bytes)
            .and_then(|_| w.flush())
            .map_err(|e| format!("handing the code to Claude Code: {e}"))
    }
}

type Saver = Arc<dyn Fn(&'static str, String) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;

/// Run one sign-in to its end and save what it got.
pub(crate) async fn drive(flow: Arc<Flow>, agent: Agent, bin: PathBuf, save: Saver) {
    let run = async {
        match agent {
            Agent::Claude => claude::run(flow.clone(), bin).await,
            Agent::Codex => codex::run(&flow, &bin).await,
        }
    };
    let got = tokio::select! {
        got = run => got,
        _ = tokio::time::sleep(SIGN_IN_LIMIT) => {
            flow.cancel();
            Err(Fail::Message("The sign-in took too long. Try again.".into()))
        }
    };
    let end = match got {
        Ok(_) if flow.is_cancelled() => Status { phase: Phase::Cancelled, ..Status::default() },
        Ok(Got { name, value, account }) => {
            flow.set(|s| {
                s.phase = Phase::Saving;
                s.code = None;
                s.code_prompt = None;
            });
            match save(name, value).await {
                Ok(()) => Status { phase: Phase::Connected, account, ..Status::default() },
                Err(e) => Status { phase: Phase::Failed, error: Some(save_error(&e)), ..Status::default() },
            }
        }
        Err(Fail::Cancelled) => Status { phase: Phase::Cancelled, ..Status::default() },
        Err(Fail::PortBusy) => Status {
            phase: Phase::Failed,
            error: Some("Codex couldn't start its sign-in on this computer.".into()),
            ..Status::default()
        },
        Err(Fail::Message(m)) => Status { phase: Phase::Failed, error: Some(m), ..Status::default() },
    };
    // A failure after a cancel is still a cancel.
    let end = if flow.is_cancelled() && end.phase != Phase::Connected {
        Status { phase: Phase::Cancelled, ..Status::default() }
    } else {
        end
    };
    flow.finish(end);
}

/// What the cloud said, in words, when it refused a save. The server's
/// `detail` is already written for people; anything else is not shown raw.
fn save_error(e: &str) -> String {
    let detail = e
        .find('{')
        .and_then(|i| serde_json::from_str::<serde_json::Value>(&e[i..]).ok())
        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(str::to_string));
    match detail {
        Some(d) if d.contains("not a credential an agent can use") => {
            "The cloud doesn't take this sign-in yet. Use an API key for now.".into()
        }
        Some(d) => format!("The cloud didn't save it: {d}."),
        None if e.contains("no cloud_api_token") => "Sign in to Aura first, then connect again.".into(),
        None => "The cloud couldn't be reached to save it. Try again.".into(),
    }
}

/// The agent's CLI on this computer's `PATH`, if it is there.
pub(crate) fn find_cli(name: &str, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(path?).map(|d| d.join(name)).find(|p| {
        std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    })
}

fn flows() -> &'static Mutex<HashMap<String, (Agent, Arc<Flow>)>> {
    static FLOWS: OnceLock<Mutex<HashMap<String, (Agent, Arc<Flow>)>>> = OnceLock::new();
    FLOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn flow(id: &str) -> Result<Arc<Flow>, String> {
    flows()
        .lock()
        .map_err(|_| "sign-in state is unavailable".to_string())?
        .get(id)
        .map(|(_, f)| f.clone())
        .ok_or_else(|| "that sign-in has ended".to_string())
}

/// Register a new flow for `agent`, cancelling and forgetting any other.
fn begin(agent: Agent) -> Result<(String, Arc<Flow>), String> {
    let id = uuid::Uuid::new_v4().to_string();
    let f = Arc::new(Flow::default());
    let mut map = flows().lock().map_err(|_| "sign-in state is unavailable".to_string())?;
    map.retain(|_, (a, old)| {
        if *a == agent {
            old.cancel();
            false
        } else {
            true
        }
    });
    map.insert(id.clone(), (agent, f.clone()));
    Ok((id, f))
}

#[derive(Serialize)]
pub struct Started {
    pub id: String,
    pub status: Status,
}

fn cloud_saver(workspace_id: Option<String>) -> Saver {
    Arc::new(move |name, value| {
        let ws = workspace_id.clone();
        Box::pin(async move {
            crate::cmd_cloud_agent_credentials::cloud_agent_credential_save(name.to_string(), value, ws)
                .await
                .map(|_| ())
        })
    })
}

/// Start signing `agent` in for cloud workspaces.
#[tauri::command]
pub async fn cloud_agent_signin_start(agent: String, workspace_id: Option<String>) -> Result<Started, String> {
    let agent = Agent::parse(&agent)?;
    let (id, f) = begin(agent)?;
    match find_cli(agent.cli(), std::env::var_os("PATH").as_deref()) {
        None => f.finish(Status {
            phase: Phase::Failed,
            error: Some(agent.missing().into()),
            missing_cli: true,
            ..Status::default()
        }),
        Some(bin) => {
            tauri::async_runtime::spawn(drive(f.clone(), agent, bin, cloud_saver(workspace_id)));
        }
    }
    Ok(Started { id, status: f.status() })
}

/// Where a sign-in is.
#[tauri::command]
pub async fn cloud_agent_signin_status(id: String) -> Result<Status, String> {
    Ok(flow(&id)?.status())
}

/// Hand a sign-in the code the member copied from the sign-in page.
#[tauri::command]
pub async fn cloud_agent_signin_code(id: String, code: String) -> Result<(), String> {
    let f = flow(&id)?;
    f.send_code(&code).await
}

/// Stop a sign-in. Nothing is saved.
#[tauri::command]
pub async fn cloud_agent_signin_cancel(id: String) -> Result<(), String> {
    if let Ok(f) = flow(&id) {
        f.cancel();
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A stand-in CLI: a shell script, made executable, in `dir`.
    pub fn fake_cli(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    /// A saver that records what it was given instead of calling the cloud.
    pub fn recording_saver() -> (Saver, Arc<Mutex<Vec<(String, String)>>>) {
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        let saver: Saver = Arc::new(move |name, value| {
            g.lock().unwrap().push((name.to_string(), value));
            Box::pin(async { Ok(()) })
        });
        (saver, got)
    }

    pub async fn wait_for(f: &Flow, what: impl Fn(&Status) -> bool) -> Status {
        for _ in 0..400 {
            let s = f.status();
            if what(&s) {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("timed out waiting; last status {:?}", f.status());
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn the_cli_is_found_only_where_it_can_run() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_cli(dir.path(), "codex", "exit 0");
        std::fs::write(dir.path().join("claude"), "not executable").unwrap();
        let path = std::env::join_paths([Path::new("/nonexistent-aura"), dir.path()]).unwrap();
        assert_eq!(find_cli("codex", Some(&path)), Some(bin));
        assert_eq!(find_cli("claude", Some(&path)), None);
        assert_eq!(find_cli("codex", None), None);
    }

    #[test]
    fn a_refused_save_is_said_in_words() {
        let e = r#"HTTP 400 Bad Request: {"reason":"bad_value","detail":"that is not a credential an agent can use"}"#;
        assert!(save_error(e).contains("doesn't take this sign-in yet"));
        let e = r#"HTTP 400 Bad Request: {"reason":"bad_value","detail":"that Codex sign-in has no ChatGPT tokens"}"#;
        assert_eq!(save_error(e), "The cloud didn't save it: that Codex sign-in has no ChatGPT tokens.");
        assert!(save_error("no cloud_api_token").contains("Sign in to Aura"));
        assert!(!save_error("POST https://x: connection refused sk-ant-oat01-x").contains("sk-ant"));
    }

    #[tokio::test]
    async fn starting_again_cancels_the_first_sign_in_for_that_agent_only() {
        let (a, fa) = begin(Agent::Codex).unwrap();
        let (_, fc) = begin(Agent::Claude).unwrap();
        let (b, _) = begin(Agent::Codex).unwrap();
        assert_ne!(a, b);
        assert_eq!(fa.status().phase, Phase::Cancelled);
        assert!(flow(&a).is_err(), "the first is forgotten");
        assert_eq!(fc.status().phase, Phase::Starting, "Claude's is left alone");
    }

    #[tokio::test]
    async fn a_code_is_one_line_with_nothing_else_in_it() {
        let f = Flow::default();
        assert!(f.send_code("abc def").await.is_err());
        assert!(f.send_code("   ").await.is_err());
        assert!(f.send_code("abc").await.unwrap_err().contains("isn't waiting for a code"));
        assert!(!f.code_sent.load(Ordering::SeqCst), "a code that never went in is not marked sent");
    }
}
