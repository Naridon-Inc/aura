// Aura Taste Engine — observation layer.
//
// Mines micro-patterns from accepted commits and writes them to
// `.aura/taste/observations.jsonl` (append-only). Phase 0 ships this
// observation pipeline only; aggregation + rule synthesis + injection
// land in Phase 1 (aggregate.rs, match.rs, MCP tool, CLAUDE.md block).
//
// Why text-based extractors (not AST) for v1:
//   - Cheap. Has to run on every commit without a noticeable pause.
//   - Language-agnostic baseline. AST parsers are per-language; the
//     v1 templates (indent, exports, imports, error handling) all
//     fall out of regex/line-prefix scans.
//   - Easy to add new templates as plain functions in `extract.rs`.
// Phase 2+ can upgrade specific templates to AST when the signal
// quality demands it.
//
// Idempotency: each observation carries `commit_sha`. Before writing,
// we read the existing log and skip any commit we've already observed.
// The log is append-only — never rewritten — so the seek-and-skip is
// O(N) but N stays small in practice (rules are aggregated and the
// log can be truncated periodically without affecting correctness).

pub mod extract;
pub mod aggregate;
pub mod check;

use git2::{DiffOptions, Repository};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// One observation = "during commit X, file F exhibited template T with
/// signal S." Many observations share a commit_sha (one per template per
/// file). The aggregator reads these to compute rule confidence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Observation {
    pub id: String,
    pub ts: u64,
    pub commit_sha: String,
    pub agent_id: String,
    pub file_path: String,
    pub language: String,
    pub layer: String,
    pub rule_template: String,
    /// Free-form per-template payload — e.g. `{"indent": 2}` for
    /// formatting.indent, `{"style": "named"}` for naming.exports.
    pub detail: serde_json::Value,
    pub signal: String,
    pub weight: f64,
    pub intent_id: Option<String>,
}

/// Signal weights, mirroring the Skill Ledger vocabulary in
/// aura-shell/src-tauri/src/manager/skill.rs:104-135.
#[allow(dead_code)] // exported for the future rewind/thumbs hooks
pub fn signal_weight(signal: &str) -> f64 {
    match signal {
        "commit" => 1.0,
        "pr_review_pass" => 1.5,
        "thumbs_up" => 1.5,
        "thumbs_down" => -2.0,
        "edit_on_top" => -0.5,
        "rewind" => -3.0,
        _ => 1.0,
    }
}

/// Resolve `.aura/taste/observations.jsonl` for a repo.
pub fn observations_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("taste").join("observations.jsonl")
}

/// Read every (commit_sha, signal) pair already in the log. Cheap
/// O(N) scan. Used for idempotency: a commit may legitimately produce
/// observations of multiple signal kinds ("commit" from the
/// post-commit pass, then "edit_on_top" / "rewind" from later events),
/// so we de-dupe on the pair, not the sha alone.
fn already_observed_pairs(log_path: &Path) -> HashSet<(String, String, String)> {
    let mut out = HashSet::new();
    let Ok(file) = fs::File::open(log_path) else {
        return out;
    };
    for line in BufReader::new(file).lines().flatten() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            let sha = v.get("commit_sha").and_then(|s| s.as_str()).unwrap_or("").to_string();
            let signal = v.get("signal").and_then(|s| s.as_str()).unwrap_or("").to_string();
            let file_path = v.get("file_path").and_then(|s| s.as_str()).unwrap_or("").to_string();
            if !sha.is_empty() {
                out.insert((sha, signal, file_path));
            }
        }
    }
    out
}

/// Append `obs` rows to `.aura/taste/observations.jsonl`. Creates the
/// parent directory if missing. Each observation becomes one line.
fn append_observations(log_path: &Path, obs: &[Observation]) -> std::io::Result<()> {
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)?;
    for o in obs {
        let line = serde_json::to_string(o).unwrap_or_default();
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
    }
    file.flush()?;
    Ok(())
}

