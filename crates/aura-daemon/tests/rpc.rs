//! W4.5 integration test: typed RPC round-trip.
//!
//! Covers: OpenSession → ListSessions → CloseSession, GetBlock hit,
//! GetBlock miss (typed NotFound). Insertion happens via a standalone
//! `BlockStore` opened at the same SQLite path as the daemon's store —
//! a detail W5 will retire once ApplyOp lands on the daemon side.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use aura_blocks::{
    AgentRef, AnchorRef, Attestations, Block, BlockId, BlockKind, BlockPayload, BlockState,
    DeclaredImpacts, Intent, Provenance, SCHEMA_VERSION,
};
use aura_blockstore::BlockStore;
use aura_daemon::server::{serve, ServerConfig};
use aura_daemon_client::error::ProtocolErrorKind;
use aura_daemon_client::paths::DaemonPaths;
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

fn seed_block(summary: &str) -> Block {
    Block {
        id: BlockId::new(),
        schema_version: SCHEMA_VERSION,
        kind: BlockKind::Command,
        parent_id: None,
        prior_sibling_id: None,
        supersedes_id: None,
        anchor: AnchorRef::Function("seed_fn".into()),
        intent: Intent {
            summary: summary.into(),
            detail: None,
            parent_intent: None,
        },
        declared_impacts: DeclaredImpacts::default(),
        actual_impacts: None,
        payload: BlockPayload::Command {
            command: "echo hello".into(),
            shell: Some("zsh".into()),
            cwd: "/tmp".into(),
        },
        state: BlockState::Proposed,
        policy: None,
        provenance: Provenance {
            actor: AgentRef("did:aura:test".into()),
            on_behalf_of: None,
            origin_host: "test-host".into(),
            signature: None,
        },
        attestations: Attestations::default(),
        created_at: OffsetDateTime::now_utc(),
        updated_at: OffsetDateTime::now_utc(),
        extensions: BTreeMap::new(),
    }
}

#[tokio::test]
async fn session_lifecycle_and_get_block_round_trip() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let store_path = dir.path().join("blocks.db");

    // Pre-seed a block through a direct BlockStore handle sharing the
    // daemon's DB file. Writing then dropping the handle closes the
    // connection before the daemon opens its own — SQLite is happy to
    // share the file across handles but the daemon's reducer is the
    // only writer post-startup (a constraint W5 formalises).
    {
        let store = BlockStore::open(&store_path).expect("open seed store");
        let b = seed_block("session-lifecycle seed");
        store.insert_block(&b).expect("insert seed");
    }

    let (tx, rx) = oneshot::channel::<()>();
    let srv_paths = paths.clone();
    let srv_store_path = store_path.clone();
    let cfg =
        ServerConfig::opening_at(srv_paths, "aura-daemon/rpc-test".into(), srv_store_path).unwrap();
    let server = tokio::spawn(async move {
        serve(cfg, async move {
            rx.await.ok();
            Ok(())
        })
        .await
    });

    wait_for_socket(paths.socket()).await;

    let client = Client::connect(&paths, "rpc-test").await.expect("connect");

    // ── Sessions ────────────────────────────────────────────────────────
    assert!(client.list_sessions().await.unwrap().is_empty());

    let s1 = client
        .open_session("/work/alpha", Some("agent-a".into()))
        .await
        .unwrap();
    let s2 = client
        .open_session("/work/beta", None)
        .await
        .unwrap();

    let mut listed = client.list_sessions().await.unwrap();
    listed.sort_by_key(|s| s.0.as_u128());
    let mut expected = vec![s1, s2];
    expected.sort_by_key(|s| s.0.as_u128());
    assert_eq!(listed, expected);

    client.close_session(s1).await.unwrap();
    let after_close = client.list_sessions().await.unwrap();
    assert_eq!(after_close, vec![s2]);

    // Closing an unknown id must return NotFound (typed).
    let missing = aura_daemon_client::protocol::SessionId::new();
    let err = match client.close_session(missing).await {
        Err(e) => e,
        Ok(_) => panic!("closing unknown session must fail"),
    };
    assert_eq!(err.kind, ProtocolErrorKind::NotFound);

    // ── GetBlock (found) ────────────────────────────────────────────────
    // Pull the seeded block id from our standalone reader.
    let store_ro = BlockStore::open(Path::new(&store_path)).unwrap();
    let any = store_ro
        .list_blocks(&aura_blockstore::BlockFilter::default())
        .unwrap();
    assert_eq!(any.len(), 1);
    let seeded_id = any[0].id.0;

    let bytes = client.get_block_raw(seeded_id).await.unwrap();
    let fetched: Block = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(fetched.id.0, seeded_id);
    assert_eq!(fetched.intent.summary, "session-lifecycle seed");

    // ── GetBlock (miss) — typed NotFound ────────────────────────────────
    let nowhere = Uuid::now_v7();
    let err = match client.get_block_raw(nowhere).await {
        Err(e) => e,
        Ok(_) => panic!("missing block must error"),
    };
    assert_eq!(err.kind, ProtocolErrorKind::NotFound);

    tx.send(()).unwrap();
    let _ = server.await.unwrap();
}
