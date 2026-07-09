//! Tab-completion engine for the composer prompt.
//!
//! Three sources cover the common terminal completion cases:
//!   - `commands` — executables on `$PATH`. Triggered when the user is
//!     typing the first token of the line.
//!   - `files` — entries in the cwd (or a path-prefix under cwd), used
//!     for any non-first token and for tokens that look like paths.
//!   - `branches` — git refs, used when the preceding words look like a
//!     git branch-taking subcommand (`checkout`, `switch`, `merge`,
//!     `rebase`, `branch -d`). Invoked via `git` subprocess so we don't
//!     pull in a gix dependency just for this feature.
//!
//! The UI layer is intentionally not in this module. `engine::complete`
//! returns a ranked `Vec<Candidate>` that the composer renders as a
//! popup; keystrokes cycle the selected index and Enter applies.

use std::collections::BTreeSet;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

/// What the user sees in the popup + what gets pasted on Apply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// The text the user sees. For commands this is the binary name;
    /// for files it's the basename (with trailing `/` on directories);
    /// for branches it's the short ref name.
    pub display: String,
    /// The text substituted back into the prompt — may include a trailing
    /// slash for directories or a trailing space for completed commands,
    /// so the caret lands ready for the next token.
    pub replacement: String,
    /// Which source produced this candidate. Useful for both rendering
    /// (source-specific icon/color) and for tie-breaking in ranking.
    pub source: Source,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Command,
    File,
    Branch,
}

/// Max candidates returned from `complete`. Fits comfortably in a
/// dropdown; anything beyond is noise.
pub const MAX_CANDIDATES: usize = 12;

/// Compute completions for `input` given the current working directory.
///
/// The input is lexed on whitespace; the LAST token drives completion.
/// First-token completion draws from `$PATH` commands (plus path-like
/// fallbacks if the token has a `/`); subsequent tokens draw from files
/// relative to cwd. When the preceding tokens match a recognized git
/// branch-taking subcommand, branches join the result set.
pub fn complete(input: &str, cwd: &Path) -> Vec<Candidate> {
    let tokens = lex(input);
    let (cursor_token, token_index) = match tokens.last() {
        Some(t) => (t.clone(), tokens.len() - 1),
        None => (String::new(), 0),
    };

    let mut out: Vec<Candidate> = Vec::new();

    if token_index == 0 && !cursor_token.contains('/') {
        extend_unique(&mut out, commands_from_path(&cursor_token));
    }

    // Path/file completion — always available as a fallback on the last
    // token. A literal "/" triggers directory listings from cwd root.
    extend_unique(&mut out, files_under_cwd(cwd, &cursor_token));

    if wants_branch(&tokens) {
        extend_unique(&mut out, git_branches(cwd, &cursor_token));
    }

    out.sort_by(|a, b| {
        let a_rank = source_rank(a.source);
        let b_rank = source_rank(b.source);
        a_rank
            .cmp(&b_rank)
            .then_with(|| a.display.cmp(&b.display))
    });
    out.truncate(MAX_CANDIDATES);
    out
}

/// Apply `candidate` to `input`: replace the final token with the
/// candidate's `replacement`, preserving the rest of the line. Returns
/// the new full input string suitable for swap into the composer.
pub fn apply(input: &str, candidate: &Candidate) -> String {
    let tokens = lex(input);
    if tokens.is_empty() {
        return candidate.replacement.clone();
    }
    // Find where the last token begins by subtracting its character
    // length from the first trailing-whitespace trim point. Operating
    // on `char_indices` keeps this safe for multibyte input.
    let trim_end = input.trim_end();
    let last = tokens.last().unwrap();
    let cut = trim_end.len().saturating_sub(last.len());
    let mut out = input[..cut].to_string();
    out.push_str(&candidate.replacement);
    out
}

// ── Source: commands ────────────────────────────────────────────────────

fn commands_from_path(prefix: &str) -> Vec<Candidate> {
    let Ok(path_var) = env::var("PATH") else {
        return Vec::new();
    };
    let mut names: BTreeSet<String> = BTreeSet::new();
    for dir in env::split_paths(&path_var) {
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            // Accept files AND symlinks (most PATH binaries on macOS are
            // symlinked into /usr/local/bin). Subdirectories are skipped.
            if !file_type.is_file() && !file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') {
                continue;
            }
            if !name.starts_with(prefix) {
                continue;
            }
            if is_executable(&entry.path()) {
                names.insert(name.to_string());
            }
        }
    }
    names
        .into_iter()
        .map(|name| Candidate {
            display: name.clone(),
            replacement: format!("{name} "),
            source: Source::Command,
        })
        .collect()
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let mode = meta.permissions().mode();
    mode & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    // Windows: a .exe/.bat/.cmd on PATH is the convention. The terminal
    // is macOS/Linux-first but the crate must compile cross-platform.
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "exe" | "bat" | "cmd"))
        .unwrap_or(false)
}

// ── Source: files ──────────────────────────────────────────────────────

