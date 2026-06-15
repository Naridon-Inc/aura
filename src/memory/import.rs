// `aura memory import-claude-code` — bring an agent CLI's per-fact memory
// into Aura's own project memory (.aura/memory.json).
//
// Why this exists
// ───────────────
// Claude Code keeps its own long-term project memory as a directory of
// per-fact Markdown files (one fact per file, YAML frontmatter + body),
// keyed by the repo's cwd. That knowledge — conventions, gotchas, project
// notes the user taught Claude over many sessions — is invisible to Aura's
// memory engine, every other agent, and the desktop Memory surface. This
// importer reads those fact files and folds each one through Aura's W3
// reconcile pipeline, so the project's accumulated knowledge becomes part
// of the shared, provenance-aware store instead of living in one agent's
// private cache.
//
// What it deliberately does NOT do
// ────────────────────────────────
// Project *instruction* files (CLAUDE.md / AGENTS.md / GEMINI.md) are not
// fact lists — they're prose directives meant to be read whole. Shredding
// them into individual "facts" would produce garbage entries. We import
// ONLY the per-fact memory directory. The `--agent` flag is reserved for
// future agents; anything other than `claude` prints a plain
// "not yet supported" line and exits cleanly.
//
// Mapping (Claude Code fact → Aura MemoryEntry)
// ─────────────────────────────────────────────
//   content   = the markdown body (falls back to `description` if empty)
//   tags      = [<metadata.type>, "imported:claude-code"]
//   added_by  = "claude-code"  (or "claude-code:<originSessionId>" when set)
//   section   = metadata.type → Aura section:
//                 feedback  → conventions   (the user's "how we work" rules)
//                 user      → conventions   (durable user preferences)
//                 reference → context       (background know-how)
//                 project   → context       (project narrative / plans)
//                 (anything else / missing) → context
//   provenance: NO code anchor (source_symbol/source_commit = None);
//               valid_from is stamped by the reconcile pipeline at write.
//
// Each fact is written through `MemoryManager::add_entry_reconciled`, so a
// re-run is idempotent: exact duplicates NOOP, restatements UPDATE
// (supersede), genuinely new facts ADD.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::memory::reconcile::ReconcileOp;
use crate::memory::MemoryManager;

/// One agent fact file parsed into the fields the importer cares about.
#[derive(Debug, Clone)]
pub struct ClaudeFact {
    /// `name` from the frontmatter (or the file stem when absent) — used
    /// only for human reporting, never as the entry id.
    pub name: String,
    /// `description` one-liner from the frontmatter, if any.
    pub description: Option<String>,
    /// `metadata.type` (user | feedback | project | reference) — flat or
    /// nested frontmatter both supported; None when no frontmatter.
    pub fact_type: Option<String>,
    /// `metadata.originSessionId`, when present.
    pub origin_session: Option<String>,
    /// The markdown body after the frontmatter (trimmed).
    pub body: String,
}

impl ClaudeFact {
    /// The content that becomes the Aura entry: body, or the description
    /// when the body is empty (some index-style facts carry only a
    /// one-liner).
    pub fn content(&self) -> String {
        let body = self.body.trim();
        if !body.is_empty() {
            return body.to_string();
        }
        self.description.clone().unwrap_or_default()
    }

    /// `metadata.type` → Aura section. Documented in the module header.
    pub fn aura_section(&self) -> &'static str {
        match self.fact_type.as_deref() {
            Some("feedback") | Some("user") => "conventions",
            Some("reference") | Some("project") => "context",
            _ => "context",
        }
    }

    /// `added_by` stamp: the agent, with the origin session folded in when
    /// known so provenance can trace the fact back to its conversation.
    pub fn added_by(&self) -> String {
        match &self.origin_session {
            Some(s) if !s.trim().is_empty() => format!("claude-code:{}", s.trim()),
            _ => "claude-code".to_string(),
        }
    }

    pub fn tags(&self) -> Vec<String> {
        let ty = self.fact_type.clone().unwrap_or_else(|| "note".to_string());
        vec![ty, "imported:claude-code".to_string()]
    }
}

/// What the import did, both for `--json` and the human summary.
#[derive(Debug, Clone, Serialize)]
pub struct ImportReport {
    /// New facts written to memory (reconcile ADD).
    pub imported: usize,
    /// Facts already present, skipped (reconcile NOOP).
    pub deduped: usize,
    /// Facts that superseded an existing entry (reconcile UPDATE / DELETE).
    pub updated: usize,
    /// Fact files parsed (= imported + deduped + updated + any empties).
    pub total: usize,
    /// Per-Aura-section count of facts that landed (ADD or UPDATE).
    pub by_section: std::collections::BTreeMap<String, usize>,
    /// `true` when nothing was written (dry run) — the caller can phrase
    /// the summary accordingly.
    pub dry_run: bool,
    /// The directory the facts were read from (absolute).
    pub source_dir: String,
}

impl ImportReport {
    fn new(source_dir: String, dry_run: bool) -> Self {
        Self {
            imported: 0,
            deduped: 0,
            updated: 0,
            total: 0,
            by_section: std::collections::BTreeMap::new(),
            dry_run,
            source_dir,
        }
    }
}

