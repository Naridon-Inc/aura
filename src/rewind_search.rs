//! Where a rewind looks for the version it is going to put back.
//!
//! Two surfaces rewind a function — `aura rewind` and the MCP `aura_rewind`
//! tool — and until now each carried its own copy of the search. The copies
//! had already drifted: the CLI could put back a function an agent had
//! **deleted**, and the MCP tool refused outright ("Cannot find 'x' in
//! current file"), which is exactly backwards, because deletion is the damage
//! an agent does and the MCP tool is the surface an agent uses.
//!
//! Both copies also stopped at the first candidate they found. If that one
//! version failed to splice, the rewind aborted even when an older, perfectly
//! good version was sitting behind it. So this module returns an ordered list
//! and the caller tries them in turn; a rewind now fails only when *nothing*
//! recorded can be put back.
//!
//! ## The order
//!
//! Aura's own records first, newest first, and git after them.
//!
//!  * [`crate::function_history`] — the per-function bodies Aura extracts on
//!    every intent log. The only record that exists for an uncommitted edit
//!    to a file nothing snapshotted.
//!  * `.aura/snapshots/` — whole-file, pre-edit. Carries the surrounding file,
//!    so it can place a deleted function back beside its neighbours.
//!  * git — HEAD and its ancestors. Always correct, only ever as recent as
//!    the last commit.
//!
//! The first two are interleaved by the clock rather than concatenated: both
//! stamp milliseconds since the epoch, and "the last state Aura recorded" is a
//! statement about time, not about which of Aura's two stores happened to
//! hold it.

use std::ops::Range;

use git2::Repository;

use crate::checkpoint::SnapshotStore;
use crate::function_history::FunctionHistory;
use crate::parser::SemanticParser;

/// How far back the git walk goes: HEAD plus this many ancestors.
pub const GIT_DEPTH: usize = 50;

/// How many versions a rewind will try before giving up.
///
/// A bound exists so a long-lived file cannot turn one rewind into hundreds
/// of parses. It is generous enough that it is never the reason a real
/// recovery fails: the candidates are deduplicated by content, so reaching it
/// means fifty genuinely different past versions all failed to splice.
pub const MAX_CANDIDATES: usize = 50;

/// Where one candidate version came from, so a person can be told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    /// A body Aura recorded for this function, with its stamp and who was
    /// working.
    Recorded { recorded_at: u64, recorded_by: String },
    /// A durable pre-edit file snapshot.
    Snapshot { timestamp: u64, trigger: String },
    /// A commit: `depth` 0 is HEAD.
    Git { depth: usize, commit: String },
}

impl Origin {
    /// One line naming this source, for the surface that reports what it did.
    pub fn describe(&self) -> String {
        match self {
            Origin::Recorded { recorded_by, .. } if recorded_by.is_empty() => {
                "Aura's recorded history for this function".to_string()
            }
            Origin::Recorded { recorded_by, .. } => {
                format!("Aura's recorded history for this function (by {recorded_by})")
            }
            Origin::Snapshot { timestamp, trigger } => {
                format!("snapshot from {timestamp} (trigger: {trigger})")
            }
            Origin::Git { depth: 0, commit } => format!("commit HEAD ({})", short(commit)),
            Origin::Git { depth, commit } => {
                format!("commit HEAD~{depth} ({})", short(commit))
            }
        }
    }

    /// The same source, said to somebody who does not read commit graphs.
    ///
    /// [`describe`](Self::describe) is written for a terminal: `commit
    /// HEAD~2 (abc12345)`, `snapshot from 1789045284657 (trigger:
    /// pre_rewind)`. The desktop shows this line to people whose recovery
    /// surface already calls these *moments*, and a unix millisecond stamp
    /// in a confirmation dialog is a question nobody can answer.
    pub fn in_plain_words(&self) -> String {
        match self {
            Origin::Recorded { recorded_by, .. } if recorded_by.is_empty() => {
                "a version Aura recorded as you worked".to_string()
            }
            Origin::Recorded { recorded_by, .. } => {
                format!("a version Aura recorded while {recorded_by} was working")
            }
            Origin::Snapshot { trigger, .. } if trigger == "pre_rewind" => {
                "the copy Aura kept just before it last brought this back".to_string()
            }
            Origin::Snapshot { .. } => "a copy Aura saved just before an edit".to_string(),
            Origin::Git { depth: 0, .. } => "the most recent moment".to_string(),
            Origin::Git { depth: 1, .. } => "one moment back".to_string(),
            Origin::Git { depth, .. } => format!("{depth} moments back"),
        }
    }

