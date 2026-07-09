//! Realtime plugin↔plugin messaging over the team rail (Commons W3a).
//!
//! Capability: `realtime:channel[:topic-glob]` — the scope segment is
//! the TOPIC, so a manifest can grant `realtime:channel:game-*` and
//! never see traffic outside its game. Envelopes ride the hidden
//! `__aura_plugin_rt` system channel as JSON bodies, exactly like the
//! Plugin Exchange and the tasks/pages sync rails.
//!
//! Semantics are EPHEMERAL: a fresh poll cursor fast-forwards to the
//! rail head and never replays history, and latency is the poll cadence
//! (~2s) — turn-based collaboration, not twitch input. Both send and
//! poll re-derive the plugin's capabilities from the registry (defense
//! in depth, mirroring `cmd_plugin_proxy`): the renderer only ever
//! passes a plugin id, never capability strings.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::cmd_plugin::PluginHostState;
use crate::cmd_plugin_proxy::enabled_plugin;

/// Hidden system channel realtime envelopes ride on. Never rendered in
/// the chat UI (leading `__` marks system channels).
pub const RT_CHANNEL: &str = "__aura_plugin_rt";

/// Serialized payload ceiling. The rail caps a whole message body at
/// 64 KB; 8 KiB keeps game/cursor state cheap and leaves no incentive
/// to tunnel file transfers through the realtime lane (that's what the
/// Exchange's chunked publish is for).
const RT_PAYLOAD_MAX_BYTES: usize = 8 * 1024;

/// Topic charset/length: `[a-z0-9-]`, ≤64 chars. Topics name a room
/// ("game-tictactoe-7f3a"), not data, so the grammar stays tiny.
const RT_TOPIC_MAX_CHARS: usize = 64;

/// Sliding-window rate limit per plugin: 30 sends / 10s. Generous for
/// turn-based play, hostile to spin-loops flooding the team rail.
const RT_MAX_SENDS: usize = 30;
const RT_WINDOW_MS: i64 = 10_000;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn local_identity(repo_root: &str) -> Result<(String, String), String> {
    let id = crate::cmd_device::effective_identity(std::path::Path::new(repo_root))?;
    Ok((id.device_id, id.display_name))
}

fn validate_topic(topic: &str) -> Result<(), String> {
    if topic.is_empty() {
        return Err("realtime topic must not be empty".into());
    }
    if topic.len() > RT_TOPIC_MAX_CHARS {
        return Err(format!(
            "realtime topic exceeds {RT_TOPIC_MAX_CHARS} chars"
        ));
    }
    if !topic
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(format!(
            "realtime topic `{topic}` may only contain [a-z0-9-]"
        ));
    }
    Ok(())
}

// ── rate limiting ─────────────────────────────────────────────────────

/// plugin_id → send timestamps inside the current window. Module-level
/// because `PluginHostState` is owned by cmd_plugin and this state is
/// pure throttle bookkeeping, not registry data.
fn rate_limiter() -> &'static Mutex<HashMap<String, Vec<i64>>> {
    static LIMITER: OnceLock<Mutex<HashMap<String, Vec<i64>>>> = OnceLock::new();
    LIMITER.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record one send attempt at `now`; errors when the plugin already
/// burned its window. Failed attempts don't consume budget.
fn check_rate(plugin_id: &str, now: i64) -> Result<(), String> {
    let mut map = rate_limiter()
        .lock()
        .map_err(|_| "realtime rate limiter poisoned".to_string())?;
    let hits = map.entry(plugin_id.to_string()).or_default();
    hits.retain(|t| now - *t < RT_WINDOW_MS);
    if hits.len() >= RT_MAX_SENDS {
        return Err(format!(
            "plugin {plugin_id} exceeded the realtime rate limit ({RT_MAX_SENDS} sends / {}s)",
            RT_WINDOW_MS / 1000
        ));
    }
    hits.push(now);
    Ok(())
}

// ── wire format ───────────────────────────────────────────────────────

