//! Plain-language "what changed" summaries for a single working-tree file.
//!
//! The file-insight panel's "What changed" line used to show raw AST symbol
//! names (`fn foo`, `class Bar`) — meaningless to the non-engineer audience
//! Aura is built for. This command turns a file's diff into ONE everyday
//! sentence using whichever model the user already has reachable
//! (`select_backend_preferred` — ollama / an authenticated agent-CLI / an API
//! key), and caches it by diff content-hash in `.aura/change_summaries.jsonl`
//! so the model is called at most once per distinct edit.
//!
//! This is the durable half of the "always-on agent fills in what+why" story:
//! the filesystem watcher captures the WHY (the agent's session prompt); this
//! command captures the WHAT in words a human can read. When no model is
//! reachable we fall back to a deterministic plain-language line — never a
//! symbol name, never a stack trace, never a jargon stub.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Semaphore;

use crate::aurawatch_inference::{self, InferContext, InferTask, InferenceBackend};
use crate::recorded_reason::{self, RecordedReason};

/// What the frontend receives for the "What changed" line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeSummary {
    /// The plain-language sentence shown to the user. Empty when the file
    /// has no diff to describe.
    pub summary: String,
    /// Provenance of the summary: `"model"` (one of the user's backends),
    /// `"fallback"` (deterministic — no model reachable), `"cache"` (a
    /// prior summary for this exact diff), or `"none"` (no diff).
    pub source: String,
    /// blake3 of the diff this summary describes. The frontend keys its
    /// in-memory cache on this so a summary is reused until the file
    /// actually changes again.
    pub diff_hash: String,
}

/// One append-only line in `.aura/change_summaries.jsonl`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheRecord {
    /// Repo-relative, forward-slash path.
    path: String,
    diff_hash: String,
    /// Which angle this line caches: `""` = the one-sentence `summarize`
    /// output (legacy records have no field → default `""`); `"before"` /
    /// `"what"` / `"why"` = the split-diff explanation angles. Keying on it
    /// lets the three angles share one file without colliding.
    #[serde(default)]
    task: String,
    summary: String,
    source: String,
    ts: i64,
}

/// Produce (or reuse) a one-sentence, plain-language description of what
/// changed in `path` relative to its last committed state. Never errors on a
/// missing model — it falls back to a deterministic line. Only errors when the
/// repo root itself is bogus.
#[tauri::command]
pub async fn summarize_file_change(
    repo_root: String,
    path: String,
) -> Result<ChangeSummary, String> {
    let cwd = PathBuf::from(&repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }
    let rel = rel_path(&cwd, &path);

    let diff = single_file_diff(&repo_root, &rel).await;
    if diff.trim().is_empty() {
        // Nothing to describe — file matches its last committed state (or
        // git is unavailable). The panel shows its own "no changes" copy.
        return Ok(ChangeSummary {
            summary: String::new(),
            source: "none".into(),
            diff_hash: String::new(),
        });
    }
    let diff_hash = summary_key(&diff);

    // 1) Reuse a summary already computed for this exact diff.
    if let Some(hit) = cache_lookup(&cwd, &rel, &diff_hash, "").await {
        return Ok(ChangeSummary {
            summary: hit.summary,
            source: "cache".into(),
            diff_hash,
        });
    }

    // 2) Paint instantly with the deterministic, diff-mined line, and compute
    //    the model off the request path to cache for next time. Never block the
    //    panel on a live model spawn (a cold agent-CLI call can take seconds).
    {
        let cwd = cwd.clone();
        let rel = rel.clone();
        let diff = diff.clone();
        let diff_hash = diff_hash.clone();
        tokio::spawn(async move {
            if cache_lookup(&cwd, &rel, &diff_hash, "").await.is_some() {
                return;
            }
            let (summary, source) = generate_summary(&rel, &diff).await;
            if source == "model" {
                let _ = cache_store(
                    &cwd,
                    &CacheRecord {
                        path: rel,
                        diff_hash,
                        task: String::new(),
                        summary,
                        source,
                        ts: now_secs(),
                    },
                )
                .await;
            }
        });
    }

    Ok(ChangeSummary {
        summary: deterministic_what(&diff),
        source: "fallback".into(),
        diff_hash,
    })
}

/// Ask the user's preferred reachable backend for a plain-language "what
/// changed" sentence. Returns `(summary, source)`.
async fn generate_summary(rel: &str, diff: &str) -> (String, String) {
    let backend = aurawatch_inference::select_backend_preferred(None).await;

    // `Generic` is the sentinel for "no real model reachable". Don't waste a
    // round-trip — go straight to the deterministic line.
    if matches!(backend, InferenceBackend::Generic) {
        return (deterministic_what(diff), "fallback".into());
    }

    let ctx = InferContext {
        files: vec![rel.to_string()],
        // The inference layer truncates further; cap here so a huge diff
        // doesn't dominate the request body.
        diff_excerpt: diff.chars().take(4000).collect(),
        assistant_tail: String::new(),
        task: InferTask::What,
    };

    match aurawatch_inference::infer(&backend, &ctx).await {
        Ok(s) => {
            let cleaned = sanitize(&s);
            if cleaned.is_empty() {
                (deterministic_what(diff), "fallback".into())
            } else {
                (cleaned, "model".into())
            }
        }
        Err(_) => (deterministic_what(diff), "fallback".into()),
    }
}

/// Multi-angle, plain-language explanation of a change: what it USED TO DO
/// (`before`), what it does NOW (`what`), and WHY it was changed and how it now
/// works (`why`). Powers the split-diff's before/after columns and reasoning
/// band. Works on either the working-tree edit or a specific past `commit`, and
/// caches each angle by (path, diff_hash, angle) so a model is called at most
/// once per distinct change per angle.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeExplanation {
    /// What this part of the project used to do, in plain words. Empty for a
    /// brand-new addition (there was nothing before to describe).
    pub before: String,
    /// What the change does / what it does now, in plain words.
    pub what: String,
    /// Why the change was made and, briefly, how it now works.
    pub why: String,
    /// Where the `why` came from, on its own, because it is the one angle that
    /// can be a fact rather than a reading: `"recorded"` when the author stated
    /// it against this file (`aura snapshot-file --why`), else `"model"` /
    /// `"cache"` / `"fallback"` / `"none"` like the rest. A reviewer has to be
    /// able to tell "the author said this" from "Aura read the diff and thinks
    /// this", and the rolled-up `source` below cannot carry that.
    #[serde(default)]
    pub why_source: String,
    /// Who recorded the reason, when `why_source` is `"recorded"` — the human
    /// handle if the log has one, else the agent's name. Empty otherwise.
    #[serde(default)]
    pub why_author: String,
    /// When the reason was recorded (unix seconds), for `"recorded"` only. 0
    /// otherwise.
    #[serde(default)]
    pub why_stated_at: i64,
    /// Rolled-up provenance: `"model"`, `"cache"`, `"fallback"` when every
    /// angle shares one source, `"mixed"` when they differ, `"none"` for no diff.
    pub source: String,
    /// blake3 of (scope + diff). The frontend keys its in-memory cache on this
    /// so the explanation is reused until the change itself changes.
    pub diff_hash: String,
}

/// Which angle of the explanation to produce.
#[derive(Clone, Copy)]
enum ExplainAngle {
    Before,
    What,
    Why,
}

impl ExplainAngle {
    /// Stable cache tag stored in the JSONL record's `task` field.
    fn tag(self) -> &'static str {
        match self {
            ExplainAngle::Before => "before",
            ExplainAngle::What => "what",
            ExplainAngle::Why => "why",
        }
    }

    fn task(self) -> InferTask {
        match self {
            ExplainAngle::Before => InferTask::Before,
            ExplainAngle::What => InferTask::What,
            ExplainAngle::Why => InferTask::Reason,
        }
    }
}

/// Produce (or reuse) the before / what / why explanation for `path`. When
/// `commit` is given, describe the change *that commit* made to the file;
/// otherwise describe the current working-tree edit. Never errors on a missing
/// model — each angle falls back to a deterministic, jargon-free line.
#[tauri::command]
pub async fn explain_change(
    repo_root: String,
    path: String,
    commit: Option<String>,
) -> Result<ChangeExplanation, String> {
    let cwd = PathBuf::from(&repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }
    let rel = rel_path(&cwd, &path);

    let commit = commit.filter(|s| !s.trim().is_empty());
    let diff = match commit.as_deref() {
        Some(sha) => commit_file_diff(&repo_root, sha, &rel).await,
        None => single_file_diff(&repo_root, &rel).await,
    };

    // A reason the author stated for THIS file, bounded to the change under
    // review, beats anything a model can read off the diff. Only this entry
    // point knows which revision is being explained, so the window is computed
    // here and the shared explanation path is simply handed the answer.
    let recorded = recorded_reason_for(&repo_root, &rel, commit.as_deref()).await;

    Ok(explain_from_diff(&cwd, &rel, &diff, recorded).await)
}

