//! Wiring an agent CLI in a repo so its work reaches Aura.
//!
//! Aura learns what an agent did from hooks the agent itself calls: Claude's
//! `PreToolUse` / `Stop` / `SessionStart` scripts, Gemini's extension hooks.
//! Something has to put those on disk and point the agent at them, and that
//! something used to be the desktop app — specifically, the moment the app
//! spawned a Claude PTY.
//!
//! Which meant the wiring existed only for people who used the app. Clone the
//! repo, install the CLI, run `claude` in a terminal, and there were no hooks
//! at all: nothing recorded, nothing on the team's console, and no error
//! either — the work simply did not show up. That is what this crate is for.
//! It owns the plugin packages and the stamping, and both the CLI (`aura
//! init`) and the shell call it, so the two cannot drift apart.
//!
//! **The plugin packages live here, next to the code that installs them.**
//! They are distributable packages in their own right — LICENSE, README,
//! `marketplace.json`, `plugin.json` — but their bodies are also compiled
//! into the binary with `include_str!`, so the app can stamp a machine that
//! never downloaded anything. That include is why they sit inside this crate
//! rather than beside the desktop app: the public mirror re-roots crates to a
//! different depth than the private tree (`aura-hooks/` → `crates/aura-hooks/`),
//! so any path that leaves the crate resolves differently in the two repos and
//! one of them stops compiling. A crate-local path resolves the same in both.
//!
//! Everything here is idempotent and best-effort. A machine with no HOME, a
//! read-only repo, a hand-edited settings file we refuse to touch — each
//! returns `None` and leaves the rest of the wiring to carry on. Failing to
//! wire an agent is not a reason to fail to start one.

use std::path::{Path, PathBuf};

mod claude;
mod codex;
mod gemini;
mod hooks_json;
mod kimi;
mod mcp;
mod opencode;
mod pi;
mod shared;

pub use claude::{merge_aura_hooks, stamp_claude_hooks, AURA_CLAUDE_SCRIPTS};
pub use codex::stamp_codex_hooks;
pub use gemini::{stamp_gemini_extension, AURA_GEMINI_FILES};
pub use kimi::stamp_kimi_hooks;
pub use mcp::{ensure_repo_mcp_json, ensure_shell_mcp_config, which_aura, SERVER_NAME};
pub use opencode::{stamp_opencode_plugin, AURA_OPENCODE_PLUGIN};
pub use pi::{stamp_pi_extension, AURA_PI_EXTENSION};
pub use shared::AURA_AGENT_SCRIPTS;

/// What actually landed. Reported rather than returned as a bare bool because
/// the caller is usually telling a person what happened — `aura init` prints
/// it, and the app decides from `wired()` whether a repo is set up at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Wiring {
    /// `~/.aura/shell-mcp-config.json` — the config the app passes to Claude
    /// as `--mcp-config`. User-global, not per repo.
    pub shell_mcp_config: bool,
    /// `<repo>/.mcp.json` — how a Claude session started from a plain
    /// terminal in this repo finds Aura's tools.
    pub repo_mcp_json: bool,
    /// `<repo>/.claude/settings.local.json` — the hooks that record what the
    /// agent did.
    pub claude_hooks: bool,
    /// `~/.gemini/extensions/aura-gemini/` — user-global, and harmless on a
    /// machine with no Gemini.
    pub gemini_extension: bool,
    /// `~/.codex/hooks.json` — user-global. Codex does not read a per-repo
    /// hooks file at all.
    pub codex_hooks: bool,
    /// `~/.kimi/config.toml` — user-global, and the only stamp that edits a
    /// file the user keeps their own settings in.
    pub kimi_hooks: bool,
    /// `~/.config/opencode/plugin/aura.js` — user-global.
    pub opencode_plugin: bool,
    /// `~/.pi/agent/extensions/aura.ts` — user-global.
    pub pi_extension: bool,
}

impl Wiring {
    /// True when this repo can report an agent's work to Aura.
    ///
    /// Only the three repo-facing stamps count. Every other field is
    /// user-global — it says something true about the machine and nothing at
    /// all about this repo — so a repo whose own wiring failed would otherwise
    /// report success on the strength of a file in somebody's home directory.
    pub fn wired(&self) -> bool {
        self.shell_mcp_config || self.repo_mcp_json || self.claude_hooks
    }
}

