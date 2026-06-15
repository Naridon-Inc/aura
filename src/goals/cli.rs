//! `aura goals …` — the command surface over the durable goal ledger.
//!
//! This is where the decompose-once / prove-on-build loop is exercised by
//! hand: `aura goals prove "<text>"` decomposes a goal ONCE (caching the
//! requirements in the ledger), then checks them against the real code and
//! records the verdict as a run. Later builds re-prove from the cached
//! requirements with no model call. `list` / `show` / `why` read the ledger
//! back in plain language; `link` ties a goal to a board task.
//!
//! Presentation layer only — all state lives in [`super::store`]; the proof
//! engine lives in [`crate::gsd`]. Output is written for a non-engineer:
//! "built and checked", "almost there", "not started yet" — never "AST node
//! not found in checkpoint".

use std::path::Path;

use colored::Colorize;
use serde_json::{json, Value};

use super::model::{Decomposition, GoalRun, Verdict};
use super::store;
use crate::gsd::GsdEngine;

/// Plain-language headline for a verdict — the user's words, no jargon.
fn verdict_headline(v: Verdict) -> &'static str {
    match v {
        Verdict::Verified => "built and checked",
        Verdict::Partial => "almost there",
        Verdict::NotWired => "not started yet",
        Verdict::Unknown => "not checked yet",
    }
}

fn verdict_glyph(v: Verdict) -> colored::ColoredString {
    match v {
        Verdict::Verified => "●".green(),
        Verdict::Partial => "◐".yellow(),
        Verdict::NotWired => "○".red(),
        Verdict::Unknown => "○".dimmed(),
    }
}

/// Resolve a goal by exact id, else by text (find-or-create via the shared
/// hash). Returns the record's id.
fn resolve_goal_id(root: &Path, id_or_text: &str) -> Result<String, String> {
    if id_or_text.starts_with("goal_") {
        if let Some(g) = store::get(root, id_or_text) {
            return Ok(g.id);
        }
    }
    // Treat it as text — find-or-create.
    Ok(store::upsert_by_text(root, id_or_text)?.id)
}

/// Pull `(task_uuid, AURA-seq)` out of a board task ref like "AURA-42".
fn resolve_task(root: &Path, task_ref: &str) -> Option<(String, Option<u64>)> {
    let task = crate::board::get_task(root, task_ref).ok().flatten()?;
    let uuid = task.get("id").and_then(Value::as_str)?.to_string();
    let seq = task.get("sequence_id").and_then(Value::as_u64);
    Some((uuid, seq))
}

/// Current HEAD commit sha (short), if we're in a repo with commits.
fn head_sha(root: &Path) -> Option<String> {
    let repo = git2::Repository::open(root).ok()?;
    let commit = repo.head().ok()?.peel_to_commit().ok()?;
    Some(commit.id().to_string()[..12].to_string())
}

// ── Subcommand: prove ───────────────────────────────────────────────────────

