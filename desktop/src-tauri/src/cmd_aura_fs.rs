//! Read-only IPC over the project's `.aura/` directory. Each work pane
//! consumes one of these structs — Plan reads waves, Impacts reads the
//! impacts log, Timeline walks snapshots, Orchestration reads the agent
//! grid, Conflict unions sentinel + impacts.
//!
//! All commands are best-effort: if the file/dir is missing we return
//! an empty list rather than an error, so freshly-cloned repos with no
//! `.aura/` state render an empty pane instead of a red banner.

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct WaveFile {
    pub name: String,           // "auth-rewrite.xml"
    pub path: String,           // absolute
    pub waves: usize,           // count of <wave> elements
    pub status: String,         // "active" | "locked" | "done" | "unknown"
    pub mtime: i64,             // unix seconds
}

#[tauri::command]
pub async fn aura_list_waves(repo_root: String) -> Result<Vec<WaveFile>, String> {
    let dir = PathBuf::from(&repo_root).join(".aura").join("waves");
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.filter_map(|r| r.ok()) {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("xml") {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let body = fs::read_to_string(&path).unwrap_or_default();
        let waves = body.matches("<wave").count();
        let status = if body.contains("status=\"active\"") {
            "active"
        } else if body.contains("status=\"locked\"") {
            "locked"
        } else if body.contains("status=\"done\"") || body.contains("status=\"completed\"") {
            "done"
        } else {
            "unknown"
        }
        .to_string();
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        out.push(WaveFile {
            name,
            path: path.to_string_lossy().into_owned(),
            waves,
            status,
            mtime,
        });
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(out)
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ImpactAlert {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub severity: String,        // "low" | "medium" | "high" | "critical"
    #[serde(default)]
    pub function: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub timestamp: i64,
    #[serde(default)]
    pub resolved: bool,
}

#[tauri::command]
pub async fn aura_read_impacts(repo_root: String) -> Result<Vec<ImpactAlert>, String> {
    let p = PathBuf::from(&repo_root).join(".aura").join("impacts.jsonl");
    if !p.is_file() {
        return Ok(vec![]);
    }
    let body = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(a) = serde_json::from_str::<ImpactAlert>(line) {
            if !a.resolved {
                out.push(a);
            }
        }
    }
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

// Flip `resolved: true` on the matched alert id and rewrite the file
// atomically (tempfile + rename so a partial write can't corrupt the
// log). Unmatched ids are a no-op — the UI's optimistic refresh will
// reconcile if we missed the row.
#[tauri::command]
pub async fn aura_resolve_impact(repo_root: String, alert_id: String) -> Result<(), String> {
    let p = PathBuf::from(&repo_root).join(".aura").join("impacts.jsonl");
    if !p.is_file() {
        return Ok(());
    }
    let body = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut lines: Vec<String> = Vec::new();
    let mut changed = false;
    let mut promoted: Option<ImpactAlert> = None;
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<ImpactAlert>(trimmed) {
            Ok(mut a) if a.id == alert_id && !a.resolved => {
                // jj-style: dismissing a high/critical impact would
                // erase the AST-level divergence forever. Persist it
                // as a ConflictedNode so it survives until somebody
                // actually resolves the underlying conflict.
                if a.severity == "high" || a.severity == "critical" {
                    promoted = Some(a.clone());
                }
                a.resolved = true;
                let serialized =
                    serde_json::to_string(&a).map_err(|e| e.to_string())?;
                lines.push(serialized);
                changed = true;
            }
            Ok(_) => lines.push(trimmed.to_string()),
            Err(_) => lines.push(trimmed.to_string()),
        }
    }
    if !changed {
        return Ok(());
    }
    let mut new_body = lines.join("\n");
    new_body.push('\n');
    let tmp = p.with_extension("jsonl.tmp");
    fs::write(&tmp, new_body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    if let Some(alert) = promoted {
        crate::cmd_conflicts::aura_conflicts_record(
            repo_root.clone(),
            crate::cmd_conflicts::RecordConflictArgs {
                file: alert.file,
                identifier: alert.function,
                base_hash: alert.branch.clone(),
                ours: String::new(),
                theirs: alert.message.clone(),
                ours_agent: "local".into(),
                theirs_agent: alert.branch,
                // ours/theirs bodies aren't carried in the impact
                // event today; the conflict row stores what we know
                // and the resolver pane fetches the actual bodies on
                // open via `git_show_head` against the two refs.
            },
        )
        .await
        .ok();
    }
    Ok(())
}

#[derive(Serialize)]
pub struct SnapshotEntry {
    pub id: String,
    pub file: String,
    pub mtime: i64,
}

#[tauri::command]
pub async fn aura_list_snapshots(repo_root: String) -> Result<Vec<SnapshotEntry>, String> {
    let dir = PathBuf::from(&repo_root).join(".aura").join("snapshots");
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    walk_snapshots(&dir, &mut out);
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(out)
}

#[derive(Serialize)]
pub struct SnapshotPage {
    pub entries: Vec<SnapshotEntry>,
    pub has_more: bool,
    pub oldest_mtime: i64,
}

// Paginated snapshot list. Walking the dir is unavoidable (no on-disk
// index by mtime) but we cap the returned set with a bounded heap so
// the IPC payload + React render stay flat regardless of total count.
#[tauri::command]
pub async fn aura_list_snapshots_v2(
    repo_root: String,
    limit: usize,
    before_mtime: Option<i64>,
) -> Result<SnapshotPage, String> {
    let dir = PathBuf::from(&repo_root).join(".aura").join("snapshots");
    if !dir.is_dir() {
        return Ok(SnapshotPage { entries: vec![], has_more: false, oldest_mtime: 0 });
    }
    let limit = limit.max(1);
    let mut all = Vec::new();
    walk_snapshots(&dir, &mut all);
    let total_before_filter = all.len();
    if let Some(b) = before_mtime {
        all.retain(|s| s.mtime < b);
    }
    all.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    let has_more = all.len() > limit
        || (before_mtime.is_some() && total_before_filter > all.len() + limit);
    all.truncate(limit);
    let oldest_mtime = all.last().map(|s| s.mtime).unwrap_or(0);
    Ok(SnapshotPage { entries: all, has_more, oldest_mtime })
}

// Count snapshots whose mtime >= `since_ts`. When None, defaults to
// today's UTC midnight (StatusBar chip semantic).
#[tauri::command]
pub async fn aura_count_snapshots_today(
    repo_root: String,
    since_ts: Option<i64>,
) -> Result<u32, String> {
    let dir = PathBuf::from(&repo_root).join(".aura").join("snapshots");
    if !dir.is_dir() {
        return Ok(0);
    }
    let threshold = match since_ts {
        Some(t) => t,
        None => {
            let now = std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            now - (now % 86400)
        }
    };
    let mut count = 0u32;
    count_snapshots_after(&dir, threshold, &mut count);
    Ok(count)
}

fn count_snapshots_after(dir: &PathBuf, threshold: i64, count: &mut u32) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|r| r.ok()) {
        let path = entry.path();
        if path.is_dir() {
            count_snapshots_after(&path, threshold, count);
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if mtime >= threshold {
            *count += 1;
        }
    }
}

fn walk_snapshots(dir: &PathBuf, out: &mut Vec<SnapshotEntry>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|r| r.ok()) {
        let path = entry.path();
        if path.is_dir() {
            walk_snapshots(&path, out);
            continue;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        out.push(SnapshotEntry {
            id: path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&name)
                .to_string(),
            file: name,
            mtime,
        });
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct OrchAgent {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub current_task: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub progress: f32,
}

#[tauri::command]
pub async fn aura_read_orchestrate(repo_root: String) -> Result<Vec<OrchAgent>, String> {
    let dir = PathBuf::from(&repo_root).join(".aura").join("orchestrate");
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(out);
    };
    for entry in entries.filter_map(|r| r.ok()) {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let body = fs::read_to_string(&path).unwrap_or_default();
        if let Ok(arr) = serde_json::from_str::<Vec<OrchAgent>>(&body) {
            out.extend(arr);
        } else if let Ok(one) = serde_json::from_str::<OrchAgent>(&body) {
            out.push(one);
        }
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct ConflictItem {
    pub kind: String,           // "sentinel" | "git" | "impact"
    pub severity: String,
    pub label: String,
    pub detail: String,
}

#[tauri::command]
pub async fn aura_list_conflicts(repo_root: String) -> Result<Vec<ConflictItem>, String> {
    let mut out = Vec::new();

    // High/critical impacts
    if let Ok(alerts) = aura_read_impacts(repo_root.clone()).await {
        for a in alerts {
            if a.severity == "high" || a.severity == "critical" {
                out.push(ConflictItem {
                    kind: "impact".into(),
                    severity: a.severity,
                    label: a.function,
                    detail: a.message,
                });
            }
        }
    }

    // Sentinel collisions
    let sentinel_dir = PathBuf::from(&repo_root).join(".aura").join("sentinel");
    if let Ok(entries) = fs::read_dir(&sentinel_dir) {
        for entry in entries.filter_map(|r| r.ok()) {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let body = fs::read_to_string(&path).unwrap_or_default();
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if name.contains("collision") || name.contains("conflict") {
                out.push(ConflictItem {
                    kind: "sentinel".into(),
                    severity: "high".into(),
                    label: name,
                    detail: body.chars().take(120).collect(),
                });
            }
        }
    }

    // Git markers — `git diff --check` returns rows for any conflict marker.
    let cwd = PathBuf::from(&repo_root);
    if let Ok(check) = std::process::Command::new("git")
        .args(["diff", "--check"])
        .current_dir(&cwd)
        .output()
    {
        let txt = String::from_utf8_lossy(&check.stdout);
        for line in txt.lines() {
            if line.trim().is_empty() {
                continue;
            }
            out.push(ConflictItem {
                kind: "git".into(),
                severity: "high".into(),
                label: line.split(':').next().unwrap_or("merge marker").to_string(),
                detail: line.to_string(),
            });
        }
    }

    Ok(out)
}

#[derive(Serialize)]
pub struct DiffStats {
    pub changed_files: u32,
    pub added: u32,
    pub removed: u32,
}

/// The fork point of a linked worktree's branch from the primary checkout —
/// the commit the worktree diverged from. We derive it from git state alone
/// (no stored metadata), so it works for worktrees created before this feature
/// existed: list the worktrees, pick the primary (the one that ISN'T this
/// path), and return `git merge-base HEAD <primary-branch-or-tip>`.
///
/// Returns `None` whenever it can't resolve cleanly — a single (non-linked)
/// worktree, a detached primary, or any git error — so callers fall back to the
/// plain HEAD/status behavior instead of showing something wrong. Never panics.
pub(crate) fn worktree_fork_base(worktree_path: &str) -> Option<String> {
    let cwd = PathBuf::from(worktree_path);

    // `git worktree list --porcelain` emits blank-line-separated records, each
    // starting with `worktree <abs-path>`, optionally followed by `HEAD <sha>`,
    // `branch refs/heads/<name>`, `detached`, `bare`, etc. The FIRST record is
    // always the main (primary) worktree.
    let listing = std::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&cwd)
        .output()
        .ok()?;
    if !listing.status.success() {
        return None;
    }
    let body = String::from_utf8_lossy(&listing.stdout);

    // Canonicalize so trailing-slash / symlink differences don't defeat the
    // "is this the primary?" comparison. Fall back to the raw path on failure.
    let this_path = std::fs::canonicalize(&cwd).unwrap_or(cwd.clone());

    // Walk the porcelain records. Each `worktree <path>` line opens a record;
    // we capture that record's path + its branch (or detached HEAD sha). The
    // primary is the first record whose path is NOT this worktree.
    let mut cur_path: Option<PathBuf> = None;
    let mut cur_ref: Option<String> = None; // branch name or HEAD sha
    let mut records: Vec<(PathBuf, Option<String>)> = Vec::new();
    let flush = |records: &mut Vec<(PathBuf, Option<String>)>,
                 cur_path: &mut Option<PathBuf>,
                 cur_ref: &mut Option<String>| {
        if let Some(p) = cur_path.take() {
            records.push((p, cur_ref.take()));
        } else {
            *cur_ref = None;
        }
    };
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            flush(&mut records, &mut cur_path, &mut cur_ref);
            cur_path = Some(PathBuf::from(rest.trim()));
        } else if let Some(rest) = line.strip_prefix("branch ") {
            // refs/heads/<name> → keep the full ref; merge-base resolves it.
            cur_ref = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            // Only used when this record has no branch (detached); a later
            // `branch` line (there won't be one) would override it anyway.
            if cur_ref.is_none() {
                cur_ref = Some(rest.trim().to_string());
            }
        }
    }
    flush(&mut records, &mut cur_path, &mut cur_ref);

    // The primary = the first record that isn't this worktree. (If this path
    // IS the first/primary record, there's no base to diff against → None.)
    let primary_ref = records.iter().find_map(|(p, r)| {
        let same = std::fs::canonicalize(p)
            .map(|c| c == this_path)
            .unwrap_or_else(|_| p == &this_path);
        if same {
            None
        } else {
            r.clone()
        }
    })?;

    let merge_base = std::process::Command::new("git")
        .args(["merge-base", "HEAD", &primary_ref])
        .current_dir(&cwd)
        .output()
        .ok()?;
    if !merge_base.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&merge_base.stdout).trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}

