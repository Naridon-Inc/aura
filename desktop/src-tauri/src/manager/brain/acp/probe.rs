//! Ask an installed ACP agent which models it actually serves.
//!
//! The composer picker knows Claude's and Codex's models because someone
//! wrote them down — a table that goes stale the day either ships something
//! new. An ACP agent doesn't need that: `session/new` returns its own
//! `configOptions`, including a `model` select carrying every id it can run
//! and which one is current. This module is the smallest thing that reads
//! that list without taking a turn:
//!
//!   spawn → `initialize` → `session/new` → read `configOptions` → drop.
//!
//! Dropping the handle kills the child (`kill_on_drop`), so the agent is
//! gone by the time the catalog is assembled. No prompt is ever sent, so the
//! probe spends no tokens and no money — it is a question about the agent,
//! not a request to the model behind it.
//!
//! Two deliberate choices:
//!
//!   - The probe runs under [`NoApprover`], not the app's real gate. Nobody
//!     is watching a background catalog refresh, so an agent that tried to
//!     touch the disk during startup gets refused rather than silently
//!     allowed or — worse — popping a permission card the user can't place.
//!   - Everything is best-effort and time-boxed. A missing binary, a login
//!     wall, or an agent that never answers yields `None`, and the picker
//!     falls back to what it already had. Discovery may only add fidelity.

use std::sync::Arc;
use std::time::Duration;

use super::brain::{AcpAgent, AcpBrain, AgentFacts, KNOWN_AGENTS};
use crate::manager::brain::gate::NoApprover;

/// Longest one agent may take to say what it can run. The handshake is two
/// round trips against a local process; an agent still silent after this is
/// waiting on something it will not get from a background probe (a login
/// prompt, a network stall), and the catalog refresh must not hang on it.
const PROBE_TIMEOUT: Duration = Duration::from_secs(12);

/// What one agent published about itself.
#[derive(Debug, Clone)]
pub struct ProbedAgent {
    /// Registry id (`opencode`) — the picker family and the `acp:<id>` stem.
    pub id: &'static str,
    pub label: &'static str,
    pub facts: AgentFacts,
}

/// Bring one agent up far enough to read its model list, then let it go.
///
/// `cwd` is where the throwaway session is rooted. It is never written to —
/// the session is opened and abandoned — but agents insist on a real
/// directory, and `safe_spawn_dir` guarantees one.
pub async fn probe_agent(agent: &AcpAgent, cwd: &str) -> Option<AgentFacts> {
    let brain = AcpBrain::from_agent(agent, Arc::new(NoApprover));
    let facts = tokio::time::timeout(PROBE_TIMEOUT, async {
        let child = brain.spawn(cwd).await.ok()?;
        // `session/new` is what carries `configOptions`; `initialize` alone
        // reports capabilities but not the model list.
        brain.open_session(&child, cwd).await.ok()?;
        Some(brain.facts())
    })
    .await
    .ok()
    .flatten()?;

    // An agent that came up but published no models tells the picker
    // nothing. Report `None` so its curated/static rows stand instead of
    // being replaced by an empty list.
    if facts.models.is_empty() {
        return None;
    }
    Some(facts)
}

/// Probe every [`KNOWN_AGENTS`] entry that is installed, concurrently.
///
/// Concurrent because these are independent processes and the catalog
/// refresh is on the picker's open path — two installed agents should cost
/// one probe's wall clock, not two.
pub async fn probe_installed_agents(cwd: &str) -> Vec<ProbedAgent> {
    let installed = super::brain::descriptors_for_installed_agents();
    let probes = installed.into_iter().map(|agent| async move {
        let facts = probe_agent(agent, cwd).await?;
        Some(ProbedAgent {
            id: agent.id,
            label: agent.label,
            facts,
        })
    });
    futures_util::future::join_all(probes)
        .await
        .into_iter()
        .flatten()
        .collect()
}

/// The agent ids this build knows how to probe — whether or not they are
/// installed. Callers use it to decide which picker families are
/// agent-authoritative (the agent defines membership) without duplicating
/// the table.
pub fn known_agent_ids() -> Vec<&'static str> {
    KNOWN_AGENTS.iter().map(|a| a.id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The probe must never invent an agent. If `KNOWN_AGENTS` is the table
    /// the picker trusts, the id list has to come from it — not from a
    /// second hardcoded copy that can drift.
    #[test]
    fn the_probe_only_knows_agents_the_table_lists() {
        let ids = known_agent_ids();
        assert_eq!(ids.len(), KNOWN_AGENTS.len());
        for a in KNOWN_AGENTS {
            assert!(ids.contains(&a.id), "{} missing from the probe table", a.id);
        }
    }

    /// A binary that doesn't exist must fail quietly and quickly — this is
    /// the path every machine without OpenCode installed takes, and it runs
    /// while the model picker is opening.
    #[tokio::test]
    async fn a_missing_binary_probes_to_nothing() {
        const ABSENT: AcpAgent = AcpAgent {
            id: "not-installed",
            label: "Not Installed",
            bin: "aura-no-such-acp-agent",
            args: &["acp"],
            blurb: "",
        };
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        assert!(probe_agent(&ABSENT, &home).await.is_none());
    }

    /// Drives the real `opencode acp` and asserts it publishes a model list.
    /// Ignored by default: it needs the binary installed and spawns a
    /// process. Run with `--ignored` when changing the handshake.
    #[tokio::test]
    #[ignore]
    async fn a_real_opencode_publishes_its_models() {
        let agent = super::super::brain::agent_by_id("opencode").expect("opencode in the table");
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        let facts = probe_agent(agent, &home)
            .await
            .expect("opencode answered the probe");
        assert!(!facts.models.is_empty(), "no models published");
    }
}