/// Decompose-once + prove + record a durable run. The heart of the spine.
pub fn prove(text: &str, task_ref: Option<&str>, as_json: bool) -> Result<(), String> {
    let root = super::discover_repo_root().ok_or("Not in a project folder.")?;
    let rec = store::upsert_by_text(&root, text)?;

    // Optionally link to a board task up front so the verdict surfaces there.
    if let Some(tr) = task_ref {
        if let Some((uuid, seq)) = resolve_task(&root, tr) {
            store::link_task(&root, &rec.id, &uuid, seq)?;
        } else if !as_json {
            eprintln!("{} couldn't find task {} on the board — proving anyway", "•".dimmed(), tr);
        }
    }

    // Decompose ONCE: reuse the cached breakdown if we have it, otherwise ask
    // the auditor model and cache the result for every future re-prove.
    let requirements = match &rec.decomposition {
        Some(d) if !d.requirements.is_empty() => d.requirements.clone(),
        _ => {
            if !as_json {
                eprintln!("  {} working out what this goal needs (one time)…", "↳".dimmed());
            }
            match GsdEngine::decompose_goal(text) {
                Some(reqs) => {
                    let decomp = Decomposition {
                        requirements: reqs.clone(),
                        decomposed_at: store::now_millis(),
                        model: Some("auditor".to_string()),
                    };
                    store::set_decomposition(&root, &rec.id, decomp)?;
                    reqs
                }
                None => {
                    let outcome = json!({
                        "goal": text, "checks": [], "passed": 0, "total": 0,
                        "verdict": "unknown",
                        "error": "Couldn't work out what this goal needs yet.",
                    });
                    if as_json {
                        println!("{}", serde_json::to_string_pretty(&outcome).unwrap_or_default());
                    } else {
                        eprintln!("{} Couldn't work out what this goal needs yet.", "✗".red());
                    }
                    return Ok(());
                }
            }
        }
    };

    // Prove the (cached) requirements against the latest code snapshot — free,
    // deterministic, no model call.
    let outcome = GsdEngine::prove_requirements(text, &requirements);
    let verdict = Verdict::from_engine(outcome["verdict"].as_str().unwrap_or("unknown"));
    let ok = outcome["passed"].as_u64().unwrap_or(0) as usize;
    let total = outcome["total"].as_u64().unwrap_or(0) as usize;

    // Record the run durably: a rolling "adhoc" manual check (auto-prove on
    // build uses the commit sha as its key, so the two never clobber).
    let files = super::files_from_outcome(&outcome);
    let run = GoalRun {
        run_key: "adhoc".to_string(),
        label: Some("Manual check".to_string()),
        agent_id: std::env::var("AURA_AGENT_ID").ok(),
        verdict,
        ok,
        total,
        commit: head_sha(&root),
        trigger: Some("manual".to_string()),
        files,
        at: store::now_millis(),
    };
    store::record_run(&root, &rec.id, run)?;

    if as_json {
        println!("{}", serde_json::to_string_pretty(&outcome).unwrap_or_default());
    } else {
        print_outcome_report(text, &outcome, verdict);
    }
    Ok(())
}

fn print_outcome_report(goal: &str, outcome: &Value, verdict: Verdict) {
    if let Some(err) = outcome["error"].as_str() {
        eprintln!("{} {}", "✗".red(), err);
        return;
    }
    println!();
    println!("{} {}", verdict_glyph(verdict), goal.bold());
    println!("  {}", verdict_headline(verdict).dimmed());
    println!();
    for check in outcome["checks"].as_array().into_iter().flatten() {
        let name = check["node_name"].as_str().unwrap_or("?");
        let reason = check["reason"].as_str().unwrap_or("");
        let passed = check["passed"].as_bool().unwrap_or(false);
        let glyph = if passed { "✓".green() } else { "·".dimmed() };
        let loc = match (check["file"].as_str(), check["line"].as_u64()) {
            (Some(f), Some(l)) if !f.is_empty() => format!("  {}:{}", f, l).dimmed().to_string(),
            (Some(f), None) if !f.is_empty() => format!("  {}", f).dimmed().to_string(),
            _ => String::new(),
        };
        println!("  {} {}{}", glyph, reason, loc);
        let _ = name;
    }
    println!();
    let ok = outcome["passed"].as_u64().unwrap_or(0);
    let total = outcome["total"].as_u64().unwrap_or(0);
    println!("  {} of {} parts in place", ok.to_string().bold(), total);
}

// ── Subcommand: list ────────────────────────────────────────────────────────

pub fn list(as_json: bool) -> Result<(), String> {
    let root = super::discover_repo_root().ok_or("Not in a project folder.")?;
    let goals = store::load(&root);
    if as_json {
        println!("{}", serde_json::to_string_pretty(&goals).unwrap_or_else(|_| "[]".into()));
        return Ok(());
    }
    if goals.is_empty() {
        println!("{} No goals tracked yet. Try: {}", "ℹ".blue(), "aura goals prove \"<what you're building>\"".cyan());
        return Ok(());
    }
    println!("{} {} goal{}\n", "🎯".bold(), goals.len(), if goals.len() == 1 { "" } else { "s" });
    for g in &goals {
        let (verdict, ok, total, _) = g.rollup();
        let task = g
            .task_seq
            .map(|n| format!("  AURA-{}", n).dimmed().to_string())
            .unwrap_or_default();
        println!("{} {}{}", verdict_glyph(verdict), g.text, task);
        let detail = if total > 0 {
            format!("{} — {} of {} parts", verdict_headline(verdict), ok, total)
        } else {
            verdict_headline(verdict).to_string()
        };
        println!("  {}\n", detail.dimmed());
    }
    Ok(())
}

