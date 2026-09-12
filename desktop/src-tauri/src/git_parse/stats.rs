//! Counts: per-file `--numstat`, and where a branch stands against its
//! upstream.

use serde::Serialize;

/// Per-file +/- for the Changes panel's `+12 -3` next to every row.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct FileDiffStat {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

/// `git diff --numstat` → rows. Numstat emits `<add>\t<del>\t<path>` per
/// line; binaries report `-\t-` and count as zero. Renames look like
/// `a/b/old.rs => a/b/new.rs` or `a/{old.rs => new.rs}/b` — keep the new path.
pub fn parse_numstat(text: &str) -> Vec<FileDiffStat> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut it = line.splitn(3, '\t');
        let add = it.next().unwrap_or("0");
        let del = it.next().unwrap_or("0");
        let Some(raw_path) = it.next() else {
            continue;
        };
        let path = match raw_path.rfind(" => ") {
            Some(idx) => raw_path[idx + 4..].trim_end_matches('}').to_string(),
            None => raw_path.to_string(),
        };
        out.push(FileDiffStat {
            path,
            additions: add.parse().unwrap_or(0),
            deletions: del.parse().unwrap_or(0),
        });
    }
    out
}

/// Where a branch stands against its upstream.
///
/// A genuine missing upstream is `has_upstream: false`; anything that stopped
/// us finding out is an error on the command, never a zeroed struct — the
/// TypeScript side renders "couldn't check", not a verdict about the branch.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct AheadBehind {
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
    pub branch: Option<String>,
}

/// `git rev-list --left-right --count @{u}...HEAD` → `(behind, ahead)`.
///
/// There IS an upstream and git answered, so a line we can't read is a broken
/// answer, not a zero. Reporting it as 0/0 is what made "in sync" the resting
/// state of every failure.
pub fn parse_left_right_count(stdout: &str) -> Result<(u32, u32), String> {
    let mut parts = stdout.split_whitespace();
    let mut count = |what: &str| -> Result<u32, String> {
        parts
            .next()
            .and_then(|n| n.parse::<u32>().ok())
            .ok_or_else(|| {
                format!("git returned a {what} count we couldn't read: {:?}", stdout.trim())
            })
    };
    let behind = count("behind")?;
    let ahead = count("ahead")?;
    Ok((behind, ahead))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numstat_keeps_the_new_side_of_a_rename_and_zeroes_binaries() {
        let text = "3\t1\tsrc/a.rs\n-\t-\timg.png\n0\t0\tsrc/{old.rs => new.rs}\n2\t0\ta/old => b/new\n";
        let rows = parse_numstat(text);
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0], FileDiffStat { path: "src/a.rs".into(), additions: 3, deletions: 1 });
        assert_eq!((rows[1].additions, rows[1].deletions), (0, 0));
        assert_eq!(rows[2].path, "new.rs");
        assert_eq!(rows[3].path, "b/new");
    }

    #[test]
    fn left_right_is_behind_then_ahead() {
        assert_eq!(parse_left_right_count("2\t5\n").unwrap(), (2, 5));
        assert!(parse_left_right_count("").is_err());
        assert!(parse_left_right_count("x y").is_err());
    }
}