/// Wire every agent CLI so edits in `repo_root` log intent through Aura,
/// regardless of which agent — or how it was launched.
///
/// Idempotent, and meant to be called often: on repo-open, at PTY spawn, and
/// from `aura init`. Re-running is also how a stale stamp gets repaired, so a
/// repo wired by an older version picks up new scripts rather than keeping the
/// old ones forever.
pub fn wire_agents_for_repo(repo_root: &str) -> Wiring {
    Wiring {
        shell_mcp_config: ensure_shell_mcp_config().is_some(),
        repo_mcp_json: ensure_repo_mcp_json(repo_root),
        claude_hooks: stamp_claude_hooks(repo_root).is_some(),
        gemini_extension: stamp_gemini_extension().is_some(),
        // The rest are user-global because their CLIs offer nothing else:
        // codex ignores a per-repo hooks file entirely, and kimi, opencode and
        // pi discover their hooks from one place per machine. That suits the
        // purpose — the repo Aura most needs to hear about is the one nobody
        // has opened in the app, and a per-repo stamp would miss exactly that.
        //
        // Each is skipped on a machine where its CLI has never run, and picked
        // up by the next repo-open after it is installed. cursor is absent by
        // design: it reads Claude's settings file, so `claude_hooks` above is
        // already its stamp.
        codex_hooks: stamp_codex_hooks().is_some(),
        kimi_hooks: stamp_kimi_hooks().is_some(),
        opencode_plugin: stamp_opencode_plugin().is_some(),
        pi_extension: stamp_pi_extension().is_some(),
    }
}

/// `~/.aura`, or `None` on a machine with no HOME.
pub(crate) fn aura_home() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".aura");
    Some(p)
}

/// Write `body` to `path`, creating parents, and make it executable when it is
/// a shell script.
///
/// The executable bit is not cosmetic: hooks are run by fork+exec with no
/// shell wrapper, so a script without it fails with `EACCES` on every single
/// tool call — noisily, forever, in a file nobody opens.
/// Stage a set of scripts, but never downgrade what is already there.
///
/// The scripts live in one shared directory and are written by *two* binaries
/// that ship on their own schedules: the `aura` CLI and the desktop app both
/// embed a copy and both re-stage on startup. Whichever ran last won, so an
/// app a release behind quietly overwrote the CLI's newer scripts every time
/// somebody opened a repo — and the symptom was nothing like the cause. The
/// hook that had learned to pass `--file` went back to not passing it, no
/// intent row named a file again, and the console's per-file "why did this
/// change" answered "no reason was written" about every file in the project.
///
/// `rev` is bumped by hand whenever a script in the set changes. It is kept
/// beside the scripts rather than inside them so there is one number to read
/// and one to bump, and an unreadable or missing stamp means "older than
/// anything", which is right for a directory staged before this existed.
///
/// Equal revs still write: same generation, same bytes, and re-staging repairs
/// a script somebody edited or a permission bit that got lost.
pub(crate) fn stage_scripts(dir: &Path, scripts: &[(&str, &str)], rev: u32) -> Option<()> {
    std::fs::create_dir_all(dir).ok()?;
    let stamp = dir.join(".rev");
    let staged = std::fs::read_to_string(&stamp)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0);
    if staged > rev {
        // Something newer is already here. Leave it alone — and say so to
        // nobody, because this is the normal state of a machine whose CLI is
        // ahead of its app.
        return Some(());
    }
    for (name, body) in scripts {
        write_script(&dir.join(name), body)?;
    }
    let _ = std::fs::write(&stamp, rev.to_string());
    Some(())
}

pub(crate) fn write_script(path: &Path, body: &str) -> Option<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok()?;
    }
    std::fs::write(path, body).ok()?;
    if path.extension().is_some_and(|e| e == "sh") {
        set_executable(path);
    }
    Some(())
}

