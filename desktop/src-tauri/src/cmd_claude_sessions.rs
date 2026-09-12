//! Native `/resume` data source for Claude Code stream-mode tabs.
//!
//! Claude Code stores each conversation as a JSONL file under
//! `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. The encoded
//! cwd is the absolute path with `/` replaced by `-` (so
//! `/Users/dev/Documents/New Git/aura-shell/src-tauri` becomes
//! `-Users-dev-Documents-New-Git-aura-shell-src-tauri`).
//!
//! For each file we surface enough metadata for a picker UI:
//!   - session id (the stem)
//!   - mtime (so the list sorts by recency)
//!   - first user prompt (so the row reads like a conversation title)
//!   - approximate turn count (so the user can tell long threads apart)
//!
//! Reading these in full is not cheap — a busy conversation runs to
//! gigabytes — so the scan reads each byte at most once ever: results are
//! remembered in an on-disk index, a file that has grown since the last look
//! is resumed from where the last pass stopped, and lines that cannot carry a
//! prompt are skipped with a byte-level test instead of a JSON parse. The
//! numbers it reports stay exact; only the work to get them shrinks.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use tokio::time::{sleep, Duration};

use crate::cmd_agent_stream::StreamEvent;

/// Live-tail watcher state: one canceller per active session id. The
/// frontend opens the watcher on PTY-tab mount and drops it on close.
fn watchers() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    static W: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

/// How far into each session's transcript we have already read, so a watcher
/// that stops and starts again picks up where the last one left off.
///
/// This has to outlive the watcher task, which is the whole point. The task
/// used to keep its position in a local and open at end-of-file, so every time
/// the user switched tabs and came back, everything the agent had written while
/// the tab was unmounted fell into the gap between the old position and the new
/// end — and nothing ever went back for it. The replay that would have covered
/// it only runs when the frontend's event cache is empty, which it isn't for
/// the first five minutes.
///
/// Keyed by the tab's session id, which survives a remount, and holding the
/// file the count was measured against: a resumed session writes a *new* JSONL,
/// and a byte offset into the old one means nothing there.
///
/// Never evicted. One short entry per session opened in this run of the app,
/// the same lifetime the watcher registry above already assumes.
fn read_offsets() -> &'static Mutex<HashMap<String, (String, u64)>> {
    static O: OnceLock<Mutex<HashMap<String, (String, u64)>>> = OnceLock::new();
    O.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record that `session_id`'s transcript has been read up to `offset` bytes of
/// `file_path`. Both the full replay and the live tail report through here, so
/// there is one answer to "where did we get to" no matter which of them ran.
fn note_read_offset(session_id: &str, file_path: &str, offset: u64) {
    if let Ok(mut map) = read_offsets().lock() {
        map.insert(session_id.to_string(), (file_path.to_string(), offset));
    }
}

/// Where a watcher for `session_id` should start reading `file_path`, given the
/// file is `file_len` bytes right now.
///
/// The mark if there is one for this exact file — that is the fix; a watcher
/// restarting after a remount has to cover the gap rather than skip it. The end
/// of the file otherwise, because no mark means nothing has read this
/// transcript and there is no history to be missing. Clamped either way: a
/// rotated or truncated file is shorter than a mark taken against the old one,
/// and seeking past its end would leave the tab silent until it grew back.
fn resume_offset(session_id: &str, file_path: &str, file_len: u64) -> u64 {
    read_offsets()
        .lock()
        .ok()
        .and_then(|map| match map.get(session_id) {
            Some((path, off)) if path == file_path => Some(*off),
            _ => None,
        })
        .map(|off| off.min(file_len))
        .unwrap_or(file_len)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ClaudeSession {
    pub session_id: String,
    pub mtime: i64,
    /// First user-typed prompt in the session, truncated to ~140 chars.
    /// Empty if we can't find one (e.g. interrupted before the first turn).
    pub first_prompt: String,
    /// Last user-typed prompt — usually more identifying than the first
    /// (sessions often open with "hi"). Truncated to ~140 chars.
    pub last_prompt: String,
    /// Approximate number of user turns in the file.
    pub turn_count: usize,
    /// Number of agent *steps* — assistant messages in the transcript. A
    /// session driven by one typed prompt can still carry dozens of these
    /// (the model reading, editing, running commands turn after turn), so
    /// this is the honest depth signal the header shows instead of letting a
    /// deep run read as "1 turn".
    pub step_count: usize,
    /// Path to the JSONL file — useful for a future "delete session"
    /// affordance.
    pub file_path: String,
    /// Working directory the session was launched from, relative to
    /// the workspace root (e.g. "aura-shell/src-tauri" or "" for the
    /// root itself). Lets the picker show *where* the session ran.
    pub cwd_rel: String,
    /// Absolute directory `claude --resume <session_id>` must be launched
    /// from for the id to resolve — the one authoritative answer, computed
    /// in `scan_session` against the transcript's own on-disk project dir.
    /// Claude keys resume by launch cwd, so a session that ran in a worktree
    /// resumes from *there*; spawning it from the app's workspace root gives
    /// a blank REPL and a `/resume` list that doesn't contain it. Empty when
    /// the transcript recorded no cwd (caller falls back to the workspace
    /// root).
    pub cwd: String,
}

#[tauri::command]
pub async fn claude_list_sessions(repo_root: String) -> Result<Vec<ClaudeSession>, String> {
    // Directory walks, multi-gigabyte reads and a `git worktree list` — all
    // blocking. On a runtime worker this starved every other command while the
    // list built, so the app felt frozen rather than merely slow here.
    tokio::task::spawn_blocking(move || list_sessions_blocking(&repo_root))
        .await
        .map_err(|e| format!("session scan failed: {e}"))?
}

fn list_sessions_blocking(repo_root: &str) -> Result<Vec<ClaudeSession>, String> {
    // Claude keys session storage by the *current working directory* it was
    // launched from, not the workspace root. So a single project ends up
    // scattered across multiple `~/.claude/projects/<encoded-cwd>/` dirs: one
    // per subdir the user happened to be in, AND one per sibling git worktree
    // (an agent driving THIS worktree may have run from the main checkout or
    // another worktree). We surface the union across every worktree root and
    // its descendant cwds, so no transcript goes missing just because it was
    // authored from a sibling checkout.
    let projects_root = projects_root_dir()
        .ok_or_else(|| "could not resolve ~/.claude projects dir".to_string())?;
    if !projects_root.exists() {
        return Ok(vec![]);
    }
    let roots = sibling_worktree_roots(repo_root);
    let recovery = recovery_prefix_for(repo_root);
    let mut out = Vec::new();
    for (dir_path, owning_root) in
        matching_project_dirs(&projects_root, &roots, recovery.as_deref(), repo_root)
    {
        let session_entries = match fs::read_dir(&dir_path) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for entry in session_entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let session_id = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let scan = scan_session_cached(&path, mtime);
            // A session whose recorded cwd no longer exists on disk ran in an
            // archived/pruned worktree. Viewing it still works (the transcript
            // replays straight off `file_path`), but resuming live must spawn
            // from a real directory — so we hand the resume the main checkout
            // instead of the dead worktree path. The label keeps the worktree
            // branch (the friendliest id we still have) so the row reads
            // `feat-foo`, not a `.../p-hash/feat-foo` jumble.
            let orphaned = !scan.cwd.is_empty() && !Path::new(&scan.cwd).is_dir();
            let (cwd, cwd_rel) = if orphaned {
                let branch = scan
                    .cwd
                    .rsplit('/')
                    .find(|s| !s.is_empty())
                    .unwrap_or("")
                    .to_string();
                (repo_root.to_string(), branch)
            } else {
                // Relativize against the worktree the session actually ran in,
                // so a row reads `aura-shell/src-tauri` rather than a
                // cross-worktree `.../New Git` fallback.
                (scan.cwd.clone(), relativize_cwd(&scan.cwd, &owning_root))
            };
            out.push(ClaudeSession {
                session_id,
                mtime,
                first_prompt: scan.first_prompt,
                last_prompt: scan.last_prompt,
                turn_count: scan.turn_count,
                step_count: scan.step_count,
                file_path: path.to_string_lossy().into_owned(),
                cwd_rel,
                cwd,
            });
        }
    }
    // Newest first — `/resume` users almost always want the most recent.
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    // Hand the work we just did to the next app launch.
    persist_scan_index();
    Ok(out)
}

