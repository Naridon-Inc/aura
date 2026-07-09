//! SubmitInput RPC integration test.
//!
//! Simulates the aura-term embedding pattern: we pre-build a
//! `ServerState`, register an input sink on its router for a known
//! `SessionId`, pass the state into `ServerConfig`, and then connect
//! an external client and call `SubmitInput`. The bytes must arrive
//! on the receiver we held.
//!
//! Covers two negative paths too:
//!   - SubmitInput against an unknown session id → typed `NotFound`
//!   - receiver dropped mid-flight → typed `Unavailable`

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use aura_blockstore::BlockStore;
use aura_daemon::input::InputRouter;
use aura_daemon::server::{serve, ServerConfig};
use aura_daemon::state::ServerState;
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

fn build_state_with_router(dir: &std::path::Path) -> (Arc<ServerState>, Arc<InputRouter>) {
    let store_path = dir.join("blocks.db");
    let store = Arc::new(BlockStore::open(&store_path).expect("open store"));
    let sentinel_root: PathBuf = dir.join("sentinel");
    let router = Arc::new(InputRouter::new());
    let state = Arc::new(ServerState::new(
        store,
        sentinel_root,
        router.clone(),
    ));
    (state, router)
}

#[tokio::test]
async fn submit_input_delivers_bytes_to_registered_sink() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let (state, router) = build_state_with_router(dir.path());

    // Register the sink BEFORE serve() is reachable on the socket —
    // this is the embedding pattern aura-term uses so a client racing
    // the spawn doesn't see NotFound.
    let sid = SessionId::new();
    let mut rx = router.register(sid);

    let cfg = ServerConfig {
        paths: paths.clone(),
        daemon_build: "aura-daemon/submit-input-test".into(),
        store: state.store.clone(),
        sentinel_root: dir.path().join("sentinel"),
        input_router: router,
        state: Some(state),
    };

    let (tx, rx_shutdown) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        serve(cfg, async move {
            rx_shutdown.await.ok();
            Ok(())
        })
        .await
    });

    wait_for_socket(paths.socket()).await;

    let client = Client::connect(&paths, "submit-input-test")
        .await
        .expect("connect");

    // Happy path: bytes should arrive byte-identically on the receiver.
    let env = client
        .request(&RequestBody::SubmitInput {
            session_id: sid,
            input: "ls -la\n".into(),
        })
        .await
        .expect("request");
    assert_eq!(env.kind, MessageKind::Response);

    let got = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("receiver did not deliver")
        .expect("sink closed unexpectedly");
    assert_eq!(got, b"ls -la\n");

    tx.send(()).unwrap();
    let _ = server.await.unwrap();
}

#[tokio::test]
async fn submit_input_for_unknown_session_is_not_found() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let (state, router) = build_state_with_router(dir.path());

    let cfg = ServerConfig {
        paths: paths.clone(),
        daemon_build: "aura-daemon/submit-input-not-found".into(),
        store: state.store.clone(),
        sentinel_root: dir.path().join("sentinel"),
        input_router: router,
        state: Some(state),
    };

    let (tx, rx_shutdown) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        serve(cfg, async move {
            rx_shutdown.await.ok();
            Ok(())
        })
        .await
    });

    wait_for_socket(paths.socket()).await;

    let client = Client::connect(&paths, "submit-input-notfound-test")
        .await
        .expect("connect");

    // Nothing registered — must surface as typed NotFound.
    let env = client
        .request(&RequestBody::SubmitInput {
            session_id: SessionId::new(),
            input: "echo\n".into(),
        })
        .await
        .expect("request");
    assert_eq!(env.kind, MessageKind::Error);
    let wire: WireError = env.decode_body().unwrap();
    assert_eq!(wire.kind, ProtocolErrorKind::NotFound);
    assert!(wire.message.contains("no input sink registered"));

    tx.send(()).unwrap();
    let _ = server.await.unwrap();
}

#[tokio::test]
async fn submit_input_after_receiver_dropped_is_unavailable() {
    let dir = TempDir::new().unwrap();
    let paths = DaemonPaths::custom(dir.path());
    let (state, router) = build_state_with_router(dir.path());

    // Register a sink, then drop the receiver. The sender persists but
    // every submit fails. SubmitInput must surface this as a typed
    // Unavailable so the caller knows the PTY is gone.
    let sid = SessionId::new();
    let rx = router.register(sid);
    drop(rx);

    let cfg = ServerConfig {
        paths: paths.clone(),
        daemon_build: "aura-daemon/submit-input-unavailable".into(),
        store: state.store.clone(),
        sentinel_root: dir.path().join("sentinel"),
        input_router: router,
        state: Some(state),
    };

    let (tx, rx_shutdown) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        serve(cfg, async move {
            rx_shutdown.await.ok();
            Ok(())
        })
        .await
    });

    wait_for_socket(paths.socket()).await;

    let client = Client::connect(&paths, "submit-input-unavail-test")
        .await
        .expect("connect");

    let env = client
        .request(&RequestBody::SubmitInput {
            session_id: sid,
            input: "echo\n".into(),
        })
        .await
        .expect("request");
    assert_eq!(env.kind, MessageKind::Error);
    let wire: WireError = env.decode_body().unwrap();
    assert_eq!(wire.kind, ProtocolErrorKind::Unavailable);
    assert!(wire.message.contains("closed"));

    tx.send(()).unwrap();
    let _ = server.await.unwrap();
}
