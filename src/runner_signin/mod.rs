//! Agent sign-ins members start from the web, run on this computer.
//!
//! A member with no Aura app clicks Connect in the web console. The cloud
//! queues a sign-in for them on their org's computer, and this thread picks it
//! up on its outbound poll — the computer is never reached from outside. It
//! runs the agent's own sign-in here (`claude setup-token`, or Codex's
//! device-code sign-in), passes the sign-in link and code box back to the
//! member through the cloud, types in the code the member pastes, and hands
//! the result back once, to be saved as that member and no one else.
//!
//! Nothing a sign-in shows or is given — its link, its code, its token — is
//! ever logged. Every sign-in is stopped, with everything it started, when it
//! finishes, is cancelled, fails, or runs past the time the cloud gave it.

mod claude;
mod codex;
mod pty;
mod screen;

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use colored::Colorize;
use serde::{Deserialize, Serialize};

use crate::runner_chat::Cloud;

/// How long one wait for the agent's output lasts.
const TICK: Duration = Duration::from_millis(250);
/// How often a sign-in says it is still going when nothing has changed.
const BEAT: Duration = Duration::from_secs(1);
/// The most of a sign-in's screen kept to read it.
const SCREEN_CAP: usize = 256 * 1024;
/// How often the cloud is asked for sign-ins waiting on this computer.
const POLL: Duration = Duration::from_secs(3);
/// How often to ask a cloud that does not hand out sign-ins yet.
const POLL_UNSUPPORTED: Duration = Duration::from_secs(60);
/// The longest any sign-in runs, whatever the cloud says.
const LONGEST: Duration = Duration::from_secs(10 * 60);
/// Sign-ins running on this computer at once.
const AT_ONCE: usize = 3;

/// What a running sign-in tells the cloud.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Report {
    pub phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_prompt: Option<&'static str>,
    pub missing_cli: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What the cloud says back: stop, or type the code the member pasted.
#[derive(Debug, Default, Deserialize)]
pub struct Next {
    #[serde(default)]
    pub stop: bool,
    #[serde(default)]
    pub code: Option<String>,
}

/// How a sign-in ended on this computer.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Signed in: what to save for the member.
    Got(String),
    /// The member cancelled, or the cloud ended it.
    Stopped,
    /// The agent's CLI isn't installed here.
    Missing,
    /// It failed, in the agent's own words when it gave any.
    Failed(Option<String>),
}

/// The cloud end of one sign-in.
pub trait Desk {
    fn report(&self, report: &Report) -> Result<Next, String>;
    fn finish(&self, value: &str) -> Result<(), String>;
}

struct CloudDesk<'a> {
    cloud: &'a Cloud,
    id: &'a str,
}

fn problem_of(resp: reqwest::blocking::Response, doing: &str) -> String {
    let status = resp.status();
    let body: serde_json::Value = resp.json().unwrap_or(serde_json::Value::Null);
    let said = body.get("detail").or_else(|| body.get("error")).and_then(|v| v.as_str()).unwrap_or("");
    format!("{doing}: {status} {said}")
}

impl CloudDesk<'_> {
    fn url(&self, step: &str) -> String {
        format!("{}/api/v2/places/{}/agent-signins/{}/{step}", self.cloud.base, self.cloud.place, self.id)
    }

    fn post(&self, step: &str, body: &impl Serialize) -> Result<reqwest::blocking::Response, String> {
        self.cloud
            .client
            .post(self.url(step))
            .header("Authorization", format!("Bearer {}", self.cloud.token))
            .json(body)
            .send()
            .map_err(|e| format!("{step}: {}", e.without_url()))
    }
}

impl Desk for CloudDesk<'_> {
    fn report(&self, report: &Report) -> Result<Next, String> {
        let resp = self.post("progress", report)?;
        if !resp.status().is_success() {
            return Err(problem_of(resp, "reporting the sign-in"));
        }
        resp.json::<Next>().map_err(|e| format!("reading what to do next: {}", e.without_url()))
    }

    fn finish(&self, value: &str) -> Result<(), String> {
        let resp = self.post("finish", &serde_json::json!({ "value": value }))?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(problem_of(resp, "saving the sign-in"))
        }
    }
}

