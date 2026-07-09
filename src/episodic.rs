//! Episodic memory recall — Bet 1 Phase B (local-only scaffold).
//!
//! The roadmap (`.aura/plans/roadmap-2026/02-bet-agent-memory-substrate.md`)
//! describes a cloud-side `episodic_events` table that aggregates every
//! `log_intent`, sentinel message, and PR-review event into a queryable
//! store. This module is the local-only preview: we read the signals Aura
//! already writes to `.aura/` today and return a ranked, narrated digest
//! so agents can ask "what happened here recently?" before Phase A (cloud
//! schema + backfill) lands.
//!
//! Signals read:
//!   - `.aura/intent_log.jsonl` — one JSON-line per `aura_log_intent` call
//!   - `.aura/sentinel/messages/*.json` — cross-agent sentinel transcripts
//!   - `.aura/snapshots/*.json` — pre-edit file snapshots (metadata only)
//!
//! We deliberately do NOT pull in file-save telemetry (`tracker/`) — per
//! the Bet 1 risk section, noisy file-save events drown the narrative.
//! Only intent + agent-to-agent + snapshot events become episodic rows.
//!
//! The returned JSON shape matches the future cloud response so the MCP
//! client surface is stable across the local→cloud migration.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_WINDOW_HOURS: u64 = 168; // 7 days
const DEFAULT_LIMIT: usize = 25;
const AURA_DIR: &str = ".aura";

#[derive(Debug, Clone, Serialize)]
pub struct EpisodicEvent {
    pub ts: u64,
    pub age_label: String,
    pub event_type: String, // "intent" | "sentinel" | "snapshot"
    pub agent: String,
    pub summary: String,
    pub refs_file: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecallResult {
    pub window_hours: u64,
    pub now_ts: u64,
    pub total_events: usize,
    pub returned: usize,
    pub events: Vec<EpisodicEvent>,
    pub narration: String,
}

pub fn recall(
    window_hours: Option<u64>,
    focus_file: Option<&str>,
    limit: Option<usize>,
) -> RecallResult {
    let window_hours = window_hours.unwrap_or(DEFAULT_WINDOW_HOURS);
    let limit = limit.unwrap_or(DEFAULT_LIMIT);
    let now_ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let since_ts = now_ts.saturating_sub(window_hours * 3600);

    let mut events: Vec<EpisodicEvent> = Vec::new();
    events.extend(read_intent_log(since_ts, now_ts));
    events.extend(read_sentinel_messages(since_ts, now_ts));
    events.extend(read_snapshots(since_ts, now_ts));

    if let Some(needle) = focus_file {
        let needle_lc = needle.to_ascii_lowercase();
        events.retain(|e| {
            e.refs_file.iter().any(|f| f.to_ascii_lowercase().contains(&needle_lc))
                || e.summary.to_ascii_lowercase().contains(&needle_lc)
        });
    }

    events.sort_by(|a, b| b.ts.cmp(&a.ts));
    let total = events.len();
    if events.len() > limit {
        events.truncate(limit);
    }

    let narration = narrate(&events, window_hours, focus_file);

    RecallResult {
        window_hours,
        now_ts,
        total_events: total,
        returned: events.len(),
        events,
        narration,
    }
}

fn read_intent_log(since_ts: u64, now_ts: u64) -> Vec<EpisodicEvent> {
    let path = Path::new(AURA_DIR).join("intent_log.jsonl");
    let Ok(content) = fs::read_to_string(&path) else { return Vec::new() };
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|v| {
            let ts = v.get("timestamp").and_then(|t| t.as_u64())?;
            if ts < since_ts {
                return None;
            }
            let intent = v.get("intent").and_then(|s| s.as_str()).unwrap_or("").to_string();
            if intent.is_empty() {
                return None;
            }
            let agent = v
                .get("agent_id")
                .or_else(|| v.get("agent"))
                .and_then(|s| s.as_str())
                .unwrap_or("unknown")
                .to_string();
            Some(EpisodicEvent {
                ts,
                age_label: humanize_age(now_ts, ts),
                event_type: "intent".to_string(),
                agent,
                summary: truncate(&intent, 280),
                refs_file: Vec::new(),
            })
        })
        .collect()
}

fn read_sentinel_messages(since_ts: u64, now_ts: u64) -> Vec<EpisodicEvent> {
    let dir = Path::new(AURA_DIR).join("sentinel").join("messages");
    let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| {
            let content = fs::read_to_string(e.path()).ok()?;
            let v: Value = serde_json::from_str(&content).ok()?;
            let ts = v.get("timestamp").and_then(|t| t.as_u64())?;
            if ts < since_ts {
                return None;
            }
            let agent = v
                .get("from_agent")
                .and_then(|s| s.as_str())
                .unwrap_or("unknown")
                .to_string();
            let summary = v
                .get("content")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            Some(EpisodicEvent {
                ts,
                age_label: humanize_age(now_ts, ts),
                event_type: "sentinel".to_string(),
                agent,
                summary: truncate(&summary, 280),
                refs_file: Vec::new(),
            })
        })
        .collect()
}

