//! Lanes — Aura's built-in answer to "run two coding agents in parallel
//! without hand-rolling a worktree or switching branches".
//!
//! When the user launches a new agent, Aura transparently provisions an
//! isolated *lane*: an Aura-managed worktree on an auto-named `lane/*`
//! branch, with the agent's PTY opened with `cwd = lane_path`. Each lane
//! gets its own working tree, index, HEAD and cwd, so two Claude Code /
//! Gemini / Codex sessions never stomp each other's checkout. The user
//! never has to think about `git worktree add` or branch-switching.
//!
//! ## Isolation matrix (the whole point)
//!
//! Each lane **ISOLATES**:
//!   - working tree (its own checkout under `~/.aura/worktrees/<id>/`)
//!   - index / staging area (per-worktree, automatic with git worktrees)
//!   - HEAD (its own `lane/*` branch tip)
//!   - cwd (the agent PTY is spawned with `cwd = lane_path`, so the
//!     session dedup key `{agent}@{lane_path}` differs from the main
//!     checkout's `{agent}@{repo_root}` — the two sessions can't collide)
//!   - any per-runtime `.aura-runtime` scratch state (lives under the
//!     worktree, not the shared repo)
//!
//! Each lane **SHARES** (deliberately — do NOT isolate these):
//!   - the `.git` object DB (automatic with worktrees — commits made in a
//!     lane are visible to every other lane and the main checkout)
//!   - the git-tracked meaning/memory layer: `.aura/intent_log.jsonl`,
//!     `.aura/memory.json`, `.aura/goals.jsonl`. These live in git, so a
//!     fresh worktree checks them out at the branch's committed state and
//!     every lane sees the same meaning/memory history. We do NOT copy
//!     them per-lane and we do NOT gitignore-isolate them.
//!
//! ## Lanes W2–W5 (roadmap — explicitly out of scope for this pass)
//!   - W2: AST 3-way merge-back of a lane into its base via `aura-merge`.
//!   - W3: radar collision warnings across lanes (same symbol in flight
//!         in two lanes at once).
//!   - W4: popout / daemon survival (lane PTYs hosted by aura-pty-daemon
//!         so a shell crash doesn't kill the lane's agent).
//!   - W5: goals continuity (a lane inherits + reports against the goal
//!         that spawned it).

use serde::Serialize;
use tauri::{AppHandle, State};
use uuid::Uuid;

use aura_loop::worktree_name;

use crate::cmd_agent_pty::{agent_pty_open, AgentPtyRegistry};
use crate::worktree::{create_managed_worktree, remove_managed_worktree, resolve_start_point};

/// Prefix every lane branch carries. `lane_list` filters worktrees by
/// this so only Aura-provisioned lanes (not the user's own feature
/// worktrees) show up in the switcher.
const LANE_BRANCH_PREFIX: &str = "lane/";

/// One isolated lane, as surfaced to the frontend LaneSwitcher. Serialised
/// camelCase so the TS `Lane` type reads naturally.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lane {
    /// Stable id for the lane — the auto-named branch doubles as the id
    /// (it's unique by construction and survives a shell restart, so the
    /// frontend can address a lane across reloads without extra state).
    pub id: String,
    /// The auto-named branch this lane lives on: `lane/{agent}/{label-slug}`
    /// when the lane was labelled, else `lane/{agent}-{uuid8}`.
    pub branch: String,
    /// Absolute path to the lane's worktree (the agent PTY's cwd).
    pub path: String,
    /// Agent CLI id the lane was spawned for (`claude`, `gemini`, …).
    pub agent: String,
    /// The agent PTY session id (`agent_pty_open`'s handle id) when this
    /// lane has a live session, else `None` (e.g. a lane enumerated after
    /// a shell restart whose PTY child is gone — the worktree survives,
    /// the session doesn't).
    pub term_id: Option<String>,
    /// Optional human label the user gave the lane ("auth refactor").
    pub label: Option<String>,
}

