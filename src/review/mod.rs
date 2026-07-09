//! Role-driven `aura review` — entire.io's reviewer/fixer model on top of
//! Aura's deterministic semantic engine.
//!
//! `aura review setup` persists per-repo roles; `aura review run` dispatches
//! the Aura engine plus every reviewer agent over the diff in parallel and
//! aggregates their findings; `aura review fix` opens the `[Y]es · [s]elect
//! · [n]o` picker and applies the chosen fixes via the fixer agent. The
//! pre-existing `aura review list|show` PR-review inbox is untouched — these
//! are additive subcommands.

pub mod context;
pub mod dimensions;
pub mod findings;
pub mod fix;
pub mod github;
pub mod reviewer;
pub mod roles;
pub mod verify;

use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use colored::Colorize;
use serde::{Deserialize, Serialize};

use findings::Finding;
use roles::ReviewRoles;

/// Persisted aggregate of one `aura review run`, so `aura review fix` can
/// act on the findings without re-spawning every reviewer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleReviewReport {
    pub created_at_ms: u64,
    pub base: String,
    pub risk_label: String,
    pub risk_score: u64,
    /// Depth the panel ran at ("low".."max") — which specialist dimensions fired.
    #[serde(default)]
    pub tier: String,
    /// The agent that ran the adversarial verify pass, or `None` if it was
    /// skipped (disabled, or no agent available).
    #[serde(default)]
    pub verified_by: Option<String>,
    /// How many candidate findings the verifier refuted (dropped as false
    /// positives) and how many it confirmed.
    #[serde(default)]
    pub refuted: usize,
    #[serde(default)]
    pub confirmed: usize,
    pub reviewers: Vec<ReviewerSummary>,
    pub findings: Vec<Finding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewerSummary {
    pub source: String,
    pub available: bool,
    pub finding_count: usize,
    pub risk_label: String,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub error: Option<String>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn resolve_repo_root() -> Result<PathBuf, String> {
    let repo = git2::Repository::open(".").map_err(|e| format!("not inside a git repository: {e}"))?;
    repo.workdir()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "bare repositories are not supported by review".to_string())
}

fn report_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("reviews").join("role-latest.json")
}

fn read_line() -> String {
    let mut s = String::new();
    let _ = std::io::stdin().lock().read_line(&mut s);
    s.trim().to_string()
}

fn prompt(label: &str, default: &str) -> String {
    if default.is_empty() {
        print!("{label}: ");
    } else {
        print!("{label} [{}]: ", default.dimmed());
    }
    let _ = std::io::stdout().flush();
    let v = read_line();
    if v.is_empty() {
        default.to_string()
    } else {
        v
    }
}

// ---------------------------------------------------------------------------
// setup / roles
// ---------------------------------------------------------------------------

/// `aura review setup` — persist reviewer/fixer roles for this repo.
pub fn run_setup(
    reviewers: Option<&str>,
    fixer: Option<&str>,
    base: Option<&str>,
    json: bool,
) -> Result<(), String> {
    let repo_root = resolve_repo_root()?;
    let mut r = ReviewRoles::load_or_seed(&repo_root);

    let any_flag = reviewers.is_some() || fixer.is_some() || base.is_some();
    if any_flag {
        if let Some(rv) = reviewers {
            r.reviewers = roles::parse_agent_csv(rv);
        }
        if let Some(fx) = fixer {
            r.fixer = if fx.trim().is_empty() { None } else { Some(fx.trim().to_string()) };
        }
        if let Some(b) = base {
            r.base = b.trim().to_string();
        }
    } else if std::io::stdin().is_terminal() {
        let available = roles::available_agents();
        let hint = if available.is_empty() {
            "claude,gemini".to_string()
        } else {
            available.join(",")
        };
        let joined = r.reviewers.join(",");
        let rv = prompt("Reviewer agents (comma-separated)", joined.max_or(&hint));
        r.reviewers = roles::parse_agent_csv(&rv);
        let fx_default = r.fixer.clone().unwrap_or_else(|| available.first().cloned().unwrap_or_default());
        let fx = prompt("Fixer agent", &fx_default);
        r.fixer = if fx.is_empty() { None } else { Some(fx) };
        r.base = prompt("Base branch", &r.base);
    }

    r.reviewers = r.sanitized_reviewers();
    r.save(&repo_root).map_err(|e| format!("could not save roles: {e}"))?;

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&r).map_err(|e| e.to_string())?
        );
    } else {
        println!("{} Review roles saved to {}", "✓".green(), roles::ReviewRoles::path(&repo_root).display().to_string().dimmed());
        print_roles(&r);
    }
    Ok(())
}

