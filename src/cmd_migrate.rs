//! `aura migrate` — the cross-IDE migration engine.
//!
//! Teams arrive at Aura with agent instructions scattered across per-IDE
//! files: `.cursorrules`, `.cursor/rules/*.mdc`, `.windsurfrules`,
//! `.clinerules`, `.github/copilot-instructions.md`, `GEMINI.md`. Each of
//! those is read by exactly one tool; every other agent on the team is blind
//! to it. `AGENTS.md` is the shared home every CLI-first agent reads (and the
//! file Aura's own integrations manage), so migration means: gather what the
//! per-IDE files say and publish it there — visibly, reversibly, and without
//! ever touching the originals.
//!
//! Design rules:
//! 1. **Report first.** `aura migrate` alone is read-only: it says what was
//!    found and what would change. Only `--apply` writes.
//! 2. **One managed block.** Everything imported lives between
//!    `<!-- AURA_MIGRATE_BEGIN -->` / `<!-- AURA_MIGRATE_END -->` in
//!    AGENTS.md. Content outside the block is never rewritten. Deleting the
//!    block is a complete opt-out.
//! 3. **Idempotent.** Each imported source is stamped with a content hash;
//!    re-running against unchanged sources writes nothing.
//! 4. **Originals stay.** The per-IDE files keep working for their own tools;
//!    Aura only mirrors them. Before the first write, the existing AGENTS.md
//!    is backed up under `.aura/migrate-backup/`.
//!
//! `CLAUDE.md` is deliberately not imported: it is a live instruction file
//! Claude Code already reads natively, and mirroring it wholesale would
//! duplicate instructions inside the same agent's context. The report names
//! it so the choice is visible, not silent.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

const BLOCK_START: &str = "<!-- AURA_MIGRATE_BEGIN -->";
const BLOCK_END: &str = "<!-- AURA_MIGRATE_END -->";
const BACKUP_DIR: &str = ".aura/migrate-backup";

/// The per-IDE single-file sources we know how to read. `.cursor/rules/` is
/// handled separately because it is a directory of rule files.
const SINGLE_SOURCES: &[(&str, &str)] = &[
    (".cursorrules", "Cursor"),
    (".windsurfrules", "Windsurf"),
    (".clinerules", "Cline"),
    (".github/copilot-instructions.md", "GitHub Copilot"),
    ("GEMINI.md", "Gemini CLI"),
];

/// One instruction source found in the repo, already converted to the body
/// we would publish.
#[derive(Debug, Clone)]
pub struct Discovered {
    /// Repo-relative path, forward slashes.
    pub path: String,
    /// Which tool reads this file today.
    pub tool: String,
    /// sha256 hex of `body` — the idempotency stamp.
    pub hash: String,
    /// The converted instruction text (frontmatter stripped).
    pub body: String,
    /// Anything worth keeping from frontmatter (description, globs).
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Add,
    Update,
    Unchanged,
}

impl Verdict {
    fn word(self) -> &'static str {
        match self {
            Verdict::Add => "new",
            Verdict::Update => "changed",
            Verdict::Unchanged => "unchanged",
        }
    }
}

#[derive(Debug)]
pub struct Report {
    pub sources: Vec<(Discovered, Verdict)>,
    pub applied: bool,
    pub wrote_agents_md: bool,
    pub backup: Option<String>,
    pub claude_md_present: bool,
}

/// Walk up from `start` to the enclosing git checkout (`.git` may be a
/// directory or, in a worktree, a file). Falls back to `start` so the command
/// still behaves sensibly outside a repository.
fn find_repo_root(start: &Path) -> PathBuf {
    let mut cur = start.to_path_buf();
    loop {
        if cur.join(".git").exists() {
            return cur;
        }
        match cur.parent() {
            Some(p) => cur = p.to_path_buf(),
            None => return start.to_path_buf(),
        }
    }
}

fn sha256_hex(text: &str) -> String {
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    hex::encode(h.finalize())
}

/// Split a leading `---` YAML frontmatter fence off a rule file. Returns
/// (note, body): the note keeps `description:` and `globs:` lines — the two
/// fields Cursor rules actually use to scope themselves — so that scoping
/// survives the move in human-readable form.
fn strip_frontmatter(text: &str) -> (Option<String>, String) {
    let rest = match text.strip_prefix("---\n") {
        Some(r) => r,
        None => return (None, text.to_string()),
    };
    let Some(end) = rest.find("\n---\n") else {
        return (None, text.to_string());
    };
    let (front, body) = rest.split_at(end);
    let body = body["\n---\n".len()..].to_string();
    let mut kept: Vec<String> = Vec::new();
    for line in front.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("description:") || trimmed.starts_with("globs:") {
            kept.push(trimmed.to_string());
        }
    }
    let note = if kept.is_empty() { None } else { Some(kept.join("; ")) };
    (note, body)
}

