//! `aura replay` — Replay Lab.
//!
//! Re-run a logged objective across N coding agents in isolated git
//! worktrees, then rank the results by *semantic correctness* (the
//! in-worktree `aura pr-review` risk), not just exit code. Direct parity
//! with entire.io's Replay Lab — and a step past it: each run is scored on
//! Aura's AST risk and fed back into the skill ledger, so replaying also
//! improves auto-routing (Wave 1).
//!
//! Layout (DDD): [`worktree`] owns isolation + orphan cleanup, [`runner`]
//! executes one agent, [`score`] ranks, and this module is the
//! orchestration + report persistence + ledger feedback.

pub mod runner;
pub mod score;
pub mod worktree;

use colored::Colorize;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

use runner::ReplayRun;
use score::ScoredRun;

/// CLI subcommands under `aura replay`.
#[derive(clap::Subcommand)]
pub enum ReplayAction {
    /// Replay an objective across agents in isolated worktrees and rank
    /// the results.
    Run {
        /// What to replay: `latest` (most recent logged intent), a
        /// recency index (`1` = most recent), or an intent timestamp.
        /// Ignored when --objective is given.
        #[arg(default_value = "latest")]
        target: String,
        /// Replay this exact objective instead of resolving one from the
        /// intent log.
        #[arg(long)]
        objective: Option<String>,
        /// Comma-separated agent ids (e.g. `claude,gemini`). Defaults to
        /// every CLI-wrapper agent found on PATH.
        #[arg(long)]
        agents: Option<String>,
        /// Base branch the per-result semantic review diffs against.
        #[arg(long, default_value = "master")]
        base: String,
        /// Per-agent wall-clock timeout in seconds.
        #[arg(long, default_value_t = 900)]
        timeout_secs: u64,
        /// Write the report JSON to this path (in addition to
        /// `.aura/replays/<id>.json`).
        #[arg(long)]
        out: Option<String>,
        /// Don't record the runs to the skill ledger.
        #[arg(long)]
        no_record: bool,
        /// Leave the per-agent worktrees on disk for inspection.
        #[arg(long)]
        keep_worktrees: bool,
        /// Emit the report as JSON instead of a table.
        #[arg(long)]
        json: bool,
    },
    /// Show a saved replay report by id.
    Report {
        /// Report id (the `<id>` in `.aura/replays/<id>.json`).
        id: String,
        #[arg(long)]
        json: bool,
    },
}

/// Persisted report — one replay across agents.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReplayReport {
    pub id: String,
    pub objective: String,
    /// Where the objective came from (e.g. "latest intent @ 1717…").
    pub source: String,
    pub base: String,
    pub created_at_ms: u64,
    pub runs: Vec<ReplayRunReport>,
}

/// Per-agent row in a [`ReplayReport`], ranked best-first.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReplayRunReport {
    pub rank: usize,
    pub agent_id: String,
    pub available: bool,
    pub score: f64,
    pub risk_label: String,
    pub risk_score: u64,
    pub pr_pass: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
    pub files_changed: usize,
    pub patch_lines: usize,
    pub est_tokens_in: u64,
    pub est_tokens_out: u64,
    pub cost_usd: f64,
    pub verdict: String,
    pub kept_at: Option<String>,
    pub error: Option<String>,
    /// The full unified diff this agent produced.
    pub patch: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn run(action: &ReplayAction) -> Result<(), String> {
    match action {
        ReplayAction::Run {
            target,
            objective,
            agents,
            base,
            timeout_secs,
            out,
            no_record,
            keep_worktrees,
            json,
        } => run_replay(
            target,
            objective.as_deref(),
            agents.as_deref(),
            base,
            *timeout_secs,
            out.as_deref(),
            !*no_record,
            *keep_worktrees,
            *json,
        ),
        ReplayAction::Report { id, json } => show_report(id, *json),
    }
}

fn resolve_repo_root() -> Result<PathBuf, String> {
    let repo = git2::Repository::open(".")
        .map_err(|e| format!("not inside a git repository: {e}"))?;
    repo.workdir()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "bare repositories are not supported by replay".to_string())
}

