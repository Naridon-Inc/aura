//! Semantic CI — the CLI side of `aura-ci`.
//!
//! `aura-ci` owns orchestration + verdict + export but deliberately knows
//! nothing about git, the AST parser, or the goal/taste/intent engines (that
//! would be a crate cycle — `aura-ci` is a dependency of this CLI). So the
//! *facts* a gate needs are gathered HERE and handed in via
//! [`aura_ci::GateContext`]:
//!
//! * staged / changed `AstNode`s (the secret + stub flags ride on them),
//! * the active goal's proof verdict (goal-aligned),
//! * the intent↔AST alignment score (intent-match),
//! * the learned-style findings (taste),
//! * and the REAL `build_verify::verify` runner, wired as a boxed closure so
//!   the `build` gate can run it without `aura-ci` depending on this crate.
//!
//! This module also implements `aura ci run | list | status | export`.

use std::path::Path;

use colored::*;
use git2::Repository;

use crate::config::ConfigManager;
use crate::intent_vs_actual;
use crate::parser::SemanticParser;
use crate::{detect_lang_ext, goals};

use aura_ci::gates::{AlignmentFact, BuildCheck, BuildOutcome, CiNode, GateContext, TasteFinding};
use aura_ci::model::{PipelineRun, Status, StepResult, Trigger};
use aura_ci::RunOpts;

/// Skip-list mirroring the pre-commit capture loop — never parse build
/// artifacts, deps, or Aura's own metadata.
fn is_skippable(path: &str) -> bool {
    path.contains("node_modules/")
        || path.contains(".next/")
        || path.contains("target/")
        || path.contains("dist/")
        || path.contains("build/")
        || path.contains(".cache/")
        || path.contains("__pycache__/")
        || path.contains(".aura/")
        || path.contains(".git/")
        || path.contains("vendor/")
        || path.contains(".turbo/")
        || path.contains(".vercel/")
        || path.contains("coverage/")
        || path.contains(".output/")
}

/// Parse the staged index into `CiNode`s — the same node set the pre-commit
/// gate inspects, projected to the dependency-free shape `aura-ci` reads.
fn staged_nodes(repo: &Repository) -> Vec<CiNode> {
    let mut parser = match SemanticParser::new() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let index = match repo.index() {
        Ok(i) => i,
        Err(_) => return Vec::new(),
    };

    let mut out = Vec::new();
    for entry in index.iter() {
        let path = String::from_utf8_lossy(&entry.path).to_string();
        if is_skippable(&path) {
            continue;
        }
        let ext = detect_lang_ext(&path);
        if ext.is_empty() {
            continue;
        }
        if let Ok(source) = std::fs::read_to_string(&path) {
            if let Ok(nodes) = parser.parse_file_with_path(&source, &ext, &path) {
                for n in nodes {
                    out.push(CiNode {
                        identifier: n.identifier,
                        kind: n.kind,
                        file_path: n.file_path,
                        start_line: n.start_line,
                        contains_secret: n.contains_secret,
                        is_stub: n.is_stub,
                    });
                }
            }
        }
    }
    out
}

/// Parse the `base..HEAD` diff into `CiNode`s for the `pr` trigger. We parse
/// the working tree's current content for changed files (the same files the PR
/// touches) — the secret/stub flags are content-derived, so this matches what
/// the cloud workflow sees after checkout.
fn diff_nodes(repo: &Repository, base: &str) -> Vec<CiNode> {
    let mut parser = match SemanticParser::new() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };

    // Resolve base..HEAD changed paths.
    let changed = changed_paths(repo, base).unwrap_or_default();
    let workdir = repo.workdir();

    let mut out = Vec::new();
    for path in changed {
        if is_skippable(&path) {
            continue;
        }
        let ext = detect_lang_ext(&path);
        if ext.is_empty() {
            continue;
        }
        let abs = workdir.map(|w| w.join(&path)).unwrap_or_else(|| Path::new(&path).to_path_buf());
        if let Ok(source) = std::fs::read_to_string(&abs) {
            if let Ok(nodes) = parser.parse_file_with_path(&source, &ext, &path) {
                for n in nodes {
                    out.push(CiNode {
                        identifier: n.identifier,
                        kind: n.kind,
                        file_path: n.file_path,
                        start_line: n.start_line,
                        contains_secret: n.contains_secret,
                        is_stub: n.is_stub,
                    });
                }
            }
        }
    }
    out
}

