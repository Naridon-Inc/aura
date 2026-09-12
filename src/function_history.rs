//! The function-level record a rewind can actually be restored from.
//!
//! Aura's pitch for rewind is that it is *surgical*: one function goes back to
//! the last state Aura recorded, and nothing around it moves. Until now both
//! rewind surfaces recovered from two **file**-level sources — the durable
//! snapshots in `.aura/snapshots/`, and git blobs — and neither is a record of
//! a function. A snapshot exists only if something took one before the edit;
//! a git blob exists only if the work was committed. Between those two, the
//! most common shape of damage — an agent rewrites a function in a file that
//! was never snapshotted and has uncommitted work in it — has nothing behind
//! it at all.
//!
//! Aura already computes exactly the missing artefact. Every intent log and
//! every `sync push` extracts the changed function bodies and hands them to
//! [`crate::live_sync::push_function_bodies`], which ships them to the
//! mothership and keeps **nothing**. So the recovery material was being
//! produced on every commit, sent off the box, and thrown away locally. Worse,
//! that path is privacy-gated (`aura radar privacy diffs`), so on the default
//! policy the bodies were computed and then dropped on the floor.
//!
//! This module is the local half. It writes the same bodies to
//! `.aura/function_history/`, under the repo, before any gate — recording a
//! body next to the file it came from sends nothing anywhere, so no privacy
//! level has an opinion about it. A rewind then has a per-function history to
//! read even when there is no snapshot and no commit.
//!
//! ## Shape
//!
//! One append-only JSONL log per source file, named the way
//! `.aura/snapshots/` names its files so the two are legible side by side. A
//! line is one recorded body. Newest is last on disk and first out of
//! [`FunctionHistory::entries_for`].
//!
//! Two properties keep it small and honest:
//!
//!  * **A body is recorded once.** Re-recording a function whose newest entry
//!    already carries the same `content_hash` is a no-op, so the twenty pushes
//!    that follow one edit leave one line, not twenty.
//!  * **The log is bounded per file.** Past [`FunctionHistory::MAX_PER_FILE`]
//!    entries the oldest are dropped. The bound is per file rather than per
//!    function on purpose: a file with forty functions keeps a shallower
//!    history of each, which is the right trade when the alternative is an
//!    unbounded log in the repo.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// One recorded state of one function.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Entry {
    pub file_path: String,
    pub function_name: String,
    #[serde(default)]
    pub function_kind: String,
    pub content_hash: String,
    pub body: String,
    /// Milliseconds since the epoch, matching `FileSnapshot::timestamp` so a
    /// rewind can order the two records against each other.
    pub recorded_at: u64,
    /// Who was at the keyboard — an agent id, or a git user. Free text; it is
    /// shown back to a person choosing between candidate versions.
    #[serde(default)]
    pub recorded_by: String,
}

/// The per-repo log directory.
pub struct FunctionHistory {
    dir: PathBuf,
}

impl Default for FunctionHistory {
    fn default() -> Self {
        Self::open()
    }
}

impl FunctionHistory {
    /// Where the logs live, relative to the repo root — the same relative
    /// convention `.aura/snapshots/` uses, so both follow the process's
    /// working directory into a worktree without being told which one.
    pub const DIR: &'static str = ".aura/function_history";

    /// How many recorded bodies one source file keeps.
    ///
    /// Fifty is what a file-level snapshot keeps; a function log is far
    /// cheaper per entry (one body, not one file) and is the only record
    /// behind an uncommitted, un-snapshotted rewind, so it keeps more.
    pub const MAX_PER_FILE: usize = 200;

    /// The log directory under the current repo.
    pub fn open() -> Self {
        Self::at(Self::DIR)
    }

    /// A log directory somewhere else. Tests use it; so would a caller that
    /// has a repo root in hand rather than a working directory.
    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The log file for one source path.
    ///
    /// Separators become `__` exactly as in `.aura/snapshots/`, so the two
    /// directories name the same file the same way.
    ///
    /// Two callers can spell one file two ways: the hook records the path git
    /// handed it (`src/lib.rs`), while an agent may hand over an absolute one.
    /// Both have to land in the same log or a rewind will not find what the
    /// edit recorded, so a path is reduced to repo-relative first whenever it
    /// can be, and used as given when it cannot.
    fn log_path(&self, file_path: &str) -> PathBuf {
        let key = self.repo_relative(file_path);
        let safe = key.replace('/', "__").replace('\\', "__");
        self.dir.join(format!("{safe}.jsonl"))
    }

