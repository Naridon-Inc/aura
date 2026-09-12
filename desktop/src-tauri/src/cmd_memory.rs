//! Read/write surface for `.aura/memory.json` and `.aura/sessions/`.
//! Backs Stage 5D Memory + Sessions browser (AUDIT-CTX-05).
//!
//! READS go straight to disk (same file the CLI writes, resolved
//! worktree-aware below). WRITES shell the installed `aura` CLI
//! (`memory add/edit/forget --json`) so there is exactly ONE write path:
//! every mutation runs the W3 reconcile pipeline, gets provenance-stamped
//! and Ed25519-signed, and lands in the right file even from a linked
//! worktree. The old direct-fs writer bypassed all of that — and worse,
//! pushing an entry-shaped object into `decisions`/`architecture` (which
//! hold TimelineEntry/ArchComponent shapes) made the CLI's next load fail
//! and silently reset the whole store.
//!
//! Every mutation emits `memory:changed` with the repo root as payload so
//! open surfaces reload without a restart.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

const SECTIONS: &[&str] = &[
    "architecture",
    "decisions",
    "conventions",
    "gotchas",
    "context",
    "active_work",
];

/// Sections a human (or the shell) may write free-text entries into.
/// `architecture` and `decisions` are DELIBERATELY absent: in the CLI's
/// `ProjectMemory` they hold `ArchComponent` / `TimelineEntry` shapes, not
/// memory entries — writing an entry there corrupts the store.
const WRITABLE_SECTIONS: &[&str] = &["conventions", "gotchas", "context", "active_work"];

/// Map a user-facing section name (including the singular aliases the CLI
/// accepts) to its canonical storage name, or explain why it's not writable.
fn canonical_write_section(section: &str) -> Result<&'static str, String> {
    match section.trim().to_lowercase().as_str() {
        "convention" | "conventions" => Ok("conventions"),
        "gotcha" | "gotchas" => Ok("gotchas"),
        "context" => Ok("context"),
        "active" | "active_work" => Ok("active_work"),
        "decisions" | "decision" | "architecture" => Err(
            "The decisions and architecture sections are maintained by Aura itself. \
             Add project facts to conventions, gotchas, context or active work instead."
                .to_string(),
        ),
        other => Err(format!(
            "Unknown memory section '{other}'. Writable sections: conventions, gotchas, context, active_work."
        )),
    }
}

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
    /// RFC3339 — when this fact stopped being current (superseded or
    /// soft-forgotten). Live entries have `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_to: Option<String>,
    /// Id of the entry this one superseded (W3 reconcile chain).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
    /// W4 decay importance weight in [0, 1] — the UI's confidence signal.
    /// Defaults to the CLI's `decay::W_MIN` so legacy entries render sanely.
    #[serde(default = "default_importance")]
    pub importance: f32,
    /// Canonical scope manifest (AUDIT-CAP-01): which repo/checkout/session
    /// the memory was written in. Passed through opaquely.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<serde_json::Value>,

    // ── AUDIT-CTX-05 entry signature (mirrors aura-cli memory/signing.rs) ──
    /// Base64 (std, no pad) Ed25519 signature over the canonical payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
    /// Full 32-byte verifying key, base64url no-pad — self-certifying.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sig_pubkey: Option<String>,
    /// `did:aura:key/…` of the identity that signed this entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sig_key_id: Option<String>,

    // ── Sharing (AURA-1372, mirrors aura-cli memory/mod.rs) ──
    /// RFC3339 of the last successful `memory-cloud push` of this entry.
    /// Absent on a fact that has never left this machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_at: Option<String>,
    /// The SERVER's verdict on that push's signature — recorded rather
    /// than asserted, because whether the org can verify who wrote a fact
    /// is the receiving end's answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_signature: Option<String>,
    /// RFC3339 of the last `memory-cloud retract`. Kept after the fact is
    /// local again, because "never shared" and "shared and taken back"
    /// mean different things to whoever decides what to do next.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_retracted_at: Option<String>,

    /// COMPUTED at view time (never read from disk): "valid" | "invalid"
    /// | "unsigned" — the shell verifies each entry's signature natively
    /// via aura-attestation so the UI can show trust without trusting the
    /// JSON it just read.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub signed: Option<String>,
}

