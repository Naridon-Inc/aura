//! `aura distill` — fold a dirty working tree into clean, intent-grouped
//! semantic commits (AURA-45).
//!
//! Agents leave behind noisy WIP: one giant uncommitted blob of edits with the
//! *why* sitting unattached in `.aura/intent_log.jsonl`. Distill walks the
//! current working tree vs HEAD (staged + unstaged, flattened — the worktree
//! is the truth), detects WHAT changed per file with the same tree-sitter
//! parser `aura pr-review` uses (added / modified / deleted top-level
//! symbols), then pairs each file with the logged intent that best explains
//! it — reusing `pr_humanize::best_scored` (file-stem = 2, symbol = 1, newest
//! wins a tie) so review and distill agree on which intent owns a change.
//!
//! Files sharing a best intent row become one commit whose subject is a
//! conventional-commit line derived from the row's `intent_type` plus a
//! deterministic symbol summary, and whose body carries the intent verbatim.
//! Files no intent explains are NEVER given an invented reason: they land in
//! one honest final commit, "chore: remaining changes (no recorded intent)".
//! Nothing is ever lost — every dirty file ends up in exactly one commit
//! (untracked files only with `--include-untracked`).
//!
//! Execution never half-stages: each group's tree is built in an *in-memory*
//! index (HEAD tree + that group's worktree state) and committed in one shot;
//! the on-disk index is only synced after commits land, preserving any staged
//! entries for paths distill did not touch.

use colored::Colorize;
use git2::{DiffOptions, IndexEntry, IndexTime, Repository};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use crate::intent_query::{read_all_rows, IntentRow};
use crate::parser::SemanticParser;
use crate::pr::pr_humanize::{best_scored, ChangedSymbol, IntentOrigin, IntentRecord};

#[cfg(test)]
#[path = "distill_tests.rs"]
mod tests;

