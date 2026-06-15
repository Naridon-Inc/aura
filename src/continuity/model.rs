//! Carryover data model — the semantic envelope a *different* brain reads
//! to resume work at the exact point of interruption.
//!
//! This is the heart of cross-agent continuity (Claude → Gemini → Kimi).
//! Unlike a plain text summary, every field here is reconstructed from
//! Aura's own provenanced state: the function-anchored intent log, the
//! per-commit AST checkpoints (rename-proof `node_id`s), the active
//! session digest, project memory, and the live working-tree diff. The
//! receiving brain continues the *work*, not a paraphrase of the chat.
//!
//! Serde shapes are the IPC contract: `aura carryover --json` emits this
//! verbatim for the shell bridge (`cmd_carryover.rs`), and `render.rs`
//! turns the same struct into the markdown that `--inject` writes into a
//! target agent's startup-context file.

use serde::{Deserialize, Serialize};

/// How much of the conversation rides along with the semantic state.
/// `Full` favours the verbatim chat tail (more turns, longer text);
/// `Semantic` favours the compact Aura-native reconstruction with a
/// short tail. Both always carry the cheap semantic fields — the mode
/// only tunes the transcript volume (the user's pick-per-swap choice).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CarryoverMode {
    Full,
    Semantic,
}

impl CarryoverMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "full" => Some(Self::Full),
            "semantic" | "compact" => Some(Self::Semantic),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Semantic => "semantic",
        }
    }

    /// Max transcript turns embedded in `recent_turns`.
    pub fn turn_cap(self) -> usize {
        match self {
            Self::Full => 200,
            Self::Semantic => 12,
        }
    }

    /// Per-turn text truncation (chars) so a long paste stays bounded.
    pub fn text_trunc(self) -> usize {
        match self {
            Self::Full => 4000,
            Self::Semantic => 500,
        }
    }
}

/// Top-level carryover payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuraCarryover {
    /// Schema version — bump on breaking field changes.
    pub version: u32,
    /// `"full"` | `"semantic"`.
    pub mode: String,
    /// Unix seconds when this payload was assembled.
    pub generated_at: u64,
    /// Repo root the payload describes.
    pub repo: String,
    /// Current git branch, when resolvable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The agent this carryover is being handed to (`gemini`, `kimi`, …).
    /// Cosmetic — drives the rendered header and the inject target file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_agent: Option<String>,
    /// Active session digest — who/what/where work was happening.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionDigest>,
    /// Recent signed/typed intents (the chronological "why" stream).
    #[serde(default)]
    pub intents: Vec<IntentBrief>,
    /// Function-level state: the AST nodes recent checkpoints touched,
    /// each tagged with the intent that changed it. This is the
    /// function-level intent linkage the user asked for.
    #[serde(default)]
    pub touched_nodes: Vec<NodeState>,
    /// Uncommitted changes right now — the literal "exact moment".
    pub working_tree: WorkingTreeDiff,
    /// Project memory compact summary (identity/stack/gotchas), as-is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<serde_json::Value>,
    /// Tail of the conversation transcript (mode-capped).
    #[serde(default)]
    pub recent_turns: Vec<TurnBrief>,
}

/// Snapshot of the active agent session.
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

/// The distilled "what happened / what's left" of a session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummaryBrief {
    pub intent: String,
    pub outcome: String,
    #[serde(default)]
    pub open_items: Vec<String>,
    #[serde(default)]
    pub learnings: Vec<String>,
}

/// One intent-log row, trimmed to what a resuming brain needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntentBrief {
    pub timestamp: u64,
    pub agent_id: String,
    pub intent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent_type: Option<String>,
    /// Present when the intent was cryptographically signed — the
    /// receiving brain can `aura attest verify <id>` to confirm it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed_block_id: Option<String>,
}

/// A function/class node a recent checkpoint touched, plus the intent
/// that changed it. `node_id` is rename-proof (`fn::name@file:line`).
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
    /// True if the node still contains a stub/TODO — a resuming brain
    /// should treat these as unfinished work.
    pub is_stub: bool,
    /// The checkpoint intent that last touched this node.
    pub intent: String,
    /// When that checkpoint landed (unix seconds).
    pub at: u64,
}

/// Working-tree diff summary (uncommitted changes vs HEAD).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkingTreeDiff {
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
    #[serde(default)]
    pub files: Vec<FileDiffStat>,
}

/// One changed path + its single-letter status (M/A/D/R/?).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDiffStat {
    pub path: String,
    pub status: String,
}

/// One transcript turn, truncated per mode.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnBrief {
    pub role: String,
    pub text: String,
    pub at: u64,
}