/// The reason recorded for `rel` against the revision being explained.
///
/// A commit takes the window between its parent's commit time and its own, so a
/// reason written for a later edit of the same file can never be shown as the
/// reason for this one. A working-tree edit takes everything since `HEAD`,
/// which is exactly the span the uncommitted diff covers.
async fn recorded_reason_for(
    repo_root: &str,
    rel: &str,
    commit: Option<&str>,
) -> Option<RecordedReason> {
    let (after, until) = match commit {
        Some(sha) => (
            git_commit_time(repo_root, &format!("{sha}^")).await,
            git_commit_time(repo_root, sha).await,
        ),
        None => (git_commit_time(repo_root, "HEAD").await, None),
    };
    let root = PathBuf::from(repo_root);
    let rel = rel.to_string();
    // The log is a few thousand lines; read it off the async runtime's thread.
    tokio::task::spawn_blocking(move || {
        let rows = recorded_reason::read_reason_rows(&root);
        recorded_reason::reason_for_file(&rows, &rel, after, until)
    })
    .await
    .ok()
    .flatten()
}

/// Author time of a revision, or `None` when it does not resolve — a root
/// commit has no parent, and an unborn `HEAD` has nothing at all.
async fn git_commit_time(repo_root: &str, rev: &str) -> Option<i64> {
    let out = Command::new("git")
        .args(["show", "-s", "--format=%ct", rev])
        .current_dir(repo_root)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// Same before / what / why explanation, but for a diff the caller already
/// holds — the raw unified diff of one file across a pull request's base..head
/// range, which the PR review surface loads from `gh pr diff`. A PR file has no
/// single commit to point at, so the hunk text is passed in directly.
#[tauri::command]
pub async fn explain_change_diff(
    repo_root: String,
    path: String,
    diff: String,
) -> Result<ChangeExplanation, String> {
    let cwd = PathBuf::from(&repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }
    let rel = rel_path(&cwd, &path);
    // A pull request's base..head range spans many commits, so no single window
    // bounds a recorded reason to it. Rather than borrow one that may belong to
    // a different commit in the range, this path stays inferred.
    Ok(explain_from_diff(&cwd, &rel, &diff, None).await)
}

/// Plain-language meaning for ONE changed piece — the per-node "New is this" /
/// "Previous was this" blurb in the split-diff header. The file-level
/// before/what/why can't speak for each of several changed pieces, so this
/// describes each piece on its own: what that function/class does now (or did,
/// for a removed one).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolExplanation {
    /// The piece's identifier — the frontend keys its per-node override on this.
    pub identifier: String,
    /// One plain sentence for what this piece does NOW — the "New is this" side.
    /// Empty until the model has written it (a changed piece never gets a
    /// jargon-mined interim; the caller shows a plain generic placeholder while
    /// this is empty, then swaps this in when it lands).
    pub now: String,
    /// One plain sentence for what this piece USED TO DO — the "Previous was
    /// this" side. Empty for a pure addition, and empty until the model writes
    /// it for a modified/removed piece.
    pub before: String,
    /// `"cache"` when at least one side was already stored, else `"none"`.
    pub source: String,
}

/// The slice of a changed symbol the frontend already holds (from the AST
/// change-note). Extra fields on the JS object (signature, rationale) are
/// ignored by serde.
#[derive(Debug, Clone, Deserialize)]
pub struct SymbolInput {
    pub identifier: String,
    pub kind: String,
    /// `"added"` | `"modified"` | `"deleted"`.
    pub change: String,
    #[serde(default)]
    pub start_line: Option<usize>,
    #[serde(default)]
    pub end_line: Option<usize>,
}

/// Which side of a piece a model line speaks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SymSide {
    /// What the piece does now — the "New is this" blurb (new side).
    Now,
    /// What the piece used to do — the "Previous was this" blurb (old side).
    Before,
}

/// Produce (or reuse) a per-piece plain-language meaning for each changed symbol
/// in a file — BOTH what it does now and what it used to do. The reader-facing
/// node line is ALWAYS model-written plain language (a modified piece never
/// leaks a mined variable name); until the model lands, the field is empty and
/// the caller shows a plain generic placeholder, then swaps this in. `commit`
/// scopes it to a past commit; omit for the working-tree edit. The model runs
/// off the request path and both sides are cached once written, so the second
/// look is instant. Never errors on a missing model.
#[tauri::command]
pub async fn explain_symbols(
    repo_root: String,
    path: String,
    commit: Option<String>,
    symbols: Vec<SymbolInput>,
) -> Result<Vec<SymbolExplanation>, String> {
    let cwd = PathBuf::from(&repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }
    if symbols.is_empty() {
        return Ok(Vec::new());
    }
    let rel = rel_path(&cwd, &path);

    let commit = commit.filter(|s| !s.trim().is_empty());
    let diff = match commit.as_deref() {
        Some(sha) => commit_file_diff(&repo_root, sha, &rel).await,
        None => single_file_diff(&repo_root, &rel).await,
    };
    if diff.trim().is_empty() {
        return Ok(Vec::new());
    }
    // Same content key the file-level explanation uses, so both share the cache
    // file and a change explained once is explained everywhere it appears.
    let diff_hash = summary_key(&diff);

    let mut out = Vec::with_capacity(symbols.len());
    // (symbol, side) pairs whose model line isn't cached yet — filled in the
    // background so a reopen (or the frontend's live re-poll) reads richer.
    let mut jobs: Vec<(SymbolInput, SymSide)> = Vec::new();
    for sym in &symbols {
        // A pure addition has no "before"; a deletion has no "now".
        let wants_now = sym.change != "deleted";
        let wants_before = sym.change != "added";

        let now = if wants_now {
            cache_lookup(&cwd, &rel, &diff_hash, &symbol_tag(&sym.identifier)).await
        } else {
            None
        };
        let before = if wants_before {
            cache_lookup(&cwd, &rel, &diff_hash, &symbol_before_tag(&sym.identifier)).await
        } else {
            None
        };

        if wants_now && now.is_none() {
            jobs.push((sym.clone(), SymSide::Now));
        }
        if wants_before && before.is_none() {
            jobs.push((sym.clone(), SymSide::Before));
        }

        let has_any = now.is_some() || before.is_some();
        out.push(SymbolExplanation {
            identifier: sym.identifier.clone(),
            now: now.map(|h| h.summary).unwrap_or_default(),
            before: before.map(|h| h.summary).unwrap_or_default(),
            source: if has_any { "cache".into() } else { "none".into() },
        });
    }

    if !jobs.is_empty() {
        spawn_symbol_backfill(cwd, rel, diff, diff_hash, jobs);
    }
    Ok(out)
}

/// Write the plain-language account of a change AS IT HAPPENS, rather than
/// waiting for someone to open it.
///
/// Everything here was already computed lazily: you opened a file's changes, the
/// generic placeholders showed, and the real sentences swapped in perhaps a
/// minute later as the model wrote them one piece at a time. That minute was
/// always avoidable — nothing about the work needs a reader present. The change
/// is finished; the words could have been written the moment it landed.
///
/// So the shell calls this when a change is recorded (a commit lands, an agent
/// finishes a turn) and it queues the same file-level and per-piece jobs, off
/// the request path, with nobody waiting. By the time anyone looks, the words
/// are in `.aura/change_summaries.jsonl` and the surface paints filled-in.
/// Returns immediately with how many files were queued — it is fire-and-forget,
/// never blocks its caller, and never errors when no model is reachable (the
/// jobs simply find no backend and stop).
///
/// `commit` names what to describe: a sha, a `base...head` range, or omitted for
/// the working tree as it stands. Per-piece lines need the AST symbol delta, so
/// they are warmed for a commit or range (where the engine can diff two trees);
/// a working-tree call warms the file-level before/what/why.
#[tauri::command]
pub async fn prewarm_change_summaries(
    repo_root: String,
    commit: Option<String>,
) -> Result<usize, String> {
    let cwd = PathBuf::from(&repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }
    let commit = commit.filter(|s| !s.trim().is_empty());
    let files = changed_paths(&repo_root, commit.as_deref()).await;
    if files.is_empty() {
        return Ok(0);
    }

    // Symbols come from the engine's AST diff, which needs two trees to
    // compare — so they exist for a commit or a range, not for a dirty tree.
    let symbols_by_file = match commit.as_deref() {
        Some(spec) => changed_symbols(&repo_root, spec).await,
        None => Default::default(),
    };

    let queued = files.len();
    tokio::spawn(async move {
        for rel in files {
            let diff = match commit.as_deref() {
                Some(spec) => commit_file_diff(&repo_root, spec, &rel).await,
                None => single_file_diff(&repo_root, &rel).await,
            };
            if diff.trim().is_empty() {
                continue;
            }
            // The file-level angles. This resolves cache → model → deterministic
            // and caches real model output, which is the whole point: run it
            // now, with nobody waiting, and the reader's call is a cache hit.
            // The recorded reason is resolved here too, so a file whose author
            // already stated why doesn't spend a model call guessing at one.
            let recorded = recorded_reason_for(&repo_root, &rel, commit.as_deref()).await;
            explain_from_diff(&cwd, &rel, &diff, recorded).await;

            // Then the per-piece "does now" / "used to do" lines — the ones the
            // split header fills in a piece at a time. Same jobs the view-time
            // path spawns, and the same in-flight claim stops the two from
            // racing if someone opens the file mid-warm.
            if let Some(syms) = symbols_by_file.get(&rel) {
                let jobs: Vec<(SymbolInput, SymSide)> = syms
                    .iter()
                    .flat_map(|sym| {
                        let mut sides = Vec::new();
                        if sym.change != "deleted" {
                            sides.push((sym.clone(), SymSide::Now));
                        }
                        if sym.change != "added" {
                            sides.push((sym.clone(), SymSide::Before));
                        }
                        sides
                    })
                    .collect();
                if !jobs.is_empty() {
                    let key = summary_key(&diff);
                    spawn_symbol_backfill(cwd.clone(), rel.clone(), diff, key, jobs);
                }
            }
        }
    });
    Ok(queued)
}

