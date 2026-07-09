//! Commons Lounge — ship-log reactions over the team rail (Commons W2).
//!
//! The Lounge tab derives presence and the ship log from data that
//! already flows (radar awareness events + roster); the only NEW state
//! is emoji reactions on ship-log entries. Reactions ride the hidden
//! `__aura_ship_log` system channel as JSON envelopes — same rail as
//! the Exchange and the tasks/pages sync, but unlike the W3a realtime
//! lane they are DURABLE: the poll fetches full channel history and the
//! renderer replays react/unreact toggles in seq order, so a late
//! joiner sees the same aggregate as everyone else.

use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

/// Hidden system channel reaction envelopes ride on. Never rendered in
/// the chat UI (leading `__` marks system channels).
pub const SHIP_LOG_CHANNEL: &str = "__aura_ship_log";

/// Radar event ids are uuids/short hashes; cap + charset keeps the rail
/// body honest without caring about the exact id scheme.
const EVENT_ID_MAX_CHARS: usize = 64;

/// One emoji (grapheme clusters with ZWJ sequences fit comfortably).
const EMOJI_MAX_BYTES: usize = 16;

/// Sliding-window rate limit: 30 reactions / 10s per app instance —
/// generous for a human tapping chips, hostile to a render loop gone
/// wrong flooding the team rail.
const REACT_MAX_SENDS: usize = 30;
const REACT_WINDOW_MS: i64 = 10_000;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn local_identity(repo_root: &str) -> Result<(String, String), String> {
    let id = crate::cmd_device::effective_identity(std::path::Path::new(repo_root))?;
    Ok((id.device_id, id.display_name))
}

fn validate_event_id(event_id: &str) -> Result<(), String> {
    if event_id.is_empty() {
        return Err("ship-log event id must not be empty".into());
    }
    if event_id.len() > EVENT_ID_MAX_CHARS {
        return Err(format!(
            "ship-log event id exceeds {EVENT_ID_MAX_CHARS} chars"
        ));
    }
    if !event_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("ship-log event id may only contain [a-zA-Z0-9_-]".into());
    }
    Ok(())
}

fn validate_emoji(emoji: &str) -> Result<(), String> {
    if emoji.is_empty() {
        return Err("reaction emoji must not be empty".into());
    }
    if emoji.len() > EMOJI_MAX_BYTES {
        return Err(format!("reaction emoji exceeds {EMOJI_MAX_BYTES} bytes"));
    }
    if emoji
        .chars()
        .any(|c| c.is_control() || c.is_ascii_whitespace())
    {
        return Err("reaction emoji contains control or whitespace chars".into());
    }
    Ok(())
}

// ── rate limiting ─────────────────────────────────────────────────────

fn rate_window() -> &'static Mutex<Vec<i64>> {
    static WINDOW: OnceLock<Mutex<Vec<i64>>> = OnceLock::new();
    WINDOW.get_or_init(|| Mutex::new(Vec::new()))
}

/// Record one reaction attempt at `now`; errors once the window is
/// burned. Failed attempts don't consume budget.
fn check_rate(now: i64) -> Result<(), String> {
    let mut hits = rate_window()
        .lock()
        .map_err(|_| "lounge rate limiter poisoned".to_string())?;
    hits.retain(|t| now - *t < REACT_WINDOW_MS);
    if hits.len() >= REACT_MAX_SENDS {
        return Err(format!(
            "ship-log reaction rate limit exceeded ({REACT_MAX_SENDS} / {}s)",
            REACT_WINDOW_MS / 1000
        ));
    }
    hits.push(now);
    Ok(())
}

// ── wire format ───────────────────────────────────────────────────────

/// One reaction toggle on the rail. Replayed in seq order; the same
/// device re-sending `react` is idempotent, `unreact` removes.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShipLogReaction {
    pub v: u32,
    /// "react" | "unreact".
    pub op: String,
    /// Radar event id (the committed event this reaction decorates).
    pub event_id: String,
    pub emoji: String,
    pub device_id: String,
    pub display: String,
    pub ts: i64,
}

impl ShipLogReaction {
    pub fn to_body(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| e.to_string())
    }

    pub fn from_body(body: &str) -> Option<Self> {
        let env: Self = serde_json::from_str(body).ok()?;
        if env.v != 1 {
            return None;
        }
        if env.op != "react" && env.op != "unreact" {
            return None;
        }
        if validate_event_id(&env.event_id).is_err()
            || validate_emoji(&env.emoji).is_err()
            || env.device_id.is_empty()
        {
            return None;
        }
        Some(env)
    }
}

