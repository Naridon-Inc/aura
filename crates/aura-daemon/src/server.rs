//! Top-level server lifecycle: prep directory, write/load keyfile, open
//! blockstore, bind socket (0600), accept loop, graceful shutdown.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use aura_blockstore::BlockStore;
use tokio::net::UnixListener;
use tracing::{debug, info, warn};

/// How often the output-ring flusher wakes to drain unflushed AppendOutput
/// ops into SQLite. Matches the ~100ms debounce target from the W3 plan:
/// long enough that 10k ops/30s batches efficiently, short enough that
/// a crash after a busy PTY burst loses at most ~100ms of tail output.
const FLUSH_INTERVAL: Duration = Duration::from_millis(100);

use aura_daemon_client::error::ProtocolError;
#[cfg(not(unix))]
use aura_daemon_client::error::ProtocolErrorKind;
use aura_daemon_client::paths::DaemonPaths;

use crate::input::InputRouter;
use crate::keyfile::{ensure_dir, load_or_create};
use crate::listener::{handle_connection, ConnContext};
use crate::state::ServerState;

pub struct ServerConfig {
    pub paths: DaemonPaths,
    pub daemon_build: String,
    /// Shared blockstore handle. Tests that want to observe / seed state
    /// from outside the daemon pass the same `Arc` they opened.
    pub store: Arc<BlockStore>,
    /// Root directory where Sentinel mailbox files land. The standard
    /// layout is `<root>/messages/*.json` + `<root>/unread_pending`.
    /// aura-term passes `<cwd>/.aura/sentinel` so its daemon shares the
    /// mailbox with the aura-cli in the same worktree.
    pub sentinel_root: PathBuf,
    /// Shared input router. aura-term keeps a handle on the outside so
    /// it can register PTY sinks; external callers reach the same
    /// router via `SubmitInput` dispatched through `ServerState`. Tests
    /// and binary callers that don't need to register sinks externally
    /// can rely on `opening_at` / `with_default_blockstore` to populate
    /// a fresh router.
    pub input_router: Arc<InputRouter>,
    /// Optional pre-built state. Embedders (aura-term) construct
    /// `ServerState` themselves so they can call `open_session` and
    /// `input_router.register` *before* the daemon starts listening —
    /// that way a `SubmitInput` racing the first client sees a populated
    /// sink, not a `NotFound`. `None` is the standalone-binary path;
    /// serve() builds state from `store` + `sentinel_root` +
    /// `input_router` on entry.
    pub state: Option<Arc<ServerState>>,
}

impl ServerConfig {
    /// Open a fresh blockstore at `blockstore_path` and wrap it in `Arc`.
    /// Main binary path; tests that need to share a store with the test
    /// body construct `ServerConfig { store: Arc::new(...), .. }` directly.
    pub fn opening_at(
        paths: DaemonPaths,
        daemon_build: String,
        blockstore_path: PathBuf,
    ) -> Result<Self, ProtocolError> {
        let store = BlockStore::open(&blockstore_path).map_err(|e| {
            ProtocolError::new(
                aura_daemon_client::error::ProtocolErrorKind::Unavailable,
                format!("blockstore open failed: {e}"),
            )
        })?;
        let sentinel_root = paths.dir().join("sentinel");
        Ok(Self {
            paths,
            daemon_build,
            store: Arc::new(store),
            sentinel_root,
            input_router: Arc::new(InputRouter::new()),
            state: None,
        })
    }

    /// Convenience: blockstore path = `<paths.dir>/blocks.db`.
    pub fn with_default_blockstore(
        paths: DaemonPaths,
        daemon_build: String,
    ) -> Result<Self, ProtocolError> {
        let blockstore_path = paths.dir().join("blocks.db");
        Self::opening_at(paths, daemon_build, blockstore_path)
    }
}

