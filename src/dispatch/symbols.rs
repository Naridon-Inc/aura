//! What one commit did to the codebase's symbols, not to its lines.
//!
//! A dispatch is read by someone who was not there, so "changed 14 files" is
//! not an answer — `parse_target`, `blame_line` and `render` changed is. That
//! is the whole difference between a diff summary and a semantic one, and it
//! is the thing Aura can say that a file-level tool cannot.
//!
//! **Only the files the commit touched are parsed.** A whole-tree scan
//! ([`crate::verify_intent::scan::scan_tree`]) is right for the commit gate,
//! which needs the full picture once; it is wrong here, where a week of
//! commits would each pay for the entire repository. The diff already names
//! the handful of paths that can possibly have changed, so both sides of just
//! those are parsed.
//!
//! **Identifiers are compared across the whole commit, not per file.** A
//! function moved from one module to another is *moved*: it leaves one file
//! and arrives in another, and reporting that as a deletion plus an unrelated
//! addition is the single most misleading thing a summary like this can do.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use git2::{Commit, Oid, Repository};

use crate::parser::SemanticParser;
use crate::verify_intent::scan::{is_skippable_path, lang_ext, symbols_in};

/// How many source files of one commit are parsed before the rest are counted
/// but not read.
///
/// A commit touching hundreds of files is a vendor drop, a rename sweep or a
/// generated update — reading all of it would cost more than the answer is
/// worth, and the answer would be a wall of names nobody reads. The cap is
/// reported (`truncated`) rather than hidden, so a reader is never told a
/// partial list is the whole list.
const MAX_FILES: usize = 60;

/// What a commit did to the named things in the codebase.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Delta {
    pub added: Vec<String>,
    pub changed: Vec<String>,
    pub removed: Vec<String>,
    /// Source files the commit touched, in repo order.
    pub files: Vec<String>,
    /// Files past [`MAX_FILES`] that were counted but not parsed.
    pub truncated: usize,
    /// True for a merge, whose content belongs to the commits it merges.
    pub merge: bool,
}

impl Delta {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.changed.is_empty() && self.removed.is_empty()
    }

    pub fn total(&self) -> usize {
        self.added.len() + self.changed.len() + self.removed.len()
    }
}

/// Compare two symbol maps of the same commit's before and after.
///
/// Split out from the git plumbing so the rule — same name, different body, is
/// a change; a name only on one side is an addition or a removal — is testable
/// without a repository.
pub fn diff_symbols(
    before: &BTreeMap<String, (String, bool)>,
    after: &BTreeMap<String, (String, bool)>,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let (mut added, mut changed, mut removed) = (Vec::new(), Vec::new(), Vec::new());
    for (name, (hash, exported)) in after {
        match before.get(name) {
            None => added.push((name.clone(), *exported)),
            Some((old, _)) if old != hash => changed.push((name.clone(), *exported)),
            Some(_) => {}
        }
    }
    for (name, (_, exported)) in before {
        if !after.contains_key(name) {
            removed.push((name.clone(), *exported));
        }
    }
    (rank(added), rank(changed), rank(removed))
}

/// Public names first, then alphabetical.
///
/// A dispatch shows a handful of names and counts the rest, so which handful
/// decides whether the line reads as "the API moved" or as a list of test
/// helpers. What a caller outside the module can see is the part that matters
/// to someone who was not there.
fn rank(mut names: Vec<(String, bool)>) -> Vec<String> {
    names.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    names.into_iter().map(|(n, _)| n).collect()
}

/// Every source path this commit touched, capped.
fn touched_paths(repo: &Repository, commit: &Commit, parent: &Commit) -> (Vec<String>, usize) {
    let (Ok(a), Ok(b)) = (parent.tree(), commit.tree()) else {
        return (Vec::new(), 0);
    };
    let Ok(diff) = repo.diff_tree_to_tree(Some(&a), Some(&b), None) else {
        return (Vec::new(), 0);
    };
    let mut paths: BTreeSet<String> = BTreeSet::new();
    for d in diff.deltas() {
        for f in [d.old_file(), d.new_file()] {
            if let Some(p) = f.path().and_then(|p| p.to_str()) {
                if !is_skippable_path(p) && !lang_ext(p).is_empty() {
                    paths.insert(p.to_string());
                }
            }
        }
    }
    let total = paths.len();
    let kept: Vec<String> = paths.into_iter().take(MAX_FILES).collect();
    (kept, total.saturating_sub(MAX_FILES))
}

