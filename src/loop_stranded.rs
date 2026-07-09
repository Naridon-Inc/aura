//! #1 — gitignore-output guard for the autonomous loop.
//!
//! A coding agent dispatched by the loop commits its work, but `git commit`
//! only captures *tracked* files. If the agent writes a real source file into a
//! gitignored path — e.g. a whole gitignored subproject like `aura-cloud/` — or
//! simply forgets to `git add` a new file, that file never enters the commit. A
//! naive runner would still mark the node "completed" with a commit that's
//! missing its core files (the remaining code references a module that isn't
//! there = silently broken). Under `--jobs` worktree mode it's worse: discarding
//! the worktree deletes the stranded file with no git trace at all.
//!
//! This guard runs right after the agent finishes. It compares the working tree
//! against a [`baseline`] captured *before* the agent ran — so it credits the
//! agent only with paths it actually touched, never pre-existing dirt from a
//! shared tree — takes a durable recovery snapshot of any *source* file the
//! commit left behind (written to the MAIN repo so it survives a worktree
//! teardown), and reports a [`Verdict::Stranded`] when source landed where git
//! can't carry it. The runner then refuses to claim a clean success.

use std::collections::HashSet;
use std::path::Path;
use std::process::Command;

use crate::checkpoint::SnapshotStore;

/// The guard's decision for one finished node.
pub enum Verdict {
    /// Nothing concerning — the commit captured the agent's work.
    Clean,
    /// Source the agent wrote was left out of the commit; recovery snapshots
    /// have already been written. `reason` is plain-language for the run log.
    Stranded { reason: String },
}

/// Directories whose ignored contents are build / dependency artifacts, not
/// lost source — writes here are expected and benign, so they never strand a
/// node. Matched as a path prefix or `/`-bounded segment.
const ARTIFACT_DIRS: &[&str] = &[
    "target/",
    "node_modules/",
    "dist/",
    "build/",
    ".next/",
    "out/",
    ".venv/",
    "venv/",
    "__pycache__/",
    ".pytest_cache/",
    "coverage/",
    ".turbo/",
    ".cache/",
    ".gradle/",
    "vendor/",
    ".aura/",
    ".git/",
    ".entire/",
];

/// Extensions we treat as *source* worth recovering. A stray binary, lockfile,
/// or log in an ignored path isn't lost work; a `.rs`/`.ts`/`.sql`/… file is.
const SOURCE_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "rb", "php", "cs",
    "swift", "c", "cc", "cpp", "h", "hpp", "sql", "graphql", "proto", "toml", "yaml", "yml",
    "json", "md", "sh", "css", "scss", "html", "vue", "svelte", "ex", "exs", "scala", "clj",
    "lua", "r", "dart",
];

/// Capture the set of paths already dirty or ignored in `work_dir`, so the
/// guard can subtract them and flag only the agent's own additions. Empty when
/// `work_dir` isn't a usable git repo — the guard then treats every concerning
/// path as the agent's (a fresh worktree starts clean anyway).
pub fn baseline(work_dir: &Path) -> HashSet<String> {
    let mut set = HashSet::new();
    for p in ignored_files(work_dir) {
        set.insert(p);
    }
    for p in untracked_files(work_dir) {
        set.insert(p);
    }
    for p in modified_tracked(work_dir) {
        set.insert(p);
    }
    set
}

/// Run the guard in `work_dir` (the agent's working tree — the repo itself in
/// sequential mode, or a throwaway worktree under `--jobs`). `repo_root` is the
/// MAIN repo, where recovery snapshots are written so they outlive a worktree.
/// `before` is the [`baseline`] taken prior to the agent running.
pub fn guard(repo_root: impl AsRef<Path>, work_dir: &Path, before: &HashSet<String>) -> Verdict {
    let repo_root = repo_root.as_ref();

    let ignored = ignored_files(work_dir);
    let untracked = untracked_files(work_dir);
    let modified = modified_tracked(work_dir);

    let stranded = evaluate(before, &ignored, &untracked, &modified);
    if stranded.is_empty() {
        return Verdict::Clean;
    }

    // Recover each stranded source file to the main repo before anything (a
    // worktree discard, a later clean) can delete it. Best-effort: a file we
    // can't read as text (binary) just isn't snapshotted — it's still reported.
    for path in &stranded {
        let _ = SnapshotStore::snapshot_external(
            repo_root,
            &work_dir.join(path),
            path,
            "loop_stranded_output",
            "aura-loop",
        );
    }

    Verdict::Stranded {
        reason: strand_reason(&stranded),
    }
}