/// Outcome of `lane_discard`. `Discarded` when the worktree was torn down;
/// `Dirty` when the lane has uncommitted work and `force` wasn't set — the
/// UI surfaces this as "This lane has unsaved work — discard anyway?"
/// rather than silently deleting the user's in-flight changes.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiscardResult {
    /// The lane's worktree (and its `lane/*` branch) were removed.
    Discarded,
    /// The lane has uncommitted changes; nothing was removed. Re-call with
    /// `force = true` to discard anyway. `changed_files` is a small count
    /// the UI can show ("3 files with unsaved work").
    Dirty { changed_files: usize },
}

/// Name a fresh lane branch after the work it is for: `lane/{agent}/{slug}`,
/// where the slug is what the user called this lane ("auth refactor" →
/// `lane/claude/auth-refactor`). A lane the user didn't label has nothing to
/// be named after, so it keeps the old `lane/{agent}-{uuid8}` shape — a
/// readable, unique placeholder rather than an invented description.
///
/// `taken` answers "is this branch already there", so a second "auth
/// refactor" becomes `auth-refactor-2` instead of failing the worktree add.
/// The agent stays its own path segment: agent ids contain dashes
/// (`cursor-agent`) and so do slugs, so a `/` is the only separator
/// [`lane_agent_from_branch`] can split on without guessing.
pub fn lane_branch(agent: &str, label: Option<&str>, taken: impl Fn(&str) -> bool) -> String {
    match label.and_then(worktree_name::from_label) {
        Some(base) => {
            let head = format!("{LANE_BRANCH_PREFIX}{agent}/");
            let slug = worktree_name::unique(&base, |c| taken(&format!("{head}{c}")));
            format!("{head}{slug}")
        }
        None => auto_lane_branch(agent),
    }
}

/// The un-labelled lane name: `lane/{agent}-{uuid8}`. The 8-char uuid slice
/// keeps it short enough to read in the UI while staying unique in practice
/// (collision odds are negligible and `create_managed_worktree` rejects a
/// path that already exists, so a freak collision fails loudly rather than
/// silently reusing a lane).
pub fn auto_lane_branch(agent: &str) -> String {
    let id = Uuid::new_v4().simple().to_string();
    format!("{LANE_BRANCH_PREFIX}{agent}-{}", &id[..8])
}

/// Does `refs/heads/<branch>` already exist in `repo_root`? Best-effort — a
/// git failure reads as "no" and leaves the real complaint to the worktree
/// add, which is the layer that can actually explain it.
fn branch_exists(repo_root: &str, branch: &str) -> bool {
    std::process::Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])
        .current_dir(repo_root)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Count uncommitted changes in a worktree via `git status --porcelain`.
/// Returns the number of changed (staged or unstaged, tracked or
/// untracked) entries. A clean tree → 0. Any git failure → Err so the
/// caller refuses to discard on an indeterminate state rather than
/// nuking work it couldn't verify was safe.
fn count_dirty(worktree_path: &str) -> Result<usize, String> {
    let out = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| format!("git status in {worktree_path}: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let body = String::from_utf8_lossy(&out.stdout);
    Ok(body.lines().filter(|l| !l.trim().is_empty()).count())
}

/// Enumerate the worktrees of `repo_root` via `git worktree list
/// --porcelain` and return only the ones on a `lane/*` branch, paired
/// with the agent id parsed out of the branch name. Best-effort: a git
/// failure yields an empty list (the switcher just shows no lanes).
///
/// Returns `(lane_path, branch, agent)` triples.
fn enumerate_lane_worktrees(repo_root: &str) -> Vec<(String, String, String)> {
    let Ok(out) = std::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_root)
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let body = String::from_utf8_lossy(&out.stdout);
    let mut out_lanes = Vec::new();
    let mut cur_path: Option<String> = None;
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            cur_path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("branch ") {
            let branch = rest.strip_prefix("refs/heads/").unwrap_or(rest).to_string();
            if let Some(path) = cur_path.take() {
                if let Some(agent) = lane_agent_from_branch(&branch) {
                    out_lanes.push((path, branch, agent));
                }
            }
        } else if line.trim().is_empty() {
            // Blank line ends a worktree stanza; reset so a detached or
            // branch-less worktree doesn't bind a later stanza's branch.
            cur_path = None;
        }
    }
    out_lanes
}

