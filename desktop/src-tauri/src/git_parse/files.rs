//! The project-wide file index: what `⌘P` and the `@`-mention picker search.

/// A gitignored file we still surface in the project index because it's a
/// config file people open and edit, not build noise. The `.env` family is
/// the canonical case (`.env`, `.env.local`, `.env.production`, …) — it lives
/// in `.gitignore` by convention, so `--exclude-standard` drops it, yet it's
/// one of the files users most want to reach from ⌘P or an `@`-mention.
/// Mirrors the dotfile-visibility doctrine in `cmd_files::is_always_hidden`,
/// which keeps `.env` in the file tree.
pub fn is_meaningful_ignored(base: &str) -> bool {
    const ENV: &str = ".env";
    base == ENV || base.starts_with(&format!("{ENV}."))
}

/// The two `git ls-files` arguments both arms run: the normal editable surface,
/// then the ignored set collapsed by directory.
///
/// `--directory` is load-bearing, not a tidy-up: without it git enumerates
/// every ignored path individually, which on a repo carrying node_modules and
/// Cargo's `target/` means ~470k lines and ~5s of wall clock — all of it
/// allocated and then thrown away, since only a handful of `.env` files
/// survive the filter. With it git stops at the first wholly ignored directory
/// and reports that one entry. The trade is deliberate: a `.env` buried
/// *inside* a wholly ignored folder is no longer surfaced — those are caches
/// and vendored trees, not files people edit.
pub const TRACKED_ARGS: [&str; 4] = ["ls-files", "--cached", "--others", "--exclude-standard"];
pub const IGNORED_ARGS: [&str; 5] = ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"];

/// Non-empty lines of a `git ls-files` listing.
pub fn lines(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Tracked + untracked-but-not-ignored, plus the few gitignored files worth
/// opening — the `.env` family above all. Collapsed directories arrive with a
/// trailing slash; they are not files and must never reach the picker.
/// Sorted and deduplicated; the frontend filters + ranks.
pub fn merge_index(tracked: Vec<String>, ignored: Vec<String>) -> Vec<String> {
    let mut paths = tracked;
    for rel in ignored {
        if rel.ends_with('/') {
            continue;
        }
        let base = rel.rsplit('/').next().unwrap_or(&rel);
        if is_meaningful_ignored(base) {
            paths.push(rel);
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_files_come_back_but_caches_do_not() {
        let tracked = lines("src/a.rs\nREADME.md\n");
        let ignored = lines("node_modules/\n.env\n.env.local\ntarget/\nbuild/out.js\napp/.env.production\n");
        assert_eq!(
            merge_index(tracked, ignored),
            vec![".env", ".env.local", "README.md", "app/.env.production", "src/a.rs"]
        );
    }

    #[test]
    fn duplicates_collapse() {
        assert_eq!(merge_index(vec!["a".into(), "a".into()], vec![]), vec!["a"]);
    }
}
