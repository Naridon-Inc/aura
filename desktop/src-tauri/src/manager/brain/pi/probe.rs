//! Ask an installed pi which models it actually serves.
//!
//! Same argument as [`crate::manager::brain::acp::probe`]: the picker should
//! show what the engine can run today, not what a table in this repo said it
//! could run when the table was written. pi answers directly —
//! `get_available_models` returns every configured model with its provider —
//! so the probe is one round trip:
//!
//!   spawn `pi --mode rpc` → `get_available_models` → drop.
//!
//! Dropping the handle kills the child. No prompt is sent, so the probe
//! spends no tokens and no money — it asks pi about itself, not the model
//! behind it.
//!
//! Two deliberate choices, both shared with the ACP probe:
//!
//!   - It runs under [`NoApprover`]. Nobody is watching a background catalog
//!     refresh, so a tool call during startup is refused rather than silently
//!     allowed or popped as a card the user cannot place.
//!   - It is best-effort and time-boxed. A pi that has never been signed in
//!     answers with an empty list, and that is a *truthful* answer the picker
//!     renders as the single default row — not a reason to invent models.

use std::sync::Arc;
use std::time::Duration;

use super::brain::{PiBrain, is_installed};
use super::wire::PiModel;
use crate::manager::brain::gate::NoApprover;

/// Longest pi may take to say what it can run. Node startup plus one local
/// round trip; a pi still silent after this is waiting on something a
/// background probe will never get.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Bring pi up far enough to read its model list, then let it go.
///
/// `cwd` is where the throwaway process is rooted. Nothing is written there
/// — no prompt is sent — but pi insists on a real directory, and
/// `safe_spawn_dir` guarantees one.
///
/// Returns `None` when pi isn't installed or never answered. An installed pi
/// with no provider configured returns `Some(vec![])`: the difference between
/// "we couldn't ask" and "we asked and it can run nothing" is exactly what
/// the picker needs to decide whether to keep what it already had.
pub async fn probe_models(cwd: &str) -> Option<Vec<PiModel>> {
    if !is_installed() {
        return None;
    }
    let brain = PiBrain::new(Arc::new(NoApprover));
    tokio::time::timeout(PROBE_TIMEOUT, async {
        let child = brain.spawn(cwd).await.ok()?;
        brain.refresh_models(&child).await;
        Some(brain.models())
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The path every machine without pi installed takes, while the model
    /// picker is opening. It has to be immediate, not a 15-second stall.
    #[tokio::test]
    async fn an_absent_pi_probes_to_nothing_immediately() {
        if is_installed() {
            // pi is on this machine; the honest version of this assertion
            // is the ignored test below.
            return;
        }
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        let started = std::time::Instant::now();
        assert!(probe_models(&home).await.is_none());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "an absent binary must not cost the probe timeout"
        );
    }

    /// Drives the real `pi --mode rpc`. Ignored by default: it needs the
    /// binary installed and spawns a process. Run with `--ignored` when
    /// changing the handshake.
    ///
    /// It asserts pi *answered*, not that the list is non-empty — a pi that
    /// has never been signed in genuinely serves nothing, and pretending
    /// otherwise is the failure this whole module avoids.
    #[tokio::test]
    #[ignore]
    async fn a_real_pi_answers_the_probe() {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        assert!(
            probe_models(&home).await.is_some(),
            "pi did not answer get_available_models"
        );
    }
}