fn files_under_cwd(cwd: &Path, token: &str) -> Vec<Candidate> {
    let (dir_component, name_prefix) = split_path_token(token);
    let dir_abs = if dir_component.is_absolute() {
        dir_component.clone()
    } else {
        cwd.join(&dir_component)
    };
    let Ok(read) = std::fs::read_dir(&dir_abs) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        // Hidden files participate in completion only when the user
        // explicitly typed a leading dot — matches shell convention.
        if name_str.starts_with('.') && !name_prefix.starts_with('.') {
            continue;
        }
        if !name_str.starts_with(&name_prefix) {
            continue;
        }
        let is_dir = entry
            .file_type()
            .map(|t| t.is_dir())
            .unwrap_or(false);

        let display = if is_dir {
            format!("{name_str}/")
        } else {
            name_str.to_string()
        };
        // Replacement re-assembles the dir component (as the user typed
        // it, with trailing slash preserved) with the name. Directories
        // get a trailing slash but NO space — so the user can keep
        // typing deeper. Files get a trailing space to move to the next
        // token.
        let mut replacement = String::new();
        if !dir_component.as_os_str().is_empty() {
            replacement.push_str(&dir_component.display().to_string());
            if !replacement.ends_with('/') {
                replacement.push('/');
            }
        }
        replacement.push_str(name_str);
        if is_dir {
            replacement.push('/');
        } else {
            replacement.push(' ');
        }
        out.push(Candidate {
            display,
            replacement,
            source: Source::File,
        });
    }
    out.sort_by(|a, b| a.display.cmp(&b.display));
    out
}

/// Split a path-ish token like `src/ui/pt` into the directory prefix
/// (`src/ui`) and the basename prefix being completed (`pt`). When
/// there's no `/`, the directory component is empty and the whole
/// token is the name prefix.
fn split_path_token(token: &str) -> (PathBuf, String) {
    if let Some(idx) = token.rfind('/') {
        let (dir, name) = token.split_at(idx + 1);
        (PathBuf::from(dir), name.to_string())
    } else {
        (PathBuf::new(), token.to_string())
    }
}

// ── Source: git branches ───────────────────────────────────────────────

fn wants_branch(tokens: &[String]) -> bool {
    if tokens.first().map(|s| s.as_str()) != Some("git") {
        return false;
    }
    // Look at the most recent non-flag token BEFORE the cursor token —
    // that's the subcommand. Flags (`-d`, `--verbose`) pass through.
    let cursor_index = tokens.len() - 1;
    let sub = tokens
        .iter()
        .take(cursor_index)
        .skip(1)
        .find(|t| !t.starts_with('-'));
    matches!(
        sub.map(|s| s.as_str()),
        Some("checkout" | "switch" | "merge" | "rebase" | "branch" | "log" | "diff")
    )
}

fn git_branches(cwd: &Path, prefix: &str) -> Vec<Candidate> {
    // `git branch --list --format=%(refname:short)` gives us a clean
    // newline-separated list; `--list <glob>` narrows to matches server-
    // side. We add a trailing `*` so the glob is a prefix match, which
    // is exactly what a completion wants.
    let pattern = format!("{prefix}*");
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .arg("branch")
        .arg("--list")
        .arg("--format=%(refname:short)")
        .arg(&pattern)
        .output();
    let Ok(out) = output else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut names: Vec<&str> = stdout.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    names.sort();
    names.dedup();
    names
        .into_iter()
        .map(|name| Candidate {
            display: name.to_string(),
            replacement: format!("{name} "),
            source: Source::Branch,
        })
        .collect()
}

// ── Shared helpers ─────────────────────────────────────────────────────

fn lex(input: &str) -> Vec<String> {
    // A dumb-but-predictable tokenizer: split on ASCII whitespace, keep
    // empty trailing tokens only if the input ends in whitespace (which
    // means the user is starting a fresh token and wants cwd files, not
    // a sub-completion of the prior token).
    let mut toks: Vec<String> = input
        .split_ascii_whitespace()
        .map(|s| s.to_string())
        .collect();
    if input.ends_with(char::is_whitespace) {
        toks.push(String::new());
    }
    toks
}

fn extend_unique(out: &mut Vec<Candidate>, new: impl IntoIterator<Item = Candidate>) {
    for c in new {
        if !out.iter().any(|existing| existing.replacement == c.replacement) {
            out.push(c);
        }
    }
}