fn changed_paths(repo: &Repository, base: &str) -> Result<Vec<String>, git2::Error> {
    let base_obj = repo.revparse_single(base)?;
    let base_tree = base_obj.peel_to_tree()?;
    let head_tree = repo.head()?.peel_to_tree()?;
    let mut opts = git2::DiffOptions::new();
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;
    let mut paths = Vec::new();
    for delta in diff.deltas() {
        if let Some(p) = delta.new_file().path() {
            paths.push(p.to_string_lossy().to_string());
        }
    }
    Ok(paths)
}

/// Resolve the comparison base for a `pr` run. The frontend (and a bare
/// `aura ci run --trigger pr`) supplies the sentinel default `HEAD`, which would
/// diff HEAD..HEAD = nothing and silently check zero changed files. When the
/// caller left it at that default, we instead resolve the **merge-base of HEAD
/// with the repo's default branch** — the same commit a GitHub PR diffs against
/// — so the secret / stub gates actually see the work this branch introduces.
///
/// An explicit `--base <ref>` is always honored verbatim. If we can't find a
/// default branch or compute a merge-base (e.g. a fresh repo with one commit),
/// we fall back to the caller's value so the run still proceeds rather than
/// erroring.
fn resolve_pr_base(repo: &Repository, base_arg: &str) -> String {
    // The user passed something other than the default sentinel — honor it.
    if base_arg != "HEAD" {
        return base_arg.to_string();
    }

    let Ok(head) = repo.head().and_then(|h| h.peel_to_commit()) else {
        return base_arg.to_string();
    };

    for candidate in default_branch_candidates(repo) {
        if let Ok(obj) = repo.revparse_single(&candidate) {
            if let Ok(commit) = obj.peel_to_commit() {
                // Don't diff a branch against itself (e.g. on `main`/`master`).
                if commit.id() == head.id() {
                    continue;
                }
                if let Ok(merge_base) = repo.merge_base(head.id(), commit.id()) {
                    return merge_base.to_string();
                }
                // No common ancestor (unrelated history) — diff against the
                // branch tip directly rather than giving up.
                return commit.id().to_string();
            }
        }
    }

    base_arg.to_string()
}

/// Ordered list of refs to try as the repo's default branch: the remote's
/// published default (`origin/HEAD`), then the conventional `main` / `master`,
/// preferring the remote-tracking form so a stale local branch doesn't win.
fn default_branch_candidates(repo: &Repository) -> Vec<String> {
    let mut out = Vec::new();

    // `origin/HEAD` points at the remote's default branch when the clone set it.
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = reference.symbolic_target() {
            // e.g. "refs/remotes/origin/main" → "origin/main"
            if let Some(short) = target.strip_prefix("refs/remotes/") {
                out.push(short.to_string());
            }
        }
    }

    for name in ["main", "master"] {
        out.push(format!("origin/{}", name));
        out.push(name.to_string());
    }

    out.dedup();
    out
}

/// Gather the active goal's proof verdict for the `goal-aligned` gate. Reads
/// the goal ledger (no model call) — the live verdict from the last build.
fn goal_fact(root: &Path) -> Option<AlignmentFact> {
    let (task_uuid, _seq) = goals::active::resolve(root)?;
    let records = goals::store::for_task(root, &task_uuid);
    let goal = records.into_iter().next()?;
    let (verdict, ok, total, _) = goal.rollup();
    let verdict_str = match verdict {
        goals::Verdict::Verified => "verified",
        goals::Verdict::Partial => "partial",
        goals::Verdict::NotWired => "not_wired",
        goals::Verdict::Unknown => "unknown",
    };
    Some(AlignmentFact {
        label: goal.text,
        verdict: Some(verdict_str.to_string()),
        score: None,
        ok,
        total,
    })
}

/// Gather the intent↔AST alignment score for the `intent-match` gate. Only
/// available against a real commit (the `pr` / post-commit path); pre-commit
/// has no commit yet, so this returns `None` and the gate cleanly skips.
fn intent_fact(sha_or_ref: &str) -> Option<AlignmentFact> {
    let report = intent_vs_actual::run(sha_or_ref).ok()?;
    if report.stated.is_empty() {
        return None;
    }
    Some(AlignmentFact {
        label: report.commit_message.clone(),
        verdict: None,
        score: Some(report.alignment_score),
        ok: report.aligned_nodes.len(),
        total: report.aligned_nodes.len() + report.mismatched_nodes.len(),
    })
}

