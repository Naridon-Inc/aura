//! Read/write surface for `.aura/memory.json` and `.aura/sessions/`.
//! Backs Stage 5D Memory + Sessions browser. Memory is a single JSON
//! with sectioned arrays of entries; sessions are one JSON file per
//! session in `.aura/sessions/<id>.json`. Both are best-effort —
//! missing files return empty.

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

const SECTIONS: &[&str] = &[
    "architecture",
    "decisions",
    "conventions",
    "gotchas",
    "context",
    "active_work",
];

#[derive(Serialize, Deserialize, Clone)]
pub struct MemoryEntry {
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub added_by: String,
    #[serde(default)]
    pub added_at: i64,

    // ── W2 provenance pass-through (written by aura-cli; see
    // aura-cli/src/memory_provenance.rs). These MUST be declared here:
    // `aura_memory_view` deserializes into this struct and re-serializes,
    // so any undeclared field is silently dropped before the frontend
    // ever sees it — the same trap cmd_prs.rs::AuraReviewPayload solves.
    // All serde-default so pre-W2 memory.json files keep loading, and
    // skip_serializing_if so entries without provenance stay compact.
    //
    // `embedding` (Vec<f32> in the CLI struct) is DELIBERATELY not
    // declared: vectors are retrieval internals — never ship them to the
    // frontend. Dropping it here is the desired behavior.
    /// HEAD short sha at write time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_commit: Option<String>,
    /// Code anchor in `<repo-relative-path>#<identifier>` form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_symbol: Option<String>,
    /// sha256 (hex) of the symbol's source text at write time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_symbol_hash: Option<String>,
    /// Intent-log row id the memory was written under.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent_id: Option<String>,
    /// `key_id` that signed that intent row, when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer_key_id: Option<String>,
    /// RFC3339 — when this fact became valid (the write time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<String>,
    /// RFC3339 — reserved for supersession windows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_to: Option<String>,
}

#[derive(Serialize)]
pub struct MemoryView {
    pub identity: String,
    pub stack: Vec<String>,
    pub sections: Vec<MemorySection>,
    pub last_updated: i64,
}

#[derive(Serialize)]
pub struct MemorySection {
    pub name: String,
    pub entries: Vec<MemoryEntry>,
}

fn memory_path(repo_root: &str) -> PathBuf {
    PathBuf::from(repo_root).join(".aura").join("memory.json")
}

