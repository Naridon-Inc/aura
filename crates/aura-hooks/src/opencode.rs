//! OpenCode's plugin.
//!
//! OpenCode has no shell-command hooks. A plugin is a JavaScript module it
//! imports, and every `.js` in its global plugin directory is loaded for every
//! project — checked on this machine with a marker file rather than taken from
//! the docs. So Aura's plugin is a shim: it receives `tool.execute.after` and
//! pipes the call into the shared script, which is where the decision about
//! what counts as a change actually lives.

use std::path::PathBuf;

/// The plugin body, compiled in — see `AURA_AGENT_SCRIPTS` for why the bodies
/// ride along in the binary rather than being read from a bundle.
pub const AURA_OPENCODE_PLUGIN: &str = include_str!("../plugins/aura-agent/plugin/opencode.js");

/// Stage the shared script and drop the plugin into OpenCode's global plugin
/// directory.
pub fn stamp_opencode_plugin() -> Option<()> {
    crate::shared::stage_shared_scripts()?;
    let mut path = opencode_config_dir()?;
    path.push("plugin");
    path.push("aura.js");
    write_if_changed(&path, AURA_OPENCODE_PLUGIN)
}

/// `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode` — and only if it is
/// already there. OpenCode creates it on first run, so a missing one means
/// OpenCode has never run here.
fn opencode_config_dir() -> Option<PathBuf> {
    let base = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(x) if !x.is_empty() => PathBuf::from(x),
        _ => {
            let mut p = PathBuf::from(std::env::var_os("HOME")?);
            p.push(".config");
            p
        }
    };
    let dir = base.join("opencode");
    dir.is_dir().then_some(dir)
}

/// Write only when the body differs.
///
/// Both module shims are watched by their host — OpenCode reloads plugins when
/// their files change — so rewriting an identical file on every repo-open would
/// make the agent reload its plugins several times a day for nothing.
pub(crate) fn write_if_changed(path: &std::path::Path, body: &str) -> Option<()> {
    if std::fs::read_to_string(path).is_ok_and(|existing| existing == body) {
        return Some(());
    }
    crate::write_script(path, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plugin_pipes_into_the_shared_script_rather_than_deciding_for_itself() {
        // The moment this file starts naming tools, it is a second opinion
        // about what counts as a change — and it will disagree with the shared
        // script the first time either of them learns a new editing tool.
        assert!(AURA_OPENCODE_PLUGIN.contains("on-post-tool-use.sh"));
        assert!(AURA_OPENCODE_PLUGIN.contains("tool.execute.after"));
        assert!(
            !AURA_OPENCODE_PLUGIN.contains("aura log-intent"),
            "the shim has started making the decision itself",
        );
    }

    #[test]
    fn the_plugin_offers_exactly_one_registration() {
        // OpenCode registers any export that looks like a plugin. A module
        // offering the same function as both a named and a default export gets
        // registered twice — and two registrations is two intent rows per edit.
        assert_eq!(AURA_OPENCODE_PLUGIN.matches("\nexport ").count(), 1);
        assert!(AURA_OPENCODE_PLUGIN.contains("export default"));
    }

    #[test]
    fn it_names_itself_so_the_intent_row_says_who_was_working() {
        assert!(AURA_OPENCODE_PLUGIN.contains("AURA_HOOK_AGENT"));
        assert!(AURA_OPENCODE_PLUGIN.contains("OpenCode"));
    }

    #[test]
    fn it_carries_the_session_id_the_console_groups_rows_by() {
        // Without this the rows still arrive, and the console still cannot
        // show a session — which is the entire reason any of this exists.
        assert!(AURA_OPENCODE_PLUGIN.contains("input.sessionID"));
    }

    #[test]
    fn an_unchanged_body_is_not_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plugin/aura.js");
        write_if_changed(&path, "one").unwrap();
        let first = std::fs::metadata(&path).unwrap().modified().unwrap();
        write_if_changed(&path, "one").unwrap();
        assert_eq!(first, std::fs::metadata(&path).unwrap().modified().unwrap());
        write_if_changed(&path, "two").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
    }
}