pub(crate) fn projects_root_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".claude");
    p.push("projects");
    Some(p)
}

/// Mirror Claude Code's project-dir encoding: every character that is not
/// ASCII-alphanumeric becomes a single `-`, one for one (NOT run-collapsed,
/// so `/.aura` becomes `--aura`).
///
/// This used to fold only `/` and ` `, and a dot survived verbatim. Every
/// worktree path has a dot in it — Claude's own `<repo>/.claude/worktrees/…`
/// and Aura's managed `~/.aura/worktrees/p-<hash>/…` — so a worktree encoded
/// to a directory name Claude Code never reads or writes. Measured against a
/// live `~/.claude/projects`: 72 of 72 real dirs match the rule below, and the
/// only four that didn't were dirs Aura had created itself with the old table
/// — transcripts written where `claude --resume` will never look.
pub(crate) fn encode_path(repo_root: &str) -> String {
    // A trailing slash is the same directory but a different encoded name, and
    // roots reach us from both git and the frontend. `/` itself has nothing to
    // trim.
    let trimmed = repo_root.trim_end_matches('/');
    let trimmed = if trimmed.is_empty() { repo_root } else { trimmed };
    trimmed
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Every git worktree root that shares this repo's object store — the main
/// checkout plus every linked worktree. Claude keys session storage by the cwd
/// it launched from, and an agent that edited THIS worktree may well have run
/// from a sibling worktree or the main checkout (a common setup: the app opens
/// a feature worktree while the human drives Claude from the main repo). The
/// session JSONL then lives under the *other* root's `~/.claude/projects` dir,
/// so scanning only `repo_root` surfaces zero transcripts. We union every
/// worktree so a session is found wherever it actually ran.
///
/// Always includes `repo_root` itself, even when the git call fails (not a
/// repo, git absent) — degrades cleanly to the old single-root behavior.
/// Short TTL cache for worktree discovery, keyed by repo_root → (built_at,
/// roots). `claude_list_sessions` fires on every Trace/Sessions open and shells
/// out to `git worktree list` each time; worktrees are added/pruned rarely, so a
/// few seconds of staleness is harmless and spares the subprocess on repeat
/// opens. Same pattern as the commit-index TTL cache.
fn worktree_roots_cache() -> &'static Mutex<HashMap<String, (u64, Vec<Checkout>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (u64, Vec<Checkout>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const WORKTREE_ROOTS_TTL_SECS: u64 = 5;

fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// One live checkout of this repo: where it is on disk, and what branch it
/// has out. `branch` is `None` for a detached HEAD.
#[derive(Clone, Debug)]
pub(crate) struct Checkout {
    pub path: String,
    pub branch: Option<String>,
}

impl Checkout {
    /// The short name a person uses for this checkout — the directory's own
    /// name. The main checkout is the repo directory itself.
    pub fn name(&self) -> String {
        self.path
            .rsplit('/')
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .to_string()
    }
}

/// Do two paths name the same directory?
///
/// String equality is not enough: git reports the resolved path, and on macOS
/// anything under `/var` or `/tmp` resolves through a symlink into
/// `/private/...`. A caller passing the unresolved form would otherwise be
/// treated as a *second* checkout — same files, no branch — and its unlabelled
/// rows would win the dedupe against the real entry.
pub(crate) fn same_dir(a: &str, b: &str) -> bool {
    if a.trim_end_matches('/') == b.trim_end_matches('/') {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Every checkout git currently lists for this repo, with its branch, served
/// from the short TTL cache. Deleted worktrees are absent — git is the source
/// of truth, so a pruned checkout stops contributing rows the moment it goes.
pub(crate) fn worktree_checkouts(repo_root: &str) -> Vec<Checkout> {
    let now = now_unix_secs();
    if let Ok(cache) = worktree_roots_cache().lock() {
        if let Some((built_at, roots)) = cache.get(repo_root) {
            if now.saturating_sub(*built_at) < WORKTREE_ROOTS_TTL_SECS {
                return roots.clone();
            }
        }
    }
    let mut roots = vec![Checkout { path: repo_root.to_string(), branch: None }];
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .arg("worktree")
        .arg("list")
        .arg("--porcelain")
        .output();
    if let Ok(output) = output {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            // Porcelain emits a `worktree <path>` line, then that checkout's
            // `HEAD`/`branch`/`detached` lines, then a blank separator. So the
            // branch always belongs to the most recent `worktree` line.
            let mut current: Option<usize> = None;
            for line in text.lines() {
                if let Some(path) = line.strip_prefix("worktree ") {
                    let path = path.trim();
                    if path.is_empty() {
                        continue;
                    }
                    current = match roots.iter().position(|r| same_dir(&r.path, path)) {
                        Some(i) => Some(i),
                        None => {
                            roots.push(Checkout { path: path.to_string(), branch: None });
                            Some(roots.len() - 1)
                        }
                    };
                } else if let Some(rf) = line.strip_prefix("branch ") {
                    if let Some(i) = current {
                        roots[i].branch =
                            Some(rf.trim().trim_start_matches("refs/heads/").to_string());
                    }
                }
            }
        }
    }
    if let Ok(mut cache) = worktree_roots_cache().lock() {
        cache.insert(repo_root.to_string(), (now, roots.clone()));
    }
    roots
}

fn sibling_worktree_roots(repo_root: &str) -> Vec<String> {
    worktree_checkouts(repo_root).into_iter().map(|c| c.path).collect()
}

/// Project dirs under `~/.claude/projects` whose encoded name is one of the
/// candidate `roots` or a descendant of it, each paired with the *most
/// specific* (longest-prefix) owning root so the caller can relativize a
/// session's cwd against the worktree it truly belongs to. Each physical dir
/// is returned at most once.
///
/// `recovery` is the encoded path of this repo's managed-worktree base
/// (`~/.aura/worktrees/<project_id>`). A session dir that matches none of the
/// live `roots` but *is* a descendant of that base belongs to an
/// archived/pruned worktree of THIS repo — its checkout is gone and it has
/// dropped out of `git worktree list`, so the live-roots union can't see it.
/// We recover such orphans paired with `repo_root` as the owning root (the
/// caller relativizes / falls back against the still-valid main checkout). The
/// `project_id` is repo-specific, so this never pulls in another repo's
/// sessions.
fn matching_project_dirs(
    projects_root: &Path,
    roots: &[String],
    recovery: Option<&str>,
    repo_root: &str,
) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(projects_root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    let prefixes: Vec<(String, &String)> =
        roots.iter().map(|r| (encode_path(r), r)).collect();
    for dir_entry in entries.flatten() {
        let dir_path = dir_entry.path();
        if !dir_path.is_dir() {
            continue;
        }
        let dir_name = match dir_path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let mut best: Option<&String> = None;
        let mut best_len = 0usize;
        for (prefix, root) in &prefixes {
            // Match: the workspace root exactly, OR a cwd inside it (encoded
            // form has an extra `-` separator right after the prefix).
            let same = &dir_name == prefix;
            let descendant = dir_name.starts_with(prefix.as_str())
                && dir_name.as_bytes().get(prefix.len()) == Some(&b'-');
            if (same || descendant) && (best.is_none() || prefix.len() > best_len) {
                best = Some(root);
                best_len = prefix.len();
            }
        }
        if let Some(root) = best {
            out.push((dir_path, (*root).clone()));
            continue;
        }
        // No live root matched. Recover it if it's a descendant of this
        // repo's managed-worktree base — an archived/pruned worktree whose
        // transcripts would otherwise be orphaned forever. Owning root is the
        // main checkout (the worktree's own path is gone).
        if let Some(prefix) = recovery {
            let descendant = dir_name.starts_with(prefix)
                && dir_name.as_bytes().get(prefix.len()) == Some(&b'-');
            if descendant {
                out.push((dir_path, repo_root.to_string()));
                continue;
            }
        }
        // Content-based fallback. The encoded dir name didn't prefix-match any
        // candidate root (and isn't a known orphan), but `encode_path` is a
        // lossy heuristic — a workspace whose absolute path contains a char we
        // don't fold the same way Claude does (or a cwd Claude recorded under a
        // slightly different spelling) yields a dir name that never matches even
        // though its transcripts genuinely ran inside this repo. So we peek at a
        // transcript's recorded `cwd` and include the dir when that cwd is one
        // of the candidate roots or sits inside one — this is what surfaces a
        // session launched from the main checkout while the app opened a
        // worktree, even when the name encoding diverged. Owned by the most
        // specific matching root so cwd-relativization still reads cleanly.
        if let Some(cwd) = first_recorded_cwd(&dir_path) {
            if let Some(owner) = owning_root_for_cwd(&cwd, roots) {
                out.push((dir_path, owner));
            }
        }
    }
    out
}

/// Read the `cwd` recorded in the first transcript line we can parse under a
/// project dir. Claude stamps the session's launch directory on most event
/// records; we only need one. Cheap — reads at most the first parseable line of
/// the first `.jsonl` file, stopping the moment a `cwd` is found. `None` when
/// the dir has no transcript or none records a cwd.
fn first_recorded_cwd(dir_path: &Path) -> Option<String> {
    let entries = fs::read_dir(dir_path).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(c) = v.get("cwd").and_then(Value::as_str) {
                if !c.is_empty() {
                    return Some(c.to_string());
                }
            }
        }
    }
    None
}

