//! Task-feature integrations — Jira (W1), Linear (next wave).
//!
//! Two-way sync architecture sits on top of this layer. W1 ships only
//! the connection foundation: TOML config loader, OS-keychain token
//! store, and the Jira (Atlassian 3LO) OAuth + identity probe. Pull
//! mirror, push, conflict UI, and webhook delta-apply land in W2+.
//!
//! Why a separate keychain service from `mcp_oauth`:
//! when the user disconnects from one MCP server, we wipe the entire
//! `aura-mcp-oauth` namespace they touched. Integrations live a
//! different lifecycle (a Jira connection is tied to a workspace, not
//! a generic MCP server), and we want disconnecting one to never
//! affect the other. The keychain account name is the provider kind
//! (e.g. `"jira"`) so a future Linear adapter can coexist trivially.

pub mod beads;
pub mod config;
pub mod jira;
pub mod jira_sync;
pub mod jira_users;
pub mod tokens;
pub mod types;

// Public re-exports — kept even when intra-crate consumers reach in
// via the long path, so external callers (binaries, tests) have a
// stable short surface to import from. `IntegrationError` in
// particular isn't used inside the lib today but is part of the
// public type contract for callers that want to match on its variants.
#[allow(unused_imports)]
pub use types::{
    CloudSite, ConnectionStatus, ExternalIdentity, IntegrationError, IntegrationKind,
    MirrorSummary, ProviderTokens,
};
