//! Linked folders, as CLI arguments.
//!
//! A workspace can be linked to other workspaces and to folders (the
//! composer's "Link workspaces" dialog). When an agent starts there, those
//! folders are handed to it as extra directories it may read, through the
//! agent's own flag, checked against each CLI's `--help`:
//!
//! | agent        | flag                           | where it goes            |
//! |--------------|--------------------------------|--------------------------|
//! | Claude Code  | `--add-dir <dir>`              | last (it takes a list)   |
//! | Codex        | `--add-dir <dir>`              | right after `exec`       |
//! | Gemini CLI   | `--include-directories <dir>`  | last (it takes a list)   |
//! | Kimi         | `--add-dir <dir>`              | last                     |
//! | Antigravity  | `--add-dir <dir>`              | first, before `--print`  |
//!
//! Any other agent (Cursor, OpenCode, pi, …) has no such flag and gets
//! nothing: an unknown flag would make the turn fail, and the dialog already
//! says that agent can't read linked folders.
//!
//! A link that no longer points at a folder on this disk (an archived copy
//! that was removed, a folder deleted since) drops out here, silently.

use std::collections::HashSet;
use std::path::Path;

use aura_agents::canonical_agent_id;

/// Where an agent's flag has to sit in its argv.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Spot {
    /// Before everything. For a CLI that stops reading flags at the first
    /// plain argument.
    Start,
    /// Right after this subcommand when it is there, else first. Codex's
    /// `exec` reads its own flags; the interactive CLI reads them up top.
    After(&'static str),
    /// After everything. For a flag that takes a list, so nothing that
    /// follows it can be read as one more folder.
    End,
}

fn flag(agent_id: &str) -> Option<(&'static str, Spot)> {
    match canonical_agent_id(agent_id).to_ascii_lowercase().as_str() {
        "claude" => Some(("--add-dir", Spot::End)),
        "codex" => Some(("--add-dir", Spot::After("exec"))),
        "gemini" => Some(("--include-directories", Spot::End)),
        "kimi" => Some(("--add-dir", Spot::End)),
        "antigravity" => Some(("--add-dir", Spot::Start)),
        _ => None,
    }
}

/// Whether this agent can be handed linked folders at all.
pub fn agent_reads_linked_dirs(agent_id: &str) -> bool {
    flag(agent_id).is_some()
}

/// The links worth handing over: folders that exist on this disk, each once,
/// never the folder the agent already starts in.
pub fn readable(dirs: &[String], cwd: &str) -> Vec<String> {
    let cwd = cwd.trim_end_matches('/');
    let mut seen = HashSet::new();
    dirs.iter()
        .map(|d| d.trim())
        .filter(|d| !d.is_empty() && d.trim_end_matches('/') != cwd)
        .filter(|d| Path::new(d).is_dir())
        .filter(|d| seen.insert(d.trim_end_matches('/').to_string()))
        .map(str::to_string)
        .collect()
}

/// Put `dirs` into `args` through this agent's flag. Nothing changes for an
/// agent without one, or when there is nothing to hand over.
pub fn apply(agent_id: &str, args: &mut Vec<String>, dirs: &[String]) {
    let Some((name, spot)) = flag(agent_id) else {
        return;
    };
    if dirs.is_empty() {
        return;
    }
    let pairs: Vec<String> = dirs
        .iter()
        .flat_map(|d| [name.to_string(), d.clone()])
        .collect();
    // A "--" ends the flags; anything placed after it would be read as text.
    let end = args.iter().position(|a| a == "--").unwrap_or(args.len());
    let at = match spot {
        Spot::Start => 0,
        Spot::End => end,
        Spot::After(sub) => args[..end]
            .iter()
            .position(|a| a == sub)
            .map(|i| i + 1)
            .unwrap_or(0),
    };
    args.splice(at..at, pairs);
}

/// The same, for an agent started in its ACP mode (`gemini --acp`), where
/// only the CLI's top-level flags apply. Kimi's `acp` subcommand takes no
/// folders, so it gets nothing.
pub fn acp_args(agent_id: &str, dirs: &[String]) -> Vec<String> {
    if canonical_agent_id(agent_id).eq_ignore_ascii_case("gemini") {
        let mut args = Vec::new();
        apply("gemini", &mut args, dirs);
        args
    } else {
        Vec::new()
    }
}

