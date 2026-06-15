//! Pure reducer — folds `BlockOp`s into a `Block`'s reduced state.
//!
//! Determinism is the whole point: running [`replay`] over an ordered op log
//! from any machine produces the same Block state. The reducer never touches
//! I/O; it takes values in and returns values out.
//!
//! Ops handled here:
//!
//! | Payload            | Effect on the Block                                      |
//! |--------------------|----------------------------------------------------------|
//! | `Transition`       | Validates via `BlockState::transition`, then updates it. |
//! | `AttachPolicy`     | Sets `policy`.                                           |
//! | `AttachAttestation`| Appends to `attestations.items`.                         |
//! | `Tag`              | Appends to `extensions["tags"]` (array; dedup).          |
//! | `SetExtension`     | Writes `extensions[key] = value`.                        |
//! | `RecordMetric`     | Writes `extensions["metrics"][key] = value`.             |
//! | `Snapshot`         | Replaces the full envelope with `folded_state`.          |
//! | `AppendOutput`     | Envelope no-op (ring-buffered; persisted by flusher).    |
//!
//! Every variant produces real behavior. `AppendOutput` is intentionally a
//! no-op on the envelope — it bumps `updated_at` only, because the reduced
//! Block carries no output stream (that's the output-ring's job). This keeps
//! replay total: any sequence of ordered ops returns `Ok`.

use aura_blocks::{Block, BlockOp, BlockOpPayload};
use serde_json::{Map, Value};

use crate::error::{Result, StoreError};