/// Resolve the objective text + a human label for where it came from.
fn resolve_objective(target: &str, objective_override: Option<&str>) -> Result<(String, String), String> {
    if let Some(o) = objective_override {
        if o.trim().is_empty() {
            return Err("--objective was empty".to_string());
        }
        return Ok((o.to_string(), "explicit --objective".to_string()));
    }
    let rows = crate::intent_query::read_all_rows(Path::new(".aura/intent_log.jsonl"));
    if rows.is_empty() {
        return Err(
            "no intent log found — run some work first, or pass --objective \"…\"".to_string(),
        );
    }
    // read_all_rows preserves file order: oldest first, newest last.
    if target == "latest" {
        let r = rows.last().unwrap();
        return Ok((r.intent.clone(), format!("latest intent @ {}", r.timestamp)));
    }
    if let Ok(n) = target.parse::<u64>() {
        // Small values are a 1-based recency index; large values are an
        // exact intent timestamp.
        if n >= 1 && (n as usize) <= rows.len() && n < 100_000 {
            let r = &rows[rows.len() - n as usize];
            return Ok((r.intent.clone(), format!("intent #{n} @ {}", r.timestamp)));
        }
        if let Some(r) = rows.iter().find(|r| r.timestamp == n) {
            return Ok((r.intent.clone(), format!("intent @ {}", r.timestamp)));
        }
    }
    Err(format!(
        "could not resolve '{target}' — use `latest`, a recency index (1 = most recent), \
an intent timestamp, or --objective \"…\""
    ))
}

/// Decide which agents to replay across.
fn resolve_agents(agents: Option<&str>) -> Result<Vec<String>, String> {
    if let Some(list) = agents {
        let v: Vec<String> = list
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if v.is_empty() {
            return Err("--agents was empty".to_string());
        }
        return Ok(v);
    }
    // Default: the CLI-wrapper agents actually installed.
    let reg = aura_agents::registry();
    let available: Vec<String> = ["claude", "gemini", "codex", "cursor"]
        .iter()
        .filter(|id| reg.get(**id).map(|p| p.is_available()).unwrap_or(false))
        .map(|id| id.to_string())
        .collect();
    if available.is_empty() {
        return Err(
            "no agent CLIs found on PATH (looked for claude, gemini, codex, cursor) — \
pass --agents explicitly"
                .to_string(),
        );
    }
    Ok(available)
}

#[allow(clippy::too_many_arguments)]
fn run_replay(
    target: &str,
    objective_override: Option<&str>,
    agents: Option<&str>,
    base: &str,
    timeout_secs: u64,
    out: Option<&str>,
    record: bool,
    keep_worktrees: bool,
    json: bool,
) -> Result<(), String> {
    let repo_root = resolve_repo_root()?;
    let (objective, source) = resolve_objective(target, objective_override)?;
    let agent_ids = resolve_agents(agents)?;
    let aura_bin = std::env::current_exe().map_err(|e| format!("locate aura binary: {e}"))?;
    let timeout = Duration::from_secs(timeout_secs);
    let id = format!("replay-{}", now_ms());

    eprintln!(
        "{} replaying {} across {}: {}",
        "▶".cyan().bold(),
        source.dimmed(),
        agent_ids.join(", ").bold(),
        truncate(&objective, 80),
    );

    let mut runs: Vec<ReplayRun> = Vec::new();
    for agent in &agent_ids {
        eprintln!("  {} {} …", "·".dimmed(), agent.bold());
        let r = runner::run_one(&repo_root, &aura_bin, agent, &objective, base, timeout, keep_worktrees);
        if let Some(err) = &r.error {
            if !r.available {
                eprintln!("    {} {}", "skipped".yellow(), err);
            } else {
                eprintln!("    {} {}", "error".red(), err);
            }
        } else {
            eprintln!(
                "    {} {} file(s) in {}ms",
                "done".green(),
                r.files_changed,
                r.duration_ms
            );
        }
        runs.push(r);
    }

    let scored = score::rank(runs);
    let report = build_report(id, objective, source, base.to_string(), &scored);

    // Persist to .aura/replays/<id>.json (+ optional --out copy).
    let dir = repo_root.join(".aura").join("replays");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let report_path = dir.join(format!("{}.json", report.id));
    let report_json = serde_json::to_string_pretty(&report)
        .map_err(|e| format!("serialize report: {e}"))?;
    std::fs::write(&report_path, &report_json)
        .map_err(|e| format!("write {}: {e}", report_path.display()))?;
    if let Some(o) = out {
        std::fs::write(o, &report_json).map_err(|e| format!("write {o}: {e}"))?;
    }

    // Feed the routing ledger (best-effort).
    let recorded = if record {
        record_outcomes(&aura_bin, &report)
    } else {
        0
    };

    if json {
        println!("{report_json}");
    } else {
        print_report(&report, &report_path, recorded, record);
    }
    Ok(())
}

