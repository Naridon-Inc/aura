//! aura-blockstore — local durable storage + deterministic reducer + sidebar
//! projection for `aura-blocks::Block` envelopes.
//!
//! Design shape:
//!
//! ```text
//!                     ┌──────────────────────────┐
//!  BlockOp  ────────▶ │  BlockStore::apply_op()  │ ─── tx ──▶  broadcast::Sender<StoreEvent>
//!  (envelope op)      │                          │
//!                     │  SQLite TRANSACTION:     │
//!                     │   1. reducer.fold(...)   │
//!                     │   2. INSERT block_op     │
//!                     │   3. UPSERT blocks       │
//!                     │   4. UPSERT sidebar_card │
//!                     └──────────────────────────┘
//! ```
//!
//! The `AppendOutput` hot path goes through [`output_ring::OutputRing`] —
//! it bypasses the reducer (AppendOutput doesn't change the reduced envelope)
//! and is persisted asynchronously by a batched flusher. The UI reads the
//! ring directly for live streaming.
//!
//! Local-only in v1. Cross-machine sync is W3b (piggybacks on
//! `aura-cli`'s existing `live_sync.rs` transport; no CRDT machinery yet
//! since BlockOp total order via `(ts, lamport, actor)` gives deterministic
//! merge and only the supervisor authors Transition ops).

pub mod error;
pub mod output_ring;
pub mod pubsub;
pub mod reducer;
pub mod schema;
pub mod sidebar;
pub mod store;

pub use error::{Result, StoreError};
pub use output_ring::{OutputChunk, OutputRing};
pub use pubsub::{StoreEvent, SubscribeFilter};
pub use reducer::{fold, replay};
pub use schema::{SCHEMA_USER_VERSION, check_version, init_db};
pub use sidebar::{Scoring, ScoringContext, SidebarFilter};
pub use store::{BlockFilter, BlockStore};
