//! Pipeline parsing — load `.aura/pipelines/*.toml` into [`Pipeline`]s, or fall
//! back to the built-in default when no TOML is present.
//!
//! ## The `.aura/pipelines/*.toml` schema
//!
//! ```toml
//! name = "default"
//! # which triggers the pipeline as a whole responds to
//! on = ["pre-commit", "pre-push"]
//!
//! [[step]]
//! name = "No leaked secrets"     # plain-language label for the Checks surface
//! gate = "no-secrets"            # a semantic verb Aura owns …
//! # blocking = true             # (optional) override the gate's default
//! # on = ["pre-commit"]         # (optional) narrow this step's triggers
//!
//! [[step]]
//! name = "Tests"
//! run = "cargo test --quiet"     # … OR an ordinary shell command
//! on = ["pre-push"]
//! budget_secs = 300
//! ```
//!
//! Each `[[step]]` has a `name`, exactly one of `gate = "<id>"` or
//! `run = "<shell>"`, and optional `on` / `blocking` / `budget_secs` /
//! `threshold`. A step omitting `blocking` inherits the gate's default posture
//! (secrets + stubs + build block; alignment + taste advise). A `run` step
//! omitting `blocking` defaults to blocking — an explicit command you declared
//! is expected to pass.
//!
//! The pipeline TOML is the SINGLE source of truth: the same file drives the
//! local git hooks AND the exported GitHub Action.

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::gates;
use crate::model::{Pipeline, Step, StepKind, Trigger};

/// Wire-format of one `[[step]]` table. Mirrors the schema above; we validate
/// the gate-xor-run invariant after deserializing.
#[derive(Debug, Deserialize)]
struct RawStep {
    name: Option<String>,
    gate: Option<String>,
    run: Option<String>,
    #[serde(default)]
    on: Vec<String>,
    blocking: Option<bool>,
    budget_secs: Option<u64>,
    threshold: Option<f64>,
}

/// Wire-format of a whole pipeline file.
#[derive(Debug, Deserialize)]
struct RawPipeline {
    name: Option<String>,
    #[serde(default)]
    on: Vec<String>,
    #[serde(default)]
    step: Vec<RawStep>,
}

/// Load every `.aura/pipelines/*.toml` under `root`. When the directory is
/// absent or empty, returns the single built-in [`default_pipeline`] so
/// `aura enable` gives sensible gates with zero config.
pub fn load(root: &Path) -> Result<Vec<Pipeline>> {
    let dir = root.join(".aura").join("pipelines");
    if !dir.is_dir() {
        return Ok(vec![default_pipeline()]);
    }

    let mut files: Vec<_> = fs::read_dir(&dir)
        .with_context(|| format!("reading {}", dir.display()))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "toml").unwrap_or(false))
        .collect();
    files.sort();

    let mut pipelines = Vec::new();
    for path in files {
        let body = fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let pipeline = parse_str(&body)
            .with_context(|| format!("parsing {}", path.display()))?;
        pipelines.push(pipeline);
    }

    if pipelines.is_empty() {
        return Ok(vec![default_pipeline()]);
    }
    Ok(pipelines)
}

/// Parse one pipeline TOML body into a [`Pipeline`], validating each step.
pub fn parse_str(body: &str) -> Result<Pipeline> {
    let raw: RawPipeline = toml::from_str(body).context("invalid pipeline TOML")?;

    let triggers = parse_triggers(&raw.on)?;
    let mut steps = Vec::with_capacity(raw.step.len());
    for (i, rs) in raw.step.into_iter().enumerate() {
        steps.push(build_step(i, rs)?);
    }

    Ok(Pipeline {
        name: raw.name.unwrap_or_else(|| "pipeline".to_string()),
        triggers,
        steps,
    })
}

