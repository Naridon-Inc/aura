//! Auto-init + auto-wire Aura the moment a repo is opened in the ADE.
//!
//! The product promise is "Aura is always running." Until now the wiring
//! was lazy and PTY-scoped: `.aura/` got created only when the aura CLI
//! happened to run, and the agent hooks/MCP were stamped only when an
//! *in-app* PTY spawned. Open someone else's repo, let Claude edit a file
//! from an external terminal, and Aura had no intent log to check against —
//! so every edit fell straight to the red "no intent logged" banner, which
//! (rightly) reads as meaningless.
//!
//! This module closes that gap. On repo-open the frontend calls
//! `aura_ensure_tracked`, which:
//!   1. shadows Aura's footprint into `.git/info/exclude` so nothing Aura
//!      writes ever shows up in the user's `git status` (their "silent
//!      everywhere, gitignored" choice — we never touch the tracked
//!      `.gitignore`);
//!   2. turns on passive capture with a silent, idempotent `aura enable`
//!      (creates `.aura/`, installs the git hooks) so there IS an intent
//!      log + checkpoint to reconcile against;
//!   3. wires every agent CLI (MCP server + Claude/Gemini hooks + a
//!      repo-level `.mcp.json`) so ANY agent editing this repo — in-app or
//!      launched from a plain terminal — logs intent through Aura.
//!
//! Non-git folders can't be tracked (Aura is a git overlay); for those we
//! return an honest status the UI turns into a one-click "Initialize Git &
//! turn on Aura" notice — never a trip to the CLI.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::cmd_doctor_cli::StaleCli;

/// Result of an ensure-tracked pass, surfaced to the UI so it can show a
/// quiet confirmation (or the non-git notice) without guessing.
#[derive(Serialize, Clone, Debug)]
pub struct AuraTrackStatus {
    pub repo_root: String,
    /// Is this a git repository at all? Aura can't track without git.
    pub is_git: bool,
    /// Aura capture is on (`.aura/` present + git hooks installed) after
    /// this call.
    pub tracked: bool,
    /// True only when THIS call flipped it on (drives the "Aura is now
    /// tracking this project" toast — shown once, not on every re-open).
    pub newly_enabled: bool,
    /// Agent CLIs wired (MCP + hooks) so edits here log intent.
    pub wired: bool,
    /// Human-readable line for the non-git / error case; `None` on success.
    pub detail: Option<String>,
    /// Set when the reason it didn't work is that the `aura` helper on this
    /// computer is older than this build needs. The strip turns this into
    /// "update it" — a button — instead of a Retry that reruns a command the
    /// old binary has never heard of.
    pub stale_cli: Option<StaleCli>,
    /// The helper's own words, all of them, unabridged. `detail` is the one
    /// line we put on screen; this is what the reader can open when that line
    /// isn't enough. Never the only copy of the diagnosis — the strip clips at
    /// one line, and a clipped error is an error nobody can act on.
    pub raw_detail: Option<String>,
}

/// Why `aura enable` didn't take.
///
/// Two channels, deliberately not one string: `raw` is the tool's own words
/// (never rewritten, never trimmed) and `stale` is a fact we worked out about
/// the binary. Collapsing them is what produced "Aura couldn't switch on for
/// this project. It said: The aura command on this computer is version 0.7.2…"
/// — our own prose quoted back as if the CLI had said it.
#[derive(Debug)]
struct EnableFailure {
    /// Everything the helper printed, unmodified.
    raw: String,
    /// Present when the binary we ran predates the subcommand we asked for.
    stale: Option<StaleCli>,
}

// Marker-delimited block we own inside `.git/info/exclude`. Idempotent by
// construction: if the begin marker is already present we leave the file
// alone. Kept narrow so a user editing their own exclude rules around it is
// never disturbed.
const EXCLUDE_BEGIN: &str = "# >>> aura (ADE local-only, do not commit) >>>";
const EXCLUDE_END: &str = "# <<< aura (ADE local-only) <<<";

// Paths Aura may write into a tracked repo that the user asked to keep out
// of `git status`. `.aura/` carries the intent log + checkpoints; the rest
// are per-agent wiring the CLIs read.
const EXCLUDE_ENTRIES: &[&str] = &[
    "/.aura/",
    "/.mcp.json",
    "/.claude/settings.local.json",
    "/.gemini.intent",
    "/.claude.intent",
    "/.aura.intent",
];