#[tauri::command]
pub async fn git_diff_stats(
    repo_root: String,
    since_base: Option<bool>,
) -> Result<DiffStats, String> {
    let cwd = PathBuf::from(&repo_root);

    // "All work since this worktree forked": diff the working tree against the
    // fork-base commit (two-dot `git diff <base>` spans base → working tree, so
    // it includes BOTH the commits made on the worktree branch and the
    // still-uncommitted edits). Only when an actual base resolves; otherwise we
    // fall through to the plain HEAD/status path below (byte-identical to the
    // pre-feature behavior).
    if since_base == Some(true) {
        if let Some(base) = worktree_fork_base(&repo_root) {
            let out = std::process::Command::new("git")
                .args(["diff", &base, "--shortstat"])
                .current_dir(&cwd)
                .output()
                .map_err(|e| e.to_string())?;
            let stat = String::from_utf8_lossy(&out.stdout);
            let mut added = 0u32;
            let mut removed = 0u32;
            for token in stat.split(',') {
                let t = token.trim();
                if let Some(n) = first_number(t) {
                    if t.contains("insertion") {
                        added = n;
                    } else if t.contains("deletion") {
                        removed = n;
                    }
                }
            }
            // The COUNT must come from the base diff itself (not `git status`),
            // so committed-but-clean-in-the-worktree files are counted too.
            // `--name-only` lists one path per changed file (renames collapse to
            // a single line), which is exactly the file count we want.
            let names = std::process::Command::new("git")
                .args(["diff", &base, "--name-only"])
                .current_dir(&cwd)
                .output()
                .map_err(|e| e.to_string())?;
            let changed_files = String::from_utf8_lossy(&names.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count() as u32;
            return Ok(DiffStats {
                changed_files,
                added,
                removed,
            });
        }
    }

    // shortstat parses "1 file changed, 5 insertions(+), 2 deletions(-)"
    let out = std::process::Command::new("git")
        .args(["diff", "--shortstat"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| e.to_string())?;
    let stat = String::from_utf8_lossy(&out.stdout);
    let mut added = 0u32;
    let mut removed = 0u32;
    let mut changed_files = 0u32;
    for token in stat.split(',') {
        let t = token.trim();
        if let Some(n) = first_number(t) {
            if t.contains("file") {
                changed_files = n;
            } else if t.contains("insertion") {
                added = n;
            } else if t.contains("deletion") {
                removed = n;
            }
        }
    }
    // Untracked + staged-only files don't show up in `diff --shortstat`,
    // so add the porcelain count to keep the chip honest.
    if let Ok(porcelain) = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&cwd)
        .output()
    {
        let body = String::from_utf8_lossy(&porcelain.stdout);
        let porcelain_count = body.lines().filter(|l| !l.trim().is_empty()).count() as u32;
        changed_files = changed_files.max(porcelain_count);
    }
    Ok(DiffStats {
        changed_files,
        added,
        removed,
    })
}

fn first_number(s: &str) -> Option<u32> {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

#[derive(Serialize)]
pub struct FileDiffStat {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

/// Per-file +/- counts vs HEAD, plus untracked files counted as
/// pure additions. The right-rail Changes panel needs per-row stats
/// (`+12 -3`) next to every file so the user can scan blast radius
/// at a glance — the global `git_diff_stats` shortstat doesn't break
/// down per path.
#[tauri::command]
pub async fn git_diff_stats_per_file(
    repo_root: String,
    since_base: Option<bool>,
) -> Result<Vec<FileDiffStat>, String> {
    let cwd = PathBuf::from(&repo_root);
    let mut out: Vec<FileDiffStat> = Vec::new();

    // "All work since this worktree forked": per-file +/- vs the fork-base
    // commit (committed + uncommitted, via two-dot `git diff <base>`). The
    // untracked pass is skipped here because the base diff already includes
    // newly-added files. Only when an actual base resolves; otherwise fall
    // through to the plain HEAD path (byte-identical to the old behavior).
    if since_base == Some(true) {
        if let Some(base) = worktree_fork_base(&repo_root) {
            let diff = std::process::Command::new("git")
                .args(["diff", &base, "--numstat"])
                .current_dir(&cwd)
                .output()
                .map_err(|e| e.to_string())?;
            if diff.status.success() {
                let body = String::from_utf8_lossy(&diff.stdout);
                for line in body.lines() {
                    let mut it = line.splitn(3, '\t');
                    let add = it.next().unwrap_or("0");
                    let del = it.next().unwrap_or("0");
                    let raw_path = match it.next() {
                        Some(p) => p,
                        None => continue,
                    };
                    let path = if let Some(idx) = raw_path.rfind(" => ") {
                        let after = &raw_path[idx + 4..];
                        after.trim_end_matches('}').to_string()
                    } else {
                        raw_path.to_string()
                    };
                    out.push(FileDiffStat {
                        path,
                        additions: add.parse().unwrap_or(0),
                        deletions: del.parse().unwrap_or(0),
                    });
                }
            }
            return Ok(out);
        }
    }

    // Tracked changes (staged + unstaged combined) vs HEAD. Numstat
    // emits "<add>\t<del>\t<path>" per line; binaries report "-\t-".
    let tracked = std::process::Command::new("git")
        .args(["diff", "HEAD", "--numstat"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| e.to_string())?;
    if tracked.status.success() {
        let body = String::from_utf8_lossy(&tracked.stdout);
        for line in body.lines() {
            let mut it = line.splitn(3, '\t');
            let add = it.next().unwrap_or("0");
            let del = it.next().unwrap_or("0");
            let raw_path = match it.next() {
                Some(p) => p,
                None => continue,
            };
            // Renames look like "a/b/old.rs => a/b/new.rs" or
            // "a/{old.rs => new.rs}/b" — keep the new path.
            let path = if let Some(idx) = raw_path.rfind(" => ") {
                let after = &raw_path[idx + 4..];
                after.trim_end_matches('}').to_string()
            } else {
                raw_path.to_string()
            };
            out.push(FileDiffStat {
                path,
                additions: add.parse().unwrap_or(0),
                deletions: del.parse().unwrap_or(0),
            });
        }
    }

    // Untracked: count newlines as additions, zero deletions. Bound at
    // 5MB per file so a stray binary doesn't blow up the response.
    if let Ok(untracked) = std::process::Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .current_dir(&cwd)
        .output()
    {
        if untracked.status.success() {
            let body = String::from_utf8_lossy(&untracked.stdout);
            for rel in body.split('\0') {
                if rel.is_empty() {
                    continue;
                }
                let abs = cwd.join(rel);
                let additions = match std::fs::metadata(&abs) {
                    Ok(m) if m.is_file() && m.len() <= 5 * 1024 * 1024 => {
                        std::fs::read_to_string(&abs)
                            .map(|s| s.lines().count() as u32)
                            .unwrap_or(0)
                    }
                    _ => 0,
                };
                out.push(FileDiffStat {
                    path: rel.to_string(),
                    additions,
                    deletions: 0,
                });
            }
        }
    }

    Ok(out)
}

// ── Intent log ────────────────────────────────────────────────────────
//
// Each line in `.aura/intent_log.jsonl` is a free-form record the daemon
// (or `aura log-intent`) appends. Fields vary by version, so the struct
// uses serde defaults — anything missing renders blank in the UI.

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct IntentEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub timestamp: i64,
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub intent: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub commit: String,
    #[serde(default)]
    pub status: String,
    /// Changeset binding (option 1/2/4/5 wiring). Older rows omit this.
    /// Kept as a raw `serde_json::Value` so the schema can evolve in
    /// `cmd_aura.rs` without dragging this struct along — the React side
    /// has its own typed `IntentChangeset`.
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub changeset: serde_json::Value,
}

#[tauri::command]
pub async fn aura_read_intent_log(repo_root: String) -> Result<Vec<IntentEntry>, String> {
    let p = PathBuf::from(&repo_root).join(".aura").join("intent_log.jsonl");
    if !p.is_file() {
        return Ok(vec![]);
    }
    let body = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (i, line) in body.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<IntentEntry>(line) {
            Ok(mut e) => {
                if e.id.is_empty() {
                    e.id = format!("i{i}");
                }
                out.push(e);
            }
            Err(_) => {
                // Permissive fallback: the line might be the older
                // single-string format. Wrap it so it still appears.
                out.push(IntentEntry {
                    id: format!("i{i}"),
                    intent: line.to_string(),
                    ..Default::default()
                });
            }
        }
    }
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

// Paginated reader. The intent log is append-only with timestamps that
// monotonically increase, so iterating `lines().rev()` yields the newest
// first — we stop after `limit` matches without parsing the rest of the
// file. Cheaper than the v1 read-all-and-sort path; the History sidebar
// uses this directly.
#[derive(Serialize)]
pub struct IntentLogPage {
    pub entries: Vec<IntentEntry>,
    pub has_more: bool,
    /// Timestamp of the oldest entry returned. Caller passes this back as
    /// `before_ts` to fetch the next page.
    pub oldest_ts: i64,
}

#[tauri::command]
pub async fn aura_read_intent_log_v2(
    repo_root: String,
    limit: usize,
    before_ts: Option<i64>,
    agent: Option<String>,
) -> Result<IntentLogPage, String> {
    let p = PathBuf::from(&repo_root).join(".aura").join("intent_log.jsonl");
    if !p.is_file() {
        return Ok(IntentLogPage { entries: vec![], has_more: false, oldest_ts: 0 });
    }
    let body = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let limit = limit.max(1);
    let agent_filter = agent.as_deref();

    let mut out: Vec<IntentEntry> = Vec::with_capacity(limit);
    let mut hit_limit = false;
    // .lines() returns a DoubleEndedIterator over &str slices — reversing
    // is constant-time per line. We enumerate from the original direction
    // so synthetic ids stay stable across pages.
    let lines: Vec<(usize, &str)> = body.lines().enumerate().collect();
    for (i, raw) in lines.iter().rev() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let mut entry: IntentEntry = match serde_json::from_str(line) {
            Ok(e) => e,
            Err(_) => IntentEntry {
                id: format!("i{i}"),
                intent: line.to_string(),
                ..Default::default()
            },
        };
        if entry.id.is_empty() {
            entry.id = format!("i{i}");
        }
        if let Some(b) = before_ts {
            if entry.timestamp >= b {
                continue;
            }
        }
        if let Some(a) = agent_filter {
            if entry.agent != a {
                continue;
            }
        }
        out.push(entry);
        if out.len() >= limit {
            hit_limit = true;
            break;
        }
    }
    let oldest_ts = out.last().map(|e| e.timestamp).unwrap_or(0);
    Ok(IntentLogPage { entries: out, has_more: hit_limit, oldest_ts })
}

// Stream-count rows whose timestamp >= `since_ts`. When `since_ts` is
// None, counts everything since today's UTC midnight (the StatusBar
// chip semantic). When set, counts since the given epoch second (used
// by the SessionMemoryChip with the session-start timestamp).
//
// We only need the integer, not the entries themselves, so the cheap
// path skips the full JSON parse after grabbing `timestamp`.
#[tauri::command]
pub async fn aura_count_intents_today(
    repo_root: String,
    agent: Option<String>,
    since_ts: Option<i64>,
) -> Result<u32, String> {
    let p = PathBuf::from(&repo_root).join(".aura").join("intent_log.jsonl");
    if !p.is_file() {
        return Ok(0);
    }
    let threshold = match since_ts {
        Some(t) => t,
        None => {
            let now = std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            now - (now % 86400)
        }
    };
    let body = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut count = 0u32;
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Cheap path: extract the timestamp without parsing the full
        // record. Falls back to full parse only when the cheap path
        // misses (unusual key order).
        let ts = quick_extract_i64(line, "\"timestamp\"")
            .or_else(|| serde_json::from_str::<IntentEntry>(line).ok().map(|e| e.timestamp))
            .unwrap_or(0);
        if ts < threshold {
            continue;
        }
        if let Some(a) = agent.as_deref() {
            // Agent filter requires the parsed record. Only do it when
            // the cheap timestamp filter passed.
            let Ok(entry) = serde_json::from_str::<IntentEntry>(line) else {
                continue;
            };
            if entry.agent != a {
                continue;
            }
        }
        count += 1;
    }
    Ok(count)
}

// ── Audit log ─────────────────────────────────────────────────────────
//
// `.aura/audit.jsonl` is the audit trail for `--no-verify` bypasses,
// hook failures, snapshot orphans, and force-pushes. Each line is one
// JSON event; reader is permissive so future additions don't break
// the History sidebar.

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AuditEntry {
    #[serde(default)]
    pub timestamp: i64,
    #[serde(default)]
    pub kind: String,        // "no_verify" | "hook_fail" | "force_push" | ...
    #[serde(default)]
    pub severity: String,    // "warn" | "fail" | "info"
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub commit: String,
    #[serde(default)]
    pub acknowledged: bool,
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Serialize)]
pub struct AuditLogPage {
    pub entries: Vec<AuditEntry>,
    pub has_more: bool,
    pub oldest_ts: i64,
}

