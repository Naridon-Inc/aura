//! Rank replay runs by semantic correctness, not just exit code.
//!
//! Each [`ReplayRun`] carries an in-worktree `aura pr-review --json`
//! result; this module turns that (plus exit status, whether the agent
//! actually changed anything, and a token cost proxy) into a single
//! comparable score. The shape mirrors the skill ledger's canonical
//! ranker — quality × pass-factor ÷ (1 + cost) — so "the brain that wrote
//! the lowest-risk working patch most cheaply" wins.

use super::runner::ReplayRun;
use serde_json::Value;

/// A scored, judged replay run.
#[derive(Debug, Clone)]
pub struct ScoredRun {
    pub run: ReplayRun,
    /// "LOW" | "MODERATE" | "CRITICAL" | "n/a" (from `aura pr-review`).
    pub risk_label: String,
    pub risk_score: u64,
    /// Did the agent exit cleanly AND produce a non-critical patch?
    pub pr_pass: bool,
    /// Composite rank score; higher is better. 0.0 for runs that produced
    /// nothing or were unavailable.
    pub score: f64,
    /// One-line human verdict for the report.
    pub verdict: String,
}

/// Pull `risk_score` + `risk_label` out of a captured pr-review JSON body.
fn parse_risk(review_json: &Option<String>) -> (Option<u64>, String) {
    let Some(raw) = review_json else {
        return (None, "n/a".to_string());
    };
    let v: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return (None, "n/a".to_string()),
    };
    let score = v.get("risk_score").and_then(|x| x.as_u64());
    let label = v
        .get("risk_label")
        .and_then(|x| x.as_str())
        .unwrap_or("n/a")
        .to_string();
    (score, label)
}

/// Map a risk label to a 1..=5 quality grade for the skill ledger.
pub fn risk_to_grade(risk_label: &str, exited_ok: bool, produced: bool) -> u8 {
    match risk_label {
        "LOW" => 5,
        "MODERATE" => 3,
        "CRITICAL" => 1,
        _ => {
            // No review (e.g. nothing to review): grade on exit + output.
            if produced && exited_ok {
                4
            } else if produced {
                2
            } else {
                1
            }
        }
    }
}

/// Score one run. Pure — all inputs come from the [`ReplayRun`].
pub fn score_run(run: ReplayRun) -> ScoredRun {
    if !run.available {
        let verdict = run.error.clone().unwrap_or_else(|| "unavailable".to_string());
        return ScoredRun {
            run,
            risk_label: "n/a".to_string(),
            risk_score: 0,
            pr_pass: false,
            score: 0.0,
            verdict,
        };
    }

    let (risk_opt, risk_label) = parse_risk(&run.review_json);
    let risk_score = risk_opt.unwrap_or(0);
    let exited_ok = run.exit_code == Some(0) && !run.timed_out;
    let produced = run.files_changed > 0;
    let pr_pass = exited_ok && produced && risk_label != "CRITICAL";

    // Quality: lower review risk → higher q. A run that produced nothing
    // gets q = 0 (no work is not a win, however cleanly it exited).
    let q = if !produced {
        0.0
    } else {
        (1.0 - (risk_score.min(100) as f64) / 100.0).max(0.05)
    };
    // Cost proxy in "thousands of tokens" so the denominator stays well
    // conditioned even when the wrappers report no dollar cost.
    let cost_units = (run.est_tokens_in + run.est_tokens_out) as f64 / 1000.0;
    let pr_factor = if pr_pass { 1.0 } else { 0.4 };
    let score = q * pr_factor / (1.0 + cost_units);

    let verdict = make_verdict(&run, produced, exited_ok, &risk_label);
    ScoredRun {
        run,
        risk_label,
        risk_score,
        pr_pass,
        score,
        verdict,
    }
}

fn make_verdict(run: &ReplayRun, produced: bool, exited_ok: bool, risk_label: &str) -> String {
    if run.timed_out {
        return format!("timed out after {}ms", run.duration_ms);
    }
    if !produced {
        return "no changes produced".to_string();
    }
    if !exited_ok {
        let code = run
            .exit_code
            .map(|c| c.to_string())
            .unwrap_or_else(|| "?".to_string());
        return format!("exited {code}, {} file(s)", run.files_changed);
    }
    format!("{} file(s), risk {risk_label}", run.files_changed)
}

/// Score and rank a batch of runs, best first. Ties break toward lower
/// risk, then fewer tokens.
pub fn rank(runs: Vec<ReplayRun>) -> Vec<ScoredRun> {
    let mut scored: Vec<ScoredRun> = runs.into_iter().map(score_run).collect();
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.risk_score.cmp(&b.risk_score))
            .then(
                (a.run.est_tokens_in + a.run.est_tokens_out)
                    .cmp(&(b.run.est_tokens_in + b.run.est_tokens_out)),
            )
    });
    scored
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(agent: &str) -> ReplayRun {
        ReplayRun {
            agent_id: agent.to_string(),
            available: true,
            exit_code: Some(0),
            timed_out: false,
            duration_ms: 1000,
            files_changed: 2,
            patch_lines: 20,
            patch: "diff".to_string(),
            stdout_tail: String::new(),
            est_tokens_in: 1000,
            est_tokens_out: 1000,
            cost_usd: 0.0,
            review_json: Some("{\"risk_score\":10,\"risk_label\":\"LOW\"}".to_string()),
            kept_at: None,
            error: None,
        }
    }

    #[test]
    fn low_risk_clean_run_beats_critical() {
        let mut critical = mk("gemini");
        critical.review_json =
            Some("{\"risk_score\":80,\"risk_label\":\"CRITICAL\"}".to_string());
        let ranked = rank(vec![critical, mk("claude")]);
        assert_eq!(ranked[0].run.agent_id, "claude");
        assert!(ranked[0].pr_pass);
        assert!(!ranked[1].pr_pass); // critical fails the pass gate
    }

    #[test]
    fn no_changes_scores_zero() {
        let mut empty = mk("codex");
        empty.files_changed = 0;
        empty.review_json = None;
        let s = score_run(empty);
        assert_eq!(s.score, 0.0);
        assert_eq!(s.verdict, "no changes produced");
    }

    #[test]
    fn unavailable_is_zero_and_keeps_reason() {
        let r = ReplayRun {
            available: false,
            error: Some("binary not found".to_string()),
            ..mk("cursor")
        };
        let s = score_run(r);
        assert_eq!(s.score, 0.0);
        assert_eq!(s.verdict, "binary not found");
    }

    #[test]
    fn cheaper_run_wins_when_quality_equal() {
        let mut cheap = mk("claude");
        cheap.est_tokens_in = 200;
        cheap.est_tokens_out = 200;
        let expensive = mk("gemini"); // 2000 tokens total
        let ranked = rank(vec![expensive, cheap]);
        assert_eq!(ranked[0].run.agent_id, "claude");
    }

    #[test]
    fn grade_maps_risk() {
        assert_eq!(risk_to_grade("LOW", true, true), 5);
        assert_eq!(risk_to_grade("CRITICAL", true, true), 1);
        assert_eq!(risk_to_grade("n/a", true, true), 4);
        assert_eq!(risk_to_grade("n/a", false, false), 1);
    }
}