    /// When this version was recorded, in milliseconds since the epoch, for
    /// the sources that know. Git candidates are ordered by walk depth
    /// instead, so they do not answer.
    fn recorded_at(&self) -> Option<u64> {
        match self {
            Origin::Recorded { recorded_at, .. } => Some(*recorded_at),
            Origin::Snapshot { timestamp, .. } => Some(*timestamp),
            Origin::Git { .. } => None,
        }
    }
}

fn short(commit: &str) -> &str {
    &commit[..commit.len().min(8)]
}

/// One version of the function that could be put back.
#[derive(Debug, Clone)]
pub struct Candidate {
    /// The function's source, ready to splice.
    pub node_source: String,
    /// The whole file that source came from, when the record carries one.
    /// Restoring a **deleted** function needs it: without the surrounding
    /// file there is no way to work out where the function used to sit.
    pub file_source: Option<String>,
    pub origin: Origin,
}

/// Every version of `identifier` in `file_path` that differs from what is
/// there now, best first, using the stores under the current repo.
pub fn candidates_here(
    parser: &mut SemanticParser,
    repo: &Repository,
    file_path: &str,
    ext: &str,
    identifier: &str,
    current_node_source: Option<&str>,
) -> Vec<Candidate> {
    candidates(
        parser,
        repo,
        &FunctionHistory::open(),
        &SnapshotStore::get_snapshots_for_file(file_path),
        file_path,
        ext,
        identifier,
        current_node_source,
    )
}

/// Every version of `identifier` in `file_path` that differs from what is
/// there now, best first.
///
/// The two Aura stores are passed in rather than reached for, so this can be
/// exercised against a known history instead of whatever happens to be in the
/// working directory.
///
/// `current_node_source` is `None` when the function is gone from the file.
/// Then every recorded version is a candidate, because anything is a
/// recovery — and only candidates that carry their whole file can actually be
/// used, so those are the ones kept.
#[allow(clippy::too_many_arguments)]
pub fn candidates(
    parser: &mut SemanticParser,
    repo: &Repository,
    history: &FunctionHistory,
    snapshots: &[crate::checkpoint::FileSnapshot],
    file_path: &str,
    ext: &str,
    identifier: &str,
    current_node_source: Option<&str>,
) -> Vec<Candidate> {
    let deleted = current_node_source.is_none();
    let mut aura: Vec<Candidate> = Vec::new();

    // Aura's per-function record. A recorded body is stored as it was
    // extracted, so it is run back through the parser here: what gets spliced
    // is always a node the parser recognises, never a heuristic slice of
    // text. A body that no longer parses on its own — a method lifted out of
    // its class, say — is dropped rather than spliced blind.
    for e in history.differing(file_path, identifier, current_node_source) {
        let Ok(Some((src, _))) = parser.retrieve_node_source(&e.body, ext, identifier) else {
            continue;
        };
        if current_node_source == Some(src.as_str()) {
            continue;
        }
        aura.push(Candidate {
            node_source: src,
            // A recorded body is the function alone. It can replace a
            // function that is still there; it cannot place one that is gone.
            file_source: None,
            origin: Origin::Recorded { recorded_at: e.recorded_at, recorded_by: e.recorded_by },
        });
    }

    // Whole-file pre-edit snapshots.
    for snap in snapshots {
        let Ok(Some((src, _))) = parser.retrieve_node_source(&snap.content, ext, identifier) else {
            continue;
        };
        if current_node_source == Some(src.as_str()) {
            continue;
        }
        aura.push(Candidate {
            node_source: src,
            file_source: Some(snap.content.clone()),
            origin: Origin::Snapshot { timestamp: snap.timestamp, trigger: snap.trigger.clone() },
        });
    }

    // Both of Aura's stores stamp milliseconds, so "the last state Aura
    // recorded" is one ordering across the two, not one store searched before
    // the other.
    aura.sort_by(|a, b| b.origin.recorded_at().cmp(&a.origin.recorded_at()));

    let mut out = aura;
    out.extend(git_candidates(parser, repo, file_path, ext, identifier, current_node_source));

    // A deleted function can only be put back from a record that carries the
    // file it lived in, and a recorded body carries only itself. Dropping
    // those here would fail at exactly the moment the record is worth most:
    // the newest state of a function that was never committed is precisely
    // what the snapshots and git do not have. So give each recorded body a
    // home instead — take the newest surviving file that still holds this
    // function and swap the recorded body in for the older one it carries.
    // Placement comes from the file; the logic comes from the record.
    if deleted {
        if let Some(scaffold) = out.iter().find_map(|c| c.file_source.clone()) {
            for candidate in out.iter_mut() {
                if candidate.file_source.is_some() {
                    continue;
                }
                candidate.file_source =
                    rehome(parser, &scaffold, ext, identifier, &candidate.node_source);
            }
        }
        out.retain(|c| c.file_source.is_some());
    }

    dedupe(out)
}

