//! `aura join AURA-XXXX-XXXX` and `aura leave` — connect a computer somebody
//! already has to their Aura team in one step, and take it off again.
//!
//! The person asks Aura for a code, pastes one line on the computer, and it is
//! connected: the code is spent for a token that opens this one computer and
//! nothing else, the token is written where only its owner can read it, and a
//! service keeps Aura running through reboots. Nothing listens for inbound
//! connections; the computer only ever calls out.
//!
//! Run twice, it says it is already connected and makes sure the service is
//! running. `aura leave` tells Aura to forget the computer, stops the service
//! and deletes the token.

mod agent;
mod claim;
mod cloud;
mod code;
mod conf;
mod launchd;
mod layout;
mod machine;
mod service;

use colored::Colorize;
use serde::Serialize;

pub use code::looks_like_code;
use layout::Layout;

/// What `--json` prints: one line, for the app.
#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub ok: bool,
    /// `connected`, `already_connected`, `left`, `not_connected`, `refused`
    /// or `failed`.
    pub state: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    /// Whether the service will find Claude Code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_ready: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

impl Report {
    fn failed(state: &'static str, message: impl Into<String>) -> Self {
        Report { ok: false, state, message: message.into(), ..Default::default() }
    }
}

/// `aura join <code>`. Returns the process exit code.
pub fn join(raw_code: &str, json: bool) -> i32 {
    if !json {
        println!("Connecting this computer to Aura…");
    }
    finish(join_inner(raw_code), json)
}

/// `aura join -`: the code arrives on the first line of stdin instead of the
/// command line. Anything on a command line is in the process list, where any
/// other account on the machine can read it, and a code read there could be
/// spent first from somewhere else. The app and the join script both hand the
/// code over this way.
pub fn join_from_stdin(json: bool) -> i32 {
    match read_code(std::io::stdin().lock()) {
        Some(raw) => join(&raw, json),
        None => finish(
            Report::failed("refused", "No code arrived. Copy the line from Aura again and paste it here."),
            json,
        ),
    }
}

/// One short line, at most. A code is 14 characters; nothing past 128 bytes
/// is read.
fn read_code(input: impl std::io::BufRead) -> Option<String> {
    use std::io::{BufRead, Read};
    let mut line = String::new();
    input.take(128).read_line(&mut line).ok()?;
    let line = line.trim();
    (!line.is_empty()).then(|| line.to_string())
}

/// `aura leave`. Returns the process exit code.
pub fn leave(json: bool) -> i32 {
    finish(leave_inner(), json)
}

fn finish(r: Report, json: bool) -> i32 {
    let code = if r.ok { 0 } else { 1 };
    if json {
        println!("{}", serde_json::to_string(&r).unwrap_or_else(|_| "{\"ok\":false}".into()));
        return code;
    }
    if r.ok {
        println!("{} {}", "✓".green().bold(), r.message);
    } else {
        eprintln!("{} {}", "✗".red().bold(), r.message);
    }
    for n in &r.notes {
        println!("  {n}");
    }
    code
}

fn cloud_base() -> Result<String, String> {
    let config = crate::config::ConfigManager::load();
    cloud::checked_base(&crate::cloud_endpoint::origin_or_public(config.cloud_url.as_deref()))
}

