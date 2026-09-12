//! Claude's hooks: the scripts, and the settings file that points at them.
//!
//! **This stamp also drives cursor-agent, which is why cursor has no module of
//! its own.** cursor-agent reads `<repo>/.claude/settings.local.json` (as well
//! as `~/.claude/settings.json`) and remaps Claude's event and tool names onto
//! its own before calling a hook — `PostToolUse` → `postToolUse`, `Edit` →
//! `Write`, `Bash` → `Shell`. A repo wired for Claude is therefore already
//! wired for cursor, and stamping `~/.cursor/hooks.json` as well would fire
//! both paths and log every edit twice.

use crate::hooks_json::Stamp;
use std::path::{Path, PathBuf};

/// The aura-claude plugin scripts, compiled in.
///
/// They exist on disk beside this file as a real, distributable plugin — but
/// the app must be able to wire a machine that never downloaded one, and
/// after a `.app` is installed there is no reliable way to find the bundle's
/// resources from library code. So the bodies ride along in the binary and get
/// staged under `~/.aura/plugins/aura-claude/scripts/` on first use.
pub const AURA_CLAUDE_SCRIPTS: &[(&str, &str)] = &[
    (
        "should-use-structured.sh",
        include_str!("../plugins/aura-claude/plugins/aura/scripts/should-use-structured.sh"),
    ),
    (
        "aura-notify.sh",
        include_str!("../plugins/aura-claude/plugins/aura/scripts/aura-notify.sh"),
    ),
    (
        "aura-notify-rpc.sh",
        include_str!("../plugins/aura-claude/plugins/aura/scripts/aura-notify-rpc.sh"),
    ),
    (
        "build-payload.sh",
        include_str!("../plugins/aura-claude/plugins/aura/scripts/build-payload.sh"),
    ),
    (
        "on-session-start.sh",
        include_str!("../plugins/aura-claude/plugins/aura/scripts/on-session-start.sh"),
    ),
    (
        "on-stop.sh",
        include_str!("../plugins/aura-claude/plugins/aura/scripts/on-stop.sh"),
    ),
    (
        "on-prompt-submit.sh",
        include_str!("../plugins/aura-claude/plugins/aura/scripts/on-prompt-submit.sh"),
    ),
    (
        "on-permission-request.sh",
        include_str!("../plugins/aura-claude/plugins/aura/scripts/on-permission-request.sh"),
    ),
    (
        "on-post-tool-use.sh",
        include_str!("../plugins/aura-claude/plugins/aura/scripts/on-post-tool-use.sh"),
    ),
    (
        "on-pre-tool-use.sh",
        include_str!("../plugins/aura-claude/plugins/aura/scripts/on-pre-tool-use.sh"),
    ),
    (
        "on-notification.sh",
        include_str!("../plugins/aura-claude/plugins/aura/scripts/on-notification.sh"),
    ),
    (
        "on-subagent-stop.sh",
        include_str!("../plugins/aura-claude/plugins/aura/scripts/on-subagent-stop.sh"),
    ),
];

/// Which script answers which event, and for what.
///
/// `PreToolUse` and `PostToolUse` are the pair that matter for recording work:
/// between them they see every edit an agent makes, which is what lets a
/// repo report itself as active rather than idle.
const AURA_ENTRIES: &[(&str, &str, Option<&str>)] = &[
    ("SessionStart", "on-session-start.sh", Some("startup|resume")),
    ("Stop", "on-stop.sh", None),
    ("Notification", "on-notification.sh", Some("idle_prompt")),
    ("PermissionRequest", "on-permission-request.sh", None),
    ("UserPromptSubmit", "on-prompt-submit.sh", None),
    ("PreToolUse", "on-pre-tool-use.sh", Some("*")),
    ("PostToolUse", "on-post-tool-use.sh", None),
    ("SubagentStop", "on-subagent-stop.sh", None),
];

