//! What Aura knows about one symbol, gathered from the stores that hold it.
//!
//! `aura trace parse_tree` answered `No trace found for 'parse_tree'` on a
//! repo whose Code Map was drawing that symbol at the time, and finished with
//! a promise of "full team trace available in v0.14" on a build numbered
//! 0.19. It was not looking anywhere that a symbol's history is kept: it
//! searched the free-text `intent` field of the intent log for the name, and
//! then searched snapshot file contents for the name as a bare substring. A
//! function nobody happened to spell out in a commit message therefore had no
//! history at all, while the same function had recorded bodies, checkpoint
//! nodes and snapshots sitting on disk.
//!
//! This gathers the four records that actually track a symbol:
//!
//!   - **Recorded bodies** — `.aura/function_history/`, one line per state of
//!     the function, stamped with who was working. Since the log stopped
//!     being thrown away this is the densest record of the four.
//!   - **Checkpoints** — a semantic capture names every node it saw with a
//!     content hash, so a hash that changes between two captures is the
//!     symbol changing, and the checkpoint says with what intent and by whom.
//!   - **Snapshots** — pre-edit copies of a defining file.
//!   - **Intent rows** — the reason written for a change, matched on the
//!     files an intent declared it wrote rather than on whether the prose
//!     happened to mention the symbol.
//!
//! ## What it will not do
//!
//! Read the whole checkpoint store. On this repo that is 423 notes and 4.4 GB
//! for about fourteen seconds of work, which is how `aura doctor` came to
//! hang. A trace reads a bounded prefix and reports how much of the store it
//! looked at, so a thin answer is legible as a thin answer rather than
//! passing for an absence of history.

use std::collections::{BTreeSet, HashMap};

use git2::Repository;

use crate::checkpoint::SnapshotStore;
use crate::function_history::FunctionHistory;

/// How wide one reason may be on a timeline row before it is cut.
pub const SUMMARY_WIDTH: usize = 96;

/// How many of the newest checkpoints a trace reads before stopping.
pub const DEFAULT_CHECKPOINT_LOOKBACK: usize = 40;

/// Which store an observation came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// A body Aura recorded for this function.
    Recorded,
    /// A semantic checkpoint in which the symbol's content hash changed.
    Checkpoint,
    /// A pre-edit file snapshot of a file that defines the symbol.
    Snapshot,
    /// An intent row that declared it wrote a file defining the symbol.
    Intent,
}

impl Source {
    pub fn label(&self) -> &'static str {
        match self {
            Source::Recorded => "recorded",
            Source::Checkpoint => "checkpoint",
            Source::Snapshot => "snapshot",
            Source::Intent => "intent",
        }
    }
}

/// One thing Aura recorded about the symbol, at one moment.
#[derive(Debug, Clone)]
pub struct Sighting {
    /// Milliseconds since the epoch.
    pub at_ms: u64,
    pub source: Source,
    /// The file the symbol was in at the time.
    pub file: String,
    /// Who was working — an agent id or a git user. Empty when unrecorded.
    pub who: String,
    /// What was said about it: an intent, a snapshot trigger, or a note.
    /// One line — an intent is often several paragraphs, and a timeline whose
    /// rows are paragraphs is not a timeline.
    pub what: String,
}

/// The first line of a message, bounded, for a one-row-per-event listing.
fn one_line(text: &str, width: usize) -> String {
    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let more = text.lines().filter(|l| !l.trim().is_empty()).count() > 1;
    if first.chars().count() <= width && !more {
        return first.to_string();
    }
    let cut: String = first.chars().take(width).collect();
    format!("{}…", cut.trim_end())
}

/// Everything the local stores hold about one symbol.
#[derive(Debug, Clone, Default)]
pub struct Trace {
    /// Files that hold or have held the symbol, as far as the stores know.
    pub files: BTreeSet<String>,
    /// Newest first.
    pub sightings: Vec<Sighting>,
    /// How many checkpoints were read, and how many the store holds. When
    /// these differ the answer is bounded, not complete.
    pub checkpoints_read: usize,
    pub checkpoints_total: usize,
}

impl Trace {
    pub fn is_empty(&self) -> bool {
        self.sightings.is_empty()
    }

    /// How many sightings came from each store, for a caller that wants to
    /// say where an answer came from.
    pub fn by_source(&self) -> Vec<(Source, usize)> {
        let mut counts: Vec<(Source, usize)> = Vec::new();
        for s in &self.sightings {
            match counts.iter_mut().find(|(src, _)| *src == s.source) {
                Some((_, n)) => *n += 1,
                None => counts.push((s.source.clone(), 1)),
            }
        }
        counts
    }
}

