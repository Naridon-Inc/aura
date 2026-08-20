//! Stable JSON surface for the awareness plane, shared by the CLI (`--json`), the
//! MCP tools (`aura_team_radar` / `aura_radar_emit`), and the desktop Tauri
//! command. One place owns the wire shape so every consumer — other agents, the
//! app — sees the same contract.

use serde_json::{json, Value};

use super::model::AwarenessEvent;
use super::{broadcast, conflict, emit, relevance};
use crate::live_events;

/// Recency cutoff for live, in-flight collisions (mirrors `conflict.rs`).
pub const CONFLICT_WINDOW_MS: u64 = 45 * 60 * 1000;

/// Recency cutoff for the ambient feed. The radar answers "who is working
/// near me *now*" — an event from six weeks ago answers nothing, and a feed
/// with no window silently ages into a list of unrelated paths that reads as
/// noise. Wider than the collision window (a teammate who touched this file
/// yesterday is still worth knowing about), far short of forever.
pub const FEED_WINDOW_MS: u64 = 24 * 60 * 60 * 1000;

/// JSON for one event — the model serializes directly; we keep this as the
/// single conversion point so callers never reach into the struct shape. A
/// computed `verified` flag is stamped on here (not a stored field): true when
/// the event's embedded pubkey re-derives its `key_id` and validates the
/// signature, so every reader — CLI, MCP, desktop — learns trust from one place.
pub fn event_json(e: &AwarenessEvent) -> Value {
    let mut v = serde_json::to_value(e).unwrap_or(Value::Null);
    if let Some(obj) = v.as_object_mut() {
        obj.insert("verified".into(), Value::Bool(super::verify::verify_event(e)));
    }
    v
}

/// JSON for one reasoned collision.
pub fn collision_json(c: &conflict::Collision) -> Value {
    json!({
        "severity": c.severity.label(),
        "peer": c.peer,
        "peer_is_agent": c.peer_is_agent,
        "reason": c.reason,
        "mine": c.mine,
        "their_file": c.their_file,
        "their_symbol": c.their_symbol,
        "their_intent": c.their_intent,
        "their_branch": c.their_branch,
        "same_branch": c.same_branch,
        "age_ms": c.age_ms,
        "event_id": c.event_id,
    })
}

/// Every event this repository's readers may see: the merged local + remote
/// plane, scoped to THIS repository.
///
/// The logs are append-only and shared, so without this a checkout picks up
/// rows about paths that live in another project entirely — the single loudest
/// source of "the radar shows random things". Branch is deliberately NOT
/// filtered: seeing a teammate working the same file on a different branch is
/// the whole point of the plane.
///
/// It is done HERE, once, rather than at the feed, because the feed is the
/// quieter half. The scope used to be applied to the displayed rows only, which
/// left the alert layer reading the unscoped plane: `detect` matches a file by
/// path suffix, so a peer editing `src/auth.rs` in an unrelated project scored
/// a *direct* collision against the `src/auth.rs` in this one — the loudest
/// thing the radar can say, about a file they have never opened. That layer
/// also gates the pre-commit hook, so the fabricated collision could stop a
/// commit.
pub fn plane_for_this_repo() -> Vec<AwarenessEvent> {
    let repo = live_events::repo_name();
    broadcast::merged_events()
        .into_iter()
        .filter(|e| e.repo == repo)
        .collect()
}

