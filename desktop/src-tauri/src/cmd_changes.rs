//! jj-style `change_id`. A change_id is a stable identifier for a
//! "logical change" that survives commit-sha rotation (amend, sign,
//! re-sign). Derivation:
//!
//!   change_id = base32(hash(intent_text + tree_hash))[..10]
//!
//! Where:
//!   • `tree_hash` = `git rev-parse <commit_sha>^{tree}` — same tree
//!     across an amend → same change_id.
//!   • `intent_text` = the most recent `.aura/intent_log.jsonl` entry
//!     whose ts ≤ commit_ts. Same intent across re-sign → same
//!     change_id. New intent on a new branch → fresh change_id.
//!
//! Shell-local: doesn't modify upstream manifest schema; computes
//! on-demand. ProvenanceReplay surfaces it as a stripe so the user
//! sees "this is the same change re-signed N times."

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize)]
pub struct ChangeIdRow {
    pub commit_sha: String,
    pub change_id: String,
}

#[derive(Deserialize)]
struct IntentLogLine {
    #[serde(default)]
    timestamp: i64,
    #[serde(default)]
    intent: String,
}

const BASE32: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";

fn encode_base32(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 8 / 5 + 1);
    let mut buffer: u64 = 0;
    let mut bits: u32 = 0;
    for b in bytes {
        buffer = (buffer << 8) | (*b as u64);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let idx = ((buffer >> bits) & 0x1f) as usize;
            out.push(BASE32[idx] as char);
        }
    }
    if bits > 0 {
        let idx = ((buffer << (5 - bits)) & 0x1f) as usize;
        out.push(BASE32[idx] as char);
    }
    out
}

fn tree_hash(repo_root: &str, commit_sha: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", &format!("{commit_sha}^{{tree}}")])
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn commit_ts(repo_root: &str, commit_sha: &str) -> Option<i64> {
    let out = Command::new("git")
        .args(["show", "-s", "--format=%ct", commit_sha])
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

fn read_intents(repo_root: &str) -> Vec<IntentLogLine> {
    let p = PathBuf::from(repo_root)
        .join(".aura")
        .join("intent_log.jsonl");
    let body = match fs::read_to_string(&p) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(row) = serde_json::from_str::<IntentLogLine>(trimmed) {
            out.push(row);
        }
    }
    out.sort_by_key(|r| r.timestamp);
    out
}

fn nearest_prior_intent(intents: &[IntentLogLine], ts: i64) -> &str {
    // Binary search for the rightmost entry with timestamp <= ts.
    let mut lo = 0usize;
    let mut hi = intents.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if intents[mid].timestamp <= ts {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    if lo == 0 {
        ""
    } else {
        intents[lo - 1].intent.as_str()
    }
}

fn derive_change_id(intent: &str, tree: &str) -> String {
    let mut hasher = DefaultHasher::new();
    intent.hash(&mut hasher);
    "\0".hash(&mut hasher);
    tree.hash(&mut hasher);
    let h = hasher.finish().to_le_bytes();
    encode_base32(&h)[..10].to_string()
}

#[tauri::command]
pub async fn aura_changes_resolve(
    repo_root: String,
    commit_sha: String,
) -> Result<ChangeIdRow, String> {
    let tree = tree_hash(&repo_root, &commit_sha)
        .ok_or_else(|| format!("git: cannot resolve tree for {commit_sha}"))?;
    let ts = commit_ts(&repo_root, &commit_sha).unwrap_or(0);
    let intents = read_intents(&repo_root);
    let intent = nearest_prior_intent(&intents, ts);
    Ok(ChangeIdRow {
        commit_sha,
        change_id: derive_change_id(intent, &tree),
    })
}

#[tauri::command]
pub async fn aura_changes_list(
    repo_root: String,
    commit_shas: Vec<String>,
) -> Result<Vec<ChangeIdRow>, String> {
    let intents = read_intents(&repo_root);
    let mut out = Vec::with_capacity(commit_shas.len());
    for sha in commit_shas {
        let tree = match tree_hash(&repo_root, &sha) {
            Some(t) => t,
            None => continue,
        };
        let ts = commit_ts(&repo_root, &sha).unwrap_or(0);
        let intent = nearest_prior_intent(&intents, ts);
        out.push(ChangeIdRow {
            commit_sha: sha,
            change_id: derive_change_id(intent, &tree),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_roundtrip_known() {
        // sanity: distinct inputs → distinct outputs
        let a = derive_change_id("intent A", "treeA");
        let b = derive_change_id("intent B", "treeA");
        let c = derive_change_id("intent A", "treeB");
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 10);
    }

    #[test]
    fn same_intent_same_tree_same_change_id() {
        let a = derive_change_id("intent A", "treeA");
        let b = derive_change_id("intent A", "treeA");
        assert_eq!(a, b);
    }
}