    /// The repo this log belongs to: the log directory is `<repo>/.aura/
    /// function_history`, so the root is two levels up. Resolved against the
    /// working directory when the store was opened with a relative path, which
    /// is the normal case.
    fn repo_root(&self) -> Option<PathBuf> {
        let dir = if self.dir.is_absolute() {
            self.dir.clone()
        } else {
            std::env::current_dir().ok()?.join(&self.dir)
        };
        let root = dir.parent()?.parent()?.to_path_buf();
        Some(root.canonicalize().unwrap_or(root))
    }

    /// A relative path is already the key: it is spelled from the repo root,
    /// which is where every surface that takes one runs. Only an absolute path
    /// has to be reduced, and it is reduced against the root rather than
    /// against the working directory, so the key a caller gets does not depend
    /// on where in the tree that caller happened to be standing.
    fn repo_relative(&self, file_path: &str) -> String {
        let given = Path::new(file_path);
        if given.is_relative() {
            return file_path.to_string();
        }
        let canonical = given.canonicalize().unwrap_or_else(|_| given.to_path_buf());
        self.repo_root()
            .and_then(|root| canonical.strip_prefix(&root).ok().map(Path::to_path_buf))
            .map(|rel| rel.to_string_lossy().into_owned())
            .unwrap_or_else(|| file_path.to_string())
    }