/// Make an opened repo a live Aura repo — idempotent and safe to call on
/// every repo focus. Order matters: exclude first (so the enable step's
/// writes are already invisible to git), then enable, then wire agents.
#[tauri::command]
pub async fn aura_ensure_tracked(repo_root: String) -> Result<AuraTrackStatus, String> {
    crate::blocking::run(move || {
        let root = PathBuf::from(&repo_root);
        if !root.is_dir() {
            return Err(format!("Not a directory: {repo_root}"));
        }

        // Aura is a git overlay — no git, nothing to track. Hand the UI an
        // honest status it can turn into a one-click init offer.
        if !root.join(".git").exists() {
            return Ok(AuraTrackStatus {
                repo_root,
                is_git: false,
                tracked: false,
                newly_enabled: false,
                wired: false,
                detail: Some(
                    "This folder isn't a Git repository yet. Aura tracks changes on top of Git — turn it on to start."
                        .into(),
                ),
                stale_cli: None,
                raw_detail: None,
            });
        }

        // (1) Keep Aura out of `git status` before we write anything else.
        // Best-effort by design — a repo we can't write an ignore rule into is
        // still a repo we can track — but not silent: dropping this error is what
        // hid the worktree failure above for as long as it lasted.
        if let Err(e) = ensure_local_exclude(&root) {
            eprintln!(
                "[aura-track] couldn't hide Aura's files from git status in {}: {e}",
                root.display()
            );
        }

        // (2) Turn on passive capture if it isn't already on.
        let already = aura_capture_present(&root);
        let mut newly_enabled = false;
        // Why the enable step didn't take, if it didn't. Held rather than dropped:
        // this is the whole difference between a Retry the user can act on and a
        // button that appears to do nothing every time they press it.
        let mut failure: Option<EnableFailure> = None;
        if !already {
            match run_aura_enable(&repo_root) {
                Ok(()) => newly_enabled = true,
                Err(why) => failure = Some(why),
            }
        }
        let tracked = already || newly_enabled || aura_capture_present(&root);

        // (3) Wire the agent CLIs so any agent editing here logs intent.
        let wired = crate::cmd_agent_pty::wire_agents_for_repo(&repo_root);

        // Only speak up when we actually failed. A late re-probe can find
        // capture on even though the enable step reported an error (another
        // window got there first), and that is a success, not a warning.
        let (detail, stale_cli, raw_detail) = if tracked {
            (None, None, None)
        } else {
            let line = explain_failure(failure.as_ref());
            let (stale, raw) = match failure {
                Some(f) => (f.stale, Some(f.raw).filter(|r| !r.trim().is_empty())),
                None => (None, None),
            };
            (Some(line), stale, raw)
        };

        Ok(AuraTrackStatus {
            repo_root,
            is_git: true,
            tracked,
            newly_enabled,
            wired,
            detail,
            stale_cli,
            raw_detail,
        })
    })
    .await
}

/// Turn whatever went wrong into a sentence the person reading it can act on.
///
/// The raw text here comes from a command-line tool, so it arrives in
/// developer shorthand — `Os { code: 20, kind: NotADirectory }` and the like.
/// The people this app is for don't read that, and a notice they can't read is
/// the same as no notice at all. So we name the failures we can positively
/// identify, and for anything else we lead in plainly and quote the tool's own
/// words rather than inventing a diagnosis we don't have.
///
/// Everything here is written front-loaded. The strip that renders it is one
/// line tall and clips, so the fact and the fix have to be in the first dozen
/// words — a sentence that opens "Aura couldn't switch on for this project. It
/// said: …" spends the whole visible line saying nothing, which is how a real
/// diagnosis ("your helper is version 0.7.2") ended up off-screen.
fn explain_failure(failure: Option<&EnableFailure>) -> String {
    let Some(f) = failure else {
        // No error to report and still not tracking: the enable step claimed
        // success but left no hooks behind.
        return "Aura ran its setup step here but the project still isn't being \
                recorded. Reopening the project usually clears it."
            .into();
    };
    // An old helper is the one failure where trying again cannot possibly work,
    // so it is named before anything else and the numbers come first. Version
    // strings are the rare jargon that earns its place: they're what the user
    // compares against the update they're being offered.
    if let Some(stale) = &f.stale {
        return format!(
            "Aura's helper on this computer is version {} and this app needs {}. The old \
             one can't switch tracking on — updating it fixes this.",
            stale.installed, stale.expected
        );
    }
    let raw = &f.raw;
    if raw.contains("NotADirectory") || raw.contains("Not a directory") {
        return "This folder is a linked copy of another project, and the version of \
                Aura installed on this computer can't switch itself on inside one. \
                Update Aura from Settings, then try again."
            .into();
    }
    if raw.contains("No such file or directory") || raw.contains("couldn't start Aura") {
        return "Aura's helper isn't installed on this computer, so there was nothing to \
                switch on. Install it, then try again."
            .into();
    }
    // Unknown failure — say so honestly and hand over the tool's own first
    // line, trimmed, so nothing is hidden and nothing is guessed. The full
    // text still travels in `raw_detail`; this is only the visible line.
    let first = raw.lines().next().unwrap_or("").trim();
    if first.is_empty() {
        return "Aura's setup step stopped without saying why. Try again, and if it \
                keeps happening reopen the project."
            .into();
    }
    format!("Aura couldn't switch on for this project. It said: {first}")
}