/// Gather learned-style findings for the `taste` gate, honoring the same
/// dev-mode bypass the inline gate uses. `None` = facts not gathered (the gate
/// skips).
fn taste_fact(repo: &Repository, config: &crate::config::AuraConfig) -> Option<Vec<TasteFinding>> {
    if config.dev_mode {
        return None;
    }
    let report = crate::taste::check::check_staged(repo, config.taste_strict_threshold).ok()?;
    Some(
        report
            .violations
            .into_iter()
            .map(|v| TasteFinding {
                file_path: v.file_path,
                rule_statement: v.rule_statement,
                reason: v.reason,
            })
            .collect(),
    )
}

/// Build the full `GateContext` for `trigger`. `base` is used by the `pr`
/// trigger to scope the diff + intent score.
pub fn build_context(repo: &Repository, root: &Path, trigger: Trigger, base: &str) -> GateContext {
    let config = ConfigManager::load();

    let nodes = match trigger {
        Trigger::Pr => diff_nodes(repo, base),
        _ => staged_nodes(repo),
    };

    let intent = match trigger {
        // Pre-commit has no commit yet — skip. PR / manual score against HEAD
        // (or the supplied ref).
        Trigger::PreCommit => None,
        _ => intent_fact("HEAD"),
    };

    // The build gate's real runner, wired as a boxed closure. `build_verify`
    // detects the project type from cwd and runs cargo/tsc/go/mypy under the
    // budget — we never reimplement it.
    let run_build: Box<dyn Fn(u64) -> BuildOutcome + Send + Sync> = Box::new(|budget_secs| {
        let status = crate::build_verify::verify(budget_secs);
        BuildOutcome {
            status: status.status.clone(),
            duration_ms: status.duration_ms,
            checks: status
                .checks
                .iter()
                .map(|c| BuildCheck {
                    name: c.name.clone(),
                    status: c.status.clone(),
                    stderr_tail: c.stderr_tail.clone(),
                })
                .collect(),
        }
    });

    GateContext {
        nodes,
        secret_allowlist: config.secret_allowlist.clone(),
        goal: goal_fact(root),
        intent,
        taste: taste_fact(repo, &config),
        run_build: Some(run_build),
    }
}

/// `aura ci run` — gather facts, run the matching pipeline(s), print the
/// verdict. Returns the process exit code (non-zero when a blocking step
/// failed, so the pre-push hook / CI job fails the build).
pub fn cmd_run(trigger_str: &str, base: &str, json: bool) -> i32 {
    let repo = match Repository::open(".") {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Semantic CI: not a git repository ({})", e);
            return 2;
        }
    };
    let root = match repo.workdir() {
        Some(w) => w.to_path_buf(),
        None => {
            eprintln!("Semantic CI: bare repository unsupported");
            return 2;
        }
    };

    let trigger = match Trigger::parse(trigger_str) {
        Some(t) => t,
        None => {
            eprintln!(
                "Semantic CI: unknown trigger `{}` (use pre-commit/pre-push/pr/manual)",
                trigger_str
            );
            return 2;
        }
    };

    // For a `pr` run with the default sentinel base, diff against the
    // merge-base with the default branch (what a real PR compares against)
    // instead of HEAD..HEAD, which would see zero changed files.
    let resolved_base = match trigger {
        Trigger::Pr => resolve_pr_base(&repo, base),
        _ => base.to_string(),
    };

    let ctx = build_context(&repo, &root, trigger, &resolved_base);
    let runs = match aura_ci::run(&root, trigger, &ctx, &RunOpts::default()) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Semantic CI: {}", e);
            return 2;
        }
    };

    if json {
        match serde_json::to_string_pretty(&runs) {
            Ok(s) => println!("{}", s),
            Err(e) => {
                eprintln!("Semantic CI: failed to serialize result: {}", e);
                return 2;
            }
        }
    } else {
        print_runs(&runs);
    }

    if aura_ci::any_blocked(&runs) {
        1
    } else {
        0
    }
}