/// Parse the agent id out of a lane branch — `lane/{agent}/{slug}` for a
/// named lane, `lane/{agent}-{uuid8}` for an un-named one. Returns `None`
/// when the branch isn't a lane branch at all.
fn lane_agent_from_branch(branch: &str) -> Option<String> {
    let rest = branch.strip_prefix(LANE_BRANCH_PREFIX)?;
    // A named lane keeps the agent in its own path segment, so the split is
    // exact — no guessing where a dashed agent id ends and the name begins.
    if let Some((agent, _slug)) = rest.split_once('/') {
        if !agent.is_empty() {
            return Some(agent.to_string());
        }
    }
    // Un-named lane: strip the trailing `-{uuid8}` to recover the agent id.
    // Agents can themselves contain a `-` (e.g. `cursor-agent`), so we split
    // off only the LAST `-` segment and treat the head as the agent.
    match rest.rsplit_once('-') {
        Some((agent, _uuid)) if !agent.is_empty() => Some(agent.to_string()),
        // No separator at all → the whole tail is the agent (defensive; our
        // own naming always appends `-{uuid8}` or a `/{slug}`).
        _ => Some(rest.to_string()),
    }
}

// ── tauri commands ──────────────────────────────────────────────────────

/// Spawn a fresh lane: create a managed worktree on a branch named after
/// what the lane is for (`lane/{agent}/{label-slug}`, or
/// `lane/{agent}-{uuid8}` when the user gave it no label) off `repo_root`'s
/// HEAD, then open the agent's PTY with `cwd = lane_path` so the session is
/// fully isolated from the main checkout (different working tree, index,
/// HEAD, cwd, and PTY dedup key). Returns the `Lane` descriptor the frontend
/// tracks.
#[tauri::command]
pub async fn lane_spawn(
    app: AppHandle,
    state: State<'_, AgentPtyRegistry>,
    repo_root: String,
    agent: String,
    label: Option<String>,
) -> Result<Lane, String> {
    // Name the lane after the work, not after a uuid: the label is the one
    // thing anyone can read in the switcher, and it is already here.
    let branch = lane_branch(&agent, label.as_deref(), |b| branch_exists(&repo_root, b));

    // Branch off the current HEAD of the main checkout — a lane starts
    // from wherever the user is, so its first commit threads cleanly back.
    let start = resolve_start_point(&repo_root, "HEAD")?;
    let worktree = create_managed_worktree(&repo_root, &branch, &start)?;

    // Default PTY geometry matches the agent surface's first-paint size;
    // the frontend re-fits via `agent_pty_resize` once the pane mounts.
    let cols: u16 = 120;
    let rows: u16 = 32;

    // Open the agent PTY *inside the lane*. Passing the lane path as the
    // `repo_root` arg is what isolates the session: `agent_pty_open` sets
    // `cwd(&repo_root)` on the child and derives its dedup key from it, so
    // `{agent}@{lane_path}` never collides with the main checkout's
    // `{agent}@{repo_root}`. `force_new = false` is safe — the lane path is
    // brand new so the key can't pre-exist; a retry of a half-failed spawn
    // re-attaches the live session, which is exactly right.
    let handle = match agent_pty_open(
        app.clone(),
        state.clone(),
        agent.clone(),
        worktree.path.clone(),
        cols,
        rows,
        None,
        Some(false),
        None,
        // Lane spawns run under the default permission policy — no Approvals
        // override here, so the spawn stays byte-identical to pre-feature.
        None,
        // No per-lane model/effort override — keep the agent on its default.
        None,
        None,
        // A lane is a worktree, and a worktree is a directory on this laptop.
        // The agent's hands have to be where its files are.
        None,
    )
    .await
    {
        Ok(h) => h,
        Err(e) => {
            // The PTY failed to spawn — roll the worktree back so we don't
            // leak a half-built lane the user can't see an agent in.
            let _ = remove_managed_worktree(&repo_root, &worktree.path);
            return Err(format!("spawn {agent} in lane: {e}"));
        }
    };

    Ok(Lane {
        id: branch.clone(),
        branch,
        path: worktree.path,
        agent,
        term_id: Some(handle.id),
        label,
    })
}

