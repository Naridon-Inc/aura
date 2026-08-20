//! pi as a first-class Aura chat brain.
//!
//! The other half of the same argument the [`super::acp`] module makes,
//! for an engine that took the opposite design decision.
//!
//! ACP inverts control: the agent asks the client to read and write, so a
//! host that serves those calls is standing in the path already. pi does
//! not. It owns its tools and runs them itself, and its RPC mode is a
//! stream to watch rather than a conversation to serve. Wrapping it as a
//! CLI would therefore give you what `cli_wrapper` gives you — text on
//! stdout, no tool cards, no permission, no memory between turns.
//!
//! What pi does offer is a hook: `tool_call` fires after
//! `tool_execution_start`, before the tool executes, and can block. That
//! is the whole seam, and it is enough. A one-file extension forwards each
//! call to Aura over pi's extension-UI protocol; Aura applies the same two
//! rules it applies to an ACP agent — nothing outside the session root, no
//! write without a snapshot — and answers `allow` or a sentence saying
//! why not, which pi hands to the model as the tool's result.
//!
//! Module layout:
//! - [`wire`] — pi's event and command shapes, and the translation into
//!   `ChatChunk`s. Pure; tested against lines captured from the binary.
//! - [`brain`] — the process, the session, and the gate that answers.
//! - [`probe`] — bringing pi up just far enough to read the model list it
//!   publishes, so the picker never needs a table for it.
//! - `aura-gate.ts` — the extension itself, compiled in with `include_str!`
//!   and written to `~/.aura/pi/` at spawn so it can never drift from the
//!   Rust that answers it.

pub mod brain;
pub mod probe;
pub mod wire;

/// The gate, driven through the real binary against a model that lives in
/// the test. Ignored by default; see the module docs for how to run it.
#[cfg(test)]
mod e2e;

pub use brain::{BLURB, LABEL, PROVIDER_ID, PiBrain, gate_extension_path, is_installed};
pub use probe::probe_models;
