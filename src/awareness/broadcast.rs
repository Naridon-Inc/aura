//! Cross-machine broadcast for the awareness plane (AURA-15 / M3b).
//!
//! [`super::emit`] captures events locally; this module is the boundary where
//! they actually leave the box — and where peers' events arrive. Everything
//! routes through [`crate::live_transport::LiveTransport`] (cloud relay today,
//! the sovereign seed later), and everything obeys the repo's
//! [`super::policy::SharePolicy`]:
//!
//! - outbound events are filtered through [`super::policy::outbound_view`]
//!   (and re-signed when fields were stripped) — the wire never sees more
//!   than the dial allows;
//! - `off` disables both directions — the repo is fully dark;
//! - pulled peer events land in a SEPARATE cache (`.aura/awareness/remote.jsonl`),
//!   never in the local emission log, so re-broadcast loops are impossible by
//!   construction.
//!
//! Both directions are throttled and best-effort: a missing relay, an old
//! server, or a dead network must never fail an emit, a hook, or a feed read.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::model::AwarenessEvent;
use super::{policy, store};
use crate::live_events;

/// Cap on the remote cache — same ephemeral-signal bound as the local store.
const REMOTE_MAX: usize = 500;
/// At most one push attempt per window (hooks fire constantly; the relay
/// doesn't need every heartbeat instantly).
const PUSH_EVERY_MS: u64 = 20_000;
/// At most one pull attempt per window (the desktop polls the feed every few
/// seconds; one HTTP round-trip per window keeps reads snappy).
const PULL_EVERY_MS: u64 = 15_000;
/// Largest batch a single push sends (matches the relay's per-request cap).
const PUSH_BATCH_MAX: usize = 100;

fn remote_path() -> PathBuf {
    PathBuf::from(".aura").join("awareness").join("remote.jsonl")
}

fn state_path() -> PathBuf {
    PathBuf::from(".aura").join("awareness").join("sync_state.json")
}

/// Durable sync cursors. `ts`-based on the push side (our own clock), relay
/// row-id on the pull side (the server's monotonic cursor — clock-skew safe).
#[derive(Serialize, Deserialize, Default, Clone, Copy)]
struct SyncState {
    /// Newest local event `ts` already pushed.
    #[serde(default)]
    last_pushed_ts: u64,
    #[serde(default)]
    last_push_attempt_ms: u64,
    /// Relay cursor for pulls (server row id).
    #[serde(default)]
    pull_cursor: i64,
    #[serde(default)]
    last_pull_attempt_ms: u64,
}

fn load_state() -> SyncState {
    fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_state(state: &SyncState) {
    let path = state_path();
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if let Ok(body) = serde_json::to_string(state) {
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, body).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
}

/// Peers' events pulled from the relay (never our own emissions).
pub fn read_remote() -> Vec<AwarenessEvent> {
    let Ok(body) = fs::read_to_string(remote_path()) else {
        return Vec::new();
    };
    body.lines()
        .filter_map(|l| {
            let t = l.trim();
            if t.is_empty() {
                None
            } else {
                serde_json::from_str::<AwarenessEvent>(t).ok()
            }
        })
        .collect()
}

fn write_remote(events: &[AwarenessEvent]) {
    let path = remote_path();
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let tmp = path.with_extension("jsonl.tmp");
    {
        let Ok(mut f) = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)
        else {
            return;
        };
        for ev in events {
            if let Ok(line) = serde_json::to_string(ev) {
                let _ = writeln!(f, "{line}");
            }
        }
        let _ = f.sync_all();
    }
    let _ = fs::rename(&tmp, &path);
}

/// The full feed every reader should see: local emissions + pulled peer
/// events, deduplicated by event id (local copy wins). This is the single
/// merge point — `api`/`cmd` read through here so the CLI, MCP tools, and
/// desktop all see the same merged radar.
pub fn merged_events() -> Vec<AwarenessEvent> {
    let mut all = store::read_all();
    let seen: HashSet<String> = all.iter().map(|e| e.id.clone()).collect();
    all.extend(read_remote().into_iter().filter(|e| !seen.contains(&e.id)));
    all
}

/// Push local events newer than the cursor through the active transport,
/// filtered per the repo policy. Throttled unless `force`. Returns how many
/// events went out (0 covers "dark", "not due", and "nothing new").
pub fn push_pending(force: bool) -> Result<usize, String> {
    let pol = policy::load();
    if !pol.allows_broadcast() {
        return Ok(0);
    }
    let mut state = load_state();
    let now = live_events::now_ms();
    if !force && now.saturating_sub(state.last_push_attempt_ms) < PUSH_EVERY_MS {
        return Ok(0);
    }
    // Stamp the attempt up front so a failing relay backs off too.
    state.last_push_attempt_ms = now;
    save_state(&state);

    let mut pending: Vec<AwarenessEvent> = store::read_all()
        .into_iter()
        .filter(|e| e.ts > state.last_pushed_ts)
        .filter_map(|e| policy::outbound_view(&e, pol))
        .collect();
    if pending.is_empty() {
        return Ok(0);
    }
    // Newest events win the batch cap — they're the live signal.
    pending.sort_by(|a, b| a.ts.cmp(&b.ts));
    if pending.len() > PUSH_BATCH_MAX {
        let cut = pending.len() - PUSH_BATCH_MAX;
        pending.drain(0..cut);
    }

    crate::live_transport::active().push_awareness(&pending)?;

    state.last_pushed_ts = pending.iter().map(|e| e.ts).max().unwrap_or(state.last_pushed_ts);
    save_state(&state);
    Ok(pending.len())
}