/// List active lanes for `repo_root`: every managed worktree on a
/// `lane/*` branch, joined with any live agent PTY session whose cwd is
/// that lane (so `term_id` is populated when the lane's agent is still
/// running, `None` when only the worktree survives — e.g. after a shell
/// restart that dropped the PTY child).
#[tauri::command]
pub async fn lane_list(
    state: State<'_, AgentPtyRegistry>,
    repo_root: String,
) -> Result<Vec<Lane>, String> {
    let mut lanes = Vec::new();
    let worktrees =
        crate::blocking::run(move || enumerate_lane_worktrees(&repo_root)).await;
    for (path, branch, agent) in worktrees {
        // A live PTY session opened in this lane reports `repo_root ==
        // lane_path` (that's what we passed as the cwd at spawn). Pick the
        // most-recently-active matching session's id for `term_id`.
        let term_id = state
            .list_in(&path)
            .into_iter()
            .find(|s| s.agent_id == agent)
            .map(|s| s.session_id)
            // Fall back to any agent in the lane if the branch's parsed
            // agent and the live session's agent disagree (e.g. the user
            // started a second agent kind inside the lane manually).
            .or_else(|| state.list_in(&path).into_iter().next().map(|s| s.session_id));
        lanes.push(Lane {
            id: branch.clone(),
            branch,
            path,
            agent,
            term_id,
            label: None,
        });
    }
    Ok(lanes)
}

