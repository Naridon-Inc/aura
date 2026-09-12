//! The commit graph: `git log --all` in one line per commit, read into the
//! rows the History rail draws lanes between.
//!
//! Was inline in `cmd_aura_fs::git_commit_graph`; moved here so a workspace
//! whose checkout is on a machine (`place_work::git::place_git_commit_graph`)
//! reads the same bytes with the same reading. The arguments are here too,
//! for the same reason the parsers are: a graph that excludes Aura's own
//! shadow branches on this laptop and shows them on a box is two graphs.

use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct GraphRef {
    pub name: String,
    /// "head" (the checked-out branch / detached HEAD) | "local" |
    /// "remote" | "tag". The frontend colours badges by this.
    pub kind: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct GraphCommit {
    pub sha: String,   // full 40-char sha — stable identity for lanes
    pub short: String, // abbreviated, for display
    pub parents: Vec<String>, // full parent shas, first-parent first
    pub author: String,
    pub author_email: String,
    pub timestamp: i64,
    pub subject: String,
    pub refs: Vec<GraphRef>,
}

/// The `git log` arguments before `-n` and `--pretty`. Aura's own
/// shadow/checkpoint branches (`entire/*`, `aura/*`) are machinery, not
/// human history — excluding them keeps the graph readable (especially for
/// non-engineers, who shouldn't see VCS internals). The `--exclude` globs
/// must precede `--all`.
pub const LOG_ARGS: [&str; 7] = [
    "log",
    "--exclude=refs/heads/entire/*",
    "--exclude=refs/heads/aura/*",
    "--exclude=refs/remotes/*/entire/*",
    "--exclude=refs/remotes/*/aura/*",
    "--all",
    "--date-order",
];

/// %H full sha · %h short · %P parents (space-sep) · %an author · %ae email
/// · %ct commit-time · %s subject · %D decorations. `%x1f` is git spelling
/// the unit separator itself, so the format carries no control byte — it
/// can travel inside a quoted shell word to a machine unchanged.
pub const LOG_FORMAT: &str = "%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%ct%x1f%s%x1f%D";

/// The remote names out of `git remote`, one per line; blanks dropped.
pub fn parse_remotes(txt: &str) -> Vec<String> {
    txt.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// Every line of a [`LOG_FORMAT`] log, in the order git printed them. A
/// line with too few fields is skipped, never a hard error.
pub fn parse_graph(txt: &str, remotes: &[String]) -> Vec<GraphCommit> {
    let mut commits = Vec::new();
    for line in txt.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 7 {
            continue;
        }
        let parents: Vec<String> = parts[2]
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();
        let refs = parts
            .get(7)
            .map(|d| parse_decorations(d, remotes))
            .unwrap_or_default();
        commits.push(GraphCommit {
            sha: parts[0].to_string(),
            short: parts[1].to_string(),
            parents,
            author: parts[3].to_string(),
            author_email: parts[4].to_string(),
            timestamp: parts[5].parse().unwrap_or(0),
            subject: parts[6].to_string(),
            refs,
        });
    }
    commits
}

/// Parse git's `%D` decoration string into typed refs. Examples:
///   "HEAD -> feat/x, origin/feat/x, tag: v1.0, other-branch"
///   "HEAD" (detached)
///
/// `remotes` is what `git remote` printed, so a decoration like
/// `origin/feat/x` is classed as remote rather than mistaken for a local
/// branch named with slashes (e.g. `feat/commons-platform`).
pub fn parse_decorations(deco: &str, remotes: &[String]) -> Vec<GraphRef> {
    let mut out = Vec::new();
    for raw in deco.split(',') {
        let tok = raw.trim();
        if tok.is_empty() {
            continue;
        }
        if let Some(branch) = tok.strip_prefix("HEAD -> ") {
            // The checked-out branch — mark it as HEAD so the rail can
            // pin "you are here".
            out.push(GraphRef {
                name: branch.trim().to_string(),
                kind: "head".to_string(),
            });
        } else if tok == "HEAD" {
            out.push(GraphRef {
                name: "HEAD".to_string(),
                kind: "head".to_string(),
            });
        } else if let Some(tag) = tok.strip_prefix("tag: ") {
            out.push(GraphRef {
                name: tag.trim().to_string(),
                kind: "tag".to_string(),
            });
        } else {
            // Remote if its first path segment is a known remote name.
            let first = tok.split('/').next().unwrap_or("");
            let kind = if remotes.iter().any(|r| r == first) {
                "remote"
            } else {
                "local"
            };
            out.push(GraphRef {
                name: tok.to_string(),
                kind: kind.to_string(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_log_line_becomes_a_commit_with_typed_refs() {
        let remotes = vec!["origin".to_string()];
        let txt = "aaaa\x1fa\x1fbbbb cccc\x1fMo\x1fmo@x.com\x1f1700000000\x1ffeat: x\x1fHEAD -> feat/x, origin/feat/x, tag: v1, feat/commons-platform\n\
                   bbbb\x1fb\x1f\x1fMo\x1fmo@x.com\x1f1699999999\x1finit\x1f\n\
                   short line\n";
        let got = parse_graph(txt, &remotes);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].parents, vec!["bbbb", "cccc"]);
        assert_eq!(got[0].timestamp, 1_700_000_000);
        let kinds: Vec<(&str, &str)> = got[0]
            .refs
            .iter()
            .map(|r| (r.name.as_str(), r.kind.as_str()))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("feat/x", "head"),
                ("origin/feat/x", "remote"),
                ("v1", "tag"),
                ("feat/commons-platform", "local"),
            ]
        );
        assert!(got[1].parents.is_empty());
        assert!(got[1].refs.is_empty());
    }

    #[test]
    fn a_detached_head_is_a_head_ref() {
        let refs = parse_decorations("HEAD", &[]);
        assert_eq!(refs, vec![GraphRef { name: "HEAD".into(), kind: "head".into() }]);
    }

    #[test]
    fn remote_names_are_one_per_line() {
        assert_eq!(parse_remotes("origin\n upstream \n\n"), vec!["origin", "upstream"]);
        assert!(parse_remotes("").is_empty());
    }
}