    /// Every recorded body for one source file, newest first.
    ///
    /// A torn or half-written line is skipped rather than failing the read: a
    /// log that lost its last line to a crash is still worth every line
    /// before it, and a rewind that refuses to look because of one bad line
    /// is worse than one that recovers from the rest.
    pub fn entries_for(&self, file_path: &str) -> Vec<Entry> {
        let Ok(text) = fs::read_to_string(self.log_path(file_path)) else {
            return Vec::new();
        };
        let mut out: Vec<Entry> = text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str::<Entry>(l).ok())
            .collect();
        out.reverse();
        out
    }

    /// Every recorded body of one function, in whichever files hold it,
    /// newest first.
    ///
    /// A rewind always knows which file it is putting a function back into,
    /// so it asks per file. A trace is asked about a name and nothing else,
    /// and the answer is spread across one log per file — including files the
    /// symbol has since moved out of, which is exactly the part of its history
    /// a person is asking after.
    pub fn entries_for_symbol(&self, function_name: &str) -> Vec<Entry> {
        let Ok(dir) = fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut out: Vec<Entry> = Vec::new();
        for entry in dir.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            out.extend(
                text.lines()
                    .filter(|l| !l.trim().is_empty())
                    .filter_map(|l| serde_json::from_str::<Entry>(l).ok())
                    .filter(|e: &Entry| e.function_name == function_name),
            );
        }
        out.sort_by(|a, b| b.recorded_at.cmp(&a.recorded_at));
        out
    }

    /// The recorded states of one function that are not what is there now,
    /// newest first — the candidates a rewind should try, in the order it
    /// should try them.
    ///
    /// `current_body` is `None` when the function is **gone** from the file.
    /// Then every recorded state is a candidate, because anything at all is a
    /// recovery.
    pub fn differing(
        &self,
        file_path: &str,
        function_name: &str,
        current_body: Option<&str>,
    ) -> Vec<Entry> {
        let current = current_body.map(str::trim);
        let mut seen_hashes: Vec<String> = Vec::new();
        self.entries_for(file_path)
            .into_iter()
            .filter(|e| e.function_name == function_name)
            .filter(|e| current != Some(e.body.trim()))
            // The same body recorded twice is one candidate: trying it a
            // second time can only fail the same way.
            .filter(|e| {
                if seen_hashes.iter().any(|h| h == &e.content_hash) {
                    false
                } else {
                    seen_hashes.push(e.content_hash.clone());
                    true
                }
            })
            .collect()
    }

    /// Record bodies, skipping any whose function is already recorded at that
    /// content hash. Returns how many lines were actually written.
    ///
    /// Never fails outward. This runs inside the push path on the way to the
    /// network, and a repo whose `.aura` is read-only must still be able to
    /// push — losing the local record is a smaller harm than refusing the
    /// operation the user asked for.
    pub fn record(&self, entries: &[Entry]) -> usize {
        let mut written = 0;
        // Group by file so one source file is read, appended and pruned once
        // even when a push carries forty of its functions.
        let mut by_file: std::collections::BTreeMap<&str, Vec<&Entry>> = Default::default();
        for e in entries {
            by_file.entry(e.file_path.as_str()).or_default().push(e);
        }
        for (file_path, group) in by_file {
            written += self.record_one_file(file_path, &group);
        }
        written
    }

    fn record_one_file(&self, file_path: &str, group: &[&Entry]) -> usize {
        if fs::create_dir_all(&self.dir).is_err() {
            return 0;
        }
        let existing = self.entries_for(file_path);
        let newest_hash = |name: &str| -> Option<String> {
            existing
                .iter()
                .find(|e| e.function_name == name)
                .map(|e| e.content_hash.clone())
        };

        let mut lines = String::new();
        let mut written = 0;
        let mut just_written: Vec<(String, String)> = Vec::new();
        for e in group {
            let already = newest_hash(&e.function_name);
            let in_batch = just_written
                .iter()
                .find(|(n, _)| n == &e.function_name)
                .map(|(_, h)| h.clone());
            if in_batch.as_deref().or(already.as_deref()) == Some(e.content_hash.as_str()) {
                continue;
            }
            let Ok(line) = serde_json::to_string(e) else { continue };
            lines.push_str(&line);
            lines.push('\n');
            just_written.push((e.function_name.clone(), e.content_hash.clone()));
            written += 1;
        }
        if written == 0 {
            return 0;
        }

        let path = self.log_path(file_path);
        let appended = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut f| f.write_all(lines.as_bytes()));
        if appended.is_err() {
            return 0;
        }

        self.prune(&path);
        written
    }

    /// Drop the oldest lines once a log is past its bound.
    ///
    /// Rewritten via tmp + rename so a crash mid-prune leaves the whole old
    /// log rather than a truncated one — the same rule the rewind write
    /// itself follows, and for the same reason: this file is somebody's only
    /// copy of code that was never committed.
    fn prune(&self, path: &Path) {
        let Ok(text) = fs::read_to_string(path) else { return };
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        if lines.len() <= Self::MAX_PER_FILE {
            return;
        }
        let keep = &lines[lines.len() - Self::MAX_PER_FILE..];
        let mut body = keep.join("\n");
        body.push('\n');

        let tmp = path.with_extension("jsonl.tmp");
        if fs::write(&tmp, body).is_ok() && fs::rename(&tmp, path).is_err() {
            let _ = fs::remove_file(&tmp);
        }
    }
}

/// Record the current state of every function in `files`.
///
/// This is the path for callers that hold *file paths* rather than sync
/// payloads — chiefly `aura log-intent`, the command Aura's own protocol tells
/// every agent to run before every commit. Unlike `aura save` and `aura share`
/// it never went near [`crate::live_sync`], so it extracted no bodies and
/// recorded nothing. An agent that followed the documented shell workflow to
/// the letter therefore left no function history behind it at all, and a later
/// rewind had nothing of Aura's own to read.
///
/// Every step is best-effort and per file: a path that no longer exists,
/// cannot be read, has no extension, or does not parse contributes nothing and
/// never fails the caller. Returns how many new states were written.
pub fn record_files(history: &FunctionHistory, files: &[String]) -> usize {
    let Ok(mut parser) = crate::parser::SemanticParser::new() else {
        return 0;
    };
    let by = crate::live_events::git_user();
    let at = now_ms();
    let mut entries: Vec<Entry> = Vec::new();

    for file_path in files {
        let path = Path::new(file_path);
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext.is_empty() {
            continue;
        }
        let Ok(source) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(nodes) = parser.parse_file(&source, ext) else {
            continue;
        };
        for node in &nodes {
            let Some(identifier) = node.identifier.as_ref() else {
                continue;
            };
            let Some(body) = crate::live_sync::extract_function_body(&source, identifier) else {
                continue;
            };
            if body.trim().is_empty() {
                continue;
            }
            entries.push(Entry {
                file_path: file_path.clone(),
                function_name: identifier.clone(),
                function_kind: node.kind.clone(),
                content_hash: node.content_hash.clone(),
                body,
                recorded_at: at,
                recorded_by: by.clone(),
            });
        }
    }

    history.record(&entries)
}