/// `aura review roles` — show the configured roles.
pub fn show_roles(json: bool) -> Result<(), String> {
    let repo_root = resolve_repo_root()?;
    match ReviewRoles::load(&repo_root) {
        Some(r) => {
            if json {
                println!("{}", serde_json::to_string_pretty(&r).map_err(|e| e.to_string())?);
            } else {
                print_roles(&r);
            }
        }
        None => {
            let seeded = ReviewRoles::seed(&repo_root);
            if json {
                println!("{}", serde_json::to_string_pretty(&seeded).map_err(|e| e.to_string())?);
            } else {
                println!("{} No roles configured yet — run `aura review setup`. Defaults:", "·".dimmed());
                print_roles(&seeded);
            }
        }
    }
    Ok(())
}

fn print_roles(r: &ReviewRoles) {
    let reviewers = if r.reviewers.is_empty() {
        "(none — Aura engine only)".dimmed().to_string()
    } else {
        r.reviewers.join(", ").cyan().to_string()
    };
    println!("  {} {}", "reviewers:".bold(), reviewers);
    println!(
        "  {} {}",
        "fixer:".bold(),
        r.fixer.clone().unwrap_or_else(|| "(none)".to_string()).cyan()
    );
    println!("  {} {}", "base:".bold(), r.base.yellow());
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/// `aura review run` — dispatch the specialist panel over the diff, aggregate,
/// adversarially verify, and calibrate.
///
/// `depth` selects how wide the panel is (see [`dimensions::Tier`]); `no_verify`
/// skips the adversarial false-positive cull (faster, noisier).
pub fn run_roles_review(
    reviewers: Option<&str>,
    fixer: Option<&str>,
    base: Option<&str>,
    depth: Option<&str>,
    no_verify: bool,
    timeout_secs: u64,
    json: bool,
) -> Result<(), String> {
    let repo_root = resolve_repo_root()?;
    let mut r = ReviewRoles::load_or_seed(&repo_root);
    if let Some(rv) = reviewers {
        r.reviewers = roles::parse_agent_csv(rv);
    }
    if let Some(fx) = fixer {
        r.fixer = Some(fx.trim().to_string());
    }
    if let Some(b) = base {
        r.base = b.trim().to_string();
    }
    let agent_ids = r.sanitized_reviewers();
    let base = r.base.clone();
    let tier = depth.map(dimensions::Tier::parse).unwrap_or(dimensions::Tier::Medium);
    let timeout = Duration::from_secs(timeout_secs);

    if !json {
        let dims = dimensions::for_tier(tier).len();
        println!(
            "\n{} role review against {} — Aura engine + {} agent(s) over {} specialist dimension(s) at depth {}",
            "🔍".bold(),
            base.yellow(),
            agent_ids.len(),
            dims,
            tier.label().cyan(),
        );
    }

    let results = reviewer::dispatch(&agent_ids, &base, timeout, tier);

    // Aura's engine is always results[0]; use it for the overall risk.
    let (risk_label, risk_score) = results
        .first()
        .map(|a| (a.risk_label.clone(), a.risk_score))
        .unwrap_or_else(|| ("n/a".to_string(), 0));

    let all: Vec<Finding> = results.iter().flat_map(|res| res.findings.clone()).collect();
    let aggregated = findings::aggregate(all);

    // Adversarial verify (best-effort) → context calibration. The verifier is a
    // fresh skeptic: prefer the configured fixer, else the first reviewer.
    let verifier_id = r.fixer.clone().or_else(|| agent_ids.first().cloned());
    let verified = if no_verify {
        verify::VerifyOutcome {
            findings: aggregated,
            refuted: 0,
            confirmed: 0,
            verifier: None,
            note: Some("verification disabled (--no-verify)".to_string()),
        }
    } else {
        if !json {
            println!("  {} adversarial verify pass…", "↳".dimmed());
        }
        let diff = reviewer::capture_diff(&base);
        verify::verify(verifier_id.as_deref(), aggregated, &diff, timeout)
    };
    if !json {
        if let Some(note) = &verified.note {
            println!("    {} {}", "·".dimmed(), note.dimmed());
        }
    }
    let calibrated = findings::calibrate(verified.findings);

    let summaries: Vec<ReviewerSummary> = results
        .iter()
        .map(|res| ReviewerSummary {
            source: res.source.clone(),
            available: res.available,
            finding_count: res.findings.len(),
            risk_label: res.risk_label.clone(),
            duration_ms: res.duration_ms,
            timed_out: res.timed_out,
            error: res.error.clone(),
        })
        .collect();

    let report = RoleReviewReport {
        created_at_ms: now_ms(),
        base: base.clone(),
        risk_label,
        risk_score,
        tier: tier.label().to_string(),
        verified_by: verified.verifier.clone(),
        refuted: verified.refuted,
        confirmed: verified.confirmed,
        reviewers: summaries,
        findings: calibrated,
    };
    persist_report(&repo_root, &report)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?);
    } else {
        print_report(&report);
        if r.fixer.is_some() && !report.findings.is_empty() {
            println!(
                "\n  {} run {} to apply fixes",
                "↳".dimmed(),
                "aura review fix".cyan()
            );
        }
    }
    Ok(())
}

