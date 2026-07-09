//! Integration test for the Handover RPC.
//!
//! Drives the real socket path end-to-end:
//! 1. seed a block into the SQLite file the daemon will open
//! 2. spawn the daemon via `serve`
//! 3. connect a client + open a session
//! 4. call `handover("claude")`
//! 5. assert the XML reflects the seeded session + block + daemon build

use std::collections::BTreeMap;
use std::time::Duration;

use aura_blocks::{
    AgentRef, AnchorRef, Attestations, Block, BlockId, BlockKind, BlockPayload, BlockState,
    DeclaredImpacts, Intent, Provenance, SCHEMA_VERSION,
};
use aura_blockstore::BlockStore;
use aura_daemon::server::{serve, ServerConfig};
use aura_daemon_client::paths::DaemonPaths;
use aura_daemon_client::Client;
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
        state: BlockState::Completed,
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
async fn handover_rpc_end_to_end() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let store_path = dir.path().join("blocks.db");

    // Seed one block via a direct handle, then drop it before the daemon
    // opens the same file (same pattern as rpc.rs).
    {
        let store = BlockStore::open(&store_path).expect("open seed store");
        let b = seed_block("handover rpc seed");
        store.insert_block(&b).expect("insert seed");
    }

    let (tx, rx) = oneshot::channel::<()>();
    let daemon_build = "aura-daemon/handover-test".to_string();
    let cfg =
        ServerConfig::opening_at(paths.clone(), daemon_build.clone(), store_path.clone()).unwrap();
    let server = tokio::spawn(async move {
        serve(cfg, async move {
            rx.await.ok();
            Ok(())
        })
        .await
    });

    wait_for_socket(paths.socket()).await;

    let client = Client::connect(&paths, "handover-test").await.expect("connect");

    // Open a session so the handover has something to list besides blocks.
    let _sid = client
        .open_session("/work/alpha", Some("agent-a".into()))
        .await
        .unwrap();

    let xml = client.handover("claude").await.expect("handover call");

    // Root element echoes the requesting agent + the daemon build.
    assert!(
        xml.contains(r#"<aura-handover"#),
        "missing root element in:\n{xml}",
    );
    assert!(
        xml.contains(r#"agent="claude""#),
        "missing requested agent:\n{xml}",
    );
    assert!(
        xml.contains(r#"daemon_build="aura-daemon/handover-test""#),
        "missing daemon_build:\n{xml}",
    );

    // Session surface.
    assert!(
        xml.contains(r#"<sessions count="1">"#),
        "expected one session, got:\n{xml}",
    );
    assert!(
        xml.contains(r#"workspace="/work/alpha""#),
        "missing workspace attr:\n{xml}",
    );
    assert!(
        xml.contains(r#"agent="agent-a""#),
        "missing session agent:\n{xml}",
    );

    // Block surface.
    assert!(
        xml.contains(r#"<blocks total="1" returned="1">"#),
        "block counts off:\n{xml}",
    );
    assert!(
        xml.contains(r#"kind="command""#),
        "block kind missing:\n{xml}",
    );
    assert!(
        xml.contains(r#"state="completed""#),
        "block state missing:\n{xml}",
    );
    assert!(
        xml.contains("<intent>handover rpc seed</intent>"),
        "intent text missing:\n{xml}",
    );
    assert!(
        xml.contains(r#"<anchor kind="function" value="seed_fn" />"#),
        "anchor missing:\n{xml}",
    );

    // Count rollup contains the single block we seeded.
    assert!(
        xml.contains(r#"completed="1""#),
        "by_state rollup missing completed=1:\n{xml}",
    );
    assert!(
        xml.contains(r#"command="1""#),
        "by_kind rollup missing command=1:\n{xml}",
    );

    tx.send(()).unwrap();
    let _ = server.await.unwrap();
}