/// Fold any source the agent *wrote but forgot to stage* into its commit,
/// BEFORE [`guard`] runs. The common failure is an agent that edits/creates
/// real files then runs `git commit` (no `git add`) or `git commit -am` (misses
/// new files): the work is sound, git can carry it, the agent just left it
/// unstaged. Staging + committing it here turns a would-be strand into a clean
/// success.
///
/// Only *non-ignored* source is rescued — a file under a `.gitignore` rule is
/// left untouched so [`guard`] still flags it (the ignore is intentional and we
/// won't force it into history). `before` is the pre-agent [`baseline`], so
/// pre-existing dirt in a shared tree is never swept in. Returns the paths it
/// committed (empty when there was nothing to rescue, or staging/committing
/// failed — in which case the guard flags them honestly as before).
pub fn rescue_uncommitted_source(work_dir: &Path, before: &HashSet<String>) -> Vec<String> {
    let mut rescue: Vec<String> = Vec::new();
    for p in untracked_files(work_dir)
        .into_iter()
        .chain(modified_tracked(work_dir))
    {
        if before.contains(&p) || is_artifact(&p) || !is_source(&p) {
            continue;
        }
        rescue.push(p);
    }
    rescue.sort();
    rescue.dedup();
    if rescue.is_empty() {
        return rescue;
    }

    // Stage exactly those paths — never `git add -A`, which would also sweep in
    // pre-existing dirt the agent never touched.
    let mut add: Vec<&str> = vec!["add", "--"];
    add.extend(rescue.iter().map(String::as_str));
    if !git_ok(work_dir, &add) {
        return Vec::new();
    }

    // A fresh follow-up commit (not `--amend`) — safe whether or not the agent
    // committed this run, and it picks up cleanly when the runner re-reads HEAD.
    // Bypass hooks/signing: this is a mechanical carry, not an authored change.
    let msg = format!(
        "chore(aura-loop): carry {} file(s) the agent left unstaged",
        rescue.len()
    );
    let committed = git_ok(
        work_dir,
        &[
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--no-verify",
            "-m",
            &msg,
        ],
    );
    if !committed {
        return Vec::new();
    }
    rescue
}

/// PURE core — no I/O. Given the pre-agent baseline and the post-agent file
/// sets, return the sorted, de-duplicated list of *source* paths the commit
/// stranded: ignored-non-artifact source, plus untracked / still-modified
/// source the agent added but didn't commit. Pre-existing paths are excluded.
fn evaluate(
    before: &HashSet<String>,
    ignored: &[String],
    untracked: &[String],
    modified: &[String],
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    for p in ignored {
        if before.contains(p) || is_artifact(p) || !is_source(p) {
            continue;
        }
        out.push(p.clone());
    }
    for p in untracked.iter().chain(modified.iter()) {
        if before.contains(p) || is_artifact(p) || !is_source(p) {
            continue;
        }
        out.push(p.clone());
    }

    out.sort();
    out.dedup();
    out
}

/// Plain-language reason naming the stranded files (first few + a count).
fn strand_reason(stranded: &[String]) -> String {
    let shown: Vec<&str> = stranded.iter().take(3).map(String::as_str).collect();
    let more = stranded.len().saturating_sub(shown.len());
    let list = if more > 0 {
        format!("{} (+{more} more)", shown.join(", "))
    } else {
        shown.join(", ")
    };
    format!(
        "the agent wrote {} source file(s) git can't carry in the commit ({}); \
         they were saved as recovery snapshots but left out of the commit — review before merging",
        stranded.len(),
        list
    )
}

/// True when `path` lives under a known build/dependency artifact directory.
fn is_artifact(path: &str) -> bool {
    let norm = path.replace('\\', "/");
    ARTIFACT_DIRS
        .iter()
        .any(|d| norm.starts_with(d) || norm.contains(&format!("/{d}")))
}

/// True when `path` has a source-code extension worth recovering.
fn is_source(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext {
        Some(e) => SOURCE_EXTS.contains(&e.as_str()),
        None => false,
    }
}

// ── git plumbing ────────────────────────────────────────────────────────────

