//! Embed an aura-daemon inside aura-term so external clients — another
//! CLI, an IDE plugin, the sandbox — can read and write the terminal's
//! live block state over the standard Unix socket.
//!
//! The embedded daemon serves the **same** `Arc<BlockStore>` the UI and
//! bridge operate on, so reads/writes over IPC and reads/writes through
//! direct `store.foo()` calls see the same data. No cross-process
//! SQLite coordination required.
//!
//! ## Why aura-term does *not* route its own reads through IPC
//!
//! Each of `app::load_blocks`, `bridge::*` block access, and PTY hot-path
//! writes go through the `Arc<BlockStore>` directly, not through a
//! `daemon_client::Client`. That's deliberate:
//!
//! - The Arc and the embedded daemon's store are the same handle.
//!   Re-routing through the socket would copy the block set across a
//!   Unix-domain transport in the same process, which is pure overhead.
//! - The iced update loop is synchronous; a blocking IPC call in a
//!   message handler would stall UI input. Making every read an async
//!   `Task::perform` would change the sidebar's refresh semantics
//!   (briefly empty → populated) without any correctness win.
//! - The architectural invariant we DO need is "external clients see
//!   what the UI sees" — which is covered by
//!   `embedded_daemon_exposes_shared_store_over_ipc` below.
//!
//! Lifecycle:
//!   - `EmbeddedDaemon::spawn` starts a dedicated OS thread running a
//!     single-threaded tokio runtime. Runtime is isolated from iced's
//!     runtime so a hang in either side can't wedge the other.
//!   - The thread probes the requested socket first: if a healthy
//!     aura-daemon is already serving, the embedded instance yields
//!     (no-op wait for shutdown) rather than clobbering the peer. A
//!     race is harmless — whichever binds first wins, the loser yields.
//!   - `Drop` sends on the shutdown channel and joins the thread, so
//!     the server flushes output rings and removes the socket before
//!     the process exits.

use std::sync::Arc;
use std::time::Duration;

use aura_blockstore::BlockStore;
use aura_daemon::input::InputRouter;
use aura_daemon::server::{serve, ServerConfig};
use aura_daemon::state::ServerState;
use aura_daemon_client::paths::DaemonPaths;
use tokio::sync::oneshot;
use tracing::{info, warn};

use crate::error::{Result, TermError};

/// Short probe window used to decide "is another aura-daemon already
/// listening at this socket?". Long enough for a local handshake on a
/// loaded box; short enough that startup stays snappy if nothing is
/// there.
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

/// Handle to the embedded daemon. `Drop` signals shutdown and joins the
/// thread so the server runs its clean-shutdown path (final ring flush,
/// socket removal) before the process exits.
pub struct EmbeddedDaemon {
    shutdown_tx: Option<oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
    /// Pre-built daemon state. aura-term holds the handle so it can
    /// `open_session` synchronously — no racing the daemon thread — and
    /// so `router()` and `state()` are always valid the moment `spawn`
    /// returns.
    state: Arc<ServerState>,
}

impl std::fmt::Debug for EmbeddedDaemon {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EmbeddedDaemon")
            .field("running", &self.thread.is_some())
            .finish()
    }
}

impl EmbeddedDaemon {
    /// Spawn the embedded daemon on a dedicated OS thread with its own
    /// tokio runtime. `paths` controls where the socket + keyfile live;
    /// production callers pass `DaemonPaths::platform_default()`, tests
    /// pass `DaemonPaths::custom(tempdir)`.
    pub fn spawn(
        store: Arc<BlockStore>,
        paths: DaemonPaths,
        daemon_build: String,
    ) -> Result<Self> {
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let input_router = Arc::new(InputRouter::new());
        let sentinel_root = paths.dir().join("sentinel");
        let state = Arc::new(ServerState::new(
            store,
            sentinel_root,
            input_router,
        ));
        let state_for_thread = state.clone();
        let paths_for_thread = paths.clone();
        let thread = std::thread::Builder::new()
            .name("aura-daemon".into())
            .spawn(move || {
                run_daemon(state_for_thread, paths_for_thread, daemon_build, shutdown_rx)
            })
            .map_err(|e| TermError::Config(format!("spawn aura-daemon thread: {e}")))?;
        Ok(Self {
            shutdown_tx: Some(shutdown_tx),
            thread: Some(thread),
            state,
        })
    }

    /// Shared handle to the input router. The bridge calls
    /// `router().register(session_id)` to receive a `Receiver<Vec<u8>>`
    /// that it drains into its PTY. External `SubmitInput` RPCs send
    /// through the same router over IPC, so both paths converge on the
    /// same sink.
    pub fn router(&self) -> Arc<InputRouter> {
        self.state.input_router.clone()
    }

