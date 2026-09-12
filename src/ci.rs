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

/// The paths a commit would actually carry: HEAD's tree against the index.
///
/// Not `index.iter()`. An index entry exists for every *tracked* file in the
/// repository, so iterating it is a list of the whole checkout — which is why
/// the gate answered a three-file commit with "829 pieces of code look
/// half-finished" and why the honest response to it became `AURA_SKIP=1`. A
/// gate that reports the repository when asked about a change is not strict,
/// it is uninformative, and people switch those off.
///
/// A repository with no commits yet has no HEAD tree, and there `None` is the
/// right base: everything staged is genuinely new.
fn staged_paths(repo: &Repository) -> Result<Vec<String>, git2::Error> {
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let diff = repo.diff_tree_to_index(head_tree.as_ref(), None, None)?;
    let mut paths = Vec::new();
    for delta in diff.deltas() {
        // The new path, so a rename is checked where it landed. A delete has
        // no new file worth parsing and is skipped by the read below.
        if let Some(p) = delta.new_file().path() {
            paths.push(p.to_string_lossy().to_string());
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// Parse the staged change into `CiNode`s — the same node set the pre-commit
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
    let changed = match staged_paths(repo) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };

    let mut out = Vec::new();
    for path in changed {
        if is_skippable(&path) {
            continue;
        }
        let ext = detect_lang_ext(&path);
        if ext.is_empty() {
            continue;
        }
        // The staged blob, not the file on disk. `verify_intent::scan` says the
        // same thing about the same question: an unstaged edit must not be able
        // to change the verdict on a commit that does not contain it — in
        // either direction. Reading the working tree meant a secret still open
        // in the editor could fail a commit that had already dropped it, and a
        // secret staged and then wiped from the buffer could pass one that
        // carried it.
        //
        // An entry is absent for a staged deletion, which is the other half of
        // why this is keyed on the index rather than the path: there is nothing
        // to parse in a file the commit removes.
        let Some(entry) = index.get_path(Path::new(&path), 0) else { continue };
        let Ok(blob) = repo.find_blob(entry.id) else { continue };
        let Ok(source) = std::str::from_utf8(blob.content()) else { continue };
        if let Ok(nodes) = parser.parse_file_with_path(source, &ext, &path) {
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
/// their exact strict-mode / dev-mode / dialoguer semantics — this function
/// does not re-block those, or a secret would be flagged twice. It records the
/// named pipeline result and prints one calm summary line, so the commit is now
/// described as a Semantic CI run ("the pipeline IS the gate now").
///
/// It does not decide anything itself. Blocking is the caller's to enforce, via
/// [`unenforced_blockers`] on the returned runs — for a long time nobody did,
/// and a step declared `blocking` was inert while its own headline claimed it
/// had stopped the commit. Best-effort: any failure to run is swallowed and
/// reported as no runs, which blocks nothing.
///
/// Returns the runs so the caller can enforce them, and persist/seal them later
/// (Phase 5).
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

/// Gate ids the pre-commit hook enforces *inline*, before the pipeline runs,
/// with their own strict-mode / allowlist / confirm semantics.
///
/// These are the only two. Everything else a pipeline can declare —
/// `no-stubs`, `goal-aligned`, `intent-match`, `build`, and any `run:` shell
/// step — has no other enforcer at pre-commit time, so if the pipeline does not
/// act on it, nothing does.
const INLINE_ENFORCED_GATES: [&str; 2] = ["gate:no-secrets", "gate:taste"];

/// The failing blocking steps that nothing else has already stopped the commit
/// over.
///
/// This closes the hole between what `.aura/pipelines` *says* and what the hook
/// *does*. `PipelineRun::finalize` sets `blocked` whenever a step marked
/// `blocking` fails, and the headline then reads "1 stopped the commit" — but
/// the pre-commit path deliberately ran the pipeline additively and threw that
/// verdict away, so the commit went through anyway. Declaring a step blocking
/// did nothing, and the record claimed it had done everything.
///
/// Steps in `INLINE_ENFORCED_GATES` are excluded, not forgotten: the inline
/// gates own those with semantics the pipeline does not know (strict mode,
/// the secret allowlist, dev mode, the interactive confirm), and re-blocking
/// here would flag one secret twice and override a decision the user already
/// made at the prompt.
pub fn unenforced_blockers(runs: &[PipelineRun]) -> Vec<&StepResult> {
    runs.iter()
        .flat_map(|run| run.steps.iter())
        .filter(|step| step.blocking && step.status.is_failure())
        .filter(|step| !INLINE_ENFORCED_GATES.contains(&step.kind.as_str()))
        .collect()
}

/// Print the blocking failures the pipeline found and nothing else enforced.
///
/// Kept beside `unenforced_blockers` rather than inlined at the call site so
/// the hook's own voice — one finding per line, then one line saying what to do
/// — stays in the module that owns the wording.
pub fn print_unenforced_blockers(blockers: &[&StepResult]) {
    println!(
        "{} Semantic CI: {} blocking {} failed. Commit halted!",
        "🚨".red().bold(),
        blockers.len(),
        if blockers.len() == 1 { "check" } else { "checks" }
    );
    for step in blockers {
        println!("  {} {}: {}", "✗".red(), step.name.yellow(), step.summary);
    }
    println!(
        "  {} Fix the finding, or drop `blocking` for that step in {}.",
        "💡".blue(),
        ".aura/pipelines".italic()
    );
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
            // Not "--force": `aura ci run` has no such flag, so the old line
            // handed the reader an argument clap rejects outright. And not
            // "the commit" unconditionally either — a `pr` or `manual` run has
            // no commit in front of it to stop. Point at the declaration
            // instead, which is the lever that actually exists.
            let verb = match run.trigger {
                Trigger::PreCommit => "stopped the commit",
                Trigger::PrePush => "stopped the push",
                Trigger::Pr | Trigger::Manual => "would stop a commit",
            };
            println!(
                "\n{} One of these {}. Fix it, or drop `blocking` for that step in {}.",
                "✗".red().bold(),
                verb,
                ".aura/pipelines".italic()
            );
        }
    }
}

#[cfg(test)]
mod blocking_enforcement_tests {
    use super::*;
    use aura_ci::model::Status;

    fn step(name: &str, kind: &str, blocking: bool, status: Status) -> StepResult {
        StepResult {
            name: name.into(),
            kind: kind.into(),
            status,
            blocking,
            summary: "…".into(),
            detail: None,
            duration_ms: 1,
        }
    }

    fn run_of(steps: Vec<StepResult>) -> PipelineRun {
        PipelineRun::finalize("default".into(), Trigger::PreCommit, steps, 1)
    }

    #[test]
    fn a_failing_blocking_step_with_no_inline_enforcer_is_reported() {
        // `no-stubs` has no inline gate in the pre-commit path, so if the
        // pipeline does not stop the commit over it, nothing does.
        let runs = vec![run_of(vec![step(
            "no half-finished code",
            "gate:no-stubs",
            true,
            Status::Fail,
        )])];
        let blockers = unenforced_blockers(&runs);
        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].name, "no half-finished code");
    }

    #[test]
    fn an_advisory_failure_never_blocks() {
        let runs = vec![run_of(vec![step(
            "goal",
            "gate:goal-aligned",
            false,
            Status::Fail,
        )])];
        assert!(unenforced_blockers(&runs).is_empty());
    }

    #[test]
    fn the_inline_gates_are_left_to_the_inline_gates() {
        // Both already halted the commit above with strict-mode, allowlist and
        // confirm semantics the pipeline does not know. Re-reporting them here
        // would flag one secret twice and could override a "yes, continue" the
        // user already gave at the prompt.
        let runs = vec![run_of(vec![
            step("secrets", "gate:no-secrets", true, Status::Fail),
            step("taste", "gate:taste", true, Status::Fail),
        ])];
        assert!(unenforced_blockers(&runs).is_empty());
    }

    #[test]
    fn a_blocking_shell_step_is_enforced() {
        // A `run:` step is the case with the least excuse for being inert —
        // the user wrote a command and said it must pass.
        let runs = vec![run_of(vec![step("npm test", "run", true, Status::Fail)])];
        assert_eq!(unenforced_blockers(&runs).len(), 1);
    }

    #[test]
    fn a_timeout_counts_as_a_failure() {
        // Status::Timeout is a failure for `blocked`; it must be one here too,
        // or a step that hangs is a step that passes.
        let runs = vec![run_of(vec![step(
            "build",
            "gate:build",
            true,
            Status::Timeout,
        )])];
        assert_eq!(unenforced_blockers(&runs).len(), 1);
    }

    #[test]
    fn a_passing_pipeline_blocks_nothing() {
        let runs = vec![run_of(vec![
            step("secrets", "gate:no-secrets", true, Status::Pass),
            step("no-stubs", "gate:no-stubs", true, Status::Pass),
            step("skipped", "gate:build", true, Status::Skip),
        ])];
        assert!(unenforced_blockers(&runs).is_empty());
    }

    #[test]
    fn blockers_are_collected_across_every_pipeline_that_ran() {
        let runs = vec![
            run_of(vec![step("a", "gate:no-stubs", true, Status::Fail)]),
            run_of(vec![step("b", "run", true, Status::Fail)]),
        ];
        assert_eq!(unenforced_blockers(&runs).len(), 2);
    }
}

