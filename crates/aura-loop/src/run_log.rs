//! The Crew **run ledger** — one durable record per `aura loop run`.
//!
//! The dependency graph (`.aura/a2a/`) holds the *current* state of every
//! node. It can't answer "what happened the last time I ran the crew?" — once
//! a node moves on, the previous run's shape is gone. The ledger fills that
//! gap: each run appends one JSON line to `.aura/crew/runs.jsonl` recording
//! who ran it, the scope (whole graph / one goal / one crew), how many nodes
//! it attempted, and the outcome + commit of each. That's what the surface's
//! "run history" reads and what lets a human (or an agent over MCP) see the
//! crew's track record, not just its live board.
//!
//! Append-on-finish: the record is built in memory across the run and written
//! as a single line when the run ends, so a crashed runner never leaves a
//! half-written record (the live truth is always the graph itself).

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// One node's result within a run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunNode {
    pub id: String,
    pub title: String,
    /// "completed" | "merged" | "failed" | "rolled-back" | "skipped".
    pub outcome: String,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
}

/// One run of the loop — the unit "run history" lists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    /// The runner that drove it (host + pid), so concurrent crews are told
    /// apart in the log.
    pub runner: String,
    /// Scope: the crew this run drained, if `--crew` was given.
    #[serde(default)]
    pub crew: Option<String>,
    /// Scope: the goal this run drained, if `--goal` was given.
    #[serde(default)]
    pub goal: Option<String>,
    /// Worker parallelism (`--jobs`).
    pub jobs: usize,
    pub started_at: i64,
    #[serde(default)]
    pub ended_at: Option<i64>,
    pub attempted: usize,
    pub completed: usize,
    pub failed: usize,
    pub nodes: Vec<RunNode>,
}

impl RunRecord {
    /// Open a fresh in-memory record for a run about to start.
    pub fn begin(
        runner: impl Into<String>,
        crew: Option<String>,
        goal: Option<String>,
        jobs: usize,
        now: i64,
    ) -> Self {
        Self {
            id: format!("run-{}", &Uuid::new_v4().to_string()[..8]),
            runner: runner.into(),
            crew,
            goal,
            jobs: jobs.max(1),
            started_at: now,
            ended_at: None,
            attempted: 0,
            completed: 0,
            failed: 0,
            nodes: Vec::new(),
        }
    }

    /// Record one node's outcome, keeping the running tallies in sync.
    pub fn push(&mut self, node: RunNode) {
        self.attempted += 1;
        match node.outcome.as_str() {
            "completed" | "merged" => self.completed += 1,
            "failed" | "rolled-back" => self.failed += 1,
            _ => {}
        }
        self.nodes.push(node);
    }

    /// Stamp the end time. Call right before `RunLedger::append`.
    pub fn finish(&mut self, now: i64) {
        self.ended_at = Some(now);
    }

    /// Wall-clock seconds, if finished.
    pub fn duration_secs(&self) -> Option<i64> {
        self.ended_at.map(|e| (e - self.started_at).max(0))
    }
}

/// File-backed run ledger under `<repo>/.aura/crew/runs.jsonl`.
pub struct RunLedger {
    path: PathBuf,
}

impl RunLedger {
    pub fn at(repo_root: &Path) -> Self {
        Self {
            path: repo_root.join(".aura").join("crew").join("runs.jsonl"),
        }
    }

    fn ensure_dir(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    /// Append one finished run as a single JSONL line.
    pub fn append(&self, record: &RunRecord) -> std::io::Result<()> {
        self.ensure_dir()?;
        let line = serde_json::to_string(record)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let mut f = OpenOptions::new().create(true).append(true).open(&self.path)?;
        writeln!(f, "{line}")
    }

    /// Every run, newest first. A malformed line is skipped, never fatal.
    pub fn list(&self) -> Vec<RunRecord> {
        let text = match fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(_) => return Vec::new(),
        };
        let mut out: Vec<RunRecord> = text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str::<RunRecord>(l).ok())
            .collect();
        out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        out
    }

    /// The most recent run, if any.
    pub fn latest(&self) -> Option<RunRecord> {
        self.list().into_iter().next()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp() -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!("aura-runlog-{}", Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn tallies_track_outcomes() {
        let mut r = RunRecord::begin("runner-1", None, Some("alerts".into()), 2, 100);
        r.push(RunNode { id: "a".into(), title: "A".into(), outcome: "completed".into(), commit: Some("abc".into()), detail: None });
        r.push(RunNode { id: "b".into(), title: "B".into(), outcome: "failed".into(), commit: None, detail: Some("boom".into()) });
        r.push(RunNode { id: "c".into(), title: "C".into(), outcome: "merged".into(), commit: Some("def".into()), detail: None });
        assert_eq!(r.attempted, 3);
        assert_eq!(r.completed, 2);
        assert_eq!(r.failed, 1);
    }

    #[test]
    fn append_then_list_is_newest_first() {
        let repo = tmp();
        let ledger = RunLedger::at(&repo);
        let mut older = RunRecord::begin("r", None, None, 1, 100);
        older.finish(150);
        ledger.append(&older).unwrap();
        let mut newer = RunRecord::begin("r", Some("main".into()), None, 4, 200);
        newer.finish(260);
        ledger.append(&newer).unwrap();

        let all = ledger.list();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].started_at, 200, "newest first");
        assert_eq!(all[0].duration_secs(), Some(60));
        assert_eq!(all[1].started_at, 100);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn malformed_line_is_skipped() {
        let repo = tmp();
        let ledger = RunLedger::at(&repo);
        ledger.ensure_dir().unwrap();
        fs::write(&ledger.path, "not json\n").unwrap();
        let mut ok = RunRecord::begin("r", None, None, 1, 10);
        ok.finish(20);
        ledger.append(&ok).unwrap();
        assert_eq!(ledger.list().len(), 1, "the good record still reads");
        let _ = fs::remove_dir_all(&repo);
    }
}