#[tauri::command]
pub async fn aura_read_audit_log_v2(
    repo_root: String,
    limit: usize,
    before_ts: Option<i64>,
) -> Result<AuditLogPage, String> {
    let p = PathBuf::from(&repo_root).join(".aura").join("audit.jsonl");
    if !p.is_file() {
        return Ok(AuditLogPage { entries: vec![], has_more: false, oldest_ts: 0 });
    }
    let body = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let limit = limit.max(1);
    let mut out: Vec<AuditEntry> = Vec::with_capacity(limit);
    let mut hit_limit = false;
    let lines: Vec<&str> = body.lines().collect();
    for raw in lines.iter().rev() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let entry: AuditEntry = match serde_json::from_str(line) {
            Ok(e) => e,
            Err(_) => AuditEntry {
                summary: line.to_string(),
                ..Default::default()
            },
        };
        if let Some(b) = before_ts {
            if entry.timestamp >= b {
                continue;
            }
        }
        out.push(entry);
        if out.len() >= limit {
            hit_limit = true;
            break;
        }
    }
    let oldest_ts = out.last().map(|e| e.timestamp).unwrap_or(0);
    Ok(AuditLogPage { entries: out, has_more: hit_limit, oldest_ts })
}

#[tauri::command]
pub async fn aura_count_audit_unacked(repo_root: String) -> Result<u32, String> {
    let p = PathBuf::from(&repo_root).join(".aura").join("audit.jsonl");
    if !p.is_file() {
        return Ok(0);
    }
    let body = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut count = 0u32;
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(e) = serde_json::from_str::<AuditEntry>(line) else {
            continue;
        };
        if !e.acknowledged && e.severity != "info" {
            count += 1;
        }
    }
    Ok(count)
}

