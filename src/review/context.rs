//! History- and project-aware review context.
//!
//! A bare diff tells a specialist *what* changed but nothing about *where it
//! lands*: the file's recent churn, the intent behind the last edits, the
//! project's own conventions. A real reviewer carries all of that in their
//! head. This module reconstructs a compact, bounded version of it from data
//! Aura already has — git history + the semantic intent log + the repo's
//! learned taste — and renders it into a single block the panel prompts embed.
//!
//! It is best-effort and read-only: every source that's missing or unreadable
//! simply contributes nothing, never a stub or a guess.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Hard ceiling on the rendered block so a busy repo can't blow the prompt.
const MAX_BLOCK_BYTES: usize = 3600;
/// At most this many touched files get a history entry (most-changed diffs
/// would otherwise dominate the prompt with churn).
const MAX_FILES: usize = 8;
/// Recent commit subjects per file.
const LOG_PER_FILE: usize = 4;
/// Total intent-log lines surfaced across all touched files.
const MAX_INTENTS: usize = 6;
/// Project-taste bullets carried over from CLAUDE.md.
const MAX_TASTE: usize = 10;

/// A pre-rendered context block (empty when nothing was gathered).
#[derive(Debug, Clone, Default)]
pub struct ReviewContext {
    pub block: String,
}

impl ReviewContext {
    pub fn is_empty(&self) -> bool {
        self.block.trim().is_empty()
    }
}

/// Gather project + history context for the files touched by `diff`.
///
/// `diff` is the already-captured unified diff (see `reviewer::capture_diff`);
/// we read the touched-file list straight out of it rather than asking git
/// again. Everything else (git log, intent log, taste) is read fresh.
pub fn gather(diff: &str) -> ReviewContext {
    let files = touched_files(diff);
    if files.is_empty() {
        return ReviewContext::default();
    }
    let repo_root = repo_root();

    let mut sections: Vec<String> = Vec::new();

    if let Some(project) = project_section(repo_root.as_deref(), &files) {
        sections.push(project);
    }
    if let Some(history) = history_section(repo_root.as_deref(), &files) {
        sections.push(history);
    }

    let mut block = sections.join("\n");
    if block.len() > MAX_BLOCK_BYTES {
        block.truncate(MAX_BLOCK_BYTES);
        block.push_str("\n… [context truncated] …");
    }
    ReviewContext { block }
}

/// Parse the new-side path of every file in a unified diff. Handles the
/// `+++ b/<path>` form and the synthetic `# --- uncommitted …` divider that
/// `capture_diff` injects between the committed and working-tree halves.
pub fn touched_files(diff: &str) -> Vec<String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    for line in diff.lines() {
        let Some(rest) = line.strip_prefix("+++ ") else {
            continue;
        };
        let rest = rest.trim();
        if rest == "/dev/null" {
            continue;
        }
        // Strip the conventional `b/` (or `a/`) prefix git emits.
        let path = rest
            .strip_prefix("b/")
            .or_else(|| rest.strip_prefix("a/"))
            .unwrap_or(rest);
        // Drop a trailing tab-quoted timestamp some git configs append.
        let path = path.split('\t').next().unwrap_or(path).trim();
        if !path.is_empty() {
            out.insert(path.to_string());
        }
    }
    out.into_iter().collect()
}

fn repo_root() -> Option<PathBuf> {
    let out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

fn project_section(repo_root: Option<&Path>, files: &[String]) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();

    let name = repo_root
        .and_then(|r| r.file_name())
        .map(|n| n.to_string_lossy().to_string());
    let langs = languages(files);
    let header = match (name, langs.is_empty()) {
        (Some(n), false) => format!("Repo: {n} · Languages in this change: {}", langs.join(", ")),
        (Some(n), true) => format!("Repo: {n}"),
        (None, false) => format!("Languages in this change: {}", langs.join(", ")),
        (None, true) => return taste(repo_root).map(render_project),
    };
    lines.push(header);

    if let Some(taste) = taste(repo_root) {
        lines.push(String::new());
        lines.push(
            "Conventions (learned project taste — a change that violates one is a real finding):"
                .to_string(),
        );
        lines.extend(taste);
    }

    Some(render_project(lines))
}

fn render_project(body: Vec<String>) -> String {
    let mut s = String::from("=== PROJECT CONTEXT ===\n");
    s.push_str(&body.join("\n"));
    s
}

/// Distinct human language names for the touched files, by extension.
fn languages(files: &[String]) -> Vec<String> {
    let mut seen: BTreeSet<&'static str> = BTreeSet::new();
    let mut order: Vec<&'static str> = Vec::new();
    for f in files {
        let ext = Path::new(f)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let lang = match ext {
            "rs" => "Rust",
            "ts" | "tsx" => "TypeScript",
            "js" | "jsx" | "mjs" | "cjs" => "JavaScript",
            "py" => "Python",
            "go" => "Go",
            "rb" => "Ruby",
            "java" => "Java",
            "kt" | "kts" => "Kotlin",
            "swift" => "Swift",
            "c" | "h" => "C",
            "cc" | "cpp" | "cxx" | "hpp" => "C++",
            "cs" => "C#",
            "php" => "PHP",
            "sql" => "SQL",
            "sh" | "bash" | "zsh" => "Shell",
            "toml" | "yaml" | "yml" | "json" => "Config",
            "md" | "mdx" => "Markdown",
            "css" | "scss" => "CSS",
            "html" => "HTML",
            _ => "",
        };
        if !lang.is_empty() && seen.insert(lang) {
            order.push(lang);
        }
    }
    order.into_iter().map(|s| s.to_string()).collect()
}