/// A sign-in waiting on this computer, as the cloud lists it.
#[derive(Debug, Clone, Deserialize)]
struct Waiting {
    id: String,
    agent: String,
    expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
struct WaitingList {
    #[serde(default)]
    signins: Vec<Waiting>,
}

enum Asked {
    Some(Vec<Waiting>),
    /// The cloud has no sign-ins for computers yet.
    Unsupported,
    Failed(String),
}

fn waiting(cloud: &Cloud) -> Asked {
    let url = format!("{}/api/v2/places/{}/agent-signins", cloud.base, cloud.place);
    let resp = match cloud.client.get(url).header("Authorization", format!("Bearer {}", cloud.token)).send() {
        Ok(r) => r,
        Err(e) => return Asked::Failed(format!("asking for sign-ins: {}", e.without_url())),
    };
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Asked::Unsupported;
    }
    if !resp.status().is_success() {
        return Asked::Failed(problem_of(resp, "asking for sign-ins"));
    }
    match resp.json::<WaitingList>() {
        Ok(list) => Asked::Some(list.signins),
        Err(e) => Asked::Failed(format!("reading the sign-ins: {}", e.without_url())),
    }
}

/// Take a sign-in for this computer. Only one computer ever gets it.
fn claim(cloud: &Cloud, id: &str) -> Result<Waiting, String> {
    let url = format!("{}/api/v2/places/{}/agent-signins/{id}/claim", cloud.base, cloud.place);
    let resp = cloud
        .client
        .post(url)
        .header("Authorization", format!("Bearer {}", cloud.token))
        .send()
        .map_err(|e| format!("taking a sign-in: {}", e.without_url()))?;
    if !resp.status().is_success() {
        return Err(problem_of(resp, "taking a sign-in"));
    }
    resp.json::<Waiting>().map_err(|e| format!("reading the sign-in taken: {}", e.without_url()))
}

fn label(agent: &str) -> &'static str {
    match agent {
        "claude" => "Claude Code",
        "codex" => "Codex",
        _ => "agent",
    }
}

/// Run one sign-in to its end with the agent's CLI found on `PATH`.
pub fn run(desk: &dyn Desk, agent: &str, deadline: Instant, running: &AtomicBool) -> Outcome {
    match agent {
        "claude" => claude::run(desk, Path::new("claude"), deadline, running),
        "codex" => codex::run(desk, Path::new("codex"), deadline, running),
        _ => Outcome::Failed(None),
    }
}

/// Tell the cloud how a sign-in ended, and say the same in a word for the
/// log. A result goes back once; a failure is told once.
fn settle(desk: &dyn Desk, outcome: Outcome) -> &'static str {
    let failed = |report: Report| {
        let _ = desk.report(&report);
    };
    match outcome {
        Outcome::Got(value) => match desk.finish(&value) {
            Ok(()) => "connected",
            Err(_) => "signed in, but the cloud did not save it",
        },
        Outcome::Stopped => "stopped",
        Outcome::Missing => {
            failed(Report { phase: "failed", missing_cli: true, ..Report::default() });
            "the agent isn't installed here"
        }
        Outcome::Failed(said) => {
            failed(Report { phase: "failed", error: said, ..Report::default() });
            "failed"
        }
    }
}

/// When a sign-in must be over on this computer: the cloud's expiry, and
/// never more than ten minutes away.
fn deadline_for(expires_at: chrono::DateTime<chrono::Utc>, now: chrono::DateTime<chrono::Utc>) -> Option<Instant> {
    let left = (expires_at - now).to_std().ok()?;
    Some(Instant::now() + left.min(LONGEST))
}

/// Keeps a sign-in counted as running here until its thread ends.
struct Slot {
    active: Arc<Mutex<HashSet<String>>>,
    id: String,
}

impl Drop for Slot {
    fn drop(&mut self) {
        if let Ok(mut a) = self.active.lock() {
            a.remove(&self.id);
        }
    }
}