/// The candidate root that owns a recorded `cwd`: the longest root that the cwd
/// equals or sits inside. `None` when the cwd is outside every candidate root —
/// i.e. it genuinely belongs to a different workspace and must not be pulled in.
fn owning_root_for_cwd(cwd: &str, roots: &[String]) -> Option<String> {
    let mut best: Option<&String> = None;
    let mut best_len = 0usize;
    for root in roots {
        let same = cwd == root.as_str();
        let inside = cwd.starts_with(root.as_str())
            && cwd.as_bytes().get(root.len()) == Some(&b'/');
        if (same || inside) && (best.is_none() || root.len() > best_len) {
            best = Some(root);
            best_len = root.len();
        }
    }
    best.cloned()
}

/// Encoded path of this repo's managed-worktree base, the prefix every one of
/// its worktree session dirs shares — used to recover orphaned (archived /
/// pruned) worktree transcripts. `None` when HOME is unset.
fn recovery_prefix_for(repo_root: &str) -> Option<String> {
    crate::worktree::managed_project_root(repo_root)
        .map(|p| encode_path(&p.to_string_lossy()))
}

/// The session id (jsonl stem) of the most-recently-active Claude session in
/// this repo's project dir(s), by file mtime. Cheap — stats mtimes only, never
/// parses transcripts. Used to stamp a *durable* session↔intent link at
/// log-intent time (e.g. the mutation-guard auto-stub), so the Trace Session
/// detail can show the live transcript without guessing by timestamp.
///
/// Uses the exact same encoding + same-or-descendant dir union as
/// `claude_list_sessions`, so the returned id is guaranteed to appear in that
/// list — the frontend's exact-match correlation can't whiff on it. Returns
/// `None` when no session dir / jsonl exists yet.
pub fn newest_session_id_for_repo(repo_root: &str) -> Option<String> {
    let projects_root = projects_root_dir()?;
    if !projects_root.exists() {
        return None;
    }
    let roots = sibling_worktree_roots(repo_root);
    let recovery = recovery_prefix_for(repo_root);
    let mut best: Option<(i64, String)> = None;
    for (dir_path, _owning_root) in
        matching_project_dirs(&projects_root, &roots, recovery.as_deref(), repo_root)
    {
        let session_entries = match fs::read_dir(&dir_path) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for entry in session_entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let stem = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let mtime = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            if best.as_ref().is_none_or(|(t, _)| mtime > *t) {
                best = Some((mtime, stem));
            }
        }
    }
    best.map(|(_, s)| s)
}

/// Resolve the newest user-typed prompt for a specific Claude Code session
/// (its jsonl stem) under `repo_root`. Reuses the same worktree-aware
/// project-dir matching as [`newest_session_id_for_repo`], then returns that
/// transcript's last user prompt (falling back to its first). `None` when the
/// session file isn't found or carries no readable prompt yet — callers treat
/// that as "no reason available" and keep their own fallback.
///
/// This is the "why" behind an edit an external CLI made: the guard fires while
/// the agent is actively editing, so this session's prompt is the request that
/// produced the change — captured at edit time, no commit required.
/// The prompt that *opened* the newest Claude transcript under `repo_root` —
/// the one sentence that names what the session is about.
///
/// Deliberately the first prompt and not the last: this is used as a session's
/// title, and a title that rewrote itself every time the person typed again
/// would move the row out from under them. `None` when Claude has never run
/// here, or when the session has been opened but not yet typed into.
pub fn opening_prompt_for_repo(repo_root: &str) -> Option<String> {
    let session_id = newest_session_id_for_repo(repo_root)?;
    let projects_root = projects_root_dir()?;
    let roots = sibling_worktree_roots(repo_root);
    let recovery = recovery_prefix_for(repo_root);
    for (dir_path, _owning_root) in
        matching_project_dirs(&projects_root, &roots, recovery.as_deref(), repo_root)
    {
        let candidate = dir_path.join(format!("{session_id}.jsonl"));
        if !candidate.is_file() {
            continue;
        }
        let mtime = fs::metadata(&candidate)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let first = scan_session_cached(&candidate, mtime).first_prompt;
        let first = first.trim();
        return (!first.is_empty()).then(|| first.to_string());
    }
    None
}

