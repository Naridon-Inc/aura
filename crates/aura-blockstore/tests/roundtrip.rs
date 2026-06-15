//! Integration test: full block lifecycle, rebuild-from-ops, subscribe order,
//! and the deselect-to-exclude flow.
//!
//! Every sub-test works off a freshly opened in-memory [`BlockStore`]. The
//! top-level test orchestrates the sequence so a regression in one phase
//! halts the others — easier triage than eight separate #[test] fns.

use aura_blockstore::{BlockStore, StoreEvent};
use aura_blocks::{
    AgentRef, AnchorRef, Attestations, Block, BlockId, BlockKind, BlockOp, BlockOpPayload,
    BlockPayload, BlockState, CapabilityGrade, DeclaredImpacts, Intent, PolicyDecision,
    Provenance, SCHEMA_VERSION,
};
use base64::Engine;
use std::collections::BTreeMap;
use std::path::Path;
use time::OffsetDateTime;
use uuid::Uuid;

fn mk_block(kind: BlockKind, summary: &str) -> Block {
    Block {
        id: BlockId::new(),
        schema_version: SCHEMA_VERSION,
        kind,
        parent_id: None,
        prior_sibling_id: None,
        supersedes_id: None,
        anchor: AnchorRef::Function("apply_limiter".into()),
        intent: Intent {
            summary: summary.into(),
            detail: None,
            parent_intent: None,
        },
        declared_impacts: DeclaredImpacts::default(),
        actual_impacts: None,
        payload: BlockPayload::Command {
            command: "kubectl apply -f staging/".into(),
            shell: Some("zsh".into()),
            cwd: "/work".into(),
        },
        state: BlockState::Proposed,
        policy: None,
        provenance: Provenance {
            actor: AgentRef("did:aura:user/muhammed".into()),
            on_behalf_of: None,
            origin_host: "laptop".into(),
            signature: None,
        },
        attestations: Attestations::default(),
        created_at: OffsetDateTime::now_utc(),
        updated_at: OffsetDateTime::now_utc(),
        extensions: BTreeMap::new(),
    }
}

fn mk_op(block_id: BlockId, actor: &str, lamport: u64, payload: BlockOpPayload) -> BlockOp {
    BlockOp {
        op_id: Uuid::now_v7(),
        block_id,
        actor: AgentRef(actor.into()),
        timestamp: OffsetDateTime::now_utc(),
        lamport,
        payload,
    }
}

fn make_policy_decision(verdict: CapabilityGrade) -> PolicyDecision {
    PolicyDecision {
        verdict,
        rules_fired: vec!["test-rule".into()],
        reason: format!("{verdict:?}"),
        decided_by: AgentRef("did:aura:policy".into()),
        decided_at: OffsetDateTime::now_utc(),
        gate_reviewer: None,
    }
}