fn build_report(
    id: String,
    objective: String,
    source: String,
    base: String,
    scored: &[ScoredRun],
) -> ReplayReport {
    let runs = scored
        .iter()
        .enumerate()
        .map(|(i, s)| ReplayRunReport {
            rank: i + 1,
            agent_id: s.run.agent_id.clone(),
            available: s.run.available,
            score: s.score,
            risk_label: s.risk_label.clone(),
            risk_score: s.risk_score,
            pr_pass: s.pr_pass,
            exit_code: s.run.exit_code,
            timed_out: s.run.timed_out,
            duration_ms: s.run.duration_ms,
            files_changed: s.run.files_changed,
            patch_lines: s.run.patch_lines,
            est_tokens_in: s.run.est_tokens_in,
            est_tokens_out: s.run.est_tokens_out,
            cost_usd: s.run.cost_usd,
            verdict: s.verdict.clone(),
            kept_at: s.run.kept_at.clone(),
            error: s.run.error.clone(),
            patch: s.run.patch.clone(),
        })
        .collect();
    ReplayReport {
        id,
        objective,
        source,
        base,
        created_at_ms: now_ms(),
        runs,
    }
}

/// Record each successful run as a skill outcome so replay feeds routing.
/// Best-effort: a missing cloud sign-in just means 0 recorded.
fn record_outcomes(aura_bin: &Path, report: &ReplayReport) -> usize {
    let mut count = 0;
    for r in &report.runs {
        if !r.available || r.files_changed == 0 {
            continue;
        }
        let coarse = classify_coarse(&report.objective);
        let exts = patch_extensions(&r.patch);
        let grade = score::risk_to_grade(&r.risk_label, r.exit_code == Some(0) && !r.timed_out, true);
        let body = serde_json::json!({
            "provider_id": r.agent_id,
            "manager_session_id": report.id,
            "manager_task_id": r.rank,
            "exit_code": r.exit_code,
            "duration_ms": r.duration_ms,
            "user_rating": 0,
            "pr_review_pass": r.pr_pass,
            "token_input": r.est_tokens_in,
            "token_output": r.est_tokens_out,
            "cost_usd": r.cost_usd,
            "brain_quality_grade": grade,
            "brain_quality_reason": format!("replay: {}", r.verdict),
            "taxonomy": {
                "coarse_category": coarse,
                "free_tags": ["replay"],
                "file_extensions": exts,
            },
            "created_at": report.created_at_ms,
        });
        let ok = std::process::Command::new(aura_bin)
            .args(["skill", "record", "--json"])
            .arg(body.to_string())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            count += 1;
        }
    }
    count
}

/// Heuristic coarse category for the skill ledger taxonomy (kebab-case to
/// match the cloud's accepted set). Deliberately simple — the value only
/// buckets the outcome; the real signal is the quality grade.
fn classify_coarse(objective: &str) -> &'static str {
    let o = objective.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| o.contains(w));
    if has(&["security", "vuln", "auth", "credential", "exploit"]) {
        "security-review"
    } else if has(&["ui", "frontend", "css", "react", "component", "button", "style"]) {
        "frontend"
    } else if has(&["api", "backend", "server", "endpoint", "database", "db", "sql", "query"]) {
        "backend"
    } else if has(&["infra", "deploy", "docker", "ci", "pipeline", "kubernetes", "terraform"]) {
        "infra"
    } else if has(&["architecture", "design", "refactor structure", "module boundaries"]) {
        "architecture-review"
    } else {
        "refactor"
    }
}

/// Distinct file extensions present in a unified diff (from `+++ b/…`).
fn patch_extensions(patch: &str) -> Vec<String> {
    let mut exts: Vec<String> = Vec::new();
    for line in patch.lines() {
        if let Some(path) = line.strip_prefix("+++ b/") {
            if let Some(dot) = path.rfind('.') {
                let ext = format!(".{}", &path[dot + 1..]);
                if !exts.contains(&ext) {
                    exts.push(ext);
                }
            }
        }
    }
    exts.truncate(6);
    exts
}

fn show_report(id: &str, json: bool) -> Result<(), String> {
    let repo_root = resolve_repo_root()?;
    // Accept both the bare id and the file stem with/without prefix.
    let candidates = [
        repo_root.join(".aura").join("replays").join(format!("{id}.json")),
        repo_root.join(".aura").join("replays").join(format!("replay-{id}.json")),
    ];
    let path = candidates
        .iter()
        .find(|p| p.exists())
        .ok_or_else(|| format!("no replay report '{id}' under .aura/replays/"))?;
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if json {
        println!("{raw}");
        return Ok(());
    }
    let report: ReplayReport =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    print_report(&report, path, 0, false);
    Ok(())
}

