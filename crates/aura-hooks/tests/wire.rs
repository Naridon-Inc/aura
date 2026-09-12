//! Wiring a repo, end to end, against a real filesystem.
//!
//! The unit tests cover each piece with its inputs handed to it. This one
//! covers the thing those pieces exist for: point `wire_agents_for_repo` at a
//! directory and a HOME, and check that what lands is what an agent actually
//! reads — the hooks Claude runs, the server it looks up tools in, the
//! extension Gemini discovers.
//!
//! It is a single test in its own file on purpose. It sets `HOME`, which is
//! process-global; a second test in this binary could observe the change
//! mid-run and be flaky in a way that only shows up under load.

use std::path::Path;

#[test]
fn wiring_a_repo_puts_every_piece_where_its_agent_looks_for_it() {
    let home = tempfile::tempdir().expect("a scratch home");
    let repo = tempfile::tempdir().expect("a scratch repo");
    // SAFETY: single-threaded, and this binary holds exactly one test.
    unsafe { std::env::set_var("HOME", home.path()) };
    // XDG_CONFIG_HOME would otherwise leak in from the developer's own
    // environment and send OpenCode's plugin somewhere outside this scratch
    // home — which is a real machine's config directory, not a test's.
    unsafe { std::env::remove_var("XDG_CONFIG_HOME") };

    // Each non-Claude CLI is stamped only where it has already run, so its
    // config directory is what says "installed here". Standing them up is how
    // this test asks for all of them at once.
    for dir in [".codex", ".kimi", ".config/opencode", ".pi/agent"] {
        std::fs::create_dir_all(home.path().join(dir)).expect("a scratch agent dir");
    }

    let wiring = aura_hooks::wire_agents_for_repo(&repo.path().to_string_lossy());

    assert!(wiring.wired(), "nothing landed: {wiring:?}");
    assert!(wiring.claude_hooks);
    assert!(wiring.repo_mcp_json);
    assert!(wiring.shell_mcp_config);
    assert!(wiring.gemini_extension);
    assert!(wiring.codex_hooks);
    assert!(wiring.kimi_hooks);
    assert!(wiring.opencode_plugin);
    assert!(wiring.pi_extension);

    // 1. The scripts Claude will fork+exec, executable — an un-executable one
    //    fails with EACCES on every tool call rather than doing nothing.
    let script_dir = home.path().join(".aura/plugins/aura-claude/scripts");
    for (name, _) in aura_hooks::AURA_CLAUDE_SCRIPTS {
        let p = script_dir.join(name);
        assert!(p.is_file(), "{name} was not staged");
        assert!(is_executable(&p), "{name} is staged without its +x bit");
    }

    // 2. The settings file that points Claude at them, with absolute paths —
    //    Claude runs hooks with the repo as cwd, so a relative one would
    //    resolve against whatever directory the session happened to start in.
    let settings: serde_json::Value = read_json(&repo.path().join(".claude/settings.local.json"));
    let pre = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        .as_str()
        .expect("a PreToolUse command");
    assert_eq!(pre, script_dir.join("on-pre-tool-use.sh").to_string_lossy());
    assert!(settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"].is_string());

    // 3. Both MCP configs name the same server, so a session started from a
    //    terminal and one started by the app reach the same tools.
    let repo_mcp: serde_json::Value = read_json(&repo.path().join(".mcp.json"));
    let shell_mcp: serde_json::Value = read_json(&home.path().join(".aura/shell-mcp-config.json"));
    let name = aura_hooks::SERVER_NAME;
    assert_eq!(repo_mcp["mcpServers"][name], shell_mcp["mcpServers"][name]);
    assert_eq!(repo_mcp["mcpServers"][name]["args"][0], "mcp");
    // One entry, not two under two names — the tool list an agent sees is
    // the union of both files, so a second name is a second copy of every tool.
    assert_eq!(
        repo_mcp["mcpServers"].as_object().map(|m| m.len()),
        Some(1),
        "more than one Aura server declared: {repo_mcp}",
    );

    // 4. Gemini's extension, in the directory Gemini scans at startup.
    let ext = home.path().join(".gemini/extensions/aura-gemini");
    assert!(ext.join("gemini-extension.json").is_file());
    assert!(ext.join("hooks/hooks.json").is_file());
    assert!(is_executable(&ext.join("scripts/on-post-tool-use.sh")));

    // 5. The four CLIs that are neither Claude nor Gemini, each pointed at the
    //    one shared script — a shell command for the two that run commands, a
    //    module that pipes into it for the two that import modules.
    let shared = home.path().join(".aura/plugins/aura-agent/scripts/on-post-tool-use.sh");
    assert!(is_executable(&shared), "the shared hook is not executable");

    let codex: serde_json::Value = read_json(&home.path().join(".codex/hooks.json"));
    let codex_cmd = codex["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
        .as_str()
        .expect("a codex PostToolUse command");
    assert!(codex_cmd.contains(&*shared.to_string_lossy()), "{codex_cmd}");
    assert!(codex_cmd.contains("AURA_HOOK_AGENT=Codex"), "{codex_cmd}");

    let kimi = std::fs::read_to_string(home.path().join(".kimi/config.toml")).unwrap();
    assert!(kimi.contains("AURA_HOOK_AGENT=Kimi"), "{kimi}");
    assert!(kimi.contains(&*shared.to_string_lossy()), "{kimi}");

    // Both module shims must name the script by the path it was actually
    // staged to. They build it from `homedir()` at run time, so what this pins
    // is that the two halves agree on the same directory.
    for (path, agent) in [
        (home.path().join(".config/opencode/plugin/aura.js"), "OpenCode"),
        (home.path().join(".pi/agent/extensions/aura.ts"), "Pi"),
    ] {
        let body = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} is not readable: {e}", path.display()));
        assert!(body.contains("on-post-tool-use.sh"), "{}", path.display());
        assert!(body.contains(agent), "{}", path.display());
    }

    // Re-wiring is what an upgrade does, and what repo-open does every time.
    // It has to be a no-op on a repo that is already wired — the failure it
    // guards is a second copy of every hook appended beside the first.
    let before = std::fs::read_to_string(repo.path().join(".claude/settings.local.json")).unwrap();
    let again = aura_hooks::wire_agents_for_repo(&repo.path().to_string_lossy());
    assert_eq!(again, wiring);
    assert_eq!(
        before,
        std::fs::read_to_string(repo.path().join(".claude/settings.local.json")).unwrap(),
    );

    // Last, because it moves HOME: a CLI that has never run on this machine is
    // left alone entirely. Creating a config directory for a product the user
    // does not have is not ours to do — and a stray `~/.kimi` would be read by
    // kimi as a configured install the next time somebody tried it.
    let bare_home = tempfile::tempdir().expect("a second scratch home");
    let bare_repo = tempfile::tempdir().expect("a second scratch repo");
    unsafe { std::env::set_var("HOME", bare_home.path()) };
    let bare = aura_hooks::wire_agents_for_repo(&bare_repo.path().to_string_lossy());
    assert!(bare.wired(), "the repo-facing wiring should still land: {bare:?}");
    assert!(
        !bare.codex_hooks && !bare.kimi_hooks && !bare.opencode_plugin && !bare.pi_extension,
        "{bare:?}",
    );
    for dir in [".codex", ".kimi", ".config/opencode", ".pi"] {
        assert!(
            !bare_home.path().join(dir).exists(),
            "wiring created {dir} for a CLI that is not installed",
        );
    }
}

fn read_json(path: &Path) -> serde_json::Value {
    let body = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("{} is not readable: {e}", path.display()));
    serde_json::from_str(&body)
        .unwrap_or_else(|e| panic!("{} is not JSON: {e}", path.display()))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}