fn source_rank(s: Source) -> u8 {
    match s {
        // Commands are the highest-value completion in terminal use —
        // surfaced first on the first token, out-ranked by file matches
        // elsewhere because the lex + ranker already picks which source
        // gets consulted.
        Source::Command => 0,
        Source::Branch => 1,
        Source::File => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn lex_distinguishes_trailing_space_from_partial_token() {
        let t1 = lex("ls src");
        assert_eq!(t1, vec!["ls", "src"]);
        let t2 = lex("ls src ");
        assert_eq!(t2, vec!["ls", "src", ""]);
        let t3 = lex("");
        assert!(t3.is_empty());
    }

    #[test]
    fn split_path_token_breaks_on_final_slash() {
        let (dir, name) = split_path_token("src/ui/pt");
        assert_eq!(dir.to_string_lossy(), "src/ui/");
        assert_eq!(name, "pt");

        let (dir, name) = split_path_token("foo");
        assert_eq!(dir.as_os_str().len(), 0);
        assert_eq!(name, "foo");

        let (dir, name) = split_path_token("./");
        assert_eq!(dir.to_string_lossy(), "./");
        assert_eq!(name, "");
    }

    #[test]
    fn files_under_cwd_returns_matching_entries_with_dir_marker() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("README.md"), "hi").unwrap();
        fs::write(dir.path().join("readme.txt"), "hi").unwrap();
        fs::write(dir.path().join(".hidden"), "x").unwrap();

        let got = files_under_cwd(dir.path(), "re");
        let displays: Vec<_> = got.iter().map(|c| c.display.clone()).collect();
        // Case-sensitive match — matches shell convention.
        assert!(displays.contains(&"readme.txt".to_string()));
        assert!(!displays.contains(&"README.md".to_string()));
        // Hidden file must not appear without a dot prefix.
        assert!(!displays.contains(&".hidden".to_string()));

        let got_caps = files_under_cwd(dir.path(), "RE");
        let displays_caps: Vec<_> = got_caps.iter().map(|c| c.display.clone()).collect();
        assert!(displays_caps.contains(&"README.md".to_string()));

        let got_dot = files_under_cwd(dir.path(), ".");
        let displays_dot: Vec<_> = got_dot.iter().map(|c| c.display.clone()).collect();
        assert!(displays_dot.contains(&".hidden".to_string()));

        // Directory entries get a trailing slash on both display and
        // replacement so typing keeps going.
        let got_s = files_under_cwd(dir.path(), "s");
        let src = got_s.iter().find(|c| c.display == "src/").expect("src/");
        assert_eq!(src.replacement, "src/");
    }

    #[test]
    fn files_under_cwd_descends_into_subdir_prefix() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src").join("main.rs"), "").unwrap();
        fs::write(dir.path().join("src").join("lib.rs"), "").unwrap();

        let got = files_under_cwd(dir.path(), "src/m");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].display, "main.rs");
        // Replacement preserves the typed directory component.
        assert_eq!(got[0].replacement, "src/main.rs ");
    }

    #[test]
    fn apply_replaces_only_the_final_token() {
        let c = Candidate {
            display: "cargo".into(),
            replacement: "cargo ".into(),
            source: Source::Command,
        };
        assert_eq!(apply("car", &c), "cargo ");

        let c2 = Candidate {
            display: "main.rs".into(),
            replacement: "src/main.rs ".into(),
            source: Source::File,
        };
        assert_eq!(apply("cargo run --bin src/m", &c2), "cargo run --bin src/main.rs ");
    }

    #[test]
    fn apply_on_empty_input_yields_replacement() {
        let c = Candidate {
            display: "ls".into(),
            replacement: "ls ".into(),
            source: Source::Command,
        };
        assert_eq!(apply("", &c), "ls ");
    }

    #[test]
    fn wants_branch_recognises_git_subcommands() {
        let t = |s: &str| -> Vec<String> { lex(s) };
        assert!(wants_branch(&t("git checkout m")));
        assert!(wants_branch(&t("git switch -c f")));
        assert!(wants_branch(&t("git rebase m")));
        assert!(wants_branch(&t("git merge f")));
        // Non-branch subcommands are excluded.
        assert!(!wants_branch(&t("git status m")));
        assert!(!wants_branch(&t("git commit -m ")));
        // Non-git commands never want branches.
        assert!(!wants_branch(&t("cargo checkout m")));
    }

    #[test]
    fn complete_ranks_commands_before_files_on_first_token() {
        // PATH has /bin; cwd has a "bin" directory. On the first token
        // "bi", command source should precede file source.
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("bin")).unwrap();

        let got = complete("bi", dir.path());
        let kinds: Vec<Source> = got.iter().map(|c| c.source).collect();
        // The first Command must come before the first File — we don't
        // assert all Commands precede all Files because the result set
        // is MAX_CANDIDATES = 12 and might be one-sided on minimal PATH.
        if kinds.contains(&Source::Command) && kinds.contains(&Source::File) {
            let first_cmd = kinds.iter().position(|s| *s == Source::Command).unwrap();
            let first_file = kinds.iter().position(|s| *s == Source::File).unwrap();
            assert!(
                first_cmd < first_file,
                "Command candidate should rank before File candidate, got {kinds:?}",
            );
        }
    }

    #[test]
    fn max_candidates_cap_is_enforced() {
        let dir = TempDir::new().unwrap();
        for i in 0..30 {
            fs::write(dir.path().join(format!("file{i:02}.txt")), "").unwrap();
        }
        let got = complete("ls fil", dir.path());
        assert!(got.len() <= MAX_CANDIDATES);
    }
}
