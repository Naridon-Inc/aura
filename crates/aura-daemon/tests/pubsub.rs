//! W4.6 integration test: EventStream subscribes, then a block insert
//! on the shared BlockStore surfaces as a `BlockCreated` EventBody.
//!
//! Sharing the `Arc<BlockStore>` between test body and daemon is the
//! load-bearing detail — broadcast channels are per-instance, so a
//! separate path-opened `BlockStore` would have its own sender and
//! produce no events on the daemon's side.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use aura_blocks::{
    AgentRef, AnchorRef, Attestations, Block, BlockId, BlockKind, BlockOp, BlockOpPayload,
    BlockPayload, BlockState, DeclaredImpacts, Intent, Provenance, SCHEMA_VERSION,
};
use uuid::Uuid;
use aura_blockstore::BlockStore;
use aura_daemon::server::{serve, ServerConfig};
use aura_daemon_client::paths::DaemonPaths;
use aura_daemon_client::protocol::SubscribeFilter;
use aura_daemon_client::{EventBody, EventStream};
use tempfile::TempDir;
use time::OffsetDateTime;
use tokio::sync::oneshot;

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
    mk_block_kind(summary, BlockKind::Command)
}

fn mk_block_kind(summary: &str, kind: BlockKind) -> Block {
    let payload = match kind {
        BlockKind::Message => BlockPayload::Message {
            body: summary.into(),
            mentions: Vec::new(),
        },
        _ => BlockPayload::Command {
            command: "true".into(),
            shell: Some("zsh".into()),
            cwd: "/tmp".into(),
        },
    };
    Block {
        id: BlockId::new(),
        schema_version: SCHEMA_VERSION,
        kind,
        parent_id: None,
        prior_sibling_id: None,
        supersedes_id: None,
        anchor: AnchorRef::Function("pub_sub_fn".into()),
        intent: Intent {
            summary: summary.into(),
            detail: None,
            parent_intent: None,
        },
        declared_impacts: DeclaredImpacts::default(),
        actual_impacts: None,
        payload,
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

#[tokio::test]
async fn subscribe_then_insert_block_receives_block_created() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let store_path = dir.path().join("blocks.db");
    let store = Arc::new(BlockStore::open(&store_path).expect("open store"));

    let (tx, rx) = oneshot::channel::<()>();
    let srv_paths = paths.clone();
    let srv_store = store.clone();
    let server = tokio::spawn(async move {
        serve(
            ServerConfig {
                paths: srv_paths.clone(),
                daemon_build: "aura-daemon/pubsub-test".into(),
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

    let mut events = EventStream::connect(&paths, "pubsub-test")
        .await
        .expect("event stream connect");
    assert_eq!(events.handshake_ack().accepted_version, 1);

    // Insert after SubscribeAck — the daemon has already subscribed to the
    // broadcast, so this event lands on our stream.
    let b = mk_block("pubsub-test seed");
    let expected_id = b.id.0;
    store.insert_block(&b).expect("insert");

    let ev = events
        .recv_with_timeout(Duration::from_secs(2))
        .await
        .expect("recv error")
        .expect("no event within timeout");
    match ev {
        EventBody::BlockCreated { block_id, session_id } => {
            assert_eq!(block_id, expected_id);
            assert!(session_id.is_none(), "session_id is None until W6.5");
        }
        other => panic!("unexpected event: {other:?}"),
    }

    tx.send(()).unwrap();
    let _ = server.await.unwrap();
}

#[tokio::test]
async fn op_applied_event_carries_snake_case_state() {
    // Locks the wire contract: event-side `new_state` matches the serde
    // repr on BlockState (snake_case) — same string form BlockFilter.states
    // accepts and ApplyOp/BlockUpdated returns. If someone ever re-introduces
    // a `{state:?}` formatter here, this test fires.
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let store_path = dir.path().join("blocks.db");
    let store = Arc::new(BlockStore::open(&store_path).expect("open store"));

    let seed = mk_block("op-applied-wire-form");
    let block_id = seed.id;
    store.insert_block(&seed).expect("insert");

    let (tx, rx) = oneshot::channel::<()>();
    let srv_paths = paths.clone();
    let srv_store = store.clone();
    let server = tokio::spawn(async move {
        serve(
            ServerConfig {
                paths: srv_paths.clone(),
                daemon_build: "aura-daemon/pubsub-wire-form".into(),
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
    let mut events = EventStream::connect(&paths, "op-applied-wire")
        .await
        .expect("event stream connect");

    // Drain the BlockCreated event from insert_block above so we can match
    // on the OpApplied that follows.
    let _ = events
        .recv_with_timeout(Duration::from_secs(1))
        .await
        .expect("recv");

    let op = BlockOp {
        op_id: Uuid::now_v7(),
        block_id,
        actor: AgentRef("did:aura:test".into()),
        timestamp: OffsetDateTime::now_utc(),
        lamport: 1,
        payload: BlockOpPayload::Transition {
            to: BlockState::Gated,
            reason: None,
        },
    };
    store.apply_op(&op).expect("apply");

    // Pull events until we land an OpApplied (BlockCreated/SidebarCardUpdated
    // may ride along depending on insert_block).
    loop {
        let ev = events
            .recv_with_timeout(Duration::from_secs(2))
            .await
            .expect("recv err")
            .expect("no event in time");
        if let EventBody::OpApplied { new_state, .. } = ev {
            assert_eq!(new_state, "gated", "wire form must be snake_case");
            break;
        }
    }

    tx.send(()).unwrap();
    let _ = server.await.unwrap();
}

#[tokio::test]
async fn subscribe_filter_kinds_drops_non_matching_block_created() {
    // The daemon now honors `SubscribeFilter.kinds` — a client subscribing
    // with kinds=["message"] must NOT see BlockCreated events for Command
    // blocks. Before this fix every subscriber saw every event regardless
    // of filter, which would have meant the sidebar pane saw terminal
    // events, the terminal pane saw sidebar events, etc.
    //
    // The test uses a Message filter (not Command) deliberately: if the
    // daemon ignores the filter, the Command block's BlockCreated arrives
    // first (before the Message block), and the assertion on the first
    // delivered event catches the regression on the FIRST event — not
    // somewhere deep in an event stream.
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let store_path = dir.path().join("blocks.db");
    let store = Arc::new(BlockStore::open(&store_path).expect("open store"));

    let (tx, rx) = oneshot::channel::<()>();
    let srv_paths = paths.clone();
    let srv_store = store.clone();
    let server = tokio::spawn(async move {
        serve(
            ServerConfig {
                paths: srv_paths.clone(),
                daemon_build: "aura-daemon/filter-test".into(),
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

    let filter = SubscribeFilter {
        kinds: vec!["message".into()],
        session_ids: Vec::new(),
    };
    let mut events = EventStream::connect_with_filter(&paths, "filter-test", filter)
        .await
        .expect("event stream connect");
    assert_eq!(events.handshake_ack().accepted_version, 1);

    // Insert in this order: Command first (MUST be filtered out), then
    // Message (MUST arrive). If the filter is ignored the first event
    // received is the Command's BlockCreated and the assertion fires.
    let command_block = mk_block_kind("filtered-out command", BlockKind::Command);
    let message_block = mk_block_kind("should arrive", BlockKind::Message);
    let message_id = message_block.id.0;
    store.insert_block(&command_block).expect("insert command");
    store.insert_block(&message_block).expect("insert message");

    let ev = events
        .recv_with_timeout(Duration::from_secs(2))
        .await
        .expect("recv error")
        .expect("no event within timeout");
    match ev {
        EventBody::BlockCreated { block_id, .. } => {
            assert_eq!(
                block_id, message_id,
                "first BlockCreated must be the Message block; Command should have been filtered",
            );
        }
        other => panic!("unexpected first event (expected BlockCreated for Message): {other:?}"),
    }

    tx.send(()).unwrap();
    let _ = server.await.unwrap();
}

#[tokio::test]
async fn subscribe_filter_empty_kinds_passes_everything() {
    // Regression guard: an empty `kinds` list on the wire filter must be
    // pass-all, matching the documented store semantics. Otherwise the
    // default `EventStream::connect` path (which passes SubscribeFilter::
    // default()) would deliver zero events.
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let store_path = dir.path().join("blocks.db");
    let store = Arc::new(BlockStore::open(&store_path).expect("open store"));

    let (tx, rx) = oneshot::channel::<()>();
    let srv_paths = paths.clone();
    let srv_store = store.clone();
    let server = tokio::spawn(async move {
        serve(
            ServerConfig {
                paths: srv_paths.clone(),
                daemon_build: "aura-daemon/empty-filter-test".into(),
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

    let mut events = EventStream::connect(&paths, "empty-filter")
        .await
        .expect("event stream connect");

    let b = mk_block_kind("arbitrary kind passes", BlockKind::Command);
    let expected = b.id.0;
    store.insert_block(&b).expect("insert");

    let ev = events
        .recv_with_timeout(Duration::from_secs(2))
        .await
        .expect("recv error")
        .expect("no event within timeout");
    match ev {
        EventBody::BlockCreated { block_id, .. } => assert_eq!(block_id, expected),
        other => panic!("expected BlockCreated, got {other:?}"),
    }

    tx.send(()).unwrap();
    let _ = server.await.unwrap();
}
