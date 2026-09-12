//! The reason somebody actually wrote down for one file.
//!
//! The split-diff header's "Why & how" band asks a model to read the diff and
//! guess why the change was made. For most changes that is the only thing
//! available. But `aura snapshot-file <path> --why "…"` exists precisely so an
//! author can say the reason in their own words, and those words land in
//! `.aura/intent_log.jsonl` scoped to that exact file — 196 of them in this
//! repo's log at the time of writing. Nothing read them. The band inferred a
//! reason from the code while the stated one sat on disk one directory away.
//!
//! This module finds it. A recorded reason wins over a generated one and is
//! labelled as recorded, so a reviewer can tell "the author said this" from
//! "Aura read the diff and thinks this".
//!
//! ## Telling a written reason from a sentence a hook composed
//!
//! Every hook capture lands in the same log with the same shape, so the file
//! field alone proves nothing. The discriminator is the one PR #65 established
//! on the read side, in the same words:
//!
//!   * `tool` names the agent tool call the row records. Only a hook writing
//!     about a tool call names one.
//!   * `change` holds the mechanical sentence the hook was going to write
//!     before a stated reason displaced it. Its presence means somebody spoke.
//!
//! So `tool` present and `change` empty is machine noise ("Claude Edit on
//! src/lib.rs", "running Edit on doctor.rs" — 1180 rows here, every one of them
//! mechanical). `change` present means the hook stepped aside, unless the
//! author declined to give a reason, in which case the hook writes its own stub
//! saying exactly that.
//!
//! `source` is deliberately NOT consulted: it defaults to `"hook_auto"` for
//! every plain `aura log-intent`, so filtering on it deletes real reasons.

use std::path::Path;

use serde::Deserialize;

/// One `.aura/intent_log.jsonl` row, narrowed to the fields that decide whether
/// it carries a reason for a file. Everything else on the row is ignored.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ReasonRow {
    #[serde(default)]
    pub timestamp: i64,
    #[serde(default)]
    pub intent: String,
    /// The file this row speaks for. Absolute in hook-written rows, repo-
    /// relative in CLI-written ones; [`matches_file`] accepts both.
    #[serde(default)]
    pub file: String,
    /// The agent tool call this row records, when a hook wrote it.
    #[serde(default)]
    pub tool: String,
    /// What the hook was going to say before a stated reason displaced it.
    #[serde(default)]
    pub change: String,
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub developer_handle: String,
}

/// A reason an author wrote for a specific file, with who wrote it and when.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedReason {
    pub text: String,
    pub stated_at: i64,
    /// The human handle when the log has one, else the agent's name. Empty when
    /// the row named neither.
    pub author: String,
}

/// The stub a hook writes for a file edit nobody gave a reason for. It is a
/// sentence about the absence of a reason, not a reason. In full the hook
/// writes *"Automatic pre-Edit snapshot; no reason was stated by the agent."*
const NO_REASON_STUB: &str = "no reason was stated";

/// Is this intent text the hook's stub rather than somebody's sentence?
///
/// The phrase has to *end* the text. Matching it anywhere threw out a real
/// reason that quoted the stub while explaining it — which happened the first
/// time somebody wrote about this behaviour, and the file they were fixing
/// then read as having no reason at all.
///
/// The same rule lives in `intent_query::is_no_reason_stub` in the CLI. Two
/// readers of one log that disagree about what a reason is will disagree
/// about a file, and the reader you happen to be holding decides what you
/// believe.
fn is_no_reason_stub(intent: &str) -> bool {
    let lowered = intent.trim().to_lowercase();
    let tail = lowered
        .trim_end_matches('.')
        .trim_end()
        .trim_end_matches("by the agent")
        .trim_end();
    tail.ends_with(NO_REASON_STUB)
}