/// Ignored files, enumerated individually (so an ignored *directory* expands to
/// its files rather than a single dir entry). `--exclude-standard` honors the
/// repo's ignore rules.
fn ignored_files(work_dir: &Path) -> Vec<String> {
    git_lines(work_dir, &["ls-files", "-o", "-i", "--exclude-standard"])
}

/// Untracked, non-ignored files the agent created but didn't commit.
fn untracked_files(work_dir: &Path) -> Vec<String> {
    git_lines(work_dir, &["ls-files", "-o", "--exclude-standard"])
}

/// Tracked files that differ from HEAD (staged or unstaged) — work the agent
/// changed but left out of the commit.
fn modified_tracked(work_dir: &Path) -> Vec<String> {
    git_lines(work_dir, &["diff", "--name-only", "HEAD"])
}

/// Run a git command in `work_dir` for its exit status alone. Returns `true`
/// when git exited 0. Used by [`rescue_uncommitted_source`] to stage + commit.
fn git_ok(work_dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .args(args)
        .current_dir(work_dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run a git command in `work_dir` and return its stdout as trimmed, non-empty
/// lines. Any failure (not a repo, no HEAD) yields an empty list — the guard
/// then simply finds nothing to strand.
fn git_lines(work_dir: &Path, args: &[&str]) -> Vec<String> {
    let out = match Command::new("git").args(args).current_dir(work_dir).output() {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

// ── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn set(paths: &[&str]) -> HashSet<String> {
        paths.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn artifact_dirs_are_benign() {
        assert!(is_artifact("target/debug/aura"));
        assert!(is_artifact("node_modules/react/index.js"));
        assert!(is_artifact("aura-shell/node_modules/x/y.ts"));
        assert!(is_artifact(".aura/snapshots/foo.json"));
        assert!(!is_artifact("aura-cloud/src/push.rs"));
        assert!(!is_artifact("src/main.rs"));
    }

    #[test]
    fn source_extensions_classified() {
        assert!(is_source("aura-cloud/push.rs"));
        assert!(is_source("migrations/001.sql"));
        assert!(is_source("api/handler.ts"));
        assert!(!is_source("README")); // no extension
        assert!(!is_source("target/app")); // binary, no source ext
        assert!(!is_source("data.bin"));
    }

    #[test]
    fn strands_ignored_source_outside_artifacts() {
        // The peer's exact case: a real source file written into a gitignored
        // subproject, never committed.
        let stranded = evaluate(
            &set(&[]),
            &["aura-cloud/src/push.rs".into(), "target/debug/x".into()],
            &[],
            &[],
        );
        assert_eq!(stranded, vec!["aura-cloud/src/push.rs".to_string()]);
    }

    #[test]
    fn ignores_pre_existing_dirt() {
        // A file already dirty/ignored before the agent ran is not the agent's
        // doing — never strand on it (matters in shared sequential mode, #2).
        let before = set(&["aura-cloud/src/push.rs"]);
        let stranded = evaluate(&before, &["aura-cloud/src/push.rs".into()], &[], &[]);
        assert!(stranded.is_empty());
    }

    #[test]
    fn strands_uncommitted_new_and_modified_source() {
        let stranded = evaluate(
            &set(&[]),
            &[],
            &["src/forgot_to_add.rs".into(), "notes.bin".into()],
            &["src/edited_not_committed.ts".into()],
        );
        assert_eq!(
            stranded,
            vec![
                "src/edited_not_committed.ts".to_string(),
                "src/forgot_to_add.rs".to_string(),
            ]
        );
    }

    #[test]
    fn clean_when_only_artifacts_and_binaries() {
        let stranded = evaluate(
            &set(&[]),
            &["target/debug/aura".into(), "node_modules/x/index.js".into()],
            &["scratch.bin".into()],
            &[],
        );
        assert!(stranded.is_empty());
    }

    #[test]
    fn dedups_paths_seen_in_multiple_sets() {
        let stranded = evaluate(
            &set(&[]),
            &["a.rs".into()],
            &["a.rs".into()],
            &["a.rs".into()],
        );
        assert_eq!(stranded, vec!["a.rs".to_string()]);
    }

    #[test]
    fn reason_lists_first_files_and_overflow_count() {
        let r = strand_reason(&[
            "a.rs".into(),
            "b.rs".into(),
            "c.rs".into(),
            "d.rs".into(),
        ]);
        assert!(r.contains("4 source file(s)"));
        assert!(r.contains("a.rs, b.rs, c.rs"));
        assert!(r.contains("+1 more"));
    }
}
