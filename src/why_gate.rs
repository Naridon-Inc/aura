//! Every file in a commit has to carry a reason somebody wrote.
//!
//! Aura already knows the difference between a reason and the absence of one.
//! The auto-snapshot hook writes a row for every edit whether or not anybody
//! said why, and when nobody did the row reads *"Automatic pre-Edit snapshot;
//! no reason was stated by the agent."* — a sentence about the absence of a
//! reason, not a reason. Both readers that matter, `IntentRow::is_stated_reason`
//! here and `recorded_reason` in the desktop shell, refuse to serve it as one.
//!
//! What nothing did was ask. The commit went through, the file landed, and the
//! only trace of the missing why was a row that said so, discovered later by a
//! person reading the log and wondering why the change had no explanation. Ten
//! files can go in behind one commit message and nine of them can be silent.
//!
//! This is the gate that asks, at the one moment where asking still costs
//! nothing to answer: before the commit. It is deliberately free of git, I/O
//! and process exits — it answers two questions and the caller in `main.rs`
//! decides what to do with the answer:
//!
//!   1. `unexplained_writes` — which staged files has nobody explained?
//!   2. `fix_instruction` — the exact command that makes them explained.
//!
//! (2) is the point. A gate that only says no teaches an agent to reach for
//! the escape hatch; a gate that hands back the command it wants run teaches
//! it to state the reason. The returned command already names the files, so an
//! agent that fills in the sentence and runs it verbatim clears the gate on the
//! next attempt. The round-trip is asserted below so the two cannot drift.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::intent_query::parse_intent_line;

/// How many paths the handed-back command spells out before it summarises.
const MAX_PATHS_IN_INSTRUCTION: usize = 12;

/// A repo-relative path with the noise a caller might have left on it removed,
/// so `./src/a.rs` and `src/a.rs ` are the one path they obviously are.
///
/// Shared with `intent_reconcile`, which asks the neighbouring question — did
/// the commit stay inside what was declared — off the same `writes_paths`
/// rows. Two guards reading one log with two ideas of what a path is would
/// disagree about the same file, and the disagreement would look like a bug in
/// whichever one the reader happened to hit.
pub(crate) fn normalize_path(path: &str) -> String {
    path.trim()
        .trim_start_matches("./")
        .trim_end_matches('/')
        .to_string()
}

/// The paths one log line claims a reason for, empty when the line states no
/// reason at all or predates `since`.
///
/// A row claims paths two ways: `--file` names the single file a hook was
/// writing about, and `--writes` names the set a commit-shaped reason covers.
/// Both count. The `writes_paths` array is read off the raw JSON because the
/// typed row does not carry it, and re-deriving the stated-reason rule here
/// instead of asking `parse_intent_line` for it is exactly how two readers
/// come to disagree about what a reason is.
fn claimed_paths(line: &str, since: u64) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let row = match parse_intent_line(line) {
        Some(r) => r,
        None => return out,
    };
    // A reason written before the last commit already answered for that
    // commit. It is not an answer for this one.
    if row.timestamp < since || !row.is_stated_reason() {
        return out;
    }
    if let Some(f) = row.file.as_deref() {
        let p = normalize_path(f);
        if !p.is_empty() {
            out.insert(p);
        }
    }
    if let Ok(v) = serde_json::from_str::<Value>(line) {
        if let Some(arr) = v.get("writes_paths").and_then(|w| w.as_array()) {
            for p in arr.iter().filter_map(|p| p.as_str()) {
                let p = normalize_path(p);
                if !p.is_empty() {
                    out.insert(p);
                }
            }
        }
    }
    out
}

/// Does anything in `claimed` speak for this staged path?
///
/// Exact match, or a claim that is the tail of the staged path at a directory
/// boundary. The second case is not laxity: an agent working inside
/// `aura-shell/` naturally writes `src/lib/thing.ts`, and refusing that would
/// reject a reason that was actually given — which is the failure this gate
/// exists to prevent, only inverted. A tail match cannot silently cover a
/// different file, because the segments that remain must match exactly.
///
/// `intent_reconcile` asks this of a declared scope rather than a stated
/// reason; the question — is this staged path spoken for by one of these
/// claims — is the same one.
pub(crate) fn covered_by(claimed: &BTreeSet<String>, staged: &str) -> bool {
    if claimed.contains(staged) {
        return true;
    }
    claimed
        .iter()
        .any(|c| !c.is_empty() && staged.ends_with(&format!("/{c}")))
}

