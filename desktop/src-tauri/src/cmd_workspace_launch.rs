// Parity W8 — the launch manifest: one command that provisions a managed
// worktree AND spawns the requested coding-agent PTYs inside it, returning
// every session id in a single round-trip.
//
// Why one command instead of the frontend chaining `worktree_create_managed`
// + N × `agent_pty_open`: the chain has a half-built failure mode (worktree
// exists, agents never spawned, UI forgot why) and each hop pays IPC + state
// re-validation. Here the worktree create is the only hard gate — agent
// spawns are best-effort and report per-agent errors in the manifest so the
// caller can render "worktree ready, gemini failed to spawn" instead of an
// all-or-nothing error.
//
// The frontend glue (`workspaceCreateStore.launchWorkspace`) drives the
// optimistic in-flight tile from this command's lifecycle: request sent →
// "creating", manifest returned → "spawning"/"ready", Err(...) → "error".

use tauri::{AppHandle, State};

use crate::cmd_agent_pty::{agent_pty_open, AgentPtyRegistry, AgentSessionHandle};
use crate::worktree::{
    create_managed_worktree, is_git_work_tree, project_id_for, resolve_start_point,
    ManagedWorktree,
};

/// One agent to spawn inside the freshly created worktree.
#[derive(Debug, serde::Deserialize)]
pub struct LaunchAgentSpec {
    /// Agent CLI id — `claude`, `gemini`, `codex`, … (same ids
    /// `agent_pty_open` accepts).
    pub agent_id: String,
    /// Optional named agent profile (~/.aura/agent-profiles/<name>/) so a
    /// launched fleet can run under isolated logins. Passed through to
    /// `agent_pty_open` untouched.
    #[serde(default)]
    pub profile_name: Option<String>,
    /// Model id this agent's CLI launches on (`claude --model`, `gemini -m`,
    /// …) — the launch composer's model picker. `None` → the agent's own
    /// configured default (no flag added). Passed through to `agent_pty_open`.
    #[serde(default)]
    pub model: Option<String>,
    /// Cross-agent reasoning effort for this agent (`"low"`/`"medium"`/
    /// `"high"`/`"max"`) — the launch composer's effort chip. `None` → the
    /// provider default. Passed through to `agent_pty_open`.
    #[serde(default)]
    pub effort: Option<String>,
}

/// What the launch produced. `sessions` and `errors` are parallel outcomes:
/// every requested agent lands in exactly one of the two. The worktree is
/// always present — its creation failing fails the whole command instead.
// No Debug derive — `AgentSessionHandle` doesn't implement it and this
// struct only travels over the IPC boundary as JSON.
#[derive(serde::Serialize)]
pub struct WorkspaceLaunchManifest {
    pub worktree: ManagedWorktree,
    pub sessions: Vec<AgentSessionHandle>,
    /// Per-agent spawn failures, formatted `"<agent_id>: <error>"`. Empty
    /// when every spawn succeeded.
    pub errors: Vec<String>,
}

/// Create a managed worktree for `branch` off `start_raw` and spawn each
/// requested agent PTY inside it. Worktree failure → Err (nothing was
/// created — `create_managed_worktree` rolls back internally). Agent spawn
/// failures are collected per-agent so a partial fleet still launches.
#[tauri::command]
pub async fn workspace_launch(
    app: AppHandle,
    state: State<'_, AgentPtyRegistry>,
    repo_root: String,
    branch: String,
    start_raw: String,
    agents: Vec<LaunchAgentSpec>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<WorkspaceLaunchManifest, String> {
    // A project folder doesn't have to be a git repo — that's fine. When it is
    // one we provision an isolated managed worktree (a fresh copy on its own
    // branch); when it isn't, there's nothing to branch off, so we run the
    // agent in the folder itself. Either way the caller gets a manifest whose
    // `worktree.path` is where the agents are spawned, so the frontend contract
    // (place tabs from `sessions`, point the in-flight tile at `worktree.path`)
    // is identical for both.
    let worktree = if is_git_work_tree(&repo_root) {
        let start = resolve_start_point(&repo_root, &start_raw)?;
        create_managed_worktree(&repo_root, &branch, &start)?
    } else {
        ManagedWorktree {
            project_id: project_id_for(&repo_root),
            branch: String::new(),
            path: repo_root.clone(),
            start_point: String::new(),
        }
    };

    // Default PTY geometry matches the agent surface's first-paint size;
    // the frontend re-fits via `agent_pty_resize` as soon as the pane
    // mounts, so this only matters for the agent's very first lines.
    let cols = cols.unwrap_or(120);
    let rows = rows.unwrap_or(32);

    let mut sessions: Vec<AgentSessionHandle> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for spec in agents {
        // force_new = false: the worktree path is brand new, so the dedup
        // key can't collide — but if a caller retries a half-failed launch,
        // re-attaching the already-live session is exactly right.
        match agent_pty_open(
            app.clone(),
            state.clone(),
            spec.agent_id.clone(),
            worktree.path.clone(),
            cols,
            rows,
            None,
            Some(false),
            spec.profile_name.clone(),
            // Workspace launches use the default permission policy — the
            // per-turn Approvals override only applies to the composer.
            None,
            // Model + effort from the launch composer ride into the agent's
            // CLI spawn (`claude --model` / reasoning-effort), so the picks
            // aren't dropped. `None` on either → the agent's own default.
            spec.model.clone(),
            spec.effort.clone(),
        )
        .await
        {
            Ok(handle) => sessions.push(handle),
            Err(e) => errors.push(format!("{}: {e}", spec.agent_id)),
        }
    }

    Ok(WorkspaceLaunchManifest {
        worktree,
        sessions,
        errors,
    })
}
