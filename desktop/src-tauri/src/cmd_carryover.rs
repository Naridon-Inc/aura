//! Carryover bridge (WW-B3) — shells `aura carryover --json` and returns
//! the typed [`AuraCarryover`] payload for the in-app brain-swap flow.
//!
//! ## Where this sits
//!
//! The chat-header BrainPicker calls [`brain_carryover`] at the *explicit
//! swap moment* — the user changes the session's brain and we hand the new
//! brain the semantic state of the work-in-progress. The renderer prepends
//! the payload to the next turn's context so the receiving brain continues
//! the work instead of restarting the conversation.
//!
//! This is deliberately **off the hot send path**. Per-turn brain selection
//! is the cheap `manager_set_brain_override` / `brain_chat_turn(brain_override)`
//! lever (no subprocess); `brain_carryover` spawns the CLI and walks AST
//! checkpoints, which is far too heavy to run on every turn.
//!
//! ## Why a serde mirror of the CLI model
//!
//! The shell links against crates, not the `aura` *binary* crate, so it
//! cannot import `continuity::model`. The CLI's `--json` output is the IPC
//! contract (see `aura-cli/src/continuity/model.rs`, whose module doc names
//! this file as the consumer). The structs below mirror that contract
//! field-for-field so deserialization fails loudly if the contract drifts,
//! rather than silently passing a malformed payload to the frontend.
//!
//! ## Redaction
//!
//! We do **not** pass `--no-redact`. The receiving brain may be a cloud
//! model (Gemini, Kimi/Moonshot), so the payload can leave the machine —
//! the CLI's always-on secret scrub must run before it does. `--no-redact`
//! is a CLI-local escape hatch only; the in-app bridge never uses it.

use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::agent_event_listener::resolve_aura_bin;

/// Top-level carryover payload. Mirror of `continuity::model::AuraCarryover`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuraCarryover {
    pub version: u32,
    pub mode: String,
    pub generated_at: u64,
    pub repo: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionDigest>,
    #[serde(default)]
    pub intents: Vec<IntentBrief>,
    #[serde(default)]
    pub touched_nodes: Vec<NodeState>,
    pub working_tree: WorkingTreeDiff,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<serde_json::Value>,
    #[serde(default)]
    pub recent_turns: Vec<TurnBrief>,
}

/// Mirror of `continuity::model::SessionDigest`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionDigest {
    pub session_id: String,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    pub started_at: u64,
    pub last_activity: u64,
    #[serde(default)]
    pub files_touched: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<SessionSummaryBrief>,
}

/// Mirror of `continuity::model::SessionSummaryBrief`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummaryBrief {
    pub intent: String,
    pub outcome: String,
    #[serde(default)]
    pub open_items: Vec<String>,
    #[serde(default)]
    pub learnings: Vec<String>,
}

/// Mirror of `continuity::model::IntentBrief`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntentBrief {
    pub timestamp: u64,
    pub agent_id: String,
    pub intent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed_block_id: Option<String>,
}

/// Mirror of `continuity::model::NodeState`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeState {
    pub node_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    pub is_stub: bool,
    pub intent: String,
    pub at: u64,
}

/// Mirror of `continuity::model::WorkingTreeDiff`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkingTreeDiff {
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
    #[serde(default)]
    pub files: Vec<FileDiffStat>,
}

/// Mirror of `continuity::model::FileDiffStat`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDiffStat {
    pub path: String,
    pub status: String,
}

/// Mirror of `continuity::model::TurnBrief`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnBrief {
    pub role: String,
    pub text: String,
    pub at: u64,
}

/// Assemble the carryover payload for a brain swap.
///
/// Shells `aura carryover --repo <root> --mode <mode> [--agent <target>] --json`
/// and parses the emitted [`AuraCarryover`]. `mode` is `"full"` or
/// `"semantic"` (empty defaults to `"semantic"`); `target_agent` is the
/// brain we're handing to (drives the rendered header) and may be empty.
///
/// Runs on a blocking thread: spawning the CLI and walking checkpoints
/// blocks, and we don't want to stall the async IPC executor for it. This
/// is the swap-time call only — never invoke it per turn.
#[tauri::command]
pub async fn brain_carryover(
    repo_root: String,
    mode: String,
    target_agent: String,
) -> Result<AuraCarryover, String> {
    let mode = {
        let m = mode.trim().to_ascii_lowercase();
        if m.is_empty() {
            "semantic".to_string()
        } else if m == "full" || m == "semantic" {
            m
        } else {
            return Err(format!("mode must be `full` or `semantic`, got `{mode}`"));
        }
    };

    let cwd = PathBuf::from(&repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }

    let bin = resolve_aura_bin();
    let mut args: Vec<String> = vec![
        "carryover".to_string(),
        "--repo".to_string(),
        repo_root.clone(),
        "--mode".to_string(),
        mode,
        "--json".to_string(),
    ];
    let target = target_agent.trim();
    if !target.is_empty() {
        args.push("--agent".to_string());
        args.push(target.to_string());
    }

    let out = tokio::task::spawn_blocking(move || {
        Command::new(&bin).args(&args).current_dir(&cwd).output()
    })
    .await
    .map_err(|e| format!("carryover task join: {e}"))?
    .map_err(|e| format!("failed to spawn `aura carryover`: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "aura carryover failed (status {}): {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str::<AuraCarryover>(stdout.trim())
        .map_err(|e| format!("parse carryover json: {e}"))
}