/// True when this row carries words somebody chose, rather than a sentence a
/// hook composed about a tool call. See the module docs for why `tool` and
/// `change` decide it and `source` does not.
pub fn is_stated_reason(row: &ReasonRow) -> bool {
    let intent = row.intent.trim();
    if intent.is_empty() || row.file.trim().is_empty() {
        return false;
    }
    if is_no_reason_stub(intent) {
        return false;
    }
    // A hook wrote this about a tool call and nothing displaced its sentence.
    if !row.tool.trim().is_empty() && row.change.trim().is_empty() {
        return false;
    }
    true
}

/// Does `row.file` name the repo-relative path `rel`?
///
/// Hook rows carry an absolute path and CLI rows a repo-relative one, and a
/// worktree's absolute paths do not share a prefix with the main checkout's, so
/// comparing whole strings misses. Matching on the relative tail is what makes
/// a reason recorded from a worktree readable in the app.
pub fn matches_file(row_file: &str, rel: &str) -> bool {
    let a = normalize(row_file);
    let b = normalize(rel);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b || a.ends_with(&format!("/{b}"))
}

fn normalize(p: &str) -> String {
    p.trim().replace('\\', "/").trim_start_matches("./").to_string()
}

/// The newest reason recorded for `rel` inside the half-open window
/// `(after, until]`.
///
/// The window is what keeps an explanation attached to the change it describes.
/// A committed change takes the window between its parent's commit time and its
/// own, so a reason written for a later edit of the same file can never be
/// presented as the reason for this commit. A working-tree edit takes everything
/// since `HEAD`. `None` on either bound leaves that side open.
pub fn reason_for_file(
    rows: &[ReasonRow],
    rel: &str,
    after: Option<i64>,
    until: Option<i64>,
) -> Option<RecordedReason> {
    let mut best: Option<&ReasonRow> = None;
    for row in rows {
        if !is_stated_reason(row) || !matches_file(&row.file, rel) {
            continue;
        }
        if let Some(lo) = after {
            if row.timestamp <= lo {
                continue;
            }
        }
        if let Some(hi) = until {
            if row.timestamp > hi {
                continue;
            }
        }
        if best.is_none_or(|b| row.timestamp >= b.timestamp) {
            best = Some(row);
        }
    }
    best.map(|r| RecordedReason {
        text: r.intent.trim().to_string(),
        stated_at: r.timestamp,
        author: if !r.developer_handle.trim().is_empty() {
            r.developer_handle.trim().to_string()
        } else {
            r.agent_id.trim().to_string()
        },
    })
}