/// Staged paths nobody has stated a reason for, in the order they were staged.
///
/// `log_text` is the whole of `.aura/intent_log.jsonl`; `since` is the commit
/// time of `HEAD`, so only reasons written for THIS change count. Unparseable
/// lines are skipped rather than fatal — a corrupt row must not decide that
/// every file in the commit is unexplained.
pub fn unexplained_writes(log_text: &str, staged: &[String], since: u64) -> Vec<String> {
    let mut claimed: BTreeSet<String> = BTreeSet::new();
    for line in log_text.lines() {
        claimed.extend(claimed_paths(line, since));
    }
    staged
        .iter()
        .map(|p| normalize_path(p))
        .filter(|p| !p.is_empty())
        .filter(|p| !covered_by(&claimed, p))
        .collect()
}

/// The exact command that makes these files explained. Already carries the
/// paths, so only the sentence is left to write.
pub fn fix_instruction(paths: &[String]) -> String {
    if paths.is_empty() {
        return "aura log-intent --type <FeatureAdd|BugFix|Refactor|…> \"<what changed and why>\" --writes <paths>"
            .to_string();
    }
    let shown = paths.len().min(MAX_PATHS_IN_INSTRUCTION);
    let mut list = paths
        .iter()
        .take(shown)
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join(",");
    if paths.len() > shown {
        list.push_str(",…");
    }
    format!(
        "aura log-intent --type <FeatureAdd|BugFix|Refactor|…> \"<what these changed and why>\" --writes {list}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A row the hook writes when nobody said why: the intent text IS the
    /// mechanical description, and no `why_stated_at` was stamped.
    fn hook_stub(ts: u64, file: &str) -> String {
        format!(
            r#"{{"timestamp":{ts},"agent_id":"hook_auto","intent":"Claude Edit on {file}","change":"Claude Edit on {file}","file":"{file}"}}"#
        )
    }

    /// A row somebody wrote a reason into, covering a whole set of files.
    fn stated(ts: u64, why: &str, writes: &[&str]) -> String {
        let arr = writes
            .iter()
            .map(|w| format!("\"{w}\""))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            r#"{{"timestamp":{ts},"agent_id":"claude","intent":"{why}","writes_paths":[{arr}]}}"#
        )
    }

    fn paths(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_stated_reason_speaks_for_every_file_it_names() {
        let log = stated(200, "the resume button stopped lying", &["a.rs", "b.rs"]);
        assert!(unexplained_writes(&log, &paths(&["a.rs", "b.rs"]), 100).is_empty());
    }

    #[test]
    fn the_hooks_own_sentence_about_an_edit_is_not_a_reason() {
        // This is the exact shape that let nine silent files ride behind one
        // commit message: a row exists for the file, and it explains nothing.
        let log = hook_stub(200, "a.rs");
        assert_eq!(unexplained_writes(&log, &paths(&["a.rs"]), 100), vec!["a.rs"]);
    }

    #[test]
    fn declining_to_give_a_reason_is_not_a_reason() {
        let log = format!(
            r#"{{"timestamp":200,"agent_id":"hook_auto","intent":"Automatic pre-Edit snapshot; no reason was stated by the agent.","change":"Automatic pre-Edit snapshot; no reason was stated by the agent.","file":"a.rs"}}"#
        );
        assert_eq!(unexplained_writes(&log, &paths(&["a.rs"]), 100), vec!["a.rs"]);
    }

    #[test]
    fn the_stub_is_still_the_stub_when_the_hook_stamps_a_time_on_it() {
        // The shape every real hook row has, and the one that would have made
        // this gate enforce nothing: `why_stated_at` is set, `change` differs
        // from `intent`, and the sentence is still about not having a reason.
        let log = r#"{"timestamp":200,"agent_id":"Claude","intent":"Automatic pre-Edit snapshot; no reason was stated by the agent.","change":"Claude Edit on a.rs","why_stated_at":199,"file":"a.rs","tool":"Edit"}"#;
        assert_eq!(unexplained_writes(log, &paths(&["a.rs"]), 100), vec!["a.rs"]);
    }

    #[test]
    fn a_reason_from_before_the_last_commit_does_not_answer_for_this_one() {
        // Otherwise a file explained once is explained forever, and the second
        // change to it rides in on the first change's sentence.
        let log = stated(50, "why the first change happened", &["a.rs"]);
        assert_eq!(unexplained_writes(&log, &paths(&["a.rs"]), 100), vec!["a.rs"]);
    }

    #[test]
    fn only_the_unexplained_files_are_named() {
        let log = format!("{}\n{}", stated(200, "why b changed", &["b.rs"]), hook_stub(201, "a.rs"));
        assert_eq!(
            unexplained_writes(&log, &paths(&["a.rs", "b.rs"]), 100),
            vec!["a.rs"]
        );
    }

    #[test]
    fn a_path_written_from_inside_a_subdirectory_still_counts() {
        // An agent working in `aura-shell/` writes the path it sees. Rejecting
        // that would be this gate refusing a reason that was actually given.
        let log = stated(200, "why it changed", &["src/lib/thing.ts"]);
        assert!(unexplained_writes(&log, &paths(&["aura-shell/src/lib/thing.ts"]), 100).is_empty());
    }

    #[test]
    fn a_tail_that_is_not_a_whole_path_segment_explains_nothing() {
        let log = stated(200, "why it changed", &["ing.ts"]);
        assert_eq!(
            unexplained_writes(&log, &paths(&["aura-shell/src/thing.ts"]), 100),
            vec!["aura-shell/src/thing.ts"]
        );
    }

    #[test]
    fn a_single_file_reason_speaks_for_that_file() {
        let log = r#"{"timestamp":200,"agent_id":"claude","intent":"why it changed","change":"Claude Edit on a.rs","why_stated_at":199,"file":"a.rs"}"#;
        assert!(unexplained_writes(log, &paths(&["a.rs"]), 100).is_empty());
    }

    #[test]
    fn a_corrupt_row_does_not_condemn_the_whole_commit() {
        let log = format!("not json at all\n{}", stated(200, "why", &["a.rs"]));
        assert!(unexplained_writes(&log, &paths(&["a.rs"]), 100).is_empty());
    }

    #[test]
    fn surface_noise_on_a_path_is_not_a_different_path() {
        let log = stated(200, "why", &[" ./a.rs "]);
        assert!(unexplained_writes(&log, &paths(&["a.rs"]), 100).is_empty());
    }

    #[test]
    fn the_handed_back_command_names_the_files_it_is_about() {
        let missing = paths(&["a.rs", "b.rs"]);
        let cmd = fix_instruction(&missing);

        assert!(cmd.contains("--writes a.rs,b.rs"));
        assert!(cmd.contains("--type"));
    }

    #[test]
    fn running_the_handed_back_command_actually_clears_the_gate() {
        // The round-trip: reject, run what we handed back, retry, pass. A gate
        // whose fix does not fix is a wall with instructions painted on it.
        let missing = unexplained_writes("", &paths(&["a.rs", "b.rs"]), 100);
        assert_eq!(missing.len(), 2);

        let cmd = fix_instruction(&missing);
        let declared: Vec<&str> = cmd
            .split("--writes ")
            .nth(1)
            .expect("the command declares a write set")
            .split(',')
            .collect();
        let log = stated(200, "the reason the agent filled in", &declared);

        assert!(unexplained_writes(&log, &paths(&["a.rs", "b.rs"]), 100).is_empty());
    }

    #[test]
    fn a_long_list_is_summarised_rather_than_unreadable() {
        let many: Vec<String> = (0..30).map(|i| format!("f{i}.rs")).collect();
        let cmd = fix_instruction(&many);

        assert!(cmd.contains("f0.rs"));
        assert!(cmd.ends_with(",…"));
    }
}
