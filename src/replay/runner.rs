//! Run one objective through one agent inside an isolated worktree.
//!
//! This is the execution half of Replay Lab: resolve a CLI-wrapper agent
//! from the `aura-agents` registry, spawn it on the objective in a fresh
//! [`ReplayWorktree`], then capture what it produced — the patch, exit
//! status, duration, a rough token estimate, and an in-worktree
//! `aura pr-review --json` so the scorer can judge semantic risk. The
//! worktree is torn down on return unless `keep` is set.
//!
//! Native brains are intentionally out of scope (they're shell-only);
//! replay drives the same CLI-wrapper agents entire.io does.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::worktree::ReplayWorktree;

/// The captured result of replaying one objective with one agent.
#[derive(Debug, Clone)]
pub struct ReplayRun {
    pub agent_id: String,
    /// False when the agent's binary isn't installed/available — the run
    /// is skipped (no worktree created) and `error` explains why.
    pub available: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
    /// Files the agent touched (from `git diff --numstat`).
    pub files_changed: usize,
    /// Lines in the produced unified diff.
    pub patch_lines: usize,
    /// The full unified diff the agent produced (staged in the worktree).
    pub patch: String,
    /// Last lines of the agent's stdout/stderr, for the report.
    pub stdout_tail: String,
    pub est_tokens_in: u64,
    pub est_tokens_out: u64,
    pub cost_usd: f64,
    /// Raw `aura pr-review --json` output captured inside the worktree, if
    /// the agent produced changes. `None` when there was nothing to review.
    pub review_json: Option<String>,
    /// Set when `--keep-worktrees` kept the worktree on disk.
    pub kept_at: Option<String>,
    pub error: Option<String>,
}

impl ReplayRun {
    fn unavailable(agent_id: &str, reason: String) -> Self {
        Self {
            agent_id: agent_id.to_string(),
            available: false,
            exit_code: None,
            timed_out: false,
            duration_ms: 0,
            files_changed: 0,
            patch_lines: 0,
            patch: String::new(),
            stdout_tail: String::new(),
            est_tokens_in: 0,
            est_tokens_out: 0,
            cost_usd: 0.0,
            review_json: None,
            kept_at: None,
            error: Some(reason),
        }
    }
}

