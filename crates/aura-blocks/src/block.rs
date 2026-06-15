//! Aura work surface — canonical Block envelope.
//!
//! A Block is the addressable unit of everything that happens on the work
//! surface: agent proposals, human commands, sentinel messages, PR mirrors,
//! impact alerts, zone events, build-state changes. One type, one table,
//! one sync pipeline, one policy evaluator.
//!
//! Design invariants — read these before changing anything:
//!
//!   I1. Blocks are graph nodes, not list items. (parent_id, prior_sibling_id,
//!       supersedes_id) carry the DAG. Time-order is a derived view.
//!
//!   I2. Blocks are supervisor artifacts. The terminal renders a *view* onto
//!       a block; scrollback is a stale projection, never the source of truth.
//!
//!   I3. Blocks have stable durable identity. A block that started on laptop,
//!       suspended to cloud, resumed on a colleague's machine, and branched
//!       by an agent keeps the same BlockId end-to-end.
//!
//!   I4. Mutable state lives in BlockOps (append-only CRDT ops), not in
//!       the Block struct. The Block is the envelope; BlockOps are the film.
//!
//!   I5. Schema evolves via semver + open `extensions`. Breaking changes are
//!       major-version bumps and require a registered migration.
//!
//!   I6. Provenance is first-class. Every block carries signed attribution
//!       strong enough to survive subpoena, audit, and cross-org federation.
//!
//!   I7. Agent-identity neutrality. No field privileges any specific agent
//!       vendor. `AgentRef` is opaque; Claude Code and Codex are equal citizens.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::BlockKind;

// ─────────────────────────────────────────────────────────────────────────────
// Schema version
// ─────────────────────────────────────────────────────────────────────────────

/// Schema semver. Bump major on incompatible change; minor on additive field;
/// patch on doc/clarification. Stored on every envelope so old clients can
/// refuse or migrate.
pub const SCHEMA_VERSION: SchemaVersion = SchemaVersion {
    major: 1,
    minor: 0,
    patch: 0,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaVersion {
    pub major: u16,
    pub minor: u16,
    pub patch: u16,
}

// ─────────────────────────────────────────────────────────────────────────────
// Identifiers
// ─────────────────────────────────────────────────────────────────────────────

/// ULID-shaped ID. Time-sortable, 128-bit, URL-safe. We use UUID v7 under the
/// hood (monotonic, unix-timestamp prefix) so old tools can parse as UUID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BlockId(pub Uuid);

impl BlockId {
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }
}

impl Default for BlockId {
    fn default() -> Self {
        Self::new()
    }
}

/// Stable identity for anything that can *produce* a block.
/// Decentralized-ID shape: `did:<method>:<identifier>` so humans, agents,
/// teams, and external orgs all fit one type. Examples:
///   did:aura:user/muhammed
///   did:aura:agent/claude-code/session-01JC...
///   did:aura:team/naridon
///   did:ext:github/app/renovate-bot
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AgentRef(pub String);

/// Provider-qualified PR/issue handle. Replaces the stringly-typed form to
/// keep parsing in one place.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProviderRef {
    /// "github" | "gitlab" | "bitbucket" | ...
    pub provider: String,
    /// Repo path, e.g. "naridon/aura".
    pub path: String,
    /// PR or issue number.
    pub number: u32,
}

/// The thing a block is *about* — a function, a file, a PR, a zone, a build.
/// Anchoring a message to `AnchorRef::Function(fn_id)` is what makes
/// dev-to-dev messaging survive renames: the AST identity travels with the
/// function, the message follows.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum AnchorRef {
    Function(String), // AST function identity
    File(String),     // repo-relative path
    Pr(ProviderRef),
    Zone(String),   // zone id
    Build(String),  // CI build id
    Block(BlockId), // another block (for replies, reviews, critiques)
    None,
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle FSM
// ─────────────────────────────────────────────────────────────────────────────

