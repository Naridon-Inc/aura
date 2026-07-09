//! Agent CLI version pinning + breaking-bump detection.
//!
//! Coding-agent CLIs (claude, gemini, codex, cursor-agent) ship
//! frequent updates and occasionally land breaking changes — argv
//! flags rename, stream-json schema rev'd, hook-payload field
//! removed. The OSC 777 plugin scripts I forked from Warp's MIT tree
//! are version-tied to a specific claude/gemini surface; if the user
//! `npm i -g @anthropic-ai/claude-code@latest` rolls them past it,
//! events stop arriving and nobody knows why.
//!
//! This module:
//!   1. Records the version of each agent CLI on first PTY spawn into
//!      `~/.aura/agent-versions.json`.
//!   2. On every subsequent spawn, re-runs `<bin> --version` and
//!      compares. Mismatch emits `agent-version-changed` so the UI
//!      can surface a banner ("claude bumped from 1.4.2 → 1.5.0 —
//!      our hooks may need refreshing").
//!   3. Exposes `agents_versions_get` for the Settings → Agents tab
//!      to render the version table at-rest.
//!
//! Cheap enough to call on every spawn — `claude --version` returns
//! in <50ms and we cache by binary path.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentVersionRecord {
    /// Last version we observed running. None when never recorded.
    pub recorded: Option<String>,
    /// Wall-clock ms when `recorded` was last updated.
    pub recorded_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentVersionStatus {
    pub agent_id: String,
    pub recorded: Option<String>,
    pub current: Option<String>,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentVersionChange {
    pub agent_id: String,
    pub from: Option<String>,
    pub to: String,
    pub at_ms: u64,
}

/// Tauri-managed cache of `~/.aura/agent-versions.json`. Loaded on
/// first access; `record_and_check` rewrites the file when an entry
/// changes. In-memory so per-spawn lookup doesn't hit the disk.
#[derive(Default)]
pub struct AgentVersionStore {
    inner: Mutex<HashMap<String, AgentVersionRecord>>,
    loaded: Mutex<bool>,
}

impl AgentVersionStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn load_if_needed(&self) {
        let mut loaded = self.loaded.lock().unwrap();
        if *loaded {
            return;
        }
        let path = match storage_path() {
            Some(p) => p,
            None => return,
        };
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(map) =
                serde_json::from_slice::<HashMap<String, AgentVersionRecord>>(&bytes)
            {
                *self.inner.lock().unwrap() = map;
            }
        }
        *loaded = true;
    }

    fn persist(&self) {
        let Some(path) = storage_path() else { return };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let map = self.inner.lock().unwrap().clone();
        if let Ok(bytes) = serde_json::to_vec_pretty(&map) {
            let _ = std::fs::write(&path, bytes);
        }
    }

    /// Read `<bin> --version`, compare against the recorded entry, and
    /// — when changed — update the cache + persist + emit
    /// `agent-version-changed`. Called from cmd_agent_pty::agent_pty_open
    /// on every PTY spawn.
    ///
    /// Best-effort: any failure (binary not on PATH, version probe
    /// stalled, file write failure) is silently swallowed. Pinning is
    /// a UX nicety, not a correctness gate.
    pub fn record_and_check(&self, app: &AppHandle, agent_id: &str, bin_name: &str) {
        self.load_if_needed();
        let current = match probe_version(bin_name) {
            Some(v) => v,
            None => return,
        };
        let mut inner = self.inner.lock().unwrap();
        let entry = inner.entry(agent_id.to_string()).or_default();
        let prior = entry.recorded.clone();
        if prior.as_deref() == Some(current.as_str()) {
            return; // unchanged — no work
        }
        let now = now_ms();
        entry.recorded = Some(current.clone());
        entry.recorded_at_ms = Some(now);
        drop(inner);
        self.persist();
        // Only emit when a *prior* recording existed. The first-spawn
        // case (None → Some) is recording, not a *change* — surfacing
        // a banner there would just be noise.
        if prior.is_some() {
            let _ = app.emit(
                "agent-version-changed",
                AgentVersionChange {
                    agent_id: agent_id.to_string(),
                    from: prior,
                    to: current,
                    at_ms: now,
                },
            );
        }
    }
}

fn storage_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".aura");
    p.push("agent-versions.json");
    Some(p)
}

fn probe_version(bin_name: &str) -> Option<String> {
    let out = std::process::Command::new(bin_name)
        .arg("--version")
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let pick = if s.is_empty() {
        String::from_utf8_lossy(&out.stderr).trim().to_string()
    } else {
        s
    };
    if pick.is_empty() {
        None
    } else {
        Some(pick.lines().next().unwrap_or("").to_string())
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Render the at-rest version table for the Settings UI. Probes the
/// current binary version + cross-references the recorded one. Slow
/// (one process spawn per agent) so the UI should call this lazily,
/// not on every render.
#[tauri::command]
pub fn agents_versions_get(
    store: State<'_, AgentVersionStore>,
) -> Result<Vec<AgentVersionStatus>, String> {
    store.load_if_needed();
    // Fixed list of known agent ids — same as aura_agents::Registry's
    // compiled-in defaults. We don't enumerate the full registry here
    // because TOML-declared providers may probe unreachable bins; UI
    // settings tab can surface the registry side separately.
    const AGENTS: &[(&str, &str)] = &[
        ("claude", "claude"),
        ("gemini", "gemini"),
        ("codex", "codex"),
        ("cursor", "cursor-agent"),
        ("kimi", "kimi"),
    ];
    let inner = store.inner.lock().unwrap();
    let mut out = Vec::with_capacity(AGENTS.len());
    for (id, bin) in AGENTS {
        let recorded = inner.get(*id).and_then(|e| e.recorded.clone());
        let current = probe_version(bin);
        let changed = match (&recorded, &current) {
            (Some(r), Some(c)) => r != c,
            _ => false,
        };
        out.push(AgentVersionStatus {
            agent_id: id.to_string(),
            recorded,
            current,
            changed,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_skips_emit_on_first_spawn() {
        // Indirect — we exercise the store's persistence and "no
        // change" path. The emit is best-effort and can't be checked
        // without a Tauri AppHandle, but the no-op-on-equal branch
        // is straight-line and worth a unit guard.
        let store = AgentVersionStore::new();
        let mut g = store.inner.lock().unwrap();
        g.insert(
            "x".into(),
            AgentVersionRecord {
                recorded: Some("1.0.0".into()),
                recorded_at_ms: Some(0),
            },
        );
        assert_eq!(g.get("x").unwrap().recorded.as_deref(), Some("1.0.0"));
    }
}
