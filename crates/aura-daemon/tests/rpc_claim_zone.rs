//! ClaimZone RPC integration test.
//!
//! End-to-end: client claims a path, daemon writes a ZoneRule JSON to
//! `<sentinel_root>/zones/`, assert the file exists and its contents
//! match the aura-cli ZoneRule schema.

use std::path::PathBuf;
use std::time::Duration;

use aura_blockstore::BlockStore;
use aura_daemon::sentinel::{ZoneMode, ZoneRule};
use aura_daemon::server::{serve, ServerConfig};
use aura_daemon_client::paths::DaemonPaths;
use aura_daemon_client::Client;
use tempfile::TempDir;
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

#[tokio::test]
async fn claim_zone_writes_warn_mode_rule_to_disk() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let store_path = dir.path().join("blocks.db");
    let sentinel_root: PathBuf = dir.path().join("sentinel");

    let store = BlockStore::open(&store_path).expect("open store");
    let cfg = ServerConfig {
        paths: paths.clone(),
        daemon_build: "aura-daemon/claim-zone-test".into(),
        store: std::sync::Arc::new(store),
        sentinel_root: sentinel_root.clone(),
                input_router: std::sync::Arc::new(aura_daemon::input::InputRouter::new()),
                state: None,
    };

    let (tx, rx) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        serve(cfg, async move {
            rx.await.ok();
            Ok(())
        })
        .await
    });

    wait_for_socket(paths.socket()).await;

    let client = Client::connect(&paths, "aura-term/0.1.0-test")
        .await
        .expect("connect");

    let echoed = client
        .claim_zone("src/foo.rs")
        .await
        .expect("claim ok");
    assert!(echoed.starts_with("src/foo.rs (zone_id=zone-"));

    // Exactly one zone file should exist; decode it and assert shape.
    let zones_dir = sentinel_root.join("zones");
    let mut entries: Vec<_> = std::fs::read_dir(&zones_dir)
        .expect("zones dir")
        .filter_map(|e| e.ok())
        .collect();
    assert_eq!(entries.len(), 1, "exactly one zone written");
    let path = entries.pop().unwrap().path();
    let raw = std::fs::read_to_string(&path).expect("zone file");
    let zone: ZoneRule = serde_json::from_str(&raw).expect("zone decode");
    assert_eq!(zone.patterns, vec!["src/foo.rs".to_string()]);
    assert_eq!(zone.mode, ZoneMode::Warn);
    assert!(zone.zone_id.starts_with("zone-"));
    // session_id is the connection UUID string.
    uuid::Uuid::parse_str(&zone.session_id).expect("session_id is uuid");

    tx.send(()).unwrap();
    let _ = server.await.unwrap();
}
