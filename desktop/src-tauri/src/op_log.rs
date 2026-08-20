//! Append-only operation log at `<repo>/.aura/op_log.jsonl`.
//!
//! Captures every mutating engine op so `aura_undo_last` can replay the
//! inverse. Inspired by jj's operation log + `jj undo`.
//!
//! Each row carries a self-describing `undo_payload` — the data the
//! inverse needs to reverse the op (e.g. for log_intent: the timestamp
//! to delete; for snapshot: the snapshot blob path). Inverse functions
//! live in this module so adding a new op kind means: (a) extend
//! `OpKind`, (b) call `record_op` from the mutating cmd, (c) add a match
//! arm in `apply_undo`.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OpEntry {
    pub op_id: String,
    pub ts: u64,
    /// Stable kind tag. Free-string so adding a new op doesn't require a
    /// schema migration of the existing log.
    pub kind: String,
    /// Human-readable summary shown in OpLogDialog.
    pub summary: String,
    /// Agent that triggered the op ("aura-shell", "claude", ...).
    pub agent_id: String,
    /// Inverse-op payload. Shape varies by kind; consumers match on
    /// `kind` to interpret. Kept opaque here so a future op kind can
    /// carry whatever it needs.
    pub undo_payload: serde_json::Value,
    /// Set to Some(when_ts) once an undo has been applied so the op
    /// doesn't get undone twice.
    #[serde(default)]
    pub undone_at: Option<u64>,
}

fn aura_dir(repo_root: &str) -> PathBuf {
    PathBuf::from(repo_root).join(".aura")
}
fn log_path(repo_root: &str) -> PathBuf {
    aura_dir(repo_root).join("op_log.jsonl")
}

/// Append a new op. Best-effort — if the log can't be written, the
/// caller's primary side effect still ran; we just lose the undo trail
/// for this op. Returns the freshly-minted op_id so a caller that wants
/// to attach metadata later can find the row again.
pub fn record_op(
    repo_root: &str,
    kind: &str,
    summary: &str,
    agent_id: &str,
    undo_payload: serde_json::Value,
) -> Result<String, String> {
    fs::create_dir_all(aura_dir(repo_root)).map_err(|e| e.to_string())?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let op_id = Uuid::new_v4().to_string();
    let entry = OpEntry {
        op_id: op_id.clone(),
        ts,
        kind: kind.to_string(),
        summary: summary.to_string(),
        agent_id: agent_id.to_string(),
        undo_payload,
        undone_at: None,
    };
    let serialized =
        serde_json::to_string(&entry).map_err(|e| format!("serialize op: {}", e))?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path(repo_root))
        .map_err(|e| format!("open op_log: {}", e))?;
    writeln!(f, "{}", serialized).map_err(|e| format!("write op_log: {}", e))?;
    Ok(op_id)
}

/// Read every op (newest first). Bounded — caller passes `limit`.
pub fn read_ops(repo_root: &str, limit: usize) -> Result<Vec<OpEntry>, String> {
    let p = log_path(repo_root);
    if !p.exists() {
        return Ok(vec![]);
    }
    let f = fs::File::open(&p).map_err(|e| format!("open op_log: {}", e))?;
    let mut rows: Vec<OpEntry> = Vec::new();
    for line in BufReader::new(f).lines().flatten() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(row) = serde_json::from_str::<OpEntry>(trimmed) {
            rows.push(row);
        }
    }
    rows.sort_by(|a, b| b.ts.cmp(&a.ts));
    rows.truncate(limit);
    Ok(rows)
}

/// Mark an op `undone_at = now` in place. Used by apply_undo so the
/// OpLogDialog can dim already-undone rows.
fn stamp_undone(repo_root: &str, op_id: &str) -> Result<(), String> {
    let p = log_path(repo_root);
    if !p.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut out = String::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(mut row) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if row.get("op_id").and_then(|v| v.as_str()) == Some(op_id) {
                row["undone_at"] = serde_json::json!(now);
            }
            out.push_str(&row.to_string());
            out.push('\n');
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    fs::write(&p, out).map_err(|e| e.to_string())?;
    Ok(())
}