/// Explicit finite-state machine. Every transition is enumerated so the
/// compiler catches unhandled cases in the supervisor.
///
/// Terminal-state derivation: `closed_at` is *not* stored on the envelope.
/// Derive it from the first `Transition` op into a terminal state
/// (see [`BlockState::is_terminal`]). Storing both invites drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockState {
    /// Just created. Not yet evaluated by policy.
    Proposed,
    /// Policy requires human approval; blocked on user.
    Gated,
    /// Policy denied; terminal. Kept for audit.
    Denied,
    /// Executing now.
    Running,
    /// Paused by user/agent; resumable. Long-lived blocks spend most of their
    /// life here. (The "three-week refactor" case.)
    Suspended,
    /// Resume requested but not yet executing. The sandbox is spinning up,
    /// or the policy engine is re-evaluating because capabilities expired
    /// during suspension. Usually transient (one tick), but the window
    /// matters — this is exactly where re-authorization happens.
    ///
    /// Kept deliberately. Sidebar projection collapses Resumed into the
    /// Running display; the state stays in the model for audit.
    Resumed,
    /// Completed successfully. Terminal.
    Completed,
    /// Completed with error. Terminal.
    Failed,
    /// Rolled back by the supervisor. Terminal.
    RolledBack,
    /// Replaced by another block (branch/retry/rewind target).
    /// `supersedes_id` on the successor points back here.
    Superseded,
}

impl BlockState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Denied | Self::Completed | Self::Failed | Self::RolledBack | Self::Superseded
        )
    }

    /// Returns `Ok(())` if `next` is a legal successor of `self`.
    /// This is THE transition table. Review carefully; it defines product
    /// semantics.
    pub fn transition(self, next: BlockState) -> Result<(), BlockError> {
        use BlockState::*;
        let ok = matches!(
            (self, next),
            (Proposed, Gated | Running | Denied | Superseded)
                | (Gated, Running | Denied | Superseded)
                | (
                    Running,
                    Suspended | Completed | Failed | RolledBack | Superseded
                )
                | (Suspended, Resumed | RolledBack | Superseded)
                | (Resumed, Running) // Terminal states have no legal successor.
        );
        if ok {
            Ok(())
        } else {
            Err(BlockError::IllegalTransition {
                from: self,
                to: next,
            })
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent, impacts, capabilities — the supervisor's primary keys
// ─────────────────────────────────────────────────────────────────────────────

/// What the block *means to accomplish*. In year 7 when agents decompose
/// features into hundreds of sub-blocks, `intent` is what the human sees in
/// the sidebar; the command is an implementation detail.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Intent {
    pub summary: String,                // one-line, human-readable
    pub detail: Option<String>,         // optional longer rationale
    pub parent_intent: Option<BlockId>, // for decomposed work
}

/// What the block claims it will touch. The policy engine cross-checks the
/// actual side-effects after execution; divergence fires a SentinelEvent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeclaredImpacts {
    pub writes_paths: Vec<String>, // repo-relative
    pub reads_paths: Vec<String>,
    pub network: Vec<NetworkIntent>,
    pub touches_zones: Vec<String>,
    pub installs_packages: Vec<String>,
    pub mutates_secrets: Vec<String>, // secret refs, never values
    pub deploys: Vec<String>,
}

/// Post-execution reconciliation. Identical shape to `DeclaredImpacts` so
/// diffing is a field-by-field match. `None` until the supervisor reconciles.
pub type ActualImpacts = DeclaredImpacts;

/// HTTP-ish verb typed to kill typos in declared network intents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum NetworkMethod {
    Get,
    Post,
    Put,
    Delete,
    Patch,
    Head,
    Options,
    #[serde(untagged)]
    Other(String),
}