/// The non-git escape hatch: user clicked "Initialize Git & turn on Aura"
/// in the in-app notice. That click is the consent to create git history in
/// this folder — we never do it silently. Then run the normal ensure pass.
#[tauri::command]
pub async fn aura_git_init_and_track(repo_root: String) -> Result<AuraTrackStatus, String> {
    let ensure_root = repo_root.clone();
    crate::blocking::run(move || {
        let root = PathBuf::from(&repo_root);
        if !root.is_dir() {
            return Err(format!("Not a directory: {repo_root}"));
        }
        if !root.join(".git").exists() {
            // Same rule as the enable step: whatever git complains about goes
            // back to the user in words, never as a silent failed click.
            let out = std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(&root)
                .output();
            match out {
                Ok(o) if o.status.success() => {}
                Ok(o) => {
                    let said = String::from_utf8_lossy(&o.stderr).trim().to_string();
                    let first = said.lines().next().unwrap_or("").trim().to_string();
                    return Err(if first.is_empty() {
                        "Aura couldn't set this folder up to track changes. Check that you \
                         can write to it, then try again."
                            .into()
                    } else {
                        format!("Aura couldn't set this folder up to track changes: {first}")
                    });
                }
                Err(e) => {
                    return Err(format!(
                        "Aura couldn't set this folder up to track changes — Git isn't \
                         available on this computer ({e})."
                    ))
                }
            }
        }
        Ok(())
    })
    .await?;
    aura_ensure_tracked(ensure_root).await
}

/// Is Aura passive capture already on here? `.aura/` present AND our git
/// pre-commit hook installed.
///
/// The hooks directory comes from `cmd_capture`'s resolver, not from a
/// hard-coded `<root>/.git/hooks`: in a linked worktree `.git` is a file and
/// the hooks live in the shared common dir, so the hard-coded path read as
/// "capture off" no matter how many times the user turned it on.
fn aura_capture_present(root: &Path) -> bool {
    if !root.join(".aura").is_dir() {
        return false;
    }
    match crate::cmd_capture::hooks_dir(root) {
        Some(hooks) => crate::cmd_capture::marker_present(&hooks),
        None => false,
    }
}

/// Shell the real `aura enable --quiet` in the repo — the idempotent,
/// non-interactive front door (creates `.aura/`, installs hooks, wires the
/// Team Radar).
///
/// Returns the CLI's own words on failure instead of a bare `false`. The
/// caller can't offer a working Retry — or explain why one didn't work —
/// without knowing what actually stopped it.
///
/// Every failure path drops the app's cached answer to "which `aura` do we
/// run" (`forget_resolved_aura`). That resolution is computed once per process
/// and, when nothing on the machine is current, it settles on whatever PATH
/// says — a 0.7.2 in `/usr/local/bin`, say. Without this, the user follows the
/// advice, installs a current CLI somewhere else, comes back, presses Try
/// again, and the app dutifully re-runs the same stale binary it decided on at
/// launch. The button worked; it just could not ever produce a different
/// answer. Re-probing costs a couple of `--version` spawns and only happens
/// after something already went wrong, so the working path is untouched.
fn run_aura_enable(repo_root: &str) -> Result<(), EnableFailure> {
    let bin = crate::agent_event_listener::resolve_aura_bin();
    let out = std::process::Command::new(&bin)
        .args(["enable", "--quiet"])
        .current_dir(repo_root)
        .output();
    match out {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            // `--quiet` keeps the success path silent, so whatever is here is
            // the complaint. stderr first, stdout as the backstop.
            let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
            let said = if stderr.is_empty() {
                String::from_utf8_lossy(&o.stdout).trim().to_string()
            } else {
                stderr
            };
            // An `aura` too old to know `enable` answers `error: unrecognized
            // subcommand 'enable'`, which tells the reader nothing. Ask the
            // binary its version so the caller can say the useful thing — and
            // offer the update — instead of quoting clap at a non-engineer.
            let stale = crate::cmd_doctor_cli::stale_cli(&bin);
            crate::cmd_doctor_cli::forget_resolved_aura();
            Err(EnableFailure { raw: said, stale })
        }
        Err(e) => {
            crate::cmd_doctor_cli::forget_resolved_aura();
            Err(EnableFailure {
                raw: format!("couldn't start Aura ({bin}): {e}"),
                stale: None,
            })
        }
    }
}