pub fn latest_prompt_for_session(repo_root: &str, session_id: &str) -> Option<String> {
    let projects_root = projects_root_dir()?;
    if !projects_root.exists() {
        return None;
    }
    let roots = sibling_worktree_roots(repo_root);
    let recovery = recovery_prefix_for(repo_root);
    for (dir_path, _owning_root) in
        matching_project_dirs(&projects_root, &roots, recovery.as_deref(), repo_root)
    {
        let candidate = dir_path.join(format!("{session_id}.jsonl"));
        if !candidate.is_file() {
            continue;
        }
        let mtime = fs::metadata(&candidate)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let scan = scan_session_cached(&candidate, mtime);
        let prompt = if scan.last_prompt.trim().is_empty() {
            scan.first_prompt
        } else {
            scan.last_prompt
        };
        let prompt = prompt.trim();
        return if prompt.is_empty() {
            None
        } else {
            Some(prompt.to_string())
        };
    }
    None
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct SessionScan {
    first_prompt: String,
    last_prompt: String,
    turn_count: usize,
    step_count: usize,
    cwd: String,
}

/// What we know about one transcript, and how far into it we know it.
///
/// `scanned_to` always sits just past a newline, so a later pass can resume
/// exactly on a record boundary. `head_sig` fingerprints the first few KB: a
/// transcript that was rewritten rather than appended to changes there, and
/// resuming into it would splice two different conversations together.
#[derive(Clone, Serialize, Deserialize)]
struct ScanEntry {
    scanned_to: u64,
    head_sig: u64,
    scan: SessionScan,
}

/// Per-file scan state, keyed by absolute path, loaded from disk on first use.
///
/// Transcripts are append-only and enormous — on this machine 2.7 GB across
/// 148 files, the largest a single 1.6 GB conversation. Re-reading them on
/// every Sessions open is the difference between an instant list and a
/// ten-second one, so we remember three things and re-read as little as
/// possible: the parse result, how far into the file it covers, and a
/// fingerprint proving the file still starts the way it did.
fn session_scan_cache() -> &'static Mutex<HashMap<String, ScanEntry>> {
    static C: OnceLock<Mutex<HashMap<String, ScanEntry>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(load_scan_index()))
}

/// Marks the index as worth writing back. Set on any real scan, cleared by
/// `persist_scan_index`.
fn scan_index_dirty() -> &'static std::sync::atomic::AtomicBool {
    static D: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    &D
}

fn scan_index_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".aura");
    p.push("session-scan-index.json");
    Some(p)
}