fn default_importance() -> f32 {
    0.3
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

/// Where the CLI actually keeps this checkout's memory. Mirrors
/// `aura-cli/src/worktree/paths.rs::private_aura_path`: in the main
/// checkout it is `<root>/.aura/memory.json`; in a LINKED worktree it is
/// `<main>/.aura/worktrees/<checkout-basename>/memory.json`. The old
/// `<root>/.aura/memory.json`-always resolution meant the desktop read and
/// wrote a file the CLI never touches whenever the project was a worktree.
fn memory_path(repo_root: &str) -> PathBuf {
    let root = PathBuf::from(repo_root);
    let git = root.join(".git");
    if git.is_file() {
        if let Some(main_root) = main_root_from_git_file(&git) {
            if let Some(name) = root.file_name().map(|n| n.to_string_lossy().to_string()) {
                if main_root != root && !name.is_empty() {
                    return main_root
                        .join(".aura")
                        .join("worktrees")
                        .join(name)
                        .join("memory.json");
                }
            }
        }
    }
    root.join(".aura").join("memory.json")
}

/// Resolve a possibly-relative path against `base`.
fn resolve_against(base: &Path, p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        base.join(p)
    }
}

/// Given a `.git` FILE (the marker of a linked worktree), find the main
/// checkout root. The file holds `gitdir: <path>` pointing at
/// `<main>/.git/worktrees/<name>`; that directory's `commondir` points back
/// at the real `<main>/.git` (authoritative), with a parent-walk fallback.
fn main_root_from_git_file(git_file: &Path) -> Option<PathBuf> {
    let here = git_file.parent()?;
    let body = fs::read_to_string(git_file).ok()?;
    let gitdir = body.trim().strip_prefix("gitdir:")?.trim();
    if gitdir.is_empty() {
        return None;
    }
    let wt_gitdir = resolve_against(here, Path::new(gitdir));
    let common_git = match fs::read_to_string(wt_gitdir.join("commondir")) {
        Ok(common) if !common.trim().is_empty() => {
            resolve_against(&wt_gitdir, Path::new(common.trim()))
        }
        // `<main>/.git/worktrees/<name>` → `<main>/.git`
        _ => wt_gitdir.parent()?.parent()?.to_path_buf(),
    };
    // Canonicalize BEFORE taking the parent: commondir is usually `../..`,
    // and a lexical `.parent()` on a `..`-suffixed path strips the wrong
    // component. The `.git` dir exists in any live repo, so this resolves.
    let common_git = common_git.canonicalize().ok()?;
    // `<main>/.git` → `<main>`.
    Some(common_git.parent()?.to_path_buf())
}

/// The read-time signature verdict for one entry, verified natively via
/// aura-attestation. Reproduces the exact payload from
/// `aura-cli/src/memory/signing.rs` — self-certifying: the embedded pubkey
/// must derive the claimed key id, then the signature must verify.
fn sig_verdict(e: &MemoryEntry, section: &str) -> &'static str {
    use aura_attestation::{SignatureBytes, VerifyingKey};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
    use sha2::{Digest, Sha256};

    let (sig_b64, pub_b64, key_id) = match (&e.sig, &e.sig_pubkey, &e.sig_key_id) {
        (Some(s), Some(p), Some(k)) => (s, p, k),
        (None, None, None) => return "unsigned",
        // Partial fields = stripped or half-written — never honest.
        _ => return "invalid",
    };
    let Ok(raw) = B64URL.decode(pub_b64) else {
        return "invalid";
    };
    let Ok(buf) = <[u8; 32]>::try_from(raw.as_slice()) else {
        return "invalid";
    };
    let Ok(vk) = VerifyingKey::from_bytes(&buf) else {
        return "invalid";
    };
    if vk.key_id() != *key_id {
        return "invalid";
    }
    let Ok(sig) = SignatureBytes::from_b64(sig_b64) else {
        return "invalid";
    };
    let mut hasher = Sha256::new();
    hasher.update(e.content.as_bytes());
    let payload = format!(
        "aura-memory-sig\n{}\n{}\n{}\n{}",
        e.id,
        section,
        hex::encode(hasher.finalize()),
        e.added_at
    );
    if vk.verify(payload.as_bytes(), &sig).is_ok() {
        "valid"
    } else {
        "invalid"
    }
}

#[tauri::command]
pub async fn aura_memory_view(
    repo_root: String,
    include_superseded: Option<bool>,
) -> Result<MemoryView, String> {
    // Reading the store is disk work — off the async runtime so the
    // UI thread never waits on it.
    crate::blocking::run(move || {
        let include_superseded = include_superseded.unwrap_or(false);
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
            let entries: Vec<MemoryEntry> = v
                .get(*s)
                .and_then(|x| x.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|e| serde_json::from_value::<MemoryEntry>(e.clone()).ok())
                        // Closed rows (superseded / soft-forgotten) are audit
                        // trail — hidden unless the caller asks for them.
                        .filter(|e: &MemoryEntry| include_superseded || e.valid_to.is_none())
                        .map(|mut e| {
                            e.signed = Some(sig_verdict(&e, s).to_string());
                            e
                        })
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
    })
    .await
}