#[cfg(test)]
mod staged_scope_tests {
    use super::*;
    use std::fs;

    /// A repository with one commit holding two files, and nothing staged.
    fn repo_with_two_files() -> (tempfile::TempDir, Repository) {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = Repository::init(dir.path()).expect("init");
        fs::write(dir.path().join("touched.ts"), "export function a() { return 1; }\n").unwrap();
        fs::write(dir.path().join("untouched.ts"), "export function b() { return 2; }\n").unwrap();

        let oid = {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("touched.ts")).unwrap();
            index.add_path(Path::new("untouched.ts")).unwrap();
            index.write().unwrap();
            index.write_tree().unwrap()
        };
        {
            let tree = repo.find_tree(oid).unwrap();
            let who = git2::Signature::now("t", "t@example.com").unwrap();
            repo.commit(Some("HEAD"), &who, &who, "first", &tree, &[])
                .unwrap();
        }
        (dir, repo)
    }

    fn stage(repo: &Repository, dir: &Path, path: &str, source: &str) {
        fs::write(dir.join(path), source).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(path)).unwrap();
        index.write().unwrap();
    }

    /// The bug this rule exists for. `index.iter()` is every *tracked* file, so
    /// the gate used to answer a one-file commit with the whole repository —
    /// 829 findings on a three-file change, in the real case that surfaced it.
    #[test]
    fn a_one_file_commit_is_one_file() {
        let (dir, repo) = repo_with_two_files();
        stage(&repo, dir.path(), "touched.ts", "export function a() { return 99; }\n");

        assert_eq!(staged_paths(&repo).unwrap(), vec!["touched.ts".to_string()]);
    }

    /// Nothing staged is nothing to check — not "everything in the checkout".
    #[test]
    fn an_empty_commit_checks_nothing() {
        let (_dir, repo) = repo_with_two_files();
        assert!(staged_paths(&repo).unwrap().is_empty());
    }

    /// An edit sitting in the working tree is not part of the commit being
    /// made, so it must not decide the verdict on it — in either direction. A
    /// secret still open in the editor should not fail a commit that already
    /// dropped it, and a secret staged and then wiped from the buffer should
    /// not pass one that carries it.
    #[test]
    fn an_unstaged_edit_does_not_reach_the_verdict() {
        let (dir, repo) = repo_with_two_files();
        stage(&repo, dir.path(), "touched.ts", "export function a() { return 99; }\n");
        // Written to disk only — never added to the index.
        fs::write(dir.path().join("untouched.ts"), "export function leaked() {}\n").unwrap();

        assert_eq!(staged_paths(&repo).unwrap(), vec!["touched.ts".to_string()]);
        let nodes = staged_nodes(&repo);
        assert!(
            nodes.iter().all(|n| n.file_path.as_deref() == Some("touched.ts")),
            "{nodes:?}"
        );
        assert!(
            nodes.iter().all(|n| n.identifier.as_deref() != Some("leaked")),
            "{nodes:?}"
        );
    }

    /// A staged deletion has no content to parse, and the file it removes must
    /// not be read off disk on the way past.
    #[test]
    fn a_staged_deletion_parses_nothing_and_does_not_panic() {
        let (dir, repo) = repo_with_two_files();
        fs::remove_file(dir.path().join("untouched.ts")).unwrap();
        let mut index = repo.index().unwrap();
        index.remove_path(Path::new("untouched.ts")).unwrap();
        index.write().unwrap();

        assert_eq!(staged_paths(&repo).unwrap(), vec!["untouched.ts".to_string()]);
        assert!(staged_nodes(&repo).is_empty());
    }
}
