//! End-to-end integration test: spawn the daemon via the in-process
//! `serve()` entrypoint, connect with the real `Client` over a Unix
//! socket at a tempdir path, assert the handshake completes.
//!
//! Why this shape over spawning the binary: deterministic, no PATH
//! assumptions, no orphan processes if the test panics. The binary is
//! a thin main() around the same `serve()` we call here.

use std::time::Duration;

use aura_daemon::server::{serve, ServerConfig};
use aura_daemon_client::envelope::MessageKind;
use aura_daemon_client::error::{ProtocolErrorKind, WireError};
use aura_daemon_client::paths::DaemonPaths;
use aura_daemon_client::protocol::{RequestBody, SessionId};
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
async fn handshake_and_unavailable_post_handshake() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let (tx, rx) = oneshot::channel::<()>();

    let srv_paths = paths.clone();
    let store_path = dir.path().join("blocks.db");
    let cfg =
        ServerConfig::opening_at(srv_paths, "aura-daemon/integration".into(), store_path).unwrap();
    let server = tokio::spawn(async move {
        serve(cfg, async move {
            rx.await.ok();
            Ok(())
        })
        .await
    });

    // ── first test body ──
    wait_for_socket(paths.socket()).await;

    let client = Client::connect(&paths, "aura-term/integration")
        .await
        .expect("client connect");
    let ack = client.handshake_ack();
    assert_eq!(ack.accepted_version, 1);
    assert_eq!(ack.daemon_build, "aura-daemon/integration");
    assert!(!ack.connection_id.is_nil());

    // SubmitInput is wired — the dispatcher looks up a sink keyed by
    // session_id in the shared InputRouter, and returns NotFound when
    // nothing is registered. That's the right shape here (no PTY owner
    // attached to this tempdir-backed daemon) and the assertion proves
    // the variant reaches the dispatcher rather than getting dropped.
    let env = client
        .request(&RequestBody::SubmitInput {
            session_id: SessionId::new(),
            input: "echo".into(),
        })
        .await
        .unwrap();
    assert_eq!(env.kind, MessageKind::Error);
    let wire: WireError = env.decode_body().unwrap();
    assert_eq!(wire.kind, ProtocolErrorKind::NotFound);
    assert!(wire.message.contains("no input sink"));

    tx.send(()).unwrap();
    let _ = server.await.unwrap();

    // Socket should be cleaned up on shutdown.
    assert!(!tokio::fs::try_exists(paths.socket()).await.unwrap_or(true));
}

#[tokio::test]
async fn bad_secret_fails_handshake() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let (tx, rx) = oneshot::channel::<()>();

    let srv_paths = paths.clone();
    let store_path = dir.path().join("blocks.db");
    let cfg = ServerConfig::opening_at(
        srv_paths,
        "aura-daemon/bad-secret-test".into(),
        store_path,
    )
    .unwrap();
    let server = tokio::spawn(async move {
        serve(cfg, async move {
            rx.await.ok();
            Ok(())
        })
        .await
    });

    wait_for_socket(paths.socket()).await;

    // Overwrite the keyfile client-side with a wrong 32-byte blob.
    tokio::fs::write(paths.keyfile(), vec![0xFF; 32])
        .await
        .unwrap();

    let err = match Client::connect(&paths, "bad-client").await {
        Err(e) => e,
        Ok(_) => panic!("wrong secret must fail"),
    };
    assert_eq!(err.kind, ProtocolErrorKind::Handshake);

    tx.send(()).unwrap();
    let _ = server.await.unwrap();
}