fn persist_report(repo_root: &Path, report: &RoleReviewReport) -> Result<(), String> {
    let p = report_path(repo_root);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create reviews dir: {e}"))?;
    }
    let body = serde_json::to_string_pretty(report).map_err(|e| e.to_string())?;
    std::fs::write(&p, body).map_err(|e| format!("write report: {e}"))
}

fn print_report(report: &RoleReviewReport) {
    println!("\n{}", "Reviewers".bold().cyan());
    for s in &report.reviewers {
        let status = if !s.available {
            s.error.clone().unwrap_or_else(|| "unavailable".into()).dimmed().to_string()
        } else if s.timed_out {
            "timed out".red().to_string()
        } else if let Some(e) = &s.error {
            e.red().to_string()
        } else {
            format!("{} finding(s) in {}ms", s.finding_count, s.duration_ms).dimmed().to_string()
        };
        let risk = if s.source == "aura" {
            format!(" risk={}", s.risk_label)
        } else {
            String::new()
        };
        println!("  {} {}{}", s.source.bold(), status, risk.yellow());
    }

    let badge = match report.risk_label.as_str() {
        "CRITICAL" => report.risk_label.red().bold(),
        "MODERATE" => report.risk_label.yellow().bold(),
        "LOW" => report.risk_label.green().bold(),
        other => other.normal(),
    };
    println!(
        "\n{} {}  (score {})  {} finding(s)",
        "Aura risk:".bold(),
        badge,
        report.risk_score,
        report.findings.len()
    );

    // Verification line — what the adversarial pass did.
    match &report.verified_by {
        Some(v) => println!(
            "{} verified by {} · {} confirmed · {} refuted (false positives dropped)",
            "Verify:".bold(),
            v.cyan(),
            report.confirmed.to_string().green(),
            report.refuted.to_string().yellow(),
        ),
        None => println!("{} {}", "Verify:".bold(), "skipped".dimmed()),
    }

    // Blocking vs advisory split — what a human must look at first.
    let blocking = report
        .findings
        .iter()
        .filter(|f| f.severity >= findings::Severity::High)
        .count();
    if blocking > 0 {
        println!(
            "{} {} blocking (High/Critical) · {} advisory",
            "Gate:".bold(),
            blocking.to_string().red().bold(),
            (report.findings.len() - blocking).to_string().dimmed(),
        );
    }

    if report.findings.is_empty() {
        println!("  {}", "no findings — clean".green());
        return;
    }
    println!("\n{}", "Findings (worst first)".bold().cyan());
    for (i, f) in report.findings.iter().enumerate() {
        let sev = match f.severity {
            findings::Severity::Critical => f.severity.label().red().bold(),
            findings::Severity::High => f.severity.label().red(),
            findings::Severity::Moderate => f.severity.label().yellow(),
            findings::Severity::Advisory => f.severity.label().blue(),
            findings::Severity::Info => f.severity.label().dimmed(),
        };
        // Location chip: file:line when anchored, else file, else nothing.
        let loc = match (&f.file, f.line) {
            (Some(file), Some(line)) => format!(" {}", format!("{file}:{line}").dimmed()),
            (Some(file), None) => format!(" {}", file.dimmed()),
            _ => String::new(),
        };
        // Provenance chip: the specialist dimension(s), else the raw source.
        let dim = f
            .dimension
            .clone()
            .unwrap_or_else(|| f.source.clone());
        let corro = if f.agreement > 1 {
            format!(" ×{}", f.agreement).green().to_string()
        } else {
            String::new()
        };
        println!(
            "  {:>2}. {} {}{}  {}{}",
            i + 1,
            sev,
            f.title.white(),
            loc,
            format!("[{dim}]").dimmed(),
            corro,
        );
        if let Some(r) = &f.rationale {
            println!("      {}", clip_line(r, 140).dimmed());
        }
    }
}