/// The index survives app restarts on purpose. Without it, the very first
/// Sessions open after every launch pays the full multi-gigabyte parse again.
fn load_scan_index() -> HashMap<String, ScanEntry> {
    let Some(path) = scan_index_path() else { return HashMap::new() };
    let Ok(bytes) = fs::read(&path) else { return HashMap::new() };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// Write the index back, dropping entries whose transcript is gone. Called
/// once per list, and only when something actually changed.
fn persist_scan_index() {
    use std::sync::atomic::Ordering;
    if !scan_index_dirty().swap(false, Ordering::Relaxed) {
        return;
    }
    let Some(path) = scan_index_path() else { return };
    let snapshot: HashMap<String, ScanEntry> = match session_scan_cache().lock() {
        Ok(mut c) => {
            c.retain(|k, _| Path::new(k).exists());
            c.clone()
        }
        Err(_) => return,
    };
    let Ok(bytes) = serde_json::to_vec(&snapshot) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    // Write-then-rename: a half-written index that failed to parse would
    // silently cost every user a full rescan, and the failure would look like
    // "the app is slow again" rather than a corrupt file.
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, &bytes).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

/// FNV-1a over the first 4 KB. Cheap, and enough to notice that a transcript
/// was replaced rather than appended to.
fn head_signature(path: &Path) -> u64 {
    let mut buf = [0u8; 4096];
    let n = fs::File::open(path)
        .and_then(|mut f| f.read(&mut buf))
        .unwrap_or(0);
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in &buf[..n] {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

/// The parse, reading as little of the file as it can get away with.
///
/// Three cases: nothing changed (return the remembered result), the file grew
/// (parse only the new bytes and fold them into the remembered result), or the
/// file is new or was rewritten (parse it all). The middle case is the one
/// that matters day to day — the transcript of the session you are *in* grows
/// continuously, and it is usually the biggest file in the set.
fn scan_session_cached(path: &Path, _mtime: i64) -> SessionScan {
    let key = path.to_string_lossy().into_owned();
    let len = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let prior = session_scan_cache()
        .lock()
        .ok()
        .and_then(|c| c.get(&key).cloned());

    if let Some(e) = prior {
        // Only trust a resume if the file still begins the same way. Length
        // alone would let an in-place rewrite masquerade as an append.
        if e.head_sig == head_signature(path) {
            if e.scanned_to == len {
                return e.scan;
            }
            if len > e.scanned_to {
                let (scan, to) = scan_session_from(path, e.scanned_to, e.scan);
                remember(key, ScanEntry { scanned_to: to, head_sig: e.head_sig, scan: scan.clone() });
                return scan;
            }
        }
    }
    let sig = head_signature(path);
    let (scan, to) = scan_session_from(path, 0, SessionScan::default());
    remember(key, ScanEntry { scanned_to: to, head_sig: sig, scan: scan.clone() });
    scan
}

fn remember(key: String, entry: ScanEntry) {
    if let Ok(mut c) = session_scan_cache().lock() {
        c.insert(key, entry);
    }
    scan_index_dirty().store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Cheap raw-bytes substring test.
///
/// Deliberately not a JSON parse. Building a `serde_json::Value` for every
/// line of a multi-gigabyte transcript is an order of magnitude more
/// expensive than looking for the one marker that makes a line worth
/// parsing at all, and the overwhelming majority of lines — assistant
/// messages, tool results — are not.
fn contains_sub(hay: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || hay.len() < needle.len() {
        return false;
    }
    let first = needle[0];
    let last_start = hay.len() - needle.len();
    let mut i = 0usize;
    while i <= last_start {
        match hay[i..=last_start].iter().position(|&b| b == first) {
            Some(off) => {
                let at = i + off;
                if &hay[at..at + needle.len()] == needle {
                    return true;
                }
                i = at + 1;
            }
            None => return false,
        }
    }
    false
}

/// Read the transcript from `start`, folding what it finds into `out`:
/// (1) first user-typed prompt, (2) last user-typed prompt — usually more
/// identifying, since openings are often "hi" — (3) turn count, (4) cwd.
///
/// Returns how far it got, which is always just past a newline. A trailing
/// partial line means the writer is mid-append; we stop before it so the next
/// pass re-reads that record whole rather than parsing half a JSON object.
///
/// Every field is exact — `turn_count` in particular is shown as a number in
/// the UI, so an estimate would be a lie. What makes this affordable is
/// reading each byte at most once across the life of the file, not reading
/// fewer of them.
fn scan_session_from(path: &Path, start: u64, mut out: SessionScan) -> (SessionScan, u64) {
    // The directory this transcript physically lives in is the ONE thing
    // `claude --resume <id>` resolves against, so it is what decides the
    // launch cwd below — not the `cwd` field, which can disagree.
    let project_dir = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    // Seeded from what an earlier incremental pass already settled on, so
    // resuming a scan mid-file does not re-open a question this transcript
    // has already answered.
    let mut cwd_matches_dir = !out.cwd.is_empty() && encode_path(&out.cwd) == project_dir;
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (out, start),
    };
    if start > 0 && file.seek(SeekFrom::Start(start)).is_err() {
        return (out, start);
    }
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut raw: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut pos = start;
    loop {
        raw.clear();
        let n = match reader.read_until(b'\n', &mut raw) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        if raw.last() != Some(&b'\n') {
            break; // partial trailing line — leave it for the next pass
        }
        pos += n as u64;
        // `cwd` and the opening prompt both live in the first records, so
        // these two conditions stop being true almost immediately and the
        // rest of the file only pays the substring test.
        let need_head = out.cwd.is_empty() || out.first_prompt.is_empty();
        if !need_head && !contains_sub(&raw, b"queue-operation") {
            continue;
        }
        let line = match std::str::from_utf8(&raw[..n - 1]) {
            Ok(l) => l,
            Err(_) => continue,
        };
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // A session that moves — Claude's own EnterWorktree does exactly this —
        // gets its transcript re-keyed under the new directory, while the `cwd`
        // stamped on the records it already wrote still names the old one. So
        // the first recorded cwd is only a starting guess; the answer is the
        // recorded cwd that actually encodes to the dir the file is sitting in,
        // because that is the only cwd from which Claude can find it again.
        if !cwd_matches_dir {
            if let Some(c) = v.get("cwd").and_then(Value::as_str) {
                if !c.is_empty() {
                    if out.cwd.is_empty() {
                        out.cwd = c.to_string();
                    }
                    if encode_path(c) == project_dir {
                        out.cwd = c.to_string();
                        cwd_matches_dir = true;
                    }
                }
            }
        }
        // Two carriers in the on-disk format:
        //   - {"type":"queue-operation", "operation":"enqueue", "content":"…"}
        //     → typed user prompts (the queue is what gets sent to claude)
        //   - {"type":"user", "message":{"content":[{"type":"text","text":"…"}]}}
        //     → wrapped user turns the model saw
        // The queue-operation form gives a cleaner preview (no tool-
        // result wrapping noise), so prefer it. We only count turns on
        // queue-operation to avoid double-counting the same prompt.
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        // Agent steps: every assistant message is one step the model took
        // (a thought, an edit, a command). Counting these is what lets a
        // one-prompt session honestly read "21 steps" instead of "1 turn".
        if kind == "assistant" {
            out.step_count += 1;
        }
        if kind == "queue-operation"
            && v.get("operation").and_then(Value::as_str) == Some("enqueue")
        {
            if let Some(c) = v.get("content").and_then(Value::as_str) {
                // Skip synthetic enqueues (e.g. <task-notification> reentry
                // payloads, system-reminder injects). They aren't user
                // intent and leak as raw XML in the recent-list preview.
                if is_synthetic_prompt(c) {
                    continue;
                }
                let trimmed = truncate(c.trim(), 140);
                if !trimmed.is_empty() {
                    out.turn_count += 1;
                    if out.first_prompt.is_empty() {
                        out.first_prompt = trimmed.clone();
                    }
                    out.last_prompt = trimmed;
                }
            }
        } else if kind == "user" && out.first_prompt.is_empty() {
            // Fallback only — sessions where queue-operation events
            // got truncated. Don't bump turn_count here to avoid
            // double-counting.
            let txt = extract_user_text(&v);
            if !txt.is_empty() && !is_synthetic_prompt(&txt) {
                out.first_prompt = txt.clone();
                out.last_prompt = txt;
            }
        }
    }
    (out, pos)
}

/// Compute a friendly relative cwd label like `aura-shell/src-tauri`.
/// Falls back to the encoded dir-name suffix when the JSONL didn't
/// record a real `cwd`. Empty string means the session ran at the
/// workspace root.
fn relativize_cwd(cwd: &str, repo_root: &str) -> String {
    if cwd.is_empty() {
        return String::new();
    }
    if let Some(rest) = cwd.strip_prefix(repo_root) {
        return rest.trim_start_matches('/').to_string();
    }
    // Cwd lives outside the workspace (e.g. a worktree). Show the last
    // two path segments so it's still readable.
    let parts: Vec<&str> = cwd.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() <= 2 {
        return cwd.to_string();
    }
    format!(".../{}/{}", parts[parts.len() - 2], parts[parts.len() - 1])
}

fn extract_user_text(v: &Value) -> String {
    let content = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array);
    if let Some(arr) = content {
        for b in arr {
            if b.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(t) = b.get("text").and_then(Value::as_str) {
                    return truncate(t.trim(), 140);
                }
            }
        }
    }
    String::new()
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let mut out: String = s.chars().take(n - 1).collect();
    out.push('…');
    out
}

/// Read a Claude Code JSONL transcript and reduce it to the same
/// `StreamEvent` shape the live wire emits. Lets the bubble view replay
/// a resumed conversation in-pane without re-running the agent.
///
/// We collapse every record we don't care about (file-history snapshots,
/// hook attachments, system markers, queue-operation duplicates of the
/// same prompt). What lands in the output:
///   - `type: "user"` with string content   → UserPrompt
///   - `type: "user"` with tool_result blocks → ToolResult
///   - `type: "assistant"` text blocks      → AssistantText
///   - `type: "assistant"` tool_use blocks  → ToolUse
///
/// `limit` truncates from the front so we always keep the most recent
/// `limit` events — sessions with thousands of turns would otherwise
/// blow the renderer up. 0 means "unbounded".
/// `session_id` is optional and only used to record how far this read got, so
/// the live tail that follows starts exactly where the replay stopped instead
/// of re-stating the file (which loses anything appended in between) — see
/// `read_offsets`. Callers that are only previewing a transcript, rather than
/// about to watch it, leave it out.
#[tauri::command]
pub async fn claude_load_session(
    file_path: String,
    limit: usize,
    session_id: Option<String>,
) -> Result<Vec<StreamEvent>, String> {
    let file = fs::File::open(&file_path).map_err(|e| format!("open {file_path}: {e}"))?;
    let mut reader = BufReader::new(file);
    let mut events: Vec<StreamEvent> = Vec::new();
    let mut turn_seq: u64 = 0;
    let mut current_turn = String::from("hist-0");
    // Counted rather than stat'd. The file is being appended to while we read,
    // so its length afterwards is not what we consumed — and a byte we credit
    // ourselves with but never parsed is a line nobody ever sees. Only whole
    // lines count: a trailing fragment is parsed best-effort (it won't be valid
    // JSON, so it yields nothing) and left for the tail to read again complete.
    let mut consumed: u64 = 0;
    let mut raw: Vec<u8> = Vec::new();
    loop {
        raw.clear();
        let n = match reader.read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let whole = raw.last() == Some(&b'\n');
        if whole {
            consumed += n as u64;
        }
        let line = String::from_utf8_lossy(&raw);
        parse_jsonl_line(
            line.trim_end_matches(['\n', '\r']),
            "hist",
            &mut turn_seq,
            &mut current_turn,
            &mut events,
        );
        if !whole {
            break;
        }
    }
    if let Some(sid) = session_id.as_deref() {
        note_read_offset(sid, &file_path, consumed);
    }
    if limit > 0 && events.len() > limit {
        let drop = events.len() - limit;
        events.drain(0..drop);
    }
    Ok(events)
}

/// Apply one JSONL line to the running parser state. Used by both the
/// initial replay (`claude_load_session`) and the live-tail watcher.
/// `prefix` distinguishes turn-id namespaces ("hist" for replay, "live"
/// for tail-after-mount) so the frontend can tell them apart if it
/// wants — the renderer treats them uniformly.
fn parse_jsonl_line(
    line: &str,
    prefix: &str,
    turn_seq: &mut u64,
    current_turn: &mut String,
    events: &mut Vec<StreamEvent>,
) {
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    // Each Claude JSONL record stamps an ISO-8601 `timestamp`. Parse it to
    // epoch millis so the transcript can show a real per-prompt age ("5d
    // ago") instead of fabricating one. Absent/unparseable → 0 (the UI then
    // omits the time rather than guessing).
    let ts = v
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0);
    match kind {
        "user" => {
            if v.get("isMeta").and_then(Value::as_bool) == Some(true) {
                return;
            }
            if let Some(origin_kind) = v
                .get("origin")
                .and_then(|o| o.get("kind"))
                .and_then(Value::as_str)
            {
                if matches!(
                    origin_kind,
                    "task-notification"
                        | "slash-command"
                        | "hook"
                        | "system-reminder"
                        | "queue-operation"
                ) {
                    return;
                }
            }
            let content = v.get("message").and_then(|m| m.get("content"));
            if let Some(text) = content.and_then(Value::as_str) {
                let trimmed = text.trim();
                if trimmed.is_empty() || is_synthetic_prompt(trimmed) {
                    return;
                }
                *turn_seq += 1;
                *current_turn = format!("{prefix}-{}", *turn_seq);
                events.push(StreamEvent::UserPrompt {
                    text: trimmed.to_string(),
                    turn_id: current_turn.clone(),
                    ts,
                });
            } else if let Some(arr) = content.and_then(Value::as_array) {
                for b in arr {
                    let bt = b.get("type").and_then(Value::as_str).unwrap_or("");
                    if bt == "text" {
                        if let Some(t) = b.get("text").and_then(Value::as_str) {
                            let trimmed = t.trim();
                            if trimmed.is_empty() || is_synthetic_prompt(trimmed) {
                                continue;
                            }
                            *turn_seq += 1;
                            *current_turn = format!("{prefix}-{}", *turn_seq);
                            events.push(StreamEvent::UserPrompt {
                                text: trimmed.to_string(),
                                turn_id: current_turn.clone(),
                                ts,
                            });
                        }
                    } else if bt == "tool_result" {
                        let id = b
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let body = b
                            .get("content")
                            .map(content_to_text)
                            .unwrap_or_default();
                        let is_error = b
                            .get("is_error")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        events.push(StreamEvent::ToolResult {
                            tool_use_id: id,
                            content: body,
                            is_error,
                            turn_id: current_turn.clone(),
                        });
                    }
                }
            }
        }
        "assistant" => {
            let arr = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array);
            if let Some(arr) = arr {
                for b in arr {
                    let bt = b.get("type").and_then(Value::as_str).unwrap_or("");
                    if bt == "text" {
                        if let Some(t) = b.get("text").and_then(Value::as_str) {
                            let trimmed = t.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            events.push(StreamEvent::AssistantText {
                                text: trimmed.to_string(),
                                turn_id: current_turn.clone(),
                            });
                        }
                    } else if bt == "tool_use" {
                        let id = b
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let name = b
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let input = b.get("input").cloned().unwrap_or(Value::Null);
                        events.push(StreamEvent::ToolUse {
                            id,
                            name,
                            input,
                            turn_id: current_turn.clone(),
                        });
                    }
                }
            }
        }
        _ => {}
    }
}

