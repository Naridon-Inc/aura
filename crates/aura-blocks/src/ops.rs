//! Append-only op stream that drives runtime block state.
//!
//! A Block's `state` and `updated_at` are the reducer's output over its ops.
//! Ops are CRDT-synced through the same pipeline as `crdt_docs` (W4). Scalars
//! are last-writer-wins keyed on `(timestamp, lamport, actor)`. `AppendOutput`
//! streams are per-actor append-only and therefore conflict-free by design.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{AgentRef, BlockId, BlockState, PolicyDecision, RedactionMark};

/// Reserved metric-key namespace for cost accounting on `RecordMetric` ops.
///
/// Multi-agent blocks need per-agent attribution, so every `cost.*` metric
/// that relates to LLM work MUST be accompanied by a `cost.agent_id`
/// entry in the same op-batch. Reducers may enforce this.
pub const COST_METRIC_KEYS: &[&str] = &[
    "cost.tokens_in",
    "cost.tokens_out",
    "cost.tokens_cache_read",
    "cost.tokens_cache_write",
    "cost.tokens_reasoning",
    "cost.usd",
    "cost.wall_ms",
    "cost.agent_id",
];

/// Structured metric — same shape whether persisted inline or in a side table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordedMetric {
    pub key: String,
    pub value: serde_json::Value,
}

/// Mutations to a block live here, not on the Block. A Block's `state` and
/// `updated_at` are the reducer's output over its ops.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockOp {
    /// UUID v7; monotonic per-actor, unique globally.
    pub op_id: Uuid,
    pub block_id: BlockId,
    pub actor: AgentRef,
    pub timestamp: OffsetDateTime,
    /// Per-block-per-actor monotonic counter. Breaks same-timestamp ties
    /// during CRDT reduction. Ordering rule: `(timestamp, lamport, actor)`
    /// lexicographic; `actor` compared as its DID string.
    pub lamport: u64,
    pub payload: BlockOpPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum BlockOpPayload {
    /// Append bytes to an output stream. `stream` is "stdout" | "stderr" |
    /// "agent-thought" | "diff" | … — agents and processes multiplex freely.
    ///
    /// `bytes_b64` holds ALREADY-REDACTED bytes. `redactions` records what
    /// was stripped, with offsets into the pre-redaction stream. See
    /// [`crate::Redactor`] — raw bytes must never be stored.
    AppendOutput {
        stream: String,
        bytes_b64: String,
        #[serde(default)]
        redactions: Vec<RedactionMark>,
    },
    /// Record a structured metric (exit code, diff hash, token usage, cost).
    /// Reserved `cost.*` keys documented in [`COST_METRIC_KEYS`].
    RecordMetric { key: String, value: serde_json::Value },
    /// Transition the lifecycle. The supervisor validates legality via
    /// [`BlockState::transition`](crate::BlockState::transition).
    Transition {
        to: BlockState,
        reason: Option<String>,
    },
    /// Attach a policy decision.
    AttachPolicy { decision: PolicyDecision },
    /// Attach an attestation (cross-org federation).
    AttachAttestation { attestation: serde_json::Value },
    /// Add a tag (arbitrary label for search / skill membership).
    Tag { tag: String },
    /// Set or update an extension field.
    SetExtension { key: String, value: serde_json::Value },
    /// Reducer checkpoint. The reducer folds all ops `<= up_to_op` into
    /// `folded_state` and emits this op; subsequent reducers may start from
    /// it rather than replaying from genesis.
    ///
    /// Reserved in v1 — compactor is not yet implemented. Ensures the wire
    /// format is forward-compatible with the day the compactor ships.
    Snapshot {
        up_to_op: Uuid,
        folded_state: serde_json::Value,
        producer: AgentRef,
    },
}

/// Total ordering for CRDT reduction. `(timestamp, lamport, actor)`
/// lexicographic; actor compared as DID string for determinism.
impl BlockOp {
    pub fn ordering_key(&self) -> (OffsetDateTime, u64, &str) {
        (self.timestamp, self.lamport, self.actor.0.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_namespace_contains_per_agent_key() {
        assert!(COST_METRIC_KEYS.contains(&"cost.agent_id"));
        assert!(COST_METRIC_KEYS.contains(&"cost.tokens_in"));
    }

    #[test]
    fn lamport_breaks_timestamp_tie() {
        let t = OffsetDateTime::now_utc();
        let block_id = BlockId::new();
        let make = |actor: &str, lamport: u64| BlockOp {
            op_id: Uuid::now_v7(),
            block_id,
            actor: AgentRef(actor.into()),
            timestamp: t,
            lamport,
            payload: BlockOpPayload::Tag {
                tag: "t".into(),
            },
        };

        let a = make("did:aura:agent/a", 1);
        let b = make("did:aura:agent/a", 2);
        // Same timestamp, same actor: lamport wins.
        assert!(a.ordering_key() < b.ordering_key());

        let c = make("did:aura:agent/a", 5);
        let d = make("did:aura:agent/b", 5);
        // Same timestamp, same lamport: actor DID breaks the tie.
        assert!(c.ordering_key() < d.ordering_key());
    }

    #[test]
    fn append_output_carries_redactions() {
        let op = BlockOp {
            op_id: Uuid::now_v7(),
            block_id: BlockId::new(),
            actor: AgentRef("did:aura:agent/claude".into()),
            timestamp: OffsetDateTime::now_utc(),
            lamport: 0,
            payload: BlockOpPayload::AppendOutput {
                stream: "stdout".into(),
                bytes_b64: "aGk=".into(),
                redactions: vec![RedactionMark {
                    offset: 0,
                    length: 3,
                    kind: crate::RedactionKind::Pii {
                        classifier: "email".into(),
                    },
                    placeholder: "[REDACTED:Pii]".into(),
                }],
            },
        };
        let json = serde_json::to_string(&op).unwrap();
        let back: BlockOp = serde_json::from_str(&json).unwrap();
        assert_eq!(back.op_id, op.op_id);
    }

    #[test]
    fn snapshot_op_roundtrips() {
        let op = BlockOp {
            op_id: Uuid::now_v7(),
            block_id: BlockId::new(),
            actor: AgentRef("did:aura:reducer".into()),
            timestamp: OffsetDateTime::now_utc(),
            lamport: 42,
            payload: BlockOpPayload::Snapshot {
                up_to_op: Uuid::now_v7(),
                folded_state: serde_json::json!({"state": "running"}),
                producer: AgentRef("did:aura:reducer".into()),
            },
        };
        let json = serde_json::to_string(&op).unwrap();
        let _back: BlockOp = serde_json::from_str(&json).unwrap();
    }
}