/// The paths a change touched: a commit's or range's file list, or everything
/// currently different from HEAD. Empty on any git failure — a warm that can't
/// find its files simply does nothing.
async fn changed_paths(repo_root: &str, spec: Option<&str>) -> Vec<String> {
    let out = match spec {
        Some(s) if s.contains("..") => {
            Command::new("git")
                .args(["diff", "--name-only", "--no-color", s])
                .current_dir(repo_root)
                .output()
                .await
        }
        Some(s) => {
            Command::new("git")
                .args(["show", "--name-only", "--no-color", "--format=", s])
                .current_dir(repo_root)
                .output()
                .await
        }
        None => {
            Command::new("git")
                .args(["diff", "--name-only", "--no-color", "HEAD"])
                .current_dir(repo_root)
                .output()
                .await
        }
    };
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// The AST symbol delta per file, read from the engine's own change-note. Only
/// the fields the per-piece jobs need are pulled out; anything the engine can't
/// parse (non-code files, sub-symbol edits) simply isn't in the map. A missing
/// or failing CLI yields an empty map — the warm then covers file-level only.
async fn changed_symbols(
    repo_root: &str,
    spec: &str,
) -> std::collections::HashMap<String, Vec<SymbolInput>> {
    let mut map = std::collections::HashMap::new();
    let Ok(out) = Command::new(crate::agent_event_listener::resolve_aura_bin())
        .args(["change-note", spec, "--json"])
        .current_dir(repo_root)
        .output()
        .await
    else {
        return map;
    };
    if !out.status.success() {
        return map;
    }
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
        return map;
    };
    let Some(files) = json.get("files").and_then(|f| f.as_array()) else {
        return map;
    };
    for f in files {
        let Some(path) = f.get("file").and_then(|p| p.as_str()) else {
            continue;
        };
        let Some(syms) = f.get("symbols").and_then(|s| s.as_array()) else {
            continue;
        };
        let parsed: Vec<SymbolInput> = syms
            .iter()
            .filter_map(|s| serde_json::from_value(s.clone()).ok())
            .collect();
        if !parsed.is_empty() {
            map.insert(path.to_string(), parsed);
        }
    }
    map
}

/// Cache tag for one piece's "does now" meaning — namespaced so it can't collide
/// with the file-level angles (`before`/`what`/`why`) that share the JSONL file.
fn symbol_tag(identifier: &str) -> String {
    format!("sym:{identifier}")
}

/// Cache tag for one piece's "used to do" meaning — the old-side counterpart.
fn symbol_before_tag(identifier: &str) -> String {
    format!("symb:{identifier}")
}

/// Keys (`diff_hash` + cache tag) of per-symbol model jobs generating right now.
/// The frontend re-polls `explain_symbols` while lines are still being written,
/// so without this a second poll would fork a duplicate agent-CLI call for a
/// piece the first poll is already generating. A job claims its key on start and
/// releases it on finish; a job whose key is already claimed skips.
fn symbol_jobs_inflight() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// RAII claim on one in-flight symbol job — releases the key on drop, whatever
/// the outcome (cached, empty, or errored), so a later poll can retry.
struct SymbolJobGuard(String);
impl Drop for SymbolJobGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = symbol_jobs_inflight().lock() {
            set.remove(&self.0);
        }
    }
}

/// Claim a per-symbol job key. Returns the guard when we won it, or `None` when
/// another spawn is already generating that exact (piece, side) — the caller
/// then skips rather than duplicating the model call. The lock is never held
/// across an `.await`.
fn claim_symbol_job(key: String) -> Option<SymbolJobGuard> {
    let mut set = symbol_jobs_inflight().lock().ok()?;
    if set.contains(&key) {
        return None;
    }
    set.insert(key.clone());
    Some(SymbolJobGuard(key))
}

/// Off-request-path model computation for the per-piece blurbs: fill in every
/// (piece, side) that has no cached line yet, and cache real output. Never
/// touches the response the user is waiting on.
///
/// It asks about a whole side's pieces IN ONE CALL. The obvious shape — one
/// model call per piece per side — is what made this surface feel broken: a
/// file with a dozen changed pieces is twenty-odd calls, each a cold agent-CLI
/// spawn of some twenty seconds, three at a time. That is minutes of generic
/// placeholders for a change that finished long ago. The pieces share one diff
/// and one reading of it, so one call answers for all of them, and the reply is
/// split back into per-piece lines cached under each piece's own key — the read
/// path cannot tell a batched line from a singly-generated one.
///
/// Anything the batch doesn't answer for — a piece the model skipped, a reply
/// that came back unusable, or a side with only one piece, where the
/// single-piece prompt is simply better — falls through to the original
/// one-call-per-piece path. So a partial answer costs a few calls, not a lost
/// description.
fn spawn_symbol_backfill(
    cwd: PathBuf,
    rel: String,
    diff: String,
    diff_hash: String,
    jobs: Vec<(SymbolInput, SymSide)>,
) {
    tokio::spawn(async move {
        let backend = aurawatch_inference::select_backend_preferred(None).await;
        if matches!(backend, InferenceBackend::Generic) {
            return;
        }
        let backend = Arc::new(backend);
        for side in [SymSide::Now, SymSide::Before] {
            let mine: Vec<SymbolInput> = jobs
                .iter()
                .filter(|(_, s)| *s == side)
                .map(|(sym, _)| sym.clone())
                .collect();
            if mine.is_empty() {
                continue;
            }
            let left = run_symbol_batch(
                &cwd, &rel, &diff, &diff_hash, &backend, &mine, side,
            )
            .await;
            if !left.is_empty() {
                run_symbols_one_by_one(
                    &cwd, &rel, &diff, &diff_hash, &backend, &left, side,
                )
                .await;
            }
        }
    });
}

/// One model call for a whole side of a file. Returns the pieces it did NOT
/// answer for, so the caller can fall back for those and only those.
///
/// A single piece skips the batch entirely: the single-piece prompt names its
/// subject in the system prompt and gives a better sentence, and there is
/// nothing to amortise.
async fn run_symbol_batch(
    cwd: &Path,
    rel: &str,
    diff: &str,
    diff_hash: &str,
    backend: &InferenceBackend,
    syms: &[SymbolInput],
    side: SymSide,
) -> Vec<SymbolInput> {
    // Only ask about pieces that still need an answer, and hold their claims
    // for the length of the call so a concurrent poll doesn't fork per-piece
    // calls for the very pieces this batch is about to describe.
    let mut wanted: Vec<SymbolInput> = Vec::new();
    let mut guards: Vec<SymbolJobGuard> = Vec::new();
    for sym in syms {
        let tag = side_tag(&sym.identifier, side);
        if cache_lookup(cwd, rel, diff_hash, &tag).await.is_some() {
            continue;
        }
        match claim_symbol_job(format!("{diff_hash}\u{0}{tag}")) {
            Some(g) => {
                guards.push(g);
                wanted.push(sym.clone());
            }
            // Someone else is already writing this one — not ours to redo.
            None => continue,
        }
    }
    if wanted.len() < 2 {
        // Nothing to amortise: hand it straight back to the single-piece path,
        // which reads better. Dropping the guards first lets it claim its own.
        drop(guards);
        return wanted;
    }
    let lines = generate_symbol_batch(backend, rel, diff, &wanted, side).await;
    let mut missed = Vec::new();
    for sym in wanted {
        match lines.get(&sym.identifier) {
            Some(text) if !text.is_empty() => {
                let _ = cache_store(
                    cwd,
                    &CacheRecord {
                        path: rel.to_string(),
                        diff_hash: diff_hash.to_string(),
                        task: side_tag(&sym.identifier, side),
                        summary: text.clone(),
                        source: "model".into(),
                        ts: now_secs(),
                    },
                )
                .await;
            }
            _ => missed.push(sym),
        }
    }
    drop(guards);
    missed
}