/// Live-tail the JSONL while a PTY-mode chat is active. The frontend
/// calls this on PtySurface mount; the spawned task polls the file
/// every 500ms, parses any newly-appended lines into `StreamEvent`s,
/// and emits them on the `claude-session:<session_id>` Tauri channel
/// so AgentStreamView updates as the agent answers, mirroring what the
/// raw terminal view shows. `claude_session_unwatch` cancels.
#[tauri::command]
pub async fn claude_session_watch(
    app: AppHandle,
    session_id: String,
    file_path: String,
) -> Result<(), String> {
    let file_len = match fs::metadata(&file_path) {
        Ok(m) => m.len(),
        Err(e) => return Err(format!("stat {file_path}: {e}")),
    };
    // Resume from wherever this session was last read to — by an earlier
    // watcher on this same tab, or by the replay that just ran.
    let mut start_offset = resume_offset(&session_id, &file_path, file_len);

    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    {
        let mut map = watchers().lock().unwrap();
        // Replacing an existing watcher: drop the old canceller. Sender
        // dropped without send → receiver gets RecvError on next poll.
        map.insert(session_id.clone(), cancel_tx);
    }

    let event_name = format!("claude-session:{session_id}");
    let session_id_for_task = session_id.clone();
    let file_path_for_task = file_path.clone();

    tokio::spawn(async move {
        let mut turn_seq: u64 = 100_000; // distinct namespace from `hist-`
        let mut current_turn = format!("live-{turn_seq}");
        let mut carry = String::new();

        loop {
            // Cancel check first — exit on close before doing any I/O.
            match cancel_rx.try_recv() {
                Err(oneshot::error::TryRecvError::Empty) => {}
                _ => break,
            }

            sleep(Duration::from_millis(500)).await;

            let len = match fs::metadata(&file_path_for_task) {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if len <= start_offset {
                if len < start_offset {
                    // File rotated/truncated. Reset to its current end —
                    // we don't try to replay backwards. The mark moves with it,
                    // so a watcher started after this one doesn't inherit a
                    // position measured against the file that used to be here.
                    start_offset = len;
                    carry.clear();
                    note_read_offset(&session_id_for_task, &file_path_for_task, len);
                }
                continue;
            }

            let mut file = match fs::File::open(&file_path_for_task) {
                Ok(f) => f,
                Err(_) => continue,
            };
            if file.seek(SeekFrom::Start(start_offset)).is_err() {
                continue;
            }
            let mut buf = String::new();
            if file.read_to_string(&mut buf).is_err() {
                continue;
            }
            start_offset = len;

            // Lines may straddle reads — keep partial trailer for next round.
            let combined = format!("{carry}{buf}");
            carry.clear();
            let mut iter = combined.split('\n').peekable();
            let mut events: Vec<StreamEvent> = Vec::new();
            while let Some(line) = iter.next() {
                if iter.peek().is_none() {
                    // Trailer (no newline yet) — defer until more bytes land.
                    carry.push_str(line);
                    break;
                }
                if line.trim().is_empty() {
                    continue;
                }
                parse_jsonl_line(
                    line,
                    "live",
                    &mut turn_seq,
                    &mut current_turn,
                    &mut events,
                );
            }

            // Publish the position a future watcher should resume from, before
            // emitting: everything up to here is accounted for, and the bytes
            // held in `carry` are half a line this task has not delivered, so
            // they are deliberately left outside the mark for the next reader
            // to pick up whole.
            note_read_offset(
                &session_id_for_task,
                &file_path_for_task,
                start_offset.saturating_sub(carry.len() as u64),
            );

            for ev in &events {
                let _ = app.emit(&event_name, ev);
            }
            // Mirror chat content into aura-cloud so cloud-paired mobile
            // / dashboard see Claude conversations the same way the LAN
            // web app already does. UserPrompt + AssistantText cover the
            // bubble feed; tool plumbing stays local.
            for ev in events {
                match ev {
                    crate::cmd_agent_stream::StreamEvent::UserPrompt { text, .. } => {
                        if !is_synthetic_prompt(&text) {
                            crate::cloud_session_sync::spawn_push_message(
                                session_id_for_task.clone(),
                                "user",
                                text,
                            );
                        }
                    }
                    crate::cmd_agent_stream::StreamEvent::AssistantText { text, .. } => {
                        crate::cloud_session_sync::spawn_push_message(
                            session_id_for_task.clone(),
                            "assistant",
                            text,
                        );
                    }
                    _ => {}
                }
            }
        }

        // Self-deregister on exit so a future watcher can take this id.
        let mut map = watchers().lock().unwrap();
        map.remove(&session_id_for_task);
    });

    Ok(())
}

#[tauri::command]
pub async fn claude_session_unwatch(session_id: String) -> Result<(), String> {
    let mut map = watchers().lock().unwrap();
    if let Some(tx) = map.remove(&session_id) {
        let _ = tx.send(());
    }
    Ok(())
}

/// True for Claude Code internal-plumbing wrappers that arrive as
/// `user`-role messages but were never typed by the human. Detected by
/// a leading XML tag from a known synthetic-content set. Image-only
/// attachment placeholders (`[Image: source: ...]`) also count as
/// synthetic — the bubble feed has nothing useful to show for them.
fn is_synthetic_prompt(text: &str) -> bool {
    const SYNTHETIC_TAGS: &[&str] = &[
        "<task-notification>",
        "<system-reminder>",
        "<command-name>",
        "<command-message>",
        "<command-args>",
        "<local-command-stdout>",
        "<local-command-stderr>",
        "<local-command-caveat>",
        "<bash-input>",
        "<bash-stdout>",
        "<bash-stderr>",
        "<user-prompt-submit-hook>",
    ];
    let head = text.trim_start();
    if SYNTHETIC_TAGS.iter().any(|tag| head.starts_with(tag)) {
        return true;
    }
    if head.starts_with("[Image: source:") || head.starts_with("[Request interrupted") {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A whole-file scan, which is what these tests are asking about. The
    /// reader itself became incremental — it resumes from a byte offset with
    /// whatever an earlier pass already settled — so starting at 0 with an
    /// empty scan is the "read it all, know nothing yet" case.
    fn scan_session(path: &Path) -> SessionScan {
        scan_session_from(path, 0, SessionScan::default()).0
    }

    // ── where the transcript is read up to ──────────────────────────────────
    //
    // The tab is unmounted while the agent keeps writing. Everything between
    // where the last watcher stopped and where the next one starts is a hole
    // the user never sees filled — the replay that would cover it only runs
    // when the frontend's event cache is empty, and for the first five minutes
    // it isn't. These pin the two halves of the answer: the mark survives the
    // watcher, and whoever reads reports honestly how far they got.

    // ── where `claude --resume` has to be launched ──────────────────────────
    //
    // Both halves of the worktree-resume bug live here: the encoding has to
    // name the directory Claude actually uses, and a transcript that moved has
    // to report the cwd it moved TO.

    #[test]
    fn encoding_matches_claude_for_both_worktree_layouts() {
        // Verified against live `~/.claude/projects` dirs. The dotted forms are
        // the ones the old `/`-and-space-only table got wrong, which is every
        // worktree there is.
        assert_eq!(
            encode_path("/Users/dev/Documents/New Git"),
            "-Users-dev-Documents-New-Git"
        );
        assert_eq!(
            encode_path("/Users/dev/.aura/worktrees/p-806b69db6ce45eb6/marrakesh"),
            "-Users-dev--aura-worktrees-p-806b69db6ce45eb6-marrakesh"
        );
        assert_eq!(
            encode_path("/Users/dev/Documents/Acme/.claude/worktrees/photo-generator"),
            "-Users-dev-Documents-Acme--claude-worktrees-photo-generator"
        );
        // A branch name with a `+` in it folds too — same rule, no special case.
        assert_eq!(
            encode_path("/r/.claude/worktrees/feat+x"),
            "-r--claude-worktrees-feat-x"
        );
    }

    #[test]
    fn encoding_ignores_a_trailing_slash() {
        assert_eq!(encode_path("/a/b/"), encode_path("/a/b"));
        // `/` is a real root, not an empty string.
        assert_eq!(encode_path("/"), "-");
    }

    #[test]
    fn a_session_that_moved_reports_the_cwd_it_moved_to() {
        // Claude's EnterWorktree re-keys the transcript under the worktree
        // while the records already written still name the main checkout. The
        // launch cwd is the one that encodes to the dir the file sits in —
        // resuming from the main checkout finds nothing.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(encode_path("/repo/.claude/worktrees/feat"));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        fs::write(
            &path,
            "{\"type\":\"user\",\"cwd\":\"/repo\"}\n\
             {\"type\":\"assistant\",\"cwd\":\"/repo/.claude/worktrees/feat\"}\n\
             {\"type\":\"assistant\",\"cwd\":\"/repo/.claude/worktrees/feat/sub\"}\n",
        )
        .unwrap();
        assert_eq!(scan_session(&path).cwd, "/repo/.claude/worktrees/feat");
    }

    #[test]
    fn a_session_that_never_moved_reports_where_it_started() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(encode_path("/repo"));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        fs::write(&path, "{\"type\":\"user\",\"cwd\":\"/repo\"}\n").unwrap();
        assert_eq!(scan_session(&path).cwd, "/repo");
    }

    #[test]
    fn an_unmatchable_dir_falls_back_to_the_first_recorded_cwd() {
        // A transcript we can't tie to its dir (hand-moved, or a Claude
        // encoding we don't know yet) still has to answer with something real
        // rather than an empty string the caller would read as "no cwd".
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("not-an-encoded-root");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        fs::write(&path, "{\"type\":\"user\",\"cwd\":\"/repo/sub\"}\n").unwrap();
        assert_eq!(scan_session(&path).cwd, "/repo/sub");
    }

    #[test]
    fn a_new_session_starts_at_the_end_because_there_is_no_history_to_miss() {
        assert_eq!(resume_offset("sess-new", "/tmp/never-read.jsonl", 4096), 4096);
    }

    #[test]
    fn a_watcher_restarting_on_the_same_tab_covers_the_gap() {
        note_read_offset("sess-gap", "/tmp/a.jsonl", 1000);
        // The agent wrote another 500 bytes while the tab was unmounted. The
        // watcher must open at 1000 — opening at 1500, which is what stat'ing
        // the file gives you, is the bug.
        assert_eq!(resume_offset("sess-gap", "/tmp/a.jsonl", 1500), 1000);
    }

    #[test]
    fn a_mark_from_a_different_transcript_is_not_used() {
        // A resumed session writes a fresh JSONL. A byte count taken against
        // the old one points at an arbitrary place in the new one.
        note_read_offset("sess-moved", "/tmp/old.jsonl", 900);
        assert_eq!(resume_offset("sess-moved", "/tmp/new.jsonl", 120), 120);
    }

    #[test]
    fn a_mark_past_the_end_of_a_truncated_file_is_clamped() {
        // Seeking past EOF would leave the tab silent until the file grew back
        // to where it used to be.
        note_read_offset("sess-rotated", "/tmp/r.jsonl", 5000);
        assert_eq!(resume_offset("sess-rotated", "/tmp/r.jsonl", 80), 80);
    }

    #[test]
    fn one_tab_s_mark_is_not_another_s() {
        note_read_offset("sess-a", "/tmp/shared.jsonl", 10);
        note_read_offset("sess-b", "/tmp/shared.jsonl", 70);
        assert_eq!(resume_offset("sess-a", "/tmp/shared.jsonl", 100), 10);
        assert_eq!(resume_offset("sess-b", "/tmp/shared.jsonl", 100), 70);
    }

    #[tokio::test]
    async fn a_replay_reports_the_bytes_it_read_not_the_file_s_size() {
        // The distinction matters because the file is being appended to while
        // we read it. Crediting ourselves with a byte we never parsed is one
        // line the user never sees.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let whole = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n";
        // A trailing fragment, as if the agent were mid-write.
        std::fs::write(&path, format!("{whole}{{\"type\":\"assis")).unwrap();

        let p = path.to_string_lossy().to_string();
        claude_load_session(p.clone(), 0, Some("sess-partial".into()))
            .await
            .unwrap();

        // Only the complete line counts. The fragment is left for the tail to
        // read again once its newline lands.
        assert_eq!(resume_offset("sess-partial", &p, u64::MAX), whole.len() as u64);
    }

    #[tokio::test]
    async fn a_replay_without_a_session_id_moves_nobody_s_mark() {
        // The resume picker previews transcripts. A preview must not move the
        // read position of a tab that is live-tailing the same file.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(&path, "{\"type\":\"user\",\"message\":{\"content\":\"x\"}}\n").unwrap();
        let p = path.to_string_lossy().to_string();

        note_read_offset("sess-live", &p, 7);
        claude_load_session(p.clone(), 0, None).await.unwrap();
        assert_eq!(resume_offset("sess-live", &p, 999), 7);
    }

    #[test]
    fn synthetic_prompt_filter_catches_internal_plumbing() {
        assert!(is_synthetic_prompt("<task-notification>\nx\n</task-notification>"));
        assert!(is_synthetic_prompt("<system-reminder>foo</system-reminder>"));
        assert!(is_synthetic_prompt("<command-name>/exit</command-name>"));
        assert!(is_synthetic_prompt("<bash-input>ls</bash-input>"));
        assert!(is_synthetic_prompt("<local-command-stdout>hi</local-command-stdout>"));
        assert!(is_synthetic_prompt("[Image: source: /tmp/x.png]"));
        assert!(is_synthetic_prompt("[Request interrupted by user]"));
    }

    #[test]
    fn synthetic_prompt_filter_passes_real_human_prompts() {
        assert!(!is_synthetic_prompt("fix the bug in auth"));
        assert!(!is_synthetic_prompt("hey can you read main.rs"));
        // Leading whitespace ok — trim handled.
        assert!(!is_synthetic_prompt("  hey there"));
        // A markdown paste isn't synthetic.
        assert!(!is_synthetic_prompt("```rust\nfn main() {}\n```"));
    }

    #[test]
    fn matching_project_dirs_recovers_pruned_worktree_orphans() {
        let base = std::env::temp_dir().join(format!("aura-sess-test-{}", std::process::id()));
        let projects = base.join("projects");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&projects).unwrap();

        let repo_root = "/Users/x/Documents/New Git";
        let root_dir = encode_path(repo_root);
        // A live worktree (as `git worktree list` would report it).
        let live_wt = "/Users/x/.aura/worktrees/p-abc/feat-live";
        // This repo's managed-worktree base → the recovery prefix.
        let recovery = encode_path("/Users/x/.aura/worktrees/p-abc");
        // An archived/pruned worktree dir under that base (its checkout is gone).
        let orphan = format!("{recovery}-feat-gone");
        // Another repo's worktree base — must NEVER be recovered.
        let foreign = format!(
            "{}-feat-other",
            encode_path("/Users/x/.aura/worktrees/p-zzz")
        );

        for name in [&root_dir, &encode_path(live_wt), &orphan, &foreign] {
            fs::create_dir_all(projects.join(name)).unwrap();
        }

        let roots = vec![repo_root.to_string(), live_wt.to_string()];
        let got = matching_project_dirs(&projects, &roots, Some(&recovery), repo_root);
        let names: std::collections::HashSet<String> = got
            .iter()
            .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();

        assert!(names.contains(&root_dir), "main checkout included");
        assert!(names.contains(&encode_path(live_wt)), "live worktree included");
        assert!(names.contains(&orphan), "pruned-worktree orphan recovered");
        assert!(!names.contains(&foreign), "another repo's worktree NOT recovered");

        // The orphan owns the main checkout as its root — its own path is gone.
        let orphan_root = got
            .iter()
            .find(|(p, _)| p.file_name().unwrap().to_string_lossy() == orphan)
            .map(|(_, r)| r.clone())
            .unwrap();
        assert_eq!(orphan_root, repo_root);

        // With no recovery prefix, only the live roots match (old behavior).
        let plain = matching_project_dirs(&projects, &roots, None, repo_root);
        let plain_names: std::collections::HashSet<String> = plain
            .iter()
            .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(!plain_names.contains(&orphan), "no recovery prefix → no orphan");

        let _ = fs::remove_dir_all(&base);
    }
}