/// Gather what is known about `symbol` in the repo at `repo`.
///
/// `lookback` bounds the checkpoint read. The two Aura stores are reached for
/// through the repo's working directory, the same way every other command
/// finds them.
pub fn trace(repo: &Repository, symbol: &str, lookback: usize) -> Trace {
    let history = FunctionHistory::open();
    let checkpoints = crate::checkpoint::CheckpointStore::latest_checkpoints(repo, lookback)
        .unwrap_or_default();
    let total = crate::checkpoint::CheckpointStore::count(repo);
    let intents = read_intents();
    let snapshots = SnapshotStore::get_all_snapshots();
    gather(
        symbol,
        &history,
        &checkpoints,
        &intents,
        &snapshots,
        checkpoints.len(),
        total,
    )
}

/// One row of `.aura/intent_log.jsonl`, reduced to what a trace needs.
#[derive(Debug, Clone)]
pub struct IntentRow {
    pub at_ms: u64,
    pub who: String,
    pub intent: String,
    pub files: Vec<String>,
}

fn read_intents() -> Vec<IntentRow> {
    let Ok(text) = std::fs::read_to_string(".aura/intent_log.jsonl") else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .map(|v| {
            // Timestamps in this log are seconds; everything else a trace
            // orders against is milliseconds.
            let at_ms = v["timestamp"].as_u64().unwrap_or(0).saturating_mul(1000);
            let mut files: Vec<String> = v["writes_paths"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|p| p.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            if let Some(f) = v["file"].as_str() {
                if !files.iter().any(|p| p == f) {
                    files.push(f.to_string());
                }
            }
            IntentRow {
                at_ms,
                who: v["agent_id"].as_str().unwrap_or("").to_string(),
                intent: v["intent"].as_str().unwrap_or("").to_string(),
                files,
            }
        })
        .collect()
}

/// The gathering itself, over records handed in.
///
/// Every store is a parameter so this can be exercised against a known
/// history. Reaching for them inside would make the result depend on whatever
/// repo the suite happened to run in.
pub fn gather(
    symbol: &str,
    history: &FunctionHistory,
    checkpoints: &[crate::checkpoint::CheckpointData],
    intents: &[IntentRow],
    snapshots: &[crate::checkpoint::FileSnapshot],
    checkpoints_read: usize,
    checkpoints_total: usize,
) -> Trace {
    let mut out = Trace {
        checkpoints_read,
        checkpoints_total,
        ..Default::default()
    };

    for entry in history.entries_for_symbol(symbol) {
        out.files.insert(entry.file_path.clone());
        out.sightings.push(Sighting {
            at_ms: entry.recorded_at,
            source: Source::Recorded,
            file: entry.file_path,
            who: entry.recorded_by,
            what: format!("body recorded ({})", short_hash(&entry.content_hash)),
        });
    }

    // A checkpoint is a sighting only where the symbol's hash differs from the
    // previous capture of the same file. Every capture names every node it
    // saw, so reporting all of them would turn "this function was touched
    // three times" into three hundred identical lines.
    let mut ordered: Vec<&crate::checkpoint::CheckpointData> = checkpoints.iter().collect();
    ordered.sort_by_key(|c| c.written_at_ms());
    let mut last_hash: HashMap<String, String> = HashMap::new();
    for cp in ordered {
        for node in &cp.ast_nodes {
            if node.identifier.as_deref() != Some(symbol) {
                continue;
            }
            let file = node.file_path.clone().unwrap_or_default();
            let hash = node.content_hash.to_string();
            out.files.insert(file.clone());
            let changed = match last_hash.get(&file) {
                Some(previous) => previous != &hash,
                None => true,
            };
            last_hash.insert(file.clone(), hash.clone());
            if !changed {
                continue;
            }
            out.sightings.push(Sighting {
                at_ms: cp.written_at_ms(),
                source: Source::Checkpoint,
                file,
                who: cp.agent_id.clone(),
                what: one_line(&cp.intent, SUMMARY_WIDTH),
            });
        }
    }

    // Snapshots and intents are matched on the files the symbol is known to
    // live in. Matching an intent on whether its prose spelled the symbol out
    // — which is all the old command did — finds only the changes somebody
    // happened to narrate, and misses every change that was merely made.
    for snap in snapshots {
        if !out.files.contains(&snap.file_path) {
            continue;
        }
        out.sightings.push(Sighting {
            at_ms: snap.timestamp,
            source: Source::Snapshot,
            file: snap.file_path.clone(),
            who: snap.agent_id.clone(),
            what: format!("file snapshot ({})", snap.trigger),
        });
    }

    for row in intents {
        let Some(file) = row.files.iter().find(|f| out.files.contains(*f)) else {
            continue;
        };
        out.sightings.push(Sighting {
            at_ms: row.at_ms,
            source: Source::Intent,
            file: file.clone(),
            who: row.who.clone(),
            what: one_line(&row.intent, SUMMARY_WIDTH),
        });
    }

    out.sightings.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
    out
}

fn short_hash(hash: &str) -> &str {
    &hash[..hash.len().min(8)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoint::{CheckpointData, FileSnapshot};
    use crate::function_history::Entry;

    fn history_with(entries: &[Entry]) -> (tempfile::TempDir, FunctionHistory) {
        let dir = tempfile::tempdir().expect("temp dir");
        let history = FunctionHistory::at(dir.path().join("function_history"));
        history.record(entries);
        (dir, history)
    }

    fn entry(file: &str, name: &str, body: &str, at: u64, who: &str) -> Entry {
        Entry {
            file_path: file.into(),
            function_name: name.into(),
            function_kind: "function".into(),
            content_hash: format!("{:x}", md5_like(body)),
            body: body.into(),
            recorded_at: at,
            recorded_by: who.into(),
        }
    }

    fn md5_like(s: &str) -> u64 {
        s.bytes().fold(1469598103934665603u64, |h, b| {
            (h ^ b as u64).wrapping_mul(1099511628211)
        })
    }

    /// Built from the JSON these records are on disk, so the fixtures cannot
    /// drift from the shape the real stores write.
    fn node(name: &str, file: &str, hash: &str) -> serde_json::Value {
        serde_json::json!({
            "node_id": format!("{file}#{name}"),
            "kind": "function_definition",
            "identifier": name,
            "content_hash": hash,
            "children": [],
            "dependencies": [],
            "derived_from": null,
            "file_path": file,
        })
    }

    /// Checkpoint stamps have to be plausible millisecond values: notes
    /// written before the unit was made uniform are in seconds, and
    /// `written_at_ms` promotes anything small enough to look like seconds.
    /// A fixture stamped `4_000` therefore comes back as `4_000_000`.
    const CP_EPOCH_MS: u64 = 1_788_000_000_000;

    fn checkpoint(
        at_ms: u64,
        who: &str,
        intent: &str,
        nodes: Vec<serde_json::Value>,
    ) -> CheckpointData {
        let at_ms = CP_EPOCH_MS + at_ms;
        serde_json::from_value(serde_json::json!({
            "id": format!("cp-{at_ms}"),
            "agent_id": who,
            "intent": intent,
            "ast_nodes": nodes,
            "timestamp": at_ms,
        }))
        .expect("a checkpoint record")
    }

    fn snapshot(file: &str, at_ms: u64) -> FileSnapshot {
        FileSnapshot {
            file_path: file.into(),
            content: "whatever".into(),
            timestamp: at_ms,
            trigger: "pre-edit".into(),
            agent_id: "claude".into(),
        }
    }

    #[test]
    fn a_function_with_recorded_bodies_has_a_trace_even_if_no_one_wrote_its_name_anywhere() {
        // The reported case in miniature: nothing in the intent prose mentions
        // the symbol, and the old command therefore reported no history at all
        // for a function it had every version of on disk.
        let (_dir, history) = history_with(&[
            entry("src/parser.rs", "parse_tree", "fn parse_tree() { 1 }", 1_000, "claude"),
            entry("src/parser.rs", "parse_tree", "fn parse_tree() { 2 }", 2_000, "ashiq"),
        ]);
        let intents = vec![IntentRow {
            at_ms: 1_500,
            who: "claude".into(),
            intent: "tidy up the module".into(),
            files: vec!["src/parser.rs".into()],
        }];

        let t = gather("parse_tree", &history, &[], &intents, &[], 0, 0);

        assert!(!t.is_empty());
        assert_eq!(
            t.sightings.iter().filter(|s| s.source == Source::Recorded).count(),
            2
        );
        assert!(t.files.contains("src/parser.rs"));
    }

    #[test]
    fn an_intent_is_matched_on_the_files_it_wrote_not_on_whether_it_named_the_symbol() {
        let (_dir, history) = history_with(&[entry(
            "src/parser.rs",
            "parse_tree",
            "fn parse_tree() {}",
            1_000,
            "claude",
        )]);
        let intents = vec![
            IntentRow {
                at_ms: 2_000,
                who: "claude".into(),
                intent: "no symbol named here at all".into(),
                files: vec!["src/parser.rs".into()],
            },
            IntentRow {
                at_ms: 3_000,
                who: "claude".into(),
                intent: "mentions parse_tree but touched another file".into(),
                files: vec!["src/unrelated.rs".into()],
            },
        ];

        let t = gather("parse_tree", &history, &[], &intents, &[], 0, 0);

        let reasons: Vec<&str> = t
            .sightings
            .iter()
            .filter(|s| s.source == Source::Intent)
            .map(|s| s.what.as_str())
            .collect();
        assert_eq!(reasons, vec!["no symbol named here at all"]);
    }

    #[test]
    fn a_checkpoint_is_a_sighting_only_where_the_symbol_actually_changed() {
        let (_dir, history) = history_with(&[]);
        let checkpoints = vec![
            checkpoint(1_000, "claude", "first capture", vec![node("parse_tree", "src/p.rs", "aaa")]),
            checkpoint(2_000, "claude", "unrelated work", vec![node("parse_tree", "src/p.rs", "aaa")]),
            checkpoint(3_000, "ashiq", "rewrote the parser", vec![node("parse_tree", "src/p.rs", "bbb")]),
        ];

        let t = gather("parse_tree", &history, &checkpoints, &[], &[], 3, 3);

        let intents: Vec<&str> = t
            .sightings
            .iter()
            .filter(|s| s.source == Source::Checkpoint)
            .map(|s| s.what.as_str())
            .collect();
        assert_eq!(
            intents,
            vec!["rewrote the parser", "first capture"],
            "the capture that changed nothing is not a change"
        );
    }

    #[test]
    fn a_symbol_the_stores_have_never_seen_reports_nothing_rather_than_something_nearby() {
        let (_dir, history) = history_with(&[entry(
            "src/parser.rs",
            "parse_tree",
            "fn parse_tree() {}",
            1_000,
            "claude",
        )]);
        let snapshots = vec![snapshot("src/parser.rs", 900)];

        let t = gather("write_tree", &history, &[], &[], &snapshots, 0, 0);

        assert!(t.is_empty());
        assert!(t.files.is_empty(), "another symbol's file is not this one's");
    }

    #[test]
    fn snapshots_of_a_defining_file_are_part_of_the_trace() {
        let (_dir, history) = history_with(&[entry(
            "src/parser.rs",
            "parse_tree",
            "fn parse_tree() {}",
            1_000,
            "claude",
        )]);
        let snapshots = vec![snapshot("src/parser.rs", 500), snapshot("src/other.rs", 600)];

        let t = gather("parse_tree", &history, &[], &[], &snapshots, 0, 0);

        let files: Vec<&str> = t
            .sightings
            .iter()
            .filter(|s| s.source == Source::Snapshot)
            .map(|s| s.file.as_str())
            .collect();
        assert_eq!(files, vec!["src/parser.rs"]);
    }

    #[test]
    fn sightings_come_back_newest_first_across_every_store() {
        let (_dir, history) = history_with(&[entry(
            "src/p.rs",
            "parse_tree",
            "fn parse_tree() {}",
            CP_EPOCH_MS + 2_000,
            "claude",
        )]);
        let checkpoints = vec![checkpoint(
            4_000,
            "claude",
            "capture",
            vec![node("parse_tree", "src/p.rs", "aaa")],
        )];
        let snapshots = vec![snapshot("src/p.rs", CP_EPOCH_MS + 1_000)];
        let intents = vec![IntentRow {
            at_ms: CP_EPOCH_MS + 3_000,
            who: "claude".into(),
            intent: "reason".into(),
            files: vec!["src/p.rs".into()],
        }];

        let t = gather("parse_tree", &history, &checkpoints, &intents, &snapshots, 1, 1);

        let order: Vec<u64> = t.sightings.iter().map(|s| s.at_ms - CP_EPOCH_MS).collect();
        assert_eq!(
            order,
            vec![4_000, 3_000, 2_000, 1_000],
            "checkpoint, then intent, then recorded body, then snapshot"
        );
    }

    #[test]
    fn a_bounded_read_says_how_much_of_the_store_it_looked_at() {
        let (_dir, history) = history_with(&[]);

        let t = gather("parse_tree", &history, &[], &[], &[], 40, 423);

        assert_eq!(t.checkpoints_read, 40);
        assert_eq!(t.checkpoints_total, 423);
    }
}
