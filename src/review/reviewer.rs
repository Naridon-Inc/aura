//! Dispatch reviewers over a diff and collect their findings.
//!
//! Two kinds of reviewer run side by side:
//!   * **Aura** — the deterministic semantic engine ([`crate::pr`]). Always
//!     runs; produces structured findings (invariant violations, taste
//!     hits, blast radius) plus a risk label.
//!   * **Agents** — CLI-wrapper brains (claude/gemini/codex/cursor) driven
//!     through the `aura-agents` registry. They get the diff in their
//!     prompt and emit free-text findings, parsed by [`super::findings`].
//!
//! Agent reviewers run in parallel threads; each is read-only (we only
//! read its stdout) so they share the working tree safely.

use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use super::dimensions::{self, Dimension, Tier};
use super::findings::{self, Finding, Severity};

/// What one reviewer concluded about the diff.
#[derive(Debug, Clone)]
pub struct ReviewerResult {
    pub source: String,
    /// False for an agent whose binary isn't installed (skipped).
    pub available: bool,
    /// "LOW"/"MODERATE"/"CRITICAL" for Aura; "n/a" for agents.
    pub risk_label: String,
    pub risk_score: u64,
    pub findings: Vec<Finding>,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub error: Option<String>,
}

impl ReviewerResult {
    fn skipped(source: &str, reason: String) -> Self {
        Self {
            source: source.to_string(),
            available: false,
            risk_label: "n/a".to_string(),
            risk_score: 0,
            findings: Vec::new(),
            duration_ms: 0,
            timed_out: false,
            error: Some(reason),
        }
    }
}

/// Maximum diff bytes we paste into an agent prompt (keeps token cost and
/// context windows sane; the agent can still open files itself).
const MAX_DIFF_BYTES: usize = 120_000;

/// Capture the review diff: `base...HEAD` plus any uncommitted work, so a
/// reviewer sees exactly what would land.
pub fn capture_diff(base: &str) -> String {
    let mut buf = String::new();
    if let Ok(out) = Command::new("git")
        .args(["diff", &format!("{base}...HEAD")])
        .output()
    {
        buf.push_str(&String::from_utf8_lossy(&out.stdout));
    }
    if let Ok(out) = Command::new("git").args(["diff", "HEAD"]).output() {
        let work = String::from_utf8_lossy(&out.stdout);
        if !work.trim().is_empty() {
            buf.push_str("\n# --- uncommitted working-tree changes ---\n");
            buf.push_str(&work);
        }
    }
    if buf.len() > MAX_DIFF_BYTES {
        let mut cut = buf;
        cut.truncate(MAX_DIFF_BYTES);
        cut.push_str("\n… [diff truncated for review prompt] …\n");
        cut
    } else {
        buf
    }
}