/// The original path: one model call per piece, bounded so a cold agent-CLI
/// spawn per piece doesn't fork a dozen processes at once. Now the fallback for
/// what a batch couldn't answer, rather than the way every line is written.
async fn run_symbols_one_by_one(
    cwd: &Path,
    rel: &str,
    diff: &str,
    diff_hash: &str,
    backend: &InferenceBackend,
    syms: &[SymbolInput],
    side: SymSide,
) {
    let sem = Arc::new(Semaphore::new(3));
    let futs = syms.iter().map(|sym| {
        let sem = Arc::clone(&sem);
        async move {
            let _permit = sem.acquire().await;
            let tag = side_tag(&sym.identifier, side);
            if cache_lookup(cwd, rel, diff_hash, &tag).await.is_some() {
                return;
            }
            // Skip if another spawn is already generating this exact (piece,
            // side); the guard releases the claim when this finishes.
            let _job = match claim_symbol_job(format!("{diff_hash}\u{0}{tag}")) {
                Some(g) => g,
                None => return,
            };
            // Re-check under the claim — the job we'd have raced may have just
            // cached it between our miss and our claim.
            if cache_lookup(cwd, rel, diff_hash, &tag).await.is_some() {
                return;
            }
            let (text, src) = generate_symbol_side(backend, rel, diff, sym, side).await;
            if src == "model" {
                let _ = cache_store(
                    cwd,
                    &CacheRecord {
                        path: rel.to_string(),
                        diff_hash: diff_hash.to_string(),
                        task: tag,
                        summary: text,
                        source: src,
                        ts: now_secs(),
                    },
                )
                .await;
            }
        }
    });
    futures_util::future::join_all(futs).await;
}

/// The cache tag for one piece on one side.
fn side_tag(identifier: &str, side: SymSide) -> String {
    match side {
        SymSide::Now => symbol_tag(identifier),
        SymSide::Before => symbol_before_tag(identifier),
    }
}

/// Ask the backend to describe every listed piece at once, and split the reply
/// back into one plain sentence per piece. Returns only the pieces it actually
/// answered for — a name the model invented is dropped, and a piece it skipped
/// is simply absent, so the caller can retry that one on its own.
async fn generate_symbol_batch(
    backend: &InferenceBackend,
    rel: &str,
    diff: &str,
    syms: &[SymbolInput],
    side: SymSide,
) -> std::collections::HashMap<String, String> {
    if matches!(backend, InferenceBackend::Generic) || syms.is_empty() {
        return Default::default();
    }
    let (task, verb) = match side {
        SymSide::Now => (InferTask::SymbolBatch, "does now"),
        SymSide::Before => (
            InferTask::SymbolBatchBefore,
            "used to do, before this change",
        ),
    };
    let listed = syms
        .iter()
        .map(|s| format!("- {} (a {})", s.identifier, plain_symbol_kind(&s.kind)))
        .collect::<Vec<_>>()
        .join("\n");
    let focus = format!(
        "Describe what each of these pieces {verb}. Write one line per piece, \
as `name: sentence`.\n\n{listed}\n\n{}",
        diff.chars().take(6000).collect::<String>(),
    );
    let ctx = InferContext {
        files: vec![rel.to_string()],
        diff_excerpt: focus,
        assistant_tail: String::new(),
        task,
    };
    match aurawatch_inference::infer(backend, &ctx).await {
        Ok(reply) => parse_batch_lines(
            &reply,
            &syms.iter().map(|s| s.identifier.clone()).collect::<Vec<_>>(),
        ),
        Err(_) => Default::default(),
    }
}

/// Split one `name: sentence` line at the colon that separates the two — the
/// first one that isn't part of a `::` path, so `Foo::bar: does a thing` splits
/// after `bar` and not after `Foo`.
fn split_name_from_sentence(line: &str) -> Option<(&str, &str)> {
    let b = line.as_bytes();
    for (i, ch) in b.iter().enumerate() {
        if *ch != b':' {
            continue;
        }
        let joins_path = b.get(i + 1) == Some(&b':') || (i > 0 && b[i - 1] == b':');
        if joins_path {
            continue;
        }
        return Some((&line[..i], &line[i + 1..]));
    }
    None
}

/// Split a batched reply into one sentence per piece.
///
/// The model was asked for `name: sentence` lines and usually obliges, but it
/// is a model: it numbers them, bullets them, back-ticks the name, wraps the
/// whole thing in a preamble, or answers about a name nobody asked for. So the
/// name is matched against the pieces we asked about rather than trusted, and
/// anything unmatched is dropped — a piece with no line simply gets retried on
/// its own, which is far better than showing the reader a sentence about the
/// wrong piece.
///
/// The sentence goes through the same `sanitize` every single-piece line does,
/// so a refusal or a piece of meta-commentary is discarded here too.
fn parse_batch_lines(
    reply: &str,
    wanted: &[String],
) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for raw in reply.lines() {
        // Strip list furniture the prompt asked for and the model added anyway.
        let line = raw
            .trim()
            .trim_start_matches(|c: char| c == '-' || c == '*' || c == '•')
            .trim_start();
        let line = line
            .trim_start_matches(|c: char| c.is_ascii_digit())
            .trim_start_matches(['.', ')'])
            .trim();
        let Some((head, rest)) = split_name_from_sentence(line) else {
            continue;
        };
        let name = head
            .trim()
            .trim_matches(|c: char| c == '`' || c == '"' || c == '\'' || c == '*')
            .trim();
        if name.is_empty() {
            continue;
        }
        // Match the name to a piece we actually asked about. Exact first, then
        // case-insensitively, then on the last path/namespace segment — models
        // will happily answer for `Foo::bar` when asked about `bar`.
        let Some(id) = wanted
            .iter()
            .find(|w| w.as_str() == name)
            .or_else(|| wanted.iter().find(|w| w.eq_ignore_ascii_case(name)))
            .or_else(|| {
                let tail = name.rsplit(['.', ':']).next().unwrap_or(name);
                wanted.iter().find(|w| w.eq_ignore_ascii_case(tail))
            })
        else {
            continue;
        };
        let sentence = sanitize(rest);
        if sentence.is_empty() {
            continue;
        }
        // First line for a piece wins; a model that repeats itself doesn't get
        // to overwrite its own better answer.
        out.entry(id.clone()).or_insert(sentence);
    }
    out
}

/// Ask the (already-selected) backend to describe one piece — its "does now" or
/// "used to do" job — in plain words. The piece is named at the head of the diff
/// excerpt so the model knows which of several changed pieces to speak for, and
/// the tense is set by `side`. Returns `("", "none")` on a sentinel backend,
/// empty reply, or error: there is deliberately NO deterministic fallback here,
/// because a mined line leaks variable names on this reader-facing surface — an
/// empty line lets the caller keep its plain generic placeholder instead.
async fn generate_symbol_side(
    backend: &InferenceBackend,
    rel: &str,
    diff: &str,
    sym: &SymbolInput,
    side: SymSide,
) -> (String, String) {
    if matches!(backend, InferenceBackend::Generic) {
        return (String::new(), "none".into());
    }
    let kind = plain_symbol_kind(&sym.kind);
    let (task, verb) = match side {
        SymSide::Now => (InferTask::Symbol, "does now"),
        SymSide::Before => (InferTask::SymbolBefore, "used to do, before this change"),
    };
    // Name the piece up front, then the diff. The system prompt (tense-matched
    // to `side`) tells the model to describe only that piece, in plain words.
    let focus = format!(
        "Focus only on the {kind} called \"{}\". Describe what it {verb}.\n\n{}",
        sym.identifier,
        diff.chars().take(3600).collect::<String>(),
    );
    let ctx = InferContext {
        files: vec![rel.to_string()],
        diff_excerpt: focus,
        assistant_tail: String::new(),
        task,
    };
    match aurawatch_inference::infer(backend, &ctx).await {
        Ok(s) => {
            let cleaned = sanitize(&s);
            if cleaned.is_empty() {
                (String::new(), "none".into())
            } else {
                (cleaned, "model".into())
            }
        }
        Err(_) => (String::new(), "none".into()),
    }
}