/// The radar query: the ambient feed (optionally narrowed to `focus`) plus the
/// reasoned conflicts against the caller's own current work. `as_actor` lets an
/// agent declare its own label so its events are excluded from its conflicts.
pub fn radar(focus: Option<&str>, limit: usize, as_actor: Option<&str>) -> Value {
    // Opportunistic (throttled, best-effort) pull so the feed includes
    // teammates' events; then read the merged local + remote view (AURA-15).
    let _ = broadcast::pull_remote(false);
    let all = plane_for_this_repo();

    let mut rows: Vec<&AwarenessEvent> = relevance::filter(&all, focus);

    // Drop anything past the feed window, and count what was dropped so the
    // surface can say "nothing recent" instead of padding the list with
    // six-week-old rows that look live.
    let now = live_events::now_ms();
    let before_window = rows.len();
    rows.retain(|e| now.saturating_sub(e.ts) <= FEED_WINDOW_MS);
    let stale_hidden = before_window - rows.len();

    rows.sort_by(|a, b| b.ts.cmp(&a.ts));
    rows.truncate(limit);

    let my_focus = conflict::focus_from_repo(as_actor);
    let mut collisions = conflict::detect(&my_focus, &all, live_events::now_ms(), CONFLICT_WINDOW_MS);
    // The ambient feed stays quiet: the weakest (callgraph-ripple) tier surfaces
    // only when explicitly asked for via `conflicts --all`.
    collisions.retain(|c| c.severity != conflict::Severity::Possible);

    json!({
        "repo": live_events::repo_name(),
        "branch": live_events::current_branch(),
        "events": rows.iter().map(|e| event_json(e)).collect::<Vec<_>>(),
        "conflicts": collisions.iter().map(collision_json).collect::<Vec<_>>(),
        // How far back the feed looked, and how many in-repo events fell
        // outside it. Lets a surface distinguish "nobody has been here"
        // from "nobody has been here lately" without guessing.
        "feed_window_ms": FEED_WINDOW_MS,
        "stale_hidden": stale_hidden,
        "focus": {
            "files": my_focus.files,
            "symbols": my_focus.symbols,
        },
    })
}

/// Just the reasoned conflicts (no feed) — for surfaces that only want the alert
/// layer (pre-commit hook, desktop conflict card).
pub fn conflicts(as_actor: Option<&str>, include_possible: bool) -> Value {
    let _ = broadcast::pull_remote(false);
    let all = plane_for_this_repo();
    // The callgraph ripple edges are only built when the Possible tier is
    // actually wanted — they cost a full checkpoint-store read (see
    // `conflict::focus_from_repo_opts`).
    let my_focus = conflict::focus_from_repo_opts(as_actor, include_possible);
    let mut collisions = conflict::detect(&my_focus, &all, live_events::now_ms(), CONFLICT_WINDOW_MS);
    if !include_possible {
        collisions.retain(|c| c.severity != conflict::Severity::Possible);
    }
    json!({
        "count": collisions.len(),
        "conflicts": collisions.iter().map(collision_json).collect::<Vec<_>>(),
    })
}

/// Emit an event and return it as JSON. Wraps [`emit::emit`] so the wire shape
/// (`{ ok, event }`) is owned here.
pub fn emit(input: emit::EmitInput) -> Value {
    let ev = emit::emit(input);
    json!({ "ok": true, "event": event_json(&ev) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::awareness::model::AwarenessKind;
    use crate::awareness::store;
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

    fn ev(id: &str, repo: &str) -> AwarenessEvent {
        AwarenessEvent {
            id: id.into(),
            actor: "ashiq".into(),
            is_agent: false,
            kind: AwarenessKind::Editing,
            repo: repo.into(),
            branch: "main".into(),
            file: Some("src/auth.rs".into()),
            symbol: Some("login".into()),
            intent: None,
            impact: None,
            ts: live_events::now_ms(),
            key_id: None,
            sig: None,
            pubkey: None,
            worktree: None,
        }
    }

    #[test]
    fn another_projects_work_never_reaches_this_repos_readers() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();
        // No git remote here, so this repo's name is the `local` fallback.
        assert_eq!(live_events::repo_name(), "local");

        assert!(store::append(&ev("mine", "local")));
        assert!(store::append(&ev("theirs", "acme/payments")));

        let plane: Vec<String> = plane_for_this_repo().into_iter().map(|e| e.id).collect();
        assert_eq!(plane, vec!["mine".to_string()]);
    }

    #[test]
    fn the_alert_layer_reads_the_same_scoped_plane_the_feed_does() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();

        // Both events name `src/auth.rs`, and `detect` matches a file by path
        // suffix — so before the scope moved off the feed and onto the plane,
        // a peer editing `src/auth.rs` in an unrelated project scored a DIRECT
        // collision against the `src/auth.rs` in this one. That is the loudest
        // thing the radar can say, about a file they have never opened, and it
        // also gates the pre-commit hook.
        assert!(store::append(&ev("theirs", "acme/payments")));

        let scoped = plane_for_this_repo();
        assert!(scoped.is_empty(), "nothing here is ours, so nothing can collide");

        // The unscoped read is what the alert layer used to do; keeping the
        // contrast in the test names what the fix is actually protecting.
        assert_eq!(super::broadcast::merged_events().len(), 1);
    }
}
