//! Pure unified-diff line index for anchoring PR review comments.
//!
//! GitHub rejects an inline review comment on any line that isn't part of the
//! pull request's diff, so before posting we must know exactly which lines are
//! commentable. This crate parses a unified diff (as produced by `git diff`,
//! `gh pr diff`, or the GitHub `application/vnd.github.diff` media type) into
//! the set of commentable new-side ("RIGHT") lines per file, and resolves a
//! finding's stated `(file, line)` against it — exact hit, a small snap, or
//! "not on a changed line" (the caller folds those into a summary).
//!
//! It is shared by the local path (`aura review post` in aura-cli) and the
//! cloud path (`/api/v2/pr/review` in aura-cloud) so both anchor identically.
//! Dependency-free and fully unit-tested.

use std::collections::BTreeMap;

/// How far from its stated line a finding may be snapped to the nearest
/// commentable line before we give up and leave it for the summary. Small on
/// purpose: a few lines covers an LLM's off-by-a-little or a signature line
/// just outside the diff's context window; anything larger would anchor the
/// comment somewhere misleading.
pub const SNAP_WINDOW: u32 = 5;

/// A finding successfully placed on real diff lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAnchor {
    /// The diff's own path for the file (new side), which is what GitHub wants.
    pub path: String,
    /// 1-based last line of the comment (single-line when `start_line` is None).
    pub line: u32,
    /// 1-based first line of a multi-line comment, when the whole span is in
    /// the diff and strictly above `line`.
    pub start_line: Option<u32>,
}

/// The set of lines in a PR diff that can carry an inline RIGHT-side comment:
/// added (`+`) and context (` `) lines, keyed by new-side file path →
/// ascending new-side line numbers.
#[derive(Debug, Default, Clone)]
pub struct DiffIndex {
    files: BTreeMap<String, Vec<u32>>,
}

impl DiffIndex {
    /// Parse a unified diff into the commentable-line index.
    pub fn parse(diff: &str) -> DiffIndex {
        let mut files: BTreeMap<String, Vec<u32>> = BTreeMap::new();
        let mut cur: Option<String> = None;
        let mut new_line: u32 = 0;
        let mut in_hunk = false;

        for line in diff.lines() {
            if line.starts_with("diff --git ") {
                cur = None;
                in_hunk = false;
                continue;
            }
            if let Some(rest) = line.strip_prefix("+++ ") {
                in_hunk = false;
                cur = parse_new_path(rest);
                continue;
            }
            if line.starts_with("--- ") {
                continue;
            }
            if line.starts_with("@@") {
                if let Some(start) = parse_hunk_new_start(line) {
                    new_line = start;
                    in_hunk = cur.is_some();
                } else {
                    in_hunk = false;
                }
                continue;
            }
            if !in_hunk {
                continue;
            }
            // Inside a hunk: classify by the leading marker. git always
            // prefixes content lines (' '/'+'/'-'), so anything else ends it.
            match line.as_bytes().first() {
                Some(b'+') | Some(b' ') => {
                    if let Some(f) = &cur {
                        files.entry(f.clone()).or_default().push(new_line);
                    }
                    new_line += 1;
                }
                Some(b'-') => { /* removed: LEFT side only, new_line unchanged */ }
                Some(b'\\') => { /* "\ No newline at end of file" */ }
                _ => in_hunk = false,
            }
        }
        DiffIndex { files }
    }

    /// Are there no commentable lines at all (empty / unparsable diff)?
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    /// Is `line` an added/context line of `file` (so an inline comment sticks)?
    pub fn has(&self, file: &str, line: u32) -> bool {
        self.files.get(file).is_some_and(|v| v.binary_search(&line).is_ok())
    }

    /// Nearest commentable line to `target` in `file`, within [`SNAP_WINDOW`].
    pub fn nearest_within(&self, file: &str, target: u32) -> Option<u32> {
        let v = self.files.get(file)?;
        v.iter()
            .copied()
            .filter(|l| l.abs_diff(target) <= SNAP_WINDOW)
            .min_by_key(|l| l.abs_diff(target))
    }

    /// Resolve a finding's file against the indexed paths: exact match first,
    /// then a unique path/basename suffix match (so `src/auth.rs` from an
    /// engine run finds `crate/src/auth.rs` in the PR diff, and vice-versa).
    /// Ambiguous suffix matches are refused rather than guessed.
    pub fn match_file(&self, file: &str) -> Option<&str> {
        if self.files.contains_key(file) {
            return self.files.get_key_value(file).map(|(k, _)| k.as_str());
        }
        let want = file.trim_start_matches("./");
        let mut hit: Option<&str> = None;
        for k in self.files.keys() {
            if path_suffix_match(k, want) {
                if hit.is_some() {
                    return None;
                }
                hit = Some(k.as_str());
            }
        }
        hit
    }

    /// Resolve a stated `(file, line, start_line)` anchor against the diff.
    /// Returns the line(s) to comment on, or `None` when the finding can't be
    /// placed on a changed line (no file match, no line, or too far from any
    /// commentable line) — the caller should summarise those instead.
    pub fn resolve(
        &self,
        file: &str,
        line: Option<u32>,
        start_line: Option<u32>,
    ) -> Option<ResolvedAnchor> {
        let path = self.match_file(file)?.to_string();
        let line = line?;
        let anchored = if self.has(&path, line) {
            line
        } else {
            self.nearest_within(&path, line)?
        };
        // Keep a multi-line range only when both ends are real diff lines and
        // the start is strictly above the end.
        let start = start_line.filter(|&s| s < anchored && self.has(&path, s));
        Some(ResolvedAnchor {
            path,
            line: anchored,
            start_line: start,
        })
    }

