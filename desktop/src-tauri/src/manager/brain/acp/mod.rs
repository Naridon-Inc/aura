//! ACP — the Agent Client Protocol — as a first-class Aura chat brain.
//!
//! `cli_wrapper` treats a coding agent as a command: spawn it, hand it a
//! flattened prompt, read whatever it prints, let it exit. That works, and
//! it is why "OpenCode (CLI)" already appears in the model picker, but it
//! throws away everything an agent knows how to tell you. No tool cards,
//! because the output was never structured. No permission prompts, because
//! there was no channel to ask on. No memory between turns, because the
//! process is gone. And a model list that had to be guessed in a table.
//!
//! ACP is a conversation instead. The agent streams `session/update`
//! events as it thinks, calls tools, and finishes; it publishes its own
//! model list as `configOptions`; it can resume a session tomorrow. And —
//! the part that matters most here — it does not touch the disk itself. It
//! asks the client to, over `fs/write_text_file`, and asks permission over
//! `session/request_permission`.
//!
//! Which puts Aura in the one position it is uniquely equipped for: every
//! edit a third-party agent makes arrives at the layer that already knows
//! how to snapshot the file, run the gate, ask the human, and record why.
//! See [`host`] — that is where the difference lives.
//!
//! Module layout:
//! - [`wire`] — protocol shapes and the `session/update` → `ChatChunk`
//!   translation. Pure; tested against bodies captured from a real agent.
//! - [`host`] — the client half: serving the agent's requests through
//!   Aura's own guards.
//! - [`terminal`] — running the agent's commands for it, gated, rooted in
//!   the project, and dead when the session is.
//! - [`probe`] — bringing an agent up just far enough to read the model
//!   list it publishes, so the picker never needs a table for it.
//!
//! The gate an agent's requests pass through is shared with every other
//! engine Aura hosts; it lives in [`crate::manager::brain::gate`].

pub mod brain;
pub mod host;
pub mod probe;
pub mod terminal;
pub mod wire;

pub use brain::{AcpBrain, PROVIDER_PREFIX, descriptors_for_installed_agents};
pub use host::{GateDecision, HostPolicy};
pub use probe::{ProbedAgent, known_agent_ids, probe_installed_agents};