/// Plain noun for a tree-sitter node kind (`function_item` → "function"),
/// tolerant of the many language-specific spellings.
fn plain_symbol_kind(kind: &str) -> &'static str {
    let k = kind.to_ascii_lowercase();
    if k.contains("function") || k.contains("method") || k.contains("arrow") {
        "function"
    } else if k.contains("class") {
        "class"
    } else if k.contains("struct") {
        "structure"
    } else if k.contains("enum") {
        "set of options"
    } else if k.contains("trait") {
        "trait"
    } else if k.contains("interface") {
        "interface"
    } else if k.contains("type") {
        "type"
    } else {
        "piece"
    }
}

/// The cache key for everything written about one change: the hash of the diff
/// itself, and nothing else.
///
/// This used to be salted with a "scope" — `"wt"` for a working-tree edit, the
/// sha for a committed one, `"pr"` for a pull request — which meant the same
/// bytes were filed under three different keys. The practical cost was that all
/// the plain-language work done while an agent was still editing was thrown away
/// the moment it committed: you would watch the words appear, commit, open the
/// change, and wait for the model to write the identical sentences a second
/// time. Same again when the change reached a pull request.
///
/// The diff IS the identity. A given patch means the same thing whether you are
/// reading it dirty in your tree, at the commit that landed it, or in the pull
/// request that proposes it — so it is described once and reused everywhere. The
/// path is a separate cache column, so two files that happen to change
/// identically still get their own lines.
fn summary_key(diff: &str) -> String {
    blake3::hash(diff.as_bytes()).to_hex().to_string()
}

/// Core of both explanation commands: given a file's diff, produce the
/// before/what/why explanation, resolving each angle cache → model →
/// deterministic and caching only real model output.
async fn explain_from_diff(
    cwd: &Path,
    rel: &str,
    diff: &str,
    recorded: Option<RecordedReason>,
) -> ChangeExplanation {
    if diff.trim().is_empty() {
        return empty_explanation();
    }
    let diff_hash = summary_key(diff);

    // A pure addition has no "before" — skip that angle entirely.
    let (_, dels) = count_changes(diff);
    let mut angles: Vec<ExplainAngle> = if dels > 0 {
        vec![ExplainAngle::Before, ExplainAngle::What, ExplainAngle::Why]
    } else {
        vec![ExplainAngle::What, ExplainAngle::Why]
    };
    // The author already said why. Asking a model to guess it, and then showing
    // the guess, would be replacing a fact with a reading of the same change.
    if recorded.is_some() {
        angles.retain(|a| !matches!(a, ExplainAngle::Why));
    }
    let angles = &angles[..];

    let mut before = String::new();
    let mut what = String::new();
    let mut why = String::new();
    let mut sources: Vec<&str> = Vec::new();
    let mut uncached: Vec<ExplainAngle> = Vec::new();

    // The recorded reason goes in verbatim, in the author's own words, and its
    // provenance travels with it so the surface can attribute it rather than
    // presenting it as Aura's reading.
    let (why_source, why_author, why_stated_at) = match &recorded {
        Some(r) => {
            why = r.text.clone();
            sources.push("recorded");
            ("recorded".to_string(), r.author.clone(), r.stated_at)
        }
        None => (String::new(), String::new(), 0),
    };

    // Paint INSTANTLY. A cached model line wins per angle; otherwise the
    // deterministic, diff-mined line shows now. We never block this view on a
    // live model call — a cold agent-CLI spawn can take many seconds, and three
    // sequential angles would wedge the header for the better part of a minute.
    // The model is computed off the request path below and refines the words on
    // the next open.
    for &angle in angles {
        if let Some(hit) = cache_lookup(cwd, rel, &diff_hash, angle.tag()).await {
            assign(&mut before, &mut what, &mut why, angle, hit.summary);
            sources.push("cache");
        } else {
            assign(
                &mut before,
                &mut what,
                &mut why,
                angle,
                deterministic_angle(diff, angle),
            );
            sources.push("fallback");
            uncached.push(angle);
        }
    }

    // Background upgrade: compute the model line for any angle not yet cached and
    // store it, so re-opening this exact change shows the richer sentence. Fire-
    // and-forget and self-limiting (once cached it never re-runs) — it can never
    // block, slow, or hang the response the user is waiting on.
    if !uncached.is_empty() {
        spawn_model_backfill(
            cwd.to_path_buf(),
            rel.to_string(),
            diff.to_string(),
            diff_hash.clone(),
            uncached,
        );
    }

    // When nothing was recorded, the `why` angle ran like any other and its own
    // source is whatever that angle produced.
    let why_source = if why_source.is_empty() {
        angle_source(angles, &sources, ExplainAngle::Why)
    } else {
        why_source
    };

    ChangeExplanation {
        before,
        what,
        why,
        why_source,
        why_author,
        why_stated_at,
        source: roll_up(&sources),
        diff_hash,
    }
}

/// The provenance recorded for one angle. `sources` is filled in `angles` order
/// after any recorded-reason entry, so the offset accounts for that entry.
fn angle_source(angles: &[ExplainAngle], sources: &[&str], want: ExplainAngle) -> String {
    let offset = sources.len().saturating_sub(angles.len());
    angles
        .iter()
        .position(|a| a.tag() == want.tag())
        .and_then(|i| sources.get(i + offset))
        .map(|s| (*s).to_string())
        .unwrap_or_else(|| "none".into())
}

/// Off-request-path model computation: for each angle with no cached model line,
/// ask the user's backend and cache real output. Never touches the response the
/// user is waiting on — the deterministic line already shipped instantly; this
/// only refines the NEXT open of this exact change.
fn spawn_model_backfill(
    cwd: PathBuf,
    rel: String,
    diff: String,
    diff_hash: String,
    angles: Vec<ExplainAngle>,
) {
    tokio::spawn(async move {
        let backend = aurawatch_inference::select_backend_preferred(None).await;
        if matches!(backend, InferenceBackend::Generic) {
            return;
        }
        for angle in angles {
            // Another view may have cached it since this task was queued.
            if cache_lookup(&cwd, &rel, &diff_hash, angle.tag())
                .await
                .is_some()
            {
                continue;
            }
            let (text, src) = generate_angle(&backend, &rel, &diff, angle).await;
            if src == "model" {
                let _ = cache_store(
                    &cwd,
                    &CacheRecord {
                        path: rel.clone(),
                        diff_hash: diff_hash.clone(),
                        task: angle.tag().into(),
                        summary: text,
                        source: src,
                        ts: now_secs(),
                    },
                )
                .await;
            }
        }
    });
}

fn empty_explanation() -> ChangeExplanation {
    ChangeExplanation {
        before: String::new(),
        what: String::new(),
        why: String::new(),
        why_source: "none".into(),
        why_author: String::new(),
        why_stated_at: 0,
        source: "none".into(),
        diff_hash: String::new(),
    }
}

fn assign(
    before: &mut String,
    what: &mut String,
    why: &mut String,
    angle: ExplainAngle,
    text: String,
) {
    match angle {
        ExplainAngle::Before => *before = text,
        ExplainAngle::What => *what = text,
        ExplainAngle::Why => *why = text,
    }
}

/// One provenance label for the whole explanation: the shared source when every
/// angle agrees, else `"mixed"`.
fn roll_up(sources: &[&str]) -> String {
    match sources.first() {
        None => "none".into(),
        Some(first) if sources.iter().all(|s| s == first) => (*first).into(),
        _ => "mixed".into(),
    }
}

/// Ask the (already-selected) backend for one plain-language angle. Falls back
/// to a deterministic line on a sentinel backend, empty reply, or error.
async fn generate_angle(
    backend: &InferenceBackend,
    rel: &str,
    diff: &str,
    angle: ExplainAngle,
) -> (String, String) {
    if matches!(backend, InferenceBackend::Generic) {
        return (deterministic_angle(diff, angle), "fallback".into());
    }
    let ctx = InferContext {
        files: vec![rel.to_string()],
        diff_excerpt: diff.chars().take(4000).collect(),
        assistant_tail: String::new(),
        task: angle.task(),
    };
    match aurawatch_inference::infer(backend, &ctx).await {
        Ok(s) => {
            let cleaned = sanitize(&s);
            if cleaned.is_empty() {
                (deterministic_angle(diff, angle), "fallback".into())
            } else {
                (cleaned, "model".into())
            }
        }
        Err(_) => (deterministic_angle(diff, angle), "fallback".into()),
    }
}

/// Deterministic, jargon-free fallback per angle — used only when no model is
/// reachable. Honest and human-readable; never a symbol name or stub.
fn deterministic_angle(diff: &str, angle: ExplainAngle) -> String {
    let (_adds, dels) = count_changes(diff);
    match angle {
        ExplainAngle::Before => {
            if dels == 0 {
                String::new()
            } else {
                // Describe what the OLD (removed) lines actually did, named from
                // their own content — the values they set, the calls they made,
                // the pieces they defined. Empty when nothing is nameable, so the
                // header simply omits the "used to" line rather than show filler.
                describe_side(diff, false)
            }
        }
        ExplainAngle::What => deterministic_what(diff),
        // No deterministic "why". Guessing intent from line counts only produces
        // filler ("added to give it something it didn't do before") that would
        // wrongly override the real recorded commit reason the header already
        // has. Empty here → the header falls back to that real reason instead.
        ExplainAngle::Why => String::new(),
    }
}

