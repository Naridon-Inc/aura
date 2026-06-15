//! Pluggable transport for the live CRDT hot path.
//!
//! The whole-file CRDT daemon (`crdt_daemon`) ships and receives op bytes
//! through this trait instead of calling the cloud HTTP client directly.
//! Today the only implementation is [`CloudTransport`] (the existing
//! `/api/v2/crdt/push|pull` endpoints). The P2P peer-mesh (roadmap M3) lands
//! as a second impl — [`active`] is the single swap point, so the engine and
//! the desktop surface bind to this interface and the mesh slots in without
//! reworking the daemon.

use crate::awareness::AwarenessEvent;
use crate::config::ConfigManager;
use crate::crdt::{pull_ops, push_update, CrdtUpdate, PulledOp};

/// One live session's transport: publish local CRDT updates and pull peers' in.
/// Also carries the awareness plane (AURA-15) — small signed semantic events,
/// never code bytes — so a future sovereign/P2P transport replaces BOTH planes
/// at the single [`active`] swap point.
pub trait LiveTransport: Send + Sync {
    /// Publish a local whole-file CRDT update for `branch`.
    fn push_crdt(&self, branch: &str, update: &CrdtUpdate) -> Result<(), String>;

    /// Pull peer ops for `branch` newer than the `since` cursor. Returns the
    /// ops plus the new cursor to persist.
    fn pull_crdt(&self, branch: &str, since: i64) -> Result<(Vec<PulledOp>, i64), String>;

    /// Publish a batch of awareness events (already policy-filtered + signed).
    fn push_awareness(&self, events: &[AwarenessEvent]) -> Result<(), String>;

    /// Pull peers' awareness events newer than the server-side `since` cursor.
    /// Returns the events plus the new cursor to persist. The cursor is a
    /// server row id (not a timestamp) so client clock skew can't drop events.
    fn pull_awareness(&self, since: i64) -> Result<(Vec<AwarenessEvent>, i64), String>;
}

/// Cloud transport — the `/api/v2/crdt/push|pull` REST endpoints. The default
/// (and currently only) transport.
pub struct CloudTransport;

impl LiveTransport for CloudTransport {
    fn push_crdt(&self, branch: &str, update: &CrdtUpdate) -> Result<(), String> {
        push_update(branch, update)
    }

    fn pull_crdt(&self, branch: &str, since: i64) -> Result<(Vec<PulledOp>, i64), String> {
        pull_ops(branch, since)
    }

    fn push_awareness(&self, events: &[AwarenessEvent]) -> Result<(), String> {
        let (url, token) = cloud_creds()?;
        let repo = crate::live_events::repo_name();
        let body = serde_json::json!({ "repo": repo, "events": events });
        let c = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| format!("http: {}", e))?;
        let resp = c
            .post(format!("{}/api/v2/awareness/push", url))
            .header("Authorization", format!("Bearer {}", token))
            .json(&body)
            .send()
            .map_err(|e| format!("network: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        Ok(())
    }

    fn pull_awareness(&self, since: i64) -> Result<(Vec<AwarenessEvent>, i64), String> {
        let (url, token) = cloud_creds()?;
        let repo = crate::live_events::repo_name();
        let c = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| format!("http: {}", e))?;
        let resp = c
            .get(format!(
                "{}/api/v2/awareness/pull?repo={}&since={}",
                url, repo, since
            ))
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .map_err(|e| format!("network: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let v: serde_json::Value = resp.json().map_err(|e| format!("parse: {}", e))?;
        let cursor = v["cursor"].as_i64().unwrap_or(since);
        let events: Vec<AwarenessEvent> = v["events"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|row| serde_json::from_value(row["event"].clone()).ok())
            .collect();
        Ok((events, cursor))
    }
}

/// Shared cloud-credential lookup for the awareness endpoints (mirrors the
/// `crdt.rs` client pattern).
fn cloud_creds() -> Result<(String, String), String> {
    let cfg = ConfigManager::load();
    let url = cfg.cloud_url.ok_or("not connected")?;
    let token = cfg
        .cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or("no cloud token")?;
    Ok((url, token))
}

/// The transport for the current live session. Cloud today; the peer-mesh (M3)
/// returns a `PeerMeshTransport` here when a mesh session is active.
pub fn active() -> Box<dyn LiveTransport> {
    Box::new(CloudTransport)
}