// Locate `"key": <int>` or `"key":<int>` and parse the integer. Tolerates
// trailing comma/whitespace/closing brace. Returns None if the key isn't
// present at all or the value isn't a bare integer (e.g., a quoted string).
fn quick_extract_i64(line: &str, key_quoted: &str) -> Option<i64> {
    let idx = line.find(key_quoted)?;
    let rest = &line[idx + key_quoted.len()..];
    let rest = rest.trim_start_matches(|c: char| c == ':' || c.is_whitespace());
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '-'))
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

// ── Usage ─────────────────────────────────────────────────────────────
//
// Pulls a thin summary out of the daemon's usage log (`.aura/usage.jsonl`).
// Falls back to zeros if no log exists. Each line is one model call:
//   { ts, model, in_tokens, out_tokens, cost_usd }
// We sum *today's* rows for the chip in the StatusBar.

#[derive(Serialize, Default)]
pub struct UsageSummary {
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cost_usd: f64,
    pub calls: u32,
    pub model: String,        // most-used model name today
}

#[derive(Deserialize, Default)]
struct UsageRow {
    #[serde(default)]
    ts: i64,
    #[serde(default)]
    model: String,
    #[serde(default)]
    in_tokens: u64,
    #[serde(default)]
    out_tokens: u64,
    #[serde(default)]
    cost_usd: f64,
}

