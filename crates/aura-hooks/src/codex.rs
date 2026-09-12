//! Codex's hooks.
//!
//! Codex adopted Claude Code's hook file wholesale — same `{hooks: {Event:
//! [{hooks: [{type, command}]}]}}` shape, same `snake_case` payload with
//! `tool_name` / `tool_input` / `tool_response` / `cwd` — so the merge is the
//! shared one and only the path and the tool names differ.
//!
//! **User-global, and only user-global.** Codex reads `~/.codex/hooks.json`
//! and the managed layers above it; a `hooks.json` inside a repo is not read
//! at all. That was checked rather than assumed — five spellings of a
//! project-level hook file were tried against codex 0.147.0 (`.codex/hooks.json`,
//! `hooks.json`, `.codex/hooks/hooks.json`, `.agents/hooks.json`,
//! `.codex/hooks/aura.json`), inside and outside HOME, untrusted and with the
//! project marked trusted, and none of them fired. Which suits the purpose
//! here anyway: the repo Aura most needs to hear about is the one it has never
//! been told about, so a per-repo stamp would miss exactly the case this
//! exists for.

use crate::hooks_json::Stamp;

/// Stamp the shared post-tool-use hook into `~/.codex/hooks.json`.
///
/// Merge-safe: this file is shared with anything else the user has installed
/// — Superset stamps `SessionStart`, `UserPromptSubmit` and `Stop` into it —
/// so the merge adds Aura's entry, replaces Aura's own stale ones, and leaves
/// every other entry exactly where it is.
pub fn stamp_codex_hooks() -> Option<()> {
    let mut path = crate::shared::existing_agent_dir(".codex")?;
    let script_dir = crate::shared::stage_shared_scripts()?;
    path.push("hooks.json");

    let stamps = [Stamp {
        event: "PostToolUse",
        command: crate::shared::hook_command(&script_dir, "Codex"),
        matcher: None,
    }];
    crate::hooks_json::merge_file(&path, &stamps, crate::shared::STAGED_DIR_MARKER)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks_json::merge;
    use serde_json::json;

    fn aura_stamp(home: &str) -> [Stamp; 1] {
        [Stamp {
            event: "PostToolUse",
            command: crate::shared::hook_command(
                std::path::Path::new(&format!("{home}/.aura/plugins/aura-agent/scripts")),
                "Codex",
            ),
            matcher: None,
        }]
    }

    #[test]
    fn another_tools_hooks_in_the_same_file_survive() {
        // `~/.codex/hooks.json` is not ours. This machine's copy already had
        // three Superset entries in it before Aura wrote a line of this, and
        // a stamp that clobbered them would silently break somebody else's
        // product.
        let mut root = serde_json::Map::new();
        root.insert(
            "hooks".into(),
            json!({
                "SessionStart": [{ "hooks": [
                    { "type": "command", "command": "OTHER=1 \"/Users/real/.other/notify.sh\"" }
                ]}]
            }),
        );

        merge(
            &mut root,
            &aura_stamp("/Users/real"),
            crate::shared::STAGED_DIR_MARKER,
        )
        .unwrap();

        assert_eq!(
            root["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "OTHER=1 \"/Users/real/.other/notify.sh\"",
        );
        assert!(root["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("AURA_HOOK_AGENT=Codex"));
    }

    #[test]
    fn re_stamping_under_a_rotated_home_replaces_rather_than_appends() {
        let mut root = serde_json::Map::new();
        merge(
            &mut root,
            &aura_stamp("/tmp/throwaway"),
            crate::shared::STAGED_DIR_MARKER,
        )
        .unwrap();
        merge(
            &mut root,
            &aura_stamp("/Users/real"),
            crate::shared::STAGED_DIR_MARKER,
        )
        .unwrap();

        let entries = root["hooks"]["PostToolUse"].as_array().unwrap();
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert!(entries[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("/Users/real/"));
    }

    #[test]
    fn a_hand_shaped_hooks_key_is_refused_rather_than_corrupted() {
        let mut root = serde_json::Map::new();
        root.insert("hooks".into(), json!("please don't"));
        let before = root.clone();
        assert!(merge(
            &mut root,
            &aura_stamp("/Users/real"),
            crate::shared::STAGED_DIR_MARKER
        )
        .is_none());
        assert_eq!(root, before);
    }
}