/// The patch a single commit applied to one file. `git show` prints the
/// commit's diff; `--format=` drops the commit header so only the hunk remains.
async fn commit_file_diff(repo_root: &str, sha: &str, rel: &str) -> String {
    // A pull request has no single commit to show — it is a range. `git show`
    // rejects one, so a spec containing `..` goes to `git diff` instead, which
    // reads both of git's range spellings natively (`a..b` compares the two
    // tips; `a...b` compares from where they diverged, which is what a pull
    // request proposes).
    let out = if sha.contains("..") {
        Command::new("git")
            .args(["diff", "--no-color", "--unified=3", sha, "--", rel])
            .current_dir(repo_root)
            .output()
            .await
    } else {
        Command::new("git")
            .args(["show", "--no-color", "--unified=3", "--format=", sha, "--", rel])
            .current_dir(repo_root)
            .output()
            .await
    };
    if let Ok(out) = out {
        if out.status.success() {
            return String::from_utf8_lossy(&out.stdout).into_owned();
        }
    }
    String::new()
}

/// Deterministic, jargon-free "what changed now" line — the NEW (added) content
/// described by what it actually introduces (the values it sets and what from,
/// the pieces it defines, the calls it makes, the schema it touches), never a
/// line count. Falls back to a modest, non-numeric generic only when nothing at
/// all is nameable (pure whitespace / formatting / opaque config).
fn deterministic_what(diff: &str) -> String {
    let described = describe_side(diff, true);
    if !described.is_empty() {
        return described;
    }
    "Updates how this part of the project works.".into()
}

/// A short, plain-language sentence describing one side of a diff — the NEW
/// (`added`) content or the OLD (removed) content — named from what the code
/// actually contains. Returns "" when nothing nameable is present, so the caller
/// can omit the line rather than show filler. Never a line count, never a raw
/// symbol dump: the real names appear in single quotes as honest anchors to the
/// code shown below the header.
fn describe_side(diff: &str, added: bool) -> String {
    compose_facts(&mine_side(diff, added), added)
}

/// The nameable things one side of a diff introduces or removes.
#[derive(Default)]
struct SideFacts {
    /// (plain kind word, name) for each definition — `function`, `class`, …
    defs: Vec<(String, String)>,
    /// (name, the call it's assigned from, if any) for each assignment.
    assigns: Vec<(String, Option<String>)>,
    /// Callees of bare calls (lines that are neither a definition nor an assignment).
    calls: Vec<String>,
    /// Human phrases for SQL schema touches (`a 'users' table`).
    schema: Vec<String>,
}

/// Scan one side of a unified diff (the `+` or `-` lines) and pull out the
/// nameable facts, most-specific first. Comment/whitespace lines contribute
/// nothing. Each category is de-duplicated and capped so the composed sentence
/// stays short.
fn mine_side(diff: &str, added: bool) -> SideFacts {
    let sign = if added { '+' } else { '-' };
    let mut f = SideFacts::default();
    for raw in diff.lines() {
        if raw.starts_with("+++") || raw.starts_with("---") {
            continue;
        }
        let rest = match raw.strip_prefix(sign) {
            Some(r) => r.trim(),
            None => continue,
        };
        if rest.is_empty()
            || rest.starts_with("//")
            || rest.starts_with('*')
            || rest.starts_with("/*")
            || rest.starts_with('#')
        {
            continue;
        }
        if let Some(c) = def_re().captures(rest) {
            f.defs.push((plain_def_kw(&c["kw"]), c["name"].to_string()));
            continue;
        }
        if let Some(c) = assign_re().captures(rest) {
            f.assigns.push((c["name"].to_string(), first_call(&c["rhs"])));
            continue;
        }
        if let Some(c) = sql_table_re().captures(rest) {
            f.schema.push(format!("a '{}' table", &c["t"]));
            continue;
        }
        if let Some(c) = sql_col_re().captures(rest) {
            f.schema.push(format!("a '{}' column", &c["c"]));
            continue;
        }
        if let Some(callee) = first_call(rest) {
            f.calls.push(callee);
        }
    }
    dedup_by(&mut f.defs, |(_, name)| name.clone(), 4);
    dedup_by(&mut f.assigns, |(name, _)| name.clone(), 3);
    dedup_by(&mut f.calls, |c| c.clone(), 3);
    dedup_by(&mut f.schema, |s| s.clone(), 3);
    f
}

/// Retain first occurrence per key, then cap length.
fn dedup_by<T, K: std::hash::Hash + Eq>(v: &mut Vec<T>, key: impl Fn(&T) -> K, cap: usize) {
    let mut seen = std::collections::HashSet::new();
    v.retain(|item| seen.insert(key(item)));
    v.truncate(cap);
}

/// Turn mined facts into one tight sentence. Picks the single most-specific
/// category present (definitions → assignments → schema → calls) so the line
/// stays readable instead of listing everything. `added` flips the verb tense
/// and the "Now" / "Previously" lead.
fn compose_facts(f: &SideFacts, added: bool) -> String {
    let lead = if added { "Now" } else { "Previously" };
    let clause = if !f.defs.is_empty() {
        let verb = if added { "adds" } else { "defined" };
        format!("{verb} {}", list_defs(&f.defs))
    } else if !f.assigns.is_empty() {
        let verb = if added { "sets" } else { "set" };
        let parts: Vec<String> = f
            .assigns
            .iter()
            .map(|(n, callee)| match callee {
                Some(c) => format!("'{n}' from '{c}'"),
                None => format!("'{n}'"),
            })
            .collect();
        format!("{verb} {}", join_and(&parts))
    } else if !f.schema.is_empty() {
        let verb = if added { "adds" } else { "removed" };
        format!("{verb} {}", join_and(&f.schema))
    } else if !f.calls.is_empty() {
        let verb = if added { "calls" } else { "called" };
        let parts: Vec<String> = f.calls.iter().map(|c| format!("'{c}'")).collect();
        format!("{verb} {}", join_and(&parts))
    } else {
        return String::new();
    };
    let sentence = format!("{lead} {clause}.");
    sentence.chars().take(160).collect()
}

/// "a function 'deliver'" / "2 functions 'deliver' and 'senderFor'", grouped by
/// kind in first-seen order.
fn list_defs(defs: &[(String, String)]) -> String {
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for (kind, name) in defs {
        let quoted = format!("'{name}'");
        if let Some(g) = groups.iter_mut().find(|(k, _)| k == kind) {
            g.1.push(quoted);
        } else {
            groups.push((kind.clone(), vec![quoted]));
        }
    }
    let phrases: Vec<String> = groups
        .iter()
        .map(|(kind, names)| {
            let noun = if names.len() == 1 {
                format!("a {kind}")
            } else {
                format!("{} {}", names.len(), plural_kind(kind, names.len()))
            };
            format!("{noun} {}", join_and(names))
        })
        .collect();
    join_and(&phrases)
}

/// Plain noun for a definition keyword.
fn plain_def_kw(kw: &str) -> String {
    match kw {
        "function" | "fn" | "def" => "function",
        "class" => "class",
        "struct" => "structure",
        "enum" => "set of choices",
        "trait" => "trait",
        "interface" => "interface",
        "type" => "type",
        _ => "piece",
    }
    .to_string()
}

/// Small-set pluralizer for the kind nouns above.
fn plural_kind(kind: &str, n: usize) -> String {
    if n == 1 {
        return kind.to_string();
    }
    if kind.ends_with('s') || kind.ends_with("ch") || kind.ends_with("sh") || kind.ends_with('x') {
        format!("{kind}es")
    } else {
        format!("{kind}s")
    }
}

/// Oxford-comma join: `[a] → "a"`, `[a,b] → "a and b"`, `[a,b,c] → "a, b, and c"`.
fn join_and(parts: &[String]) -> String {
    match parts.len() {
        0 => String::new(),
        1 => parts[0].clone(),
        2 => format!("{} and {}", parts[0], parts[1]),
        _ => {
            let head = parts[..parts.len() - 1].join(", ");
            format!("{head}, and {}", parts[parts.len() - 1])
        }
    }
}

/// First real function call on a line — the callee's last name segment
/// (`this.deps.deliver(` → `deliver`), skipping control-flow keywords so
/// `if (` / `for (` / `return (` never read as a call.
fn first_call(s: &str) -> Option<String> {
    for c in call_re().captures_iter(s) {
        let callee = c.name("callee").map(|m| m.as_str()).unwrap_or("");
        if callee.is_empty() || is_noise_callee(callee) {
            continue;
        }
        return Some(callee.to_string());
    }
    None
}

