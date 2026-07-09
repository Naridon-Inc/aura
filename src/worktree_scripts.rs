//! Per-worktree lifecycle scripts — the warm-up/teardown recipe a project
//! defines once so every isolated worktree (a crew agent's throwaway tree, or a
//! human's `aura work` session) lands ready to build instead of bare.
//!
//! The gap this closes: a fresh `git worktree` has the source but none of the
//! derived state — no `node_modules`, no `target/`, no generated files. An agent
//! (or you) dropped into it can't build or test until deps are installed, so the
//! acceptance gate that's supposed to prove the work fails for a reason that has
//! nothing to do with the work. Conductor solves the same problem with
//! Setup/Run/Archive scripts in `.conductor/settings.toml`; this is the Aura
//! equivalent, read from the project's own `.aura/settings.toml` so the recipe
//! is git-tracked and shared by the whole team:
//!
//! ```toml
//! [worktree]
//! setup   = "npm install && cargo build"   # run once, right after create
//! run     = "npm run dev"                   # `aura work run <name>` execs this
//! archive = "docker compose down"           # run once, right before teardown
//! ```
//!
//! Every field is optional. A project that defines none gets exactly today's
//! bare behaviour — lifecycle scripts are a convenience, never a hard
//! dependency, so a missing file or a parse hiccup degrades silently to empty.

use std::path::Path;
use std::process::{Command, Stdio};

/// The lifecycle commands a project defines for its worktrees. All optional.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Lifecycle {
    /// Run once, right after a worktree is created, to warm it up (install
    /// deps, prime a build) before any agent or gate touches it.
    pub setup: Option<String>,
    /// The project's dev/run command, surfaced as `aura work run <name>`.
    pub run: Option<String>,
    /// Run once, right before a worktree is torn down, to clean up after it
    /// (stop a dev server, drop containers, prune scratch state).
    pub archive: Option<String>,
}

impl Lifecycle {
    /// True when the project defines no lifecycle at all (the bare-worktree case).
    pub fn is_empty(&self) -> bool {
        self.setup.is_none() && self.run.is_none() && self.archive.is_none()
    }
}

/// Read `<repo_root>/.aura/settings.toml` and pull the `[worktree]` table out of
/// it. Missing file, missing table, or any read/parse hiccup all degrade to an
/// empty [`Lifecycle`] — the recipe is a convenience, never required.
pub fn load(repo_root: &Path) -> Lifecycle {
    let path = repo_root.join(".aura").join("settings.toml");
    match std::fs::read_to_string(&path) {
        Ok(text) => parse_worktree_table(&text),
        Err(_) => Lifecycle::default(),
    }
}

/// Run one lifecycle phase command inside `dir`. Returns `true` if there was
/// nothing to run (a no-op is success, not a failure) or the command exited 0;
/// `false` only if a real command ran and failed. When `quiet` the child's
/// stdout/stderr are suppressed (used under `--json`, where stray output would
/// corrupt the machine-readable stream); otherwise they stream through so the
/// human watches the warm-up live. `env` pairs are exported into the command's
/// environment (e.g. `AURA_WORK_PORT`, the Conductor-`CONDUCTOR_PORT` analogue
/// that lets parallel worktrees run their dev servers on distinct ports).
pub fn run_phase(dir: &Path, cmd: Option<&str>, quiet: bool, env: &[(&str, &str)]) -> bool {
    let Some(cmd) = cmd else { return true };
    let cmd = cmd.trim();
    if cmd.is_empty() {
        return true;
    }
    let mut c = Command::new("sh");
    c.arg("-c").arg(cmd).current_dir(dir);
    for (k, v) in env {
        c.env(k, v);
    }
    if quiet {
        c.stdout(Stdio::null()).stderr(Stdio::null());
    }
    c.status().map(|s| s.success()).unwrap_or(false)
}

/// PURE, unit-testable: extract `setup`/`run`/`archive` string values from the
/// `[worktree]` table of a TOML document.
///
/// A deliberately small subset of TOML — single-line `key = "..."` (or `'...'`,
/// or a bare unquoted value) under the `[worktree]` header — which is all a
/// lifecycle recipe ever needs. Other tables, unknown keys, blank lines and
/// `#` comments are ignored. We avoid pulling in a full TOML parser dependency
/// for three string keys; if a project's settings file uses richer TOML we
/// still read these three keys correctly and ignore the rest.
fn parse_worktree_table(toml: &str) -> Lifecycle {
    let mut life = Lifecycle::default();
    let mut in_table = false;
    for raw in toml.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            // A new table header — we only care about `[worktree]` (tolerate a
            // trailing inline comment after the closing bracket).
            let header = line.split('#').next().unwrap_or(line).trim();
            in_table = header == "[worktree]";
            continue;
        }
        if !in_table {
            continue;
        }
        if let Some((key, val)) = line.split_once('=') {
            let val = unquote(val.trim());
            if val.is_empty() {
                continue;
            }
            match key.trim() {
                "setup" => life.setup = Some(val),
                "run" => life.run = Some(val),
                "archive" => life.archive = Some(val),
                _ => {}
            }
        }
    }
    life
}

