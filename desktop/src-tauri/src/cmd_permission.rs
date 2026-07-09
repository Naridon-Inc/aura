//! Permission-prompt bridge between aura-shell-mcp (the Rust binary
//! claude spawns to host the `permission_prompt` MCP tool) and the
//! React UI.
//!
//! Flow per prompt:
//!   1. claude calls the MCP tool with `{tool_name, input}`.
//!   2. The MCP shim opens a UNIX socket connection to aura-shell and
//!      sends a JSON envelope: `{prompt_id, channel, tool_name, input}`.
//!   3. We park the connection in `pending`, emit `permission:prompt`
//!      to the React side, and wait on a oneshot channel for the user's
//!      decision.
//!   4. React renders a blocking card; user clicks Allow/Deny/Always.
//!   5. `permission_respond` resolves the oneshot — the socket task
//!      writes the response back to the shim and closes the connection.
//!   6. The shim returns the MCP `tools/call` response to claude, which
//!      proceeds (or refuses) the underlying tool call.
//!
//! The socket lives in `~/.aura/run/aura-shell-mcp.sock` (macOS/Linux).
//! Windows gets a TCP loopback fallback — same JSON envelope, just
//! transported via TCP since AF_UNIX support there is patchy.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    Allow,
    AllowAlways,
    Deny,
}

#[derive(Clone, Debug, Serialize)]
pub struct PendingPrompt {
    pub prompt_id: String,
    pub channel: String,
    pub tool_name: String,
    pub input: serde_json::Value,
    pub ts: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PermissionResponse {
    pub decision: PermissionDecision,
    /// When `allow` and the user tweaked the input (rare — currently
    /// unused by the React side but allowed by the MCP shape).
    pub updated_input: Option<serde_json::Value>,
}

/// One in-flight prompt: the metadata for the React renderer + the
/// oneshot the socket task is awaiting.
struct Slot {
    meta: PendingPrompt,
    responder: oneshot::Sender<PermissionResponse>,
}

#[derive(Default)]
pub struct PermissionRegistry {
    slots: Mutex<HashMap<String, Slot>>,
    /// Per-channel auto-allow set populated by AllowAlways. Keyed by
    /// `(channel, tool_name)` so a different tab/agent doesn't inherit
    /// the user's decision.
    auto_allow: Mutex<HashMap<String, ()>>,
}

impl PermissionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a new pending prompt. The caller (socket reader task)
    /// owns the receiver half — it awaits the user's decision before
    /// writing back to the MCP shim.
    pub fn enqueue(
        &self,
        meta: PendingPrompt,
    ) -> oneshot::Receiver<PermissionResponse> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut g) = self.slots.lock() {
            g.insert(
                meta.prompt_id.clone(),
                Slot { meta, responder: tx },
            );
        }
        rx
    }

    pub fn auto_allow_key(channel: &str, tool: &str) -> String {
        format!("{channel}::{tool}")
    }

    pub fn is_auto_allowed(&self, channel: &str, tool: &str) -> bool {
        self.auto_allow
            .lock()
            .map(|g| g.contains_key(&Self::auto_allow_key(channel, tool)))
            .unwrap_or(false)
    }

    fn remember_allow_always(&self, channel: &str, tool: &str) {
        if let Ok(mut g) = self.auto_allow.lock() {
            g.insert(Self::auto_allow_key(channel, tool), ());
        }
    }

    pub fn list_pending(&self) -> Vec<PendingPrompt> {
        self.slots
            .lock()
            .ok()
            .map(|g| g.values().map(|s| s.meta.clone()).collect())
            .unwrap_or_default()
    }
}

/// Called by React when the user picks a decision on the prompt card.
/// Resolves the oneshot the socket reader is parked on; the MCP shim
/// then formats the response and returns to claude.
#[tauri::command]
pub fn permission_respond(
    registry: State<'_, PermissionRegistry>,
    prompt_id: String,
    decision: PermissionDecision,
    updated_input: Option<serde_json::Value>,
) -> Result<(), String> {
    let slot = registry
        .slots
        .lock()
        .map_err(|e| format!("lock: {e}"))?
        .remove(&prompt_id);
    let Some(slot) = slot else {
        return Err(format!("no pending prompt {prompt_id}"));
    };
    if matches!(decision, PermissionDecision::AllowAlways) {
        registry.remember_allow_always(&slot.meta.channel, &slot.meta.tool_name);
    }
    let _ = slot.responder.send(PermissionResponse {
        decision,
        updated_input,
    });
    Ok(())
}

/// React queries on mount so a previously-fired prompt that landed
/// before the listener attached still renders. Cheap — usually empty.
#[tauri::command]
pub fn permission_list_pending(
    registry: State<'_, PermissionRegistry>,
) -> Vec<PendingPrompt> {
    registry.list_pending()
}

/// Push a new prompt into React. Called from the socket-server task
/// (defined in `permission_socket.rs`, started at app boot) once it
/// has parked the responder in `registry`.
pub fn emit_prompt(app: &AppHandle, prompt: &PendingPrompt) {
    let _ = app.emit("permission:prompt", prompt);
}
