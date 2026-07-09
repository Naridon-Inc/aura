// Proto error types — covers PTY I/O, config parse, and blockstore errors
// (the bridge crosses into aura-blockstore so `StoreError` must convert).

use thiserror::Error;

#[derive(Debug, Error)]
pub enum TermError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("config: {0}")]
    Config(String),

    #[error("store: {0}")]
    Store(#[from] aura_blockstore::StoreError),
}

pub type Result<T, E = TermError> = std::result::Result<T, E>;