/// Squash a tool_result content payload (string OR array of text blocks)
/// down to a single string so the bubble view can render it verbatim.
fn content_to_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod incremental_scan_tests {
    use super::*;
    use std::io::Write as _;

    fn scratch(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "aura-scan-{}-{}-{}",
            name,
            std::process::id(),
            now_unix_secs()
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn prompt(text: &str) -> String {
        format!(
            r#"{{"type":"queue-operation","operation":"enqueue","content":{},"cwd":"/tmp/proj"}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    /// Filler that looks like the bulk of a real transcript: assistant turns
    /// and tool results, none of which can carry a user prompt.
    fn noise(i: usize) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"reply {i}"}}]}}}}"#
        )
    }

    fn append(path: &Path, lines: &[String]) {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    #[test]
    fn contains_sub_matches_only_real_occurrences() {
        assert!(contains_sub(b"a queue-operation here", b"queue-operation"));
        assert!(!contains_sub(b"a queue-operatio here", b"queue-operation"));
        assert!(!contains_sub(b"short", b"queue-operation"));
        // A near-miss that shares the first byte must not stop the search.
        assert!(contains_sub(b"qqqqqueue-operation", b"queue-operation"));
    }

    /// The load-bearing property: reading a transcript in two passes must
    /// produce exactly what reading it in one pass would. If this ever drifts,
    /// the turn counts and previews in the Sessions list quietly go wrong.
    #[test]
    fn resuming_a_grown_transcript_matches_a_full_rescan() {
        let dir = scratch("resume");
        let p = dir.join("s.jsonl");

        let mut first: Vec<String> = vec![prompt("open the door")];
        first.extend((0..50).map(noise));
        first.push(prompt("second thing"));
        append(&p, &first);

        let (partial, at) = scan_session_from(&p, 0, SessionScan::default());
        assert_eq!(partial.turn_count, 2);
        assert_eq!(partial.cwd, "/tmp/proj");
        assert_eq!(at, fs::metadata(&p).unwrap().len());

        let mut more: Vec<String> = (50..90).map(noise).collect();
        more.push(prompt("third thing"));
        append(&p, &more);

        let (resumed, resumed_at) = scan_session_from(&p, at, partial);
        let (full, full_at) = scan_session_from(&p, 0, SessionScan::default());

        assert_eq!(resumed.turn_count, full.turn_count, "turn count must be exact");
        assert_eq!(resumed.turn_count, 3);
        assert_eq!(resumed.first_prompt, full.first_prompt);
        assert_eq!(resumed.last_prompt, full.last_prompt);
        assert_eq!(resumed.last_prompt, "third thing");
        assert_eq!(resumed.cwd, full.cwd);
        assert_eq!(resumed_at, full_at);

        let _ = fs::remove_dir_all(&dir);
    }

    /// A transcript being written right now ends mid-record. Consuming that
    /// half-line would drop the record when the rest arrives, so the scan has
    /// to stop before it and report the offset of the last complete line.
    #[test]
    fn a_half_written_line_is_left_for_the_next_pass() {
        let dir = scratch("partial");
        let p = dir.join("s.jsonl");
        append(&p, &[prompt("complete one")]);
        let complete_len = fs::metadata(&p).unwrap().len();

        let mut f = fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(br#"{"type":"queue-operation","operation":"enq"#).unwrap();
        drop(f);

        let (scan, at) = scan_session_from(&p, 0, SessionScan::default());
        assert_eq!(at, complete_len, "must stop at the last newline");
        assert_eq!(scan.turn_count, 1);

        // Now the writer finishes the record; resuming picks it up whole.
        append(&p, &[String::from(r#"ueue","content":"finished later"}"#)]);
        let (after, _) = scan_session_from(&p, at, scan);
        assert_eq!(after.turn_count, 2);
        assert_eq!(after.last_prompt, "finished later");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rewritten_head_is_detected() {
        let dir = scratch("sig");
        let a = dir.join("a.jsonl");
        let b = dir.join("b.jsonl");
        append(&a, &[prompt("one")]);
        append(&b, &[prompt("two")]);
        assert_ne!(head_signature(&a), head_signature(&b));
        assert_eq!(head_signature(&a), head_signature(&a));
        let _ = fs::remove_dir_all(&dir);
    }
}