/// Parse `<repo>/.aura/intent_log.jsonl`. A malformed line is skipped rather
/// than failing the read — the log is append-only and shared with hooks, so one
/// truncated write must not blind the whole surface.
pub fn read_reason_rows(repo_root: &Path) -> Vec<ReasonRow> {
    let path = repo_root.join(".aura").join("intent_log.jsonl");
    let body = match std::fs::read_to_string(&path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    body.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<ReasonRow>(l.trim()).ok())
        .filter(|r| !r.file.trim().is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook_capture(file: &str, ts: i64) -> ReasonRow {
        ReasonRow {
            timestamp: ts,
            intent: format!("Claude Edit on {file}"),
            file: file.into(),
            tool: "Edit".into(),
            agent_id: "Claude".into(),
            ..Default::default()
        }
    }

    fn stated(file: &str, ts: i64, why: &str) -> ReasonRow {
        ReasonRow {
            timestamp: ts,
            intent: why.into(),
            file: file.into(),
            tool: "Edit".into(),
            // A stated reason displaced the hook's sentence into `change`.
            change: format!("Claude Edit on {file}"),
            agent_id: "Claude".into(),
            developer_handle: "ashiqwayanad007".into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_hook_sentence_about_a_tool_call_is_not_a_reason() {
        assert!(!is_stated_reason(&hook_capture("src/lib.rs", 10)));
        // The other mechanical form the hook writes.
        let mut other = hook_capture("src/lib.rs", 10);
        other.intent = "running Edit on lib.rs".into();
        assert!(!is_stated_reason(&other));
    }

    #[test]
    fn declining_to_give_a_reason_is_not_a_reason() {
        let mut row = stated("src/lib.rs", 10, "x");
        row.intent = "Automatic pre-Edit snapshot; no reason was stated by the agent.".into();
        assert!(!is_stated_reason(&row));
    }

    #[test]
    fn a_reason_that_quotes_the_stub_while_explaining_it_survives() {
        // The first person to write about this behaviour quoted the hook's
        // sentence inside their own, and a `contains` test threw the whole
        // reason away — so the file they were fixing read as unexplained.
        let mut row = stated("src/lib.rs", 10, "x");
        row.intent = "The hook writes 'no reason was stated by the agent' even when \
                      somebody did, so the reader believed the stub and hid the \
                      sentence underneath it."
            .into();
        assert!(is_stated_reason(&row));
    }

    #[test]
    fn words_the_author_chose_are_a_reason() {
        assert!(is_stated_reason(&stated(
            "src/lib.rs",
            10,
            "switch retry to exponential backoff so we stop tripping the rate limit",
        )));
    }

    #[test]
    fn a_cli_row_with_no_tool_at_all_is_a_reason() {
        // `aura log-intent --writes` writes no `tool`; nothing displaced, because
        // no hook sentence existed to displace.
        let row = ReasonRow {
            timestamp: 10,
            intent: "regroup the CLI command reference under Trace/Crew/Control".into(),
            file: "README.md".into(),
            ..Default::default()
        };
        assert!(is_stated_reason(&row));
    }

    #[test]
    fn an_absolute_path_from_a_worktree_matches_the_relative_one() {
        assert!(matches_file(
            "/Users/x/.aura/worktrees/p-1/antigua/aura-cli/src/doctor.rs",
            "aura-cli/src/doctor.rs",
        ));
        assert!(matches_file("aura-cli/src/doctor.rs", "aura-cli/src/doctor.rs"));
        assert!(matches_file("./README.md", "README.md"));
    }

    #[test]
    fn a_path_that_merely_ends_the_same_way_does_not_match() {
        // `.../my-doctor.rs` shares a suffix with `doctor.rs` but is another file.
        assert!(!matches_file("/repo/src/my-doctor.rs", "doctor.rs"));
        assert!(!matches_file("/repo/other/doctor.rs", "src/doctor.rs"));
    }

    #[test]
    fn the_newest_reason_inside_the_window_wins() {
        let rows = vec![
            stated("src/lib.rs", 100, "first pass at the guard"),
            hook_capture("src/lib.rs", 150),
            stated("src/lib.rs", 200, "make the guard fail closed"),
        ];
        let got = reason_for_file(&rows, "src/lib.rs", None, None).expect("a reason");
        assert_eq!(got.text, "make the guard fail closed");
        assert_eq!(got.stated_at, 200);
        assert_eq!(got.author, "ashiqwayanad007");
    }

    #[test]
    fn a_later_edits_reason_cannot_explain_an_earlier_commit() {
        // This is the whole point of the window: the commit under review ran
        // between 100 and 200, and the reason written at 300 belongs to the edit
        // that came after it.
        let rows = vec![
            stated("src/lib.rs", 150, "make the guard fail closed"),
            stated("src/lib.rs", 300, "delete the guard, it was never reached"),
        ];
        let got = reason_for_file(&rows, "src/lib.rs", Some(100), Some(200)).expect("a reason");
        assert_eq!(got.text, "make the guard fail closed");
    }

    #[test]
    fn a_reason_for_another_file_is_never_borrowed() {
        let rows = vec![stated("src/other.rs", 100, "unrelated work")];
        assert!(reason_for_file(&rows, "src/lib.rs", None, None).is_none());
    }

    #[test]
    fn a_file_nobody_explained_reports_nothing_rather_than_inventing() {
        let rows = vec![hook_capture("src/lib.rs", 100), hook_capture("src/lib.rs", 200)];
        assert!(reason_for_file(&rows, "src/lib.rs", None, None).is_none());
    }
}