#[tauri::command]
pub async fn aura_memory_view(repo_root: String) -> Result<MemoryView, String> {
    let path = memory_path(&repo_root);
    if !path.exists() {
        return Ok(MemoryView {
            identity: String::new(),
            stack: vec![],
            sections: SECTIONS
                .iter()
                .map(|s| MemorySection {
                    name: (*s).to_string(),
                    entries: vec![],
                })
                .collect(),
            last_updated: 0,
        });
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let identity = v
        .get("identity")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let stack = v
        .get("stack")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let mut sections = Vec::new();
    for s in SECTIONS {
        let entries = v
            .get(*s)
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| serde_json::from_value::<MemoryEntry>(e.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        sections.push(MemorySection {
            name: (*s).to_string(),
            entries,
        });
    }
    let last_updated = v
        .get("last_updated")
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    Ok(MemoryView {
        identity,
        stack,
        sections,
        last_updated,
    })
}

#[tauri::command]
pub async fn aura_memory_write_entry(
    repo_root: String,
    section: String,
    content: String,
    tags: Vec<String>,
) -> Result<MemoryEntry, String> {
    if !SECTIONS.contains(&section.as_str()) {
        return Err(format!("unknown section: {}", section));
    }
    let path = memory_path(&repo_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut v: serde_json::Value = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if !v.is_object() {
        v = serde_json::json!({});
    }
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let id = format!("mem-{:08x}", rand_id());
    let entry = MemoryEntry {
        id: id.clone(),
        content,
        tags,
        added_by: "aura-shell".to_string(),
        added_at: now,
        // Shell-authored entries carry no provenance — only aura-cli
        // writes stamp code anchors (memory_provenance.rs).
        source_commit: None,
        source_symbol: None,
        source_symbol_hash: None,
        intent_id: None,
        signer_key_id: None,
        valid_from: None,
        valid_to: None,
    };
    let arr = v
        .as_object_mut()
        .unwrap()
        .entry(section.clone())
        .or_insert_with(|| serde_json::json!([]));
    if let Some(a) = arr.as_array_mut() {
        a.push(serde_json::to_value(&entry).unwrap());
    }
    v["last_updated"] = serde_json::json!(now);
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    fs::write(&path, pretty).map_err(|e| e.to_string())?;
    Ok(entry)
}

/// Report from `aura memory import-claude-code --json`. Mirrors
/// `aura-cli/src/memory/import.rs::ImportReport` field-for-field (the
/// `--json` output is the IPC contract). The shell links crates, not the
/// `aura` binary, so this is a serde mirror rather than a shared type —
/// same arrangement as cmd_carryover.rs.
#[derive(Serialize, Deserialize, Clone)]
pub struct ClaudeImportReport {
    pub imported: usize,
    pub deduped: usize,
    pub updated: usize,
    pub total: usize,
    #[serde(default)]
    pub by_section: std::collections::BTreeMap<String, usize>,
    #[serde(default)]
    pub dry_run: bool,
    /// Absolute source dir the facts were read from; null when none found.
    #[serde(default)]
    pub source_dir: Option<String>,
    /// Present (and `false`) only on the "nothing found" / error shapes.
    #[serde(default)]
    pub found: Option<bool>,
    /// Plain-language note on the no-facts / error paths.
    #[serde(default)]
    pub message: Option<String>,
}

/// Import Claude Code's per-repo memory into Aura's `.aura/memory.json` by
/// shelling the installed `aura` CLI. Returns the parsed report. The CLI
/// runs every fact through the W3 reconcile pipeline, so this is idempotent
/// (exact duplicates NOOP, restatements supersede). `dry_run = true` reports
/// what WOULD import without writing.
#[tauri::command]
pub async fn aura_memory_import_claude_code(
    repo_root: String,
    dry_run: bool,
) -> Result<ClaudeImportReport, String> {
    let cwd = PathBuf::from(&repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }
    let bin = crate::agent_event_listener::resolve_aura_bin();
    let mut args: Vec<String> = vec![
        "memory".to_string(),
        "import-claude-code".to_string(),
        "--json".to_string(),
    ];
    if dry_run {
        args.push("--dry-run".to_string());
    }

    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new(&bin)
            .args(&args)
            .current_dir(&cwd)
            .output()
    })
    .await
    .map_err(|e| format!("import task join: {e}"))?
    .map_err(|e| format!("failed to spawn `aura memory import-claude-code`: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "aura memory import-claude-code failed (status {}): {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str::<ClaudeImportReport>(stdout.trim())
        .map_err(|e| format!("parse import json: {e}"))
}

#[tauri::command]
pub async fn aura_memory_forget_entry(
    repo_root: String,
    id: String,
) -> Result<bool, String> {
    let path = memory_path(&repo_root);
    if !path.exists() {
        return Ok(false);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let mut removed = false;
    for s in SECTIONS {
        if let Some(arr) = v.get_mut(*s).and_then(|x| x.as_array_mut()) {
            let before = arr.len();
            arr.retain(|e| e.get("id").and_then(|x| x.as_str()) != Some(id.as_str()));
            if arr.len() != before {
                removed = true;
            }
        }
    }
    if removed {
        let now = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        v["last_updated"] = serde_json::json!(now);
        let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
        fs::write(&path, pretty).map_err(|e| e.to_string())?;
    }
    Ok(removed)
}

fn rand_id() -> u32 {
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    nanos ^ 0x5bd1e995
}

// ---------- Sessions ----------

#[derive(Serialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub agent_id: String,
    pub phase: String,
    pub started_at: i64,
    pub last_activity: i64,
    pub files_touched: Vec<String>,
    pub checkpoint_count: u64,
    pub base_commit: String,
    pub worktree: String,
}

#[tauri::command]
pub async fn aura_session_list(repo_root: String, limit: usize) -> Result<Vec<SessionSummary>, String> {
    let dir = PathBuf::from(&repo_root).join(".aura").join("sessions");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut rows: Vec<(i64, SessionSummary)> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let last_activity = v
            .get("last_activity")
            .and_then(|x| x.as_i64())
            .unwrap_or(0);
        let summary = SessionSummary {
            session_id: v
                .get("session_id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            agent_id: v
                .get("agent_id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            phase: v
                .get("phase")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            started_at: v.get("started_at").and_then(|x| x.as_i64()).unwrap_or(0),
            last_activity,
            files_touched: v
                .get("files_touched")
                .and_then(|x| x.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|s| s.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default(),
            checkpoint_count: v
                .get("checkpoint_count")
                .and_then(|x| x.as_u64())
                .unwrap_or(0),
            base_commit: v
                .get("base_commit")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            worktree: v
                .get("worktree")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        };
        rows.push((last_activity, summary));
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.truncate(limit.max(1));
    Ok(rows.into_iter().map(|(_, s)| s).collect())
}

#[tauri::command]
pub async fn aura_session_read(
    repo_root: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let path = PathBuf::from(&repo_root)
        .join(".aura")
        .join("sessions")
        .join(format!("{}.json", session_id));
    if !path.exists() {
        return Err(format!("session not found: {}", session_id));
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `aura_memory_view` round-trips entries through this struct, so a
    /// CLI-written W2 provenance field survives to the frontend only if
    /// it is declared above. This pins the pass-through — and pins that
    /// `embedding` vectors are dropped on purpose.
    #[test]
    fn provenance_fields_round_trip_and_embedding_is_dropped() {
        let raw = serde_json::json!({
            "id": "mem-00000001",
            "content": "verify_token rejects expired JWTs",
            "tags": ["auth"],
            "added_by": "claude",
            "added_at": 1_765_000_000_i64,
            "source_commit": "abc1234",
            "source_symbol": "src/auth.rs#verify_token",
            "source_symbol_hash": "deadbeefdeadbeef",
            "intent_id": "ts:1765000000",
            "signer_key_id": "key-7f",
            "valid_from": "2026-06-10T12:00:00Z",
            "valid_to": null,
            "embedding": [0.25_f32, -0.5_f32]
        });
        let entry: MemoryEntry =
            serde_json::from_value(raw).expect("CLI-shaped entry must deserialize");
        let out = serde_json::to_value(&entry).expect("re-serialize");

        assert_eq!(out["source_commit"], "abc1234");
        assert_eq!(out["source_symbol"], "src/auth.rs#verify_token");
        assert_eq!(out["source_symbol_hash"], "deadbeefdeadbeef");
        assert_eq!(out["intent_id"], "ts:1765000000");
        assert_eq!(out["signer_key_id"], "key-7f");
        assert_eq!(out["valid_from"], "2026-06-10T12:00:00Z");
        // Absent/None provenance must stay absent, not become `null`.
        assert!(out.get("valid_to").is_none());
        // Vectors never ship to the frontend.
        assert!(out.get("embedding").is_none());
    }

    /// Pre-W2 entries (no provenance keys at all) keep loading and stay
    /// compact on re-serialize.
    #[test]
    fn pre_w2_entry_loads_without_provenance_keys() {
        let raw = serde_json::json!({
            "id": "mem-00000002",
            "content": "use 2-space indent in ts",
        });
        let entry: MemoryEntry = serde_json::from_value(raw).expect("legacy entry loads");
        let out = serde_json::to_value(&entry).expect("re-serialize");
        for key in [
            "source_commit",
            "source_symbol",
            "source_symbol_hash",
            "intent_id",
            "signer_key_id",
            "valid_from",
            "valid_to",
        ] {
            assert!(out.get(key).is_none(), "{} must be skipped when None", key);
        }
    }
}
