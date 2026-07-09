//! Aura plugin host.
//!
//! Three coordinated plugin kinds live under ~/.aura/plugins/<scope>/<name>/:
//!   • `aura.plugin.json` — native Aura plugins (UI panels, slash cmds,
//!     status pills, hooks). TS bundle runs in iframe + Web Worker.
//!   • `aura.skill.json`  — Anthropic-skill-style markdown shipped to
//!     agents. Description preloaded; body loaded on demand.
//!   • `aura.mcp.json`    — MCP server subprocess (tools, brains,
//!     analyzers). Speaks JSON-RPC over stdio.
//!
//! W0.1 ships only the manifest types + structural validator. Registry,
//! capability enforcement, loader, and bridge land in later waves of
//! the plugin platform plan (cloud A2A plan id f1a23de6).
//!
//! Manifest schema URL: <https://aura.dev/schemas/plugin@1>.

pub mod capability;
pub mod manifest;
pub mod registry;
pub mod secrets;

pub use capability::{glob_match, Capability, CapabilityError, CapabilitySet};
pub use manifest::{
    AppContrib, Manifest, ManifestError, ManifestKind, McpManifest, NativePluginManifest,
    NetAuthBinding, NetInject, SkillManifest,
};
pub use secrets::resolve_injected_secret;
pub use registry::{Registry, RegistryEntry, ScanRejection, ScanReport};
