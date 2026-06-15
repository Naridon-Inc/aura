//! Team Awareness plane (M3) — a live, signed, semantic stream of *who* (human
//! or agent) is building *what*, *why*, and what it will *impact*, surfaced
//! BEFORE a commit/PR so humans and agents coordinate proactively instead of
//! colliding at merge time.
//!
//! This is the "awareness, not sync" plane: it carries small semantic events,
//! NOT code bytes. The code plane stays plain git. Events are signed (M3a) with
//! a per-actor Ed25519 identity so they can't be spoofed. See the team Page
//! "Team Awareness Plane + Sovereign Git — Roadmap (v1)".
//!
//! Surfaces: `aura radar` (this CLI, usable by any agent that shells out) and
//! the MCP tools `aura_team_radar` / `aura_activity_emit` (follow-up wave).

pub mod agent_hook;
pub mod api;
pub mod broadcast;
pub mod cmd;
pub mod conflict;
pub mod emit;
pub mod identity;
pub mod model;
pub mod policy;
pub mod relevance;
pub mod render;
pub mod store;

pub use model::{AwarenessEvent, AwarenessKind};
