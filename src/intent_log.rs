//! Appending to `.aura/intent_log.jsonl` without shredding it.
//!
//! # What was broken
//!
//! Two writers — `aura save` and `aura log-intent` — each appended a row with
//! `writeln!(file, "{}", entry)`. That reads like one line but is not one
//! write: `write!`-family macros hand the formatter each piece separately, so
//! a serialised JSON object goes to the file as a long series of small writes
//! and the newline as one more. Two processes appending at the same moment
//! therefore interleave *inside* a line, and the result is not JSON at all:
//!
//! ```text
//! {{""agent_idagent_id""::""CodexCodex"",",intent""intent:""Codex patch …
//! ```
//!
//! Both rows are lost, and so is every consumer of the file — `aura intents
//! push` skips what it cannot parse, so the work silently never reaches the
//! team.
//!
//! This is not a rare race. The hook fires once per tool call and returns
//! immediately by backgrounding the CLI (`aura log-intent … &`), and agents
//! run tool calls in parallel, so two of these processes overlapping is the
//! normal case rather than the unlucky one.
//!
//! # The fix
//!
//! Build the whole line, newline included, and hand it to the kernel in a
//! single `write_all` on a file opened with `O_APPEND`. One write of a short
//! line under append mode lands whole, which is exactly the guarantee JSONL
//! needs and the only one it needs.

use std::io::Write;
use std::path::Path;

/// The log's name inside a repo's `.aura` directory.
pub const FILE_NAME: &str = "intent_log.jsonl";

/// Append one row to `<repo_root>/.aura/intent_log.jsonl`.
///
/// Creates `.aura` if it is missing, so a hook firing in a repo that has never
/// been touched by Aura still records the work.
pub fn append(repo_root: &Path, entry: &serde_json::Value) -> std::io::Result<()> {
    let dir = repo_root.join(".aura");
    std::fs::create_dir_all(&dir)?;
    append_to(&dir.join(FILE_NAME), entry)
}

/// Append one row to a named log file.
///
/// Split out so the concurrency test can point at a scratch file, and so the
/// two callers that already hold a path do not have to reconstruct a root.
pub fn append_to(path: &Path, entry: &serde_json::Value) -> std::io::Result<()> {
    // One string, one write. Serialising into the file instead would issue a
    // write per JSON token and put us straight back where we started.
    let mut line = entry.to_string();
    line.push('\n');

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(line.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_row_is_one_line_of_json() {
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), &serde_json::json!({"intent": "did a thing"})).unwrap();
        append(dir.path(), &serde_json::json!({"intent": "did another"})).unwrap();

        let body = std::fs::read_to_string(dir.path().join(".aura").join(FILE_NAME)).unwrap();
        let rows: Vec<&str> = body.lines().collect();
        assert_eq!(rows.len(), 2);
        for row in rows {
            let parsed: serde_json::Value = serde_json::from_str(row).expect("each line is JSON");
            assert!(parsed["intent"].is_string());
        }
    }

    #[test]
    fn rows_written_at_the_same_moment_do_not_shred_each_other() {
        // The real shape of the bug: the hook backgrounds this write, agents
        // make tool calls in parallel, and the losing interleave produces a
        // file where *neither* row survives. Sixteen threads is enough to lose
        // reliably with the old `writeln!`-per-token write.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");

        std::thread::scope(|s| {
            for i in 0..16 {
                let path = path.clone();
                s.spawn(move || {
                    for j in 0..16 {
                        let row = serde_json::json!({
                            "agent_id": "Codex",
                            "intent": format!("worker {i} row {j} — long enough to straddle a buffer boundary if this were written a token at a time"),
                            "timestamp": 1_787_574_296i64 + j,
                            "session_id": format!("session-{i}"),
                        });
                        append_to(&path, &row).expect("append");
                    }
                });
            }
        });

        let body = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 16 * 16, "every row is exactly one line");
        for line in lines {
            serde_json::from_str::<serde_json::Value>(line)
                .unwrap_or_else(|e| panic!("a row was shredded by a concurrent write: {e}\n{line}"));
        }
    }
}
