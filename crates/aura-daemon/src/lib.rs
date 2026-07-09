//! aura-daemon library surface. The binary in `bin/aura-daemon` is a thin
//! wrapper around `server::serve`; keeping the modules in a library lets
//! integration tests (and future embedders like `aura-term` fallback
//! "spawn daemon" flows) drive the same entrypoint in-process.

pub mod consolidate;
pub mod handover;
pub mod handshake;
pub mod input;
pub mod keyfile;
pub mod listener;
pub mod sentinel;
pub mod server;
pub mod state;
pub mod db;
pub mod kms;
pub mod acp_server;
pub mod episodic;
pub mod fleet;

/// Build identifier emitted in `HandshakeAck.daemon_build`.
pub const DAEMON_BUILD: &str = concat!("aura-daemon/", env!("CARGO_PKG_VERSION"));
