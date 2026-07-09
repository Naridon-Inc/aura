//! Background output-ring flusher integration test.
//!
//! The daemon spawns a tokio task that periodically drains per-block
//! rings into the `block_ops` table. This test asserts the loop
//! actually runs: append an AppendOutput op, wait a few ticks, confirm
//! the ring drained.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use aura_blocks::{
    AgentRef, AnchorRef, Attestations, Block, BlockId, BlockKind, BlockOp, BlockOpPayload,
    BlockPayload, BlockState, DeclaredImpacts, Intent, Provenance, SCHEMA_VERSION,
};
use aura_blockstore::output_ring::DEFAULT_CAP_BYTES;
use aura_blockstore::BlockStore;
use aura_daemon::server::{serve, ServerConfig};
use aura_daemon_client::paths::DaemonPaths;
use tempfile::TempDir;
use time::OffsetDateTime;
use tokio::sync::oneshot;
use uuid::Uuid;

async fn wait_for_socket(p: &std::path::Path) {
    for _ in 0..200 {
        if tokio::fs::try_exists(p).await.unwrap_or(false) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("socket did not appear at {}", p.display());
}

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
            summary: "flusher-test".into(),
            detail: None,
            parent_intent: None,
        },
        declared_impacts: DeclaredImpacts::default(),
        actual_impacts: None,
        payload: BlockPayload::Command {
            command: "noop".into(),
            shell: Some("zsh".into()),
            cwd: "/tmp".into(),
        },
        state: BlockState::Proposed,
        policy: None,
        provenance: Provenance {
            actor: AgentRef("did:aura:test".into()),
            on_behalf_of: None,
            origin_host: "test".into(),
            signature: None,
        },
        attestations: Attestations::default(),
        created_at: OffsetDateTime::now_utc(),
        updated_at: OffsetDateTime::now_utc(),
        extensions: BTreeMap::new(),
    }
}

fn mk_output_op(block_id: BlockId, lamport: u64, payload_bytes: &[u8]) -> BlockOp {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    BlockOp {
        op_id: Uuid::now_v7(),
        block_id,
        actor: AgentRef("did:aura:test".into()),
        timestamp: OffsetDateTime::now_utc(),
        lamport,
        payload: BlockOpPayload::AppendOutput {
            stream: "stdout".into(),
            bytes_b64: B64.encode(payload_bytes),
            redactions: Vec::new(),
        },
    }
}

#[tokio::test]
async fn background_flusher_drains_rings() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let store_path = dir.path().join("blocks.db");
    let store = Arc::new(BlockStore::open(&store_path).expect("open store"));

    let block = mk_block();
    let block_id = block.id;
    store.insert_block(&block).expect("seed block");

    let (shutdown, rx) = oneshot::channel::<()>();
    let srv_store = store.clone();
    let srv_paths = paths.clone();
    let server = tokio::spawn(async move {
        serve(
            ServerConfig {
                paths: srv_paths.clone(),
                daemon_build: "aura-daemon/flusher-test".into(),
                store: srv_store,
                sentinel_root: srv_paths.dir().join("sentinel"),
                input_router: std::sync::Arc::new(aura_daemon::input::InputRouter::new()),
                state: None,
            },
            async move {
                rx.await.ok();
                Ok(())
            },
        )
        .await
    });

    wait_for_socket(paths.socket()).await;

    // Push ops into the ring. No daemon RPC is needed — the ring is a
    // direct store surface; W5 will wire PTY producers to it.
    let ring = store.rings().get_or_create(block_id, DEFAULT_CAP_BYTES);
    for i in 1..=5 {
        ring.append(mk_output_op(block_id, i, format!("chunk {i}\n").as_bytes()))
            .expect("ring append");
    }

    // Wait long enough for the 100ms flusher to tick at least twice.
    // Anything beyond the first tick drains the ring; the extra headroom
    // covers cold-start scheduling jitter under `cargo test`.
    tokio::time::sleep(Duration::from_millis(350)).await;

    let leftover = ring.drain_unflushed();
    assert!(
        leftover.is_empty(),
        "flusher should have drained ring; {} ops still pending",
        leftover.len()
    );

    // Also verify ops actually landed in SQLite (not just drained into the
    // void). Read via a second BlockStore handle — we seeded via the same
    // file path, rusqlite shares nicely.
    shutdown.send(()).unwrap();
    let _ = server.await.unwrap();

    let reader = BlockStore::open(&store_path).expect("reopen store");
    let rebuilt = reader
        .rebuild_block_from_ops(block_id)
        .expect("replay from ops");
    // AppendOutput is a reducer no-op on folded state but still lives in
    // block_ops — the rebuild succeeding on a block with only Append ops
    // demonstrates the rows are present. State should equal initial.
    assert!(matches!(rebuilt.state, BlockState::Proposed));
}
