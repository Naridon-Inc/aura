//! `aura workspace …` — an agent drives cloud workspaces from a shell.
//!
//! AURA-1295. The cloud already exposes `/api/v2/public/workspaces` (the
//! "Conductor API" parity surface); nothing on the client side called it. This
//! module is that client, in three thin layers:
//!
//!   * [`client`] — auth/base-URL resolution and one method per endpoint. No
//!     printing, no exiting; every failure is an [`client::ApiError`] the
//!     caller maps to an exit code.
//!   * [`cmd`]    — the clap verbs, and the one polling loop (`messages --wait`).
//!   * [`output`] — the human rendering. `--json` prints the raw response.
//!
//! The MCP tools in `crate::mcp_workspace` call the same [`client`], so the
//! CLI and the MCP surface cannot drift apart.

pub mod client;
pub mod cmd;
pub mod output;

#[cfg(test)]
mod tests;