/// PURE: strip one layer of matching quotes from a TOML scalar. A quoted value
/// is returned verbatim (a `#` inside a quoted command is part of the command,
/// not a comment); a bare value has any trailing ` # comment` removed.
fn unquote(s: &str) -> String {
    let s = s.trim();
    let bytes = s.as_bytes();
    if s.len() >= 2 {
        let first = bytes[0];
        let last = bytes[s.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return s[1..s.len() - 1].to_string();
        }
    }
    // Bare value: a ` #` (space then hash) starts an inline comment.
    match s.split_once(" #") {
        Some((v, _)) => v.trim().to_string(),
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_doc_is_empty_lifecycle() {
        assert!(parse_worktree_table("").is_empty());
        assert!(parse_worktree_table("[other]\nx = 1\n").is_empty());
    }

    #[test]
    fn reads_all_three_keys() {
        let doc = r#"
            [worktree]
            setup = "npm install"
            run = 'npm run dev'
            archive = "docker compose down"
        "#;
        let life = parse_worktree_table(doc);
        assert_eq!(life.setup.as_deref(), Some("npm install"));
        assert_eq!(life.run.as_deref(), Some("npm run dev"));
        assert_eq!(life.archive.as_deref(), Some("docker compose down"));
        assert!(!life.is_empty());
    }

    #[test]
    fn only_worktree_table_is_read() {
        let doc = "[editor]\nsetup = \"WRONG\"\n[worktree]\nsetup = \"npm ci\"\n[build]\nsetup = \"ALSO WRONG\"\n";
        let life = parse_worktree_table(doc);
        assert_eq!(life.setup.as_deref(), Some("npm ci"));
        assert_eq!(life.run, None);
    }

    #[test]
    fn hash_inside_quotes_is_kept() {
        // A `#` inside a quoted command is part of the command, not a comment.
        let life = parse_worktree_table("[worktree]\nsetup = \"cargo build --features 'a#b'\"\n");
        assert_eq!(life.setup.as_deref(), Some("cargo build --features 'a#b'"));
    }

    #[test]
    fn bare_value_drops_inline_comment() {
        let life = parse_worktree_table("[worktree]\nsetup = make build # warm it up\n");
        assert_eq!(life.setup.as_deref(), Some("make build"));
    }

    #[test]
    fn comments_and_blank_lines_ignored() {
        let doc = "# top comment\n\n[worktree]\n# inner comment\nsetup = \"x\"\n\n";
        assert_eq!(parse_worktree_table(doc).setup.as_deref(), Some("x"));
    }

    #[test]
    fn compound_command_survives() {
        let life = parse_worktree_table("[worktree]\nsetup = \"npm install && cargo build\"\n");
        assert_eq!(life.setup.as_deref(), Some("npm install && cargo build"));
    }

    #[test]
    fn empty_value_is_skipped_not_empty_string() {
        let life = parse_worktree_table("[worktree]\nsetup = \"\"\nrun = \"go run .\"\n");
        assert_eq!(life.setup, None);
        assert_eq!(life.run.as_deref(), Some("go run ."));
    }

    #[test]
    fn run_phase_none_and_blank_are_noop_success() {
        let here = Path::new(".");
        assert!(run_phase(here, None, true, &[]));
        assert!(run_phase(here, Some("   "), true, &[]));
    }

    #[test]
    fn run_phase_runs_and_reports_status() {
        let here = Path::new(".");
        assert!(run_phase(here, Some("true"), true, &[]));
        assert!(!run_phase(here, Some("false"), true, &[]));
    }

    #[test]
    fn run_phase_exports_env() {
        let here = Path::new(".");
        // The command only succeeds if AURA_WORK_PORT reached the child.
        assert!(run_phase(
            here,
            Some("test \"$AURA_WORK_PORT\" = \"4321\""),
            true,
            &[("AURA_WORK_PORT", "4321")]
        ));
    }
}
