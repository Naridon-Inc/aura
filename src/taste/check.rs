// Taste violation detector — Phase 2.
//
// Given a (before, after) diff per file, run the same template
// extractors used by `observe_commit` and cross-reference the hits
// against the active rule set. Emit one Violation per (file, rule)
// pair where the new lines disagree with the established rule.
//
// "Disagrees" is template-specific:
//   formatting.indent       — added lines use a different dominant
//                             leading-whitespace than the rule's.
//   naming.exports          — at least one new `export default` when
//                             the rule says "named dominates" (and
//                             vice-versa).
//   imports.style           — at least one new namespace import when
//                             the rule prefers named (and vice-versa).
//   error_handling.with_context
//                           — at least one new bare `?` when the
//                             rule says "wrap with .context()" (and
//                             vice-versa).
//
// Violations carry the rule_id + a short fragment so the PR reviewer
// and the pre-commit hook can produce actionable output.

use git2::{DiffOptions, Repository};
use serde::Serialize;
use std::path::PathBuf;

use super::aggregate::{load_rules, Rule, RuleStatus};
use super::extract;

#[derive(Debug, Serialize, Clone)]
pub struct Violation {
    pub rule_id: String,
    pub template: String,
    pub language: String,
    pub layer: String,
    pub file_path: String,
    pub rule_statement: String,
    /// Short reason, e.g. "added 12 four-space lines into a 2-space project".
    pub reason: String,
    /// Mirror of rule.confidence — callers gate on this to decide
    /// whether to block vs. warn.
    pub confidence: f64,
}

#[derive(Debug, Default, Serialize)]
pub struct CheckReport {
    pub violations: Vec<Violation>,
    /// (file, rule_id) pairs that matched — useful for the "taste
    /// match score" chip in the UI without a separate run.
    pub conformances: Vec<(String, String)>,
    pub files_scanned: usize,
}

/// Walk a commit's diff and report taste violations. Mirrors the
/// blob-pulling loop in `observe_commit` so the extractor inputs
/// are identical (no observation/checker drift).
pub fn check_commit(
    repo: &Repository,
    commit_sha: &str,
    threshold: f64,
) -> Result<CheckReport, Box<dyn std::error::Error>> {
    let oid = git2::Oid::from_str(commit_sha)?;
    let commit = repo.find_commit(oid)?;
    let new_tree = commit.tree()?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    check_tree_diff(repo, parent_tree.as_ref(), &new_tree, threshold)
}

/// Convenience: run the taste check against the staged index. Used
/// by the pre-commit hook when `taste_strict` is on. Diffs HEAD's
/// tree against a tree written from the current index — the same
/// content git is about to commit.
pub fn check_staged(
    repo: &Repository,
    threshold: f64,
) -> Result<CheckReport, Box<dyn std::error::Error>> {
    let mut index = repo.index()?;
    let index_oid = index.write_tree()?;
    let index_tree = repo.find_tree(index_oid)?;
    let head_tree = repo.head().and_then(|r| r.peel_to_tree()).ok();
    check_tree_diff(repo, head_tree.as_ref(), &index_tree, threshold)
}