impl NetworkMethod {
    /// Stable on-wire verb. Borrowed; safe to compare against policy strings
    /// loaded from TOML without an allocation.
    pub fn as_wire(&self) -> &str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Delete => "DELETE",
            Self::Patch => "PATCH",
            Self::Head => "HEAD",
            Self::Options => "OPTIONS",
            Self::Other(s) => s.as_str(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkIntent {
    pub host: String,
    pub method: NetworkMethod,
    pub purpose: String, // free-text rationale
}

/// The capability grade a block needs. Matches the three-tier permission
/// model: Auto (in-repo reversible writes), Gate (irreversibles), Deny
/// (out-of-repo writes, .aura/ mutation).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityGrade {
    Auto,
    Gate,
    Deny,
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy decision — carried on the block, not in a side table
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyDecision {
    pub verdict: CapabilityGrade,
    pub rules_fired: Vec<String>,        // policy rule IDs
    pub reason: String,                  // human-readable
    pub decided_by: AgentRef,            // usually did:aura:policy-engine
    pub decided_at: OffsetDateTime,
    pub gate_reviewer: Option<AgentRef>, // who cleared the gate (if Gate)
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance — for audit, for federation, for 10-year defensibility
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provenance {
    /// Who produced this block (human, agent, external system).
    pub actor: AgentRef,
    /// On whose behalf (e.g., Claude Code acting for did:aura:user/muhammed).
    pub on_behalf_of: Option<AgentRef>,
    /// Machine the block was created on. Resume across machines is a later
    /// block with supersedes_id → this block; the origin stays pinned here.
    pub origin_host: String,
    /// Optional signature. Present for cross-org federation; optional locally.
    /// Signature covers the envelope canonicalized per [`crate::CANONICALIZATION`].
    pub signature: Option<Signature>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signature {
    /// Algorithm identifier, e.g. "ed25519".
    pub algo: String,
    /// Key identity DID, e.g. "did:aura:key/...".
    pub key_id: String,
    /// Base64 signature over the canonicalized envelope
    /// (see [`crate::CANONICALIZATION`] for the exact scheme and version).
    pub sig_b64: String,
}

/// Reserved-but-unspecced bag for cross-org attestations (external agent vouches
/// for the block). Empty in v1; shape locks in when federation ships.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Attestations {
    pub items: Vec<serde_json::Value>,
}

// ─────────────────────────────────────────────────────────────────────────────
// The envelope
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Block {
    // ── Identity ──────────────────────────────────────────────────────────
    pub id: BlockId,
    pub schema_version: SchemaVersion,
    pub kind: BlockKind,

    // ── Graph edges (DAG, not list) ───────────────────────────────────────
    pub parent_id: Option<BlockId>, // containment: a review block's parent is the diff it reviews
    pub prior_sibling_id: Option<BlockId>, // time-order within a parent
    pub supersedes_id: Option<BlockId>, // branch/retry/rewind target
    pub anchor: AnchorRef,          // what the block is *about*

    // ── Semantics ─────────────────────────────────────────────────────────
    pub intent: Intent,
    pub declared_impacts: DeclaredImpacts,
    /// Populated by the supervisor *after* execution; compared against
    /// `declared_impacts` to fire divergence alerts. `None` pre-reconciliation.
    pub actual_impacts: Option<ActualImpacts>,
    pub payload: BlockPayload, // kind-specific body

    // ── Supervisor state ──────────────────────────────────────────────────
    pub state: BlockState,
    pub policy: Option<PolicyDecision>, // None for kinds that skip policy

    // ── Provenance ────────────────────────────────────────────────────────
    pub provenance: Provenance,
    #[serde(default)]
    pub attestations: Attestations,

    // ── Timing ────────────────────────────────────────────────────────────
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime, // bumped on every op apply

    // ── Open extension bag — reserved for fields we haven't invented yet.
    // Use sparingly; prefer promoting to a real field via minor bump.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: BTreeMap<String, serde_json::Value>,
}

/// Kind-specific body. Variants are narrow on purpose — if you find yourself
/// packing unrelated things into a single variant, it's a new kind, not a new
/// field. There is no Custom escape hatch; see `kinds.toml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BlockPayload {
    Command {
        command: String,       // the literal command line
        shell: Option<String>, // zsh|bash|fish|pwsh
        cwd: String,
    },
    Proposal {
        proposed_command: String,
        alternatives: Vec<String>, // agent-offered variants
    },
    Message {
        body: String, // markdown
        mentions: Vec<AgentRef>,
    },
    Sentinel {
        event_type: String,        // e.g. "diff_critique", "intent_divergence"
        body: serde_json::Value,   // schema depends on event_type
    },
    ExternalMirror {
        source: String, // "github", "gitlab", "linear", ...
        external_id: String,
        body: serde_json::Value,
    },
    Impact {
        function_id: String,
        change_kind: String, // "signature", "behavior", "removed"
    },
    Zone {
        zone_id: String,
        action: String, // "claimed", "released", "expired"
    },
    Build {
        build_id: String,
        status: String, // "green", "red", "started"
    },
    Skill {
        skill_name: String,
        arguments: serde_json::Value,
    },
    Branch {
        reason: String,
    },
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum BlockError {
    #[error("illegal state transition: {from:?} → {to:?}")]
    IllegalTransition { from: BlockState, to: BlockState },
    #[error("schema version mismatch: block={block:?}, supported={supported:?}")]
    SchemaMismatch {
        block: SchemaVersion,
        supported: SchemaVersion,
    },
    #[error("policy decision missing for kind that requires one")]
    MissingPolicy,
    #[error("no migration path from {from:?} to {to:?}")]
    NoMigrationPath { from: SchemaVersion, to: SchemaVersion },
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fsm_happy_path() {
        assert!(BlockState::Proposed.transition(BlockState::Gated).is_ok());
        assert!(BlockState::Gated.transition(BlockState::Running).is_ok());
        assert!(BlockState::Running.transition(BlockState::Completed).is_ok());
    }

    #[test]
    fn fsm_long_lived_suspend_resume() {
        assert!(BlockState::Running.transition(BlockState::Suspended).is_ok());
        assert!(BlockState::Suspended.transition(BlockState::Resumed).is_ok());
        assert!(BlockState::Resumed.transition(BlockState::Running).is_ok());
    }

    #[test]
    fn fsm_rejects_illegal() {
        assert!(BlockState::Completed.transition(BlockState::Running).is_err());
        assert!(BlockState::Proposed.transition(BlockState::Completed).is_err());
        assert!(BlockState::Denied.transition(BlockState::Running).is_err());
    }

    #[test]
    fn terminals_are_terminal() {
        for s in [
            BlockState::Denied,
            BlockState::Completed,
            BlockState::Failed,
            BlockState::RolledBack,
            BlockState::Superseded,
        ] {
            assert!(s.is_terminal(), "{s:?} should be terminal");
        }
    }

    #[test]
    fn roundtrip_json() {
        let block = Block {
            id: BlockId::new(),
            schema_version: SCHEMA_VERSION,
            kind: BlockKind::Command,
            parent_id: None,
            prior_sibling_id: None,
            supersedes_id: None,
            anchor: AnchorRef::None,
            intent: Intent {
                summary: "list files".into(),
                detail: None,
                parent_intent: None,
            },
            declared_impacts: Default::default(),
            actual_impacts: None,
            payload: BlockPayload::Command {
                command: "ls -la".into(),
                shell: Some("zsh".into()),
                cwd: "/home/muhammed/naridon".into(),
            },
            state: BlockState::Proposed,
            policy: None,
            provenance: Provenance {
                actor: AgentRef("did:aura:user/muhammed".into()),
                on_behalf_of: None,
                origin_host: "wayanad-laptop".into(),
                signature: None,
            },
            attestations: Default::default(),
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
            extensions: BTreeMap::new(),
        };
        let json = serde_json::to_string(&block).unwrap();
        let back: Block = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, block.id);
        assert_eq!(back.schema_version, block.schema_version);
        assert_eq!(back.kind, block.kind);
    }

    #[test]
    fn provider_ref_roundtrip() {
        let a = AnchorRef::Pr(ProviderRef {
            provider: "github".into(),
            path: "naridon/aura".into(),
            number: 1203,
        });
        let json = serde_json::to_string(&a).unwrap();
        let back: AnchorRef = serde_json::from_str(&json).unwrap();
        assert_eq!(a, back);
    }
}
