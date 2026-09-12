//! Pi's extension.
//!
//! Like OpenCode, Pi loads modules rather than running shell commands, and it
//! discovers every file in `~/.pi/agent/extensions/` for every project —
//! checked here with a marker file, not read off a page. So Aura's extension
//! is a shim over the shared script.
//!
//! The one thing Pi does differently: a tool call arrives as two events, and
//! only the first carries the arguments. The extension holds them until the
//! call finishes, so a tool that was blocked or errored is not recorded as an
//! edit that happened.
//!
//! The file is `aura.ts`, and the name matters more than it looks: this
//! directory is shared, and at least one other tool stamps its own extension
//! beside ours.

use std::path::PathBuf;

/// The extension body, compiled in.
pub const AURA_PI_EXTENSION: &str = include_str!("../plugins/aura-agent/extensions/pi.ts");

/// Stage the shared script and drop the extension into Pi's global extension
/// directory.
pub fn stamp_pi_extension() -> Option<()> {
    crate::shared::stage_shared_scripts()?;
    let mut path = pi_agent_dir()?;
    path.push("extensions");
    path.push("aura.ts");
    crate::opencode::write_if_changed(&path, AURA_PI_EXTENSION)
}

/// `~/.pi/agent`, and only if it is already there — Pi creates it on first
/// run, so a missing one means Pi has never run on this machine.
fn pi_agent_dir() -> Option<PathBuf> {
    let mut p = PathBuf::from(std::env::var_os("HOME")?);
    p.push(".pi");
    p.push("agent");
    p.is_dir().then_some(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_extension_pipes_into_the_shared_script_rather_than_deciding_for_itself() {
        assert!(AURA_PI_EXTENSION.contains("on-post-tool-use.sh"));
        assert!(
            !AURA_PI_EXTENSION.contains("aura log-intent"),
            "the shim has started making the decision itself",
        );
    }

    #[test]
    fn it_waits_for_the_call_to_finish_before_recording_it() {
        // Pi splits a tool call in two and only the start carries arguments.
        // Recording on the start event would log edits that were then blocked
        // by a permission prompt or failed outright.
        assert!(AURA_PI_EXTENSION.contains("tool_execution_start"));
        assert!(AURA_PI_EXTENSION.contains("tool_execution_end"));
        let start = AURA_PI_EXTENSION.find("tool_execution_start").unwrap();
        let end = AURA_PI_EXTENSION.find("tool_execution_end").unwrap();
        let report = AURA_PI_EXTENSION.rfind("report({").expect("it reports somewhere");
        assert!(report > end && end > start, "the report moved off the end event");
        assert!(AURA_PI_EXTENSION.contains("isError"), "a failed call is recorded as an edit");
    }

    #[test]
    fn it_names_itself_so_the_intent_row_says_who_was_working() {
        assert!(AURA_PI_EXTENSION.contains("AURA_HOOK_AGENT"));
        assert!(AURA_PI_EXTENSION.contains("\"Pi\""));
    }

    #[test]
    fn it_asks_for_the_session_id_rather_than_reading_one_off_the_event() {
        // Pi is the only one of these CLIs that does not put a session id on
        // the tool event; it identifies a session by its file, reachable only
        // through the handler's context.
        assert!(AURA_PI_EXTENSION.contains("getSessionId"));
        assert!(AURA_PI_EXTENSION.contains("sessionId"));
    }
}