#[tokio::test]
async fn roundtrip_and_rebuild_and_subscribe_and_deselect() {
    let store = BlockStore::open(Path::new(":memory:")).expect("open store");
    let mut rx = store.subscribe();

    // ── Step 1: Proposed → Gated → (Auto) → Running → AppendOutput*3 → Completed
    let block = mk_block(BlockKind::Command, "apply limiter");
    let id = block.id;
    store.insert_block(&block).expect("insert block");

    // Policy decision attaches with Auto verdict (Proposed can transition to Gated
    // even when Auto — we want to exercise the full pipeline).
    store
        .apply_op(&mk_op(
            id,
            "did:aura:supervisor",
            1,
            BlockOpPayload::Transition {
                to: BlockState::Gated,
                reason: Some("policy review".into()),
            },
        ))
        .expect("transition gated");

    store
        .apply_op(&mk_op(
            id,
            "did:aura:policy",
            2,
            BlockOpPayload::AttachPolicy {
                decision: make_policy_decision(CapabilityGrade::Auto),
            },
        ))
        .expect("attach policy");

    store
        .apply_op(&mk_op(
            id,
            "did:aura:supervisor",
            3,
            BlockOpPayload::Transition {
                to: BlockState::Running,
                reason: None,
            },
        ))
        .expect("transition running");

    // Output stream goes through the output ring (hot path) with a flush.
    let ring = store.rings().get_or_create(id, 1024 * 1024);
    for i in 0..3 {
        let bytes_b64 = base64::engine::general_purpose::STANDARD.encode(
            format!("chunk-{i}\n").as_bytes(),
        );
        ring.append(mk_op(
            id,
            "did:aura:user/muhammed",
            10 + i,
            BlockOpPayload::AppendOutput {
                stream: "stdout".into(),
                bytes_b64,
                redactions: vec![],
            },
        ))
        .expect("ring append");
    }
    let n_flushed = store.flush_output_rings().expect("flush");
    assert_eq!(n_flushed, 3, "three output ops should persist");

    store
        .apply_op(&mk_op(
            id,
            "did:aura:supervisor",
            20,
            BlockOpPayload::Transition {
                to: BlockState::Completed,
                reason: None,
            },
        ))
        .expect("transition completed");

    // ── Step 2: Assert reduced state is what we expect.
    let final_block = store.get_block(id).expect("get").expect("some");
    assert_eq!(final_block.state, BlockState::Completed);
    assert!(final_block.policy.is_some());
    assert_eq!(
        final_block.policy.as_ref().unwrap().verdict,
        CapabilityGrade::Auto
    );

    // ── Step 3: Rebuild from ops matches reduced.
    let rebuilt = store.rebuild_block_from_ops(id).expect("rebuild");
    assert_eq!(rebuilt.state, final_block.state);
    assert_eq!(
        rebuilt.policy.as_ref().unwrap().verdict,
        final_block.policy.as_ref().unwrap().verdict
    );

    // ── Step 4: Subscribe saw the events, BlockCreated before OpApplied.
    let mut saw_block_created_first = false;
    let mut saw_any_completed = false;
    for _ in 0..40 {
        match rx.try_recv() {
            Ok(StoreEvent::BlockCreated { block_id, .. }) if block_id == id => {
                saw_block_created_first = true;
            }
            Ok(StoreEvent::OpApplied {
                block_id,
                new_state,
                ..
            }) if block_id == id => {
                assert!(
                    saw_block_created_first,
                    "OpApplied before BlockCreated for {id:?}"
                );
                if new_state == BlockState::Completed {
                    saw_any_completed = true;
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    assert!(saw_block_created_first, "BlockCreated never arrived");
    assert!(saw_any_completed, "Completed transition never broadcast");

    // ── Step 5: Deselect-to-exclude flow.
    //
    // Parent-intent block with two children. Gate approves the parent but
    // excludes child C2. Child C2 gets a supervisor-authored Supersede
    // transition; parent carries extensions["gate.excluded_children"].
    let parent = {
        let mut p = mk_block(BlockKind::Proposal, "modernize error handling");
        p.payload = BlockPayload::Proposal {
            proposed_command: "plan: 15 file edits".into(),
            alternatives: vec![],
        };
        p
    };
    let parent_id = parent.id;
    store.insert_block(&parent).expect("insert parent");

    let c1 = {
        let mut c = mk_block(BlockKind::Command, "rewrite retry_logic");
        c.parent_id = Some(parent_id);
        c
    };
    let c2 = {
        let mut c = mk_block(BlockKind::Command, "rewrite auth_middleware");
        c.parent_id = Some(parent_id);
        c
    };
    store.insert_block(&c1).expect("c1");
    store.insert_block(&c2).expect("c2");

    // Parent approval with exclusion recorded in extensions.
    store
        .apply_op(&mk_op(
            parent_id,
            "did:aura:user/muhammed",
            1,
            BlockOpPayload::SetExtension {
                key: "gate.excluded_children".into(),
                value: serde_json::json!([format!("{:?}", c2.id.0)]),
            },
        ))
        .expect("parent exclusion");
    store
        .apply_op(&mk_op(
            parent_id,
            "did:aura:policy",
            2,
            BlockOpPayload::AttachPolicy {
                decision: make_policy_decision(CapabilityGrade::Gate),
            },
        ))
        .expect("parent policy");
    store
        .apply_op(&mk_op(
            parent_id,
            "did:aura:supervisor",
            3,
            BlockOpPayload::Transition {
                to: BlockState::Gated,
                reason: Some("awaiting human".into()),
            },
        ))
        .expect("parent -> gated");
    store
        .apply_op(&mk_op(
            parent_id,
            "did:aura:supervisor",
            4,
            BlockOpPayload::Transition {
                to: BlockState::Running,
                reason: Some("approved with exclusions".into()),
            },
        ))
        .expect("parent -> running");

    // c2 is excluded → supervisor supersedes it at gate time.
    store
        .apply_op(&mk_op(
            c2.id,
            "did:aura:supervisor",
            1,
            BlockOpPayload::Transition {
                to: BlockState::Superseded,
                reason: Some("excluded at parent gate".into()),
            },
        ))
        .expect("c2 superseded");

    // c1 proceeds through normal lifecycle.
    store
        .apply_op(&mk_op(
            c1.id,
            "did:aura:supervisor",
            1,
            BlockOpPayload::Transition {
                to: BlockState::Running,
                reason: None,
            },
        ))
        .expect("c1 -> running");
    store
        .apply_op(&mk_op(
            c1.id,
            "did:aura:supervisor",
            2,
            BlockOpPayload::Transition {
                to: BlockState::Completed,
                reason: None,
            },
        ))
        .expect("c1 -> completed");

    // Audit: parent carries the exclusion list, c2 is Superseded, c1 is
    // Completed.
    let parent_after = store.get_block(parent_id).unwrap().unwrap();
    let excluded = parent_after
        .extensions
        .get("gate.excluded_children")
        .expect("excluded list present");
    assert!(excluded.as_array().map(|a| a.len()).unwrap_or(0) == 1);
    assert!(parent_after.policy.is_some());

    let c2_after = store.get_block(c2.id).unwrap().unwrap();
    assert_eq!(c2_after.state, BlockState::Superseded);

    let c1_after = store.get_block(c1.id).unwrap().unwrap();
    assert_eq!(c1_after.state, BlockState::Completed);

    // Rebuild c2 and c1 from ops — state still holds under replay.
    let c2_rebuilt = store.rebuild_block_from_ops(c2.id).unwrap();
    assert_eq!(c2_rebuilt.state, BlockState::Superseded);
    let c1_rebuilt = store.rebuild_block_from_ops(c1.id).unwrap();
    assert_eq!(c1_rebuilt.state, BlockState::Completed);
}