/// Pull peers' events newer than the relay cursor into the remote cache.
/// Throttled unless `force`. Returns how many new events landed.
pub fn pull_remote(force: bool) -> Result<usize, String> {
    let pol = policy::load();
    if !pol.allows_broadcast() {
        return Ok(0);
    }
    let mut state = load_state();
    let now = live_events::now_ms();
    if !force && now.saturating_sub(state.last_pull_attempt_ms) < PULL_EVERY_MS {
        return Ok(0);
    }
    state.last_pull_attempt_ms = now;
    save_state(&state);

    let (events, cursor) = crate::live_transport::active().pull_awareness(state.pull_cursor)?;

    let mut fresh = 0usize;
    if !events.is_empty() {
        // Our own events echo back from the relay; the local store already has
        // them, so id-dedup against BOTH stores keeps the cache peers-only.
        let mut cache = read_remote();
        let mut seen: HashSet<String> = cache.iter().map(|e| e.id.clone()).collect();
        seen.extend(store::read_all().into_iter().map(|e| e.id));
        for ev in events {
            if seen.insert(ev.id.clone()) {
                cache.push(ev);
                fresh += 1;
            }
        }
        if fresh > 0 {
            cache.sort_by(|a, b| a.ts.cmp(&b.ts));
            if cache.len() > REMOTE_MAX {
                let cut = cache.len() - REMOTE_MAX;
                cache.drain(0..cut);
            }
            write_remote(&cache);
        }
    }

    state.pull_cursor = cursor.max(state.pull_cursor);
    save_state(&state);
    Ok(fresh)
}

/// Fire-and-forget background sync, called after an emit. Spawns a detached
/// `aura radar sync --quiet` so hooks and agents never wait on the network.
/// Cheap guards keep the common case to two small file reads and no process.
pub fn maybe_spawn_sync() {
    if cfg!(test) {
        return; // unit tests emit in tempdirs; never spawn from there
    }
    if !policy::load().allows_broadcast() {
        return;
    }
    let state = load_state();
    let now = live_events::now_ms();
    let push_due = now.saturating_sub(state.last_push_attempt_ms) >= PUSH_EVERY_MS;
    let pull_due = now.saturating_sub(state.last_pull_attempt_ms) >= PULL_EVERY_MS;
    if !push_due && !pull_due {
        return;
    }
    // No relay configured → nothing to spawn for.
    let cfg = crate::config::ConfigManager::load();
    let has_token =
        cfg.cloud_api_token.is_some() || std::env::var("AURA_CLOUD_TOKEN").is_ok();
    if cfg.cloud_url.is_none() || !has_token {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let _ = std::process::Command::new(exe)
        .args(["radar", "sync", "--quiet"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::awareness::model::AwarenessKind;
    use crate::TEST_CWD_LOCK as SERIAL;

    struct CwdGuard(std::path::PathBuf);
    impl Drop for CwdGuard {
        fn drop(&mut self) {
            let _ = std::env::set_current_dir(&self.0);
        }
    }

    fn enter_tmp() -> (CwdGuard, tempfile::TempDir) {
        let g = CwdGuard(std::env::current_dir().expect("cwd"));
        let d = tempfile::tempdir().expect("tmp");
        std::env::set_current_dir(d.path()).expect("cd");
        (g, d)
    }

    fn ev(id: &str, actor: &str, ts: u64) -> AwarenessEvent {
        AwarenessEvent {
            id: id.into(),
            actor: actor.into(),
            is_agent: true,
            kind: AwarenessKind::Editing,
            repo: "demo/repo".into(),
            branch: "main".into(),
            file: Some("src/auth.rs".into()),
            symbol: Some("login".into()),
            intent: None,
            impact: None,
            ts,
            key_id: None,
            sig: None,
        }
    }

    #[test]
    fn merged_events_dedups_by_id_and_keeps_peers() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();

        // Local store: my event. Remote cache: a peer's event + an echo of mine.
        assert!(store::append(&ev("mine", "claude@here", 10)));
        write_remote(&[ev("mine", "claude@here", 10), ev("peer", "ashiq", 20)]);

        let merged = merged_events();
        assert_eq!(merged.len(), 2, "echo of my own event must dedup away");
        assert!(merged.iter().any(|e| e.id == "peer"));
    }

    #[test]
    fn push_is_a_noop_when_dark() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();

        policy::save(policy::SharePolicy::Off).expect("save policy");
        assert!(store::append(&ev("e1", "claude@here", 10)));
        // Off short-circuits BEFORE the transport — no network in a unit test.
        assert_eq!(push_pending(true).expect("push"), 0);
        assert_eq!(pull_remote(true).expect("pull"), 0);
    }

    #[test]
    fn push_throttles_between_attempts() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();

        // Symbols policy, but a fresh attempt stamp inside the window →
        // the throttle gate returns before touching the transport.
        let state = SyncState {
            last_push_attempt_ms: live_events::now_ms(),
            last_pull_attempt_ms: live_events::now_ms(),
            ..Default::default()
        };
        save_state(&state);
        assert!(store::append(&ev("e1", "claude@here", 10)));
        assert_eq!(push_pending(false).expect("push"), 0);
        assert_eq!(pull_remote(false).expect("pull"), 0);
    }

    #[test]
    fn remote_cache_is_capped() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();

        let many: Vec<AwarenessEvent> = (0..REMOTE_MAX + 50)
            .map(|i| ev(&format!("e{i}"), "ashiq", i as u64))
            .collect();
        write_remote(&many);
        // write_remote itself doesn't cap (pull_remote does), but reading back
        // must round-trip whatever was written.
        assert_eq!(read_remote().len(), REMOTE_MAX + 50);
    }
}