/// How many files a fall-back sweep will parse when the caller named none.
pub const FALLBACK_MAX_FILES: usize = 64;

/// Record the functions one intent is about.
///
/// `named` is what the caller stated it touched (`--file`, `--writes`); that is
/// the precise set and it is always the set used. A caller that names nothing —
/// a person typing `aura log-intent "..."` by hand — falls back to the files
/// git already sees as dirty, bounded by [`FALLBACK_MAX_FILES`] so that a hook
/// firing in the middle of a thousand-file rebase cannot turn a fire-and-forget
/// capture into a repo-wide parse.
pub fn record_for_intent(history: &FunctionHistory, repo_root: &Path, named: &[String]) -> usize {
    if named.is_empty() {
        return record_files(history, &dirty_files(repo_root));
    }
    // A named path is spelled however the caller spelled it. One that does not
    // resolve from here is tried again against the repo root, so a hook that
    // reports `src/lib.rs` while sitting in a subdirectory still records.
    let files: Vec<String> = named
        .iter()
        .map(|path| {
            if Path::new(path).exists() {
                path.clone()
            } else {
                repo_root.join(path).to_string_lossy().into_owned()
            }
        })
        .collect();
    record_files(history, &files)
}

/// The files git sees as changed against HEAD, as absolute paths.
///
/// Staged-and-then-untouched work counts: the diff is HEAD to working tree
/// *with* the index, the same pairing `aura share` settled on after
/// `diff_index_to_workdir` alone answered "nothing changed" for a fully staged
/// commit.
fn dirty_files(repo_root: &Path) -> Vec<String> {
    let Ok(repo) = git2::Repository::open(repo_root) else {
        return Vec::new();
    };
    let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let Ok(diff) = repo
        .diff_tree_to_workdir_with_index(head.as_ref(), None)
        .or_else(|_| repo.diff_index_to_workdir(None, None))
    else {
        return Vec::new();
    };

    let mut files: Vec<String> = Vec::new();
    diff.foreach(
        &mut |delta, _| {
            if files.len() >= FALLBACK_MAX_FILES {
                return false;
            }
            if let Some(path) = delta.new_file().path() {
                files.push(repo_root.join(path).to_string_lossy().into_owned());
            }
            true
        },
        None,
        None,
        None,
    )
    .ok();
    files
}