/// The links that no longer point at a folder on this disk, for the dialog to
/// show as missing.
#[tauri::command]
pub fn linked_dirs_missing(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| !Path::new(p.trim()).is_dir())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn claude_gets_add_dir_last_so_its_list_eats_nothing() {
        let mut args = s(&["-p", "fix it", "--output-format", "stream-json"]);
        apply("claude", &mut args, &s(&["/a", "/b c"]));
        assert_eq!(
            args,
            s(&["-p", "fix it", "--output-format", "stream-json", "--add-dir", "/a", "--add-dir", "/b c"])
        );
        let mut alias = Vec::new();
        apply("claude_code", &mut alias, &s(&["/a"]));
        assert_eq!(alias, s(&["--add-dir", "/a"]));
    }

    #[test]
    fn codex_gets_add_dir_after_exec_and_before_the_prompt() {
        let mut turn = s(&["-c", "model=o3", "exec", "--json", "resume", "sid", "fix it"]);
        apply("codex", &mut turn, &s(&["/a"]));
        assert_eq!(
            turn,
            s(&["-c", "model=o3", "exec", "--add-dir", "/a", "--json", "resume", "sid", "fix it"])
        );
        // The terminal CLI has no `exec`; its flags go up top.
        let mut repl = s(&["-c", "model=o3"]);
        apply("codex", &mut repl, &s(&["/a"]));
        assert_eq!(repl, s(&["--add-dir", "/a", "-c", "model=o3"]));
    }

    #[test]
    fn gemini_kimi_and_antigravity_use_their_own_flags() {
        let mut gemini = s(&["-p", "fix it"]);
        apply("gemini", &mut gemini, &s(&["/a"]));
        assert_eq!(gemini, s(&["-p", "fix it", "--include-directories", "/a"]));
        let mut kimi = s(&["-p", "fix it"]);
        apply("kimi", &mut kimi, &s(&["/a"]));
        assert_eq!(kimi, s(&["-p", "fix it", "--add-dir", "/a"]));
        let mut agy = s(&["--model", "m", "--print", "fix it"]);
        apply("agy", &mut agy, &s(&["/a"]));
        assert_eq!(agy, s(&["--add-dir", "/a", "--model", "m", "--print", "fix it"]));
    }

    #[test]
    fn agents_without_a_flag_get_nothing() {
        for agent in ["cursor", "opencode", "pi", "made-up"] {
            let mut args = s(&["-p", "fix it"]);
            apply(agent, &mut args, &s(&["/a"]));
            assert_eq!(args, s(&["-p", "fix it"]), "{agent}");
            assert!(!agent_reads_linked_dirs(agent), "{agent}");
        }
        assert!(agent_reads_linked_dirs("claude") && agent_reads_linked_dirs("cx"));
    }

    #[test]
    fn no_links_leave_the_argv_alone() {
        let mut args = s(&["-p", "fix it"]);
        apply("claude", &mut args, &[]);
        assert_eq!(args, s(&["-p", "fix it"]));
    }

    #[test]
    fn flags_never_land_after_a_double_dash() {
        let mut args = s(&["-p", "--", "-starts with a dash"]);
        apply("claude", &mut args, &s(&["/a"]));
        assert_eq!(args, s(&["-p", "--add-dir", "/a", "--", "-starts with a dash"]));
    }

    #[test]
    fn acp_mode_only_gemini_takes_folders() {
        assert_eq!(acp_args("gemini", &s(&["/a"])), s(&["--include-directories", "/a"]));
        assert!(acp_args("kimi", &s(&["/a"])).is_empty());
        assert!(acp_args("opencode", &s(&["/a"])).is_empty());
    }

    fn real_argv(agent: &str, mode: aura_agents::InvokeMode) -> Vec<String> {
        aura_agents::registry()
            .get(agent)
            .expect("agent in registry")
            .build_invocation(&aura_agents::InvokeRequest {
                prompt: "fix it",
                mode,
                resume_session_id: None,
                attachments_via_stdin: false,
                effort: None,
                fast: false,
                model: None,
                approval: None,
            })
            .expect("invocation")
            .args
    }

    #[test]
    fn the_real_argv_keeps_its_prompt_and_gains_the_folder_where_the_cli_reads_it() {
        use aura_agents::InvokeMode;
        for (agent, mode) in [
            ("claude", InvokeMode::StreamJson),
            ("codex", InvokeMode::StreamJson),
            ("antigravity", InvokeMode::StreamJson),
            ("kimi", InvokeMode::StreamJson),
            ("gemini", InvokeMode::StreamJson),
        ] {
            let before = real_argv(agent, mode);
            let mut after = before.clone();
            apply(agent, &mut after, &s(&["/linked"]));
            assert_eq!(after.len(), before.len() + 2, "{agent}: {after:?}");
            let at = after.iter().position(|a| a == "/linked").unwrap();
            let name = &after[at - 1];
            assert!(name == "--add-dir" || name == "--include-directories", "{agent}");
            // Removing the pair gives back the argv the CLI was built with.
            let mut back = after.clone();
            back.drain(at - 1..=at);
            assert_eq!(back, before, "{agent}");
            if let Some(exec) = before.iter().position(|a| a == "exec") {
                assert_eq!(at - 1, exec + 1, "{agent}: flag sits right after exec");
            }
        }
    }

    #[test]
    fn a_request_without_links_reads_as_none() {
        let req: super::super::types::ChatRequest =
            serde_json::from_value(serde_json::json!({ "messages": [] })).unwrap();
        assert!(req.linked_dirs.is_empty());
    }

    #[test]
    fn missing_repeated_and_own_folders_drop_out() {
        let root = std::env::temp_dir().join(format!("aura-linked-{}", std::process::id()));
        let other = root.join("other");
        std::fs::create_dir_all(&other).unwrap();
        let cwd = root.to_string_lossy().to_string();
        let other = other.to_string_lossy().to_string();
        let gone = root.join("deleted").to_string_lossy().to_string();
        let kept = readable(
            &[other.clone(), format!("{other}/"), gone, cwd.clone(), "  ".into()],
            &cwd,
        );
        assert_eq!(kept, vec![other.clone()]);
        assert_eq!(
            linked_dirs_missing(vec![other, format!("{cwd}/deleted")]),
            vec![format!("{cwd}/deleted")]
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