/// Run Aura's deterministic engine and turn its report into findings.
pub fn run_aura_reviewer(base: &str) -> ReviewerResult {
    let started = Instant::now();
    let report = match crate::pr::PrReviewEngine::run_review(base, true, false) {
        Ok(Some(json)) => json,
        Ok(None) => {
            return ReviewerResult {
                source: "aura".to_string(),
                available: true,
                risk_label: "LOW".to_string(),
                risk_score: 0,
                findings: Vec::new(),
                duration_ms: started.elapsed().as_millis() as u64,
                timed_out: false,
                error: None,
            }
        }
        Err(e) => return ReviewerResult::skipped("aura", format!("engine error: {e}")),
    };

    let v: serde_json::Value = match serde_json::from_str(&report) {
        Ok(v) => v,
        Err(e) => return ReviewerResult::skipped("aura", format!("bad report JSON: {e}")),
    };
    if v.get("status").and_then(|s| s.as_str()) == Some("no_changes") {
        return ReviewerResult {
            source: "aura".to_string(),
            available: true,
            risk_label: "LOW".to_string(),
            risk_score: 0,
            findings: Vec::new(),
            duration_ms: started.elapsed().as_millis() as u64,
            timed_out: false,
            error: None,
        };
    }

    let risk_label = v
        .get("risk_label")
        .and_then(|x| x.as_str())
        .unwrap_or("n/a")
        .to_string();
    let risk_score = v.get("risk_score").and_then(|x| x.as_u64()).unwrap_or(0);

    let mut findings = Vec::new();
    // The engine appends a `(path:line)` location to each invariant/taste
    // string (see `pr.rs`); `from_engine` lifts it into a real line anchor so
    // these post as inline comments with no LLM in the loop.
    for s in str_array(&v, "invariant_violations") {
        findings.push(Finding::from_engine("aura", Severity::Critical, s));
    }
    for s in str_array(&v, "taste_findings") {
        findings.push(Finding::from_engine("aura", Severity::Advisory, s));
    }
    for s in str_array(&v, "blast_radius") {
        findings.push(Finding::new("aura", Severity::Info, format!("blast radius: {s}")));
    }
    for s in str_array(&v, "cross_branch_conflicts") {
        findings.push(Finding::new(
            "aura",
            Severity::High,
            format!("cross-branch conflict: {s}"),
        ));
    }

    ReviewerResult {
        source: "aura".to_string(),
        available: true,
        risk_label,
        risk_score,
        findings,
        duration_ms: started.elapsed().as_millis() as u64,
        timed_out: false,
        error: None,
    }
}

fn str_array(v: &serde_json::Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|e| e.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// One agent invocation's raw result.
#[derive(Debug)]
pub struct AgentRun {
    /// Combined stdout+stderr the agent emitted.
    pub output: String,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub error: Option<String>,
}

/// Distinguishes concurrent temp logs — the same agent may run several
/// dimensions (and the verifier) at once, so the pid alone isn't unique.
static RUN_SEQ: AtomicU64 = AtomicU64::new(0);

/// Run an arbitrary prompt through an agent CLI (one-shot, read-only), teeing
/// its output to a unique temp file so a chatty brain can't deadlock on a full
/// pipe while we poll for the timeout.
///
/// `Err(reason)` means the agent never produced usable output (unknown agent,
/// missing binary, spawn/IO failure). Callers turn that into a skipped reviewer
/// rather than aborting the whole review.
pub fn run_agent_prompt(
    agent_id: &str,
    prompt: &str,
    timeout: Duration,
) -> Result<AgentRun, String> {
    let reg = aura_agents::registry();
    let provider = reg
        .get(agent_id)
        .ok_or_else(|| format!("'{agent_id}' is not a known agent"))?;
    if !provider.is_available() {
        return Err(format!(
            "'{}' binary not found on PATH — skipped",
            provider.bin_name()
        ));
    }

    let inv = provider
        .build_invocation(&aura_agents::InvokeRequest {
            prompt,
            mode: aura_agents::InvokeMode::OneShot,
            resume_session_id: None,
            attachments_via_stdin: false,
            effort: None,
            fast: false,
            model: None,
            approval: None,
        })
        .map_err(|e| format!("build invocation: {e}"))?;

    // Unique per call: same agent may run several dimensions concurrently.
    let seq = RUN_SEQ.fetch_add(1, Ordering::Relaxed);
    let log_path = std::env::temp_dir().join(format!(
        "aura-review-{agent_id}-{}-{seq}.log",
        std::process::id()
    ));
    let log_file = std::fs::File::create(&log_path).map_err(|e| format!("create log: {e}"))?;
    let log_err = log_file.try_clone().map_err(|e| format!("dup log: {e}"))?;

    let mut cmd = Command::new(&inv.bin);
    cmd.args(&inv.args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_err));
    for (k, val) in &inv.env {
        cmd.env(k, val);
    }
    cmd.env_remove("AURA_MANAGER_SESSION_ID");
    if agent_id == "claude" {
        cmd.env_remove("CLAUDECODE");
    }

    let started = Instant::now();
    let mut child = cmd.spawn().map_err(|e| format!("spawn {}: {e}", inv.bin))?;

    let mut timed_out = false;
    let mut error = None;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(400));
            }
            Err(e) => {
                error = Some(format!("wait: {e}"));
                let _ = child.kill();
                break;
            }
        }
    }
    let duration_ms = started.elapsed().as_millis() as u64;
    let output = std::fs::read_to_string(&log_path).unwrap_or_default();
    let _ = std::fs::remove_file(&log_path);

    Ok(AgentRun {
        output,
        duration_ms,
        timed_out,
        error,
    })
}

