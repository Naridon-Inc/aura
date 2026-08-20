//! Auto-prove-on-build: the automatic, reasons-driven half of the spine.
//!
//! When a commit lands, the post-commit hook calls [`prove_active_on_commit`].
//! It finds the active task and makes sure the work stays tied to a goal it can
//! check:
//!
//! 1. **Ensure a goal exists** for the active task — if none is linked yet, one
//!    is born from the task's title (the smaller goal the work delivers).
//! 2. **Decompose dynamically from the live reasons** — if the goal has never
//!    been broken down, do it now, grounded in the intent the agent just logged
//!    (what was actually built), and cache it. Decompose-once: every later
//!    build reuses this.
//! 3. **Prove against the just-committed code** — AST-only, deterministic — and
//!    record a run stamped with the commit sha (the reverse code↔goal index).
//!
//! It is **non-blocking**: every step is best-effort and any failure is
//! swallowed so the commit is never affected. The one model call (decompose)
//! happens at most once per goal — the first build that touches it; after that
//! every build re-proves for free.

use std::path::Path;

use super::model::{Decomposition, GoalRun, Verdict};
use super::store;
use crate::gsd::GsdEngine;

/// One re-proof recorded against a commit, for an optional summary line.
pub struct BuildProof {
    pub goal_text: String,
    pub verdict: Verdict,
    pub ok: usize,
    pub total: usize,
    /// True when this build did the one-time decomposition (vs. a free re-prove).
    pub freshly_decomposed: bool,
}

/// Prove the active task's goal(s) against `commit_sha`, decomposing on the fly
/// from the live reasons when needed, recording a run per goal. Returns what it
/// proved (empty when there's no active task). Never errors — the commit first.
pub fn prove_active_on_commit(root: &Path, commit_sha: &str) -> Vec<BuildProof> {
    let (task_uuid, _task_seq) = match super::active::resolve(root) {
        Some(t) => t,
        None => return Vec::new(),
    };
    let title = task_title(root, &task_uuid).unwrap_or_default();
    // One repo, one place: the ledger and the reasons are both this root.
    prove_task_on_commit(root, root, Some(&task_uuid), &title, commit_sha)
}

/// Prove a **specific** task's goal(s) against `commit_sha` and record a run
/// per goal into `ledger_root`'s goal ledger — the durable, app-visible
/// `.aura/goals.jsonl`. This is the crew's path: the autonomous loop knows
/// exactly which node it just finished, so it proves *that node's own goal*
/// rather than whatever `.aura/active_task` happens to point at (which the
/// loop never pins per node), and it writes the run to the main repo even when
/// the work was built in a throwaway `--jobs` worktree (whose own ledger is
/// discarded). Without both, a crew-built commit lands with no proof bound to
/// it and the Activity surface honestly but uselessly reads "Not checked".
///
/// `task_uuid` is the board task id when the node has one (so the goal links to
/// the board task and survives across runs); pass `None` for a node minted
/// straight into the graph, and the goal is derived from `task_title` and
/// proved unlinked. The AST snapshot proved against is the latest checkpoint in
/// `refs/notes/aura`, which git shares across worktrees — so the freshly
/// committed code is reachable from the main repo. When there's genuinely no
/// snapshot to check (verdict `unknown`), no run is recorded: "Not checked"
/// then means exactly that, not a dropped result.
///
/// `work_root` is the checkout the code was actually built in, and it is a
/// *separate* argument from `ledger_root` on purpose. The one-time
/// decomposition is grounded in the reasons the agent logged, and those live in
/// the working checkout's `.aura/intent_log.jsonl` — while the ledger is the
/// main repo's, shared by every worktree. Reading the reasons from the ledger
/// root is how a node ends up graded against a *different* crew's intent: three
/// loops in three worktrees all append to their own logs, but only one of them
/// is the main repo's, so whichever crew committed last supplies the reasons for
/// everybody. The requirements then describe someone else's work and the node's
/// own code scores zero — a confident, wrong `not_wired`.
pub fn prove_task_on_commit(
    ledger_root: &Path,
    work_root: &Path,
    task_uuid: Option<&str>,
    task_title: &str,
    commit_sha: &str,
) -> Vec<BuildProof> {
    // Resolve the goal(s) for THIS task explicitly. Prefer the goals already
    // linked to the board task; otherwise derive one from the title (and link
    // it when we have a board id to link to).
    let task_uuid = task_uuid.filter(|u| !u.trim().is_empty());
    let mut goals = match task_uuid {
        Some(u) => store::for_task(ledger_root, u),
        None => Vec::new(),
    };
    if goals.is_empty() {
        let title = task_title.trim();
        if !title.is_empty() {
            if let Ok(rec) = store::upsert_by_text(ledger_root, title) {
                match task_uuid {
                    Some(u) => {
                        let seq = task_seq(ledger_root, u);
                        let _ = store::link_task(ledger_root, &rec.id, u, seq);
                        goals = store::for_task(ledger_root, u);
                    }
                    // No board id to anchor to — prove the derived goal directly.
                    None => goals = vec![rec],
                }
            }
        }
    }
    if goals.is_empty() {
        return Vec::new();
    }

    prove_goals(ledger_root, work_root, goals, commit_sha)
}