/// Same checker driven by two arbitrary trees. Used by `aura pr-review`
/// to scan the cumulative base..head delta, not one commit at a time.
pub fn check_tree_diff(
    repo: &Repository,
    base_tree: Option<&git2::Tree<'_>>,
    head_tree: &git2::Tree<'_>,
    threshold: f64,
) -> Result<CheckReport, Box<dyn std::error::Error>> {
    let repo_root = repo.workdir().ok_or("bare repo")?.to_path_buf();
    let rules = load_rules(&repo_root).rules;
    let active: Vec<Rule> = rules
        .into_iter()
        .filter(|r| matches!(r.status, RuleStatus::Active | RuleStatus::Provisional))
        .filter(|r| r.confidence >= threshold)
        .collect();
    if active.is_empty() {
        return Ok(CheckReport::default());
    }

    let mut opts = DiffOptions::new();
    let diff = repo.diff_tree_to_tree(base_tree, Some(head_tree), Some(&mut opts))?;

    let mut changed: Vec<(PathBuf, String, String)> = Vec::new();
    diff.foreach(
        &mut |delta, _| {
            let new_path = delta.new_file().path().map(|p| p.to_path_buf());
            let old_path = delta.old_file().path().map(|p| p.to_path_buf());
            let path = new_path.clone().or_else(|| old_path.clone());
            if let Some(path) = path {
                let after = head_tree
                    .get_path(&path)
                    .ok()
                    .and_then(|e| e.to_object(repo).ok())
                    .and_then(|o| o.peel_to_blob().ok())
                    .and_then(|b| std::str::from_utf8(b.content()).ok().map(String::from))
                    .unwrap_or_default();
                let before = base_tree
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

    let mut report = CheckReport::default();
    for (path, before, after) in changed {
        let file_str = path.to_string_lossy().to_string();
        let language = extract::detect_language(&file_str);
        let layer = extract::detect_layer(&file_str);
        if language.is_empty() {
            continue;
        }
        report.files_scanned += 1;
        let scope = extract::Scope {
            file_path: file_str.clone(),
            language: language.clone(),
            layer: layer.clone(),
        };
        let hits = extract::run_all(&before, &after, &scope);
        for hit in &hits {
            // Scope precedence: prefer a rule whose layer matches this
            // file's layer exactly; fall back to the broader `core`
            // rule only if no specific one exists. Otherwise a `core`
            // rule wins via insertion order and a more-specific rule
            // never fires.
            let rule = active
                .iter()
                .find(|r| r.template == hit.template && r.language == language && r.layer == layer)
                .or_else(|| {
                    active
                        .iter()
                        .find(|r| r.template == hit.template && r.language == language && r.layer == "core")
                });
            let Some(rule) = rule else { continue };
            match evaluate(&hit.template, &rule.summary, &hit.detail) {
                Verdict::Conform => {
                    report.conformances.push((file_str.clone(), rule.id.clone()));
                }
                Verdict::Violate(reason) => {
                    report.violations.push(Violation {
                        rule_id: rule.id.clone(),
                        template: hit.template.clone(),
                        language: language.clone(),
                        layer: layer.clone(),
                        file_path: file_str.clone(),
                        rule_statement: rule.statement.clone(),
                        reason,
                        confidence: rule.confidence,
                    });
                }
                Verdict::Skip => {}
            }
        }
    }
    Ok(report)
}

enum Verdict {
    Conform,
    Violate(String),
    Skip,
}

/// Compare an extractor hit against the rule's aggregated summary.
/// Each template has its own definition of "conforms" — encoded here
/// rather than as a generic comparator because the shapes differ.
fn evaluate(template: &str, rule_summary: &serde_json::Value, hit_detail: &serde_json::Value) -> Verdict {
    match template {
        "formatting.indent" => {
            let rule_dom = rule_summary.get("dominant").and_then(|v| v.as_str()).unwrap_or("");
            let hit_dom = hit_detail.get("dominant").and_then(|v| v.as_str()).unwrap_or("");
            if rule_dom.is_empty() || hit_dom.is_empty() || rule_dom == hit_dom {
                Verdict::Conform
            } else {
                Verdict::Violate(format!(
                    "added lines use {}-indent, project prefers {}",
                    pretty_indent(hit_dom),
                    pretty_indent(rule_dom),
                ))
            }
        }
        "naming.exports" => {
            let rule_ratio = rule_summary.get("ratio").and_then(|v| v.as_f64()).unwrap_or(0.5);
            let hit_named = hit_detail.get("named").and_then(|v| v.as_u64()).unwrap_or(0);
            let hit_default = hit_detail.get("default").and_then(|v| v.as_u64()).unwrap_or(0);
            if hit_named == 0 && hit_default == 0 {
                return Verdict::Skip;
            }
            // Project prefers named (ratio ≥ 0.7) but new diff added a default.
            if rule_ratio >= 0.7 && hit_default > 0 && hit_named == 0 {
                Verdict::Violate(format!("added {} default export(s); project prefers named", hit_default))
            } else if rule_ratio <= 0.3 && hit_named > 0 && hit_default == 0 {
                Verdict::Violate(format!("added {} named export(s); project prefers default", hit_named))
            } else {
                Verdict::Conform
            }
        }
        "imports.style" => {
            let rule_named = rule_summary.get("named").and_then(|v| v.as_u64()).unwrap_or(0);
            let rule_namespace = rule_summary.get("namespace").and_then(|v| v.as_u64()).unwrap_or(0);
            let rule_default = rule_summary.get("default").and_then(|v| v.as_u64()).unwrap_or(0);
            let preferred = if rule_named >= rule_namespace && rule_named >= rule_default {
                "named"
            } else if rule_namespace >= rule_default {
                "namespace"
            } else {
                "default"
            };
            let hit_named = hit_detail.get("named").and_then(|v| v.as_u64()).unwrap_or(0);
            let hit_namespace = hit_detail.get("namespace").and_then(|v| v.as_u64()).unwrap_or(0);
            let hit_default = hit_detail.get("default").and_then(|v| v.as_u64()).unwrap_or(0);
            if hit_named + hit_namespace + hit_default == 0 {
                return Verdict::Skip;
            }
            let off_style = match preferred {
                "named" if hit_namespace > 0 && hit_named == 0 => Some(format!("{} namespace import(s)", hit_namespace)),
                "named" if hit_default > 0 && hit_named == 0 => Some(format!("{} default import(s)", hit_default)),
                "namespace" if hit_named > 0 && hit_namespace == 0 => Some(format!("{} named import(s)", hit_named)),
                _ => None,
            };
            if let Some(off) = off_style {
                Verdict::Violate(format!("added {} ; project prefers `{}` imports", off, preferred))
            } else {
                Verdict::Conform
            }
        }
        "error_handling.with_context" => {
            let rule_ratio = rule_summary.get("ratio").and_then(|v| v.as_f64()).unwrap_or(0.5);
            let hit_bare = hit_detail.get("bare").and_then(|v| v.as_u64()).unwrap_or(0);
            let hit_ctx = hit_detail.get("with_context").and_then(|v| v.as_u64()).unwrap_or(0);
            if hit_bare + hit_ctx == 0 {
                return Verdict::Skip;
            }
            if rule_ratio >= 0.7 && hit_bare > 0 && hit_ctx == 0 {
                Verdict::Violate(format!(
                    "added {} bare `?`; project wraps errors with `.context()`",
                    hit_bare,
                ))
            } else if rule_ratio <= 0.3 && hit_ctx > 0 && hit_bare == 0 {
                Verdict::Violate(format!(
                    "added {} `.context()` wraps; project's style is bare `?`",
                    hit_ctx,
                ))
            } else {
                Verdict::Conform
            }
        }
        _ => Verdict::Skip,
    }
}

fn pretty_indent(s: &str) -> String {
    match s {
        "tab" => "tab".into(),
        "2" => "2-space".into(),
        "4" => "4-space".into(),
        other => other.into(),
    }
}
