//! SendMessage RPC integration test.
//!
//! Drives the real socket path end-to-end:
//!   1. spawn the daemon with a tempdir sentinel root
//!   2. client sends a DM and a broadcast
//!   3. assert the JSON files on disk match aura-cli's wire shape
//!   4. assert the unread-marker is touched

use std::path::PathBuf;
use std::time::Duration;

use aura_blockstore::BlockStore;
use aura_daemon::sentinel::SentinelMessage;
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
async fn send_message_writes_dm_and_broadcast_to_disk() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let store_path = dir.path().join("blocks.db");
    let sentinel_root: PathBuf = dir.path().join("sentinel");

    let store = BlockStore::open(&store_path).expect("open store");
    let cfg = ServerConfig {
        paths: paths.clone(),
        daemon_build: "aura-daemon/send-message-test".into(),
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

    let dm_id = client
        .send_message("session-bob", "hello bob")
        .await
        .expect("dm send");
    assert!(dm_id.starts_with("msg-"), "id shape: {dm_id}");

    // Broadcast: empty target means "to all".
    let bcast_id = client
        .send_message("", "ping everyone")
        .await
        .expect("broadcast send");
    assert_ne!(dm_id, bcast_id);

    // The mailbox directory now holds both messages. Read them back via
    // the same struct aura-cli uses — schema compatibility is the point
    // of this RPC, so we validate by decoding with the canonical shape.
    let messages_dir = sentinel_root.join("messages");
    let dm_path = messages_dir.join(format!("{dm_id}.json"));
    let dm_raw = std::fs::read_to_string(&dm_path).expect("dm file");
    let dm: SentinelMessage = serde_json::from_str(&dm_raw).expect("dm decode");
    assert_eq!(dm.to_session.as_deref(), Some("session-bob"));
    assert_eq!(dm.content, "hello bob");
    assert_eq!(dm.from_agent, "aura-term/0.1.0-test");
    // from_session is the connection id — a valid UUID string.
    uuid::Uuid::parse_str(&dm.from_session).expect("from_session is a uuid");
    // Sender is in read_by so inbox filters don't show it as new.
    assert!(dm.read_by.contains(&dm.from_session));

    let bcast_path = messages_dir.join(format!("{bcast_id}.json"));
    let bcast_raw = std::fs::read_to_string(&bcast_path).expect("broadcast file");
    let bcast: SentinelMessage = serde_json::from_str(&bcast_raw).expect("bcast decode");
    assert!(bcast.to_session.is_none());
    assert_eq!(bcast.content, "ping everyone");

    // Unread marker exists.
    assert!(sentinel_root.join("unread_pending").exists());

    tx.send(()).unwrap();
    let _ = server.await.unwrap();
}