fn build_step(index: usize, rs: RawStep) -> Result<Step> {
    let kind = match (rs.gate, rs.run) {
        (Some(_), Some(_)) => anyhow::bail!(
            "step {} declares both `gate` and `run` — pick exactly one",
            index + 1
        ),
        (None, None) => anyhow::bail!(
            "step {} declares neither `gate` nor `run` — pick exactly one",
            index + 1
        ),
        (Some(g), None) => StepKind::Gate(g),
        (None, Some(r)) => StepKind::Run(r),
    };

    // Default blocking posture: a gate inherits the gate impl's default; a
    // `run` step you explicitly declared is expected to pass → blocking.
    let blocking = rs.blocking.unwrap_or_else(|| match &kind {
        StepKind::Gate(id) => gates::resolve(id)
            .map(|g| g.default_blocking())
            .unwrap_or(false),
        StepKind::Run(_) => true,
    });

    // Default name: the supplied label, else a humanized fallback.
    let name = rs.name.unwrap_or_else(|| default_name(&kind));

    Ok(Step {
        name,
        kind,
        on: parse_triggers(&rs.on)?,
        blocking,
        budget_secs: rs.budget_secs,
        threshold: rs.threshold,
    })
}

fn default_name(kind: &StepKind) -> String {
    match kind {
        // Single source of truth: each gate impl owns its plain-language label.
        StepKind::Gate(id) => gates::resolve(id)
            .map(|g| g.default_name().to_string())
            .unwrap_or_else(|| id.clone()),
        StepKind::Run(cmd) => cmd.clone(),
    }
}

/// The default step label for a gate id, via the gate impl. Unknown ids fall
/// back to the raw id (the executor will Skip them with a clear note).
fn gates_default_name(id: &str) -> String {
    gates::resolve(id)
        .map(|g| g.default_name().to_string())
        .unwrap_or_else(|| id.to_string())
}

fn parse_triggers(tokens: &[String]) -> Result<Vec<Trigger>> {
    let mut out = Vec::with_capacity(tokens.len());
    for t in tokens {
        let trigger = Trigger::parse(t)
            .with_context(|| format!("unknown trigger `{}` (use pre-commit/pre-push/pr/manual)", t))?;
        out.push(trigger);
    }
    Ok(out)
}

/// The built-in default pipeline used when no `.aura/pipelines/*.toml` exists.
///
/// `no-secrets` (blocking, always) + `no-stubs` (blocking, pre-commit) +
/// `goal-aligned` (advisory) + `build` (pre-push). This is the sensible
/// zero-config gate set `aura enable` gives you; any TOML overrides it.
pub fn default_pipeline() -> Pipeline {
    Pipeline {
        name: "default".to_string(),
        triggers: vec![Trigger::PreCommit, Trigger::PrePush, Trigger::Pr],
        steps: vec![
            Step {
                name: gates_default_name("no-secrets"),
                kind: StepKind::Gate("no-secrets".into()),
                on: vec![], // every trigger
                blocking: true,
                budget_secs: None,
                threshold: None,
            },
            Step {
                name: gates_default_name("no-stubs"),
                kind: StepKind::Gate("no-stubs".into()),
                on: vec![Trigger::PreCommit, Trigger::Pr],
                blocking: true,
                budget_secs: None,
                threshold: None,
            },
            Step {
                name: gates_default_name("goal-aligned"),
                kind: StepKind::Gate("goal-aligned".into()),
                on: vec![], // every trigger
                blocking: false,
                budget_secs: None,
                threshold: None,
            },
            Step {
                name: gates_default_name("build"),
                kind: StepKind::Gate("build".into()),
                on: vec![Trigger::PrePush, Trigger::Pr],
                blocking: true,
                budget_secs: Some(90),
                threshold: None,
            },
        ],
    }
}