#[tauri::command]
pub async fn aura_usage_summary(repo_root: String) -> Result<UsageSummary, String> {
    let mut sum = UsageSummary::default();
    let p = PathBuf::from(&repo_root).join(".aura").join("usage.jsonl");
    if !p.is_file() {
        return Ok(sum);
    }
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let day_start = now - (now % 86400);

    let body = fs::read_to_string(&p).unwrap_or_default();
    let mut counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(r) = serde_json::from_str::<UsageRow>(line) else {
            continue;
        };
        if r.ts < day_start {
            continue;
        }
        sum.tokens_in += r.in_tokens;
        sum.tokens_out += r.out_tokens;
        sum.cost_usd += r.cost_usd;
        sum.calls += 1;
        *counts.entry(r.model).or_insert(0) += 1;
    }
    sum.model = counts
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(k, _)| k)
        .unwrap_or_default();
    Ok(sum)
}

// ── Recent commits (for History tab + #commits channel) ──────────────

#[derive(Serialize)]
pub struct CommitEntry {
    pub sha: String,        // short
    pub author: String,
    pub timestamp: i64,
    pub subject: String,
    pub branch: String,
}

#[tauri::command]
pub async fn git_recent_commits(repo_root: String, limit: u32) -> Result<Vec<CommitEntry>, String> {
    let cwd = PathBuf::from(&repo_root);
    let n = limit.clamp(1, 200);
    let fmt = "%h\x1f%an\x1f%ct\x1f%s";
    let out = std::process::Command::new("git")
        .args([
            "log",
            &format!("-n{n}"),
            &format!("--pretty=format:{fmt}"),
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| e.to_string())?;
    let txt = String::from_utf8_lossy(&out.stdout);

    // Best-effort current branch tag for each row — no per-commit branch
    // lookup (expensive); we just attach the current HEAD branch since
    // `git log` here is HEAD-relative anyway.
    let head_branch = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&cwd)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let mut commits = Vec::new();
    for line in txt.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 4 {
            continue;
        }
        commits.push(CommitEntry {
            sha: parts[0].to_string(),
            author: parts[1].to_string(),
            timestamp: parts[2].parse().unwrap_or(0),
            subject: parts[3].to_string(),
            branch: head_branch.clone(),
        });
    }
    Ok(commits)
}

// ── Commit graph (Source Control topology view) ──────────────────────
//
// Powers the native commit-graph rail (the VS Code "Source Control →
// Graph" parity surface). Unlike `git_recent_commits` (HEAD-relative,
// flat), this walks `--all --date-order` so every branch/merge shows,
// and carries the data a topology renderer needs: the FULL sha, the full
// parent shas (so lanes can be threaded), author email (avatar/identity),
// and the decoration refs (branch tips / tags / HEAD) parsed into typed
// badges. Lane assignment itself is pure and lives in the frontend.

