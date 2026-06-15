//! Append-only on-disk log for awareness events (`.aura/awareness/events.jsonl`).
//! Mirrors the durable-JSONL pattern used by `live_conflicts.rs`. The store is
//! cwd-relative (like the conflict store) and bounded to the most recent
//! [`MAX_EVENTS`] so a long Live session can't grow it without limit.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use super::model::{AwarenessEvent, AwarenessKind};

/// Keep at most this many events on disk (newest wins). This is the awareness
/// plane's tombstone/bloat guard — events are ephemeral situational signal, not
/// permanent history.
const MAX_EVENTS: usize = 500;

fn store_path() -> PathBuf {
    PathBuf::from(".aura").join("awareness").join("events.jsonl")
}

pub fn read_all() -> Vec<AwarenessEvent> {
    let Ok(body) = fs::read_to_string(store_path()) else {
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

fn write_all(events: &[AwarenessEvent]) -> bool {
    let path = store_path();
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return false;
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
            return false;
        };
        for ev in events {
            let Ok(line) = serde_json::to_string(ev) else {
                return false;
            };
            if writeln!(f, "{line}").is_err() {
                return false;
            }
        }
        let _ = f.sync_all();
    }
    fs::rename(&tmp, &path).is_ok()
}

/// Is there already an event from `actor` about the same `kind` + target
/// (matched on symbol when present, else file) within `within_ms` of `now`?
/// This is the anti-thrash / firehose guard: auto-emitters call it so a tight
/// edit loop produces one "editing X" signal, not one per keystroke. Matching is
/// case-insensitive on actor and target.
pub fn has_recent(
    actor: &str,
    kind: AwarenessKind,
    file: Option<&str>,
    symbol: Option<&str>,
    within_ms: u64,
    now: u64,
) -> bool {
    let target = symbol.or(file).map(|s| s.to_ascii_lowercase());
    let Some(target) = target else {
        return false;
    };
    read_all().iter().rev().any(|e| {
        e.kind == kind
            && now.saturating_sub(e.ts) <= within_ms
            && e.actor.eq_ignore_ascii_case(actor)
            && e
                .symbol
                .as_deref()
                .or(e.file.as_deref())
                .map(|t| t.eq_ignore_ascii_case(&target))
                .unwrap_or(false)
    })
}

/// How many events `actor` has landed within `within_ms` of `now`, across ALL
/// targets. This is the global firehose guard ([`super::emit::emit_throttled`]):
/// the per-target check above can't stop an agent sweeping many *distinct*
/// files in one refactor, so the rate cap counts per actor instead. Actor match
/// is case-insensitive, consistent with [`has_recent`].
pub fn count_recent_by_actor(actor: &str, within_ms: u64, now: u64) -> usize {
    read_all()
        .iter()
        .filter(|e| {
            now.saturating_sub(e.ts) <= within_ms && e.actor.eq_ignore_ascii_case(actor)
        })
        .count()
}

/// Append an event, keeping only the most recent [`MAX_EVENTS`]. Returns `true`
/// when the write succeeded.
pub fn append(ev: &AwarenessEvent) -> bool {
    let mut events = read_all();
    events.push(ev.clone());
    if events.len() > MAX_EVENTS {
        let cut = events.len() - MAX_EVENTS;
        events.drain(0..cut);
    }
    write_all(&events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::awareness::model::AwarenessKind;
    // Same serial lock as every other cwd-mutating test in the crate — the
    // store is cwd-relative, so parallel tests would race on the process cwd.
    use crate::TEST_CWD_LOCK as SERIAL;

    struct CwdGuard(PathBuf);
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

    fn ev(actor: &str, kind: AwarenessKind, ts: u64) -> AwarenessEvent {
        AwarenessEvent {
            id: format!("id-{ts}"),
            actor: actor.into(),
            is_agent: true,
            kind,
            repo: "demo/repo".into(),
            branch: "main".into(),
            file: Some("src/auth.rs".into()),
            symbol: Some("login".into()),
            intent: Some("harden token check".into()),
            impact: None,
            ts,
            key_id: None,
            sig: None,
        }
    }

    #[test]
    fn append_reads_back_in_order() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();

        assert!(append(&ev("claude", AwarenessKind::Editing, 1)));
        assert!(append(&ev("ashiq", AwarenessKind::Intent, 2)));

        let rows = read_all();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].actor, "claude");
        assert_eq!(rows[1].kind, AwarenessKind::Intent);
    }

    #[test]
    fn has_recent_matches_within_window_and_target() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();
        // claude edited `login` at ts=1000; "now" is 2000.
        assert!(append(&ev("claude", AwarenessKind::Editing, 1000)));

        // same actor + kind + symbol, inside the window → recent.
        assert!(has_recent("claude", AwarenessKind::Editing, Some("src/auth.rs"), Some("login"), 5000, 2000));
        // actor + symbol match is case-insensitive.
        assert!(has_recent("CLAUDE", AwarenessKind::Editing, None, Some("LOGIN"), 5000, 2000));
        // outside the window → not recent (anti-thrash only suppresses a tight loop).
        assert!(!has_recent("claude", AwarenessKind::Editing, None, Some("login"), 500, 2000));
        // different symbol, kind, or actor are all distinct targets.
        assert!(!has_recent("claude", AwarenessKind::Editing, None, Some("logout"), 5000, 2000));
        assert!(!has_recent("claude", AwarenessKind::Intent, None, Some("login"), 5000, 2000));
        assert!(!has_recent("ashiq", AwarenessKind::Editing, None, Some("login"), 5000, 2000));
    }

    #[test]
    fn count_recent_by_actor_is_global_and_windowed() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();

        // Three events across DISTINCT targets from claude, one stale, plus a
        // peer's event — the count is per-actor, across all targets, windowed.
        let mut a = ev("claude", AwarenessKind::Editing, 1000);
        a.symbol = Some("login".into());
        let mut b = ev("claude", AwarenessKind::Editing, 1500);
        b.symbol = Some("logout".into());
        let mut stale = ev("claude", AwarenessKind::Editing, 10);
        stale.symbol = Some("old".into());
        let peer = ev("ashiq", AwarenessKind::Editing, 1600);
        for e in [&a, &b, &stale, &peer] {
            assert!(append(e));
        }

        assert_eq!(count_recent_by_actor("claude", 1000, 2000), 2);
        assert_eq!(count_recent_by_actor("CLAUDE", 1000, 2000), 2, "case-insensitive");
        assert_eq!(count_recent_by_actor("ashiq", 1000, 2000), 1);
        assert_eq!(count_recent_by_actor("claude", 10_000, 2000), 3, "wider window sees stale");
    }

    #[test]
    fn has_recent_falls_back_to_file_without_symbol() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();
        let mut e = ev("claude", AwarenessKind::Editing, 1000);
        e.symbol = None; // file-only event (e.g. whole-file edit)
        assert!(append(&e));

        // matches on file when neither side has a symbol.
        assert!(has_recent("claude", AwarenessKind::Editing, Some("src/auth.rs"), None, 5000, 2000));
        // no target at all → nothing to match, never throttle.
        assert!(!has_recent("claude", AwarenessKind::Editing, None, None, 5000, 2000));
    }
}