    /// Commentable new-side lines for `file` (mainly for tests/inspection).
    pub fn lines(&self, file: &str) -> Vec<u32> {
        self.files.get(file).cloned().unwrap_or_default()
    }

    /// Every file that has at least one commentable line.
    pub fn files(&self) -> impl Iterator<Item = &str> {
        self.files.keys().map(String::as_str)
    }
}

/// `+++ b/path` → `path`; `+++ /dev/null` (deleted file) → `None`.
fn parse_new_path(rest: &str) -> Option<String> {
    // Drop a trailing tab-delimited timestamp some diff tools append.
    let raw = rest.split('\t').next().unwrap_or(rest).trim();
    let raw = raw.trim_matches('"');
    if raw == "/dev/null" {
        return None;
    }
    let path = raw.strip_prefix("b/").unwrap_or(raw);
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// Parse `@@ -a,b +c,d @@ heading` → the new-side start line `c`.
fn parse_hunk_new_start(line: &str) -> Option<u32> {
    let plus = line.split_whitespace().find(|t| t.starts_with('+'))?;
    let nums = plus.trim_start_matches('+');
    let start = nums.split(',').next()?;
    start.parse().ok()
}

/// Does indexed path `key` and wanted path `want` name the same file by a
/// path-segment suffix? (`a/b/c.rs` matches `b/c.rs` and `c.rs`.)
fn path_suffix_match(key: &str, want: &str) -> bool {
    key == want
        || key.ends_with(&format!("/{want}"))
        || want.ends_with(&format!("/{key}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIFF: &str = "\
diff --git a/src/auth.rs b/src/auth.rs
index 1111111..2222222 100644
--- a/src/auth.rs
+++ b/src/auth.rs
@@ -10,6 +10,8 @@ fn login() {
 context a
-old removed
+added one
+added two
 context b
@@ -40,3 +50,4 @@ fn logout() {
 ctx
+late add
 ctx2
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 title
+new doc line
 end
";

    #[test]
    fn parse_indexes_added_and_context_new_side_lines() {
        let idx = DiffIndex::parse(DIFF);
        assert_eq!(idx.lines("src/auth.rs"), vec![10, 11, 12, 13, 50, 51, 52]);
        assert_eq!(idx.lines("README.md"), vec![1, 2, 3]);
    }

    #[test]
    fn deleted_file_side_is_skipped() {
        let d = "\
diff --git a/gone.rs b/gone.rs
--- a/gone.rs
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
";
        let idx = DiffIndex::parse(d);
        assert!(idx.lines("gone.rs").is_empty());
        assert!(idx.is_empty());
    }

    #[test]
    fn resolve_exact_line() {
        let idx = DiffIndex::parse(DIFF);
        assert_eq!(
            idx.resolve("src/auth.rs", Some(11), None),
            Some(ResolvedAnchor { path: "src/auth.rs".into(), line: 11, start_line: None })
        );
    }

    #[test]
    fn resolve_snaps_within_window() {
        let idx = DiffIndex::parse(DIFF);
        // 49 isn't in the diff, 50 is and is within SNAP_WINDOW.
        assert_eq!(
            idx.resolve("src/auth.rs", Some(49), None).unwrap().line,
            50
        );
    }

    #[test]
    fn resolve_far_line_is_none() {
        let idx = DiffIndex::parse(DIFF);
        assert_eq!(idx.resolve("src/auth.rs", Some(999), None), None);
    }

    #[test]
    fn resolve_unknown_file_is_none() {
        let idx = DiffIndex::parse(DIFF);
        assert_eq!(idx.resolve("src/other.rs", Some(11), None), None);
    }

    #[test]
    fn resolve_missing_line_is_none() {
        let idx = DiffIndex::parse(DIFF);
        assert_eq!(idx.resolve("src/auth.rs", None, None), None);
    }

    #[test]
    fn resolve_basename_suffix_match() {
        let idx = DiffIndex::parse(DIFF);
        let a = idx.resolve("crate/src/auth.rs", Some(12), None).unwrap();
        assert_eq!(a.path, "src/auth.rs");
        assert_eq!(a.line, 12);
    }

    #[test]
    fn resolve_keeps_valid_range_else_collapses() {
        let idx = DiffIndex::parse(DIFF);
        assert_eq!(
            idx.resolve("src/auth.rs", Some(13), Some(11)),
            Some(ResolvedAnchor { path: "src/auth.rs".into(), line: 13, start_line: Some(11) })
        );
        // start line 5 not in the diff → collapse to single-line.
        assert_eq!(
            idx.resolve("src/auth.rs", Some(13), Some(5)),
            Some(ResolvedAnchor { path: "src/auth.rs".into(), line: 13, start_line: None })
        );
    }

    #[test]
    fn ambiguous_suffix_refused() {
        let d = "\
diff --git a/x/util.rs b/x/util.rs
--- a/x/util.rs
+++ b/x/util.rs
@@ -1,1 +1,2 @@
 a
+b
diff --git a/y/util.rs b/y/util.rs
--- a/y/util.rs
+++ b/y/util.rs
@@ -1,1 +1,2 @@
 a
+b
";
        let idx = DiffIndex::parse(d);
        assert_eq!(idx.match_file("util.rs"), None); // two candidates → refuse
    }
}