#[derive(Serialize)]
pub struct GraphRef {
    pub name: String,
    /// "head" (the checked-out branch / detached HEAD) | "local" |
    /// "remote" | "tag". The frontend colours badges by this.
    pub kind: String,
}

#[derive(Serialize)]
pub struct GraphCommit {
    pub sha: String,   // full 40-char sha — stable identity for lanes
    pub short: String, // abbreviated, for display
    pub parents: Vec<String>, // full parent shas, first-parent first
    pub author: String,
    pub author_email: String,
    pub timestamp: i64,
    pub subject: String,
    pub refs: Vec<GraphRef>,
}

#[tauri::command]
pub async fn git_commit_graph(
    repo_root: String,
    limit: u32,
) -> Result<Vec<GraphCommit>, String> {
    let cwd = PathBuf::from(&repo_root);
    let n = limit.clamp(1, 1000);

    // Remote names, so a decoration like `origin/feat/x` is classed as
    // remote rather than mistaken for a local branch named with slashes
    // (e.g. `feat/commons-platform`). One cheap call; empty on failure.
    let remotes: Vec<String> = std::process::Command::new("git")
        .args(["remote"])
        .current_dir(&cwd)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default();

    // %H full sha · %h short · %P parents (space-sep) · %an author ·
    // %ae email · %ct commit-time · %s subject · %D decorations.
    let fmt = "%H\x1f%h\x1f%P\x1f%an\x1f%ae\x1f%ct\x1f%s\x1f%D";
    // Aura's own shadow/checkpoint branches (`entire/*`, `aura/*`) are
    // machinery, not human history — excluding them keeps the graph
    // readable (especially for non-engineers, who shouldn't see VCS
    // internals). The `--exclude` globs must precede `--all`.
    let out = std::process::Command::new("git")
        .args([
            "log",
            "--exclude=refs/heads/entire/*",
            "--exclude=refs/heads/aura/*",
            "--exclude=refs/remotes/*/entire/*",
            "--exclude=refs/remotes/*/aura/*",
            "--all",
            "--date-order",
            &format!("-n{n}"),
            &format!("--pretty=format:{fmt}"),
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        // Empty repo / not a git dir → empty graph, never a hard error
        // (the rail just shows its empty state).
        return Ok(Vec::new());
    }
    let txt = String::from_utf8_lossy(&out.stdout);

    let mut commits = Vec::new();
    for line in txt.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 7 {
            continue;
        }
        let parents: Vec<String> = parts[2]
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();
        let refs = parts
            .get(7)
            .map(|d| parse_decorations(d, &remotes))
            .unwrap_or_default();
        commits.push(GraphCommit {
            sha: parts[0].to_string(),
            short: parts[1].to_string(),
            parents,
            author: parts[3].to_string(),
            author_email: parts[4].to_string(),
            timestamp: parts[5].parse().unwrap_or(0),
            subject: parts[6].to_string(),
            refs,
        });
    }
    Ok(commits)
}

/// Parse git's `%D` decoration string into typed refs. Examples:
///   "HEAD -> feat/x, origin/feat/x, tag: v1.0, other-branch"
///   "HEAD" (detached)
fn parse_decorations(deco: &str, remotes: &[String]) -> Vec<GraphRef> {
    let mut out = Vec::new();
    for raw in deco.split(',') {
        let tok = raw.trim();
        if tok.is_empty() {
            continue;
        }
        if let Some(branch) = tok.strip_prefix("HEAD -> ") {
            // The checked-out branch — mark it as HEAD so the rail can
            // pin "you are here".
            out.push(GraphRef {
                name: branch.trim().to_string(),
                kind: "head".to_string(),
            });
        } else if tok == "HEAD" {
            out.push(GraphRef {
                name: "HEAD".to_string(),
                kind: "head".to_string(),
            });
        } else if let Some(tag) = tok.strip_prefix("tag: ") {
            out.push(GraphRef {
                name: tag.trim().to_string(),
                kind: "tag".to_string(),
            });
        } else {
            // Remote if its first path segment is a known remote name.
            let first = tok.split('/').next().unwrap_or("");
            let kind = if remotes.iter().any(|r| r == first) {
                "remote"
            } else {
                "local"
            };
            out.push(GraphRef {
                name: tok.to_string(),
                kind: kind.to_string(),
            });
        }
    }
    out
}

// ── Git contributors (auto-populated team list) ──────────────────────
//
// The chat panel treats git history as the source of truth for team
// membership: whoever has authored a commit IS on the team. No separate
// signup. We walk all-branch `git log`, dedupe by email, and return
// name + email + commit count + last-active timestamp.

#[derive(Serialize)]
pub struct GitContributor {
    pub name: String,
    pub email: String,
    pub commits: u32,
    pub last_active: i64,
    pub handle: String, // local-part of email — what we show as @handle
}

// Same vendored-path exclusions as `cmd_team::walk_git_authors`. Without
// these, dependency maintainers (Monaco/React/etc.) appear in the team
// list whenever a repo has committed `node_modules` or a `vendor/` dir.
// Listing them as teammates is both noisy and a security risk because
// they'd receive any subsequent chat broadcast.
const VENDORED_EXCLUDES: &[&str] = &[
    ":(exclude)node_modules/**",
    ":(exclude)**/node_modules/**",
    ":(exclude)vendor/**",
    ":(exclude)**/vendor/**",
    ":(exclude)third_party/**",
    ":(exclude)**/third_party/**",
    ":(exclude)external/**",
    ":(exclude)**/external/**",
    ":(exclude)bower_components/**",
    ":(exclude)target/**",
    ":(exclude)dist/**",
    ":(exclude)build/**",
    ":(exclude).next/**",
    ":(exclude).nuxt/**",
    ":(exclude).turbo/**",
    ":(exclude).cache/**",
    ":(exclude)pkg/**",
    ":(exclude)Pods/**",
];