/// `aura ci list` — show the declared pipelines (or the built-in default).
pub fn cmd_list(json: bool) -> i32 {
    let root = std::env::current_dir().unwrap_or_else(|_| Path::new(".").to_path_buf());
    let pipelines = match aura_ci::load_pipelines(&root) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Semantic CI: {}", e);
            return 2;
        }
    };

    if json {
        match serde_json::to_string_pretty(&pipelines) {
            Ok(s) => println!("{}", s),
            Err(_) => return 2,
        }
        return 0;
    }

    let dir = root.join(".aura").join("pipelines");
    if dir.is_dir() {
        println!("{} Pipelines (from {})", "✓".green().bold(), ".aura/pipelines/".dimmed());
    } else {
        println!(
            "{} No .aura/pipelines/ — using the built-in default. Run {} to write a starter.",
            "·".dimmed(),
            "aura ci export".cyan()
        );
    }
    for p in &pipelines {
        let triggers: Vec<&str> = p.triggers.iter().map(|t| t.as_str()).collect();
        println!("\n  {} {}  ({})", "▸".cyan(), p.name.bold(), triggers.join(", ").dimmed());
        for step in &p.steps {
            let kind = match &step.kind {
                aura_ci::StepKind::Gate(id) => format!("gate {}", id),
                aura_ci::StepKind::Run(cmd) => format!("run `{}`", cmd),
            };
            let posture = if step.blocking { "blocking".yellow() } else { "advisory".dimmed() };
            println!("    {} {}  {} [{}]", "•".dimmed(), step.name, kind.dimmed(), posture);
        }
    }
    0
}

/// `aura ci status` — a quick verdict against the staged work (pre-commit
/// trigger), human-readable.
pub fn cmd_status() -> i32 {
    cmd_run("pre-commit", "HEAD", false)
}

/// `aura ci export` — write the GitHub Actions workflow from the same pipelines.
pub fn cmd_export(out: &str) -> i32 {
    let root = std::env::current_dir().unwrap_or_else(|_| Path::new(".").to_path_buf());
    let pipelines = match aura_ci::load_pipelines(&root) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Semantic CI: {}", e);
            return 2;
        }
    };
    let yaml = aura_ci::export::github_workflow(&pipelines);
    let out_path = root.join(out);
    if let Some(parent) = out_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("Semantic CI: couldn't create {}: {}", parent.display(), e);
            return 2;
        }
    }
    if let Err(e) = std::fs::write(&out_path, &yaml) {
        eprintln!("Semantic CI: couldn't write {}: {}", out_path.display(), e);
        return 2;
    }
    println!(
        "{} Wrote {} — runs the same checks in the cloud on every PR.",
        "✓".green().bold(),
        out.cyan()
    );
    println!("  {} Commit it, push, and GitHub will run your Semantic CI.", "↳".dimmed());
    0
}

/// Project already-parsed CLI `AstNode`s into the dependency-free `CiNode`
/// shape `aura-ci` reads. Lets the pre-commit hook reuse the nodes it already
/// parsed instead of re-parsing the staged tree.
pub fn project_nodes(nodes: &[crate::models::AstNode]) -> Vec<CiNode> {
    nodes
        .iter()
        .map(|n| CiNode {
            identifier: n.identifier.clone(),
            kind: n.kind.clone(),
            file_path: n.file_path.clone(),
            start_line: n.start_line,
            contains_secret: n.contains_secret,
            is_stub: n.is_stub,
        })
        .collect()
}