#[cfg(unix)]
fn set_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(0o755);
        let _ = std::fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repo_with_nothing_wired_does_not_claim_to_be() {
        assert!(!Wiring::default().wired());
    }

    #[test]
    fn a_user_global_stamp_alone_is_not_a_wired_repo() {
        // These all land in someone's home directory and say nothing about
        // this repo, so a repo whose own hooks failed would otherwise report
        // success on the strength of a file it has never met.
        for w in [
            Wiring { gemini_extension: true, ..Default::default() },
            Wiring { codex_hooks: true, ..Default::default() },
            Wiring { kimi_hooks: true, ..Default::default() },
            Wiring { opencode_plugin: true, ..Default::default() },
            Wiring { pi_extension: true, ..Default::default() },
        ] {
            assert!(!w.wired(), "{w:?}");
        }
    }

    /// The two post-tool-use hooks, as they are compiled into the binary and
    /// staged onto every machine. Read from the embedded tables rather than
    /// from disk, because the table is what ships.
    fn post_tool_use_hooks() -> Vec<(&'static str, &'static str)> {
        let claude = AURA_CLAUDE_SCRIPTS
            .iter()
            .find(|(name, _)| *name == "on-post-tool-use.sh")
            .map(|(_, body)| ("aura-claude", *body))
            .expect("the claude post-tool-use hook is staged");
        let gemini = AURA_GEMINI_FILES
            .iter()
            .find(|(name, _)| *name == "scripts/on-post-tool-use.sh")
            .map(|(_, body)| ("aura-gemini", *body))
            .expect("the gemini post-tool-use hook is staged");
        vec![claude, gemini]
    }

    /// Where a hook first *calls* for an intent row.
    ///
    /// Two spellings, because one script logs inline and the other goes
    /// through a helper — and a helper is necessarily *defined* above the
    /// gate, which is not the same as logging above it. The definition is not
    /// the call, and it is the call that must stay outside.
    fn first_intent_call(body: &str) -> Option<usize> {
        let helper = body.find("\n            log_intent \"").or(body.find("\n        log_intent \""));
        let inline = body.find("aura log-intent \"");
        match (helper, inline) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    #[test]
    fn recording_what_an_agent_changed_does_not_depend_on_the_host_terminal() {
        // The regression: `if ! should_use_structured; then exit 0; fi` at the
        // top of the file. That gate asks whether an Aura Shell tab is
        // listening for a notification. It has nothing to say about whether
        // an edit is worth recording — but the auto-log-intent block sat under
        // it, so the same agent run from Terminal, iTerm, ssh or a runner
        // wrote no intent row at all. Nothing local, so nothing pushed, so the
        // web console showed a tracked repo as idle while somebody was
        // actively editing it.
        for (plugin, body) in post_tool_use_hooks() {
            assert!(
                !body.contains("if ! should_use_structured"),
                "{plugin}: the hook still exits early when no Aura Shell hosts it"
            );
            let logs = first_intent_call(body)
                .unwrap_or_else(|| panic!("{plugin}: the hook no longer logs intent"));
            let gate = body
                .find("if should_use_structured; then")
                .unwrap_or_else(|| panic!("{plugin}: the notification is no longer gated"));
            let gate_end = gate
                + body[gate..]
                    .find("\nfi\n")
                    .unwrap_or_else(|| panic!("{plugin}: the gated block never closes"));
            assert!(
                logs > gate_end,
                "{plugin}: intent logging is back inside the notification gate"
            );
        }
    }

    #[test]
    fn the_hook_reads_stdin_once_and_before_the_gate() {
        // Both halves of the script want the tool payload, and a pipe gives it
        // up once. Reading it inside the gated half would leave the ungated
        // half with nothing to log.
        for (plugin, body) in post_tool_use_hooks() {
            assert_eq!(
                body.matches("INPUT=$(cat)").count(),
                1,
                "{plugin}: stdin is read more than once"
            );
            let read = body.find("INPUT=$(cat)").unwrap();
            let gate = body.find("if should_use_structured; then").unwrap();
            assert!(read < gate, "{plugin}: stdin is read inside the gate");
        }
    }

    #[test]
    fn any_of_the_three_repo_facing_stamps_counts() {
        for w in [
            Wiring { shell_mcp_config: true, ..Default::default() },
            Wiring { repo_mcp_json: true, ..Default::default() },
            Wiring { claude_hooks: true, ..Default::default() },
        ] {
            assert!(w.wired(), "{w:?}");
        }
    }
}