fn print_report(report: &ReplayReport, path: &Path, recorded: usize, record: bool) {
    println!(
        "\n{} {}",
        "Replay".bold(),
        report.id.cyan(),
    );
    println!("  objective: {}", truncate(&report.objective, 100));
    println!(
        "  source: {} · base: {}\n",
        report.source.dimmed(),
        report.base.dimmed()
    );
    println!(
        "  {:<2} {:<9} {:>7}  {:<9} {:>5} {:>7} {:>7}  {}",
        "#".dimmed(),
        "AGENT".dimmed(),
        "SCORE".dimmed(),
        "RISK".dimmed(),
        "FILES".dimmed(),
        "TOKENS".dimmed(),
        "TIME".dimmed(),
        "VERDICT".dimmed(),
    );
    for r in &report.runs {
        let rank = if r.available && r.files_changed > 0 {
            r.rank.to_string()
        } else {
            "-".to_string()
        };
        let score = if r.available && r.files_changed > 0 {
            format!("{:.3}", r.score)
        } else {
            "—".to_string()
        };
        let tokens = fmt_tokens(r.est_tokens_in + r.est_tokens_out);
        let time = fmt_ms(r.duration_ms);
        let agent = if r.rank == 1 && r.available && r.files_changed > 0 {
            r.agent_id.green().bold().to_string()
        } else {
            r.agent_id.clone()
        };
        println!(
            "  {:<2} {:<9} {:>7}  {:<9} {:>5} {:>7} {:>7}  {}",
            rank,
            agent,
            score,
            r.risk_label,
            if r.files_changed > 0 { r.files_changed.to_string() } else { "—".to_string() },
            tokens,
            time,
            r.verdict,
        );
    }
    // Winner = first ranked run that actually produced a working result.
    if let Some(w) = report.runs.iter().find(|r| r.available && r.files_changed > 0) {
        println!("\n  {} {}", "Winner:".bold(), w.agent_id.green().bold());
    } else {
        println!("\n  {} no agent produced changes.", "·".dimmed());
    }
    println!("  {} {}", "Report:".dimmed(), path.display());
    if record {
        println!(
            "  {} recorded {} outcome(s) to the skill ledger.",
            "↳".dimmed(),
            recorded
        );
    }
}

fn truncate(s: &str, max: usize) -> String {
    let one_line = s.replace('\n', " ");
    if one_line.chars().count() <= max {
        one_line
    } else {
        let kept: String = one_line.chars().take(max.saturating_sub(1)).collect();
        format!("{kept}…")
    }
}

fn fmt_tokens(n: u64) -> String {
    if n >= 1000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        n.to_string()
    }
}

fn fmt_ms(ms: u64) -> String {
    if ms >= 60_000 {
        format!("{}m{}s", ms / 60_000, (ms % 60_000) / 1000)
    } else if ms >= 1000 {
        format!("{}s", ms / 1000)
    } else {
        format!("{ms}ms")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_agents_parses_csv() {
        let v = resolve_agents(Some("claude, gemini ,codex")).unwrap();
        assert_eq!(v, vec!["claude", "gemini", "codex"]);
        assert!(resolve_agents(Some("  ")).is_err());
    }

    #[test]
    fn classify_coarse_buckets() {
        assert_eq!(classify_coarse("Add OAuth login to the API"), "security-review");
        assert_eq!(classify_coarse("Restyle the React button component"), "frontend");
        assert_eq!(classify_coarse("Add a new server endpoint"), "backend");
        assert_eq!(classify_coarse("Update the docker deploy pipeline"), "infra");
        assert_eq!(classify_coarse("Rename a helper"), "refactor");
    }

    #[test]
    fn patch_extensions_dedup() {
        let patch = "+++ b/src/a.rs\n+++ b/src/b.rs\n+++ b/src/c.ts\n+++ b/README";
        let exts = patch_extensions(patch);
        assert_eq!(exts, vec![".rs", ".ts"]);
    }

    #[test]
    fn truncate_collapses_and_caps() {
        assert_eq!(truncate("a\nb", 10), "a b");
        assert_eq!(truncate(&"x".repeat(20), 5), "xxxx…");
    }

    #[test]
    fn fmt_helpers() {
        assert_eq!(fmt_tokens(2500), "2.5k");
        assert_eq!(fmt_tokens(900), "900");
        assert_eq!(fmt_ms(65000), "1m5s");
        assert_eq!(fmt_ms(4500), "4s");
        assert_eq!(fmt_ms(250), "250ms");
    }
}
