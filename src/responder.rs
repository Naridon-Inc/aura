// Auto-responder: spawns `claude -p` in the background when new Aura messages arrive,
// so a peer Claude session can auto-reply without the user being at the keyboard.
//
// Driven by AutoResponderConfig in the user's aura config. Off by default.
// Cooldown + daily cap prevent runaway token spend.

use crate::config::{AuraConfig, AutoResponderConfig};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Default)]
struct ResponderState {
    last_spawn_at: u64,   // unix seconds
    daily_count: u32,
    daily_reset_at: u64,  // unix seconds — start of current UTC day
}

fn state_path() -> PathBuf {
    PathBuf::from(".aura/live/responder_state.json")
}

fn load_state() -> ResponderState {
    std::fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_state(state: &ResponderState) {
    if let Some(parent) = state_path().parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(state_path(), json);
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn start_of_utc_day(ts: u64) -> u64 {
    ts - (ts % 86_400)
}

/// Check if a spawn is allowed under cooldown + daily cap, and if so, spawn `claude -p`.
/// Returns true if a process was spawned.
pub fn maybe_spawn(unread_count: u64, repo: &str) -> bool {
    if unread_count == 0 {
        return false;
    }

    let cfg = crate::config::ConfigManager::load();
    let responder = match cfg.auto_responder.as_ref() {
        Some(r) if r.enabled => r.clone(),
        _ => return false,
    };

    let now = now_secs();
    let mut state = load_state();

    // Reset daily counter if a new UTC day has begun
    let today = start_of_utc_day(now);
    if state.daily_reset_at < today {
        state.daily_reset_at = today;
        state.daily_count = 0;
    }

    if state.daily_count >= responder.daily_cap {
        return false;
    }

    if now.saturating_sub(state.last_spawn_at) < responder.cooldown_secs {
        return false;
    }

    if !spawn_claude(&responder, repo, unread_count) {
        return false;
    }

    state.last_spawn_at = now;
    state.daily_count += 1;
    save_state(&state);
    true
}

fn spawn_claude(cfg: &AutoResponderConfig, repo: &str, unread: u64) -> bool {
    let prompt = format!(
        "You have {n} unread Aura team message{plural} in repo {repo}. \
         Run `aura msg list` to read them, then reply with `aura msg send \"...\"` if a response is warranted. \
         Be concise. Do NOT make code changes unless the message explicitly asks for one. \
         If the message needs human input, send a brief acknowledgement and stop.",
        n = unread,
        plural = if unread == 1 { "" } else { "s" },
        repo = repo,
    );

    let mut cmd = Command::new(&cfg.command);
    cmd.arg("-p").arg(&prompt);
    if let Some(session) = cfg.resume_session.as_ref() {
        if !session.is_empty() {
            cmd.arg("--resume").arg(session);
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    match cmd.spawn() {
        Ok(_) => true,
        Err(_) => false,
    }
}

/// Convenience for callers that already have the AuraConfig loaded.
pub fn _is_enabled(cfg: &AuraConfig) -> bool {
    cfg.auto_responder.as_ref().map(|r| r.enabled).unwrap_or(false)
}