/// Shell one `aura memory …` subcommand in `repo_root` and parse its
/// `--json` stdout. An `{"op":"error"}` envelope becomes an `Err` so the
/// frontend gets the CLI's plain-language message either way.
async fn run_memory_cli(
    repo_root: &str,
    args: Vec<String>,
) -> Result<serde_json::Value, String> {
    let cwd = PathBuf::from(repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }
    let bin = crate::agent_event_listener::resolve_aura_bin();
    let shown = args.join(" ");
    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new(&bin)
            .args(&args)
            .current_dir(&cwd)
            .output()
    })
    .await
    .map_err(|e| format!("memory task join: {e}"))?
    .map_err(|e| format!("failed to spawn `aura {shown}`: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "aura {shown} failed (status {}): {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("parse `aura {shown}` json: {e}"))?;
    if v.get("op").and_then(|x| x.as_str()) == Some("error") {
        return Err(v
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("memory operation failed")
            .to_string());
    }
    Ok(v)
}

/// Add a memory by shelling `aura memory add --json`. Returns the CLI's
/// reconcile envelope `{op, id, superseded, reason, section, entry}` —
/// `op` may be "added", "updated" (superseded a restatement), "deleted"
/// (the new fact invalidated an old one) or "noop" (exact duplicate), and
/// the UI should say which happened rather than pretending every write
/// appends. `entry` never carries an embedding vector.
#[tauri::command]
pub async fn aura_memory_write_entry(
    app: tauri::AppHandle,
    repo_root: String,
    section: String,
    content: String,
    tags: Vec<String>,
) -> Result<serde_json::Value, String> {
    let canonical = canonical_write_section(&section)?;
    let mut args = vec![
        "memory".to_string(),
        "add".to_string(),
        content,
        "--section".to_string(),
        canonical.to_string(),
        "--json".to_string(),
    ];
    let tags: Vec<String> = tags
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if !tags.is_empty() {
        args.push("--tags".to_string());
        args.push(tags.join(","));
    }
    let v = run_memory_cli(&repo_root, args).await?;
    let _ = app.emit("memory:changed", &repo_root);
    Ok(v)
}

/// Edit a memory by shelling `aura memory edit --json`: the old row keeps
/// its audit trail (valid_to closes) and a signed successor lands with a
/// `supersedes` back-pointer. `tags: None` inherits the old row's tags.
#[tauri::command]
pub async fn aura_memory_update_entry(
    app: tauri::AppHandle,
    repo_root: String,
    id: String,
    content: String,
    tags: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let mut args = vec![
        "memory".to_string(),
        "edit".to_string(),
        id,
        content,
        "--json".to_string(),
    ];
    if let Some(tags) = tags {
        args.push("--tags".to_string());
        args.push(
            tags.iter()
                .map(|t| t.trim())
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    let v = run_memory_cli(&repo_root, args).await?;
    let _ = app.emit("memory:changed", &repo_root);
    Ok(v)
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
    app: tauri::AppHandle,
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
    let report = serde_json::from_str::<ClaudeImportReport>(stdout.trim())
        .map_err(|e| format!("parse import json: {e}"))?;
    if !dry_run && report.imported + report.updated > 0 {
        let _ = app.emit("memory:changed", &repo_root);
    }
    Ok(report)
}

/// Forget a memory by shelling `aura memory forget --json`. Default is a
/// SOFT forget — the row's validity window closes so it leaves recall but
/// stays on disk as audit trail. `hard: true` is the privacy path: the row
/// is erased entirely.
#[tauri::command]
pub async fn aura_memory_forget_entry(
    app: tauri::AppHandle,
    repo_root: String,
    id: String,
    hard: Option<bool>,
) -> Result<bool, String> {
    let mut args = vec![
        "memory".to_string(),
        "forget".to_string(),
        id,
        "--json".to_string(),
    ];
    if hard.unwrap_or(false) {
        args.push("--hard".to_string());
    }
    let v = run_memory_cli(&repo_root, args).await?;
    let _ = app.emit("memory:changed", &repo_root);
    Ok(v.get("removed").and_then(|x| x.as_bool()).unwrap_or(false))
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
    // Reading the store is disk work — off the async runtime so the
    // UI thread never waits on it.
    crate::blocking::run(move || {
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
    })
    .await
}

#[tauri::command]
pub async fn aura_session_read(
    repo_root: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
    // Reading the store is disk work — off the async runtime so the
    // UI thread never waits on it.
    crate::blocking::run(move || {
        let path = PathBuf::from(&repo_root)
            .join(".aura")
            .join("sessions")
            .join(format!("{}.json", session_id));
        if !path.exists() {
            return Err(format!("session not found: {}", session_id));
        }
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    })
    .await
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
            "supersedes",
            "scope",
            "sig",
            "sig_pubkey",
            "sig_key_id",
            "shared_at",
            "shared_signature",
            "shared_retracted_at",
            "signed",
        ] {
            assert!(out.get(key).is_none(), "{} must be skipped when None", key);
        }
    }

    /// The worktree trap this file used to have: a linked worktree's
    /// memory lives under the MAIN checkout's `.aura/worktrees/<name>/`,
    /// exactly where the CLI's `private_aura_path` puts it — not in the
    /// worktree's own `.aura/`. The old resolution read a file the CLI
    /// never writes, so the desktop showed an empty (or stale) store.
    #[test]
    fn memory_path_resolves_linked_worktree_to_main_private_plane() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let main = tmp.path().join("mainrepo");
        let wt = tmp.path().join("granada");
        let wt_meta = main.join(".git").join("worktrees").join("granada");
        fs::create_dir_all(&wt_meta).unwrap();
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt_meta.join("commondir"), "../..\n").unwrap();
        fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", wt_meta.display()),
        )
        .unwrap();

        let got = memory_path(&wt.to_string_lossy());
        let want = main
            .canonicalize()
            .unwrap()
            .join(".aura")
            .join("worktrees")
            .join("granada")
            .join("memory.json");
        assert_eq!(got, want, "linked worktree resolves into the main private plane");

        // A main checkout (`.git` is a directory) stays local.
        fs::create_dir_all(main.join(".git")).unwrap();
        let got_main = memory_path(&main.to_string_lossy());
        assert_eq!(got_main, main.join(".aura").join("memory.json"));
    }

    /// Writes may only land in entry-shaped sections. `decisions` and
    /// `architecture` hold different shapes in the CLI store — an entry
    /// pushed there breaks the CLI's next load and silently resets the
    /// whole file, which is why the gate speaks plain language.
    #[test]
    fn writable_section_gate_maps_aliases_and_rejects_structured_sections() {
        assert_eq!(canonical_write_section("gotcha"), Ok("gotchas"));
        assert_eq!(canonical_write_section("Conventions"), Ok("conventions"));
        assert_eq!(canonical_write_section("active"), Ok("active_work"));
        assert_eq!(canonical_write_section("context"), Ok("context"));
        let err = canonical_write_section("decisions").unwrap_err();
        assert!(err.contains("maintained by Aura"), "plain-language refusal: {err}");
        assert!(canonical_write_section("architecture").is_err());
        assert!(canonical_write_section("bogus").unwrap_err().contains("Unknown"));
    }

    /// Native verification mirrors aura-cli's memory/signing.rs payload
    /// byte-for-byte: a properly signed entry verdicts "valid", tampered
    /// content flips it to "invalid", absent fields are honest "unsigned",
    /// and partial fields are never trusted.
    #[test]
    fn sig_verdict_valid_tampered_unsigned() {
        use aura_attestation::SigningKey;
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
        use sha2::{Digest, Sha256};

        let mut e: MemoryEntry = serde_json::from_value(serde_json::json!({
            "id": "mem-cafe0001",
            "content": "the retry cap is 3",
            "added_at": 1_765_432_100_i64,
        }))
        .unwrap();
        assert_eq!(sig_verdict(&e, "gotchas"), "unsigned");

        let sk = SigningKey::generate();
        let mut hasher = Sha256::new();
        hasher.update(e.content.as_bytes());
        let payload = format!(
            "aura-memory-sig\n{}\ngotchas\n{}\n{}",
            e.id,
            hex::encode(hasher.finalize()),
            e.added_at
        );
        e.sig = Some(sk.sign(payload.as_bytes()).to_b64());
        e.sig_pubkey = Some(B64URL.encode(sk.verifying_key().to_bytes()));
        e.sig_key_id = Some(sk.key_id());
        assert_eq!(sig_verdict(&e, "gotchas"), "valid");
        // Same entry claimed in a different section — payload mismatch.
        assert_eq!(sig_verdict(&e, "context"), "invalid");

        let mut tampered = e.clone();
        tampered.content = "the retry cap is 999".to_string();
        assert_eq!(sig_verdict(&tampered, "gotchas"), "invalid");

        let mut partial = e.clone();
        partial.sig_pubkey = None;
        assert_eq!(sig_verdict(&partial, "gotchas"), "invalid");
    }
}