// ── Subcommand: show / why ──────────────────────────────────────────────────

pub fn show(id_or_text: &str, as_json: bool) -> Result<(), String> {
    let root = super::discover_repo_root().ok_or("Not in a project folder.")?;
    let id = resolve_goal_id(&root, id_or_text)?;
    let g = store::get(&root, &id).ok_or("Goal not found.")?;
    if as_json {
        println!("{}", serde_json::to_string_pretty(&g).unwrap_or_default());
        return Ok(());
    }
    let (verdict, ok, total, _) = g.rollup();
    println!("{} {}", verdict_glyph(verdict), g.text.bold());
    println!("  {}", verdict_headline(verdict).dimmed());
    if let Some(seq) = g.task_seq {
        println!("  part of task {}", format!("AURA-{}", seq).cyan());
    }
    println!();
    if let Some(d) = &g.decomposition {
        println!("  {}", "What it needs:".bold());
        for r in &d.requirements {
            let call = r
                .must_call
                .as_ref()
                .map(|c| format!(" → {}", c))
                .unwrap_or_default();
            println!("    · {}{}", r.node_name, call.dimmed());
        }
        println!();
    }
    if total > 0 {
        println!("  {} of {} parts in place", ok.to_string().bold(), total);
    }
    if let Some(run) = g.runs.first() {
        if !run.files.is_empty() {
            println!("  delivered in: {}", run.files.join(", ").dimmed());
        }
        if let Some(c) = &run.commit {
            println!("  last checked at commit {}", c.dimmed());
        }
    }
    Ok(())
}

/// `aura goals why <goal>` — the plain-language proof: each part, whether it's
/// there, and where it lives in the code.
pub fn why(id_or_text: &str, as_json: bool) -> Result<(), String> {
    let root = super::discover_repo_root().ok_or("Not in a project folder.")?;
    let id = resolve_goal_id(&root, id_or_text)?;
    let g = store::get(&root, &id).ok_or("Goal not found.")?;

    // Re-prove from cached requirements so "why" always reflects the code as it
    // stands right now, not a stale run.
    let requirements = match &g.decomposition {
        Some(d) if !d.requirements.is_empty() => d.requirements.clone(),
        _ => {
            if as_json {
                println!("{}", json!({"goal": g.text, "verdict": "unknown", "error": "Not checked yet — run `aura goals prove` first."}));
            } else {
                println!("{} This goal hasn't been checked yet. Run {} first.", "ℹ".blue(), "aura goals prove".cyan());
            }
            return Ok(());
        }
    };
    let outcome = GsdEngine::prove_requirements(&g.text, &requirements);
    let verdict = Verdict::from_engine(outcome["verdict"].as_str().unwrap_or("unknown"));
    if as_json {
        println!("{}", serde_json::to_string_pretty(&outcome).unwrap_or_default());
    } else {
        print_outcome_report(&g.text, &outcome, verdict);
    }
    Ok(())
}

// ── Subcommand: link ────────────────────────────────────────────────────────

pub fn link(id_or_text: &str, task_ref: &str) -> Result<(), String> {
    let root = super::discover_repo_root().ok_or("Not in a project folder.")?;
    let id = resolve_goal_id(&root, id_or_text)?;
    let (uuid, seq) = resolve_task(&root, task_ref).ok_or_else(|| format!("Couldn't find task {} on the board.", task_ref))?;
    store::link_task(&root, &id, &uuid, seq)?;
    println!("{} Linked goal to {}", "✓".green().bold(), task_ref.cyan());
    Ok(())
}