#[tauri::command]
pub async fn git_contributors(repo_root: String) -> Result<Vec<GitContributor>, String> {
    let cwd = PathBuf::from(&repo_root);
    let fmt = "%aN\x1f%aE\x1f%ct";
    let mut args: Vec<String> = vec![
        "log".into(),
        "--all".into(),
        format!("--pretty=format:{fmt}"),
        "--".into(),
        ".".into(),
    ];
    for ex in VENDORED_EXCLUDES {
        args.push((*ex).to_string());
    }
    let out = std::process::Command::new("git")
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| e.to_string())?;
    let txt = String::from_utf8_lossy(&out.stdout);

    use std::collections::BTreeMap;
    let mut by_email: BTreeMap<String, GitContributor> = BTreeMap::new();
    for line in txt.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 3 {
            continue;
        }
        let name = parts[0].trim().to_string();
        let email = parts[1].trim().to_lowercase();
        let ts: i64 = parts[2].parse().unwrap_or(0);
        if email.is_empty() {
            continue;
        }
        // Drop only the standard GitHub privacy address. Older code
        // also rejected anything containing "noreply", which silently
        // filtered out real teammates whose company addresses happen to
        // contain that substring.
        if email.ends_with("@users.noreply.github.com") {
            continue;
        }
        let handle = email.split('@').next().unwrap_or(&email).to_string();
        let entry = by_email
            .entry(email.clone())
            .or_insert_with(|| GitContributor {
                name: name.clone(),
                email: email.clone(),
                commits: 0,
                last_active: 0,
                handle,
            });
        entry.commits += 1;
        if ts > entry.last_active {
            entry.last_active = ts;
            // Prefer the most-recent display name for renames over time.
            if !name.is_empty() {
                entry.name = name;
            }
        }
    }
    let mut list: Vec<GitContributor> = by_email.into_values().collect();
    list.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    Ok(list)
}

// ── Semantic outline (functions/classes for the editor's right rail) ─
//
// We shell out to `aura semantic outline <file>` and parse a permissive
// "kind:name:line" line format. If the CLI isn't available we fall
// back to a regex pass over the raw text so the user still sees *some*
// outline rather than an empty rail.

#[derive(Serialize)]
pub struct OutlineNode {
    pub kind: String,        // "fn" | "class" | "type" | "const" | "section"
    pub name: String,
    pub line: u32,
}

#[tauri::command]
pub async fn aura_semantic_outline(
    repo_root: String,
    file: String,
) -> Result<Vec<OutlineNode>, String> {
    // Try the CLI first.
    let cwd = PathBuf::from(&repo_root);
    if let Ok(out) = std::process::Command::new("aura")
        .args(["semantic", "outline", &file])
        .current_dir(&cwd)
        .output()
    {
        if out.status.success() {
            let txt = String::from_utf8_lossy(&out.stdout);
            let mut nodes = Vec::new();
            for line in txt.lines() {
                let parts: Vec<&str> = line.splitn(3, ':').collect();
                if parts.len() < 3 {
                    continue;
                }
                nodes.push(OutlineNode {
                    kind: parts[0].trim().to_string(),
                    name: parts[1].trim().to_string(),
                    line: parts[2].trim().parse().unwrap_or(0),
                });
            }
            if !nodes.is_empty() {
                return Ok(nodes);
            }
        }
    }

    // Fallback: cheap regex scan. Catches Rust/TS/JS/Python at minimum.
    let abs = if PathBuf::from(&file).is_absolute() {
        PathBuf::from(&file)
    } else {
        cwd.join(&file)
    };
    let body = fs::read_to_string(&abs).unwrap_or_default();
    let mut nodes = Vec::new();
    for (i, line) in body.lines().enumerate() {
        let trimmed = line.trim_start();
        let lineno = (i + 1) as u32;
        if let Some(name) = strip_prefix_word(trimmed, &["pub fn ", "fn ", "function ", "def ", "async fn "]) {
            nodes.push(OutlineNode { kind: "fn".into(), name, line: lineno });
        } else if let Some(name) = strip_prefix_word(trimmed, &["pub struct ", "struct ", "class ", "interface "]) {
            nodes.push(OutlineNode { kind: "class".into(), name, line: lineno });
        } else if let Some(name) = strip_prefix_word(trimmed, &["pub type ", "type "]) {
            nodes.push(OutlineNode { kind: "type".into(), name, line: lineno });
        } else if let Some(name) = strip_prefix_word(trimmed, &["pub const ", "const ", "let "]) {
            // Only top-level lets (no leading whitespace).
            if line.starts_with("pub const ") || line.starts_with("const ") || line.starts_with("let ") {
                nodes.push(OutlineNode { kind: "const".into(), name, line: lineno });
            }
        }
    }
    Ok(nodes)
}