fn start(cloud: &Arc<Cloud>, job: Waiting, active: &Arc<Mutex<HashSet<String>>>, running: &Arc<AtomicBool>) {
    let Some(deadline) = deadline_for(job.expires_at, chrono::Utc::now()) else { return };
    let Ok(mut held) = active.lock() else { return };
    if held.len() >= AT_ONCE || !held.insert(job.id.clone()) {
        return;
    }
    drop(held);
    let slot = Slot { active: active.clone(), id: job.id.clone() };
    let (cloud, running) = (cloud.clone(), running.clone());
    let spawned = std::thread::Builder::new().name("aura-signin-run".into()).spawn(move || {
        let _slot = slot;
        let short: String = job.id.chars().take(8).collect();
        let agent = label(&job.agent);
        eprintln!("{} {agent} sign-in {short} started on this computer", "[sign-in]".cyan());
        let desk = CloudDesk { cloud: &cloud, id: &job.id };
        let ended = settle(&desk, run(&desk, &job.agent, deadline, &running));
        eprintln!("{} {agent} sign-in {short}: {ended}", "[sign-in]".cyan());
    });
    if spawned.is_err() {
        eprintln!("{} could not start a sign-in thread", "[sign-in]".yellow());
    }
}

fn drive(cloud: Arc<Cloud>, running: Arc<AtomicBool>) {
    let active: Arc<Mutex<HashSet<String>>> = Arc::default();
    let mut last_error: Option<String> = None;
    let mut said_unsupported = false;
    while running.load(Ordering::SeqCst) {
        let pause = match waiting(&cloud) {
            Asked::Some(jobs) => {
                last_error = None;
                said_unsupported = false;
                for job in jobs {
                    let busy = active.lock().map(|a| a.len() >= AT_ONCE || a.contains(&job.id)).unwrap_or(true);
                    if busy {
                        continue;
                    }
                    match claim(&cloud, &job.id) {
                        Ok(taken) => start(&cloud, taken, &active, &running),
                        Err(why) => eprintln!("{} {why}", "[sign-in]".dimmed()),
                    }
                }
                POLL
            }
            Asked::Unsupported => {
                if !said_unsupported {
                    eprintln!("{} the cloud does not run agent sign-ins on computers yet", "[sign-in]".dimmed());
                    said_unsupported = true;
                }
                POLL_UNSUPPORTED
            }
            Asked::Failed(why) => {
                if last_error.as_deref() != Some(why.as_str()) {
                    eprintln!("{} {why}", "[sign-in]".yellow());
                    last_error = Some(why);
                }
                POLL
            }
        };
        let until = Instant::now() + pause;
        while running.load(Ordering::SeqCst) && Instant::now() < until {
            std::thread::sleep(TICK);
        }
    }
}