/// Apply one op to a block. Pure; no I/O.
///
/// Caller must ensure `op.block_id == block.id` — this is an invariant of
/// the store (block_ops has a foreign key). We assert it so replay bugs or
/// crafted ops fail loudly instead of silently folding into the wrong block.
pub fn fold(mut block: Block, op: &BlockOp) -> Result<Block> {
    if op.block_id != block.id {
        return Err(StoreError::IllegalOp {
            block_id: format!("{:?}", block.id),
            reason: format!("op {} targets a different block", op.op_id),
        });
    }

    match &op.payload {
        BlockOpPayload::Transition { to, reason: _ } => {
            block.state.transition(*to)?;
            block.state = *to;
        }
        BlockOpPayload::AttachPolicy { decision } => {
            block.policy = Some(decision.clone());
        }
        BlockOpPayload::AttachAttestation { attestation } => {
            block.attestations.items.push(attestation.clone());
        }
        BlockOpPayload::Tag { tag } => {
            let entry = block
                .extensions
                .entry("tags".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Value::Array(arr) = entry {
                let already = arr.iter().any(|v| v.as_str() == Some(tag.as_str()));
                if !already {
                    arr.push(Value::String(tag.clone()));
                }
            } else {
                return Err(StoreError::IllegalOp {
                    block_id: format!("{:?}", block.id),
                    reason: "extensions.tags present but not an array".into(),
                });
            }
        }
        BlockOpPayload::SetExtension { key, value } => {
            block.extensions.insert(key.clone(), value.clone());
        }
        BlockOpPayload::RecordMetric { key, value } => {
            let metrics = block
                .extensions
                .entry("metrics".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            match metrics {
                Value::Object(m) => {
                    m.insert(key.clone(), value.clone());
                }
                _ => {
                    return Err(StoreError::IllegalOp {
                        block_id: format!("{:?}", block.id),
                        reason: "extensions.metrics present but not an object".into(),
                    });
                }
            }
        }
        BlockOpPayload::Snapshot {
            up_to_op: _,
            folded_state,
            producer: _,
        } => {
            // Snapshot replaces the envelope wholesale. The producer certifies
            // that `folded_state` is the result of replaying all ops through
            // `up_to_op`. Subsequent folds apply on top.
            block = serde_json::from_value::<Block>(folded_state.clone())?;
        }
        BlockOpPayload::AppendOutput { .. } => {
            // Envelope no-op. The output stream lives in the ring buffer and
            // block_ops table, addressed by (block_id, lamport). The reducer
            // still advances `updated_at` so sidebar ordering reflects
            // liveness.
        }
    }

    block.updated_at = op.timestamp;
    Ok(block)
}

/// Fold a fully-ordered op slice into an initial block.
///
/// The caller passes the initial envelope (typically the one that was stored
/// with state=Proposed when the block was created) and every op authored on
/// it. Ops are sorted by `(timestamp, lamport, actor)` before folding so
/// this function is deterministic regardless of insertion order.
pub fn replay(initial: Block, ops: &[BlockOp]) -> Result<Block> {
    let mut sorted: Vec<&BlockOp> = ops.iter().collect();
    sorted.sort_by(|a, b| a.ordering_key().cmp(&b.ordering_key()));
    let mut acc = initial;
    for op in sorted {
        acc = fold(acc, op)?;
    }
    Ok(acc)
}

#[cfg(test)]
pub(crate) fn now_utc() -> time::OffsetDateTime {
    time::OffsetDateTime::now_utc()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_blocks::{
        AgentRef, AnchorRef, Attestations, Block, BlockId, BlockKind, BlockPayload, BlockState,
        CapabilityGrade, DeclaredImpacts, Intent, PolicyDecision, Provenance, SCHEMA_VERSION,
    };
    use std::collections::BTreeMap;
    use time::OffsetDateTime;
    use uuid::Uuid;

    fn mk_block() -> Block {
        Block {
            id: BlockId::new(),
            schema_version: SCHEMA_VERSION,
            kind: BlockKind::Command,
            parent_id: None,
            prior_sibling_id: None,
            supersedes_id: None,
            anchor: AnchorRef::None,
            intent: Intent {
                summary: "t".into(),
                detail: None,
                parent_intent: None,
            },
            declared_impacts: DeclaredImpacts::default(),
            actual_impacts: None,
            payload: BlockPayload::Command {
                command: "echo hi".into(),
                shell: Some("zsh".into()),
                cwd: "/tmp".into(),
            },
            state: BlockState::Proposed,
            policy: None,
            provenance: Provenance {
                actor: AgentRef("did:aura:user/test".into()),
                on_behalf_of: None,
                origin_host: "test-host".into(),
                signature: None,
            },
            attestations: Attestations::default(),
            created_at: now_utc(),
            updated_at: now_utc(),
            extensions: BTreeMap::new(),
        }
    }

    fn mk_op(block_id: BlockId, lamport: u64, payload: BlockOpPayload) -> BlockOp {
        BlockOp {
            op_id: Uuid::now_v7(),
            block_id,
            actor: AgentRef("did:aura:test".into()),
            timestamp: now_utc(),
            lamport,
            payload,
        }
    }

    #[test]
    fn transition_legal() {
        let b = mk_block();
        let id = b.id;
        let op = mk_op(
            id,
            1,
            BlockOpPayload::Transition {
                to: BlockState::Gated,
                reason: None,
            },
        );
        let after = fold(b, &op).unwrap();
        assert_eq!(after.state, BlockState::Gated);
    }

    #[test]
    fn transition_illegal_errors() {
        let b = mk_block();
        let id = b.id;
        let op = mk_op(
            id,
            1,
            BlockOpPayload::Transition {
                to: BlockState::Completed,
                reason: None,
            },
        );
        let err = fold(b, &op).unwrap_err();
        assert!(matches!(err, StoreError::Reducer(_)), "got {err:?}");
    }

    #[test]
    fn attach_policy_sets_decision() {
        let b = mk_block();
        let id = b.id;
        let decision = PolicyDecision {
            verdict: CapabilityGrade::Auto,
            rules_fired: vec!["in-repo-reversible".into()],
            reason: "auto".into(),
            decided_by: AgentRef("did:aura:policy".into()),
            decided_at: now_utc(),
            gate_reviewer: None,
        };
        let op = mk_op(id, 1, BlockOpPayload::AttachPolicy { decision });
        let after = fold(b, &op).unwrap();
        assert!(after.policy.is_some());
        assert_eq!(after.policy.unwrap().verdict, CapabilityGrade::Auto);
    }

    #[test]
    fn set_extension_merges() {
        let b = mk_block();
        let id = b.id;
        let op1 = mk_op(
            id,
            1,
            BlockOpPayload::SetExtension {
                key: "gate.excluded_children".into(),
                value: serde_json::json!([]),
            },
        );
        let op2 = mk_op(
            id,
            2,
            BlockOpPayload::SetExtension {
                key: "reviewer_note".into(),
                value: serde_json::json!("lgtm"),
            },
        );
        let b = fold(b, &op1).unwrap();
        let b = fold(b, &op2).unwrap();
        assert_eq!(b.extensions.len(), 2);
        assert_eq!(
            b.extensions.get("reviewer_note").unwrap(),
            &serde_json::json!("lgtm")
        );
    }

    #[test]
    fn record_metric_writes_into_metrics_map() {
        let b = mk_block();
        let id = b.id;
        let op1 = mk_op(
            id,
            1,
            BlockOpPayload::RecordMetric {
                key: "cost.tokens_in".into(),
                value: serde_json::json!(1200),
            },
        );
        let op2 = mk_op(
            id,
            2,
            BlockOpPayload::RecordMetric {
                key: "cost.usd".into(),
                value: serde_json::json!(0.042),
            },
        );
        let b = fold(b, &op1).unwrap();
        let b = fold(b, &op2).unwrap();
        let m = b.extensions.get("metrics").unwrap().as_object().unwrap();
        assert_eq!(m.get("cost.tokens_in").unwrap(), &serde_json::json!(1200));
        assert_eq!(m.get("cost.usd").unwrap(), &serde_json::json!(0.042));
    }

    #[test]
    fn snapshot_replaces_envelope() {
        let a = mk_block();
        let id = a.id;

        // Build a divergent "future" envelope and snapshot into it.
        let mut future = a.clone();
        future.state = BlockState::Running;
        future
            .extensions
            .insert("snapshot_marker".into(), serde_json::json!(true));
        let folded_state = serde_json::to_value(&future).unwrap();

        let op = mk_op(
            id,
            1,
            BlockOpPayload::Snapshot {
                up_to_op: Uuid::now_v7(),
                folded_state,
                producer: AgentRef("did:aura:reducer".into()),
            },
        );
        // Starting from the original state, the snapshot yields the future one.
        let after = fold(a, &op).unwrap();
        assert_eq!(after.state, BlockState::Running);
        assert!(after.extensions.contains_key("snapshot_marker"));
    }

    #[test]
    fn replay_is_order_independent() {
        let b = mk_block();
        let id = b.id;

        // Build three transitions in reverse insertion order and confirm
        // replay sorts them before folding.
        let t1 = OffsetDateTime::from_unix_timestamp(1_000_000).unwrap();
        let t2 = OffsetDateTime::from_unix_timestamp(1_000_001).unwrap();
        let t3 = OffsetDateTime::from_unix_timestamp(1_000_002).unwrap();
        let mk = |ts, lamport, to| BlockOp {
            op_id: Uuid::now_v7(),
            block_id: id,
            actor: AgentRef("did:aura:supervisor".into()),
            timestamp: ts,
            lamport,
            payload: BlockOpPayload::Transition { to, reason: None },
        };
        let o1 = mk(t1, 1, BlockState::Gated);
        let o2 = mk(t2, 2, BlockState::Running);
        let o3 = mk(t3, 3, BlockState::Completed);
        let shuffled = vec![o3.clone(), o1.clone(), o2.clone()];

        let after = replay(b.clone(), &shuffled).unwrap();
        assert_eq!(after.state, BlockState::Completed);

        // Re-run with canonical order — same outcome.
        let canon = replay(b, &[o1, o2, o3]).unwrap();
        assert_eq!(after.state, canon.state);
        assert_eq!(after.updated_at, canon.updated_at);
    }
}