fn strip_prefix_word(s: &str, prefixes: &[&str]) -> Option<String> {
    for p in prefixes {
        if let Some(rest) = s.strip_prefix(p) {
            // Take identifier characters until ( < : space {
            let name: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
                .collect();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct CliDetectResult {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

/// Detect a CLI binary on PATH and grab its version string. Used by the
/// onboarding flow to show real "installed / not installed" state for
/// claude / codex / gemini / gh / etc. instead of optimistic placeholders.
#[tauri::command]
pub async fn cli_detect(name: String) -> Result<CliDetectResult, String> {
    let which_out = std::process::Command::new("which")
        .arg(&name)
        .output()
        .map_err(|e| e.to_string())?;
    if !which_out.status.success() {
        return Ok(CliDetectResult {
            installed: false,
            path: None,
            version: None,
        });
    }
    let path = String::from_utf8_lossy(&which_out.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(CliDetectResult {
            installed: false,
            path: None,
            version: None,
        });
    }
    // Best-effort version grab. Different CLIs prefer different flags,
    // so try --version first then fall back to -v. Cap the output at
    // the first non-empty line — `gh --version` prints a banner.
    let version = std::process::Command::new(&path)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| {
            if !o.status.success() {
                return None;
            }
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .find(|l| !l.trim().is_empty())
                .map(|l| l.trim().to_string())
        });
    Ok(CliDetectResult {
        installed: true,
        path: Some(path),
        version,
    })
}

#[cfg(test)]
mod perf_smoke {
    //! Stage 1 perf gate. Generates synthetic load (50k intent rows, 20k
    //! snapshot files) in a tempdir and asserts the paginated v2
    //! endpoints stay under their budgets:
    //!
    //!   * `aura_read_intent_log_v2(limit=200)`     — 100ms
    //!   * `aura_count_intents_today`              — 150ms
    //!   * `aura_list_snapshots_v2(limit=200)`      — 200ms
    //!   * `aura_count_snapshots_today`            — 200ms
    //!
    //! Budgets are wide (10× expected) so this test serves as a
    //! regression *floor* against accidental O(N) work creeping back
    //! into the hot path, not a microbench. Set `AURA_SMOKE=1` to enable.
    use super::*;
    use std::time::Instant;

    fn gate() -> bool {
        std::env::var("AURA_SMOKE").map(|v| v == "1").unwrap_or(false)
    }

    fn build_load(root: &std::path::Path, intents: usize, snaps: usize) {
        let aura = root.join(".aura");
        std::fs::create_dir_all(&aura).unwrap();
        let snap_root = aura.join("snapshots");

        // Intent log — JSONL, one entry per line. Mix two agents so the
        // agent-filter path also has work to do.
        let log = aura.join("intent_log.jsonl");
        let mut s = String::with_capacity(intents * 96);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        for i in 0..intents {
            let ts = now - (i as i64);
            let agent = if i % 2 == 0 { "claude" } else { "gemini" };
            s.push_str(&format!(
                "{{\"id\":\"i{i}\",\"agent\":\"{agent}\",\"intent\":\"row {i}\",\"timestamp\":{ts}}}\n",
            ));
        }
        std::fs::write(&log, s).unwrap();

        // Snapshot tree — sharded under a few day-folders to mimic real
        // layout (`<repo>/.aura/snapshots/<yyyymmdd>/<file>.json`). Skip
        // disk if zero requested — keeps cheap tests cheap.
        if snaps > 0 {
            for shard in 0..16 {
                std::fs::create_dir_all(snap_root.join(format!("d{shard:02}"))).unwrap();
            }
            for i in 0..snaps {
                let shard = i % 16;
                let p = snap_root
                    .join(format!("d{shard:02}"))
                    .join(format!("snap_{i}.json"));
                std::fs::write(&p, b"{}").unwrap();
            }
        }
    }

    #[tokio::test]
    async fn page_50k_intents_under_budget() {
        if !gate() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        build_load(dir.path(), 50_000, 0);
        let root = dir.path().to_string_lossy().to_string();

        let t0 = Instant::now();
        let page = super::aura_read_intent_log_v2(root.clone(), 200, None, None)
            .await
            .unwrap();
        let elapsed = t0.elapsed();
        eprintln!("intent_log_v2(200) over 50k rows: {elapsed:?}");
        assert_eq!(page.entries.len(), 200);
        assert!(page.has_more);
        assert!(elapsed.as_millis() < 100, "first page > 100ms: {elapsed:?}");

        // Filtered page — agent="claude" still bounded.
        let t1 = Instant::now();
        let p2 = super::aura_read_intent_log_v2(
            root.clone(),
            200,
            None,
            Some("claude".to_string()),
        )
        .await
        .unwrap();
        let e1 = t1.elapsed();
        eprintln!("intent_log_v2(200, agent=claude) over 50k rows: {e1:?}");
        assert_eq!(p2.entries.len(), 200);
        assert!(e1.as_millis() < 100, "filtered page > 100ms: {e1:?}");

        // Count path.
        let t2 = Instant::now();
        let n = super::aura_count_intents_today(root.clone(), None, Some(0))
            .await
            .unwrap();
        let e2 = t2.elapsed();
        eprintln!("count_intents (since=0) over 50k rows: {e2:?} -> {n}");
        assert_eq!(n, 50_000);
        assert!(e2.as_millis() < 150, "count > 150ms: {e2:?}");
    }

    #[tokio::test]
    async fn page_20k_snapshots_under_budget() {
        if !gate() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        build_load(dir.path(), 0, 20_000);
        let root = dir.path().to_string_lossy().to_string();

        let t0 = Instant::now();
        let page = super::aura_list_snapshots_v2(root.clone(), 200, None)
            .await
            .unwrap();
        let elapsed = t0.elapsed();
        eprintln!("list_snapshots_v2(200) over 20k files: {elapsed:?}");
        assert_eq!(page.entries.len(), 200);
        assert!(page.has_more);
        assert!(elapsed.as_millis() < 200, "snap page > 200ms: {elapsed:?}");

        let t1 = Instant::now();
        let n = super::aura_count_snapshots_today(root.clone(), Some(0))
            .await
            .unwrap();
        let e1 = t1.elapsed();
        eprintln!("count_snapshots (since=0) over 20k files: {e1:?} -> {n}");
        assert_eq!(n, 20_000);
        assert!(e1.as_millis() < 200, "snap count > 200ms: {e1:?}");
    }
}

#[cfg(test)]
mod resolve_impact_tests {
    //! Behaviour gate for `aura_resolve_impact`: flips `resolved:true`
    //! on the matched id, leaves siblings untouched, no-ops cleanly when
    //! the id is missing or the file doesn't exist.
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_log(root: &std::path::Path, lines: &[&str]) {
        let aura = root.join(".aura");
        std::fs::create_dir_all(&aura).unwrap();
        let p = aura.join("impacts.jsonl");
        let mut f = std::fs::File::create(p).unwrap();
        for line in lines {
            writeln!(f, "{}", line).unwrap();
        }
    }

    fn read_log(root: &std::path::Path) -> Vec<ImpactAlert> {
        let p = root.join(".aura").join("impacts.jsonl");
        let body = std::fs::read_to_string(&p).unwrap();
        body.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<ImpactAlert>(l).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn flips_matched_id_only() {
        let dir = tempdir().unwrap();
        write_log(
            dir.path(),
            &[
                r#"{"id":"a","severity":"high","function":"foo","resolved":false,"timestamp":1}"#,
                r#"{"id":"b","severity":"low","function":"bar","resolved":false,"timestamp":2}"#,
            ],
        );
        super::aura_resolve_impact(
            dir.path().to_string_lossy().into_owned(),
            "a".into(),
        )
        .await
        .unwrap();
        let after = read_log(dir.path());
        assert_eq!(after.len(), 2);
        assert_eq!(after[0].id, "a");
        assert!(after[0].resolved, "matched id should flip");
        assert_eq!(after[1].id, "b");
        assert!(!after[1].resolved, "sibling id should stay false");
    }

    #[tokio::test]
    async fn missing_id_is_noop() {
        let dir = tempdir().unwrap();
        let original =
            r#"{"id":"a","severity":"high","function":"foo","resolved":false,"timestamp":1}"#;
        write_log(dir.path(), &[original]);
        super::aura_resolve_impact(
            dir.path().to_string_lossy().into_owned(),
            "nonexistent".into(),
        )
        .await
        .unwrap();
        let body = std::fs::read_to_string(dir.path().join(".aura/impacts.jsonl")).unwrap();
        assert!(body.contains(r#""resolved":false"#));
    }

    #[tokio::test]
    async fn missing_file_is_noop() {
        let dir = tempdir().unwrap();
        super::aura_resolve_impact(
            dir.path().to_string_lossy().into_owned(),
            "a".into(),
        )
        .await
        .unwrap();
        // No impacts.jsonl created — confirm we didn't crash.
        assert!(!dir.path().join(".aura/impacts.jsonl").exists());
    }
}
