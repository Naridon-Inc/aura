//! Evaluation context — the read-only snapshot the supervisor hands to the
//! evaluator at proposal time. The evaluator is pure except for the sliding
//! windows in [`RateState`]; every other input comes in through [`EvalContext`].

use aura_blocks::AgentRef;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use time::OffsetDateTime;

use crate::schema::TrustTier;

#[derive(Debug, Clone)]
pub struct EvalContext {
    /// Absolute path to the current git repo root. Path classification
    /// (inside/outside repo) uses this.
    pub repo_root: PathBuf,

    /// cwd at proposal time. May equal repo_root or a subpath.
    pub cwd: PathBuf,

    /// Current branch name, if any. Informational for human-state rules.
    pub branch: Option<String>,

    /// Wall clock at proposal evaluation.
    pub now: OffsetDateTime,

    /// Local timezone offset in hours; used by human-state hour rules.
    /// Supervisor resolves from system TZ; evaluator just reads.
    pub local_offset_hours: i8,

    /// Host identifier — which machine the proposal was made on.
    pub origin_host: String,

    /// Who the block's proposing actor is (agent or human).
    pub actor: AgentRef,

    /// Pre-resolved trust tier for `actor`. Supervisor looks this up from
    /// compiled agent grants before calling the evaluator.
    pub actor_trust_tier: TrustTier,

    /// Zone claims currently active, keyed by zone id → owning actor.
    pub zone_claims: HashMap<String, AgentRef>,

    /// Network allowlist (union of rule hosts marked allowlist). Pre-computed
    /// by the supervisor at policy-load time so rules like
    /// `hosts_not_in_allowlist = true` can evaluate in O(1).
    pub network_allowlist: HashSet<String>,
}

/// Mutable rate-limit state. Kept in-memory in the supervisor; passed to the
/// evaluator by mutable reference so sliding windows can be updated.
///
/// This is the ONE piece of non-determinism in the evaluator and it is
/// deliberately scoped: bounded memory (VecDeque of timestamps per window),
/// reset on supervisor restart, never crosses machines in v1.
#[derive(Debug, Default, Clone)]
pub struct RateState {
    windows: HashMap<WindowKey, VecDeque<OffsetDateTime>>,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub struct WindowKey {
    pub rule_id: String,
    pub scope_key: String, // actor DID, block-kind name, or "global"
}

impl RateState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record an event and return the count within the window.
    pub fn tick(&mut self, key: WindowKey, now: OffsetDateTime, window_secs: u64) -> u32 {
        let q = self.windows.entry(key).or_default();
        q.push_back(now);
        let cutoff = now - time::Duration::seconds(window_secs as i64);
        while let Some(&front) = q.front() {
            if front < cutoff {
                q.pop_front();
            } else {
                break;
            }
        }
        q.len() as u32
    }

    /// Peek at current count without recording.
    pub fn count(&self, key: &WindowKey, now: OffsetDateTime, window_secs: u64) -> u32 {
        let Some(q) = self.windows.get(key) else {
            return 0;
        };
        let cutoff = now - time::Duration::seconds(window_secs as i64);
        q.iter().filter(|t| **t >= cutoff).count() as u32
    }
}