/// What the renderer aggregates — the envelope plus its rail seq so
/// toggle replay is deterministically ordered.
#[derive(Clone, Debug, Serialize)]
pub struct LoungeReactionRow {
    pub op: String,
    pub event_id: String,
    pub emoji: String,
    pub device_id: String,
    pub display: String,
    pub ts: i64,
    pub seq: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct LoungeReactionsResult {
    pub rows: Vec<LoungeReactionRow>,
    /// This device's id, so the renderer knows which chips are "mine"
    /// without a separate identity round-trip.
    pub self_device: String,
}

// ── commands ──────────────────────────────────────────────────────────

/// Toggle a reaction on a ship-log entry. Validated, rate limited, and
/// persisted to the rail when the workspace has team peers; a solo
/// workspace skips the rail write and the returned row is the only
/// listener (the UI applies it optimistically either way).
#[tauri::command]
pub fn lounge_react(
    repo_root: String,
    event_id: String,
    emoji: String,
    add: bool,
) -> Result<LoungeReactionRow, String> {
    validate_event_id(&event_id)?;
    validate_emoji(&emoji)?;
    let ts = now_ms();
    check_rate(ts)?;
    let (device_id, display) = local_identity(&repo_root)?;
    let op = if add { "react" } else { "unreact" };

    if crate::cmd_team::team_has_peers(&repo_root) {
        let env = ShipLogReaction {
            v: 1,
            op: op.to_string(),
            event_id: event_id.clone(),
            emoji: emoji.clone(),
            device_id: device_id.clone(),
            display: display.clone(),
            ts,
        };
        let msg =
            crate::cmd_team::new_system_message(&repo_root, SHIP_LOG_CHANNEL, env.to_body()?);
        crate::cmd_team::persist_and_deliver(&repo_root, msg)?;
    }

    Ok(LoungeReactionRow {
        op: op.to_string(),
        event_id,
        emoji,
        device_id,
        display,
        ts,
        seq: None,
    })
}

/// Fetch the FULL reaction history for this team room (reactions are
/// durable, unlike the W3a realtime lane). Rows come back seq-ordered;
/// the renderer replays react/unreact toggles to build the aggregate.
/// Errors from a room-less repo bubble up — the caller treats them as
/// "no reactions yet" exactly like the other sync rails.
#[tauri::command]
pub async fn lounge_reactions(repo_root: String) -> Result<LoungeReactionsResult, String> {
    let (device_id, _) = local_identity(&repo_root)?;
    let rows = crate::cmd_team::fetch_channel_since(&repo_root, SHIP_LOG_CHANNEL, None).await?;

    let mut out: Vec<LoungeReactionRow> = Vec::new();
    for msg in rows {
        let Some(env) = ShipLogReaction::from_body(&msg.body) else {
            continue;
        };
        out.push(LoungeReactionRow {
            op: env.op,
            event_id: env.event_id,
            emoji: env.emoji,
            device_id: env.device_id,
            display: env.display,
            ts: env.ts,
            seq: msg.seq,
        });
    }
    // Deterministic replay order: rail seq first, sender clock as the
    // tie-break for rows that never got a cloud seq.
    out.sort_by_key(|r| (r.seq.unwrap_or(i64::MAX), r.ts));
    Ok(LoungeReactionsResult {
        rows: out,
        self_device: device_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_reaction() -> ShipLogReaction {
        ShipLogReaction {
            v: 1,
            op: "react".into(),
            event_id: "evt_7f3a-2b".into(),
            emoji: "🚀".into(),
            device_id: "dev-1".into(),
            display: "Ada".into(),
            ts: 1_700_000_000_000,
        }
    }

    #[test]
    fn event_id_grammar_is_tight() {
        assert!(validate_event_id("evt_7f3a-2b").is_ok());
        assert!(validate_event_id(&"a".repeat(EVENT_ID_MAX_CHARS)).is_ok());
        assert!(validate_event_id("").is_err());
        assert!(validate_event_id("has space").is_err());
        assert!(validate_event_id("dot.sep").is_err());
        assert!(validate_event_id(&"a".repeat(EVENT_ID_MAX_CHARS + 1)).is_err());
    }

    #[test]
    fn emoji_validation_allows_zwj_rejects_junk() {
        assert!(validate_emoji("🚀").is_ok());
        assert!(validate_emoji("👨‍💻").is_ok()); // ZWJ sequence
        assert!(validate_emoji("✅").is_ok());
        assert!(validate_emoji("").is_err());
        assert!(validate_emoji("a b").is_err());
        assert!(validate_emoji("x\u{0007}").is_err());
        assert!(validate_emoji(&"🚀".repeat(8)).is_err()); // > 16 bytes
    }

    #[test]
    fn envelope_roundtrips_and_rejects_bad_shapes() {
        let env = demo_reaction();
        let body = env.to_body().unwrap();
        let back = ShipLogReaction::from_body(&body).unwrap();
        assert_eq!(back.event_id, "evt_7f3a-2b");
        assert_eq!(back.emoji, "🚀");
        assert_eq!(back.op, "react");

        let mut bad = demo_reaction();
        bad.v = 2;
        assert!(ShipLogReaction::from_body(&bad.to_body().unwrap()).is_none());

        let mut bad = demo_reaction();
        bad.op = "explode".into();
        assert!(ShipLogReaction::from_body(&bad.to_body().unwrap()).is_none());

        let mut bad = demo_reaction();
        bad.event_id = "nope nope".into();
        assert!(ShipLogReaction::from_body(&bad.to_body().unwrap()).is_none());

        let mut bad = demo_reaction();
        bad.device_id = String::new();
        assert!(ShipLogReaction::from_body(&bad.to_body().unwrap()).is_none());

        assert!(ShipLogReaction::from_body("not json").is_none());
    }

    #[test]
    fn rate_limit_slides_its_window() {
        let t0 = 5_000_000i64;
        for i in 0..REACT_MAX_SENDS {
            assert!(check_rate(t0 + i as i64).is_ok(), "send {i} within budget");
        }
        // Over budget rejects — and must NOT consume budget.
        assert!(check_rate(t0 + 100).is_err());
        assert!(check_rate(t0 + 101).is_err());
        // Window slides past the burst → sends flow again.
        assert!(check_rate(t0 + REACT_WINDOW_MS + 50).is_ok());
    }
}
