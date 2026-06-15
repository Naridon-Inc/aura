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
use std::time::{Duration, Instant};

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

/// Run a single agent reviewer in a worker thread, capturing its findings.
fn run_agent_reviewer(agent_id: &str, diff: &str, timeout: Duration) -> ReviewerResult {
    let reg = aura_agents::registry();
    let provider = match reg.get(agent_id) {
        Some(p) => p,
        None => {
            return ReviewerResult::skipped(
                agent_id,
                format!("'{agent_id}' is not a known agent"),
            )
        }
    };
    if !provider.is_available() {
        return ReviewerResult::skipped(
            agent_id,
            format!("'{}' binary not found on PATH — skipped", provider.bin_name()),
        );
    }

    let prompt = build_review_prompt(diff);
    let inv = match provider.build_invocation(&aura_agents::InvokeRequest {
        prompt: &prompt,
        mode: aura_agents::InvokeMode::OneShot,
        resume_session_id: None,
        attachments_via_stdin: false,
        effort: None,
        fast: false,
        model: None,
        approval: None,
    }) {
        Ok(i) => i,
        Err(e) => return ReviewerResult::skipped(agent_id, format!("build invocation: {e}")),
    };

    // Tee output to a per-agent temp file so a chatty reviewer can't
    // deadlock on a full pipe while we poll for the timeout.
    let log_path = std::env::temp_dir().join(format!("aura-review-{agent_id}-{}.log", std::process::id()));
    let log_file = match std::fs::File::create(&log_path) {
        Ok(f) => f,
        Err(e) => return ReviewerResult::skipped(agent_id, format!("create log: {e}")),
    };
    let log_err = match log_file.try_clone() {
        Ok(f) => f,
        Err(e) => return ReviewerResult::skipped(agent_id, format!("dup log: {e}")),
    };

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
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return ReviewerResult::skipped(agent_id, format!("spawn {}: {e}", inv.bin)),
    };

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

    let findings = findings::parse_agent_output(agent_id, &output);
    ReviewerResult {
        source: agent_id.to_string(),
        available: true,
        risk_label: "n/a".to_string(),
        risk_score: 0,
        findings,
        duration_ms,
        timed_out,
        error,
    }
}

fn build_review_prompt(diff: &str) -> String {
    format!(
        "You are a senior code reviewer. Review the following unified diff and report \
concrete issues only. Do NOT modify any files.\n\
\n\
Output ONE finding per line. Each line MUST be:\n\
  <SEVERITY>: <path:line> — <explanation>\n\
where SEVERITY is one of CRITICAL / HIGH / MODERATE / LOW, and <path:line> anchors the \
finding to the exact NEW-file line it concerns (read the `@@ -a,b +c,d @@` hunk headers: \
`+c` is the first new-side line of that hunk; count added/context lines down from there). \
Use a range `path:start-end` only when the issue genuinely spans several lines. Anchor to \
a line that actually appears (added `+` or context) in the diff below. Example:\n\
  HIGH: src/auth/login.rs:42 — token compared with == instead of a constant-time check\n\
  MODERATE: src/net/retry.rs:88-94 — retry loop never backs off between attempts\n\
If you find nothing material, output a single line: \"LOW: no material issues found\".\n\
\n\
=== DIFF ===\n{diff}\n=== END DIFF ===\n"
    )
}

/// Dispatch Aura + every agent reviewer over the diff, in parallel.
/// Returns Aura first, then each agent in the order requested.
pub fn dispatch(agent_ids: &[String], base: &str, timeout: Duration) -> Vec<ReviewerResult> {
    let diff = capture_diff(base);

    // Fan the agent reviewers out across threads; each is read-only.
    let mut handles = Vec::new();
    for id in agent_ids {
        let id = id.clone();
        let diff = diff.clone();
        handles.push(std::thread::spawn(move || {
            run_agent_reviewer(&id, &diff, timeout)
        }));
    }

    // Aura's engine runs on this thread (git2 handles aren't Send).
    let mut results = vec![run_aura_reviewer(base)];
    for h in handles {
        match h.join() {
            Ok(r) => results.push(r),
            Err(_) => results.push(ReviewerResult::skipped("agent", "reviewer thread panicked".into())),
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_embeds_diff_and_forbids_edits() {
        let p = build_review_prompt("diff --git a b");
        assert!(p.contains("diff --git a b"));
        assert!(p.contains("Do NOT modify any files"));
    }

    #[test]
    fn unknown_agent_is_skipped_not_fatal() {
        let r = run_agent_reviewer("definitely-not-an-agent", "x", Duration::from_secs(1));
        assert!(!r.available);
        assert!(r.error.is_some());
        assert!(r.findings.is_empty());
    }

    #[test]
    fn prompt_requests_line_anchors() {
        let p = build_review_prompt("diff --git a b");
        assert!(p.contains("path:line"));
    }
}
