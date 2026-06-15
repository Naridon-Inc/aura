//! # Semantic CI — Aura's own CI/CD
//!
//! Aura already runs scattered, hardcoded "checks on git events": a secret
//! guard, a taste gate, AST stub detection, intent↔AST alignment, goal
//! auto-prove, a real `build_verify` runner, and a server-side red-blocks-push
//! gate. What was missing was a way to **declare, name, order, see, and
//! export** those gates as one pipeline.
//!
//! `aura-ci` is exactly that — a *declarative semantic pipeline*. It does NOT
//! run a hosted runner farm; it orchestrates the gates Aura already owns. A
//! git-tracked [`Pipeline`](model::Pipeline) lives in `.aura/pipelines/*.toml`;
//! each [`Step`](model::Step) is either a `run` (ordinary shell command) or a
//! `gate` (one of Aura's semantic verbs — `no-secrets`, `no-stubs`,
//! `goal-aligned`, `intent-match`, `taste`, `build`). The same TOML drives the
//! local git hooks AND the exported GitHub Action.
//!
//! ## Dependency direction
//!
//! `aura-ci` deliberately does NOT depend on `aura-cli` (which would be a
//! cycle — the CLI depends on this crate). The semantic *facts* that live in
//! the CLI — the staged `AstNode`s, the diff sets, the stated intent, the
//! active-goal proof, and the real `build_verify::verify` call — are handed in
//! by the CLI via a [`GateContext`](gates::GateContext). This crate owns
//! orchestration + verdict + export; the CLI owns fact-gathering.
//!
//! ## Entry point
//!
//! [`run`] loads the pipelines, runs the one(s) matching `trigger` against the
//! caller-supplied facts, and returns a [`PipelineRun`](model::PipelineRun).

pub mod executor;
pub mod export;
pub mod gates;
pub mod model;
pub mod parse;

pub use gates::{
    AlignmentFact, BuildCheck, BuildOutcome, CiNode, GateContext, TasteFinding,
};
pub use model::{Pipeline, PipelineRun, Status, Step, StepKind, StepResult, Trigger};

use std::path::Path;

/// Options for a pipeline run.
#[derive(Debug, Clone, Default)]
pub struct RunOpts {
    /// Run only the pipeline with this name (else run every loaded pipeline).
    pub only: Option<String>,
}

/// Load `.aura/pipelines/*.toml` under `root` (or the built-in default), run
/// every pipeline matching `trigger` against the caller-supplied `ctx`, and
/// return the runs.
///
/// The caller (the CLI) gathers the facts into `ctx`; this function never
/// re-parses the tree or re-runs git. Most repos have one pipeline, but a repo
/// may declare several (e.g. a fast `pre-commit` one and a heavy `pr` one) —
/// each that fires for `trigger` produces one [`PipelineRun`].
pub fn run(
    root: &Path,
    trigger: Trigger,
    ctx: &GateContext,
    opts: &RunOpts,
) -> anyhow::Result<Vec<PipelineRun>> {
    let pipelines = parse::load(root)?;
    let mut runs = Vec::new();
    for pipeline in &pipelines {
        if let Some(only) = &opts.only {
            if &pipeline.name != only {
                continue;
            }
        }
        // A pipeline fires for `trigger` if it has any step that would run.
        if pipeline.steps_for(trigger).is_empty() {
            continue;
        }
        runs.push(executor::run(pipeline, trigger, ctx, root));
    }
    Ok(runs)
}

/// Load the declared pipelines (or the built-in default) without running them —
/// for `aura ci list` and the export path.
pub fn load_pipelines(root: &Path) -> anyhow::Result<Vec<Pipeline>> {
    parse::load(root)
}

/// True when any of `runs` is blocked (a blocking step failed). The CLI / CI
/// job uses this to set its exit code.
pub fn any_blocked(runs: &[PipelineRun]) -> bool {
    runs.iter().any(|r| r.blocked)
}

// Semantic CI Phase 5: seal PipelineRun into .aura/attest via aura-attestation

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_default_pipeline_with_empty_ctx_passes() {
        // No facts gathered → gates that need facts Skip, the pipeline passes.
        let tmp = std::env::temp_dir().join(format!("aura-ci-lib-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let ctx = GateContext::default();
        let runs = run(&tmp, Trigger::PreCommit, &ctx, &RunOpts::default()).unwrap();
        assert_eq!(runs.len(), 1);
        let r = &runs[0];
        assert_eq!(r.pipeline, "default");
        // Empty staged set → no-secrets + no-stubs pass; goal-aligned skips.
        assert!(!r.blocked);
        assert_eq!(r.status, Status::Pass);
        assert!(!any_blocked(&runs));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn run_detects_blocking_secret() {
        let tmp = std::env::temp_dir().join(format!("aura-ci-lib2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let ctx = GateContext {
            nodes: vec![CiNode {
                identifier: Some("API_KEY".into()),
                kind: "variable".into(),
                contains_secret: true,
                ..Default::default()
            }],
            ..Default::default()
        };
        let runs = run(&tmp, Trigger::PreCommit, &ctx, &RunOpts::default()).unwrap();
        assert!(any_blocked(&runs), "a flagged secret must block the run");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