    /// Shared daemon state. aura-term reaches for this to open a primary
    /// session (so `ListSessions` includes it) before the bridge spawns a
    /// PTY. Exposed as `Arc` so cheap clones land on the call path.
    pub fn state(&self) -> Arc<ServerState> {
        self.state.clone()
    }

    /// Convenience: spawn against the platform-default paths
    /// (`~/Library/Application Support/aura/` on macOS, `~/.aura/` on
    /// Linux). Wraps `DaemonPaths::platform_default` into `TermError`.
    pub fn spawn_default(store: Arc<BlockStore>, daemon_build: String) -> Result<Self> {
        let paths = DaemonPaths::platform_default()
            .map_err(|e| TermError::Config(format!("resolve daemon paths: {e}")))?;
        Self::spawn(store, paths, daemon_build)
    }
}

impl Drop for EmbeddedDaemon {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.thread.take() {
            // Join is best-effort — if the runtime is already gone the
            // thread has already exited. Ignoring the panic payload is
            // intentional: we don't want a panicking daemon to abort
            // the UI process on shutdown.
            let _ = t.join();
        }
    }
}

fn run_daemon(
    state: Arc<ServerState>,
    paths: DaemonPaths,
    daemon_build: String,
    shutdown_rx: oneshot::Receiver<()>,
) {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            warn!(error = %e, "embedded daemon failed to build runtime");
            return;
        }
    };
    rt.block_on(async move {
        if probe_alive(&paths).await {
            info!(
                socket = %paths.socket().display(),
                "peer aura-daemon already serving; embedded instance yielding",
            );
            // Hold the thread alive until shutdown so `EmbeddedDaemon`'s
            // Drop still has something to join cleanly. Yielding this
            // way (vs. exiting immediately) keeps the external invariant
            // simple: "handle exists → thread exists".
            let _ = shutdown_rx.await;
            return;
        }
        // The pre-built state already carries the store, sentinel_root,
        // and input router — pass it through directly. The other
        // ServerConfig fields become placeholders that serve() ignores
        // when `state` is `Some`.
        let sentinel_root = paths.dir().join("sentinel");
        let store = state.store.clone();
        let input_router = state.input_router.clone();
        let cfg = ServerConfig {
            paths: paths.clone(),
            daemon_build,
            store,
            sentinel_root,
            input_router,
            state: Some(state),
        };
        if let Err(e) = serve(cfg, async move {
            shutdown_rx.await.ok();
            Ok(())
        })
        .await
        {
            warn!(error = %e, "embedded aura-daemon exited with error");
        }
    });
}