/// Pull the bullet list under a `## Project Taste` heading in CLAUDE.md, if any.
/// These are the repo's own learned conventions — the highest-signal project
/// context we can hand a reviewer.
fn taste(repo_root: Option<&Path>) -> Option<Vec<String>> {
    let root = repo_root?;
    let body = std::fs::read_to_string(root.join("CLAUDE.md")).ok()?;
    let mut out: Vec<String> = Vec::new();
    let mut in_section = false;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("## ") {
            // Enter on the Taste heading; leave on the next heading.
            in_section = trimmed.to_lowercase().contains("project taste");
            continue;
        }
        if in_section {
            if let Some(item) = trimmed.strip_prefix("- ") {
                let item = item.trim();
                if !item.is_empty() {
                    out.push(format!("- {item}"));
                    if out.len() >= MAX_TASTE {
                        break;
                    }
                }
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn history_section(repo_root: Option<&Path>, files: &[String]) -> Option<String> {
    let mut entries: Vec<String> = Vec::new();
    for file in files.iter().take(MAX_FILES) {
        let subjects = git_log_subjects(file);
        if subjects.is_empty() {
            continue;
        }
        let mut block = format!("{file}:");
        for s in subjects {
            block.push_str(&format!("\n  · {s}"));
        }
        entries.push(block);
    }

    let intents = recent_intents(repo_root, files);

    if entries.is_empty() && intents.is_empty() {
        return None;
    }

    let mut s = String::from(
        "=== RECENT HISTORY (touched files) ===\n\
Use it: a change that contradicts the recent intent for a file, or re-breaks an \
area a recent commit just fixed, is high-signal. Still cite the exact changed line.\n",
    );
    if !entries.is_empty() {
        s.push_str(&entries.join("\n"));
    }
    if !intents.is_empty() {
        if !entries.is_empty() {
            s.push('\n');
        }
        s.push_str("\nRecent intent (Aura semantic log) for touched files:\n");
        s.push_str(&intents.join("\n"));
    }
    Some(s)
}

/// Recent commit subjects that touched `file` (newest first).
fn git_log_subjects(file: &str) -> Vec<String> {
    let out = match Command::new("git")
        .args([
            "log",
            &format!("-n{LOG_PER_FILE}"),
            "--pretty=format:%s",
            "--",
            file,
        ])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| clip(l.trim(), 100))
        .filter(|l| !l.is_empty())
        .collect()
}

/// Scan the tail of `.aura/intent_log.jsonl` for entries whose changeset
/// touched one of `files`, surfacing the stated intent. This is the
/// differentiator: Aura recorded *why* each prior edit was made, so the
/// reviewer can judge a change against the goal of the change before it.
fn recent_intents(repo_root: Option<&Path>, files: &[String]) -> Vec<String> {
    let Some(root) = repo_root else {
        return Vec::new();
    };
    let body = match std::fs::read_to_string(root.join(".aura/intent_log.jsonl")) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    // Match on basenames so absolute paths in the log line up with the diff's
    // repo-relative paths.
    let wanted: BTreeSet<String> = files
        .iter()
        .filter_map(|f| Path::new(f).file_name().map(|n| n.to_string_lossy().to_string()))
        .collect();

    let mut out: Vec<String> = Vec::new();
    // Newest entries are last; walk from the end.
    for line in body.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let paths = val
            .get("changeset")
            .and_then(|c| c.get("files"))
            .and_then(|f| f.as_array());
        let touches = paths.is_some_and(|arr| {
            arr.iter().any(|f| {
                f.get("path")
                    .and_then(|p| p.as_str())
                    .and_then(|p| Path::new(p).file_name())
                    .map(|n| wanted.contains(&n.to_string_lossy().to_string()))
                    .unwrap_or(false)
            })
        });
        if !touches {
            continue;
        }
        if let Some(intent) = val.get("intent").and_then(|i| i.as_str()) {
            let intent = intent.trim();
            if !intent.is_empty() {
                out.push(format!("  · {}", clip(intent, 220)));
                if out.len() >= MAX_INTENTS {
                    break;
                }
            }
        }
    }
    out
}

fn clip(s: &str, max: usize) -> String {
    let s = s.replace(['\n', '\r'], " ");
    if s.chars().count() <= max {
        s
    } else {
        let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
        t.push('…');
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn touched_files_parses_new_side_and_skips_dev_null() {
        let diff = "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@\n+x\n\
diff --git a/old.txt b/old.txt\n--- a/old.txt\n+++ /dev/null\n\
# --- uncommitted working-tree changes ---\n+++ b/src/b.ts\n";
        let files = touched_files(diff);
        assert_eq!(files, vec!["src/a.rs".to_string(), "src/b.ts".to_string()]);
    }

    #[test]
    fn languages_dedup_and_map() {
        let files = vec![
            "src/a.rs".to_string(),
            "src/b.rs".to_string(),
            "ui/c.tsx".to_string(),
            "weird.xyz".to_string(),
        ];
        let langs = languages(&files);
        assert!(langs.contains(&"Rust".to_string()));
        assert!(langs.contains(&"TypeScript".to_string()));
        assert_eq!(langs.iter().filter(|l| *l == "Rust").count(), 1);
        assert!(!langs.contains(&"".to_string()));
    }

    #[test]
    fn empty_diff_yields_empty_context() {
        let ctx = gather("");
        assert!(ctx.is_empty());
    }

    #[test]
    fn clip_caps_length() {
        let long = "a".repeat(500);
        let c = clip(&long, 50);
        assert!(c.chars().count() <= 50);
        assert!(c.ends_with('…'));
    }
}