fn read_source(repo_root: &Path, rel: &str, tool: &str) -> Option<Discovered> {
    let raw = fs::read_to_string(repo_root.join(rel)).ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    let (note, body) = strip_frontmatter(&raw);
    let body = body.trim().to_string();
    if body.is_empty() {
        return None;
    }
    Some(Discovered {
        path: rel.to_string(),
        tool: tool.to_string(),
        hash: sha256_hex(&body),
        body,
        note,
    })
}

/// Find every instruction source in the checkout, deterministically ordered
/// by path so the rendered block (and its diff) is stable.
pub fn discover(repo_root: &Path) -> Vec<Discovered> {
    let mut out: Vec<Discovered> = Vec::new();
    for (rel, tool) in SINGLE_SOURCES {
        if let Some(d) = read_source(repo_root, rel, tool) {
            out.push(d);
        }
    }
    let rules_dir = repo_root.join(".cursor/rules");
    if let Ok(entries) = fs::read_dir(&rules_dir) {
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.ends_with(".mdc") || n.ends_with(".md"))
            .collect();
        names.sort();
        for name in names {
            let rel = format!(".cursor/rules/{name}");
            if let Some(d) = read_source(repo_root, &rel, "Cursor") {
                out.push(d);
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Parse the hashes recorded in an existing managed block:
/// `<!-- aura-migrate source="PATH" hash="sha256:HEX" ... -->` lines.
fn recorded_hashes(agents_md: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let block = match extract_block(agents_md) {
        Some((_, inner, _)) => inner,
        None => return map,
    };
    for line in block.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("<!-- aura-migrate source=\"") else {
            continue;
        };
        let Some((path, rest)) = rest.split_once('"') else { continue };
        let Some(idx) = rest.find("hash=\"sha256:") else { continue };
        let tail = &rest[idx + "hash=\"sha256:".len()..];
        let Some((hash, _)) = tail.split_once('"') else { continue };
        map.insert(path.to_string(), hash.to_string());
    }
    map
}

/// Split a document into (before, inside, after) around the managed block.
fn extract_block(text: &str) -> Option<(&str, &str, &str)> {
    let start = text.find(BLOCK_START)?;
    let end_at = text[start..].find(BLOCK_END)? + start;
    let inner = &text[start + BLOCK_START.len()..end_at];
    Some((&text[..start], inner, &text[end_at + BLOCK_END.len()..]))
}

/// Render the full managed block from scratch. Always regenerated whole so
/// ordering and formatting stay canonical regardless of edit history.
fn render_block(sources: &[Discovered]) -> String {
    let mut s = String::new();
    s.push_str(BLOCK_START);
    s.push_str("\n## Imported agent instructions\n\n");
    s.push_str(
        "Managed by `aura migrate` — mirrored here from per-IDE files so every \
         agent sees them. Edit the source files and re-run `aura migrate --apply`; \
         delete this block to opt out. The source files themselves are untouched.\n",
    );
    for d in sources {
        s.push_str(&format!(
            "\n<!-- aura-migrate source=\"{}\" hash=\"sha256:{}\" tool=\"{}\" -->\n",
            d.path, d.hash, d.tool
        ));
        s.push_str(&format!("### From `{}` ({})\n", d.path, d.tool));
        if let Some(note) = &d.note {
            s.push_str(&format!("_{note}_\n"));
        }
        s.push('\n');
        s.push_str(&d.body);
        s.push('\n');
    }
    s.push_str(BLOCK_END);
    s
}

fn upsert_block(existing: Option<&str>, block: &str) -> String {
    match existing {
        Some(text) => match extract_block(text) {
            Some((before, _, after)) => format!("{before}{block}{after}"),
            None => {
                let mut out = text.trim_end().to_string();
                if !out.is_empty() {
                    out.push_str("\n\n");
                }
                out.push_str(block);
                out.push('\n');
                out
            }
        },
        None => format!("# Agent instructions\n\n{block}\n"),
    }
}

/// Compute what a run would do (and, with `apply`, do it).
pub fn run_in(repo_root: &Path, apply: bool) -> Result<Report, String> {
    let sources = discover(repo_root);
    let agents_path = repo_root.join("AGENTS.md");
    let existing = fs::read_to_string(&agents_path).ok();
    let recorded = existing.as_deref().map(recorded_hashes).unwrap_or_default();

    let judged: Vec<(Discovered, Verdict)> = sources
        .into_iter()
        .map(|d| {
            let v = match recorded.get(&d.path) {
                None => Verdict::Add,
                Some(h) if *h == d.hash => Verdict::Unchanged,
                Some(_) => Verdict::Update,
            };
            (d, v)
        })
        .collect();

    let block_exists = existing
        .as_deref()
        .map(|t| extract_block(t).is_some())
        .unwrap_or(false);
    // Stale entries (source deleted since last run) also require a rewrite.
    let stale = recorded
        .keys()
        .any(|p| !judged.iter().any(|(d, _)| &d.path == p));
    let needs_write = !judged.is_empty()
        && (!block_exists || stale || judged.iter().any(|(_, v)| *v != Verdict::Unchanged));

    let mut report = Report {
        sources: judged,
        applied: apply,
        wrote_agents_md: false,
        backup: None,
        claude_md_present: repo_root.join("CLAUDE.md").is_file(),
    };

    if !apply || !needs_write {
        return Ok(report);
    }

    if let Some(old) = &existing {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let dir = repo_root.join(BACKUP_DIR);
        fs::create_dir_all(&dir).map_err(|e| format!("backup dir: {e}"))?;
        let backup = dir.join(format!("AGENTS.md.{ts}"));
        fs::write(&backup, old).map_err(|e| format!("backup write: {e}"))?;
        report.backup = Some(format!("{BACKUP_DIR}/AGENTS.md.{ts}"));
    }

    let only_sources: Vec<Discovered> =
        report.sources.iter().map(|(d, _)| d.clone()).collect();
    let block = render_block(&only_sources);
    let next = upsert_block(existing.as_deref(), &block);
    fs::write(&agents_path, next).map_err(|e| format!("AGENTS.md write: {e}"))?;
    report.wrote_agents_md = true;
    Ok(report)
}

fn render_human(report: &Report) -> String {
    let mut out = String::new();
    if report.sources.is_empty() {
        out.push_str(
            "Nothing to migrate — no per-IDE instruction files found \
             (.cursorrules, .cursor/rules/, .windsurfrules, .clinerules, \
             .github/copilot-instructions.md, GEMINI.md).\n",
        );
        return out;
    }
    out.push_str("Found instruction files other agents can't see:\n");
    for (d, v) in &report.sources {
        out.push_str(&format!("  {} ({}) — {}\n", d.path, d.tool, v.word()));
    }
    if report.claude_md_present {
        out.push_str(
            "  CLAUDE.md — left in place (Claude Code reads it natively; not mirrored)\n",
        );
    }
    if !report.applied {
        let pending = report
            .sources
            .iter()
            .filter(|(_, v)| *v != Verdict::Unchanged)
            .count();
        if pending == 0 {
            out.push_str("\nAGENTS.md is already up to date. Nothing to do.\n");
        } else {
            out.push_str(&format!(
                "\nRun `aura migrate --apply` to mirror {pending} file(s) into AGENTS.md. \
                 Source files stay untouched.\n"
            ));
        }
    } else if report.wrote_agents_md {
        if let Some(b) = &report.backup {
            out.push_str(&format!("\nBacked up the previous AGENTS.md to {b}\n"));
        }
        out.push_str("Updated AGENTS.md — every agent now sees these instructions.\n");
    } else {
        out.push_str("\nAGENTS.md is already up to date. Nothing written.\n");
    }
    out
}

fn render_json(report: &Report) -> String {
    let sources: Vec<serde_json::Value> = report
        .sources
        .iter()
        .map(|(d, v)| {
            serde_json::json!({
                "path": d.path,
                "tool": d.tool,
                "hash": format!("sha256:{}", d.hash),
                "verdict": v.word(),
                "note": d.note,
            })
        })
        .collect();
    serde_json::json!({
        "sources": sources,
        "applied": report.applied,
        "wrote_agents_md": report.wrote_agents_md,
        "backup": report.backup,
        "claude_md_left_in_place": report.claude_md_present,
    })
    .to_string()
}

/// CLI entry: report by default, write with `--apply`.
pub fn run(apply: bool, json: bool) -> i32 {
    let cwd = match std::env::current_dir() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("aura migrate: cannot resolve working directory: {e}");
            return 1;
        }
    };
    let root = find_repo_root(&cwd);
    match run_in(&root, apply) {
        Ok(report) => {
            if json {
                println!("{}", render_json(&report));
            } else {
                print!("{}", render_human(&report));
            }
            0
        }
        Err(e) => {
            eprintln!("aura migrate: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let t = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(t.path().join(".git")).unwrap();
        t
    }

    #[test]
    fn discovery_finds_known_artifacts_and_skips_empty() {
        let t = repo();
        fs::write(t.path().join(".cursorrules"), "Use tabs.\n").unwrap();
        fs::write(t.path().join(".windsurfrules"), "   \n").unwrap(); // whitespace only
        fs::create_dir_all(t.path().join(".github")).unwrap();
        fs::write(
            t.path().join(".github/copilot-instructions.md"),
            "Prefer small PRs.\n",
        )
        .unwrap();
        fs::create_dir_all(t.path().join(".cursor/rules")).unwrap();
        fs::write(t.path().join(".cursor/rules/b.mdc"), "Rule B\n").unwrap();
        fs::write(t.path().join(".cursor/rules/a.mdc"), "Rule A\n").unwrap();

        let found = discover(t.path());
        let paths: Vec<&str> = found.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                ".cursor/rules/a.mdc",
                ".cursor/rules/b.mdc",
                ".cursorrules",
                ".github/copilot-instructions.md",
            ]
        );
    }

    #[test]
    fn frontmatter_is_stripped_and_kept_as_note() {
        let t = repo();
        fs::create_dir_all(t.path().join(".cursor/rules")).unwrap();
        fs::write(
            t.path().join(".cursor/rules/ts.mdc"),
            "---\ndescription: TypeScript rules\nglobs: **/*.ts\nalwaysApply: false\n---\nUse strict mode.\n",
        )
        .unwrap();
        let found = discover(t.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].body, "Use strict mode.");
        let note = found[0].note.as_deref().unwrap();
        assert!(note.contains("description: TypeScript rules"));
        assert!(note.contains("globs: **/*.ts"));
        assert!(!note.contains("alwaysApply"));
    }

    #[test]
    fn apply_writes_block_and_rerun_is_idempotent() {
        let t = repo();
        fs::write(t.path().join(".cursorrules"), "Use tabs.\n").unwrap();

        let first = run_in(t.path(), true).unwrap();
        assert!(first.wrote_agents_md);
        assert!(first.backup.is_none(), "no AGENTS.md existed — no backup");
        let text = fs::read_to_string(t.path().join("AGENTS.md")).unwrap();
        assert!(text.contains(BLOCK_START) && text.contains(BLOCK_END));
        assert!(text.contains("Use tabs."));
        assert!(text.contains("aura-migrate source=\".cursorrules\""));

        let second = run_in(t.path(), true).unwrap();
        assert!(!second.wrote_agents_md, "unchanged sources must write nothing");
        assert_eq!(second.sources[0].1, Verdict::Unchanged);
        assert_eq!(text, fs::read_to_string(t.path().join("AGENTS.md")).unwrap());
    }

    #[test]
    fn changed_source_updates_and_existing_content_survives() {
        let t = repo();
        fs::write(
            t.path().join("AGENTS.md"),
            "# Ours\n\nHand-written intro.\n",
        )
        .unwrap();
        fs::write(t.path().join(".cursorrules"), "v1\n").unwrap();
        run_in(t.path(), true).unwrap();

        fs::write(t.path().join(".cursorrules"), "v2\n").unwrap();
        let report = run_in(t.path(), true).unwrap();
        assert_eq!(report.sources[0].1, Verdict::Update);
        assert!(report.wrote_agents_md);
        assert!(report.backup.is_some(), "existing AGENTS.md must be backed up");

        let text = fs::read_to_string(t.path().join("AGENTS.md")).unwrap();
        assert!(text.contains("Hand-written intro."), "content outside block preserved");
        assert!(text.contains("v2") && !text.contains("v1\n"));

        let backup_dir = t.path().join(BACKUP_DIR);
        assert!(fs::read_dir(backup_dir).unwrap().count() >= 1);
    }

    #[test]
    fn deleted_source_is_dropped_on_next_apply() {
        let t = repo();
        fs::write(t.path().join(".cursorrules"), "cursor\n").unwrap();
        fs::write(t.path().join(".clinerules"), "cline\n").unwrap();
        run_in(t.path(), true).unwrap();

        fs::remove_file(t.path().join(".clinerules")).unwrap();
        let report = run_in(t.path(), true).unwrap();
        assert!(report.wrote_agents_md, "stale entry must force a rewrite");
        let text = fs::read_to_string(t.path().join("AGENTS.md")).unwrap();
        assert!(!text.contains("cline"));
        assert!(text.contains("cursor"));
    }

    #[test]
    fn report_mode_never_writes() {
        let t = repo();
        fs::write(t.path().join(".cursorrules"), "Use tabs.\n").unwrap();
        let report = run_in(t.path(), false).unwrap();
        assert!(!report.wrote_agents_md);
        assert_eq!(report.sources[0].1, Verdict::Add);
        assert!(!t.path().join("AGENTS.md").exists());
    }
}