/// Which generation of the script set this build carries. **Bump it whenever a
/// script in `AURA_CLAUDE_SCRIPTS` changes.**
///
/// The scripts are staged into one shared directory by two binaries that ship
/// independently — the `aura` CLI and the desktop app — so the last one to run
/// wins, and for months that was whichever the user happened to open second.
/// A desktop app one release behind re-staged its older `on-post-tool-use.sh`
/// over the CLI's newer one on every repo-open, silently taking `--file` back
/// out of the hook's `log-intent` call; no intent row named a file after that,
/// and the console's per-file "why did this change" band answered "no reason
/// was written" about every file in the project.
///
/// 1 is the first generation to say so. Anything staged before this existed
/// reads as 0 and is upgraded, which is right — it predates `--file`.
///
/// 2 is the generation that beats, logs intent outside the notification gate,
/// and asks before syncing a transcript. All three shipped under rev 1 without
/// the bump this doc comment asks for, which meant an older binary staging its
/// own rev 1 could still write over them — equal revs are re-staged on purpose,
/// so *not bumping* is the one way to make the guard do nothing at all.
/// 3 is the generation that knows a session is not one worker. `PostToolUse`
/// now forwards Claude's `agent_id` to `log-intent`, and `SubagentStop` is
/// registered at all — before it, the only record that a Task-tool worker had
/// run was a directory of transcripts on the person's own disk that nothing
/// ever opened, so every sub-agent's edits reached the console anonymous.
const SCRIPTS_REV: u32 = 3;

/// Where the staged scripts live. Matched on as a substring when deciding
/// whether a hook entry is one of ours, so it must stay stable across
/// versions — a rename here orphans every stamp already on disk.
const STAGED_DIR_MARKER: &str = "/.aura/plugins/aura-claude/scripts/";

/// Stage the scripts under `~/.aura/plugins/aura-claude/scripts/` and point
/// `<repo_root>/.claude/settings.local.json` at them.
///
/// Idempotent, and re-staging is deliberate: it overwrites, so upgrading Aura
/// upgrades the scripts in repos that were wired months ago rather than only
/// in new ones. It will not *downgrade* them, though — see `SCRIPTS_REV`.
///
/// `settings.local.json` rather than `settings.json` because Claude
/// git-ignores the local one by convention — Aura's plumbing has no business
/// showing up in someone's `git status`.
pub fn stamp_claude_hooks(repo_root: &str) -> Option<()> {
    let mut script_dir = crate::aura_home()?;
    script_dir.push("plugins");
    script_dir.push("aura-claude");
    script_dir.push("scripts");
    crate::stage_scripts(&script_dir, AURA_CLAUDE_SCRIPTS, SCRIPTS_REV)?;

    let settings_path = claude_settings_path(repo_root)?;
    let existing = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let mut root = match existing {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };

    merge_aura_hooks(&mut root, &script_dir)?;

    let serialized = serde_json::to_string_pretty(&serde_json::Value::Object(root)).ok()?;
    std::fs::write(&settings_path, serialized).ok()?;
    Some(())
}

fn claude_settings_path(repo_root: &str) -> Option<PathBuf> {
    let mut p = PathBuf::from(repo_root);
    p.push(".claude");
    std::fs::create_dir_all(&p).ok()?;
    p.push("settings.local.json");
    Some(p)
}

/// Merge Aura's hook entries into a parsed `settings.local.json`, in place.
///
/// Split out from the stamping so it can be tested without an env or a
/// filesystem: `script_dir` is the only thing that varies between machines,
/// and here it is a parameter rather than a read of `HOME`.
///
/// Returns `None` — leaving `root` untouched — when the file's `hooks` key
/// exists but isn't an object. That means the user hand-edited it into some
/// other shape, and a merge would corrupt it.
///
/// The merge itself lives in `hooks_json` because codex reads a file of
/// exactly this shape; only the table of entries and the marker differ.
pub fn merge_aura_hooks(
    root: &mut serde_json::Map<String, serde_json::Value>,
    script_dir: &Path,
) -> Option<()> {
    let stamps: Vec<Stamp> = AURA_ENTRIES
        .iter()
        .map(|(event, script, matcher)| Stamp {
            event,
            command: script_dir.join(script).to_string_lossy().into_owned(),
            matcher: *matcher,
        })
        .collect();
    crate::hooks_json::merge(root, &stamps, STAGED_DIR_MARKER)
}

