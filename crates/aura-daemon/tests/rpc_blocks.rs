//! W5.1 integration tests: ListBlocks + ApplyOp RPC round-trips.
//!
//! These close out the last remaining Unavailable RPCs the UI rewire (W5)
//! needs: pulling a filtered block feed, and submitting a reducer op
//! from a client process. Errors exercised: reducer domain errors
//! (illegal transition) and NotFound (op on a missing block).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use aura_blocks::{
    AgentRef, AnchorRef, Attestations, Block, BlockId, BlockKind, BlockOp, BlockOpPayload,
    BlockPayload, BlockState, DeclaredImpacts, Intent, Provenance, SCHEMA_VERSION,
};
use aura_blockstore::BlockStore;
use aura_daemon::server::{serve, ServerConfig};
use aura_daemon_client::error::ProtocolErrorKind;
use aura_daemon_client::paths::DaemonPaths;
use aura_daemon_client::protocol::BlockFilter;
use aura_daemon_client::Client;
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

fn mk_block(summary: &str) -> Block {
    Block {
        id: BlockId::new(),
        schema_version: SCHEMA_VERSION,
        kind: BlockKind::Command,
        parent_id: None,
        prior_sibling_id: None,
        supersedes_id: None,
        anchor: AnchorRef::Function("rpc_blocks_fn".into()),
        intent: Intent {
            summary: summary.into(),
            detail: None,
            parent_intent: None,
        },
        declared_impacts: DeclaredImpacts::default(),
        actual_impacts: None,
        payload: BlockPayload::Command {
            command: "true".into(),
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

fn mk_op(block_id: BlockId, to: BlockState, lamport: u64) -> BlockOp {
    BlockOp {
        op_id: Uuid::now_v7(),
        block_id,
        actor: AgentRef("did:aura:test".into()),
        timestamp: OffsetDateTime::now_utc(),
        lamport,
        payload: BlockOpPayload::Transition { to, reason: None },
    }
}

async fn spawn_daemon(
    paths: DaemonPaths,
    store: Arc<BlockStore>,
) -> (
    tokio::task::JoinHandle<Result<(), aura_daemon_client::error::ProtocolError>>,
    oneshot::Sender<()>,
) {
    let (tx, rx) = oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        serve(
            ServerConfig {
                paths: paths.clone(),
                daemon_build: "aura-daemon/rpc-blocks-test".into(),
                store,
                sentinel_root: paths.dir().join("sentinel"),
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
    (handle, tx)
}

#[tokio::test]
async fn list_blocks_returns_seeded_blocks() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let store_path = dir.path().join("blocks.db");
    let store = Arc::new(BlockStore::open(&store_path).expect("open store"));

    let a = mk_block("first");
    let b = mk_block("second");
    store.insert_block(&a).expect("seed a");
    store.insert_block(&b).expect("seed b");

    let (server, shutdown) = spawn_daemon(paths.clone(), store.clone()).await;
    wait_for_socket(paths.socket()).await;
    let client = Client::connect(&paths, "list-test").await.expect("connect");

    let raw = client
        .list_blocks_raw(BlockFilter::default())
        .await
        .expect("list");
    let blocks: Vec<Block> = serde_json::from_slice(&raw).expect("decode list");
    assert_eq!(blocks.len(), 2);
    let summaries: Vec<_> = blocks.iter().map(|b| b.intent.summary.clone()).collect();
    assert!(summaries.contains(&"first".to_string()));
    assert!(summaries.contains(&"second".to_string()));

    shutdown.send(()).unwrap();
    let _ = server.await.unwrap();
}

#[tokio::test]
async fn list_blocks_narrows_by_kind_and_state() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let store_path = dir.path().join("blocks.db");
    let store = Arc::new(BlockStore::open(&store_path).expect("open store"));

    let b = mk_block("narrow-by-kind");
    store.insert_block(&b).expect("seed");

    let (server, shutdown) = spawn_daemon(paths.clone(), store.clone()).await;
    wait_for_socket(paths.socket()).await;
    let client = Client::connect(&paths, "list-filter").await.expect("connect");

    // Matching kind — hit.
    let hits = client
        .list_blocks_raw(BlockFilter {
            kinds: vec!["command".into()],
            states: vec!["proposed".into()],
            ..Default::default()
        })
        .await
        .expect("list hit");
    let hits: Vec<Block> = serde_json::from_slice(&hits).unwrap();
    assert_eq!(hits.len(), 1);

    // Non-matching state — miss.
    let misses = client
        .list_blocks_raw(BlockFilter {
            states: vec!["completed".into()],
            ..Default::default()
        })
        .await
        .expect("list miss");
    let misses: Vec<Block> = serde_json::from_slice(&misses).unwrap();
    assert!(misses.is_empty());

    // Non-matching kind — miss. Guards against a silently-broken
    // parse_kind (previously returned None for every input because
    // BlockKind is serde-internally-tagged, not a bare string enum —
    // the "None = pass-all" semantic would have made the kind filter
    // invisible without this assertion).
    let wrong_kind = client
        .list_blocks_raw(BlockFilter {
            kinds: vec!["message".into()],
            ..Default::default()
        })
        .await
        .expect("list wrong-kind");
    let wrong_kind: Vec<Block> = serde_json::from_slice(&wrong_kind).unwrap();
    assert!(
        wrong_kind.is_empty(),
        "parse_kind must produce a real BlockKind so unmatched kinds narrow to empty",
    );

    shutdown.send(()).unwrap();
    let _ = server.await.unwrap();
}

#[tokio::test]
async fn apply_op_happy_path_transitions_block() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let store_path = dir.path().join("blocks.db");
    let store = Arc::new(BlockStore::open(&store_path).expect("open store"));

    let b = mk_block("apply-op-happy");
    let block_id = b.id;
    store.insert_block(&b).expect("seed");

    let (server, shutdown) = spawn_daemon(paths.clone(), store.clone()).await;
    wait_for_socket(paths.socket()).await;
    let client = Client::connect(&paths, "apply-ok").await.expect("connect");

    let op = mk_op(block_id, BlockState::Gated, 1);
    let op_json = serde_json::to_vec(&op).unwrap();
    let (ret_id, new_state) = client.apply_op_raw(op_json).await.expect("apply ok");
    assert_eq!(ret_id, block_id.0);
    assert_eq!(new_state, "gated");

    // Round-trip the reduced block via GetBlock to confirm the daemon's
    // store actually updated — not just that the RPC returned.
    let fetched_raw = client.get_block_raw(block_id.0).await.unwrap();
    let fetched: Block = serde_json::from_slice(&fetched_raw).unwrap();
    assert!(matches!(fetched.state, BlockState::Gated));

    shutdown.send(()).unwrap();
    let _ = server.await.unwrap();
}

#[tokio::test]
async fn apply_op_illegal_transition_returns_domain_error() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let store_path = dir.path().join("blocks.db");
    let store = Arc::new(BlockStore::open(&store_path).expect("open store"));

    let b = mk_block("apply-op-illegal");
    let block_id = b.id;
    store.insert_block(&b).expect("seed");

    let (server, shutdown) = spawn_daemon(paths.clone(), store.clone()).await;
    wait_for_socket(paths.socket()).await;
    let client = Client::connect(&paths, "apply-illegal")
        .await
        .expect("connect");

    // Proposed → Completed is not a legal single-step transition; the FSM
    // enforces Proposed → Gated → Running → Completed.
    let op = mk_op(block_id, BlockState::Completed, 1);
    let op_json = serde_json::to_vec(&op).unwrap();
    let err = match client.apply_op_raw(op_json).await {
        Err(e) => e,
        Ok(_) => panic!("illegal transition must error"),
    };
    assert_eq!(err.kind, ProtocolErrorKind::Domain);
    assert!(
        err.message.to_lowercase().contains("reducer")
            || err.message.to_lowercase().contains("transition"),
        "message: {}",
        err.message
    );

    shutdown.send(()).unwrap();
    let _ = server.await.unwrap();
}

#[tokio::test]
async fn apply_op_on_missing_block_returns_not_found() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let store_path = dir.path().join("blocks.db");
    let store = Arc::new(BlockStore::open(&store_path).expect("open store"));

    let (server, shutdown) = spawn_daemon(paths.clone(), store.clone()).await;
    wait_for_socket(paths.socket()).await;
    let client = Client::connect(&paths, "apply-miss").await.expect("connect");

    let op = mk_op(BlockId::new(), BlockState::Gated, 1);
    let op_json = serde_json::to_vec(&op).unwrap();
    let err = match client.apply_op_raw(op_json).await {
        Err(e) => e,
        Ok(_) => panic!("applying op to missing block must error"),
    };
    assert_eq!(err.kind, ProtocolErrorKind::NotFound);

    shutdown.send(()).unwrap();
    let _ = server.await.unwrap();
}

