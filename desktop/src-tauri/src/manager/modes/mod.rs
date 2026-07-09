//! Modes + Marketplace — v0.2.32 MM.1.
//!
//! A *mode* is a portable specialist persona: a YAML file with a
//! `system_prompt`, a tool ACL, hints about which Brain/model to prefer,
//! and a tiny UI shroud. Modes plug into the brain stack so the user
//! can switch between "architect" (planning, no code edits), "code"
//! (implementation specialist), and "debug" (root-cause investigator)
//! without reconfiguring providers or rewriting their system prompt.
//!
//! Architecture mirrors the Brain registry (KK.3):
//!
//! - `schema.rs`        — typed `Mode` struct + YAML serde + version const
//! - `validate.rs`      — strict validator + canonical tool whitelist
//! - `storage.rs`       — atomic load/save + meta sidecar with blake3 pin
//! - `marketplace.rs`   — reqwest client for the public index + per-mode install
//! - `registry.rs`      — merged view: bundled defaults + on-disk installs
//!
//! Bundled defaults (`architect`, `code`, `debug`) live in
//! `aura-shell/resources/modes/*.yaml` and are baked into the binary via
//! `include_str!`. Users can override them by dropping a same-slug YAML
//! into `~/.aura/modes/`; uninstalling the override falls back to the
//! bundled default.
//!
//! Tauri commands live one level up in `cmd_modes.rs` and call into the
//! pure-Rust modules here. Network calls are async; everything else is
//! sync — the file surface is small enough that blocking I/O on the
//! Tauri command thread doesn't hurt.

pub mod marketplace;
pub mod registry;
pub mod schema;
pub mod storage;
pub mod validate;

pub use registry::ModeDescriptor;
pub use schema::{MODE_SCHEMA_VERSION, Mode, ToolAcl, UiShroud, ZoneHints};
pub use validate::{CANONICAL_TOOLS, IssueLevel, RESERVED_TOOLS, ValidationIssue, ValidationReport, validate};

use thiserror::Error;

/// Unified error type for everything in this module. `Validation` is
/// the catch-all for "your YAML is wrong"; `Network` for marketplace
/// transport failures; `PinMismatch` for blake3 disagreement on
/// install; `AdvancedGate` for modes that ask for reserved tools
/// without the user's explicit acknowledgement.
#[derive(Debug, Error)]
pub enum ModesError {
    #[error("io: {message}")]
    Io { message: String },
    #[error("validation: {message}")]
    Validation { message: String },
    #[error("network: {message}")]
    Network { message: String },
    #[error("blake3 pin mismatch: expected {expected}, got {actual}")]
    PinMismatch { expected: String, actual: String },
    #[error("advanced gate required for tools: {wanted:?}")]
    AdvancedGate { wanted: Vec<String> },
    #[error("not found: {slug}")]
    NotFound { slug: String },
}

impl ModesError {
    /// Tauri commands return `Result<T, String>` — this is the canonical
    /// conversion so error messages surface intact in the renderer.
    pub fn to_user_string(&self) -> String {
        self.to_string()
    }
}

impl From<ModesError> for String {
    fn from(value: ModesError) -> Self {
        value.to_user_string()
    }
}