/// One realtime message on the rail. `origin` mirrors the exchange and
/// tasks/pages sync envelopes so receivers skip their own echoes with
/// the same one-liner everywhere.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RtEnvelope {
    pub v: u32,
    /// Sending plugin — receivers only ever see envelopes whose
    /// `plugin_id` matches their own (same-plugin, cross-device bus).
    pub plugin_id: String,
    pub topic: String,
    pub payload: serde_json::Value,
    pub from_device: String,
    pub from_display: String,
    /// Sender's wall-clock millis.
    pub ts: i64,
    /// Origin device id (same as `from_device`; top-level copy for
    /// uniform skip logic across the sync rails).
    pub origin: String,
}

impl RtEnvelope {
    pub fn to_body(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| e.to_string())
    }

    pub fn from_body(body: &str) -> Option<Self> {
        let env: Self = serde_json::from_str(body).ok()?;
        if env.v != 1 {
            return None;
        }
        if env.plugin_id.is_empty() || validate_topic(&env.topic).is_err() {
            return None;
        }
        Some(env)
    }
}

/// What the renderer (and ultimately the plugin sandbox) receives —
/// the envelope minus routing internals.
#[derive(Clone, Debug, Serialize)]
pub struct RtEvent {
    pub topic: String,
    pub payload: serde_json::Value,
    pub from_device: String,
    pub from_display: String,
    pub ts: i64,
}

#[derive(Debug, Serialize)]
pub struct RtPollResult {
    pub events: Vec<RtEvent>,
    /// Cursor for the next poll — highest cloud seq seen, including
    /// rows that filtered out (other plugins' traffic still advances
    /// the cursor; re-reading it buys nothing).
    pub next_seq: Option<i64>,
}

// ── commands ──────────────────────────────────────────────────────────

/// Send one realtime message on a topic. Capability-gated on
/// `realtime:channel[:<topic>]`, charset-checked, size-capped, rate
/// limited. Returns the event as sent so the renderer can loopback-emit
/// it to the sender's own sandboxes without waiting a poll tick. A solo
/// workspace (no team peers) skips the rail write entirely — loopback
/// is the only listener.
#[tauri::command]
pub fn plugin_rt_send(
    state: State<'_, PluginHostState>,
    repo_root: String,
    plugin_id: String,
    topic: String,
    payload: serde_json::Value,
) -> Result<RtEvent, String> {
    let entry = enabled_plugin(&state, &plugin_id)?;
    validate_topic(&topic)?;
    if !entry.capabilities.allows("realtime", "channel", Some(&topic)) {
        return Err(format!(
            "plugin {plugin_id} lacks capability realtime:channel for topic {topic}"
        ));
    }
    let serialized = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    if serialized.len() > RT_PAYLOAD_MAX_BYTES {
        return Err(format!(
            "realtime payload exceeds {} byte cap",
            RT_PAYLOAD_MAX_BYTES
        ));
    }
    let ts = now_ms();
    check_rate(&plugin_id, ts)?;
    let (device_id, display) = local_identity(&repo_root)?;

    if crate::cmd_team::team_has_peers(&repo_root) {
        let env = RtEnvelope {
            v: 1,
            plugin_id: plugin_id.clone(),
            topic: topic.clone(),
            payload: payload.clone(),
            from_device: device_id.clone(),
            from_display: display.clone(),
            ts,
            origin: device_id.clone(),
        };
        let msg = crate::cmd_team::new_system_message(&repo_root, RT_CHANNEL, env.to_body()?);
        crate::cmd_team::persist_and_deliver(&repo_root, msg)?;
    }

    Ok(RtEvent {
        topic,
        payload,
        from_device: device_id,
        from_display: display,
        ts,
    })
}