/// Encode a repo cwd the way Claude Code names its per-project memory dir:
/// every `/` and space becomes `-`. An absolute path therefore yields a
/// leading `-` (e.g. `/Users/me/My Repo` → `-Users-me-My-Repo`).
pub fn encode_project_dir(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|c| if c == '/' || c == ' ' { '-' } else { c })
        .collect()
}

/// Locate Claude Code's memory dir for `cwd`:
/// `~/.claude/projects/<encoded-cwd>/memory`. Returns the path only when it
/// exists, so callers can give a clean "nothing to import" message.
pub fn default_source_dir(cwd: &Path) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let encoded = encode_project_dir(cwd);
    let dir = PathBuf::from(home)
        .join(".claude")
        .join("projects")
        .join(encoded)
        .join("memory");
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// Split a fact file into (frontmatter-yaml, body). A file that doesn't open
/// with a `---` fence has no frontmatter: the whole text is the body.
fn split_frontmatter(raw: &str) -> (Option<&str>, &str) {
    let trimmed = raw.trim_start_matches('\u{feff}');
    let rest = match trimmed.strip_prefix("---\n").or_else(|| trimmed.strip_prefix("---\r\n")) {
        Some(r) => r,
        None => return (None, trimmed),
    };
    // Find the closing fence at the start of a line.
    for marker in ["\n---\n", "\n---\r\n"] {
        if let Some(idx) = rest.find(marker) {
            let yaml = &rest[..idx];
            let body = &rest[idx + marker.len()..];
            return (Some(yaml), body);
        }
    }
    // A trailing `---` with no following newline (EOF) also closes it.
    if let Some(stripped) = rest.strip_suffix("\n---") {
        return (Some(stripped), "");
    }
    // Open fence but no close — treat the whole thing as body (defensive).
    (None, trimmed)
}

/// Read `name`/`description`/`type`/`originSessionId` out of the YAML
/// frontmatter, supporting BOTH the flat shape (`type:` at root) and the
/// nested shape (`metadata: { type:, originSessionId: }`) Claude Code
/// emits across versions.
fn parse_frontmatter(yaml: &str) -> (Option<String>, Option<String>, Option<String>, Option<String>) {
    let value: serde_yaml::Value = match serde_yaml::from_str(yaml) {
        Ok(v) => v,
        Err(_) => return (None, None, None, None),
    };
    let get_str = |v: &serde_yaml::Value, key: &str| -> Option<String> {
        v.get(key)
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };

    let name = get_str(&value, "name");
    let description = get_str(&value, "description");

    // type / originSessionId: prefer the nested `metadata` block, fall back
    // to the flat root keys.
    let metadata = value.get("metadata");
    let fact_type = metadata
        .and_then(|m| get_str(m, "type"))
        .or_else(|| get_str(&value, "type"));
    let origin_session = metadata
        .and_then(|m| get_str(m, "originSessionId"))
        .or_else(|| get_str(&value, "originSessionId"));

    (name, description, fact_type, origin_session)
}

/// Parse one fact file into a `ClaudeFact`. Returns None only for an
/// unreadable file; a frontmatter-less file is still a fact (filename =
/// name, whole text = body, type defaults to context downstream).
pub fn parse_fact_file(path: &Path) -> Option<ClaudeFact> {
    let raw = fs::read_to_string(path).ok()?;
    let (yaml, body) = split_frontmatter(&raw);
    let (name, description, fact_type, origin_session) = match yaml {
        Some(y) => parse_frontmatter(y),
        None => (None, None, None, None),
    };
    let name = name.unwrap_or_else(|| {
        path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "fact".to_string())
    });
    Some(ClaudeFact {
        name,
        description,
        fact_type,
        origin_session,
        body: body.trim().to_string(),
    })
}

/// Collect every importable fact file in `dir`: top-level `*.md` files,
/// excluding the `MEMORY.md` index (it's a table of contents, not a fact).
/// Sorted for deterministic reporting.
pub fn collect_fact_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md"))
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| !n.eq_ignore_ascii_case("MEMORY.md"))
                    .unwrap_or(false)
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    files.sort();
    files
}