fn join_inner(raw_code: &str) -> Report {
    let Some(code) = code::PairCode::parse(raw_code) else {
        return Report::failed(
            "refused",
            "That isn't an Aura code. Codes look like AURA-K7QM-3XPT — copy the line from Aura again.",
        );
    };
    let l = match layout::resolve() {
        Ok(l) => l,
        Err(e) => return Report::failed("failed", e),
    };
    let client = match cloud::client() {
        Ok(c) => c,
        Err(e) => return Report::failed("failed", e),
    };

    // Joined already? Say so, and make sure it's running — that is what
    // running the line a second time is for.
    let mut notes = Vec::new();
    if let Ok(text) = std::fs::read_to_string(&l.conf) {
        let held = conf::parse(&text);
        if !held.joined_by_pair() {
            return Report::failed(
                "refused",
                "This computer is already set up as an Aura computer, so nothing was changed.",
            );
        }
        if let (Some(token), Some(base)) = (held.runner_token.as_deref(), held.cloud_url.as_deref()) {
            match cloud::still_connected(&client, base, token) {
                cloud::Alive::Yes => return already_connected(&l, held.place_id),
                cloud::Alive::Gone => {
                    notes.push("This computer had been removed from Aura, so it was connected again.".into())
                }
                cloud::Alive::Unknown(e) => return Report::failed("failed", e),
            }
        }
    }

    let base = match cloud_base() {
        Ok(b) => b,
        Err(e) => return Report::failed("failed", e),
    };
    if let Err(e) = service::ensure_account(&l) {
        return Report::failed("failed", e);
    }
    let claim = match claim::claim_for(&l.pending, code.lookup(), None) {
        Ok(c) => c,
        Err(e) => return Report::failed("failed", e),
    };
    let machine = machine::this_machine();
    let joined = match cloud::redeem(&client, &base, &code.display(), &claim, &machine) {
        Ok(j) => j,
        Err(cloud::RedeemError::Refused(m)) => {
            claim::forget(&l.pending, code.lookup());
            return Report::failed("refused", m);
        }
        // The claim is kept: if the code was spent and the answer lost, the
        // same line run again finishes the join.
        Err(cloud::RedeemError::Unreachable(m)) => return Report::failed("failed", m),
    };

    let mut report = Report {
        org: Some(joined.org_name.clone()),
        name: Some(joined.name.clone()),
        place_id: Some(joined.place_id.clone()),
        scope: Some(joined.scope.clone()),
        service: Some(l.describe()),
        ..Default::default()
    };
    match keep(&l, &base, &joined) {
        Ok(started) => notes.extend(started),
        Err(e) => {
            report.state = "failed";
            report.message = format!(
                "Aura accepted this computer, but it couldn't be set up to stay connected: {e}. \
                 Run the same line again to finish."
            );
            return report;
        }
    }
    claim::forget(&l.pending, code.lookup());
    notes.extend(agent_note(&l));
    report.ok = true;
    report.state = "connected";
    report.message = format!("Connected to {}. You can close this window.", joined.org_name);
    report.agent_ready = Some(service::agent_ready(&l));
    report.notes.extend(notes);
    report
}

/// Write the token and the note, make the folders, start the service.
fn keep(l: &Layout, base: &str, joined: &cloud::Redeemed) -> Result<Vec<String>, String> {
    let text = conf::render(&conf::Conf {
        runner_token: joined.runner_token.clone(),
        place_id: joined.place_id.clone(),
        cloud_url: base.to_string(),
        workspaces: l.workspaces.display().to_string(),
    })?;
    conf::write_private(&l.conf, text.as_bytes(), None)?;
    let state = conf::State {
        place_id: joined.place_id.clone(),
        org_name: joined.org_name.clone(),
        name: joined.name.clone(),
        scope: joined.scope.clone(),
        cloud_url: base.to_string(),
        joined_at: chrono::Utc::now().to_rfc3339(),
        run_as: l.run_as.clone(),
    };
    let note = serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?;
    conf::write_private(&l.state, &note, None)?;
    start(l, &joined.name)
}

fn start(l: &Layout, name: &str) -> Result<Vec<String>, String> {
    let bin = std::env::current_exe().map_err(|e| format!("couldn't find Aura itself: {e}"))?;
    service::prepare(l)?;
    service::install(l, &bin, name)
}

fn already_connected(l: &Layout, place_id: Option<String>) -> Report {
    let state = conf::read_state(&l.state);
    let org = state.as_ref().map(|s| s.org_name.clone());
    let name = state.as_ref().map(|s| s.name.clone()).unwrap_or_else(|| "Computer".into());
    let mut report = Report {
        org: org.clone(),
        name: Some(name.clone()),
        place_id: place_id.or_else(|| state.as_ref().map(|s| s.place_id.clone())),
        scope: state.as_ref().map(|s| s.scope.clone()),
        service: Some(l.describe()),
        ..Default::default()
    };
    match start(l, &name) {
        Ok(notes) => report.notes = notes,
        Err(e) => {
            report.state = "failed";
            report.message = format!("This computer is connected, but Aura couldn't start here: {e}");
            return report;
        }
    }
    report.ok = true;
    report.state = "already_connected";
    report.message = match org {
        Some(o) => format!("Already connected to {o}. You can close this window."),
        None => "Already connected. You can close this window.".into(),
    };
    report.notes.extend(agent_note(l));
    report.agent_ready = Some(service::agent_ready(l));
    report.notes.push("To connect it somewhere else, run `aura leave` first.".into());
    report
}

/// Claude Code for the account Aura runs as: installed when missing, and a
/// line saying so either way it changed.
fn agent_note(l: &Layout) -> Option<String> {
    match agent::ensure(l) {
        agent::Outcome::Present => None,
        agent::Outcome::Installed => Some(format!("Installed Claude Code for {}.", l.run_as)),
        agent::Outcome::Missing(why) => Some(format!("{} {why}", claude_missing(l))),
    }
}