/// Apply the inverse op encoded in `entry.undo_payload`. Returns a
/// human-readable summary of what was undone (for the success toast).
pub fn apply_undo(repo_root: &str, entry: &OpEntry) -> Result<String, String> {
    if entry.undone_at.is_some() {
        return Err("op already undone".into());
    }
    let summary = match entry.kind.as_str() {
        "log_intent" => undo_log_intent(repo_root, &entry.undo_payload)?,
        "snapshot" => undo_snapshot(repo_root, &entry.undo_payload)?,
        "intent_attribute" => undo_intent_attribute(repo_root, &entry.undo_payload)?,
        "intent_split" => undo_intent_split(repo_root, &entry.undo_payload)?,
        "intent_merge" => undo_intent_merge(repo_root, &entry.undo_payload)?,
        "zone_claim" => undo_zone_claim(repo_root, &entry.undo_payload)?,
        other => return Err(format!("no inverse implemented for op kind '{}'", other)),
    };
    stamp_undone(repo_root, &entry.op_id)?;
    Ok(summary)
}

// ── Inverse implementations ────────────────────────────────────────────

/// log_intent inverse: remove the row at `intent_ts`.
fn undo_log_intent(repo_root: &str, payload: &serde_json::Value) -> Result<String, String> {
    let ts = payload
        .get("intent_ts")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "log_intent undo: missing intent_ts".to_string())?;
    let p = aura_dir(repo_root).join("intent_log.jsonl");
    if !p.exists() {
        return Err("intent_log.jsonl missing".into());
    }
    let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut out = String::new();
    let mut removed = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let row: serde_json::Value =
            serde_json::from_str(trimmed).unwrap_or(serde_json::Value::Null);
        if row.get("timestamp").and_then(|v| v.as_u64()) == Some(ts) {
            removed = true;
            continue;
        }
        out.push_str(trimmed);
        out.push('\n');
    }
    if !removed {
        return Err(format!("no intent at ts {} to remove", ts));
    }
    fs::write(&p, out).map_err(|e| e.to_string())?;
    // Refresh the .intent_logged marker so the pre-commit gate reflects
    // whether anything is left.
    let any_left = read_intent_log_any(repo_root)?;
    let marker = aura_dir(repo_root).join(".intent_logged");
    if any_left {
        let _ = fs::write(&marker, "1");
    } else {
        let _ = fs::remove_file(&marker);
    }
    Ok(format!("Removed intent #{}", ts))
}

fn read_intent_log_any(repo_root: &str) -> Result<bool, String> {
    let p = aura_dir(repo_root).join("intent_log.jsonl");
    if !p.exists() {
        return Ok(false);
    }
    let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(raw.lines().any(|l| !l.trim().is_empty()))
}

/// snapshot inverse: delete the snapshot blob/dir created for this file.
fn undo_snapshot(repo_root: &str, payload: &serde_json::Value) -> Result<String, String> {
    let snap_path = payload
        .get("snapshot_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "snapshot undo: missing snapshot_path".to_string())?;
    let abs = if Path::new(snap_path).is_absolute() {
        PathBuf::from(snap_path)
    } else {
        PathBuf::from(repo_root).join(snap_path)
    };
    if !abs.exists() {
        return Ok(format!("snapshot {} already gone", snap_path));
    }
    if abs.is_dir() {
        fs::remove_dir_all(&abs).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(&abs).map_err(|e| e.to_string())?;
    }
    Ok(format!("Deleted snapshot {}", snap_path))
}

/// intent_attribute inverse: remove the appended paths from the target
/// intent's changeset.files.
fn undo_intent_attribute(
    repo_root: &str,
    payload: &serde_json::Value,
) -> Result<String, String> {
    let ts = payload
        .get("intent_ts")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "intent_attribute undo: missing intent_ts".to_string())?;
    let paths: Vec<String> = payload
        .get("file_paths")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if paths.is_empty() {
        return Err("intent_attribute undo: empty file_paths".into());
    }
    let p = aura_dir(repo_root).join("intent_log.jsonl");
    if !p.exists() {
        return Err("intent_log.jsonl missing".into());
    }
    let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut rows: Vec<serde_json::Value> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let target = rows
        .iter_mut()
        .find(|r| r["timestamp"].as_u64() == Some(ts))
        .ok_or_else(|| format!("no intent at ts {}", ts))?;
    let cs = target
        .get_mut("changeset")
        .ok_or_else(|| "target has no changeset".to_string())?;
    let files = cs
        .get_mut("files")
        .ok_or_else(|| "changeset has no files".to_string())?;
    if let Some(arr) = files.as_array_mut() {
        arr.retain(|f| {
            f.get("path")
                .and_then(|v| v.as_str())
                .map(|p| !paths.contains(&p.to_string()))
                .unwrap_or(true)
        });
    }
    let mut out = String::new();
    for r in &rows {
        out.push_str(&r.to_string());
        out.push('\n');
    }
    fs::write(&p, out).map_err(|e| e.to_string())?;
    Ok(format!("Detached {} path(s) from intent #{}", paths.len(), ts))
}

