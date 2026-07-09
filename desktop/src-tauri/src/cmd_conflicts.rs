//! ConflictedNode store. jj-style: a conflict is a first-class
//! persistent object that survives until somebody resolves it. Writes
//! to `.aura/conflicts.jsonl` (append-only). Each row carries the
//! identifier (function/class), the base hash both sides forked from,
//! and the two competing bodies. The resolver picks one (or writes a
//! merged body) and the row gets stamped with `resolved_at` +
//! `resolved_in_commit`.
//!
//! The pre-existing `aura_list_conflicts` in `cmd_aura_fs.rs` reads
//! sentinel + git markers and stays untouched — those are surface-level
//! collision signals. ConflictedNode is the durable AST-level object.

use crate::op_log;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConflictedNode {
    pub id: String,
    pub file: String,
    pub identifier: String,
    pub base_hash: String,
    pub ours: String,
    pub theirs: String,
    pub ours_agent: String,
    pub theirs_agent: String,
    pub opened_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_in_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution_body: Option<String>,
}

fn store_path(repo_root: &str) -> PathBuf {
    PathBuf::from(repo_root).join(".aura").join("conflicts.jsonl")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_all(repo_root: &str) -> Result<Vec<ConflictedNode>, String> {
    let path = store_path(repo_root);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let body = fs::read_to_string(&path).map_err(|e| format!("read conflicts: {e}"))?;
    let mut out = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<ConflictedNode>(trimmed) {
            Ok(node) => out.push(node),
            Err(_) => continue,
        }
    }
    Ok(out)
}

fn write_all(repo_root: &str, nodes: &[ConflictedNode]) -> Result<(), String> {
    let path = store_path(repo_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir .aura: {e}"))?;
    }
    let tmp = path.with_extension("jsonl.tmp");
    {
        let mut f = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|e| format!("open conflicts.tmp: {e}"))?;
        for node in nodes {
            let line =
                serde_json::to_string(node).map_err(|e| format!("serialize conflict: {e}"))?;
            writeln!(f, "{line}").map_err(|e| format!("write conflict: {e}"))?;
        }
        f.sync_all().ok();
    }
    fs::rename(&tmp, &path).map_err(|e| format!("rename conflicts.jsonl: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn aura_conflicts_list(repo_root: String) -> Result<Vec<ConflictedNode>, String> {
    read_all(&repo_root)
}

#[derive(Deserialize)]
pub struct RecordConflictArgs {
    pub file: String,
    pub identifier: String,
    pub base_hash: String,
    pub ours: String,
    pub theirs: String,
    pub ours_agent: String,
    pub theirs_agent: String,
}

#[tauri::command]
pub async fn aura_conflicts_record(
    repo_root: String,
    args: RecordConflictArgs,
) -> Result<ConflictedNode, String> {
    // Dedup: if there's already an open conflict on the same file +
    // identifier with the same base_hash, return it instead of
    // doubling up. Live Sync may fire impact events repeatedly for the
    // same divergence.
    let mut nodes = read_all(&repo_root)?;
    if let Some(existing) = nodes.iter().find(|n| {
        n.resolved_at.is_none()
            && n.file == args.file
            && n.identifier == args.identifier
            && n.base_hash == args.base_hash
    }) {
        return Ok(existing.clone());
    }
    let node = ConflictedNode {
        id: Uuid::new_v4().to_string(),
        file: args.file,
        identifier: args.identifier,
        base_hash: args.base_hash,
        ours: args.ours,
        theirs: args.theirs,
        ours_agent: args.ours_agent,
        theirs_agent: args.theirs_agent,
        opened_at: now_secs(),
        resolved_at: None,
        resolved_in_commit: None,
        resolution_body: None,
    };
    nodes.push(node.clone());
    write_all(&repo_root, &nodes)?;
    op_log::record_op(
        &repo_root,
        "conflict_open",
        &format!("Conflict on {} in {}", node.identifier, node.file),
        "aura-shell",
        serde_json::json!({ "conflict_id": node.id }),
    )
    .ok();
    Ok(node)
}

#[derive(Deserialize)]
pub struct ResolveConflictArgs {
    pub conflict_id: String,
    /// "ours" | "theirs" | "custom"
    pub strategy: String,
    /// Required when strategy = "custom". Final body to write.
    pub custom_body: Option<String>,
    /// HEAD sha at resolve time, captured by the renderer so we don't
    /// have to shell out to git from this command.
    pub resolved_in_commit: Option<String>,
}

#[tauri::command]
pub async fn aura_conflicts_resolve(
    repo_root: String,
    args: ResolveConflictArgs,
) -> Result<ConflictedNode, String> {
    let mut nodes = read_all(&repo_root)?;
    let idx = nodes
        .iter()
        .position(|n| n.id == args.conflict_id)
        .ok_or_else(|| format!("no conflict with id {}", args.conflict_id))?;
    if nodes[idx].resolved_at.is_some() {
        return Err("conflict already resolved".into());
    }
    let body = match args.strategy.as_str() {
        "ours" => nodes[idx].ours.clone(),
        "theirs" => nodes[idx].theirs.clone(),
        "custom" => args
            .custom_body
            .clone()
            .ok_or_else(|| "custom strategy requires custom_body".to_string())?,
        other => return Err(format!("unknown strategy {other}")),
    };
    nodes[idx].resolved_at = Some(now_secs());
    nodes[idx].resolved_in_commit = args.resolved_in_commit;
    nodes[idx].resolution_body = Some(body.clone());
    let resolved = nodes[idx].clone();
    write_all(&repo_root, &nodes)?;
    op_log::record_op(
        &repo_root,
        "conflict_resolve",
        &format!("Resolved conflict on {}", resolved.identifier),
        "aura-shell",
        serde_json::json!({
            "conflict_id": resolved.id,
            "strategy": args.strategy,
        }),
    )
    .ok();
    Ok(resolved)
}
