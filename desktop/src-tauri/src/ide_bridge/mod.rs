//! Aura as an IDE that coding-agent CLIs can drive.
//!
//! # Why this exists
//!
//! An agent running in an Aura tab could only ever write text at you. It had
//! no way to say "here is the change I want to make, look at it" — so review
//! happened in a terminal scrollback instead of in the editor.
//!
//! Claude Code already knows how to talk to an editor, and the way it does it
//! is not VS Code-specific: on startup it scans `~/.claude/ide/` for `*.lock`
//! files, each describing a local MCP server, and connects to the one whose
//! project matches. Nothing in that says "VS Code". So the whole job is to
//! *be* one of those servers. That is this module:
//!
//! ```text
//!   ~/.claude/ide/<port>.lock   ← we publish (discovery)
//!   ws://127.0.0.1:<port>       ← we serve, MCP over WebSocket (control)
//!   ide-bridge:request event    ← we ask React, because tabs live there
//! ```
//!
//! # Layout
//!
//! * [`protocol`] — the wire shapes and the tool catalog. No I/O, so the
//!   handshake can be asserted in unit tests instead of by launching a CLI.
//! * [`lockfile`] — publishing and retracting the discovery file.
//! * [`bridge`] — the Rust↔React round-trip (pending map, auth token).
//! * [`server`] — the socket and the MCP dispatcher.
//!
//! # Trust
//!
//! The listener is loopback-only on an OS-assigned port, and every upgrade
//! must present the token from the lock file. The lock file is `0600`, so on
//! a shared machine another account can see that Aura is running but cannot
//! read the token, and therefore cannot drive your tabs.

mod bridge;
mod lockfile;
mod protocol;
mod server;

pub use bridge::{IdeBridgeState, Running};

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

/// How often the advertised project list is re-checked.
///
/// `workspaceFolders` is how a CLI that Aura did *not* spawn (someone typing
/// `claude` in a stock terminal, then `/ide`) decides this lock belongs to
/// the repo they are in. Opening a new project has to show up there, and
/// nothing in the project registry pushes a change event, so we look.
const WORKSPACE_POLL: Duration = Duration::from_secs(30);

/// Publish this Aura instance and start serving. Called once from `setup`.
///
/// Ordering is load-bearing: bind → publish the token → advertise → accept.
/// Advertising before the token is live would hand out a port that rejects
/// the very credential it just published.
pub async fn start(app: AppHandle, bridge: Arc<IdeBridgeState>) -> Result<u16, String> {
    let (listener, port) = server::bind().await?;

    // 122 bits of randomness, never derived from anything guessable like the
    // port or the pid — those are both readable by any local process.
    let token = uuid::Uuid::new_v4().to_string();
    let roots = crate::cmd_projects::registered_roots();

    bridge.set_running(Running {
        port,
        auth_token: token.clone(),
        lock_path: lockfile::lock_path(port),
    });

    let lock_path =
        lockfile::write(port, &roots, &token).map_err(|e| format!("write ide lock: {e}"))?;

    server::serve(listener, app, bridge.clone());
    spawn_workspace_watcher(bridge, roots);

    tracing::info!("ide bridge listening on 127.0.0.1:{port} ({})", lock_path.display());
    Ok(port)
}

/// Keep the advertised project list honest as the person opens and closes
/// projects. Rewrites only on an actual change, so this is a cheap read of a
/// small JSON file twice a minute and nothing else.
fn spawn_workspace_watcher(bridge: Arc<IdeBridgeState>, initial: Vec<String>) {
    tokio::spawn(async move {
        let mut last = initial;
        loop {
            tokio::time::sleep(WORKSPACE_POLL).await;
            let Some(running) = bridge.running() else {
                continue;
            };
            let roots = crate::cmd_projects::registered_roots();
            if roots == last {
                continue;
            }
            if let Err(e) = lockfile::rewrite(&running.lock_path, &roots, &running.auth_token) {
                tracing::debug!("ide bridge: could not refresh lock file: {e}");
                continue;
            }
            last = roots;
        }
    });
}

/// Stop advertising. Called on quit — a lock file left behind points agents
/// at a port nothing is listening on until the CLI's own reaper notices the
/// pid is dead.
pub fn shutdown(app: &AppHandle) {
    if let Some(bridge) = app.try_state::<Arc<IdeBridgeState>>() {
        if let Some(running) = bridge.running() {
            lockfile::remove_at(&running.lock_path);
        }
    }
}

/// What an agent CLI would find. Surfaced so the app can show "agents can
/// drive your tabs" honestly rather than asserting it.
#[tauri::command]
pub fn ide_bridge_status(bridge: State<'_, Arc<IdeBridgeState>>) -> Value {
    match bridge.running() {
        Some(r) => json!({
            "running": true,
            "port": r.port,
            "lockPath": r.lock_path.to_string_lossy(),
        }),
        None => json!({ "running": false }),
    }
}

/// React answering one `ide-bridge:request`.
///
/// Returns whether the answer landed. `false` means nothing was waiting —
/// already answered, or the agent gave up — which the caller treats as
/// "fine, drop it" rather than an error, because a person closing a diff tab
/// twice is not a fault.
#[tauri::command]
pub fn ide_bridge_respond(
    bridge: State<'_, Arc<IdeBridgeState>>,
    request_id: String,
    reply: Value,
) -> bool {
    bridge.resolve(&request_id, reply)
}