/// Parse one path out of one tree into `identifier -> (hash, exported)`.
///
/// Results are cached on the blob's object id. A linear history hands the same
/// blob to two neighbouring commits — the child side of one is the parent side
/// of the next — so the cache halves the parsing over a window, and a file
/// that sat unchanged through a whole week is parsed once.
fn symbols_at(
    repo: &Repository,
    cache: &mut Cache,
    commit: &Commit,
    path: &str,
    out: &mut BTreeMap<String, (String, bool)>,
) {
    let Ok(tree) = commit.tree() else { return };
    // A path absent from this side of the diff is a creation or a deletion,
    // not a failure — it simply contributes nothing to that side's map.
    let Ok(entry) = tree.get_path(std::path::Path::new(path)) else { return };
    let oid = entry.id();
    if let Some(hit) = cache.blobs.get(&oid) {
        out.extend(hit.iter().map(|(k, v)| (k.clone(), v.clone())));
        return;
    }
    let mut parsed: BTreeMap<String, (String, bool)> = BTreeMap::new();
    if let Ok(blob) = repo.find_blob(oid) {
        if let Ok(source) = std::str::from_utf8(blob.content()) {
            let mut facts = BTreeMap::new();
            symbols_in(&mut cache.parser, path, source, &mut facts);
            for (name, f) in facts {
                parsed.insert(name, (f.content_hash, f.exported));
            }
        }
    }
    out.extend(parsed.iter().map(|(k, v)| (k.clone(), v.clone())));
    cache.blobs.insert(oid, parsed);
}

/// One parser and one blob cache, held across every commit in a window.
///
/// Building a tree-sitter parser is not free, and a dispatch builds one per
/// commit if you let it. Both costs are paid once here.
pub struct Cache {
    parser: SemanticParser,
    blobs: HashMap<Oid, BTreeMap<String, (String, bool)>>,
}

impl Cache {
    pub fn new() -> Option<Self> {
        Some(Cache { parser: SemanticParser::new().ok()?, blobs: HashMap::new() })
    }
}

/// What this commit did, semantically.
///
/// A merge returns an empty delta with `merge: true`: its diff against its
/// first parent is the whole merged branch, which is every one of those
/// commits' work attributed to whoever pressed merge.
pub fn delta_for(repo: &Repository, cache: &mut Cache, commit: &Commit) -> Delta {
    if commit.parent_count() != 1 {
        return Delta { merge: commit.parent_count() > 1, ..Default::default() };
    }
    let Ok(parent) = commit.parent(0) else { return Delta::default() };
    let (files, truncated) = touched_paths(repo, commit, &parent);
    if files.is_empty() {
        return Delta { truncated, ..Default::default() };
    }

    let (mut before, mut after) = (BTreeMap::new(), BTreeMap::new());
    for path in &files {
        symbols_at(repo, cache, &parent, path, &mut before);
        symbols_at(repo, cache, commit, path, &mut after);
    }
    let (added, changed, removed) = diff_symbols(&before, &after);
    Delta { added, changed, removed, files, truncated, merge: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, (String, bool)> {
        pairs.iter().map(|(k, v)| (k.to_string(), (v.to_string(), false))).collect()
    }

    fn public(pairs: &[(&str, &str)]) -> BTreeMap<String, (String, bool)> {
        pairs.iter().map(|(k, v)| (k.to_string(), (v.to_string(), true))).collect()
    }

    #[test]
    fn a_same_named_symbol_with_a_new_body_reads_as_changed() {
        let before = map(&[("parse", "h1"), ("render", "h2")]);
        let after = map(&[("parse", "h9"), ("render", "h2")]);
        let (added, changed, removed) = diff_symbols(&before, &after);
        assert!(added.is_empty());
        assert_eq!(changed, vec!["parse"]);
        assert!(removed.is_empty(), "an untouched symbol is not news");
    }

    #[test]
    fn a_symbol_moved_between_files_is_not_a_deletion() {
        // Both sides are built across every file the commit touched, so a
        // function that left one module and arrived in another is present on
        // both sides under the same name — which is the truth. Reporting it as
        // a removal is how a summary scares someone for no reason.
        let before = map(&[("dial", "h1")]);
        let after = map(&[("dial", "h1")]);
        let (added, changed, removed) = diff_symbols(&before, &after);
        assert!(added.is_empty() && changed.is_empty() && removed.is_empty());
    }

    #[test]
    fn a_new_name_is_added_and_a_vanished_one_is_removed() {
        let before = map(&[("old", "h1")]);
        let after = map(&[("new", "h2")]);
        let (added, changed, removed) = diff_symbols(&before, &after);
        assert_eq!(added, vec!["new"]);
        assert_eq!(removed, vec!["old"]);
        assert!(changed.is_empty());
    }

    #[test]
    fn the_public_names_are_listed_before_the_private_ones() {
        // Only a handful of names survive into the document, so the ones a
        // reader outside the module could possibly care about go first.
        let before = BTreeMap::new();
        let mut after = map(&[("helper", "h"), ("also_helper", "h")]);
        after.extend(public(&[("dial", "h"), ("connect", "h")]));
        let (added, _, _) = diff_symbols(&before, &after);
        assert_eq!(added, vec!["connect", "dial", "also_helper", "helper"]);
    }

    #[test]
    fn an_empty_delta_knows_it_is_empty() {
        let d = Delta::default();
        assert!(d.is_empty());
        assert_eq!(d.total(), 0);
        let d = Delta { added: vec!["a".into()], ..Default::default() };
        assert!(!d.is_empty());
        assert_eq!(d.total(), 1);
    }
}
