//! What a recovery would do, said before it does it.
//!
//! `aura rewind` decided and wrote in one motion. The only way to find out
//! what it would put in your file was to let it. That is a bad bargain for
//! the one verb whose whole job is undoing something you did not want, and it
//! is the reason the desktop's "Bring this back" button could only offer a
//! name and a filename and ask you to trust it.
//!
//! Two other things were decided silently. A name can belong to more than one
//! thing in a file — a Rust struct and its `impl` block, two methods on
//! different classes, an overload pair — and the walk took whichever it
//! reached first, making a choice nobody asked for. And a rewind takes a
//! safety snapshot it then never offers back, so "you can undo this too" was
//! true of the data and false of the interface.
//!
//! This module is the vocabulary for all three, and deliberately free of git,
//! disk and process exits: it shapes what a caller already gathered.

use std::ops::Range;

use serde_json::{json, Value};

use crate::rewind_search::{Candidate, Origin};

/// The trigger label a rewind's mandatory safety snapshot is filed under.
/// Undoing a recovery means finding this and nothing else — an ordinary
/// pre-edit snapshot is somebody's work, not the thing the rewind displaced.
pub const PRE_REWIND_TRIGGER: &str = "pre_rewind";

/// One node in the current file carrying the name that was asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolMatch {
    /// The node's own source.
    pub source: String,
    /// One-based line the node starts on, which is how a person will find it.
    pub line: usize,
    /// Its first line, trimmed — enough to tell a struct from its impl block.
    pub signature: String,
}

/// Put a line number and a readable first line on each parser match.
pub fn describe_matches(source: &str, matches: &[(String, Range<usize>)]) -> Vec<SymbolMatch> {
    matches
        .iter()
        .map(|(node_source, range)| {
            let line = source[..range.start.min(source.len())]
                .bytes()
                .filter(|b| *b == b'\n')
                .count()
                + 1;
            let signature = node_source
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("")
                .to_string();
            SymbolMatch {
                source: node_source.clone(),
                line,
                signature,
            }
        })
        .collect()
}

/// The refusal shown when the name does not identify one thing.
///
/// It names every candidate and the line it is on, because the person asking
/// knows which one they meant and the tool does not. Guessing here writes the
/// wrong function back into a file somebody is about to commit.
pub fn ambiguity_message(identifier: &str, file: &str, matches: &[SymbolMatch]) -> String {
    let mut out = format!(
        "'{}' names {} different things in {}, so Aura can't tell which one you mean:\n",
        identifier,
        matches.len(),
        file
    );
    for m in matches {
        out.push_str(&format!("  line {}: {}\n", m.line, truncate(&m.signature, 100)));
    }
    out.push_str("Nothing was changed. Open the file at one of those lines and bring that piece back from there.");
    out
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let kept: String = s.chars().take(max).collect();
    format!("{kept}…")
}

/// What one recovery would change, with nothing changed yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preview {
    pub identifier: String,
    pub file: String,
    /// The piece is not in the file at all right now — the case a pre-edit
    /// snapshot exists for. Then there is no "before" to show, and the
    /// recovery is a re-insertion rather than a replacement.
    pub deleted: bool,
    /// Where the version being brought back came from, in words.
    pub origin: String,
    /// The piece as it stands, absent when it was deleted.
    pub current: Option<String>,
    /// The piece as it would stand.
    pub restored: String,
    /// How many saved versions existed to choose from. More than one means a
    /// person could reasonably want an older one than the one offered.
    pub candidates_considered: usize,
}

impl Preview {
    /// True when applying this would leave the file exactly as it is. Worth
    /// saying out loud rather than reporting a recovery that recovered
    /// nothing.
    pub fn is_noop(&self) -> bool {
        match &self.current {
            Some(c) => c.trim_end() == self.restored.trim_end(),
            None => false,
        }
    }

    /// For the desktop, which renders the two versions side by side itself.
    pub fn to_json(&self) -> Value {
        json!({
            "identifier": self.identifier,
            "file": self.file,
            "deleted": self.deleted,
            "origin": self.origin,
            "current": self.current,
            "restored": self.restored,
            "candidates_considered": self.candidates_considered,
            "no_change": self.is_noop(),
        })
    }

    /// For the terminal. Says what would change and, plainly, what would not.
    pub fn render(&self) -> String {
        let mut out = String::new();
        if self.deleted {
            out.push_str(&format!(
                "'{}' is not in {} right now. Bringing it back would put it in again.\n",
                self.identifier, self.file
            ));
        } else {
            out.push_str(&format!(
                "'{}' in {} would go back to an earlier version.\n",
                self.identifier, self.file
            ));
        }
        out.push_str(&format!("  from: {}\n", self.origin));
        if self.candidates_considered > 1 {
            out.push_str(&format!(
                "  ({} saved versions exist; this is the most recent one that differs)\n",
                self.candidates_considered
            ));
        }
        if self.is_noop() {
            out.push_str("  This would change nothing — the saved version and the current one are the same.\n");
            return out;
        }
        if let Some(current) = &self.current {
            out.push_str(&format!("\n--- now ({} lines)\n", line_count(current)));
            out.push_str(current.trim_end());
            out.push('\n');
        }
        out.push_str(&format!(
            "\n+++ after ({} lines)\n",
            line_count(&self.restored)
        ));
        out.push_str(self.restored.trim_end());
        out.push('\n');
        out.push_str(&format!("\nNothing else in {} would change.\n", self.file));
        out
    }
}

fn line_count(s: &str) -> usize {
    s.trim_end().lines().count()
}

