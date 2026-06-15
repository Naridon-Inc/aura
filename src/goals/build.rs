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
    let mut proofs = Vec::new();

    let (task_uuid, _task_seq) = match super::active::resolve(root) {
        Some(t) => t,
        None => return proofs,
    };

    // 1. Make sure the active task has a goal to prove. If nothing's linked,
    //    derive the smaller goal from the task title and link it.
    let mut goals = store::for_task(root, &task_uuid);
    if goals.is_empty() {
        if let Some(title) = task_title(root, &task_uuid) {
            if let Ok(rec) = store::upsert_by_text(root, &title) {
                let seq = task_seq(root, &task_uuid);
                let _ = store::link_task(root, &rec.id, &task_uuid, seq);
                goals = store::for_task(root, &task_uuid);
            }
        }
    }
    if goals.is_empty() {
        return proofs;
    }

    // The live reasons behind this commit — what the agent just logged.
    let reasons = latest_intent(root);
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
                    let _ = store::set_decomposition(root, &goal.id, decomp);
                    (reqs, true)
                }
                // No model reachable — skip, best-effort. A later manual/app
                // prove will decompose it.
                None => continue,
            },
        };

        // 3. Prove against the just-committed code (AST-only, free).
        let outcome = GsdEngine::prove_requirements(&goal.text, &requirements);
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
        let _ = store::record_run(root, &goal.id, run);

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

fn short_sha(sha: &str) -> String {
    sha.chars().take(12).collect()
}