/// Where git actually keeps this checkout's local ignore list.
///
/// `.git/info/exclude` is only right for a plain checkout. In a linked
/// worktree `.git` is a *file* pointing at `…/.git/worktrees/<name>`, so
/// `create_dir_all(".git/info")` fails with `NotADirectory` and the exclude
/// block never gets written — silently, because the caller drops the error.
/// That is why `.aura/` reappears as untracked noise in every worktree even
/// though hiding it is the first thing repo-open does. Asking git resolves
/// the linked-worktree case the way git itself does, and falls back to the
/// literal path only when git can't be run at all.
fn local_exclude_path(root: &Path) -> std::path::PathBuf {
    let fallback = root.join(".git").join("info").join("exclude");
    let Ok(out) = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--git-path", "info/exclude"])
        .output()
    else {
        return fallback;
    };
    if !out.status.success() {
        return fallback;
    }
    let resolved = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if resolved.is_empty() {
        return fallback;
    }
    // `--git-path` answers relative to the repo root when it can.
    let path = std::path::PathBuf::from(resolved);
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

/// Append our marker-delimited block to `.git/info/exclude` if it isn't
/// there yet. `.git/info/exclude` is the local, never-committed ignore
/// list — perfect for hiding Aura's footprint without editing the repo's
/// tracked `.gitignore`. Idempotent: presence of the begin marker is a
/// no-op.
fn ensure_local_exclude(root: &Path) -> std::io::Result<()> {
    let exclude = local_exclude_path(root);
    if let Some(info_dir) = exclude.parent() {
        std::fs::create_dir_all(info_dir)?;
    }
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.contains(EXCLUDE_BEGIN) {
        return Ok(());
    }

    let mut block = String::new();
    if !existing.is_empty() && !existing.ends_with('\n') {
        block.push('\n');
    }
    block.push_str(EXCLUDE_BEGIN);
    block.push('\n');
    for e in EXCLUDE_ENTRIES {
        block.push_str(e);
        block.push('\n');
    }
    block.push_str(EXCLUDE_END);
    block.push('\n');

    let combined = format!("{existing}{block}");
    std::fs::write(&exclude, combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclude_block_is_idempotent_and_hides_aura() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".git").join("info")).unwrap();
        // Pre-existing user rule must survive.
        std::fs::write(root.join(".git/info/exclude"), "*.log\n").unwrap();

        ensure_local_exclude(root).unwrap();
        let body = std::fs::read_to_string(root.join(".git/info/exclude")).unwrap();
        assert!(body.contains("*.log"), "user rule preserved");
        assert!(body.contains("/.aura/"), "aura dir excluded");
        assert!(body.contains(EXCLUDE_BEGIN));

        // Second pass adds nothing.
        ensure_local_exclude(root).unwrap();
        let body2 = std::fs::read_to_string(root.join(".git/info/exclude")).unwrap();
        assert_eq!(body, body2, "second ensure is a no-op");
        assert_eq!(body2.matches(EXCLUDE_BEGIN).count(), 1);
    }

    /// The regression this exists for: in a linked worktree `.git` is a file,
    /// so writing to `.git/info/exclude` failed and `.aura/` stayed visible in
    /// `git status` — silently, since the caller drops the error.
    ///
    /// Asserted through `git check-ignore` rather than by reading the file we
    /// just wrote: the question is not "did we write a file" but "does git
    /// actually ignore .aura in this worktree", and only git can answer that.
    #[test]
    fn exclude_reaches_git_inside_a_linked_worktree() {
        fn git(cwd: &Path, args: &[&str]) -> bool {
            std::process::Command::new("git")
                .arg("-C")
                .arg(cwd)
                .args(args)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }

        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        std::fs::create_dir_all(&main).unwrap();
        if !git(&main, &["init"]) {
            return; // no git on this machine — nothing to assert
        }
        git(&main, &["config", "user.email", "t@example.com"]);
        git(&main, &["config", "user.name", "t"]);
        git(&main, &["commit", "--allow-empty", "-m", "init"]);

        let wt = dir.path().join("wt");
        if !git(&main, &["worktree", "add", wt.to_str().unwrap(), "-b", "feat"]) {
            return; // worktrees unavailable — nothing to assert
        }
        assert!(wt.join(".git").is_file(), "a linked worktree keeps .git as a file");

        ensure_local_exclude(&wt).expect("exclude must succeed in a worktree");

        std::fs::create_dir_all(wt.join(".aura")).unwrap();
        std::fs::write(wt.join(".aura").join("state.json"), "{}").unwrap();
        assert!(
            git(&wt, &["check-ignore", "-q", ".aura/state.json"]),
            "git itself must ignore .aura inside the worktree"
        );
    }

    /// Build a failure the way `run_aura_enable` does, for the explain tests.
    fn said(raw: &str) -> EnableFailure {
        EnableFailure {
            raw: raw.into(),
            stale: None,
        }
    }

    #[test]
    fn worktree_failure_reads_as_a_linked_copy_not_an_errno() {
        // What `aura enable` actually prints inside a worktree today.
        let raw = r#"Error: Os { code: 20, kind: NotADirectory, message: "Not a directory" }"#;
        let msg = explain_failure(Some(&said(raw)));
        assert!(msg.contains("linked copy"), "names the real situation: {msg}");
        assert!(!msg.contains("NotADirectory"), "no errno shorthand: {msg}");
        assert!(!msg.contains("worktree"), "no git jargon: {msg}");
    }

    #[test]
    fn missing_binary_failure_points_at_installing_it() {
        let msg = explain_failure(Some(&said(
            "couldn't start Aura (aura): No such file or directory",
        )));
        assert!(msg.contains("isn't installed"), "{msg}");
    }

    #[test]
    fn unknown_failure_quotes_the_tool_rather_than_guessing() {
        let msg = explain_failure(Some(&said("permission denied writing hooks\nsecond line")));
        assert!(msg.contains("permission denied writing hooks"), "{msg}");
        assert!(!msg.contains("second line"), "only the first line: {msg}");
    }

    #[test]
    fn silent_failure_still_says_something_actionable() {
        // The case that produced the dead Retry: nothing failed loudly, yet
        // capture is still off. Never resolve to an empty string.
        assert!(!explain_failure(None).trim().is_empty());
        assert!(!explain_failure(Some(&said(""))).trim().is_empty());
    }

    /// The Ubuntu screenshot, in one assertion. A 0.7.2 `aura` predates the
    /// `enable` subcommand by three months, so clap answers `error:
    /// unrecognized subcommand 'enable'` — and the strip used to print exactly
    /// that, clipped to `error: unr…`, next to a Try again that reran the same
    /// missing subcommand forever.
    #[test]
    fn an_old_helper_is_named_by_version_not_by_quoting_clap() {
        let f = EnableFailure {
            raw: "error: unrecognized subcommand 'enable'\n\nUsage: aura <COMMAND>".into(),
            stale: Some(StaleCli {
                installed: "0.7.2".into(),
                expected: "0.19.36".into(),
                path: "/usr/local/bin/aura".into(),
            }),
        };
        let msg = explain_failure(Some(&f));
        assert!(msg.contains("0.7.2"), "says which version they have: {msg}");
        assert!(msg.contains("0.19.36"), "says which version is needed: {msg}");
        assert!(
            !msg.contains("unrecognized subcommand"),
            "never quotes clap at the reader: {msg}"
        );
        assert!(
            !msg.contains("It said:"),
            "our own prose must not be attributed to the tool: {msg}"
        );
    }

    /// The visible line is one line tall and clips. Whatever a non-engineer
    /// needs — the two version numbers — has to survive that clip, so it lives
    /// in the opening words, not after a lead-in.
    #[test]
    fn the_version_numbers_survive_a_one_line_clip() {
        let f = EnableFailure {
            raw: "error: unrecognized subcommand 'enable'".into(),
            stale: Some(StaleCli {
                installed: "0.7.2".into(),
                expected: "0.19.36".into(),
                path: "/usr/local/bin/aura".into(),
            }),
        };
        let msg = explain_failure(Some(&f));
        let head: String = msg.chars().take(80).collect();
        assert!(head.contains("0.7.2"), "installed version is up front: {head}");
        assert!(head.contains("0.19.36"), "expected version is up front: {head}");
    }

    #[test]
    fn capture_absent_without_hook() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".aura")).unwrap();
        std::fs::create_dir_all(root.join(".git").join("hooks")).unwrap();
        assert!(!aura_capture_present(root), "no pre-commit hook => not tracked");
        std::fs::write(
            root.join(".git/hooks/pre-commit"),
            "#!/bin/sh\n# --- AURA SEMANTIC ENGINE ---\naura capture-context\n",
        )
        .unwrap();
        assert!(aura_capture_present(root), "hook marker => tracked");
    }
}