fn read_snapshots(since_ts: u64, now_ts: u64) -> Vec<EpisodicEvent> {
    let dir = Path::new(AURA_DIR).join("snapshots");
    let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let (file_path, ts) = parse_snapshot_filename(&name)?;
            if ts < since_ts {
                return None;
            }
            Some(EpisodicEvent {
                ts,
                age_label: humanize_age(now_ts, ts),
                event_type: "snapshot".to_string(),
                agent: "aura".to_string(),
                summary: format!("pre-edit snapshot of {}", file_path),
                refs_file: vec![file_path],
            })
        })
        .collect()
}

/// Snapshot file names are `<path>__<ms_epoch>.json` where path uses
/// double-underscore as the directory separator. Example:
/// `__Users__you__Documents__x.rs__1777020482259.json`.
fn parse_snapshot_filename(name: &str) -> Option<(String, u64)> {
    let stem = name.strip_suffix(".json")?;
    let (path_part, ts_part) = stem.rsplit_once("__")?;
    let ms: u64 = ts_part.parse().ok()?;
    let path = path_part.replace("__", "/");
    Some((path, ms / 1000))
}

fn humanize_age(now_ts: u64, then_ts: u64) -> String {
    if then_ts > now_ts {
        return "just now".to_string();
    }
    let diff = now_ts - then_ts;
    match diff {
        0..=59 => "just now".to_string(),
        60..=3599 => format!("{}m ago", diff / 60),
        3600..=86399 => format!("{}h ago", diff / 3600),
        _ => format!("{}d ago", diff / 86400),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max).collect();
    format!("{}…", truncated)
}

fn narrate(events: &[EpisodicEvent], window_hours: u64, focus: Option<&str>) -> String {
    if events.is_empty() {
        return format!(
            "No episodic events in the last {} hours{}.",
            window_hours,
            focus.map(|f| format!(" matching '{}'", f)).unwrap_or_default()
        );
    }
    let (mut intents, mut sentinel, mut snapshots) = (0usize, 0usize, 0usize);
    for e in events {
        match e.event_type.as_str() {
            "intent" => intents += 1,
            "sentinel" => sentinel += 1,
            "snapshot" => snapshots += 1,
            _ => {}
        }
    }
    let focus_str = focus.map(|f| format!(" focused on '{}'", f)).unwrap_or_default();
    format!(
        "{} events in the last {}h{}: {} intents, {} agent-to-agent messages, {} file snapshots. Latest: {} at {}.",
        events.len(),
        window_hours,
        focus_str,
        intents,
        sentinel,
        snapshots,
        events[0].event_type,
        events[0].age_label,
    )
}

/// Compatibility helper: resolve the working directory for episodic reads.
/// Future cloud implementation will ignore this and hit the remote store.
pub fn aura_dir_exists() -> bool {
    PathBuf::from(AURA_DIR).exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn humanize_age_boundaries() {
        assert_eq!(humanize_age(1_000_000, 1_000_000), "just now");
        assert_eq!(humanize_age(1_000_000, 999_950), "just now");
        assert_eq!(humanize_age(1_000_000, 999_880), "2m ago");
        assert_eq!(humanize_age(1_000_000, 990_000), "2h ago");
        assert_eq!(humanize_age(1_000_000, 500_000), "5d ago");
    }

    #[test]
    fn truncate_respects_max_chars() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello world", 5), "hello…");
    }

    #[test]
    fn parse_snapshot_filename_happy_path() {
        let (path, ts) = parse_snapshot_filename(
            "__Users__you__src__lib.rs__1777020482259.json",
        )
        .unwrap();
        assert_eq!(path, "/Users/you/src/lib.rs");
        assert_eq!(ts, 1_777_020_482);
    }

    #[test]
    fn parse_snapshot_filename_rejects_bad_stem() {
        assert!(parse_snapshot_filename("not-a-snapshot.txt").is_none());
        assert!(parse_snapshot_filename("missing-ts.json").is_none());
    }

    #[test]
    fn narrate_handles_empty() {
        let out = narrate(&[], 24, None);
        assert!(out.contains("No episodic events"));
        assert!(out.contains("24"));
    }

    #[test]
    fn narrate_counts_by_type() {
        let now = 1_000_000u64;
        let events = vec![
            EpisodicEvent {
                ts: now - 60,
                age_label: "1m ago".into(),
                event_type: "intent".into(),
                agent: "a".into(),
                summary: "x".into(),
                refs_file: vec![],
            },
            EpisodicEvent {
                ts: now - 120,
                age_label: "2m ago".into(),
                event_type: "sentinel".into(),
                agent: "b".into(),
                summary: "y".into(),
                refs_file: vec![],
            },
            EpisodicEvent {
                ts: now - 180,
                age_label: "3m ago".into(),
                event_type: "snapshot".into(),
                agent: "aura".into(),
                summary: "z".into(),
                refs_file: vec!["foo.rs".into()],
            },
        ];
        let out = narrate(&events, 1, None);
        assert!(out.contains("3 events"));
        assert!(out.contains("1 intents"));
        assert!(out.contains("1 agent-to-agent"));
        assert!(out.contains("1 file snapshots"));
    }
}
