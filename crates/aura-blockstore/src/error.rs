//! Store-layer errors.
//!
//! Every fallible path routes through this enum. The reducer is pure and
//! returns `StoreError::Reducer(BlockError)` on illegal transitions; anything
//! touching SQLite returns `StoreError::Sql`. Keep the variant count small —
//! too many narrow variants invites inconsistent error-handling.

use aura_blocks::BlockError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("sqlite: {0}")]
    Sql(#[from] rusqlite::Error),

    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("reducer: {0}")]
    Reducer(#[from] BlockError),

    #[error("illegal op on block {block_id}: {reason}")]
    IllegalOp { block_id: String, reason: String },

    #[error("block not found: {0}")]
    NotFound(String),

    #[error("schema version mismatch: db={found}, expected={expected}")]
    SchemaVersion { found: u32, expected: u32 },

    #[error("base64 decode: {0}")]
    Base64(#[from] base64::DecodeError),

    #[error("time format: {0}")]
    Time(#[from] time::error::ComponentRange),
}

pub type Result<T, E = StoreError> = std::result::Result<T, E>;