/// Serialize a pipeline back to canonical TOML (used by `aura ci` to scaffold a
/// starter `.aura/pipelines/default.toml` the team can edit).
pub fn to_toml(pipeline: &Pipeline) -> String {
    let mut out = String::new();
    out.push_str(&format!("name = \"{}\"\n", pipeline.name));
    let trig: Vec<String> = pipeline
        .triggers
        .iter()
        .map(|t| format!("\"{}\"", t.as_str()))
        .collect();
    out.push_str(&format!("on = [{}]\n", trig.join(", ")));
    for step in &pipeline.steps {
        out.push_str("\n[[step]]\n");
        out.push_str(&format!("name = \"{}\"\n", step.name));
        match &step.kind {
            StepKind::Gate(id) => out.push_str(&format!("gate = \"{}\"\n", id)),
            StepKind::Run(cmd) => out.push_str(&format!("run = \"{}\"\n", cmd.replace('"', "\\\""))),
        }
        if !step.on.is_empty() {
            let on: Vec<String> = step.on.iter().map(|t| format!("\"{}\"", t.as_str())).collect();
            out.push_str(&format!("on = [{}]\n", on.join(", ")));
        }
        out.push_str(&format!("blocking = {}\n", step.blocking));
        if let Some(b) = step.budget_secs {
            out.push_str(&format!("budget_secs = {}\n", b));
        }
        if let Some(t) = step.threshold {
            out.push_str(&format!("threshold = {}\n", t));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_round_trip() {
        let body = r#"
name = "ci"
on = ["pre-commit", "pre-push"]

[[step]]
name = "No leaked secrets"
gate = "no-secrets"

[[step]]
name = "Tests"
run = "cargo test --quiet"
on = ["pre-push"]
budget_secs = 300
blocking = true
"#;
        let p = parse_str(body).unwrap();
        assert_eq!(p.name, "ci");
        assert_eq!(p.triggers, vec![Trigger::PreCommit, Trigger::PrePush]);
        assert_eq!(p.steps.len(), 2);

        // gate step inherits the no-secrets default (blocking).
        assert_eq!(p.steps[0].gate_id(), Some("no-secrets"));
        assert!(p.steps[0].blocking);
        assert!(p.steps[0].on.is_empty()); // inherits pipeline triggers

        // run step
        assert_eq!(p.steps[1].gate_id(), None);
        assert_eq!(p.steps[1].on, vec![Trigger::PrePush]);
        assert_eq!(p.steps[1].budget_secs, Some(300));

        // Re-emit + re-parse must be stable.
        let toml2 = to_toml(&p);
        let p2 = parse_str(&toml2).unwrap();
        assert_eq!(p2.name, p.name);
        assert_eq!(p2.triggers, p.triggers);
        assert_eq!(p2.steps.len(), p.steps.len());
        assert_eq!(p2.steps[1].kind, p.steps[1].kind);
    }

    #[test]
    fn gate_xor_run_enforced() {
        let both = r#"
name = "x"
[[step]]
gate = "no-stubs"
run = "echo hi"
"#;
        assert!(parse_str(both).is_err());

        let neither = r#"
name = "x"
[[step]]
name = "empty"
"#;
        assert!(parse_str(neither).is_err());
    }

    #[test]
    fn builtin_default_shape() {
        let p = default_pipeline();
        assert_eq!(p.name, "default");
        // no-secrets blocking on every trigger
        let secrets = p.steps.iter().find(|s| s.gate_id() == Some("no-secrets")).unwrap();
        assert!(secrets.blocking);
        assert!(secrets.on.is_empty());
        // no-stubs blocking on pre-commit
        let stubs = p.steps.iter().find(|s| s.gate_id() == Some("no-stubs")).unwrap();
        assert!(stubs.blocking);
        assert!(stubs.on.contains(&Trigger::PreCommit));
        // goal-aligned advisory
        let goal = p.steps.iter().find(|s| s.gate_id() == Some("goal-aligned")).unwrap();
        assert!(!goal.blocking);
        // build pre-push
        let build = p.steps.iter().find(|s| s.gate_id() == Some("build")).unwrap();
        assert!(build.blocking);
        assert!(build.on.contains(&Trigger::PrePush));
        assert!(!build.on.contains(&Trigger::PreCommit));
    }

    #[test]
    fn load_missing_dir_returns_default() {
        let tmp = std::env::temp_dir().join(format!("aura-ci-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let pipelines = load(&tmp).unwrap();
        assert_eq!(pipelines.len(), 1);
        assert_eq!(pipelines[0].name, "default");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