/// The pure import driver: parse every fact, run each through reconcile (or,
/// in dry-run, only classify), and tally the report. Split out from the CLI
/// arm so it's directly testable.
///
/// `write` = false performs a real parse + section mapping but does NOT
/// touch memory.json — dry-run preview. `write` = true persists through the
/// W3 reconcile pipeline.
pub fn run_import(dir: &Path, write: bool) -> ImportReport {
    let mut report = ImportReport::new(dir.to_string_lossy().to_string(), !write);
    let files = collect_fact_files(dir);

    for path in &files {
        let Some(fact) = parse_fact_file(path) else {
            continue;
        };
        let content = fact.content();
        if content.trim().is_empty() {
            // No body and no description — nothing to remember. Count it in
            // `total` (it was a file) but it lands nowhere.
            report.total += 1;
            continue;
        }
        report.total += 1;
        let section = fact.aura_section();

        if !write {
            // Dry-run: we can't know whether reconcile would NOOP without
            // calling the model, so report every non-empty fact as a
            // would-import and tally by mapped section. This is honest about
            // the upper bound; the real run reports the exact split.
            report.imported += 1;
            *report.by_section.entry(section.to_string()).or_insert(0) += 1;
            continue;
        }

        let outcome = MemoryManager::add_entry_reconciled(
            section,
            &content,
            fact.tags(),
            &fact.added_by(),
            None, // imported facts carry no code anchor
        );
        match outcome.op {
            ReconcileOp::Added => {
                report.imported += 1;
                *report.by_section.entry(section.to_string()).or_insert(0) += 1;
            }
            ReconcileOp::Updated => {
                report.updated += 1;
                *report.by_section.entry(section.to_string()).or_insert(0) += 1;
            }
            ReconcileOp::Deleted => {
                // The incoming fact invalidated an existing one without
                // adding new knowledge — count as an update (the store
                // changed) but it owns no section slot.
                report.updated += 1;
            }
            ReconcileOp::Noop => {
                report.deduped += 1;
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_replaces_slash_and_space_with_dash() {
        let p = Path::new("/Users/me/My Repo");
        assert_eq!(encode_project_dir(p), "-Users-me-My-Repo");
    }

    #[test]
    fn parses_flat_frontmatter() {
        let raw = "---\nname: Never stub code\ndescription: No stubs allowed.\ntype: feedback\noriginSessionId: abc-123\n---\nReal body here.\nSecond line.";
        let (yaml, body) = split_frontmatter(raw);
        assert!(yaml.is_some());
        assert_eq!(body.trim(), "Real body here.\nSecond line.");
        let (name, desc, ty, sess) = parse_frontmatter(yaml.unwrap());
        assert_eq!(name.as_deref(), Some("Never stub code"));
        assert_eq!(desc.as_deref(), Some("No stubs allowed."));
        assert_eq!(ty.as_deref(), Some("feedback"));
        assert_eq!(sess.as_deref(), Some("abc-123"));
    }

    #[test]
    fn parses_nested_metadata_frontmatter() {
        let raw = "---\nname: project-code-atlas\ndescription: \"The atlas engine\"\nmetadata:\n  node_type: memory\n  type: project\n  originSessionId: beb1d4d7\n---\n\nBody about atlas.";
        let (yaml, body) = split_frontmatter(raw);
        let (name, _desc, ty, sess) = parse_frontmatter(yaml.unwrap());
        assert_eq!(name.as_deref(), Some("project-code-atlas"));
        assert_eq!(ty.as_deref(), Some("project"));
        assert_eq!(sess.as_deref(), Some("beb1d4d7"));
        assert_eq!(body.trim(), "Body about atlas.");
    }

    #[test]
    fn frontmatterless_file_is_all_body() {
        let raw = "# Deployment Guide\n\nServer details here.";
        let (yaml, body) = split_frontmatter(raw);
        assert!(yaml.is_none());
        assert_eq!(body, raw);
    }

    #[test]
    fn section_mapping_is_documented() {
        let mk = |ty: Option<&str>| ClaudeFact {
            name: "x".into(),
            description: None,
            fact_type: ty.map(|s| s.to_string()),
            origin_session: None,
            body: "b".into(),
        };
        assert_eq!(mk(Some("feedback")).aura_section(), "conventions");
        assert_eq!(mk(Some("user")).aura_section(), "conventions");
        assert_eq!(mk(Some("reference")).aura_section(), "context");
        assert_eq!(mk(Some("project")).aura_section(), "context");
        assert_eq!(mk(None).aura_section(), "context");
    }

    #[test]
    fn content_falls_back_to_description_when_body_empty() {
        let f = ClaudeFact {
            name: "x".into(),
            description: Some("one-liner".into()),
            fact_type: Some("reference".into()),
            origin_session: None,
            body: "".into(),
        };
        assert_eq!(f.content(), "one-liner");
    }

    #[test]
    fn added_by_folds_in_origin_session() {
        let f = ClaudeFact {
            name: "x".into(),
            description: None,
            fact_type: None,
            origin_session: Some("sess-9".into()),
            body: "b".into(),
        };
        assert_eq!(f.added_by(), "claude-code:sess-9");
    }

    #[test]
    fn dry_run_counts_facts_without_writing() {
        let dir = std::env::temp_dir().join(format!("aura-import-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        fs::write(
            dir.join("a.md"),
            "---\nname: A\ntype: feedback\n---\nFact A body.",
        )
        .unwrap();
        fs::write(
            dir.join("b.md"),
            "---\nname: B\nmetadata:\n  type: reference\n---\nFact B body.",
        )
        .unwrap();
        // The index must be skipped.
        fs::write(dir.join("MEMORY.md"), "# index\n- a\n- b").unwrap();

        let report = run_import(&dir, false);
        assert_eq!(report.total, 2, "MEMORY.md must be excluded");
        assert_eq!(report.imported, 2);
        assert_eq!(report.by_section.get("conventions"), Some(&1));
        assert_eq!(report.by_section.get("context"), Some(&1));
        assert!(report.dry_run);

        let _ = fs::remove_dir_all(&dir);
    }
}
