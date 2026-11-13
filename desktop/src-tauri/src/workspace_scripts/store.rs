//! Where a workspace's setup and archive runs are kept: one folder per
//! workspace under `~/.aura/workspace-scripts/`, holding each run's record
//! (`setup.json`) and everything it printed (`setup.log`). This is machine
//! state, so it lives in the home folder and never in a repository's `.aura/`.
//! Keyed by the workspace's path, so an archive run's output outlives the
//! workspace it ran in.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use super::{ScriptKind, ScriptRun};

/// How much of a log the app reads back at once — the end of it.
pub const LOG_TAIL_BYTES: u64 = 256 * 1024;
/// A run stops writing to its log past this size and says so once.
pub const LOG_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// `~/.aura/workspace-scripts`, or `None` when there is no home folder.
pub fn root() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".aura").join("workspace-scripts"))
}

/// PURE: the folder name for a workspace — FNV-1a of its path, so any path
/// becomes a short, stable, filesystem-safe name.
pub fn key_for(worktree_path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in worktree_path.trim_end_matches('/').as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

pub fn dir_for(root: &Path, worktree_path: &str) -> PathBuf {
    root.join(key_for(worktree_path))
}

fn record_path(dir: &Path, kind: ScriptKind) -> PathBuf {
    dir.join(format!("{}.json", kind.as_str()))
}

fn log_path(dir: &Path, kind: ScriptKind) -> PathBuf {
    dir.join(format!("{}.log", kind.as_str()))
}

/// Save a run's record, replacing the last one whole (write then rename, so a
/// reader never sees half a record).
pub fn write_record(dir: &Path, run: &ScriptRun) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let json = serde_json::to_vec_pretty(run).map_err(io::Error::other)?;
    let tmp = dir.join(format!(".{}.json.tmp", run.kind.as_str()));
    fs::write(&tmp, json)?;
    fs::rename(tmp, record_path(dir, run.kind))
}

pub fn read_record(dir: &Path, kind: ScriptKind) -> Option<ScriptRun> {
    let bytes = fs::read(record_path(dir, kind)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Start a fresh, empty log for a new run.
pub fn reset_log(dir: &Path, kind: ScriptKind) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    File::create(log_path(dir, kind)).map(|_| ())
}

/// Appends a run's output to its log, up to [`LOG_MAX_BYTES`].
pub struct LogWriter {
    file: Option<File>,
    written: u64,
    capped: bool,
}

impl LogWriter {
    pub fn open(dir: &Path, kind: ScriptKind) -> Self {
        let file = OpenOptions::new().create(true).append(true).open(log_path(dir, kind)).ok();
        let written = file.as_ref().and_then(|f| f.metadata().ok()).map_or(0, |m| m.len());
        Self { file, written, capped: false }
    }

    /// A writer that keeps nothing (no home folder to keep it in).
    pub fn none() -> Self {
        Self { file: None, written: 0, capped: false }
    }

    pub fn append(&mut self, bytes: &[u8]) {
        let Some(file) = self.file.as_mut() else { return };
        if self.capped {
            return;
        }
        if self.written + bytes.len() as u64 > LOG_MAX_BYTES {
            self.capped = true;
            let _ = file.write_all(b"\n[output past 8 MB was not kept]\n");
            return;
        }
        if file.write_all(bytes).is_ok() {
            self.written += bytes.len() as u64;
        }
    }
}

/// The end of a run's log, at most `max` bytes, starting on a whole line.
pub fn read_log_tail(dir: &Path, kind: ScriptKind, max: u64) -> String {
    let Ok(mut file) = File::open(log_path(dir, kind)) else {
        return String::new();
    };
    let len = file.metadata().map_or(0, |m| m.len());
    let cut = len > max;
    if cut && file.seek(SeekFrom::Start(len - max)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if !cut {
        return text;
    }
    match text.find('\n') {
        Some(i) => text[i + 1..].to_string(),
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::super::ScriptStatus;
    use super::*;

    fn run(kind: ScriptKind) -> ScriptRun {
        ScriptRun {
            kind,
            worktree_path: "/w/a".into(),
            command: "echo hi".into(),
            status: ScriptStatus::Completed,
            started_at: 1,
            ended_at: Some(2),
            exit_code: Some(0),
            reason: None,
        }
    }

    #[test]
    fn a_path_always_maps_to_the_same_short_folder() {
        assert_eq!(key_for("/w/a"), key_for("/w/a/"));
        assert_ne!(key_for("/w/a"), key_for("/w/b"));
        assert_eq!(key_for("/w/a").len(), 16);
    }

    #[test]
    fn a_record_round_trips_and_setup_and_archive_keep_their_own() {
        let dir = tempfile::tempdir().unwrap();
        write_record(dir.path(), &run(ScriptKind::Setup)).unwrap();
        assert_eq!(read_record(dir.path(), ScriptKind::Setup), Some(run(ScriptKind::Setup)));
        assert_eq!(read_record(dir.path(), ScriptKind::Archive), None);
    }

    #[test]
    fn the_log_tail_starts_on_a_whole_line() {
        let dir = tempfile::tempdir().unwrap();
        reset_log(dir.path(), ScriptKind::Setup).unwrap();
        let mut w = LogWriter::open(dir.path(), ScriptKind::Setup);
        w.append(b"first line\nsecond line\nthird\n");
        assert_eq!(read_log_tail(dir.path(), ScriptKind::Setup, 1024), "first line\nsecond line\nthird\n");
        assert_eq!(read_log_tail(dir.path(), ScriptKind::Setup, 16), "third\n");
        reset_log(dir.path(), ScriptKind::Setup).unwrap();
        assert_eq!(read_log_tail(dir.path(), ScriptKind::Setup, 1024), "");
    }
}