/// Now, in milliseconds since the epoch — the stamp every entry carries.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    fn entry(name: &str, hash: &str, body: &str, at: u64) -> Entry {
        Entry {
            file_path: "src/auth.rs".into(),
            function_name: name.into(),
            function_kind: "function".into(),
            content_hash: hash.into(),
            body: body.into(),
            recorded_at: at,
            recorded_by: "claude".into(),
        }
    }

    #[test]
    fn a_body_recorded_once_can_be_read_back() {
        let d = dir();
        let h = FunctionHistory::at(d.path());
        assert_eq!(h.record(&[entry("verify", "h1", "fn verify() { old() }", 1)]), 1);

        let back = h.entries_for("src/auth.rs");
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].function_name, "verify");
        assert_eq!(back[0].body, "fn verify() { old() }");
    }

    #[test]
    fn the_same_body_pushed_again_does_not_grow_the_log() {
        let d = dir();
        let h = FunctionHistory::at(d.path());
        let e = entry("verify", "h1", "fn verify() {}", 1);
        assert_eq!(h.record(std::slice::from_ref(&e)), 1);
        assert_eq!(h.record(std::slice::from_ref(&e)), 0, "a re-push is not a new state");
        assert_eq!(h.record(&[e.clone(), e.clone()]), 0, "nor is the same body twice in one batch");
        assert_eq!(h.entries_for("src/auth.rs").len(), 1);
    }

    #[test]
    fn a_changed_body_is_a_new_state() {
        let d = dir();
        let h = FunctionHistory::at(d.path());
        h.record(&[entry("verify", "h1", "fn verify() { a() }", 1)]);
        h.record(&[entry("verify", "h2", "fn verify() { b() }", 2)]);

        let back = h.entries_for("src/auth.rs");
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].content_hash, "h2", "newest comes back first");
        assert_eq!(back[1].content_hash, "h1");
    }

    #[test]
    fn the_last_state_that_is_not_the_one_on_disk_comes_first() {
        let d = dir();
        let h = FunctionHistory::at(d.path());
        h.record(&[entry("verify", "h1", "fn verify() { a() }", 1)]);
        h.record(&[entry("verify", "h2", "fn verify() { b() }", 2)]);
        h.record(&[entry("verify", "h3", "fn verify() { c() }", 3)]);

        let candidates = h.differing("src/auth.rs", "verify", Some("fn verify() { c() }"));
        assert_eq!(candidates.len(), 2, "the state already on disk is not a recovery");
        assert_eq!(candidates[0].content_hash, "h2");
        assert_eq!(candidates[1].content_hash, "h1");
    }

    #[test]
    fn a_function_that_was_deleted_can_use_every_state_it_ever_had() {
        let d = dir();
        let h = FunctionHistory::at(d.path());
        h.record(&[entry("verify", "h1", "fn verify() { a() }", 1)]);
        h.record(&[entry("verify", "h2", "fn verify() { b() }", 2)]);

        let candidates = h.differing("src/auth.rs", "verify", None);
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].content_hash, "h2");
    }

    #[test]
    fn one_functions_history_is_not_anothers() {
        let d = dir();
        let h = FunctionHistory::at(d.path());
        h.record(&[
            entry("verify", "h1", "fn verify() {}", 1),
            entry("sign", "h9", "fn sign() {}", 1),
        ]);

        let only_verify = h.differing("src/auth.rs", "verify", None);
        assert_eq!(only_verify.len(), 1);
        assert_eq!(only_verify[0].function_name, "verify");

        let only_sign = h.differing("src/auth.rs", "sign", None);
        assert_eq!(only_sign.len(), 1);
        assert_eq!(only_sign[0].content_hash, "h9");
    }

    #[test]
    fn two_files_keep_two_logs() {
        let d = dir();
        let h = FunctionHistory::at(d.path());
        let mut other = entry("verify", "h1", "fn verify() {}", 1);
        other.file_path = "src/session.rs".into();
        h.record(&[entry("verify", "h1", "fn verify() { auth }", 1), other]);

        assert_eq!(h.entries_for("src/auth.rs").len(), 1);
        assert_eq!(h.entries_for("src/session.rs").len(), 1);
        assert_eq!(h.entries_for("src/auth.rs")[0].body, "fn verify() { auth }");
    }

    #[test]
    fn a_log_stops_growing_at_its_bound_and_keeps_the_newest() {
        let d = dir();
        let h = FunctionHistory::at(d.path());
        let total = FunctionHistory::MAX_PER_FILE + 25;
        for i in 0..total {
            h.record(&[entry("verify", &format!("h{i}"), &format!("fn verify() {{ {i} }}"), i as u64)]);
        }
        let back = h.entries_for("src/auth.rs");
        assert_eq!(back.len(), FunctionHistory::MAX_PER_FILE);
        assert_eq!(
            back[0].content_hash,
            format!("h{}", total - 1),
            "the newest state must survive pruning — it is the one a rewind wants"
        );
    }

    #[test]
    fn a_torn_line_costs_that_line_and_nothing_else() {
        let d = dir();
        let h = FunctionHistory::at(d.path());
        h.record(&[entry("verify", "h1", "fn verify() { a() }", 1)]);
        h.record(&[entry("verify", "h2", "fn verify() { b() }", 2)]);

        let path = d.path().join("src__auth.rs.jsonl");
        let mut text = fs::read_to_string(&path).unwrap();
        text.push_str("{\"file_path\":\"src/auth.rs\",\"funct\n");
        fs::write(&path, text).unwrap();

        let back = h.entries_for("src/auth.rs");
        assert_eq!(back.len(), 2, "the two good lines still read");
        assert_eq!(back[0].content_hash, "h2");
    }

    #[test]
    fn a_file_with_no_history_answers_empty_rather_than_failing() {
        let d = dir();
        let h = FunctionHistory::at(d.path());
        assert!(h.entries_for("src/never_touched.rs").is_empty());
        assert!(h.differing("src/never_touched.rs", "verify", None).is_empty());
    }

    #[test]
    fn a_path_cannot_write_outside_the_log_directory() {
        let d = dir();
        let h = FunctionHistory::at(d.path());
        let mut e = entry("verify", "h1", "fn verify() {}", 1);
        e.file_path = "../../etc/passwd".into();
        h.record(&[e]);

        assert!(
            d.path().join("....__..__etc__passwd.jsonl").exists()
                || fs::read_dir(d.path()).unwrap().count() == 1,
            "the separators are flattened, so the log stays in its own directory"
        );
        assert!(!Path::new("/etc/passwd.jsonl").exists());
    }

    /// A repo with one source file in it, staged so git sees it.
    fn repo_with_source(source: &str) -> tempfile::TempDir {
        let d = dir();
        let repo = git2::Repository::init(d.path()).expect("init");
        fs::create_dir_all(d.path().join("src")).expect("src");
        fs::write(d.path().join("src/lib.rs"), source).expect("write");
        let mut index = repo.index().expect("index");
        index.add_path(Path::new("src/lib.rs")).expect("add");
        index.write().expect("index write");
        d
    }

    fn store_in(repo: &Path) -> FunctionHistory {
        FunctionHistory::at(repo.join(".aura").join("function_history"))
    }

    const TWO_FNS: &str = "pub fn alpha(x: i32) -> i32 {\n    x + 1\n}\n\npub fn beta() -> i32 {\n    7\n}\n";

    #[test]
    fn the_command_every_agent_is_told_to_run_leaves_a_record_behind_it() {
        let d = repo_with_source(TWO_FNS);
        let h = store_in(d.path());
        let named = vec!["src/lib.rs".to_string()];

        let written = record_for_intent(&h, d.path(), &named);

        assert_eq!(written, 2, "both functions in the named file are recorded");
        let kept = h.entries_for(&d.path().join("src/lib.rs").to_string_lossy());
        assert!(kept.iter().any(|e| e.function_name == "beta"));
        assert!(kept.iter().any(|e| e.function_name == "alpha"));
    }

    #[test]
    fn an_intent_that_names_no_file_still_records_what_git_sees_as_changed() {
        let d = repo_with_source(TWO_FNS);
        let h = store_in(d.path());

        let written = record_for_intent(&h, d.path(), &[]);

        assert_eq!(
            written, 2,
            "a person typing the command by hand names nothing, and still gets a record"
        );
    }

    #[test]
    fn one_file_spelled_two_ways_lands_in_one_log() {
        let d = repo_with_source(TWO_FNS);
        let h = store_in(d.path());
        record_for_intent(&h, d.path(), &["src/lib.rs".to_string()]);

        // The path recorded was absolute; the log is named for the repo-relative
        // form, which is what a rewind spelling `src/lib.rs` from the repo root
        // also resolves to. Two spellings, one log.
        assert!(
            d.path()
                .join(".aura/function_history/src__lib.rs.jsonl")
                .exists(),
            "an absolute path is reduced to the repo-relative key"
        );
    }

    #[test]
    fn a_named_file_that_does_not_parse_costs_that_file_and_nothing_else() {
        let d = repo_with_source(TWO_FNS);
        let h = store_in(d.path());
        fs::write(d.path().join("notes.txt"), "not source at all").expect("write");

        let written = record_for_intent(
            &h,
            d.path(),
            &["notes.txt".to_string(), "src/lib.rs".to_string()],
        );

        assert_eq!(written, 2, "the source file is still recorded");
    }

    #[test]
    fn a_fall_back_sweep_stops_at_its_bound() {
        let d = repo_with_source(TWO_FNS);
        let repo = git2::Repository::open(d.path()).expect("open");
        let mut index = repo.index().expect("index");
        for n in 0..(FALLBACK_MAX_FILES + 20) {
            let name = format!("src/f{n}.rs");
            fs::write(d.path().join(&name), "pub fn only() -> u8 {\n    1\n}\n").expect("write");
            index.add_path(Path::new(&name)).expect("add");
        }
        index.write().expect("index write");

        let swept = dirty_files(d.path());

        assert_eq!(
            swept.len(),
            FALLBACK_MAX_FILES,
            "a hook firing mid-rebase does not turn into a repo-wide parse"
        );
    }
}
