//! The one hook body every agent CLI that is not Claude Code runs.
//!
//! Four CLIs — codex, kimi, opencode, pi — disagree about what a tool is
//! called, what its arguments are called, and whether the keys are
//! `snake_case` or `camelCase`. They agree about everything else: this tool
//! changed a file, so record it. Written once per CLI that decision would
//! exist four times, and the first time one of them learned about a new
//! editing tool the other three would quietly stop noticing it.
//!
//! So there is one script, staged once, and each CLI is pointed at it in
//! whatever way that CLI supports: a shell command for codex and kimi, and a
//! module that pipes into it for opencode and pi.
//!
//! cursor is the fifth non-Claude CLI and is deliberately absent: it reads
//! Claude's own `settings.local.json`, so Aura's Claude stamp already drives
//! it, and a second stamp would log every edit twice. See `claude.rs`.

use std::path::PathBuf;

/// The shared plugin package, compiled in.
///
/// As with the Claude and Gemini packages, the bodies ride along in the binary
/// rather than being read from the bundle: after a `.app` is installed there is
/// no reliable way for library code to find its own resources, and a machine
/// that only ever installed the CLI never downloaded a plugin at all.
pub const AURA_AGENT_SCRIPTS: &[(&str, &str)] = &[(
    "on-post-tool-use.sh",
    include_str!("../plugins/aura-agent/scripts/on-post-tool-use.sh"),
)];

/// Where the shared script lives, as a substring to recognise our own stamps
/// by. It must stay stable across versions — a rename here orphans every stamp
/// already on disk, and the orphan prints an error on every tool call forever.
pub(crate) const STAGED_DIR_MARKER: &str = "/.aura/plugins/aura-agent/scripts/";

/// Stage the shared script under `~/.aura/plugins/aura-agent/scripts/` and
/// return that directory.
///
/// Overwrites deliberately, so upgrading Aura upgrades the script on machines
/// wired months ago rather than only on new ones.
pub(crate) fn stage_shared_scripts() -> Option<PathBuf> {
    let mut dir = crate::aura_home()?;
    dir.push("plugins");
    dir.push("aura-agent");
    dir.push("scripts");
    std::fs::create_dir_all(&dir).ok()?;
    for (name, body) in AURA_AGENT_SCRIPTS {
        crate::write_script(&dir.join(name), body)?;
    }
    Some(dir)
}

/// A CLI's own config directory, but only if it exists.
///
/// Aura stamps into directories other tools own, and creating one on a machine
/// where that tool was never installed leaves a stray config dir behind for a
/// product the user does not have. So a missing directory means "not installed
/// here" and the stamp is skipped — no error, nothing written.
///
/// Nothing is lost by waiting: wiring runs on every repo-open and every `aura
/// init`, so the first of those after the CLI is installed picks it up.
pub(crate) fn existing_agent_dir(rel: &str) -> Option<PathBuf> {
    let mut p = PathBuf::from(std::env::var_os("HOME")?);
    p.push(rel);
    p.is_dir().then_some(p)
}

/// The command a shell-command CLI runs: the shared script, told which agent
/// it is speaking for.
///
/// The agent name only ever reaches the intent text, but it is the difference
/// between a console row that says who was working and one that says "Agent".
pub(crate) fn hook_command(script_dir: &std::path::Path, agent: &str) -> String {
    let path = script_dir.join("on-post-tool-use.sh");
    format!("AURA_HOOK_AGENT={} {}", agent, sh_quote(&path.to_string_lossy()))
}

/// Single-quote for `sh`. Hook commands are handed to a shell, and a home
/// directory with a space in it is ordinary on macOS.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn a_home_with_a_space_in_it_still_produces_one_argument() {
        let cmd = hook_command(
            Path::new("/Users/some one/.aura/plugins/aura-agent/scripts"),
            "Codex",
        );
        assert_eq!(
            cmd,
            "AURA_HOOK_AGENT=Codex '/Users/some one/.aura/plugins/aura-agent/scripts/on-post-tool-use.sh'"
        );
    }

    #[test]
    fn the_command_carries_the_marker_we_recognise_our_own_stamps_by() {
        // If these two ever disagree, every re-stamp appends beside the last
        // one instead of replacing it, and the file grows a copy per upgrade.
        let cmd = hook_command(
            Path::new("/Users/real/.aura/plugins/aura-agent/scripts"),
            "Kimi",
        );
        assert!(cmd.contains(STAGED_DIR_MARKER), "{cmd}");
    }

    /// The shared script speaks every CLI's dialect, and each dialect is one
    /// line in a `case`. These pin the tool names that mean "a file changed"
    /// for each CLI we stamp — dropping one is silent: that CLI simply stops
    /// reporting, with no error anywhere.
    #[test]
    fn the_shared_script_answers_every_dialect_we_stamp_for() {
        let body = AURA_AGENT_SCRIPTS[0].1;
        for (cli, tools) in [
            ("codex", ["apply_patch", "shell"].as_slice()),
            ("kimi", ["write", "edit", "multi_edit", "bash"].as_slice()),
            ("opencode", ["write", "edit", "patch", "bash"].as_slice()),
            ("pi", ["write", "edit", "bash"].as_slice()),
        ] {
            for tool in tools {
                assert!(
                    body.contains(tool),
                    "{cli}: the shared script no longer handles `{tool}`",
                );
            }
        }
    }

    #[test]
    fn the_shared_script_reads_the_payload_before_it_needs_it() {
        // stdin is a pipe: it gives up its contents once. Every branch below
        // reads from `$INPUT`, so the read has to happen before the `case`.
        let body = AURA_AGENT_SCRIPTS[0].1;
        assert_eq!(body.matches("INPUT=$(cat").count(), 1);
        assert!(body.find("INPUT=$(cat").unwrap() < body.find("case \"$TOOL\"").unwrap());
    }

    #[test]
    fn the_shared_script_never_fails_the_tool_call_it_watches() {
        // A post-tool hook runs between the agent's tool call and the agent
        // seeing its result. A non-zero exit there is reported to the agent as
        // something going wrong with its own work.
        let body = AURA_AGENT_SCRIPTS[0].1;
        assert!(body.trim_end().ends_with("exit 0"));
        assert!(
            !body.contains("set -e"),
            "an unguarded command would abort the script mid-payload",
        );
    }
}