/// Put `node_source` where `identifier` sits in `scaffold`, so a body that was
/// recorded on its own can be placed back into a file it has gone missing
/// from. `None` when the scaffold does not carry the function, or when the
/// swap does not survive a re-parse — restoring something other than what was
/// recorded is worse than not restoring.
fn rehome(
    parser: &mut SemanticParser,
    scaffold: &str,
    ext: &str,
    identifier: &str,
    node_source: &str,
) -> Option<String> {
    let (_, range) = current_node(parser, scaffold, ext, identifier)?;
    if range.end > scaffold.len()
        || range.start > range.end
        || !scaffold.is_char_boundary(range.start)
        || !scaffold.is_char_boundary(range.end)
    {
        return None;
    }
    let mut rehomed = scaffold.to_string();
    rehomed.replace_range(range, node_source);
    match parser.retrieve_node_source(&rehomed, ext, identifier) {
        Ok(Some((back, _))) if back.trim_end() == node_source.trim_end() => Some(rehomed),
        _ => None,
    }
}

fn git_candidates(
    parser: &mut SemanticParser,
    repo: &Repository,
    file_path: &str,
    ext: &str,
    identifier: &str,
    current_node_source: Option<&str>,
) -> Vec<Candidate> {
    let mut out = Vec::new();
    let Ok(head) = repo.head().and_then(|r| r.peel_to_commit()) else {
        return out;
    };
    let mut commit = head;
    for depth in 0..GIT_DEPTH {
        if let Ok(tree) = commit.tree() {
            if let Ok(entry) = tree.get_path(std::path::Path::new(file_path)) {
                if let Ok(obj) = entry.to_object(repo) {
                    if let Some(blob) = obj.as_blob() {
                        if let Ok(past_file) = std::str::from_utf8(blob.content()) {
                            if let Ok(Some((src, _))) =
                                parser.retrieve_node_source(past_file, ext, identifier)
                            {
                                if current_node_source != Some(src.as_str()) {
                                    out.push(Candidate {
                                        node_source: src,
                                        file_source: Some(past_file.to_string()),
                                        origin: Origin::Git {
                                            depth,
                                            commit: commit.id().to_string(),
                                        },
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        match commit.parent(0) {
            Ok(p) => commit = p,
            Err(_) => break,
        }
    }
    out
}

/// Keep the first appearance of each distinct version, and stop at the bound.
///
/// The same function body usually sits in a dozen consecutive commits. Trying
/// it a dozen times cannot succeed any of the later times if it failed the
/// first, and it would spend the whole candidate budget on one version.
fn dedupe(candidates: Vec<Candidate>) -> Vec<Candidate> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for c in candidates {
        let key = c.node_source.trim().to_string();
        if seen.iter().any(|s| s == &key) {
            continue;
        }
        seen.push(key);
        out.push(c);
        if out.len() >= MAX_CANDIDATES {
            break;
        }
    }
    out
}

/// Try the candidates in order and keep the first one that goes back.
///
/// Both surfaces used to stop at the first candidate they found, so a version
/// that would not splice ended the rewind even when a perfectly good older
/// one was waiting behind it. The transactional apply writes nothing when it
/// refuses, so a rejected attempt costs the file nothing and there is no
/// reason not to try the next.
///
/// On success: which candidate worked, and whatever the apply returned. On
/// failure: the reason the last attempt gave, so the caller can say something
/// truer than "rewind failed".
pub fn apply_first<T>(
    candidates: &[Candidate],
    mut attempt: impl FnMut(&Candidate) -> Result<T, String>,
) -> Result<(usize, T), String> {
    let mut last_error = String::from("there was nothing to put back");
    for (i, candidate) in candidates.iter().enumerate() {
        match attempt(candidate) {
            Ok(v) => return Ok((i, v)),
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

/// The byte range `identifier` occupies in `source`, or `None` when it is not
/// there. Both surfaces need exactly this before they can splice.
pub fn current_node(
    parser: &mut SemanticParser,
    source: &str,
    ext: &str,
    identifier: &str,
) -> Option<(String, Range<usize>)> {
    parser.retrieve_node_source(source, ext, identifier).ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recorded_version_is_named_by_who_recorded_it() {
        let o = Origin::Recorded { recorded_at: 5, recorded_by: "claude".into() };
        assert!(o.describe().contains("claude"));
        let anon = Origin::Recorded { recorded_at: 5, recorded_by: String::new() };
        assert!(!anon.describe().contains("(by"), "no name is better than an empty one");
    }

    #[test]
    fn the_desktop_wording_carries_no_stamps_shas_or_trigger_names() {
        let snap = Origin::Snapshot { timestamp: 1789045284657, trigger: "pre_rewind".into() };
        let plain = snap.in_plain_words();
        assert!(!plain.contains("1789045284657"), "a millisecond stamp is not an answer: {plain}");
        assert!(!plain.contains("pre_rewind"), "an internal trigger name leaked: {plain}");
        // And it is the rewind's own copy, not somebody's pre-edit backup.
        assert!(plain.contains("brought this back"));

        let ordinary = Origin::Snapshot { timestamp: 1, trigger: "pre_edit".into() };
        assert!(ordinary.in_plain_words().contains("before an edit"));

        let git = Origin::Git { depth: 2, commit: "abcdef1234567890".into() };
        assert_eq!(git.in_plain_words(), "2 moments back");
        assert!(!git.in_plain_words().contains("abcdef"));
        assert_eq!(
            Origin::Git { depth: 0, commit: "abc".into() }.in_plain_words(),
            "the most recent moment"
        );

        let anon = Origin::Recorded { recorded_at: 5, recorded_by: String::new() };
        assert!(!anon.in_plain_words().contains("while"), "no name is better than an empty one");
    }

    #[test]
    fn head_is_named_head_and_not_head_minus_zero() {
        let o = Origin::Git { depth: 0, commit: "abcdef1234567890".into() };
        assert_eq!(o.describe(), "commit HEAD (abcdef12)");
        let older = Origin::Git { depth: 3, commit: "abcdef1234567890".into() };
        assert_eq!(older.describe(), "commit HEAD~3 (abcdef12)");
    }

    #[test]
    fn a_short_commit_id_is_not_sliced_past_its_end() {
        let o = Origin::Git { depth: 0, commit: "abc".into() };
        assert_eq!(o.describe(), "commit HEAD (abc)");
    }

    fn candidate(src: &str, origin: Origin) -> Candidate {
        Candidate { node_source: src.into(), file_source: None, origin }
    }

    #[test]
    fn the_same_version_from_two_places_is_tried_once() {
        let out = dedupe(vec![
            candidate("fn a() {}", Origin::Git { depth: 0, commit: "aaa".into() }),
            candidate("fn a() {}\n", Origin::Git { depth: 1, commit: "bbb".into() }),
            candidate("fn a() { b() }", Origin::Git { depth: 2, commit: "ccc".into() }),
        ]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].origin, Origin::Git { depth: 0, commit: "aaa".into() });
        assert_eq!(out[1].origin, Origin::Git { depth: 2, commit: "ccc".into() });
    }

    #[test]
    fn the_candidate_list_is_bounded() {
        let many: Vec<Candidate> = (0..MAX_CANDIDATES * 3)
            .map(|i| candidate(&format!("fn a() {{ {i} }}"), Origin::Git { depth: i, commit: "x".into() }))
            .collect();
        assert_eq!(dedupe(many).len(), MAX_CANDIDATES);
    }

    // ── The wiring itself ──────────────────────────────────────────────
    //
    // Everything below drives the real parser against a real repository.
    // The two Aura stores are handed in, so a run is judged on the history
    // the test wrote and not on whatever is in the working directory.

    use crate::checkpoint::FileSnapshot;
    use crate::function_history::{Entry, FunctionHistory};

    const TWO_FUNCTIONS: &str = "\
fn verify(token: &str) -> bool {
    token == \"new\"
}

fn sign(token: &str) -> String {
    format!(\"signed:{}\", token)
}
";

    const OLD_VERIFY: &str = "fn verify(token: &str) -> bool {\n    token == \"old\"\n}";

    fn parser() -> SemanticParser {
        SemanticParser::new().expect("parser")
    }

    /// A repository with no commits, so git contributes nothing and the only
    /// records are the ones the test wrote. Returns the temp dir, the repo,
    /// and the absolute path of the written file.
    fn uncommitted_repo(source: &str) -> (tempfile::TempDir, Repository, String) {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = Repository::init(dir.path()).expect("git init");
        let file = dir.path().join("auth.rs");
        std::fs::write(&file, source).expect("write");
        let path = file.to_string_lossy().into_owned();
        (dir, repo, path)
    }

    fn recorded(file_path: &str, body: &str, hash: &str, at: u64) -> Entry {
        Entry {
            file_path: file_path.to_string(),
            function_name: "verify".into(),
            function_kind: "function".into(),
            content_hash: hash.into(),
            body: body.into(),
            recorded_at: at,
            recorded_by: "claude".into(),
        }
    }

    fn history_with(entries: Vec<Entry>) -> (tempfile::TempDir, FunctionHistory) {
        let dir = tempfile::tempdir().expect("temp dir");
        let h = FunctionHistory::at(dir.path());
        h.record(&entries);
        (dir, h)
    }

    #[test]
    fn a_recorded_body_is_the_candidate_when_there_is_no_snapshot_and_no_commit() {
        let (_d, repo, path) = uncommitted_repo(TWO_FUNCTIONS);
        let (_hd, history) = history_with(vec![recorded(&path, OLD_VERIFY, "h1", 10)]);
        let mut p = parser();
        let current = current_node(&mut p, TWO_FUNCTIONS, "rs", "verify").map(|(s, _)| s);

        let found = candidates(
            &mut p, &repo, &history, &[], &path, "rs", "verify", current.as_deref(),
        );

        assert_eq!(found.len(), 1, "the recorded body is the only record there is");
        assert!(found[0].node_source.contains("token == \"old\""));
        assert!(matches!(found[0].origin, Origin::Recorded { .. }));
    }

    #[test]
    fn the_version_already_on_disk_is_never_offered_as_a_recovery() {
        let (_d, repo, path) = uncommitted_repo(TWO_FUNCTIONS);
        let on_disk = "fn verify(token: &str) -> bool {\n    token == \"new\"\n}";
        let (_hd, history) = history_with(vec![recorded(&path, on_disk, "h1", 10)]);
        let mut p = parser();
        let current = current_node(&mut p, TWO_FUNCTIONS, "rs", "verify").map(|(s, _)| s);

        let found = candidates(
            &mut p, &repo, &history, &[], &path, "rs", "verify", current.as_deref(),
        );
        assert!(found.is_empty(), "putting back what is already there is not a rewind");
    }

    #[test]
    fn a_recorded_body_that_no_longer_parses_on_its_own_is_dropped() {
        let (_d, repo, path) = uncommitted_repo(TWO_FUNCTIONS);
        let (_hd, history) = history_with(vec![recorded(&path, "fn verify(token: &str -> {{{", "h1", 10)]);
        let mut p = parser();
        let current = current_node(&mut p, TWO_FUNCTIONS, "rs", "verify").map(|(s, _)| s);

        let found = candidates(
            &mut p, &repo, &history, &[], &path, "rs", "verify", current.as_deref(),
        );
        assert!(found.is_empty(), "a body the parser cannot read is never spliced blind");
    }

    #[test]
    fn a_rewind_from_recorded_history_leaves_every_sibling_byte_identical() {
        let (_d, repo, path) = uncommitted_repo(TWO_FUNCTIONS);
        let (_hd, history) = history_with(vec![recorded(&path, OLD_VERIFY, "h1", 10)]);
        let mut p = parser();
        let (current_src, range) =
            current_node(&mut p, TWO_FUNCTIONS, "rs", "verify").expect("verify is in the file");

        let found = candidates(
            &mut p, &repo, &history, &[], &path, "rs", "verify", Some(&current_src),
        );
        let (i, _applied) = apply_first(&found, |c| {
            crate::rewind_txn::apply_rewind(
                &mut p, &path, "rs", "verify", TWO_FUNCTIONS, Some(range.clone()),
                &c.node_source, c.file_source.as_deref(),
                || Ok("safety.json".to_string()),
            )
        })
        .expect("the recorded version goes back");
        assert!(matches!(found[i].origin, Origin::Recorded { .. }));

        let after = std::fs::read_to_string(&path).expect("read back");
        assert!(after.contains("token == \"old\""), "verify went back");
        assert_eq!(
            after.matches("fn sign(token: &str) -> String {\n    format!(\"signed:{}\", token)\n}\n").count(),
            1,
            "its neighbour is byte-identical, and there is still exactly one of it"
        );
        // Everything outside the rewound node is the file it was.
        let (before_head, before_tail) = TWO_FUNCTIONS.split_at(range.start);
        assert!(after.starts_with(before_head));
        assert!(after.ends_with(&before_tail[range.end - range.start..]));
    }

    #[test]
    fn a_rewind_from_recorded_history_always_leaves_a_safety_snapshot() {
        let (_d, repo, path) = uncommitted_repo(TWO_FUNCTIONS);
        let (_hd, history) = history_with(vec![recorded(&path, OLD_VERIFY, "h1", 10)]);
        let mut p = parser();
        let (current_src, range) = current_node(&mut p, TWO_FUNCTIONS, "rs", "verify").unwrap();
        let found = candidates(
            &mut p, &repo, &history, &[], &path, "rs", "verify", Some(&current_src),
        );

        let taken = std::cell::Cell::new(0);
        let (_i, applied) = apply_first(&found, |c| {
            crate::rewind_txn::apply_rewind(
                &mut p, &path, "rs", "verify", TWO_FUNCTIONS, Some(range.clone()),
                &c.node_source, c.file_source.as_deref(),
                || {
                    taken.set(taken.get() + 1);
                    Ok("safety.json".to_string())
                },
            )
        })
        .expect("rewind applies");

        assert_eq!(taken.get(), 1, "exactly one snapshot, taken for the attempt that wrote");
        assert_eq!(applied.safety_snapshot, "safety.json");
    }

    #[test]
    fn a_rewind_aborts_without_writing_when_the_file_changed_after_it_was_read() {
        let (_d, repo, path) = uncommitted_repo(TWO_FUNCTIONS);
        let (_hd, history) = history_with(vec![recorded(&path, OLD_VERIFY, "h1", 10)]);
        let mut p = parser();
        let (current_src, range) = current_node(&mut p, TWO_FUNCTIONS, "rs", "verify").unwrap();
        let found = candidates(
            &mut p, &repo, &history, &[], &path, "rs", "verify", Some(&current_src),
        );
        assert!(!found.is_empty());

        // Somebody else writes the file between the parse and the apply.
        let meanwhile = TWO_FUNCTIONS.replace("token == \"new\"", "token == \"theirs\"");
        std::fs::write(&path, &meanwhile).unwrap();

        let err = apply_first(&found, |c| {
            crate::rewind_txn::apply_rewind(
                &mut p, &path, "rs", "verify", TWO_FUNCTIONS, Some(range.clone()),
                &c.node_source, c.file_source.as_deref(),
                || Ok("safety.json".to_string()),
            )
        })
        .expect_err("a concurrent edit must not be overwritten");
        assert!(err.contains("changed on disk"), "{err}");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            meanwhile,
            "their edit is still there, whole"
        );
    }

    #[test]
    fn the_next_version_is_tried_when_the_first_will_not_go_back() {
        let tried = std::cell::RefCell::new(Vec::new());
        let list = vec![
            candidate("first", Origin::Recorded { recorded_at: 3, recorded_by: "a".into() }),
            candidate("second", Origin::Recorded { recorded_at: 2, recorded_by: "a".into() }),
            candidate("third", Origin::Recorded { recorded_at: 1, recorded_by: "a".into() }),
        ];
        let (i, ()) = apply_first(&list, |c| {
            tried.borrow_mut().push(c.node_source.clone());
            if c.node_source == "first" { Err("will not splice".into()) } else { Ok(()) }
        })
        .expect("the version behind it goes back");

        assert_eq!(i, 1, "the second version is the one that applied");
        assert_eq!(*tried.borrow(), vec!["first", "second"], "and the third was never needed");
    }

    #[test]
    fn a_rewind_fails_with_the_reason_the_last_attempt_gave() {
        let list = vec![
            candidate("a", Origin::Recorded { recorded_at: 2, recorded_by: String::new() }),
            candidate("b", Origin::Recorded { recorded_at: 1, recorded_by: String::new() }),
        ];
        let err = apply_first::<()>(&list, |c| Err(format!("{} refused", c.node_source)))
            .expect_err("nothing applied");
        assert_eq!(err, "b refused");
    }

    #[test]
    fn a_deleted_function_comes_back_as_the_newest_body_aura_recorded() {
        let without_verify = "fn sign(token: &str) -> String {\n    format!(\"signed:{}\", token)\n}\n";
        let (_d, repo, path) = uncommitted_repo(without_verify);
        // The record is newer than the snapshot: it is the state the function
        // was actually in when it went, and it was never committed anywhere.
        let (_hd, history) = history_with(vec![recorded(&path, OLD_VERIFY, "h1", 10)]);
        let snapshot = FileSnapshot {
            file_path: path.clone(),
            content: TWO_FUNCTIONS.to_string(),
            timestamp: 5,
            trigger: "pre_edit".into(),
            agent_id: "claude".into(),
        };
        let mut p = parser();

        let found = candidates(
            &mut p, &repo, &history, std::slice::from_ref(&snapshot), &path, "rs", "verify", None,
        );

        assert!(
            matches!(found[0].origin, Origin::Recorded { .. }),
            "the newest state wins, and being a lone body is no longer a reason to lose"
        );
        assert_eq!(found[0].node_source.trim_end(), OLD_VERIFY.trim_end());
        let home = found[0].file_source.as_deref().expect("a home to be placed into");
        assert!(home.contains(OLD_VERIFY.trim_end()), "the recorded body is the one in the file");
        assert!(home.contains("fn sign"), "and its neighbours came with it");
    }

    #[test]
    fn a_deleted_function_with_no_file_anywhere_is_honestly_unrecoverable() {
        let without_verify = "fn sign(token: &str) -> String {\n    format!(\"signed:{}\", token)\n}\n";
        let (_d, repo, path) = uncommitted_repo(without_verify);
        let (_hd, history) = history_with(vec![recorded(&path, OLD_VERIFY, "h1", 10)]);
        let mut p = parser();

        // No snapshot, nothing committed: there is no file that ever held this
        // function, so there is nowhere to put the body back.
        let found = candidates(&mut p, &repo, &history, &[], &path, "rs", "verify", None);

        assert!(found.is_empty(), "no home, no claim that it can be restored");
    }

    #[test]
    fn auras_own_record_is_offered_before_git() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = Repository::init(dir.path()).expect("git init");
        let committed = TWO_FUNCTIONS.replace("token == \"new\"", "token == \"committed\"");
        std::fs::write(dir.path().join("auth.rs"), &committed).unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("auth.rs")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = git2::Signature::now("t", "t@example.com").unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "in", &tree, &[]).unwrap();
        }
        // Now the working copy says something else again.
        std::fs::write(dir.path().join("auth.rs"), TWO_FUNCTIONS).unwrap();

        // The git walk addresses the file by its path inside the repo.
        let (_hd, history) = history_with(vec![recorded("auth.rs", OLD_VERIFY, "h1", 10)]);
        let mut p = parser();
        let current = current_node(&mut p, TWO_FUNCTIONS, "rs", "verify").map(|(s, _)| s);

        let found = candidates(
            &mut p, &repo, &history, &[], "auth.rs", "rs", "verify", current.as_deref(),
        );

        assert_eq!(found.len(), 2, "both the recorded body and the committed one");
        assert!(matches!(found[0].origin, Origin::Recorded { .. }), "Aura's own record comes first");
        assert!(found[0].node_source.contains("token == \"old\""));
        assert!(matches!(found[1].origin, Origin::Git { depth: 0, .. }));
        assert!(found[1].node_source.contains("token == \"committed\""));
    }

    #[test]
    fn git_supplies_a_version_when_aura_recorded_none() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = Repository::init(dir.path()).expect("git init");
        let committed = TWO_FUNCTIONS.replace("token == \"new\"", "token == \"committed\"");
        std::fs::write(dir.path().join("auth.rs"), &committed).unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("auth.rs")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let sig = git2::Signature::now("t", "t@example.com").unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "in", &tree, &[]).unwrap();
        }
        let empty = tempfile::tempdir().unwrap();
        let history = FunctionHistory::at(empty.path());
        let mut p = parser();
        let current = current_node(&mut p, TWO_FUNCTIONS, "rs", "verify").map(|(s, _)| s);

        let found = candidates(
            &mut p, &repo, &history, &[], "auth.rs", "rs", "verify", current.as_deref(),
        );
        assert_eq!(found.len(), 1);
        assert!(matches!(found[0].origin, Origin::Git { depth: 0, .. }));
    }

    #[test]
    fn auras_two_stores_are_ordered_by_the_clock_not_by_store() {
        let mut aura = vec![
            candidate("old recorded", Origin::Recorded { recorded_at: 100, recorded_by: "a".into() }),
            candidate("new snapshot", Origin::Snapshot { timestamp: 900, trigger: "pre_edit".into() }),
            candidate("mid recorded", Origin::Recorded { recorded_at: 500, recorded_by: "a".into() }),
        ];
        aura.sort_by(|a, b| b.origin.recorded_at().cmp(&a.origin.recorded_at()));
        let order: Vec<&str> = aura.iter().map(|c| c.node_source.as_str()).collect();
        assert_eq!(order, vec!["new snapshot", "mid recorded", "old recorded"]);
    }
}