/// One-line clip for terminal display (rationale preview under a finding).
fn clip_line(s: &str, n: usize) -> String {
    let one = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= n {
        one
    } else {
        let mut out: String = one.chars().take(n.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

// ---------------------------------------------------------------------------
// fix
// ---------------------------------------------------------------------------

/// `aura review fix` — pick findings and apply them via the fixer.
pub fn run_fix(base: Option<&str>, fixer: Option<&str>, yes: bool, json: bool) -> Result<(), String> {
    let repo_root = resolve_repo_root()?;
    let roles = ReviewRoles::load_or_seed(&repo_root);
    let base_branch = base
        .map(|s| s.to_string())
        .unwrap_or_else(|| roles.base.clone());
    let fixer_id = fixer.map(|s| s.to_string()).or_else(|| roles.fixer.clone());

    // Prefer the findings from the last `aura review run`; otherwise run a
    // quick Aura-only pass so `fix` works standalone.
    let findings = match load_report(&repo_root) {
        Some(rep) if !rep.findings.is_empty() => rep.findings,
        _ => {
            if !json {
                println!("{} no prior review — running Aura engine…", "·".dimmed());
            }
            reviewer::run_aura_reviewer(&base_branch).findings
        }
    };

    let picked = fix::pick(&findings, yes);
    let selected = match picked {
        fix::Picked::Selected(s) => s,
        fix::Picked::None => {
            if json {
                println!("{}", serde_json::json!({"applied": false, "reason": "no selection"}));
            }
            return Ok(());
        }
    };

    let summary = fix::apply(&repo_root, fixer_id.as_deref(), &base_branch, &selected)?;
    if json {
        println!(
            "{}",
            serde_json::json!({"applied": true, "summary": summary, "count": selected.len()})
        );
    } else {
        println!("{} {}", "✓".green(), summary);
        println!(
            "  {} review the diff, then run {} to re-check",
            "↳".dimmed(),
            format!("aura pr-review --base {base_branch}").cyan()
        );
    }
    Ok(())
}

fn load_report(repo_root: &Path) -> Option<RoleReviewReport> {
    let raw = std::fs::read_to_string(report_path(repo_root)).ok()?;
    serde_json::from_str(&raw).ok()
}

// ---------------------------------------------------------------------------
// post — line-anchored inline comments on a GitHub PR
// ---------------------------------------------------------------------------

/// `aura review post` — post the latest review's findings to a GitHub PR as
/// line-anchored inline comments, submitted as ONE pull-request review. With
/// `--dry-run` it builds and prints the exact payload without contacting
/// GitHub. Uses the persisted `aura review run` report when present; otherwise
/// runs a fast Aura-only pass so it works standalone.
pub fn run_post(
    pr: Option<u64>,
    base: Option<&str>,
    dry_run: bool,
    json: bool,
) -> Result<(), String> {
    let repo_root = resolve_repo_root()?;
    let roles = ReviewRoles::load_or_seed(&repo_root);
    let base_branch = base.map(|s| s.to_string()).unwrap_or_else(|| roles.base.clone());

    // Prefer the last full review; fall back to a deterministic Aura-only pass.
    let (findings, risk_label, risk_score) = match load_report(&repo_root) {
        Some(rep) if !rep.findings.is_empty() => (rep.findings, rep.risk_label, rep.risk_score),
        _ => {
            if !json {
                println!("{} no prior `aura review run` — running Aura engine…", "·".dimmed());
            }
            let a = reviewer::run_aura_reviewer(&base_branch);
            (a.findings, a.risk_label, a.risk_score)
        }
    };

    // Resolve the PR + its head commit + unified diff via `gh`.
    let target = github::resolve_pr(pr)?;
    let diff = github::fetch_diff(target.number)?;
    let idx = github::DiffIndex::parse(&diff);

    let header = compose_header(&risk_label, risk_score, &findings);
    let payload = github::build_payload(&findings, &header, &target.head_oid, &idx);
    let inline = payload.comments.len();

    if dry_run {
        let pretty = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
        if json {
            println!("{pretty}");
        } else {
            println!(
                "\n{} dry run — would post {} inline comment(s) to {} (commit {})",
                "🔍".bold(),
                inline,
                target.slug().cyan(),
                short_sha(&target.head_oid).dimmed(),
            );
            println!("\n{pretty}");
        }
        return Ok(());
    }

    let url = github::submit(&target, &payload)?;
    if json {
        println!(
            "{}",
            serde_json::json!({
                "posted": true,
                "pr": target.number,
                "inline_comments": inline,
                "url": url,
            })
        );
    } else {
        println!(
            "\n{} posted {} inline comment(s) to {} — {}",
            "✓".green().bold(),
            inline,
            target.slug().cyan(),
            url.underline(),
        );
    }
    Ok(())
}

/// Markdown header for the review body: risk badge + finding counts.
fn compose_header(risk_label: &str, risk_score: u64, findings: &[Finding]) -> String {
    let worst = github::worst_label(findings);
    format!(
        "## 🔍 Aura review\n\n**Risk:** {risk_label} (score {risk_score}) · **{}** finding(s) · worst severity **{worst}**\n\n_Inline comments below are anchored to the exact changed lines._",
        findings.len()
    )
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(8).collect()
}

/// Tiny helper: pick the non-empty of two strings (self, fallback).
trait MaxOr {
    fn max_or<'a>(&'a self, fallback: &'a str) -> &'a str;
}
impl MaxOr for String {
    fn max_or<'a>(&'a self, fallback: &'a str) -> &'a str {
        if self.trim().is_empty() {
            fallback
        } else {
            self.as_str()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_roundtrips() {
        let rep = RoleReviewReport {
            created_at_ms: 123,
            base: "main".into(),
            risk_label: "LOW".into(),
            risk_score: 5,
            tier: "medium".into(),
            verified_by: Some("claude".into()),
            refuted: 2,
            confirmed: 3,
            reviewers: vec![ReviewerSummary {
                source: "aura".into(),
                available: true,
                finding_count: 1,
                risk_label: "LOW".into(),
                duration_ms: 10,
                timed_out: false,
                error: None,
            }],
            findings: vec![Finding::new("aura", findings::Severity::High, "x")],
        };
        let s = serde_json::to_string(&rep).unwrap();
        let back: RoleReviewReport = serde_json::from_str(&s).unwrap();
        assert_eq!(back.base, "main");
        assert_eq!(back.findings.len(), 1);
    }

    #[test]
    fn max_or_picks_nonempty() {
        assert_eq!(String::new().max_or("fb"), "fb");
        assert_eq!("x".to_string().max_or("fb"), "x");
    }
}