/// Stamping claude's hooks into a repo's `settings.local.json`.
///
/// The failure these pin is quiet and permanent: a stale entry never breaks
/// anything, it just prints a hook error on every single tool call, forever, in
/// a file nobody opens. So the tests are about what *survives* a re-stamp.
#[cfg(test)]
mod tests {
    use super::*;

    fn commands_for(root: &serde_json::Map<String, serde_json::Value>, event: &str) -> Vec<String> {
        root.get("hooks")
            .and_then(|h| h.get(event))
            .and_then(|a| a.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|it| it.get("hooks")?.as_array()?.first()?.get("command")?.as_str())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn re_stamping_under_a_different_home_replaces_rather_than_appends() {
        // The actual bug. The app was launched once with HOME pointed at a
        // throwaway directory (a UI test does exactly that), which stamped a
        // second copy of every hook beside the real one. /tmp was then swept,
        // and every tool call in four repos started printing a hook error for
        // a script that no longer existed.
        let mut root = serde_json::Map::new();
        merge_aura_hooks(
            &mut root,
            Path::new("/tmp/throwaway/.aura/plugins/aura-claude/scripts"),
        )
        .unwrap();
        merge_aura_hooks(
            &mut root,
            Path::new("/Users/real/.aura/plugins/aura-claude/scripts"),
        )
        .unwrap();

        let cmds = commands_for(&root, "PreToolUse");
        assert_eq!(
            cmds,
            vec!["/Users/real/.aura/plugins/aura-claude/scripts/on-pre-tool-use.sh".to_string()],
            "the throwaway home's stamp should be gone, not sitting beside the real one",
        );
    }

    #[test]
    fn re_stamping_under_the_same_home_is_a_no_op() {
        let dir = Path::new("/Users/real/.aura/plugins/aura-claude/scripts");
        let mut once = serde_json::Map::new();
        merge_aura_hooks(&mut once, dir).unwrap();
        let mut twice = once.clone();
        merge_aura_hooks(&mut twice, dir).unwrap();
        assert_eq!(once, twice);
    }

    #[test]
    fn someone_elses_hooks_are_never_touched() {
        // We prune by "is this one of ours", so the predicate has to be tight.
        // A hook the user wrote themselves must survive a re-stamp under a
        // different home, even when it sits in the same event's list.
        let mine = serde_json::json!({
            "hooks": [{ "type": "command", "command": "/Users/real/bin/my-own-linter.sh" }]
        });
        let mut root = serde_json::Map::new();
        merge_aura_hooks(
            &mut root,
            Path::new("/tmp/throwaway/.aura/plugins/aura-claude/scripts"),
        )
        .unwrap();
        root.get_mut("hooks")
            .and_then(|h| h.get_mut("PreToolUse"))
            .and_then(|a| a.as_array_mut())
            .unwrap()
            .push(mine.clone());

        merge_aura_hooks(
            &mut root,
            Path::new("/Users/real/.aura/plugins/aura-claude/scripts"),
        )
        .unwrap();

        let cmds = commands_for(&root, "PreToolUse");
        assert!(
            cmds.contains(&"/Users/real/bin/my-own-linter.sh".to_string()),
            "a user's own hook was removed: {cmds:?}",
        );
        assert_eq!(
            cmds.len(),
            2,
            "expected our one stamp plus their one hook: {cmds:?}"
        );
    }

    #[test]
    fn a_hand_edited_hooks_key_is_left_alone() {
        // `hooks` as anything but an object means the user shaped this file
        // themselves. Merging would corrupt it, so we refuse and change nothing.
        let mut root = serde_json::Map::new();
        root.insert(
            "hooks".into(),
            serde_json::Value::String("please don't".into()),
        );
        let before = root.clone();
        assert!(merge_aura_hooks(
            &mut root,
            Path::new("/Users/real/.aura/plugins/aura-claude/scripts")
        )
        .is_none());
        assert_eq!(root, before);
    }

    #[test]
    fn unrelated_settings_survive() {
        let mut root = serde_json::Map::new();
        root.insert(
            "permissions".into(),
            serde_json::json!({ "allow": ["Bash(ls:*)"] }),
        );
        merge_aura_hooks(
            &mut root,
            Path::new("/Users/real/.aura/plugins/aura-claude/scripts"),
        )
        .unwrap();
        assert_eq!(root["permissions"]["allow"][0], "Bash(ls:*)");
    }

    #[test]
    fn every_event_we_stamp_names_a_script_that_ships() {
        // The table and the embedded bodies are two lists that have to agree.
        // A typo here stamps a hook at a path nothing was ever staged to, and
        // the symptom is the same permanent per-tool-call error as above.
        for (event, script, _) in AURA_ENTRIES {
            assert!(
                AURA_CLAUDE_SCRIPTS.iter().any(|(name, _)| name == script),
                "{event} points at {script}, which is not compiled in",
            );
        }
    }

    /// cursor-agent runs these same scripts, so the dialect it speaks is part
    /// of this module's contract even though it has no stamp of its own.
    ///
    /// Its `postToolUse` payload is Claude-shaped — `tool_name`, `tool_input`,
    /// `cwd` in snake_case, and `tool_input.file_path` for a write — but it
    /// remaps the *names*: `Edit` and `Write` both arrive as `Write`, and
    /// `Bash` as `Shell`. Shell commands may not reach `postToolUse` at all
    /// (cursor has dedicated shell events), so the `Shell` arm is tolerance
    /// rather than a promise; file edits are the signal that matters, and they
    /// do arrive.
    mod cursor {
        use super::*;

        fn post_tool_use() -> &'static str {
            AURA_CLAUDE_SCRIPTS
                .iter()
                .find(|(name, _)| *name == "on-post-tool-use.sh")
                .expect("the post-tool-use hook is staged")
                .1
        }

        #[test]
        fn the_hook_answers_cursors_spelling_of_a_shell_command() {
            assert!(
                post_tool_use().contains("Bash|Shell)"),
                "cursor's `Shell` no longer reaches the shell branch",
            );
        }

        #[test]
        fn an_intent_row_names_the_agent_that_actually_did_the_work() {
            // Before this, every row said "Claude" — including the ones cursor
            // wrote, because cursor runs Claude's hook scripts verbatim. The
            // payloads differ in exactly one convenient way: cursor sends a
            // `generation_id`, Claude sends a `session_id`.
            let body = post_tool_use();
            assert!(body.contains(".generation_id"), "the discriminator is gone");
            assert!(body.contains(r#"AGENT="Cursor""#));
            assert!(
                !body.contains(r#"log-intent "Claude "#),
                "an intent row still hardcodes Claude as the author",
            );
        }

        #[test]
        fn a_row_carries_the_session_it_belongs_to_in_either_dialect() {
            // The console builds its Sessions feed by grouping intent rows on
            // this id, so reading only Claude's spelling would leave every
            // cursor session invisible. Cursor's own `generation_id` is per
            // turn — grouping on that makes each edit its own session.
            let body = post_tool_use();
            assert!(body.contains(".session_id // .conversation_id"));
            assert!(body.contains("--session"));
        }

        #[test]
        fn the_agent_name_reaches_the_cli_and_not_just_the_sentence() {
            // `aura log-intent` files a row under `AURA_AGENT`, defaulting to
            // "hook_auto". Naming the agent only inside the intent text leaves
            // every row in the console attributed to nobody in particular.
            let body = post_tool_use();
            assert!(body.contains(r#"AURA_AGENT="$AGENT""#));
        }
    }
}