/// Observe a single commit. Idempotent — if we've already seen this
/// sha, this is a no-op. Returns the number of observations written.
pub fn observe_commit(
    repo: &Repository,
    commit_sha: &str,
    agent_id: &str,
    intent_id: Option<&str>,
) -> Result<usize, Box<dyn std::error::Error>> {
    let repo_root = repo.workdir().ok_or("bare repo")?.to_path_buf();
    let log_path = observations_path(&repo_root);

    // Phase 0 emits one "commit" observation per (template, file) for
    // a sha. If we've already done that pass for this sha we skip —
    // negative-signal observations (edit_on_top, rewind) go through
    // `record_negative_signal` below and are de-duped on the full
    // (sha, signal, file_path) tuple.
    let pairs = already_observed_pairs(&log_path);
    if pairs.iter().any(|(s, sig, _)| s == commit_sha && sig == "commit") {
        return Ok(0);
    }

    let oid = git2::Oid::from_str(commit_sha)?;
    let commit = repo.find_commit(oid)?;
    let new_tree = commit.tree()?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());

    let mut opts = DiffOptions::new();
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&new_tree), Some(&mut opts))?;

    // Pull (path, before_text, after_text) for every changed blob so the
    // extractors see both sides. Skipping binary / unreadable blobs.
    let mut changed: Vec<(PathBuf, String, String)> = Vec::new();
    diff.foreach(
        &mut |delta, _| {
            let new_path = delta.new_file().path().map(|p| p.to_path_buf());
            let old_path = delta.old_file().path().map(|p| p.to_path_buf());
            let path = new_path.clone().or_else(|| old_path.clone());
            if let Some(path) = path {
                let after = new_tree
                    .get_path(&path)
                    .ok()
                    .and_then(|e| e.to_object(repo).ok())
                    .and_then(|o| o.peel_to_blob().ok())
                    .and_then(|b| std::str::from_utf8(b.content()).ok().map(String::from))
                    .unwrap_or_default();
                let before = parent_tree
                    .as_ref()
                    .and_then(|t| t.get_path(&path).ok())
                    .and_then(|e| e.to_object(repo).ok())
                    .and_then(|o| o.peel_to_blob().ok())
                    .and_then(|b| std::str::from_utf8(b.content()).ok().map(String::from))
                    .unwrap_or_default();
                changed.push((path, before, after));
            }
            true
        },
        None,
        None,
        None,
    )?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut out: Vec<Observation> = Vec::new();
    for (path, before, after) in changed {
        let file_str = path.to_string_lossy().to_string();
        let language = extract::detect_language(&file_str);
        let layer = extract::detect_layer(&file_str);
        if language.is_empty() {
            continue; // skip binaries, lockfiles, unknown extensions
        }
        let scope = extract::Scope {
            file_path: file_str.clone(),
            language: language.clone(),
            layer: layer.clone(),
        };
        for hit in extract::run_all(&before, &after, &scope) {
            out.push(Observation {
                id: format!("obs_{}", Uuid::new_v4().simple()),
                ts,
                commit_sha: commit_sha.to_string(),
                agent_id: agent_id.to_string(),
                file_path: file_str.clone(),
                language: language.clone(),
                layer: layer.clone(),
                rule_template: hit.template,
                detail: hit.detail,
                signal: "commit".to_string(),
                weight: signal_weight("commit"),
                intent_id: intent_id.map(String::from),
            });
        }
    }

    if !out.is_empty() {
        append_observations(&log_path, &out)?;
    }
    Ok(out.len())
}

/// Record a negative-signal observation against an existing commit's
/// file. Used by the post-tool-use hook (`edit_on_top` — the agent's
/// version was partially overwritten by a human edit) and the rewind
/// handler (`rewind` — strongest reject).
///
/// We don't re-run the extractors; we just attach the negative weight
/// to every active rule that scopes to the file. The aggregator
/// re-computes confidence on next run and decays the rule.
pub fn record_negative_signal(
    repo_root: &Path,
    commit_sha: &str,
    file_path: &str,
    signal: &str,
    agent_id: &str,
) -> std::io::Result<usize> {
    let log_path = observations_path(repo_root);
    let pairs = already_observed_pairs(&log_path);
    if pairs.contains(&(commit_sha.to_string(), signal.to_string(), file_path.to_string())) {
        return Ok(0);
    }

    let language = extract::detect_language(file_path);
    let layer = extract::detect_layer(file_path);
    if language.is_empty() {
        return Ok(0);
    }

    let active_templates: Vec<String> = aggregate::load_rules(repo_root)
        .rules
        .into_iter()
        .filter(|r| {
            r.language == language
                && (r.layer == layer || r.layer == "core")
                && matches!(
                    r.status,
                    aggregate::RuleStatus::Active | aggregate::RuleStatus::Provisional
                )
        })
        .map(|r| r.template)
        .collect();

    if active_templates.is_empty() {
        return Ok(0);
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let weight = signal_weight(signal);
    let mut out = Vec::with_capacity(active_templates.len());
    for template in active_templates {
        out.push(Observation {
            id: format!("obs_{}", Uuid::new_v4().simple()),
            ts,
            commit_sha: commit_sha.to_string(),
            agent_id: agent_id.to_string(),
            file_path: file_path.to_string(),
            language: language.clone(),
            layer: layer.clone(),
            rule_template: template,
            detail: serde_json::json!({ "signal_only": true }),
            signal: signal.to_string(),
            weight,
            intent_id: None,
        });
    }
    append_observations(&log_path, &out)?;
    Ok(out.len())
}

/// Cheap status counts read straight off the log. Used by `aura taste
/// status`. Returns (total, by_template_count, by_language_count, last_ts).
pub fn status_counts(repo_root: &Path) -> (usize, Vec<(String, usize)>, Vec<(String, usize)>, u64) {
    let log_path = observations_path(repo_root);
    let Ok(file) = fs::File::open(&log_path) else {
        return (0, vec![], vec![], 0);
    };
    let mut total = 0usize;
    let mut by_template: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    let mut by_language: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    let mut last_ts: u64 = 0;
    for line in BufReader::new(file).lines().flatten() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        total += 1;
        if let Some(t) = v.get("rule_template").and_then(|s| s.as_str()) {
            *by_template.entry(t.to_string()).or_insert(0) += 1;
        }
        if let Some(l) = v.get("language").and_then(|s| s.as_str()) {
            *by_language.entry(l.to_string()).or_insert(0) += 1;
        }
        if let Some(ts) = v.get("ts").and_then(|n| n.as_u64()) {
            if ts > last_ts {
                last_ts = ts;
            }
        }
    }
    (
        total,
        by_template.into_iter().collect(),
        by_language.into_iter().collect(),
        last_ts,
    )
}