/// Does a healthy aura-daemon already respond on this socket? If yes,
/// we yield rather than clobber. If no (or the probe times out), the
/// caller spawns its own server.
async fn probe_alive(paths: &DaemonPaths) -> bool {
    if !paths.socket().exists() {
        return false;
    }
    match tokio::time::timeout(
        PROBE_TIMEOUT,
        aura_daemon_client::Client::connect(paths, "aura-term-probe"),
    )
    .await
    {
        Ok(Ok(_client)) => true, // client drops → connection closes
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_daemon_client::Client;
    use std::path::Path;
    use tempfile::TempDir;

    async fn wait_for_socket(p: &Path) {
        for _ in 0..200 {
            if tokio::fs::try_exists(p).await.unwrap_or(false) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("socket did not appear at {}", p.display());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn embedded_daemon_handshakes_a_client() {
        // The whole point: spawn the embedded daemon the way aura-term
        // will spawn it, and prove an external client can handshake
        // against it. If this breaks, no external tool can see the
        // terminal's state — which is why we embed in the first place.
        let dir = TempDir::new().unwrap();
        let store = Arc::new(BlockStore::open(Path::new(":memory:")).unwrap());
        let paths = DaemonPaths::custom(dir.path());

        let daemon = EmbeddedDaemon::spawn(store, paths.clone(), "aura-term/test".into())
            .expect("spawn embedded daemon");
        wait_for_socket(paths.socket()).await;

        let client = Client::connect(&paths, "test-client")
            .await
            .expect("handshake");
        assert_eq!(client.handshake_ack().accepted_version, 1);

        drop(daemon); // triggers shutdown + thread join
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn embedded_daemon_exposes_shared_store_over_ipc() {
        // The architectural contract: a seed written directly to the
        // Arc<BlockStore> MUST be visible to an external Client over the
        // socket. If this breaks, an IDE plugin or a sibling CLI opening
        // the socket would see a different block set than the UI shows —
        // the single source-of-truth invariant is broken.
        use std::collections::BTreeMap;
        use aura_blocks::{
            AgentRef, AnchorRef, Attestations, Block, BlockId, BlockKind, BlockPayload,
            BlockState, DeclaredImpacts, Intent, Provenance, SCHEMA_VERSION,
        };
        use aura_daemon_client::protocol::BlockFilter;
        use time::OffsetDateTime;

        let dir = TempDir::new().unwrap();
        let store = Arc::new(BlockStore::open(Path::new(":memory:")).unwrap());
        let paths = DaemonPaths::custom(dir.path());

        // Seed directly through the shared Arc — simulating the UI
        // minting a block via the bridge. The daemon holds the same
        // handle, so the IPC read must observe this write.
        let seed = Block {
            id: BlockId::new(),
            schema_version: SCHEMA_VERSION,
            kind: BlockKind::Command,
            parent_id: None,
            prior_sibling_id: None,
            supersedes_id: None,
            anchor: AnchorRef::Function("ui_minted".into()),
            intent: Intent {
                summary: "shared-arc invariant".into(),
                detail: None,
                parent_intent: None,
            },
            declared_impacts: DeclaredImpacts::default(),
            actual_impacts: None,
            payload: BlockPayload::Command {
                command: "echo hi".into(),
                shell: None,
                cwd: "/tmp".into(),
            },
            state: BlockState::Proposed,
            policy: None,
            provenance: Provenance {
                actor: AgentRef("did:aura:ui".into()),
                on_behalf_of: None,
                origin_host: "ui-host".into(),
                signature: None,
            },
            attestations: Attestations::default(),
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
            extensions: BTreeMap::new(),
        };
        let seed_id = seed.id.0;
        store.insert_block(&seed).unwrap();

        let daemon = EmbeddedDaemon::spawn(
            store.clone(),
            paths.clone(),
            "aura-term/ipc-invariant".into(),
        )
        .expect("spawn embedded daemon");
        wait_for_socket(paths.socket()).await;

        let client = Client::connect(&paths, "ipc-invariant-test")
            .await
            .expect("handshake");

        // list_blocks_raw round-trip — the same block the UI wrote
        // directly must be in the list the IPC client receives.
        let list_bytes = client
            .list_blocks_raw(BlockFilter::default())
            .await
            .expect("list_blocks_raw");
        let blocks: Vec<Block> =
            serde_json::from_slice(&list_bytes).expect("decode block list");
        assert_eq!(blocks.len(), 1, "IPC list must see exactly the seed");
        assert_eq!(blocks[0].id.0, seed_id);
        assert_eq!(blocks[0].intent.summary, "shared-arc invariant");

        // get_block_raw round-trip — single-block fetch must return
        // byte-identical envelope for the known id.
        let got = client.get_block_raw(seed_id).await.expect("get_block_raw");
        let fetched: Block = serde_json::from_slice(&got).expect("decode block");
        assert_eq!(fetched.id.0, seed_id);
        assert_eq!(
            fetched.anchor,
            AnchorRef::Function("ui_minted".into()),
            "anchor survived IPC round-trip"
        );

        // Writing a SECOND block after the daemon is up must also be
        // visible — guards against a hypothetical snapshot-on-spawn bug.
        let mut second = seed.clone();
        second.id = BlockId::new();
        second.intent.summary = "post-spawn write".into();
        store.insert_block(&second).unwrap();

        let list_bytes2 = client
            .list_blocks_raw(BlockFilter::default())
            .await
            .expect("list_blocks_raw (post-spawn)");
        let blocks2: Vec<Block> = serde_json::from_slice(&list_bytes2).unwrap();
        assert_eq!(blocks2.len(), 2, "IPC must observe post-spawn writes");

        drop(daemon);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn external_apply_op_via_ipc_is_observable_via_shared_arc() {
        // Symmetric write-path invariant: an external client's ApplyOp
        // must mutate the SAME store the UI reads through the shared
        // Arc. This is the write-side of
        // `embedded_daemon_exposes_shared_store_over_ipc`: without it,
        // an MCP agent committing a block via IPC would never show up
        // in the terminal's sidebar. Proving this keeps the in-process
        // Arc<BlockStore> read path honest — it's not a cache, it's
        // the same storage cell.
        use std::collections::BTreeMap;
        use aura_blocks::{
            AgentRef, AnchorRef, Attestations, Block, BlockId, BlockKind, BlockOp,
            BlockOpPayload, BlockPayload, BlockState, DeclaredImpacts, Intent, Provenance,
            SCHEMA_VERSION,
        };
        use time::OffsetDateTime;

        let dir = TempDir::new().unwrap();
        let store = Arc::new(BlockStore::open(Path::new(":memory:")).unwrap());
        let paths = DaemonPaths::custom(dir.path());

        // Seed a Proposed block via the shared Arc, just like the UI's
        // bridge would on a fresh command. The external client will
        // push a Transition op against it over IPC.
        let seed = Block {
            id: BlockId::new(),
            schema_version: SCHEMA_VERSION,
            kind: BlockKind::Command,
            parent_id: None,
            prior_sibling_id: None,
            supersedes_id: None,
            anchor: AnchorRef::Function("ipc_apply_op".into()),
            intent: Intent {
                summary: "write-path invariant seed".into(),
                detail: None,
                parent_intent: None,
            },
            declared_impacts: DeclaredImpacts::default(),
            actual_impacts: None,
            payload: BlockPayload::Command {
                command: "noop".into(),
                shell: None,
                cwd: "/tmp".into(),
            },
            state: BlockState::Proposed,
            policy: None,
            provenance: Provenance {
                actor: AgentRef("did:aura:ui".into()),
                on_behalf_of: None,
                origin_host: "ui-host".into(),
                signature: None,
            },
            attestations: Attestations::default(),
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
            extensions: BTreeMap::new(),
        };
        let seed_id = seed.id.0;
        store.insert_block(&seed).unwrap();

        let daemon = EmbeddedDaemon::spawn(
            store.clone(),
            paths.clone(),
            "aura-term/write-invariant".into(),
        )
        .expect("spawn embedded daemon");
        wait_for_socket(paths.socket()).await;

        let client = Client::connect(&paths, "write-invariant-test")
            .await
            .expect("handshake");

        // External client mints a Transition op (Proposed → Gated) and
        // submits via ApplyOp. The daemon's dispatcher routes through
        // the SAME store the UI reads; no separate client-state.
        let op = BlockOp {
            op_id: uuid::Uuid::now_v7(),
            block_id: BlockId(seed_id),
            actor: AgentRef("did:aura:external".into()),
            timestamp: OffsetDateTime::now_utc(),
            lamport: 1,
            payload: BlockOpPayload::Transition {
                to: BlockState::Gated,
                reason: Some("invariant test".into()),
            },
        };
        let op_bytes = serde_json::to_vec(&op).expect("encode op");
        let (updated_id, new_state) = client
            .apply_op_raw(op_bytes)
            .await
            .expect("apply_op_raw");
        assert_eq!(updated_id, seed_id);
        assert_eq!(new_state, "gated");

        // In-process Arc must reflect the external mutation immediately
        // — this is the invariant the test is here to enforce.
        let observed = store
            .get_block(BlockId(seed_id))
            .expect("read")
            .expect("block present");
        assert_eq!(observed.state, BlockState::Gated);
        assert_eq!(
            observed.intent.summary, "write-path invariant seed",
            "envelope untouched; only state advanced",
        );

        drop(daemon);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn second_embedded_daemon_yields_to_the_first() {
        // Two EmbeddedDaemon handles at the same paths: the first
        // binds, the second probes + yields. The test checks the
        // second handle drops cleanly (no panic, no clobbered
        // socket) and the first handle is still serving afterwards.
        let dir = TempDir::new().unwrap();
        let store = Arc::new(BlockStore::open(Path::new(":memory:")).unwrap());
        let paths = DaemonPaths::custom(dir.path());

        let first = EmbeddedDaemon::spawn(store.clone(), paths.clone(), "aura-term/first".into())
            .expect("spawn first");
        wait_for_socket(paths.socket()).await;

        // Give the first daemon a brief window to fully come up so the
        // probe returns true deterministically. Local handshakes are
        // fast; 100ms is ample.
        tokio::time::sleep(Duration::from_millis(100)).await;

        let second = EmbeddedDaemon::spawn(store.clone(), paths.clone(), "aura-term/second".into())
            .expect("spawn second");
        // Second yields silently; no way to observe it directly beyond
        // "handle drops cleanly and the socket still belongs to first".
        drop(second);

        // First daemon must still be responsive.
        let client = Client::connect(&paths, "after-yield")
            .await
            .expect("first daemon still responsive");
        assert_eq!(client.handshake_ack().daemon_build, "aura-term/first");

        drop(first);
    }
}