/// Run the pipeline from inside the pre-commit hook, *additively*, reusing the
/// `AstNode`s the hook already parsed (no second parse of the staged tree).
///
/// The inline pre-commit gates (secret guard, taste) already own blocking with
/// their exact strict-mode / dev-mode / dialoguer semantics — we do NOT
/// re-block here, or a secret would be flagged twice. Instead this records the
/// named pipeline result and prints one calm summary line so the commit is now
/// described as a Semantic CI run ("the pipeline IS the gate now") without
/// changing whether the commit proceeds. Best-effort: any failure is swallowed.
///
/// Returns the runs so a caller could persist/seal them later (Phase 5).
pub fn run_pre_commit_additive(
    repo: &Repository,
    root: &Path,
    staged: &[crate::models::AstNode],
) -> Vec<PipelineRun> {
    let config = ConfigManager::load();
    let ctx = GateContext {
        nodes: project_nodes(staged),
        secret_allowlist: config.secret_allowlist.clone(),
        goal: goal_fact(root),
        intent: None, // no commit yet at pre-commit time
        taste: taste_fact(repo, &config),
        // The build gate is pre-push/pr only, so no closure is needed here; a
        // None cleanly skips it if a custom pipeline puts `build` on pre-commit.
        run_build: None,
    };
    let runs = match aura_ci::run(root, Trigger::PreCommit, &ctx, &RunOpts::default()) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    for run in &runs {
        // One calm line. The inline gates above already shouted about any hard
        // block; here we just name the pipeline that ran.
        let passed = run
            .steps
            .iter()
            .filter(|s| s.status == Status::Pass)
            .count();
        let total_ran = run
            .steps
            .iter()
            .filter(|s| s.status != Status::Skip)
            .count();
        if total_ran == 0 {
            continue;
        }
        println!(
            "  {} Semantic CI `{}`: {}/{} checks passed.",
            "↳".dimmed(),
            run.pipeline.dimmed(),
            passed,
            total_ran
        );
    }
    runs
}

/// Record the post-commit goal proofs as a named `goal-aligned` Semantic CI
/// step result. Called from the post-commit (PersistCheckpoint) arm right after
/// `goals::build::prove_active_on_commit` runs — it reuses those proofs (no
/// re-prove) and shapes them into a [`PipelineRun`] so the post-commit goal
/// check is a named pipeline step, not a one-off print. Returns the run for any
/// later persistence/seal (Phase 5). Best-effort; never affects the commit.
pub fn record_goal_aligned_post_commit(proofs: &[goals::build::BuildProof]) -> Option<PipelineRun> {
    if proofs.is_empty() {
        return None;
    }
    let steps: Vec<StepResult> = proofs
        .iter()
        .map(|p| {
            let (status, summary) = match p.verdict {
                goals::Verdict::Verified => (
                    Status::Pass,
                    format!("This delivers the goal “{}”.", p.goal_text),
                ),
                goals::Verdict::Partial => (
                    Status::Fail,
                    format!(
                        "Part of the goal “{}” is built ({} of {} parts).",
                        p.goal_text, p.ok, p.total
                    ),
                ),
                goals::Verdict::NotWired => (
                    Status::Fail,
                    format!("None of the goal “{}” is built yet.", p.goal_text),
                ),
                goals::Verdict::Unknown => (
                    Status::Skip,
                    format!("Can't tell yet whether this builds “{}”.", p.goal_text),
                ),
            };
            StepResult {
                name: "Builds toward the goal".to_string(),
                kind: "gate:goal-aligned".to_string(),
                // goal-aligned is advisory — a goal not fully built is info,
                // never a reason to have blocked the commit that just landed.
                status,
                blocking: false,
                summary,
                detail: Some(format!("Goal: {}\nParts built: {} of {}", p.goal_text, p.ok, p.total)),
                duration_ms: 0,
            }
        })
        .collect();
    // Recorded after the commit landed; tagged Manual (the "here is the
    // result" context) rather than a hook trigger — it never gated anything.
    Some(PipelineRun::finalize(
        "default".to_string(),
        Trigger::Manual,
        steps,
        0,
    ))
}

/// Human output for a set of pipeline runs — verdict-first, plain language.
fn print_runs(runs: &[PipelineRun]) {
    if runs.is_empty() {
        println!("{} No checks ran for this step.", "·".dimmed());
        return;
    }
    for run in runs {
        println!("\n{}", run.headline.bold());
        for step in &run.steps {
            let glyph = match step.status {
                Status::Pass => step.status.glyph().green(),
                Status::Fail => step.status.glyph().red(),
                Status::Timeout => step.status.glyph().yellow(),
                Status::Skip => step.status.glyph().dimmed(),
            };
            let tag = if step.status.is_failure() && !step.blocking {
                " (advice)".dimmed().to_string()
            } else {
                String::new()
            };
            println!("  {} {}{}", glyph, step.name, tag);
            if step.status.is_failure() {
                println!("      {}", step.summary.dimmed());
            }
        }
        if run.blocked {
            println!(
                "\n{} One of these stopped the commit. Fix it, or override with {}.",
                "✗".red().bold(),
                "--force".italic()
            );
        }
    }
}