/// Decompose-once / prove-on-build for an explicit set of goals against
/// `commit_sha`, recording a run per goal into `ledger_root`'s ledger and
/// grounding the decomposition in `work_root`'s reasons. Shared by the
/// active-task ([`prove_active_on_commit`]) and explicit-task
/// ([`prove_task_on_commit`]) entry points.
fn prove_goals(
    ledger_root: &Path,
    work_root: &Path,
    goals: Vec<super::model::GoalRecord>,
    commit_sha: &str,
) -> Vec<BuildProof> {
    let mut proofs = Vec::new();

    // The live reasons behind this commit — what the agent just logged, in the
    // checkout it worked in.
    let reasons = latest_intent(work_root);
    let short = short_sha(commit_sha);

    for goal in goals {
        // 2. Decompose once, dynamically, from the reasons — or reuse the cache.
        let (requirements, freshly_decomposed) = match &goal.decomposition {
            Some(d) if !d.requirements.is_empty() => (d.requirements.clone(), false),
            _ => match GsdEngine::decompose_goal_with_context(&goal.text, reasons.as_deref()) {
                Some(reqs) => {
                    let decomp = Decomposition {
                        requirements: reqs.clone(),
                        decomposed_at: store::now_millis(),
                        model: Some("auditor".to_string()),
                    };
                    let _ = store::set_decomposition(ledger_root, &goal.id, decomp);
                    (reqs, true)
                }
                // No model reachable — skip, best-effort. A later manual/app
                // prove will decompose it.
                None => continue,
            },
        };

        // 3. Prove against the just-committed code (AST-only, free) — anchored
        // to THIS commit, not "the newest snapshot in the repo". `refs/notes/aura`
        // is one store shared by every worktree and branch, so while a crew loop
        // builds three branches at once the newest note is whoever committed last
        // *anywhere*. Grading a goal against a sibling branch's code reports a
        // confident, wrong zero and throws the work away.
        let outcome = GsdEngine::prove_requirements_at(&goal.text, &requirements, commit_sha);
        let verdict_str = outcome["verdict"].as_str().unwrap_or("unknown");
        if verdict_str == "unknown" {
            continue; // couldn't check (no snapshot) — don't record a misleading run
        }
        let verdict = Verdict::from_engine(verdict_str);
        let ok = outcome["passed"].as_u64().unwrap_or(0) as usize;
        let total = outcome["total"].as_u64().unwrap_or(0) as usize;
        let files = super::files_from_outcome(&outcome);

        let run = GoalRun {
            // Keyed by the commit so each build is its own run in the history
            // (the manual "adhoc" key never clobbers, and vice-versa).
            run_key: format!("build:{short}"),
            label: Some(format!("Built on {short}")),
            agent_id: std::env::var("AURA_AGENT_ID").ok(),
            verdict,
            ok,
            total,
            commit: Some(short.clone()),
            trigger: Some("build".to_string()),
            files,
            at: store::now_millis(),
        };
        let _ = store::record_run(ledger_root, &goal.id, run);

        proofs.push(BuildProof { goal_text: goal.text.clone(), verdict, ok, total, freshly_decomposed });
    }

    proofs
}

/// The most recent reason the agent logged — the WHY behind this commit.
fn latest_intent(root: &Path) -> Option<String> {
    let p = root.join(".aura").join("intent_log.jsonl");
    let raw = std::fs::read_to_string(&p).ok()?;
    let last = raw.lines().filter(|l| !l.trim().is_empty()).last()?;
    let v: serde_json::Value = serde_json::from_str(last).ok()?;
    v.get("intent").and_then(|i| i.as_str()).map(|s| s.to_string())
}

fn task_title(root: &Path, uuid: &str) -> Option<String> {
    let t = crate::board::get_task(root, uuid).ok().flatten()?;
    t.get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn task_seq(root: &Path, uuid: &str) -> Option<u64> {
    let t = crate::board::get_task(root, uuid).ok().flatten()?;
    t.get("sequence_id").and_then(serde_json::Value::as_u64)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    fn write_intent(root: &Path, intent: &str) {
        let dir = root.join(".aura");
        std::fs::create_dir_all(&dir).unwrap();
        let line = serde_json::json!({ "agent_id": "claude", "intent": intent }).to_string();
        std::fs::write(dir.join("intent_log.jsonl"), format!("{line}\n")).unwrap();
    }

    /// Three crew loops run in three worktrees and all record their proofs into
    /// the *main* repo's ledger, but each logs its reasons into its own
    /// checkout. So the ledger root and the working root hold different intents
    /// at the same moment, and grounding a decomposition in the ledger root's
    /// intent describes another crew's work — which is how a node that really
    /// did build its goal comes back a confident `not_wired` and, with
    /// `--rollback`, gets erased.
    #[test]
    fn reasons_come_from_the_checkout_the_work_happened_in() {
        let ledger = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();

        // The main repo's log carries whichever crew committed most recently.
        write_intent(ledger.path(), "cloud: one org-selection helper");
        // This node's own checkout carries what this node actually did.
        write_intent(work.path(), "window: every entry point names its place");

        assert_eq!(
            super::latest_intent(work.path()).as_deref(),
            Some("window: every entry point names its place"),
        );
        // The bug, stated as an assertion: reading the ledger root here is what
        // hands a window node the cloud node's reasons.
        assert_ne!(super::latest_intent(ledger.path()), super::latest_intent(work.path()));
    }

    /// A checkout that has logged nothing yields no reasons rather than
    /// borrowing someone else's — decomposition then falls back to the goal
    /// text alone, which is vague but honest.
    #[test]
    fn a_checkout_with_no_log_has_no_reasons_to_lend() {
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(super::latest_intent(empty.path()), None);
    }
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(12).collect()
}