/// Tear down a lane: close its live agent PTY (if any), then remove the
/// worktree and delete its `lane/*` branch.
///
/// **Dirty-guard**: if the lane's worktree has uncommitted changes and
/// `force` is false, nothing is removed — `DiscardResult::Dirty` comes
/// back so the UI can ask "This lane has unsaved work — discard anyway?".
/// Pass `force = true` to discard regardless.
///
/// `lane_id` is the lane's branch name (the `Lane.id` the frontend holds).
#[tauri::command]
pub async fn lane_discard(
    state: State<'_, AgentPtyRegistry>,
    repo_root: String,
    lane_id: String,
    force: bool,
) -> Result<DiscardResult, String> {
    // Resolve the lane's worktree path from its branch. We re-enumerate
    // rather than trust a frontend-supplied path so discard can't be
    // pointed at an arbitrary directory.
    let inspect_root = repo_root.clone();
    let lane = crate::blocking::run(move || -> Result<Option<(String, String, usize)>, String> {
        let lane = enumerate_lane_worktrees(&inspect_root)
            .into_iter()
            .find(|(_, branch, _)| branch == &lane_id);
        let Some((path, branch, _agent)) = lane else {
            return Ok(None);
        };

        let dirty = if force { 0 } else { count_dirty(&path)? };
        Ok(Some((path, branch, dirty)))
    })
    .await?;
    let Some((path, branch, dirty)) = lane else {
        // Unknown lane — treat as already-gone so the UI's optimistic
        // removal isn't blocked by a stale entry.
        return Ok(DiscardResult::Discarded);
    };

    // Dirty-guard. Refuse to delete in-flight work unless forced.
    if dirty > 0 {
        return Ok(DiscardResult::Dirty {
            changed_files: dirty,
        });
    }

    // Close any live agent PTY session running in this lane so we don't
    // tear the worktree out from under a running child. Best-effort —
    // a missing/dead session is fine, the worktree removal is what
    // matters.
    let sessions = state.list_in(&path);
    for sess in sessions {
        let _ = crate::cmd_agent_pty::agent_pty_close(state.clone(), sess.session_id).await;
    }

    crate::blocking::run(move || {
        // Remove the worktree (atomic rename + detached rm). This frees the
        // branch's worktree lock so the branch delete below can succeed.
        remove_managed_worktree(&repo_root, &path)?;

        // Delete the lane branch. `-D` (force) because a lane branch is never
        // meant to outlive its lane — the user discarding the lane is the
        // explicit signal that its commits (if any) aren't wanted here.
        // Best-effort: a missing branch (already pruned) isn't an error worth
        // failing the discard over.
        let _ = std::process::Command::new("git")
            .args(["branch", "-D", &branch])
            .current_dir(&repo_root)
            .output();

        Ok(DiscardResult::Discarded)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_lane_branch_has_prefix_and_agent() {
        let b = auto_lane_branch("claude");
        assert!(b.starts_with("lane/claude-"), "got {b}");
        // `lane/claude-` + 8 hex chars.
        assert_eq!(b.len(), "lane/claude-".len() + 8);
    }

    #[test]
    fn auto_lane_branch_is_unique() {
        let a = auto_lane_branch("gemini");
        let b = auto_lane_branch("gemini");
        assert_ne!(a, b, "two lanes must not collide");
    }

    #[test]
    fn lane_branch_is_named_after_the_label() {
        assert_eq!(
            lane_branch("claude", Some("auth refactor"), |_| false),
            "lane/claude/auth-refactor"
        );
        // A dashed agent id keeps its own segment, so the name can't eat it.
        assert_eq!(
            lane_branch("cursor-agent", Some("Fix the login bug!"), |_| false),
            "lane/cursor-agent/fix-the-login-bug"
        );
        // Branch-flow prefixes say nothing about the work.
        assert_eq!(
            lane_branch("claude", Some("feat/worktree-control-plane"), |_| false),
            "lane/claude/worktree-control-plane"
        );
    }

    #[test]
    fn lane_branch_suffixes_a_taken_label() {
        let taken = |b: &str| b == "lane/claude/auth-refactor";
        assert_eq!(
            lane_branch("claude", Some("auth refactor"), taken),
            "lane/claude/auth-refactor-2"
        );
    }

    #[test]
    fn lane_branch_without_a_usable_label_falls_back_to_the_uuid_shape() {
        // Nothing to name it after → the readable placeholder, never an
        // invented description.
        for label in [None, Some(""), Some("   "), Some("★★★")] {
            let b = lane_branch("claude", label, |_| false);
            assert!(b.starts_with("lane/claude-"), "got {b}");
            assert_eq!(b.len(), "lane/claude-".len() + 8);
        }
    }

    #[test]
    fn parses_agent_from_a_named_lane_branch() {
        assert_eq!(
            lane_agent_from_branch("lane/claude/auth-refactor").as_deref(),
            Some("claude")
        );
        // The dashed agent id survives because it has its own segment.
        assert_eq!(
            lane_agent_from_branch("lane/cursor-agent/fix-the-login-bug").as_deref(),
            Some("cursor-agent")
        );
    }

    #[test]
    fn parses_agent_from_lane_branch() {
        assert_eq!(
            lane_agent_from_branch("lane/claude-ab12ef34").as_deref(),
            Some("claude")
        );
        // Agents with their own dash survive (only the LAST segment is the
        // uuid).
        assert_eq!(
            lane_agent_from_branch("lane/cursor-agent-deadbeef").as_deref(),
            Some("cursor-agent")
        );
    }

    #[test]
    fn non_lane_branch_yields_none() {
        assert_eq!(lane_agent_from_branch("feat/foo"), None);
        assert_eq!(lane_agent_from_branch("main"), None);
    }
}
