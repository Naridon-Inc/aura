//! Aura work surface — canonical Block envelope.
//!
//! See `block.rs` module doc for design invariants. This lib.rs is the public
//! surface and nothing more.

mod block;
mod canonicalization;
mod migration;
mod ops;
mod redaction;
mod sidebar;

// BlockKind is generated from `kinds.toml` at build time. There is no Custom
// variant — adding kinds requires editing the registry (see `kinds.toml`).
include!(concat!(env!("OUT_DIR"), "/block_kind.rs"));

pub use block::{
    ActualImpacts, AgentRef, AnchorRef, Attestations, Block, BlockError, BlockId, BlockPayload,
    BlockState, CapabilityGrade, DeclaredImpacts, Intent, NetworkIntent, NetworkMethod,
    PolicyDecision, ProviderRef, Provenance, SchemaVersion, Signature, SCHEMA_VERSION,
};
pub use canonicalization::{canonicalize, canonicalize_for_signing, CanonError, CANONICALIZATION};
pub use migration::{Migration, MigrationRegistry};
pub use ops::{BlockOp, BlockOpPayload, RecordedMetric, COST_METRIC_KEYS};
pub use redaction::{RedactionKind, RedactionMark, Redactor};
pub use sidebar::{SidebarCard, SidebarPriority};