/// Control-flow / language keywords that look like calls but aren't.
fn is_noise_callee(name: &str) -> bool {
    matches!(
        name,
        "if" | "for"
            | "while"
            | "switch"
            | "catch"
            | "return"
            | "await"
            | "function"
            | "typeof"
            | "super"
            | "throw"
            | "match"
            | "with"
            | "new"
    )
}

fn def_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^(?:pub\s+|export\s+|default\s+|async\s+|public\s+|private\s+|protected\s+|static\s+|abstract\s+|final\s+)*(?P<kw>function|fn|def|class|struct|enum|trait|interface|type)\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)",
        )
        .expect("def_re is a valid regex")
    })
}

fn assign_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^(?:pub\s+|export\s+)?(?:const|let|var|val|final)\s+(?:mut\s+)?(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?P<rhs>.+)$",
        )
        .expect("assign_re is a valid regex")
    })
}

fn call_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?:[A-Za-z_$][A-Za-z0-9_$]*\.)*(?P<callee>[A-Za-z_$][A-Za-z0-9_$]*)\s*\(")
            .expect("call_re is a valid regex")
    })
}

fn sql_table_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)(?:create|alter)\s+table\s+(?:if\s+not\s+exists\s+)?[`"']?(?P<t>[A-Za-z_][A-Za-z0-9_]*)"#)
            .expect("sql_table_re is a valid regex")
    })
}

fn sql_col_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)add\s+column\s+[`"']?(?P<c>[A-Za-z_][A-Za-z0-9_]*)"#)
            .expect("sql_col_re is a valid regex")
    })
}

/// Count added/removed content lines, ignoring the diff's own `+++`/`---`
/// file headers.
fn count_changes(diff: &str) -> (usize, usize) {
    let mut adds = 0usize;
    let mut dels = 0usize;
    for l in diff.lines() {
        if l.starts_with("+++") || l.starts_with("---") {
            continue;
        }
        if l.starts_with('+') {
            adds += 1;
        } else if l.starts_with('-') {
            dels += 1;
        }
    }
    (adds, dels)
}

/// Trim a model's reply down to one clean sentence: first usable non-empty
/// line, stripped of wrapping quotes/backticks, whitespace-collapsed,
/// length-capped.
///
/// "Usable" excludes replies that talk about the *request* instead of the code
/// — refusals, apologies, and asks for more input. A model handed a truncated
/// hunk answers "I don't see a function called \"blockedNow\" in the diff
/// provided… Please provide", and that sentence used to be cached as the
/// piece's plain-language description and shown to the reader verbatim. Every
/// caller treats an empty return as "no model output" and falls back, so
/// dropping the line here is all that's needed.
fn sanitize(s: &str) -> String {
    s.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| {
            let stripped = l.trim_matches(|c| c == '"' || c == '\'' || c == '`').trim();
            stripped.split_whitespace().collect::<Vec<_>>().join(" ")
        })
        .find(|l| !l.is_empty() && !reads_as_meta(l))
        .map(|l| l.chars().take(160).collect())
        .unwrap_or_default()
}

/// Does this sentence describe the *prompt* rather than the code? These
/// surfaces promise a plain description of what a piece of the project does;
/// anything addressing the reader about the diff, the excerpt, or the model's
/// own limits is a failed generation, not a description.
///
/// Matched on phrases rather than bare words on purpose: this is a
/// version-control codebase, so a genuine description may well say "It builds a
/// diff between two versions" — only diff-as-the-thing-I-was-handed is meta.
fn reads_as_meta(line: &str) -> bool {
    let l = line.to_ascii_lowercase();
    // A description never asks the reader a question.
    if l.ends_with('?') {
        return true;
    }
    const META: &[&str] = &[
        // The model talking about itself or refusing.
        "i don't see",
        "i do not see",
        "i can't see",
        "i cannot see",
        "i don't have",
        "i do not have",
        "i can't",
        "i cannot",
        "i'm unable",
        "i am unable",
        "i'm sorry",
        "i am sorry",
        "sorry,",
        "unfortunately,",
        "as an ai",
        "language model",
        // Asking for more input.
        "please provide",
        "please share",
        "please paste",
        "could you provide",
        "can you provide",
        // Talking about the material it was handed.
        "the diff provided",
        "the provided diff",
        "diff provided",
        "the diff you",
        "the diff shows",
        "the diff does not",
        "the diff doesn't",
        "in the diff",
        "from the diff",
        "this diff",
        "the excerpt",
        "the snippet",
        "the code provided",
        "the provided code",
        "you provided",
        // Reporting that the material was inadequate.
        "no function called",
        "no such function",
        "there is no function",
        "there's no function",
        "cannot determine",
        "can't determine",
        "unable to determine",
        "not enough context",
        "insufficient context",
        "insufficient information",
        "cuts off",
        "truncated",
    ];
    META.iter().any(|m| l.contains(m))
}

/// This file's patch vs its last committed state, handling the brand-new
/// untracked file case (invisible to `git diff HEAD`) the same way the review
/// pane does — by synthesizing an add-diff.
async fn single_file_diff(repo_root: &str, rel: &str) -> String {
    if let Ok(out) = Command::new("git")
        .args(["diff", "HEAD", "--no-color", "--unified=3", "--", rel])
        .current_dir(repo_root)
        .output()
        .await
    {
        if out.status.success() {
            let body = String::from_utf8_lossy(&out.stdout);
            if !body.trim().is_empty() {
                return body.into_owned();
            }
        }
    }

    if is_untracked(repo_root, rel).await {
        if let Ok(out) = Command::new("git")
            .args(["diff", "--no-color", "--no-index", "--", "/dev/null", rel])
            .current_dir(repo_root)
            .output()
            .await
        {
            // git uses exit code 1 for "differences found" here (not an error).
            if matches!(out.status.code(), Some(0) | Some(1)) {
                return String::from_utf8_lossy(&out.stdout).into_owned();
            }
        }
    }

    String::new()
}

/// True when `rel` is not tracked by git (so `git diff HEAD` can't see it).
async fn is_untracked(repo_root: &str, rel: &str) -> bool {
    match Command::new("git")
        .args(["ls-files", "--error-unmatch", "--", rel])
        .current_dir(repo_root)
        .output()
        .await
    {
        Ok(o) => !o.status.success(),
        Err(_) => false,
    }
}

fn rel_path(cwd: &Path, path: &str) -> String {
    let p = Path::new(path);
    let rel = p.strip_prefix(cwd).unwrap_or(p);
    rel.to_string_lossy().replace('\\', "/")
}

fn cache_path(cwd: &Path) -> PathBuf {
    cwd.join(".aura").join("change_summaries.jsonl")
}

/// Newest matching record wins — the file is append-only, so a later line for
/// the same (path, diff_hash, task) supersedes earlier ones.
///
/// Deterministic-fallback records are treated as a MISS. A fallback is what we
/// wrote when no model was reachable at that moment (a cold start, a timeout, a
/// transient failure); if we served it back forever the change would be stuck
/// on filler even after the model came back. Skipping it means the next open
/// retries the model and, on success, caches the real words over it.
async fn cache_lookup(
    cwd: &Path,
    rel: &str,
    diff_hash: &str,
    task: &str,
) -> Option<CacheRecord> {
    let bytes = tokio::fs::read(cache_path(cwd)).await.ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let mut hit = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(rec) = serde_json::from_str::<CacheRecord>(line) {
            if rec.path == rel
                && rec.diff_hash == diff_hash
                && rec.task == task
                && rec.source != "fallback"
            {
                hit = Some(rec);
            }
        }
    }
    hit
}