/// S2-ER wire test: confirms the new BlockFilter fields (actor,
/// anchor_kind, anchor_value, since_ms, until_ms) round-trip through the
/// daemon RPC and narrow results the same way the in-process store
/// filter does. Without this, the listener.rs pass-through could silently
/// drop a field and the failure would only surface in production.
#[tokio::test]
async fn list_blocks_narrows_by_actor_anchor_and_time_range() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let store_path = dir.path().join("blocks.db");
    let store = Arc::new(BlockStore::open(&store_path).expect("open store"));

    // Seed three blocks that differ on each filter axis. Using explicit
    // updated_at timestamps lets the time-range assertion be exact rather
    // than wall-clock-relative.
    let make = |actor: &str, anchor: AnchorRef, ms: i64| {
        let mut b = mk_block("recall-seed");
        b.id = BlockId::new();
        b.provenance.actor = AgentRef(actor.into());
        b.anchor = anchor;
        let t = OffsetDateTime::from_unix_timestamp_nanos((ms as i128) * 1_000_000).unwrap();
        b.created_at = t;
        b.updated_at = t;
        b
    };
    let claude = make(
        "did:aura:agent/claude",
        AnchorRef::Function("apply_limiter".into()),
        2_000,
    );
    let other_actor = make(
        "did:aura:agent/codex",
        AnchorRef::Function("apply_limiter".into()),
        2_000,
    );
    let other_anchor = make(
        "did:aura:agent/claude",
        AnchorRef::File("src/lib.rs".into()),
        2_000,
    );
    let too_old = make(
        "did:aura:agent/claude",
        AnchorRef::Function("apply_limiter".into()),
        500,
    );
    store.insert_block(&claude).expect("seed claude");
    store.insert_block(&other_actor).expect("seed other actor");
    store.insert_block(&other_anchor).expect("seed other anchor");
    store.insert_block(&too_old).expect("seed too old");

    let (server, shutdown) = spawn_daemon(paths.clone(), store.clone()).await;
    wait_for_socket(paths.socket()).await;
    let client = Client::connect(&paths, "list-recall").await.expect("connect");

    // actor + anchor (kind+value) + since_ms must collapse to exactly the
    // claude/apply_limiter/2000ms row.
    let raw = client
        .list_blocks_raw(BlockFilter {
            actor: Some("did:aura:agent/claude".into()),
            anchor_kind: Some("function".into()),
            anchor_value: Some("apply_limiter".into()),
            since_ms: Some(1_000),
            ..Default::default()
        })
        .await
        .expect("list");
    let hits: Vec<Block> = serde_json::from_slice(&raw).expect("decode list");
    assert_eq!(hits.len(), 1, "filters must AND together: {hits:?}");
    assert!(matches!(&hits[0].anchor, AnchorRef::Function(s) if s == "apply_limiter"));
    assert_eq!(hits[0].provenance.actor.0, "did:aura:agent/claude");

    // until_ms drops the 2000ms rows entirely; only the 500ms row survives
    // (claude/apply_limiter/500ms == too_old).
    let raw_until = client
        .list_blocks_raw(BlockFilter {
            until_ms: Some(1_000),
            ..Default::default()
        })
        .await
        .expect("list until");
    let until_hits: Vec<Block> = serde_json::from_slice(&raw_until).unwrap();
    assert_eq!(until_hits.len(), 1);
    assert_eq!(until_hits[0].id, too_old.id);

    shutdown.send(()).unwrap();
    let _ = server.await.unwrap();
}