/// intent_split inverse: merge the split-off rows back into the original.
/// Payload carries: {kept_ts, new_ts, original_files (full pre-split list)}.
fn undo_intent_split(repo_root: &str, payload: &serde_json::Value) -> Result<String, String> {
    let kept_ts = payload
        .get("kept_ts")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "intent_split undo: missing kept_ts".to_string())?;
    let new_ts = payload
        .get("new_ts")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "intent_split undo: missing new_ts".to_string())?;
    let original_files = payload
        .get("original_files")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    let p = aura_dir(repo_root).join("intent_log.jsonl");
    if !p.exists() {
        return Err("intent_log.jsonl missing".into());
    }
    let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut rows: Vec<serde_json::Value> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let target_idx = rows
        .iter()
        .position(|r| r["timestamp"].as_u64() == Some(kept_ts))
        .ok_or_else(|| format!("no kept intent at ts {}", kept_ts))?;
    rows[target_idx]["changeset"]["files"] = original_files;
    rows.retain(|r| r["timestamp"].as_u64() != Some(new_ts));
    let mut out = String::new();
    for r in &rows {
        out.push_str(&r.to_string());
        out.push('\n');
    }
    fs::write(&p, out).map_err(|e| e.to_string())?;
    Ok(format!("Reverted split — restored intent #{}", kept_ts))
}

/// intent_merge inverse: re-create the dropped row + restore the kept
/// row's pre-merge text + files. Payload: {kept_ts, dropped_row (full
/// JSON), kept_text_pre, kept_files_pre}.
fn undo_intent_merge(repo_root: &str, payload: &serde_json::Value) -> Result<String, String> {
    let kept_ts = payload
        .get("kept_ts")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "intent_merge undo: missing kept_ts".to_string())?;
    let dropped_row = payload
        .get("dropped_row")
        .cloned()
        .ok_or_else(|| "intent_merge undo: missing dropped_row".to_string())?;
    let kept_text_pre = payload
        .get("kept_text_pre")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "intent_merge undo: missing kept_text_pre".to_string())?
        .to_string();
    let kept_files_pre = payload
        .get("kept_files_pre")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    let p = aura_dir(repo_root).join("intent_log.jsonl");
    if !p.exists() {
        return Err("intent_log.jsonl missing".into());
    }
    let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut rows: Vec<serde_json::Value> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let target = rows
        .iter_mut()
        .find(|r| r["timestamp"].as_u64() == Some(kept_ts))
        .ok_or_else(|| format!("no kept intent at ts {}", kept_ts))?;
    target["intent"] = serde_json::json!(kept_text_pre);
    target["changeset"]["files"] = kept_files_pre;
    rows.push(dropped_row);
    let mut out = String::new();
    for r in &rows {
        out.push_str(&r.to_string());
        out.push('\n');
    }
    fs::write(&p, out).map_err(|e| e.to_string())?;
    Ok(format!("Reverted merge — restored both intents"))
}

/// zone_claim inverse: release the claimed zones. Best-effort — uses
/// the `aura zone release` CLI; failures bubble up so the user can act.
fn undo_zone_claim(repo_root: &str, payload: &serde_json::Value) -> Result<String, String> {
    let zones: Vec<String> = payload
        .get("zones")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if zones.is_empty() {
        return Err("zone_claim undo: empty zones".into());
    }
    let mut args = vec!["zone".to_string(), "release".to_string()];
    args.extend(zones.iter().cloned());
    let out = std::process::Command::new(crate::agent_event_listener::resolve_aura_bin())
        .args(&args)
        .current_dir(repo_root)
        .output()
        .map_err(|e| format!("spawn aura: {}", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(format!("Released {} zone(s)", zones.len()))
}