pub async fn serve<F>(cfg: ServerConfig, shutdown: F) -> Result<(), ProtocolError>
where
    F: Future<Output = std::io::Result<()>>,
{
    ensure_dir(cfg.paths.dir()).await?;
    let secret = Arc::new(load_or_create(cfg.paths.keyfile()).await?);
    let daemon_build = Arc::new(cfg.daemon_build);

    let state = cfg.state.unwrap_or_else(|| {
        Arc::new(ServerState::new(
            cfg.store,
            cfg.sentinel_root,
            cfg.input_router,
        ))
    });

    let socket_path = cfg.paths.socket().to_path_buf();
    remove_stale(&socket_path).await?;

    let listener = UnixListener::bind(&socket_path).map_err(ProtocolError::from_io)?;
    apply_socket_mode(&socket_path)?;
    info!(socket = %socket_path.display(), "listening");

    let ctx = ConnContext {
        secret: secret.clone(),
        daemon_build: daemon_build.clone(),
        state: state.clone(),
    };

    // Background flusher. AppendOutput ops accumulate in per-block rings
    // (hot path: ~10k ops/30s under a busy PTY) and must periodically
    // persist into `block_ops` so crash recovery + cross-machine replay
    // see them. Without this task, the ops sit in memory forever — a
    // real bug the UI would hit the moment W5 wires up PTY → ring flow.
    let flusher_store = state.store.clone();
    let flusher = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            match flusher_store.flush_output_rings() {
                Ok(0) => {}
                Ok(n) => debug!(persisted = n, "output ring flush"),
                Err(e) => warn!(error = %e, "output ring flush failed; retrying next tick"),
            }
        }
    });

    // W4 — scheduled memory consolidation: every 30 minutes, run
    // `aura memory consolidate` in each workspace the daemon knows about
    // (sentinel-derived repo + open-session workspaces). Same code path as
    // the manual CLI verb; fail-quiet — a keyless cycle or a missing CLI
    // binary just means nothing happens until the next tick. The first
    // (immediate) interval tick is consumed so the pass starts one full
    // period after boot instead of racing daemon startup.
    let consolidate_state = state.clone();
    let consolidator = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(crate::consolidate::CONSOLIDATE_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await; // consume the immediate tick
        loop {
            ticker.tick().await;
            crate::consolidate::run_pass(&consolidate_state).await;
        }
    });

    let accept_loop = async {
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let ctx = ctx.clone();
                    tokio::spawn(handle_connection(stream, ctx));
                }
                Err(e) => {
                    warn!(error = %e, "accept failed; continuing");
                }
            }
        }
    };

    tokio::pin!(accept_loop);
    tokio::select! {
        _ = &mut accept_loop => {}
        r = shutdown => {
            if let Err(e) = r {
                warn!(error = %e, "shutdown signal registration failed; exiting anyway");
            } else {
                info!("shutdown signal received");
            }
        }
    }

    // Stop the periodic consolidator — a half-finished CLI run is fine,
    // the CLI's own save is atomic (tmp + rename).
    consolidator.abort();

    // Stop the periodic flusher, then do one final drain so any ops
    // buffered in the last <100ms window land in SQLite before exit.
    flusher.abort();
    match state.store.flush_output_rings() {
        Ok(n) => debug!(persisted = n, "final output ring flush"),
        Err(e) => warn!(error = %e, "final output ring flush failed"),
    }

    if let Err(e) = tokio::fs::remove_file(&socket_path).await {
        debug!(error = %e, "removing socket on shutdown failed (may already be gone)");
    }

    Ok(())
}

async fn remove_stale(path: &std::path::Path) -> Result<(), ProtocolError> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ProtocolError::from_io(e)),
    }
}

#[cfg(unix)]
fn apply_socket_mode(path: &std::path::Path) -> Result<(), ProtocolError> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o600);
    std::fs::set_permissions(path, perms).map_err(ProtocolError::from_io)?;
    Ok(())
}

#[cfg(not(unix))]
fn apply_socket_mode(_path: &std::path::Path) -> Result<(), ProtocolError> {
    Err(ProtocolError::new(
        ProtocolErrorKind::Unavailable,
        "aura-daemon requires a Unix-family target",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_daemon_client::Client;
    use aura_daemon_client::envelope::MessageKind;
    use aura_daemon_client::protocol::RequestBody;
    use tempfile::TempDir;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn handshake_round_trip() {
        let dir = TempDir::new().unwrap();
        let paths = DaemonPaths::custom(dir.path());
        let (tx, rx) = oneshot::channel::<()>();

        let server_paths = paths.clone();
        let store_path = dir.path().join("blocks.db");
        let cfg = ServerConfig::opening_at(server_paths, "aura-daemon/test".into(), store_path)
            .expect("open store");
        let server = tokio::spawn(async move {
            serve(
                cfg,
                async move {
                    rx.await.ok();
                    Ok(())
                },
            )
            .await
        });

        wait_for_path(paths.socket()).await;

        let client = Client::connect(&paths, "test-client").await.unwrap();
        let ack = client.handshake_ack().clone();
        assert_eq!(ack.accepted_version, 1);
        assert_eq!(ack.daemon_build, "aura-daemon/test");

        // SubmitInput is wired; with no sink registered the dispatcher
        // surfaces NotFound — the right shape for a client addressing a
        // session the daemon has no PTY owner for.
        let env = client
            .request(&RequestBody::SubmitInput {
                session_id: aura_daemon_client::protocol::SessionId::new(),
                input: "echo".into(),
            })
            .await
            .unwrap();
        assert_eq!(env.kind, MessageKind::Error);
        let wire: aura_daemon_client::error::WireError = env.decode_body().unwrap();
        assert_eq!(
            wire.kind,
            aura_daemon_client::error::ProtocolErrorKind::NotFound
        );

        tx.send(()).unwrap();
        let _ = server.await.unwrap();
    }

    async fn wait_for_path(p: &std::path::Path) {
        for _ in 0..200 {
            if tokio::fs::try_exists(p).await.unwrap_or(false) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("socket did not appear at {}", p.display());
    }
}
