//! What the allowlist refused, written down where a person can read it.
//!
//! A wall that silently drops packets produces a bug report that says "it hangs".
//! Everything this module exists for is the other half of a refusal: the work is
//! told, in words, on the spot ([`crate::broker`] answers `403` with a sentence),
//! and the attempt is appended here so the surface that started the run can say
//! afterwards *which* machine the agent wanted and how often — which is either
//! one line to add to the project's spec, or the first thing anybody has ever
//! seen of a prompt injection trying to leave.
//!
//! Refusals only. A log of everything permitted would be a second copy of the
//! traffic, on disk, in the member's home, and the interesting line would be
//! somewhere in it.

use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// How the work asked for the machine it was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Via {
    /// `CONNECT host:443` — a TLS tunnel, which is nearly everything.
    Connect,
    /// A plain proxied request, which names its host in the request line.
    Http,
}

/// One refusal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Refusal {
    /// Unix seconds. Wall-clock rather than monotonic because the reader is a
    /// person on another machine asking "when did this start".
    pub at: u64,
    pub host: String,
    pub port: u16,
    pub via: Via,
}

impl Refusal {
    /// Read a journal back.
    ///
    /// A line that will not parse is skipped rather than fatal: this file is
    /// appended to by a process that may have been killed mid-write, and half a
    /// row must not cost the reader the other thousand.
    pub fn read(text: &str) -> Vec<Refusal> {
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str::<Refusal>(l).ok())
            .collect()
    }
}

/// Everything the work tried to reach at one machine, and how often.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attempt {
    pub host: String,
    pub port: u16,
    pub tries: u32,
    pub first: u64,
    pub last: u64,
}

impl Attempt {
    /// The row, as a sentence.
    ///
    /// The plural is spelled out rather than left as `1 attempts` — this is the
    /// line somebody reads while deciding whether their agent has been talked
    /// into something, and a report that reads like a machine wrote it is a
    /// report that gets skimmed.
    pub fn plainly(&self) -> String {
        match self.tries {
            1 => format!("wanted {}:{} once", self.host, self.port),
            n => format!("wanted {}:{} {n} times", self.host, self.port),
        }
    }
}

/// One row per machine, most-wanted first.
///
/// Grouped because the interesting fact is *which host*, and a retrying HTTP
/// client can write forty rows about one of them in a second.
pub fn tally(refusals: &[Refusal]) -> Vec<Attempt> {
    let mut out: Vec<Attempt> = Vec::new();
    for r in refusals {
        match out
            .iter_mut()
            .find(|a| a.port == r.port && a.host == r.host)
        {
            Some(a) => {
                a.tries += 1;
                a.first = a.first.min(r.at);
                a.last = a.last.max(r.at);
            }
            None => out.push(Attempt {
                host: r.host.clone(),
                port: r.port,
                tries: 1,
                first: r.at,
                last: r.at,
            }),
        }
    }
    // Most attempts first, then alphabetically so two runs of the same shape
    // read the same way.
    out.sort_by(|a, b| b.tries.cmp(&a.tries).then_with(|| a.host.cmp(&b.host)));
    out
}

/// The file refusals are appended to, in the member's own home on the machine
/// the work is running on.
#[derive(Debug, Clone)]
pub struct Journal {
    path: PathBuf,
}

impl Journal {
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Journal { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Write down that the work was refused a machine.
    ///
    /// Best-effort on purpose, and the only place in this crate where an error
    /// is dropped: the journal is how a refusal is *explained*, not how it is
    /// *enforced*. A full disk or a read-only home must not turn into an agent
    /// that suddenly reaches everything, so nothing here can fail the refusal
    /// that has already happened.
    ///
    /// One `write` of one line, opened `append`, so a broker serving forty
    /// connections at once produces forty whole rows rather than forty
    /// interleaved halves.
    pub fn refused(&self, host: &str, port: u16, via: Via) {
        let row = Refusal {
            at: now(),
            host: host.to_string(),
            port,
            via,
        };
        let Ok(mut line) = serde_json::to_string(&row) else {
            return;
        };
        line.push('\n');
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let opened = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path);
        if let Ok(mut file) = opened {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refusal(at: u64, host: &str) -> Refusal {
        Refusal {
            at,
            host: host.into(),
            port: 443,
            via: Via::Connect,
        }
    }

    #[test]
    fn a_journal_survives_a_line_that_was_cut_in_half() {
        // The broker is killed when the agent exits. A row that was mid-write
        // must not cost the reader the rest of the file.
        let text = format!(
            "{}\n{{\"at\":17,\"host\":\"cut\n{}\n",
            serde_json::to_string(&refusal(10, "a.example")).unwrap(),
            serde_json::to_string(&refusal(20, "b.example")).unwrap(),
        );
        let rows = Refusal::read(&text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].host, "b.example");
    }

    #[test]
    fn one_host_asked_for_forty_times_is_one_row() {
        let mut rows: Vec<Refusal> = (0..40).map(|i| refusal(100 + i, "evil.example")).collect();
        rows.push(refusal(50, "npm.example"));
        let tally = tally(&rows);
        assert_eq!(tally.len(), 2);
        // Most-wanted first: the retrying client is the one worth looking at.
        assert_eq!(tally[0].host, "evil.example");
        assert_eq!(tally[0].tries, 40);
        assert_eq!((tally[0].first, tally[0].last), (100, 139));
        assert_eq!(tally[1].plainly(), "wanted npm.example:443 once");
    }

    #[test]
    fn the_same_host_on_two_ports_is_two_rows() {
        // Allowing 443 is not allowing 22, so the report must not merge them.
        let rows = vec![
            refusal(1, "github.com"),
            Refusal {
                port: 22,
                ..refusal(2, "github.com")
            },
        ];
        assert_eq!(tally(&rows).len(), 2);
    }

    #[test]
    fn a_refusal_lands_in_a_directory_that_was_not_there() {
        let dir = std::env::temp_dir().join(format!("aura-egress-journal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let journal = Journal::at(dir.join("deep").join("run.jsonl"));
        journal.refused("evil.example", 443, Via::Http);
        journal.refused("evil.example", 443, Via::Connect);

        let text = std::fs::read_to_string(journal.path()).expect("a journal");
        let rows = Refusal::read(&text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].via, Via::Http);
        assert_eq!(tally(&rows)[0].tries, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