/// The candidate that undoes a recovery: the newest pre-rewind safety
/// snapshot.
///
/// A rewind always takes one before it writes, so the version it displaced is
/// always recoverable — but only this trigger is the right source. An
/// ordinary pre-edit snapshot holds somebody's work, and restoring from it
/// would undo their edit rather than Aura's. Returns the index into
/// `candidates`, which are already ordered newest first.
pub fn undo_candidate(candidates: &[Candidate]) -> Option<usize> {
    candidates.iter().position(|c| {
        matches!(&c.origin, Origin::Snapshot { trigger, .. } if trigger == PRE_REWIND_TRIGGER)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(origin: Origin) -> Candidate {
        Candidate {
            node_source: "fn a() {}".into(),
            file_source: None,
            origin,
        }
    }

    #[test]
    fn a_match_carries_the_line_a_person_would_scroll_to() {
        let src = "one\ntwo\nfn target() {}\n";
        let start = src.find("fn target").unwrap();
        let described = describe_matches(src, &[("fn target() {}".into(), start..src.len())]);
        assert_eq!(described[0].line, 3);
        assert_eq!(described[0].signature, "fn target() {}");
    }

    #[test]
    fn the_refusal_names_every_thing_the_name_could_mean() {
        let src = "struct Job {}\n\nimpl Job {}\n";
        let a = src.find("struct Job").unwrap();
        let b = src.find("impl Job").unwrap();
        let described = describe_matches(
            src,
            &[
                ("struct Job {}".into(), a..a + 13),
                ("impl Job {}".into(), b..b + 11),
            ],
        );
        let msg = ambiguity_message("Job", "src/job.rs", &described);

        assert!(msg.contains("2 different things"));
        assert!(msg.contains("line 1: struct Job {}"));
        assert!(msg.contains("line 3: impl Job {}"));
        // The half that matters most: it did not pick one anyway.
        assert!(msg.contains("Nothing was changed"));
    }

    #[test]
    fn a_preview_shows_both_versions_and_promises_nothing_else_moves() {
        let p = Preview {
            identifier: "total".into(),
            file: "src/bill.rs".into(),
            deleted: false,
            origin: "commit HEAD~2 (abc12345)".into(),
            current: Some("fn total() { 0 }".into()),
            restored: "fn total() { sum() }".into(),
            candidates_considered: 3,
        };
        let text = p.render();

        assert!(text.contains("--- now"));
        assert!(text.contains("+++ after"));
        assert!(text.contains("fn total() { 0 }"));
        assert!(text.contains("fn total() { sum() }"));
        assert!(text.contains("commit HEAD~2"));
        assert!(text.contains("Nothing else in src/bill.rs would change."));
        assert!(text.contains("3 saved versions exist"));
    }

    #[test]
    fn a_deleted_piece_is_described_as_coming_back_not_as_being_replaced() {
        let p = Preview {
            identifier: "total".into(),
            file: "src/bill.rs".into(),
            deleted: true,
            origin: "snapshot from 1789 (trigger: pre_edit)".into(),
            current: None,
            restored: "fn total() { sum() }".into(),
            candidates_considered: 1,
        };
        let text = p.render();

        assert!(text.contains("is not in src/bill.rs right now"));
        assert!(!text.contains("--- now"));
        assert!(text.contains("+++ after"));
    }

    #[test]
    fn a_recovery_that_would_change_nothing_says_so() {
        let p = Preview {
            identifier: "total".into(),
            file: "src/bill.rs".into(),
            deleted: false,
            origin: "commit HEAD (abc12345)".into(),
            current: Some("fn total() { 0 }\n".into()),
            restored: "fn total() { 0 }".into(),
            candidates_considered: 1,
        };
        assert!(p.is_noop());
        assert!(p.render().contains("would change nothing"));
        assert_eq!(p.to_json()["no_change"], json!(true));
    }

    #[test]
    fn the_json_carries_both_versions_for_the_desktop_to_draw() {
        let p = Preview {
            identifier: "total".into(),
            file: "src/bill.rs".into(),
            deleted: false,
            origin: "commit HEAD~2 (abc12345)".into(),
            current: Some("fn total() { 0 }".into()),
            restored: "fn total() { sum() }".into(),
            candidates_considered: 2,
        };
        let v = p.to_json();

        assert_eq!(v["current"], json!("fn total() { 0 }"));
        assert_eq!(v["restored"], json!("fn total() { sum() }"));
        assert_eq!(v["deleted"], json!(false));
        assert_eq!(v["candidates_considered"], json!(2));
    }

    #[test]
    fn undo_takes_the_rewinds_own_snapshot_and_not_somebody_elses_work() {
        let candidates = vec![
            candidate(Origin::Recorded {
                recorded_at: 9,
                recorded_by: "claude".into(),
            }),
            candidate(Origin::Snapshot {
                timestamp: 8,
                trigger: "pre_edit".into(),
            }),
            candidate(Origin::Snapshot {
                timestamp: 7,
                trigger: PRE_REWIND_TRIGGER.into(),
            }),
        ];
        // Not index 1: that snapshot holds a person's edit, and restoring it
        // would undo their work rather than Aura's recovery.
        assert_eq!(undo_candidate(&candidates), Some(2));
    }

    #[test]
    fn with_no_rewind_snapshot_there_is_nothing_to_undo() {
        let candidates = vec![candidate(Origin::Git {
            depth: 1,
            commit: "abc".into(),
        })];
        assert_eq!(undo_candidate(&candidates), None);
    }
}