async fn cache_store(cwd: &Path, rec: &CacheRecord) -> std::io::Result<()> {
    let dir = cwd.join(".aura");
    tokio::fs::create_dir_all(&dir).await?;
    let mut line = serde_json::to_string(rec).unwrap_or_default();
    line.push('\n');
    let mut f = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("change_summaries.jsonl"))
        .await?;
    f.write_all(line.as_bytes()).await?;
    Ok(())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The exact case from the screenshot: a one-line addition inside a rewritten
    // method. The "now" line must name what it does — the value it sets and the
    // call it's set from — never a line count.
    #[test]
    fn what_names_the_assignment_and_its_source_call() {
        let diff = "\
--- a/email-dispatcher.service.ts
+++ b/email-dispatcher.service.ts
@@
 const rendered = renderEmailTemplate(templateKey, vars);
+const from = this.senderFor(branding);
 const res = await this.deps.emailPort.deliver({";
        assert_eq!(deterministic_what(diff), "Now sets 'from' from 'senderFor'.");
    }

    // A brand-new function file: the "now" line names the function it adds.
    #[test]
    fn what_names_a_new_function() {
        let diff = "\
--- /dev/null
+++ b/consent-propagation.ts
@@
+export function propagateConsent(user: User): boolean {
+  return user.consented;
+}";
        assert_eq!(
            deterministic_what(diff),
            "Now adds a function 'propagateConsent'.",
        );
    }

    // A SQL migration: name the table it creates, not "+69 lines".
    #[test]
    fn what_names_a_created_table() {
        let diff = "\
--- /dev/null
+++ b/migration.sql
@@
+CREATE TABLE consent_events (
+  id UUID PRIMARY KEY
+);";
        assert_eq!(deterministic_what(diff), "Now adds a 'consent_events' table.");
    }

    // The "before" side describes the OLD lines that were removed, in past tense.
    #[test]
    fn before_describes_the_removed_side() {
        let diff = "\
--- a/email-dispatcher.service.ts
+++ b/email-dispatcher.service.ts
@@
-const from = defaultSender(branding);
+const from = this.senderFor(branding);";
        assert_eq!(
            describe_side(diff, false),
            "Previously set 'from' from 'defaultSender'.",
        );
    }

    // Control-flow keywords must never read as calls.
    #[test]
    fn control_flow_is_not_a_call() {
        assert_eq!(first_call("if (ready) {"), None);
        assert_eq!(first_call("for (const x of xs) {"), None);
        assert_eq!(first_call("return ok;"), None);
        assert_eq!(first_call("this.deps.emailPort.deliver({"), Some("deliver".into()));
    }

    // Nothing nameable (whitespace / formatting) → an honest, non-numeric
    // generic, never "N lines added".
    #[test]
    fn empty_of_signal_falls_back_without_line_counts() {
        let diff = "\
--- a/x.ts
+++ b/x.ts
@@
-
+
+   ";
        let out = deterministic_what(diff);
        assert_eq!(out, "Updates how this part of the project works.");
        assert!(!out.contains("line"));
    }

    // Per-piece node lines are model-written now (no deterministic mining that
    // could leak a variable name onto this reader-facing surface), so they have
    // no unit test here — the empty-until-model contract lives in the frontend,
    // which shows a plain generic placeholder until `now`/`before` arrive.

    // Verbatim from the Changes pane: a truncated hunk made the model answer
    // about the request instead of the code, and the refusal was cached and
    // shown as the piece's description. It must come back empty so the caller
    // falls back.
    #[test]
    fn a_refusal_is_not_a_description() {
        let refusal = "I don't see a function called \"blockedNow\" in the diff \
provided. The excerpt shows a new constant and comment being added, but cuts \
off mid-line. Please provide the full function.";
        assert_eq!(sanitize(refusal), "");
    }

    // Apologies, asks for more input, and questions back at the reader are the
    // same failure wearing different clothes.
    #[test]
    fn meta_replies_are_rejected() {
        for s in [
            "Sorry, I can't determine what this function does.",
            "As an AI language model, I need more context.",
            "Could you provide the rest of the file?",
            "Which of the two functions did you mean?",
            "Unfortunately, the snippet is truncated.",
        ] {
            assert_eq!(sanitize(s), "", "should have rejected: {s}");
        }
    }

    // A real description survives — including one that legitimately says
    // "diff", which this codebase's own pieces do.
    #[test]
    fn a_real_description_survives() {
        assert_eq!(
            sanitize("It blocks retry attempts on old messages to prevent duplicate emails."),
            "It blocks retry attempts on old messages to prevent duplicate emails.",
        );
        assert_eq!(
            sanitize("It builds a diff between two versions of a file."),
            "It builds a diff between two versions of a file.",
        );
    }

    // Models often lead with a throat-clearing line and then answer. Take the
    // answer rather than throwing the whole reply away.
    #[test]
    fn a_usable_line_after_a_meta_one_is_used() {
        let reply = "I don't see the full function, but here is what it does:\n\
It sends emails and retries the ones that fail.";
        assert_eq!(
            sanitize(reply),
            "It sends emails and retries the ones that fail.",
        );
    }

    // The reading these pin: one model call now speaks for a whole file's
    // changed pieces, and the reply has to be split back apart correctly. A
    // line matched to the wrong piece would describe the wrong code to the
    // reader, which is worse than no line at all — so anything unmatched is
    // dropped and retried on its own.

    fn wanted(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn splits_a_clean_batch_reply_into_one_line_per_piece() {
        let reply = "retry: Waits longer between attempts so the service stops refusing us.\n\
                     noop: Does nothing, kept so older callers still work.";
        let got = parse_batch_lines(reply, &wanted(&["retry", "noop"]));
        assert_eq!(
            got.get("retry").map(String::as_str),
            Some("Waits longer between attempts so the service stops refusing us.")
        );
        assert_eq!(
            got.get("noop").map(String::as_str),
            Some("Does nothing, kept so older callers still work.")
        );
    }

    #[test]
    fn strips_the_list_furniture_a_model_adds_anyway() {
        let reply = "- `retry`: Waits longer between attempts.\n\
                     2. **noop**: Does nothing on purpose.";
        let got = parse_batch_lines(reply, &wanted(&["retry", "noop"]));
        assert_eq!(
            got.get("retry").map(String::as_str),
            Some("Waits longer between attempts.")
        );
        assert_eq!(
            got.get("noop").map(String::as_str),
            Some("Does nothing on purpose.")
        );
    }

    #[test]
    fn a_name_nobody_asked_about_is_dropped_not_guessed_at() {
        let reply = "somethingElse: Sends the welcome email.\nretry: Waits longer.";
        let got = parse_batch_lines(reply, &wanted(&["retry"]));
        assert_eq!(got.len(), 1);
        assert_eq!(got.get("retry").map(String::as_str), Some("Waits longer."));
    }

    #[test]
    fn a_piece_the_model_skipped_is_absent_so_it_can_be_retried_alone() {
        let reply = "retry: Waits longer between attempts.";
        let got = parse_batch_lines(reply, &wanted(&["retry", "noop"]));
        assert!(got.contains_key("retry"));
        assert!(!got.contains_key("noop"));
    }

    #[test]
    fn a_qualified_name_still_finds_its_piece() {
        // Asked about `bar`, answered about `Foo::bar` — the same piece.
        let reply = "Foo::bar: Adds up what the order costs.";
        let got = parse_batch_lines(reply, &wanted(&["bar"]));
        assert_eq!(
            got.get("bar").map(String::as_str),
            Some("Adds up what the order costs.")
        );
    }

    #[test]
    fn a_refusal_inside_a_batch_is_dropped_like_any_other() {
        // The same meta-reply guard every single-piece line goes through: a
        // sentence about the prompt is a failed generation, not a description.
        let reply = "retry: I don't see a function called retry in the diff provided.\n\
                     noop: Does nothing on purpose.";
        let got = parse_batch_lines(reply, &wanted(&["retry", "noop"]));
        assert!(!got.contains_key("retry"), "a refusal must not be cached");
        assert!(got.contains_key("noop"));
    }

    #[test]
    fn preamble_and_blank_lines_are_ignored() {
        let reply = "Here are the descriptions:\n\n\
                     retry: Waits longer between attempts.\n\n";
        let got = parse_batch_lines(reply, &wanted(&["retry"]));
        assert_eq!(got.len(), 1);
        assert_eq!(
            got.get("retry").map(String::as_str),
            Some("Waits longer between attempts.")
        );
    }

    #[test]
    fn the_first_answer_for_a_piece_wins() {
        let reply = "retry: Waits longer between attempts.\nretry: Something vaguer.";
        let got = parse_batch_lines(reply, &wanted(&["retry"]));
        assert_eq!(
            got.get("retry").map(String::as_str),
            Some("Waits longer between attempts.")
        );
    }

    #[test]
    fn a_side_tag_is_the_same_key_the_read_path_looks_up() {
        // Batched lines must be indistinguishable from singly-generated ones,
        // which means writing them under the tags `explain_symbols` reads.
        assert_eq!(side_tag("retry", SymSide::Now), symbol_tag("retry"));
        assert_eq!(
            side_tag("retry", SymSide::Before),
            symbol_before_tag("retry")
        );
    }

    #[test]
    fn a_batch_sees_far_more_of_the_diff_than_a_single_piece_does() {
        // A batch answers for every piece in the file, including the ones near
        // the end — so it must not be handed the single-piece excerpt budget.
        let big = "x".repeat(5000);
        let one = InferContext {
            files: vec!["a.rs".into()],
            diff_excerpt: big.clone(),
            assistant_tail: String::new(),
            task: InferTask::Symbol,
        };
        let many = InferContext {
            files: vec!["a.rs".into()],
            diff_excerpt: big,
            assistant_tail: String::new(),
            task: InferTask::SymbolBatch,
        };
        assert!(many.user_prompt().len() > one.user_prompt().len() + 3000);
    }
}