/// Keep only the last `n` lines of `s` (the interesting tail of a log).
fn tail(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// Rough token estimate (~4 chars/token) — the CLI wrappers don't report
/// usage, so this mirrors orchestrate.rs's heuristic for a cost proxy.
fn est_tokens(s: &str) -> u64 {
    (s.len() as u64) / 4
}

/// Replay `objective` with `agent_id` in a fresh worktree off HEAD.
///
/// `aura_bin` is the path to the running `aura` binary (used to invoke
/// `pr-review` inside the worktree). `base` is the branch the review
/// diffs against. Never panics — every failure becomes a populated
/// [`ReplayRun`] with `error` set.
pub fn run_one(
    repo_root: &Path,
    aura_bin: &Path,
    agent_id: &str,
    objective: &str,
    base: &str,
    timeout: Duration,
    keep: bool,
) -> ReplayRun {
    let reg = aura_agents::registry();
    let provider = match reg.get(agent_id) {
        Some(p) => p,
        None => {
            return ReplayRun::unavailable(
                agent_id,
                format!("'{agent_id}' is not a known agent (try: claude, gemini, codex, cursor)"),
            )
        }
    };
    if !provider.is_available() {
        return ReplayRun::unavailable(
            agent_id,
            format!("'{}' binary not found on PATH — skipped", provider.bin_name()),
        );
    }

    let mut wt = match ReplayWorktree::create(repo_root, agent_id) {
        Ok(w) => w,
        Err(e) => return ReplayRun::unavailable(agent_id, e),
    };
    wt.set_keep(keep);

    let inv = match provider.build_invocation(&aura_agents::InvokeRequest {
        prompt: objective,
        mode: aura_agents::InvokeMode::OneShot,
        resume_session_id: None,
        attachments_via_stdin: false,
        effort: None,
        fast: false,
        model: None,
        approval: None,
    }) {
        Ok(i) => i,
        Err(e) => {
            return ReplayRun {
                error: Some(format!("could not build invocation for {agent_id}: {e}")),
                ..ReplayRun::unavailable(agent_id, String::new())
            }
        }
    };

    // Tee the agent's stdout+stderr to a log file so a chatty agent can't
    // deadlock on a full pipe while we poll for the timeout.
    let log_path = wt.path.join(".aura-replay.log");
    let started = Instant::now();
    let mut run = ReplayRun {
        agent_id: agent_id.to_string(),
        available: true,
        exit_code: None,
        timed_out: false,
        duration_ms: 0,
        files_changed: 0,
        patch_lines: 0,
        patch: String::new(),
        stdout_tail: String::new(),
        est_tokens_in: est_tokens(objective),
        est_tokens_out: 0,
        cost_usd: 0.0,
        review_json: None,
        kept_at: None,
        error: None,
    };

    let log_file = match std::fs::File::create(&log_path) {
        Ok(f) => f,
        Err(e) => {
            run.error = Some(format!("could not create replay log: {e}"));
            return run;
        }
    };
    let log_err = match log_file.try_clone() {
        Ok(f) => f,
        Err(e) => {
            run.error = Some(format!("could not duplicate log handle: {e}"));
            return run;
        }
    };

    let mut cmd = Command::new(&inv.bin);
    cmd.args(&inv.args)
        .current_dir(&wt.path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_err));
    for (k, v) in &inv.env {
        cmd.env(k, v);
    }
    // Don't let the spawned agent re-enter Aura's manager bridge or
    // inherit a parent Claude harness flag.
    cmd.env_remove("AURA_MANAGER_SESSION_ID");
    if agent_id == "claude" {
        cmd.env_remove("CLAUDECODE");
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            run.error = Some(format!("could not spawn {}: {e}", inv.bin));
            return run;
        }
    };

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                run.exit_code = status.code();
                break;
            }
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    run.timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(400));
            }
            Err(e) => {
                run.error = Some(format!("error waiting on {agent_id}: {e}"));
                let _ = child.kill();
                break;
            }
        }
    }
    run.duration_ms = started.elapsed().as_millis() as u64;

    // Read back the captured output.
    let output = std::fs::read_to_string(&log_path).unwrap_or_default();
    run.stdout_tail = tail(&output, 40);
    run.est_tokens_out = est_tokens(&output);
    let _ = std::fs::remove_file(&log_path);

    if let Some(cost) = provider.cost_per_1k() {
        run.cost_usd = (run.est_tokens_in as f64 / 1000.0) * cost.input_usd
            + (run.est_tokens_out as f64 / 1000.0) * cost.output_usd;
    }

    // Capture the patch: stage everything (so new files show up), diff
    // against the index, then read numstat for a file count.
    let _ = Command::new("git")
        .args(["add", "-A"])
        .current_dir(&wt.path)
        .output();
    if let Ok(diff) = Command::new("git")
        .args(["diff", "--cached"])
        .current_dir(&wt.path)
        .output()
    {
        run.patch = String::from_utf8_lossy(&diff.stdout).to_string();
        run.patch_lines = run.patch.lines().count();
    }
    if let Ok(numstat) = Command::new("git")
        .args(["diff", "--cached", "--numstat"])
        .current_dir(&wt.path)
        .output()
    {
        run.files_changed = String::from_utf8_lossy(&numstat.stdout)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count();
    }

    // Semantic review of the produced changes, run inside the worktree so
    // it judges *this* agent's diff and nothing else.
    if run.files_changed > 0 {
        if let Ok(rev) = Command::new(aura_bin)
            .args(["pr-review", "--base", base, "--json"])
            .current_dir(&wt.path)
            .output()
        {
            let body = String::from_utf8_lossy(&rev.stdout).trim().to_string();
            if !body.is_empty() && body.starts_with('{') {
                run.review_json = Some(body);
            }
        }
    }

    if keep {
        run.kept_at = Some(wt.path.to_string_lossy().to_string());
    }
    // `wt` drops here → worktree removed unless keep was set.
    run
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_last_n_lines() {
        assert_eq!(tail("a\nb\nc\nd", 2), "c\nd");
        assert_eq!(tail("only", 5), "only");
        assert_eq!(tail("", 3), "");
    }

    #[test]
    fn est_tokens_is_quarter_len() {
        assert_eq!(est_tokens("abcd"), 1);
        assert_eq!(est_tokens(&"x".repeat(400)), 100);
    }

    #[test]
    fn unavailable_run_has_no_patch() {
        let r = ReplayRun::unavailable("gemini", "not installed".into());
        assert!(!r.available);
        assert!(r.patch.is_empty());
        assert_eq!(r.error.as_deref(), Some("not installed"));
    }
}