// ---------------------------------------------------------------------------
// Plan shapes (the stable machine surface for --json)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PlanSymbol {
    pub name: String,
    /// `added` | `modified` | `deleted` | `renamed`.
    pub action: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanFile {
    /// Path relative to the repo root.
    pub path: String,
    /// `added` | `modified` | `deleted` — the file-level delta vs HEAD.
    pub change: String,
    /// Deterministic one-liner: "update parse_config, add login".
    pub what: String,
    /// Top-level symbols the parser saw change (empty for non-code files).
    pub symbols: Vec<PlanSymbol>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanIntent {
    /// The logged intent prose, verbatim.
    pub intent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed_block_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanGroup {
    /// First line of the commit message (≤ 72 chars).
    pub subject: String,
    /// Full commit message (subject + blank line + Why/Agent/Intent-Id body).
    pub message: String,
    pub files: Vec<PlanFile>,
    /// The intent row this group was distilled from; `None` for the honest
    /// leftover group — a missing reason is never invented.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<PlanIntent>,
    /// Commit SHA once executed; `null` in a dry-run / plan.
    pub commit: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DistillPlan {
    /// `plan` (dry-run / --json) or `execute`.
    pub mode: String,
    /// HEAD before distilling (None on an unborn branch).
    pub head_before: Option<String>,
    pub include_untracked: bool,
    pub max_groups: usize,
    pub groups: Vec<PlanGroup>,
    /// Human-readable observations: overflow merges, skipped entries, …
    pub notes: Vec<String>,
    /// How many groups have been committed (0 in plan mode).
    pub committed: usize,
    /// Set when execution stopped mid-sequence; landed groups keep their
    /// `commit`, the rest stay dirty in the working tree.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct DistillOptions {
    pub dry_run: bool,
    pub json: bool,
    pub include_untracked: bool,
    pub max_groups: usize,
}

// ---------------------------------------------------------------------------
// Inventory: what is dirty vs HEAD, and WHAT changed inside each file
// ---------------------------------------------------------------------------

/// One dirty file with its parsed symbol-level changes.
#[derive(Debug, Clone)]
struct FileChange {
    path: String,
    change: String, // added | modified | deleted
    symbols: Vec<ChangedSymbol>,
}

/// Map a path to the parser ext `pr.rs` supports, or None for "non-code".
fn parser_ext(path: &Path) -> Option<&'static str> {
    match path.extension().and_then(|s| s.to_str()) {
        Some("rs") => Some("rs"),
        Some("py") => Some("py"),
        Some("ts") | Some("tsx") => Some("ts"),
        Some("js") | Some("jsx") => Some("js"),
        _ => None,
    }
}

/// Collect every dirty file vs HEAD (staged + unstaged flattened; the
/// worktree is the truth) and parse old-vs-new top-level symbols.
fn inventory(
    repo: &Repository,
    head_tree: Option<&git2::Tree>,
    include_untracked: bool,
    notes: &mut Vec<String>,
) -> Result<Vec<FileChange>, Box<dyn std::error::Error>> {
    let workdir = repo
        .workdir()
        .ok_or("aura distill requires a repository with a working tree")?
        .to_path_buf();

    let mut opts = DiffOptions::new();
    opts.include_untracked(include_untracked)
        .recurse_untracked_dirs(include_untracked)
        .include_typechange(true);
    let diff = repo.diff_tree_to_workdir_with_index(head_tree, Some(&mut opts))?;

    let mut parser = SemanticParser::new()?;
    let mut out: Vec<FileChange> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for delta in diff.deltas() {
        // Submodule pointers are not files we can stage as blobs — skip
        // honestly and say so rather than failing mid-commit later.
        if matches!(delta.new_file().mode(), git2::FileMode::Commit)
            || matches!(delta.old_file().mode(), git2::FileMode::Commit)
        {
            if let Some(p) = delta.new_file().path().or_else(|| delta.old_file().path()) {
                notes.push(format!(
                    "skipped submodule '{}' — distill only commits file changes",
                    p.display()
                ));
            }
            continue;
        }

        let rel: PathBuf = match delta.new_file().path().or_else(|| delta.old_file().path()) {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        let path_str = rel.to_string_lossy().to_string();
        if !seen.insert(path_str.clone()) {
            continue;
        }

        let change = match delta.status() {
            git2::Delta::Added | git2::Delta::Untracked => "added",
            git2::Delta::Deleted => "deleted",
            _ => "modified",
        }
        .to_string();

        // WHAT: old (HEAD blob) vs new (worktree) top-level symbols, with the
        // same parser + diff pr.rs uses. Unparseable / non-code → no symbols.
        let mut symbols: Vec<ChangedSymbol> = Vec::new();
        if let Some(ext) = parser_ext(&rel) {
            let old_nodes = head_tree
                .and_then(|t| t.get_path(&rel).ok())
                .and_then(|entry| entry.to_object(repo).ok())
                .and_then(|obj| obj.as_blob().map(|b| b.content().to_vec()))
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .and_then(|src| parser.parse_file(&src, ext).ok())
                .unwrap_or_default();
            let new_nodes = std::fs::read_to_string(workdir.join(&rel))
                .ok()
                .and_then(|src| parser.parse_file(&src, ext).ok())
                .unwrap_or_default();
            for (name, action) in SemanticParser::diff_nodes(&old_nodes, &new_nodes) {
                symbols.push(ChangedSymbol {
                    name,
                    action,
                    line: None,
                    kind: None,
                });
            }
        }

        out.push(FileChange {
            path: path_str,
            change,
            symbols,
        });
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Grouping: score each file against the intent log, cap at --max-groups
// ---------------------------------------------------------------------------

/// One distill group before message composition. `intent: None` is the honest
/// leftover bucket.
struct Group {
    /// Index into the intent-log rows (log order == chronological order).
    intent_index: Option<usize>,
    files: Vec<FileChange>,
}

/// Read the local intent log and mirror it into `IntentRecord`s so
/// `pr_humanize::best_scored` can score them. Rows stay index-aligned with
/// the returned `IntentRow`s (empty-intent rows are dropped from both).
fn load_intents(repo_root: &Path) -> (Vec<IntentRow>, Vec<IntentRecord>) {
    let rows: Vec<IntentRow> = read_all_rows(&repo_root.join(".aura").join("intent_log.jsonl"))
        .into_iter()
        .filter(|r| !r.intent.trim().is_empty())
        .collect();
    let records = rows
        .iter()
        .map(|r| IntentRecord {
            intent: r.intent.clone(),
            agent_id: match r.agent_id.trim() {
                "" | "unknown" => None,
                a => Some(a.to_string()),
            },
            timestamp: if r.timestamp > 0 { Some(r.timestamp) } else { None },
            task_id: None,
            task_seq: None,
            origin: IntentOrigin::Local,
        })
        .collect();
    (rows, records)
}

/// Group files by their best-matching intent row. Files no intent explains
/// fall into the leftover bucket — never a fabricated reason.
fn group_by_intent(files: Vec<FileChange>, records: &[IntentRecord]) -> Vec<Group> {
    let mut by_intent: BTreeMap<usize, Vec<FileChange>> = BTreeMap::new();
    let mut leftover: Vec<FileChange> = Vec::new();

    for file in files {
        let stem = Path::new(&file.path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&file.path)
            .to_lowercase();
        let chosen = best_scored(&stem, &file.symbols, records, IntentOrigin::Local)
            .and_then(|rec| records.iter().position(|r| std::ptr::eq(r, rec)));
        match chosen {
            Some(idx) => by_intent.entry(idx).or_default().push(file),
            None => leftover.push(file),
        }
    }

    // Deterministic order: intent groups in log order (oldest intent first),
    // honest leftover group always last.
    let mut groups: Vec<Group> = by_intent
        .into_iter()
        .map(|(idx, files)| Group {
            intent_index: Some(idx),
            files,
        })
        .collect();
    if !leftover.is_empty() {
        groups.push(Group {
            intent_index: None,
            files: leftover,
        });
    }
    groups
}

/// Longest shared leading directory-component run between two paths.
fn shared_components(a: &str, b: &str) -> usize {
    let da: Vec<&str> = Path::new(a)
        .parent()
        .map(|p| p.iter().filter_map(|c| c.to_str()).collect())
        .unwrap_or_default();
    let db: Vec<&str> = Path::new(b)
        .parent()
        .map(|p| p.iter().filter_map(|c| c.to_str()).collect())
        .unwrap_or_default();
    da.iter().zip(db.iter()).take_while(|(x, y)| x == y).count()
}

/// Best directory affinity between any file of `g` and any file of `s`.
fn dir_affinity(g: &Group, s: &Group) -> usize {
    let mut best = 0;
    for gf in &g.files {
        for sf in &s.files {
            best = best.max(shared_components(&gf.path, &sf.path));
        }
    }
    best
}

/// Enforce `--max-groups`: overflow intent groups merge into the nearest
/// surviving *intent* group by shared directory. The leftover bucket is
/// never a merge target (its message says "no recorded intent" — dumping
/// intent-bearing files there would lie) and never overflows. Every merge
/// is logged into `notes`.
fn cap_groups(
    mut groups: Vec<Group>,
    max_groups: usize,
    rows: &[IntentRow],
    notes: &mut Vec<String>,
) -> Vec<Group> {
    let mut max_groups = max_groups.max(1);
    let has_leftover = groups.iter().any(|g| g.intent_index.is_none());
    // The leftover group is mandatory when present (honesty over the cap):
    // intent-bearing files must merge into intent groups, so at least one
    // intent slot has to survive alongside it.
    if has_leftover && max_groups < 2 && groups.len() > 1 {
        notes.push("max-groups raised to 2: the no-recorded-intent group cannot absorb files that have an intent".to_string());
        max_groups = 2;
    }
    if groups.len() <= max_groups {
        return groups;
    }

    // Rank intent groups: bigger groups carry the stronger signal, log order
    // breaks ties. Survivors = leftover (if any) + top-ranked intent groups.
    let mut intent_order: Vec<usize> = groups
        .iter()
        .enumerate()
        .filter(|(_, g)| g.intent_index.is_some())
        .map(|(i, _)| i)
        .collect();
    intent_order.sort_by(|&a, &b| {
        groups[b]
            .files
            .len()
            .cmp(&groups[a].files.len())
            .then(groups[a].intent_index.cmp(&groups[b].intent_index))
    });
    let intent_capacity = max_groups - usize::from(has_leftover);
    let survivor_set: HashSet<usize> = intent_order.iter().take(intent_capacity).copied().collect();

    // Merge each overflow group into the nearest surviving intent group.
    let overflow: Vec<usize> = intent_order.iter().skip(intent_capacity).copied().collect();
    let mut merged_files: Vec<(usize, Vec<FileChange>)> = Vec::new();
    for &gi in &overflow {
        let target = survivor_set
            .iter()
            .map(|&si| (dir_affinity(&groups[gi], &groups[si]), std::cmp::Reverse(si), si))
            .max()
            .map(|(_, _, si)| si)
            .expect("at least one intent group survives the cap");
        let from = intent_subject_hint(&groups[gi], rows);
        let into = intent_subject_hint(&groups[target], rows);
        notes.push(format!(
            "max-groups: merged group \"{from}\" ({} file{}) into \"{into}\" (nearest by shared directory)",
            groups[gi].files.len(),
            if groups[gi].files.len() == 1 { "" } else { "s" },
        ));
        let files = std::mem::take(&mut groups[gi].files);
        merged_files.push((target, files));
    }
    for (target, files) in merged_files {
        groups[target].files.extend(files);
    }

    let mut kept: Vec<Group> = Vec::new();
    for (i, g) in groups.into_iter().enumerate() {
        if g.intent_index.is_none() || survivor_set.contains(&i) {
            kept.push(g);
        }
    }
    for g in &mut kept {
        g.files.sort_by(|a, b| a.path.cmp(&b.path));
    }
    kept
}

/// Short label for a group used in merge notes (intent first sentence-ish).
fn intent_subject_hint(group: &Group, rows: &[IntentRow]) -> String {
    match group.intent_index {
        Some(idx) => {
            let text = rows[idx].intent.trim();
            let mut hint: String = text.chars().take(48).collect();
            if text.chars().count() > 48 {
                hint.push('…');
            }
            hint
        }
        None => "remaining changes (no recorded intent)".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Messages: conventional-commit subject + verbatim WHY body
// ---------------------------------------------------------------------------

/// `intent_type` → conventional-commit type. Anything unknown (or absent)
/// stays an honest `chore`.
fn type_prefix(intent_type: Option<&str>) -> &'static str {
    match intent_type {
        Some("FeatureAdd") => "feat",
        Some("BugFix") => "fix",
        Some("Refactor") => "refactor",
        Some("Revert") => "revert",
        Some("Docs") => "docs",
        Some("Deps") => "build",
        Some("Performance") => "perf",
        _ => "chore",
    }
}

const VERBS: [&str; 4] = ["add", "update", "remove", "rename"];

/// Flatten a group's changes into (verb-bucket, item) pairs: symbols when the
/// parser saw them, file basenames otherwise. Deduped, alphabetical within
/// each bucket — fully deterministic, no LLM anywhere.
fn summary_items(files: &[FileChange]) -> Vec<(usize, String)> {
    let mut buckets: [BTreeSet<String>; 4] = Default::default();
    for file in files {
        if file.symbols.is_empty() {
            let basename = Path::new(&file.path)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| file.path.clone());
            let bucket = match file.change.as_str() {
                "added" => 0,
                "deleted" => 2,
                _ => 1,
            };
            buckets[bucket].insert(basename);
            continue;
        }
        for sym in &file.symbols {
            let (bucket, item) = match sym.action.as_str() {
                "added" => (0, sym.name.clone()),
                "deleted" => (2, sym.name.clone()),
                // diff_nodes renders renames as "old -> new"; the new name is
                // the one a reader greps for.
                "renamed" => (
                    3,
                    sym.name
                        .rsplit(" -> ")
                        .next()
                        .unwrap_or(&sym.name)
                        .to_string(),
                ),
                _ => (1, sym.name.clone()),
            };
            buckets[bucket].insert(item);
        }
    }
    let mut items = Vec::new();
    for (bi, bucket) in buckets.iter().enumerate() {
        for item in bucket {
            items.push((bi, item.clone()));
        }
    }
    items
}

/// Render `prefix: verb a, b; verb2 c +N more`, greedily fitting `budget`
/// chars. Deterministic truncation: drop items from the end until it fits.
fn compose_line(prefix: Option<&str>, items: &[(usize, String)], budget: usize) -> String {
    let render = |shown: &[(usize, String)], dropped: usize| -> String {
        let mut parts: Vec<String> = Vec::new();
        let mut current_bucket: Option<usize> = None;
        for (bucket, item) in shown {
            if current_bucket == Some(*bucket) {
                let last = parts.last_mut().expect("bucket part exists");
                last.push_str(", ");
                last.push_str(item);
            } else {
                parts.push(format!("{} {}", VERBS[*bucket], item));
                current_bucket = Some(*bucket);
            }
        }
        let body = parts.join("; ");
        let mut line = match prefix {
            Some(p) => format!("{p}: {body}"),
            None => body,
        };
        if dropped > 0 {
            line.push_str(&format!(" +{dropped} more"));
        }
        line
    };

    if items.is_empty() {
        // A group always has files, and files always yield at least a
        // basename item — this only guards direct misuse.
        return match prefix {
            Some(p) => format!("{p}: update files"),
            None => "update files".to_string(),
        };
    }
    for k in (1..=items.len()).rev() {
        let line = render(&items[..k], items.len() - k);
        if line.chars().count() <= budget {
            return line;
        }
    }
    render(&items[..1], items.len() - 1)
        .chars()
        .take(budget)
        .collect()
}

/// Subject the leftover group always gets — honest, never an invented why.
pub const LEFTOVER_SUBJECT: &str = "chore: remaining changes (no recorded intent)";

/// Build the final plan groups: subject (≤72 chars, conventional type from
/// the intent_type), body with the verbatim WHY + provenance trailers.
fn compose_groups(groups: Vec<Group>, rows: &[IntentRow]) -> Vec<PlanGroup> {
    groups
        .into_iter()
        .map(|group| {
            let files: Vec<PlanFile> = group
                .files
                .iter()
                .map(|f| PlanFile {
                    path: f.path.clone(),
                    change: f.change.clone(),
                    what: compose_line(None, &summary_items(std::slice::from_ref(f)), 100),
                    symbols: f
                        .symbols
                        .iter()
                        .map(|s| PlanSymbol {
                            name: s.name.clone(),
                            action: s.action.clone(),
                        })
                        .collect(),
                })
                .collect();

            match group.intent_index {
                Some(idx) => {
                    let row = &rows[idx];
                    let prefix = type_prefix(row.intent_type.as_deref());
                    let subject = compose_line(Some(prefix), &summary_items(&group.files), 72);
                    let mut body: Vec<String> = vec![format!("Why: {}", row.intent.trim())];
                    match row.agent_id.trim() {
                        "" | "unknown" => {}
                        agent => body.push(format!("Agent: {agent}")),
                    }
                    if let Some(bid) = &row.signed_block_id {
                        body.push(format!("Intent-Id: {bid}"));
                    }
                    if let Some(kid) = &row.key_id {
                        body.push(format!("Key-Id: {kid}"));
                    }
                    let message = format!("{subject}\n\n{}\n", body.join("\n"));
                    PlanGroup {
                        subject,
                        message,
                        files,
                        intent: Some(PlanIntent {
                            intent: row.intent.clone(),
                            intent_type: row.intent_type.clone(),
                            agent_id: match row.agent_id.trim() {
                                "" | "unknown" => None,
                                a => Some(a.to_string()),
                            },
                            timestamp: if row.timestamp > 0 {
                                Some(row.timestamp)
                            } else {
                                None
                            },
                            key_id: row.key_id.clone(),
                            signed_block_id: row.signed_block_id.clone(),
                        }),
                        commit: None,
                    }
                }
                None => PlanGroup {
                    subject: LEFTOVER_SUBJECT.to_string(),
                    message: format!("{LEFTOVER_SUBJECT}\n"),
                    files,
                    intent: None,
                    commit: None,
                },
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Execution: one commit per group, never half-staged
// ---------------------------------------------------------------------------

/// Stage one path's *worktree* state into the in-memory index: blob + mode
/// for files/symlinks, removal when the path is gone from disk.
fn stage_worktree_state(
    repo: &Repository,
    mem: &mut git2::Index,
    workdir: &Path,
    rel: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let abs = workdir.join(rel);
    let md = match std::fs::symlink_metadata(&abs) {
        Ok(m) => m,
        Err(_) => {
            // Deleted in the worktree → deleted in the commit. Tolerate the
            // path already being absent from the tree.
            let _ = mem.remove_path(Path::new(rel));
            return Ok(());
        }
    };
    let ft = md.file_type();
    let (oid, mode) = if ft.is_symlink() {
        let target = std::fs::read_link(&abs)?;
        (
            repo.blob(target.to_string_lossy().as_bytes())?,
            0o120000u32,
        )
    } else if ft.is_file() {
        (repo.blob_path(&abs)?, file_mode(&md))
    } else {
        return Err(format!("'{rel}' is not a regular file — cannot distill it").into());
    };
    let entry = IndexEntry {
        ctime: IndexTime::new(0, 0),
        mtime: IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode,
        uid: 0,
        gid: 0,
        file_size: 0,
        id: oid,
        flags: 0,
        flags_extended: 0,
        path: rel.as_bytes().to_vec(),
    };
    mem.add(&entry)?;
    Ok(())
}

#[cfg(unix)]
fn file_mode(md: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    if md.permissions().mode() & 0o111 != 0 {
        0o100755
    } else {
        0o100644
    }
}

#[cfg(not(unix))]
fn file_mode(_md: &std::fs::Metadata) -> u32 {
    0o100644
}

/// Commit each group in order. On any failure: stop immediately, leave what
/// landed committed, the rest untouched in the working tree, and say exactly
/// which is which via `plan.error` + per-group `commit` fields.
fn execute_plan(repo: &Repository, plan: &mut DistillPlan) {
    let workdir = match repo.workdir() {
        Some(w) => w.to_path_buf(),
        None => {
            plan.error = Some("repository has no working tree".to_string());
            return;
        }
    };

    let mut real_index = match repo.index() {
        Ok(i) => i,
        Err(e) => {
            plan.error = Some(format!("cannot open index: {e}"));
            return;
        }
    };
    if real_index.has_conflicts() {
        plan.error =
            Some("the index has unresolved merge conflicts — resolve them first".to_string());
        return;
    }
    // Snapshot the on-disk index so staged entries for paths distill does not
    // commit survive the post-run sync (e.g. a file staged then reverted in
    // the worktree).
    let index_snapshot: Vec<IndexEntry> = real_index.iter().collect();

    let sig = match repo.signature() {
        Ok(s) => s,
        Err(_) => {
            plan.error = Some(
                "no committer identity configured — set git user.name and user.email".to_string(),
            );
            return;
        }
    };

    let mut parent: Option<git2::Commit> = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok());
    let mut landed_paths: HashSet<String> = HashSet::new();

    for gi in 0..plan.groups.len() {
        let result = (|| -> Result<Option<git2::Oid>, Box<dyn std::error::Error>> {
            let mut mem = git2::Index::new()?;
            if let Some(p) = &parent {
                mem.read_tree(&p.tree()?)?;
            }
            for file in &plan.groups[gi].files {
                stage_worktree_state(repo, &mut mem, &workdir, &file.path)?;
            }
            let tree_id = mem.write_tree_to(repo)?;
            if let Some(p) = &parent {
                if p.tree_id() == tree_id {
                    // The worktree moved back to HEAD for every path in this
                    // group between planning and execution — an empty commit
                    // would be noise.
                    return Ok(None);
                }
            }
            let tree = repo.find_tree(tree_id)?;
            let parents: Vec<&git2::Commit> = parent.iter().collect();
            let oid = repo.commit(Some("HEAD"), &sig, &sig, &plan.groups[gi].message, &tree, &parents)?;
            Ok(Some(oid))
        })();

        match result {
            Ok(Some(oid)) => {
                plan.groups[gi].commit = Some(oid.to_string());
                plan.committed += 1;
                for f in &plan.groups[gi].files {
                    landed_paths.insert(f.path.clone());
                }
                parent = repo.find_commit(oid).ok();
            }
            Ok(None) => {
                plan.notes.push(format!(
                    "group \"{}\" no longer differs from HEAD — skipped (no empty commit)",
                    plan.groups[gi].subject
                ));
                for f in &plan.groups[gi].files {
                    landed_paths.insert(f.path.clone());
                }
            }
            Err(e) => {
                plan.error = Some(format!(
                    "commit failed for group \"{}\": {e}",
                    plan.groups[gi].subject
                ));
                break;
            }
        }
    }

    // Sync the on-disk index to the new HEAD for everything that landed, so
    // `git status` is clean afterwards. Entries for paths distill did not
    // commit are restored from the snapshot (preserving any staged state).
    if plan.committed > 0 || plan.error.is_some() {
        let sync = (|| -> Result<(), git2::Error> {
            let head_tree = match &parent {
                Some(p) => p.tree()?,
                None => return Ok(()),
            };
            real_index.read_tree(&head_tree)?;
            for entry in &index_snapshot {
                let path = String::from_utf8_lossy(&entry.path).to_string();
                if landed_paths.contains(&path) {
                    continue;
                }
                let unchanged = head_tree
                    .get_path(Path::new(&path))
                    .map(|te| te.id() == entry.id && te.filemode() as u32 == entry.mode)
                    .unwrap_or(false);
                if !unchanged {
                    real_index.add(entry)?;
                }
            }
            real_index.write()
        })();
        if let Err(e) = sync {
            plan.notes
                .push(format!("warning: failed to refresh the index after committing: {e}"));
        }
    }
}

// ---------------------------------------------------------------------------
// Orchestration + CLI surface
// ---------------------------------------------------------------------------

/// Build the distill plan for `repo`'s dirty working tree, and execute it
/// unless `dry_run`/`json` ask for the plan only. Pure with respect to the
/// process: no chdir, no global state — hermetic tests call this directly.
pub fn distill(repo: &Repository, opts: &DistillOptions) -> Result<DistillPlan, String> {
    let plan_only = opts.dry_run || opts.json;
    let mut notes: Vec<String> = Vec::new();

    let head_commit = match repo.head() {
        Ok(h) => Some(h.peel_to_commit().map_err(|e| e.to_string())?),
        Err(e)
            if e.code() == git2::ErrorCode::UnbornBranch
                || e.code() == git2::ErrorCode::NotFound =>
        {
            None
        }
        Err(e) => return Err(e.to_string()),
    };
    let head_tree = match &head_commit {
        Some(c) => Some(c.tree().map_err(|e| e.to_string())?),
        None => None,
    };

    let files = inventory(repo, head_tree.as_ref(), opts.include_untracked, &mut notes)
        .map_err(|e| e.to_string())?;

    let workdir = repo
        .workdir()
        .ok_or_else(|| "aura distill requires a repository with a working tree".to_string())?;
    let (rows, records) = load_intents(workdir);

    let groups = group_by_intent(files, &records);
    let groups = cap_groups(groups, opts.max_groups, &rows, &mut notes);
    let plan_groups = compose_groups(groups, &rows);

    let mut plan = DistillPlan {
        mode: if plan_only { "plan" } else { "execute" }.to_string(),
        head_before: head_commit.as_ref().map(|c| c.id().to_string()),
        include_untracked: opts.include_untracked,
        max_groups: opts.max_groups.max(1),
        groups: plan_groups,
        notes,
        committed: 0,
        error: None,
    };

    if plan.groups.is_empty() || plan_only {
        return Ok(plan);
    }

    execute_plan(repo, &mut plan);
    Ok(plan)
}

/// CLI entry point. Returns the process exit code.
pub fn run(dry_run: bool, json: bool, include_untracked: bool, max_groups: usize) -> i32 {
    let repo = match Repository::discover(".") {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{} not inside a git repository: {}", "✗".red().bold(), e.message());
            return 1;
        }
    };
    let opts = DistillOptions {
        dry_run,
        json,
        include_untracked,
        max_groups,
    };
    let plan = match distill(&repo, &opts) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{} {}", "✗".red().bold(), e);
            return 1;
        }
    };

    if json {
        match serde_json::to_string_pretty(&plan) {
            Ok(s) => println!("{s}"),
            Err(e) => {
                eprintln!("{} failed to serialize plan: {e}", "✗".red().bold());
                return 1;
            }
        }
        return if plan.error.is_some() { 1 } else { 0 };
    }

    if plan.groups.is_empty() {
        println!("{} Nothing to distill — the working tree is clean.", "✓".green());
        return 0;
    }

    let file_count: usize = plan.groups.iter().map(|g| g.files.len()).sum();
    println!(
        "\n{} {} — {} group{} across {} file{}{}",
        "⚗️ ".bold(),
        "aura distill".bold().cyan(),
        plan.groups.len(),
        if plan.groups.len() == 1 { "" } else { "s" },
        file_count,
        if file_count == 1 { "" } else { "s" },
        if plan.mode == "plan" { " (dry run — nothing committed)".dimmed().to_string() } else { String::new() },
    );

    for (i, group) in plan.groups.iter().enumerate() {
        let marker = match &group.commit {
            Some(sha) => format!("{} {}", "✓".green().bold(), sha[..7.min(sha.len())].yellow()),
            None => format!("{}", "·".dimmed()),
        };
        println!("\n{} [{}/{}] {}", marker, i + 1, plan.groups.len(), group.subject.white().bold());
        for file in &group.files {
            println!("    {} {} {}", "•".blue(), file.path, format!("— {}", file.what).dimmed());
        }
        if let Some(intent) = &group.intent {
            println!("    {} {}", "Why:".bold(), intent.intent.trim().dimmed());
        }
    }

    for note in &plan.notes {
        println!("\n{} {}", "ℹ".blue(), note.dimmed());
    }

    if let Some(err) = &plan.error {
        println!("\n{} {}", "✗".red().bold(), err);
        println!(
            "  {} {} group{} committed; the remaining changes are still dirty in your working tree — nothing was lost.",
            "↳".dimmed(),
            plan.committed,
            if plan.committed == 1 { "" } else { "s" },
        );
        return 1;
    }

    if plan.mode == "execute" {
        println!(
            "\n{} Distilled {} commit{}; the working tree is clean.",
            "✓".green().bold(),
            plan.committed,
            if plan.committed == 1 { "" } else { "s" },
        );
    }
    0
}
