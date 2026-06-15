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

/// JSON for one event — the model serializes directly; we keep this as the
/// single conversion point so callers never reach into the struct shape.
pub fn event_json(e: &AwarenessEvent) -> Value {
    serde_json::to_value(e).unwrap_or(Value::Null)
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

/// The radar query: the ambient feed (optionally narrowed to `focus`) plus the
/// reasoned conflicts against the caller's own current work. `as_actor` lets an
/// agent declare its own label so its events are excluded from its conflicts.
pub fn radar(focus: Option<&str>, limit: usize, as_actor: Option<&str>) -> Value {
    // Opportunistic (throttled, best-effort) pull so the feed includes
    // teammates' events; then read the merged local + remote view (AURA-15).
    let _ = broadcast::pull_remote(false);
    let all = broadcast::merged_events();

    let mut rows: Vec<&AwarenessEvent> = relevance::filter(&all, focus);
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
    let all = broadcast::merged_events();
    let my_focus = conflict::focus_from_repo(as_actor);
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