/// Run one specialist dimension through an agent and parse its JSON findings,
/// tagged `"<agent>:<dimension>"` so the summary shows who ran which pass.
fn run_dimension(
    agent_id: &str,
    dim: &Dimension,
    diff: &str,
    context: &str,
    timeout: Duration,
) -> ReviewerResult {
    let source = format!("{agent_id}:{}", dim.id);
    let prompt = dimensions::build_prompt(dim, diff, context);
    match run_agent_prompt(agent_id, &prompt, timeout) {
        Ok(run) => {
            let findings = findings::parse_json_findings(&source, dim.id, &run.output);
            ReviewerResult {
                source,
                available: true,
                risk_label: "n/a".to_string(),
                risk_score: 0,
                findings,
                duration_ms: run.duration_ms,
                timed_out: run.timed_out,
                error: run.error,
            }
        }
        Err(reason) => ReviewerResult::skipped(&source, reason),
    }
}

/// Dispatch the Aura engine plus a multi-agent specialist panel over the diff.
///
/// The deterministic engine always runs first (and on this thread — git2
/// handles aren't `Send`). Then every dimension enabled at `tier` (see
/// [`dimensions::for_tier`]) is fanned across the configured agents round-robin:
/// with several agents the panel is genuinely parallel and heterogeneous; with
/// a single agent that one brain runs the whole specialist sweep. Each
/// dimension runs in its own thread (all read-only over the shared tree) and is
/// parsed independently, so one timing-out specialist can't sink the rest.
pub fn dispatch(
    agent_ids: &[String],
    base: &str,
    timeout: Duration,
    tier: Tier,
) -> Vec<ReviewerResult> {
    let diff = capture_diff(base);

    let mut results = vec![run_aura_reviewer(base)];

    // No agents, or nothing to review → the engine pass stands alone.
    if agent_ids.is_empty() || diff.trim().is_empty() {
        return results;
    }

    // Gather history + project context once, shared across the whole panel:
    // recent git churn + Aura intent for the touched files + the repo's learned
    // conventions. Every specialist judges the diff against the same backdrop.
    let context = super::context::gather(&diff).block;

    let dims = dimensions::for_tier(tier);
    let mut handles = Vec::new();
    for (i, dim) in dims.into_iter().enumerate() {
        let agent = agent_ids[i % agent_ids.len()].clone();
        let diff = diff.clone();
        let context = context.clone();
        // `dim` is `&'static Dimension` (CATALOG is a const), so it moves into
        // the thread freely.
        handles.push(std::thread::spawn(move || {
            run_dimension(&agent, dim, &diff, &context, timeout)
        }));
    }

    for h in handles {
        match h.join() {
            Ok(r) => results.push(r),
            Err(_) => results.push(ReviewerResult::skipped(
                "agent",
                "reviewer thread panicked".into(),
            )),
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_agent_is_skipped_not_fatal() {
        let r = run_agent_prompt("definitely-not-an-agent", "x", Duration::from_secs(1));
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("not a known agent"));
    }

    #[test]
    fn empty_diff_runs_engine_only() {
        // With no agents configured, dispatch returns exactly the Aura pass and
        // never tries to fan a panel — regardless of tier.
        let results = dispatch(&[], "HEAD", Duration::from_secs(1), Tier::Max);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].source, "aura");
    }
}