fn claude_missing(l: &Layout) -> String {
    if l.kind == layout::Kind::SystemdSystem && l.run_as == layout::SERVICE_ACCOUNT {
        format!(
            "Claude Code isn't installed for the '{}' account yet. Aura needs it to do work here.",
            l.run_as
        )
    } else {
        "Claude Code isn't installed on this computer yet. Aura needs it to do work here.".into()
    }
}

fn leave_inner() -> Report {
    let l = match layout::resolve() {
        Ok(l) => l,
        Err(e) => return Report::failed("failed", e),
    };
    let text = match std::fs::read_to_string(&l.conf) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let system = std::path::Path::new("/etc/aura-runner/computer.conf");
            if l.kind == layout::Kind::SystemdUser && system.exists() {
                return Report::failed(
                    "failed",
                    "This computer was connected with sudo. Run: sudo aura leave",
                );
            }
            // Nothing to revoke, but a half-finished join may have left a
            // service behind; clearing it is what "leave" means.
            let _ = service::remove(&l);
            let _ = service::remove_file(&l.state);
            return Report {
                ok: true,
                state: "not_connected",
                message: "This computer isn't connected to Aura.".into(),
                ..Default::default()
            };
        }
        Err(e) => return Report::failed("failed", format!("couldn't read {}: {e}", l.conf.display())),
    };
    let held = conf::parse(&text);
    if !held.joined_by_pair() {
        return Report::failed(
            "refused",
            "This computer was set up by Aura itself. Remove it in the Aura app instead.",
        );
    }
    let state = conf::read_state(&l.state);
    let name = state.as_ref().map(|s| s.name.clone()).unwrap_or_else(|| "this computer".into());
    let mut notes = Vec::new();

    // Stop first, so nothing is running on a token that's about to stop working.
    if let Err(e) = service::remove(&l) {
        return Report::failed("failed", format!("couldn't stop Aura on this computer: {e}"));
    }
    if let (Some(token), Some(base)) = (held.runner_token.as_deref(), held.cloud_url.as_deref()) {
        let told = cloud::client()
            .map(|c| cloud::remove_self(&c, base, token))
            .unwrap_or_else(cloud::Removed::Failed);
        match told {
            cloud::Removed::Done | cloud::Removed::AlreadyGone => {}
            cloud::Removed::NotOurs => notes.push(format!("Remove '{name}' in the Aura app too.")),
            cloud::Removed::Failed(e) => notes.push(format!(
                "{e} The token on this computer is deleted either way — remove '{name}' in the Aura app so it stops showing."
            )),
        }
    }
    for f in [&l.conf, &l.state] {
        if let Err(e) = service::remove_file(f) {
            return Report::failed("failed", e);
        }
    }
    let _ = std::fs::remove_dir_all(&l.pending);
    if l.workspaces.exists() {
        notes.push(format!(
            "Copies of your projects are still in {}. Delete that folder if you don't need them.",
            l.workspaces.display()
        ));
    }
    Report {
        ok: true,
        state: "left",
        message: match state.map(|s| s.org_name) {
            Some(org) => format!("This computer has left {org}."),
            None => "This computer has left Aura.".into(),
        },
        notes,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_code_on_stdin_is_one_short_line() {
        assert_eq!(super::read_code(&b"AURA-K7QM-3XPT\n"[..]).as_deref(), Some("AURA-K7QM-3XPT"));
        assert_eq!(super::read_code(&b"  AURA-K7QM-3XPT  \r\nmore\n"[..]).as_deref(), Some("AURA-K7QM-3XPT"));
        assert_eq!(super::read_code(&b""[..]), None);
        assert_eq!(super::read_code(&b"\n"[..]), None);
        let long = vec![b'A'; 4096];
        assert_eq!(super::read_code(&long[..]).map(|s| s.len()), Some(128));
    }

    use super::*;

    #[test]
    fn the_json_line_is_what_the_app_reads() {
        let r = Report {
            ok: true,
            state: "connected",
            message: "Connected to Acme. You can close this window.".into(),
            org: Some("Acme".into()),
            agent_ready: Some(true),
            ..Default::default()
        };
        let v: serde_json::Value = serde_json::to_value(&r).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["state"], "connected");
        assert_eq!(v["org"], "Acme");
        assert!(v.get("notes").is_none());
        assert!(v.get("place_id").is_none());
    }

    #[test]
    fn a_bad_code_is_refused_before_anything_is_touched() {
        let r = join_inner("not-a-code");
        assert!(!r.ok);
        assert_eq!(r.state, "refused");
    }
}