/// Start running web sign-ins for this computer, beside the chats. Only a
/// computer with a machine token is a place a sign-in can be queued on.
pub fn spawn(running: Arc<AtomicBool>) -> Option<JoinHandle<()>> {
    let cloud = match Cloud::connect() {
        Ok(c) => Arc::new(c),
        Err(why) => {
            eprintln!("{} not running agent sign-ins: {why}", "[sign-in]".dimmed());
            return None;
        }
    };
    eprintln!("{} members can sign their agents in on this computer from the web", "[sign-in]".cyan());
    std::thread::Builder::new().name("aura-signin".into()).spawn(move || drive(cloud, running)).ok()
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::{Desk, Next, Report};
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    /// A fake agent CLI: `script` run by `/bin/sh`.
    pub fn fake_cli(dir: &Path, name: &str, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// A cloud that hands over one pasted code once the code box is up, or
    /// says stop after a number of reports.
    pub struct Scripted {
        code: Mutex<Option<String>>,
        stop_after: Option<usize>,
        reports: Mutex<Vec<Report>>,
        code_given_at: Mutex<Option<usize>>,
        pub finished: Mutex<Vec<String>>,
    }

    impl Scripted {
        fn new(code: Option<&str>, stop_after: Option<usize>) -> Scripted {
            Scripted {
                code: Mutex::new(code.map(str::to_string)),
                stop_after,
                reports: Mutex::default(),
                code_given_at: Mutex::default(),
                finished: Mutex::default(),
            }
        }

        pub fn pasting(code: &str) -> Scripted {
            Scripted::new(Some(code), None)
        }

        pub fn stopping_after(reports: usize) -> Scripted {
            Scripted::new(None, Some(reports))
        }

        pub fn reports(&self) -> Vec<Report> {
            self.reports.lock().unwrap().clone()
        }

        /// How many reports had come in when the code was handed over.
        pub fn code_given_at(&self) -> Option<usize> {
            *self.code_given_at.lock().unwrap()
        }
    }

    impl Desk for Scripted {
        fn report(&self, report: &Report) -> Result<Next, String> {
            let mut reports = self.reports.lock().unwrap();
            reports.push(report.clone());
            if self.stop_after.is_some_and(|n| reports.len() >= n) {
                return Ok(Next { stop: true, code: None });
            }
            let code = if report.code_prompt.is_some() { self.code.lock().unwrap().take() } else { None };
            if code.is_some() {
                *self.code_given_at.lock().unwrap() = Some(reports.len());
            }
            Ok(Next { stop: false, code })
        }

        fn finish(&self, value: &str) -> Result<(), String> {
            self.finished.lock().unwrap().push(value.to_string());
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::Scripted;
    use super::*;

    #[test]
    fn a_report_carries_only_what_it_has() {
        let r = Report { phase: "browser", url: Some("https://claude.ai/x".into()), code_prompt: Some("required"), ..Report::default() };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            serde_json::json!({ "phase": "browser", "url": "https://claude.ai/x", "code_prompt": "required", "missing_cli": false })
        );
    }

    #[test]
    fn what_the_cloud_says_next_reads_with_or_without_a_code() {
        let n: Next = serde_json::from_str(r#"{"stop":false,"code":"abc#st"}"#).unwrap();
        assert_eq!((n.stop, n.code.as_deref()), (false, Some("abc#st")));
        let n: Next = serde_json::from_str(r#"{"stop":true}"#).unwrap();
        assert!(n.stop && n.code.is_none());
        let list: WaitingList = serde_json::from_str(
            r#"{"signins":[{"id":"5b0e4b1e-0000-4000-8000-000000000001","agent":"codex","expires_at":"2026-11-13T10:00:00Z"}]}"#,
        )
        .unwrap();
        assert_eq!(list.signins[0].agent, "codex");
    }

    #[test]
    fn a_sign_in_never_runs_past_its_expiry_or_ten_minutes() {
        let now = chrono::Utc::now();
        assert!(deadline_for(now - chrono::Duration::seconds(1), now).is_none());
        let soon = deadline_for(now + chrono::Duration::seconds(30), now).unwrap();
        assert!(soon <= Instant::now() + Duration::from_secs(31));
        let far = deadline_for(now + chrono::Duration::hours(3), now).unwrap();
        assert!(far <= Instant::now() + LONGEST + Duration::from_secs(1));
    }

    #[test]
    fn the_result_goes_back_once_and_a_failure_is_told_once() {
        let desk = Scripted::pasting("x");
        assert_eq!(settle(&desk, Outcome::Got("value".into())), "connected");
        assert_eq!(*desk.finished.lock().unwrap(), ["value"]);
        assert!(desk.reports().is_empty());

        let desk = Scripted::pasting("x");
        settle(&desk, Outcome::Missing);
        assert_eq!(desk.reports(), [Report { phase: "failed", missing_cli: true, ..Report::default() }]);

        let desk = Scripted::pasting("x");
        settle(&desk, Outcome::Failed(Some("Invalid code".into())));
        assert_eq!(desk.reports(), [Report { phase: "failed", error: Some("Invalid code".into()), ..Report::default() }]);

        let desk = Scripted::pasting("x");
        settle(&desk, Outcome::Stopped);
        assert!(desk.reports().is_empty() && desk.finished.lock().unwrap().is_empty());
    }

    #[test]
    fn an_agent_this_computer_cannot_sign_in_fails_without_running_anything() {
        let desk = Scripted::pasting("x");
        assert_eq!(run(&desk, "gemini", Instant::now() + TICK, &AtomicBool::new(true)), Outcome::Failed(None));
        assert!(desk.reports().is_empty());
    }

    #[test]
    fn nothing_a_sign_in_shows_or_is_given_is_logged() {
        for (name, src) in [
            ("mod.rs", include_str!("mod.rs")),
            ("claude.rs", include_str!("claude.rs")),
            ("codex.rs", include_str!("codex.rs")),
            ("pty.rs", include_str!("pty.rs")),
        ] {
            let code = src.split("#[cfg(test)]").next().unwrap();
            for line in code.lines().filter(|l| l.contains("println!") || l.contains("log::") || l.contains("tracing::")) {
                for secret in ["url", "code", "token", "value", "screen", "raw", "said"] {
                    assert!(
                        !line.contains(&format!("{{{secret}")) && !line.contains(&format!(", {secret}")),
                        "{name} logs `{secret}`: {line}"
                    );
                }
            }
        }
    }
}