/// Poll the realtime rail for one plugin. `since_seq: None` initializes
/// the cursor: it fast-forwards past everything already on the rail and
/// returns no events — realtime is ephemeral, history never replays.
/// Capabilities are re-checked here PER TOPIC so a renderer compromise
/// (or a stale cursor) can never read traffic a scoped grant
/// (`realtime:channel:game-*`) doesn't cover.
#[tauri::command]
pub async fn plugin_rt_poll(
    state: State<'_, PluginHostState>,
    repo_root: String,
    plugin_id: String,
    since_seq: Option<i64>,
) -> Result<RtPollResult, String> {
    let entry = enabled_plugin(&state, &plugin_id)?;
    let (device_id, _) = local_identity(&repo_root)?;
    let rows = crate::cmd_team::fetch_channel_since(&repo_root, RT_CHANNEL, since_seq).await?;

    let cursor_init = since_seq.is_none();
    let mut next_seq = since_seq;
    let mut events = Vec::new();
    for msg in rows {
        if let Some(seq) = msg.seq {
            if next_seq.is_none_or(|cur| seq > cur) {
                next_seq = Some(seq);
            }
        }
        if cursor_init {
            continue; // fast-forward only — no history replay
        }
        let Some(env) = RtEnvelope::from_body(&msg.body) else {
            continue;
        };
        if env.plugin_id != plugin_id {
            continue; // another plugin's traffic — cursor still advanced
        }
        if env.origin == device_id {
            continue; // own echo — already loopback-delivered on send
        }
        if !entry.capabilities.allows("realtime", "channel", Some(&env.topic)) {
            continue; // outside this plugin's topic scope
        }
        events.push(RtEvent {
            topic: env.topic,
            payload: env.payload,
            from_device: env.from_device,
            from_display: env.from_display,
            ts: env.ts,
        });
    }
    Ok(RtPollResult { events, next_seq })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_envelope() -> RtEnvelope {
        RtEnvelope {
            v: 1,
            plugin_id: "@acme/game".into(),
            topic: "game-x".into(),
            payload: serde_json::json!({ "cell": 4 }),
            from_device: "dev-1".into(),
            from_display: "Ada".into(),
            ts: 1_700_000_000_000,
            origin: "dev-1".into(),
        }
    }

    #[test]
    fn topic_grammar_is_tiny() {
        assert!(validate_topic("game-tictactoe-7f3a").is_ok());
        assert!(validate_topic(&"a".repeat(RT_TOPIC_MAX_CHARS)).is_ok());
        assert!(validate_topic("").is_err());
        assert!(validate_topic("UPPER").is_err());
        assert!(validate_topic("has space").is_err());
        assert!(validate_topic("dot.sep").is_err());
        assert!(validate_topic(&"a".repeat(RT_TOPIC_MAX_CHARS + 1)).is_err());
    }

    #[test]
    fn envelope_roundtrips_and_rejects_bad_shapes() {
        let env = demo_envelope();
        let body = env.to_body().unwrap();
        let back = RtEnvelope::from_body(&body).unwrap();
        assert_eq!(back.topic, "game-x");
        assert_eq!(back.payload["cell"], 4);
        assert_eq!(back.origin, "dev-1");

        let mut bad = demo_envelope();
        bad.v = 2;
        assert!(RtEnvelope::from_body(&bad.to_body().unwrap()).is_none());

        let mut bad = demo_envelope();
        bad.topic = "NOPE".into();
        assert!(RtEnvelope::from_body(&bad.to_body().unwrap()).is_none());

        let mut bad = demo_envelope();
        bad.plugin_id = String::new();
        assert!(RtEnvelope::from_body(&bad.to_body().unwrap()).is_none());

        assert!(RtEnvelope::from_body("not json").is_none());
    }

    #[test]
    fn rate_limit_slides_its_window() {
        // Unique key — the limiter map is shared across the test binary.
        let id = "@test/rate-limit-window";
        let t0 = 1_000_000i64;
        for i in 0..RT_MAX_SENDS {
            assert!(check_rate(id, t0 + i as i64).is_ok(), "send {i} within budget");
        }
        // 31st inside the window rejects — and must NOT consume budget.
        assert!(check_rate(id, t0 + 100).is_err());
        assert!(check_rate(id, t0 + 101).is_err());
        // Once the window slides past the burst, sends flow again.
        assert!(check_rate(id, t0 + RT_WINDOW_MS + 50).is_ok());
    }

    #[test]
    fn payload_cap_measures_serialized_bytes() {
        let big = serde_json::Value::String("x".repeat(RT_PAYLOAD_MAX_BYTES));
        assert!(serde_json::to_vec(&big).unwrap().len() > RT_PAYLOAD_MAX_BYTES);
        let small = serde_json::json!({ "cell": 4, "mark": "x" });
        assert!(serde_json::to_vec(&small).unwrap().len() <= RT_PAYLOAD_MAX_BYTES);
    }
}
