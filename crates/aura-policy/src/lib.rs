//! aura-policy — deterministic policy evaluator for Aura block proposals.
//!
//! Public API:
//!   - [`load_from_path`] / [`load_from_str`] → [`CompiledPolicy`]
//!   - [`evaluate`] → [`aura_blocks::PolicyDecision`]
//!   - [`EvalContext`] + [`RateState`]
//!   - [`PolicyAdvisor`] + [`FrequencyAdvisor`] for the non-binding LLM layer
//!
//! Design notes (the non-negotiables):
//!   - The evaluator is pure-sync-deterministic. [`RateState`] is the only
//!     mutable input, and its mutation is bounded and auditable.
//!   - Never a panic, never an unwrap on rule-driven paths. Malformed policy
//!     fails at load time, not at evaluate time.
//!   - Most-restrictive verdict wins. Every matching rule is recorded.
//!   - Structural default: reversible → Auto, else → Gate. `.aura/` → Deny.
//!   - LLMs NEVER sit on the decision path. They live in [`PolicyAdvisor`],
//!     which emits rule-change suggestions; humans review and merge. This is
//!     the N6 graceful-degradation contract — the evaluator cannot silently
//!     degrade because it has no LLM dependency to degrade.

pub mod advisor;
pub mod context;
pub mod evaluator;
pub mod schema;
pub mod contracts;
pub mod cedar;

pub use advisor::{AdvisorSuggestion, FrequencyAdvisor, PolicyAdvisor, SuggestionKind};
pub use context::{EvalContext, RateState, WindowKey};
pub use evaluator::evaluate;
pub use schema::{load_from_path, load_from_str, CompiledPolicy, PolicyError};
