//! Stamping this machine's real agent CLIs, and reading back what landed.
//!
//! Everything else in this crate runs against a scratch HOME, which proves the
//! code is right about the shapes it was told about. It cannot prove those
//! shapes are right about the CLIs — that a config file is where the docs say,
//! that a plugin directory is really auto-discovered, that another tool's
//! entries survive our merge in the file as it actually exists here.
//!
//! So this one writes to the real HOME, and is therefore `#[ignore]`d *and*
//! gated on an env var. Run it deliberately:
//!
//! ```text
//! AURA_LIVE_STAMP=1 cargo test -p aura-hooks --test live_stamp -- --ignored --nocapture
//! ```
//!
//! It is safe to run — every stamp is merge-safe and idempotent, which is the
//! bulk of what it checks — but it does change files that belong to other
//! products, so it never runs on its own.

use std::path::PathBuf;

#[test]
#[ignore = "writes to the real HOME; set AURA_LIVE_STAMP=1 and pass --ignored"]
fn stamping_this_machine_leaves_every_installed_cli_wired() {
    if std::env::var("AURA_LIVE_STAMP").is_err() {
        eprintln!("skipped: set AURA_LIVE_STAMP=1 to stamp this machine for real");
        return;
    }
    let home = PathBuf::from(std::env::var("HOME").expect("a HOME"));

    // What another tool had in the shared files before we touched them. The
    // merge is the whole risk here: `~/.codex/hooks.json` and
    // `~/.kimi/config.toml` are not ours, and clobbering somebody's entries
    // would break their product silently.
    let codex_path = home.join(".codex/hooks.json");
    let kimi_path = home.join(".kimi/config.toml");
    let codex_before = std::fs::read_to_string(&codex_path).unwrap_or_default();
    let kimi_before = std::fs::read_to_string(&kimi_path).unwrap_or_default();

    let stamped = [
        ("codex", aura_hooks::stamp_codex_hooks().is_some()),
        ("kimi", aura_hooks::stamp_kimi_hooks().is_some()),
        ("opencode", aura_hooks::stamp_opencode_plugin().is_some()),
        ("pi", aura_hooks::stamp_pi_extension().is_some()),
    ];
    for (cli, ok) in stamped {
        println!("{cli}: {}", if ok { "stamped" } else { "not installed here" });
    }
    assert!(
        stamped.iter().any(|(_, ok)| *ok),
        "no agent CLI on this machine was stamped — is any of them installed?",
    );

    let script = home.join(".aura/plugins/aura-agent/scripts/on-post-tool-use.sh");
    assert!(script.is_file(), "the shared hook was not staged");

    if stamped[0].1 {
        let now = std::fs::read_to_string(&codex_path).expect("codex hooks.json");
        let doc: serde_json::Value = serde_json::from_str(&now).expect("valid JSON");
        assert!(doc["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .is_some_and(|c| c.contains("AURA_HOOK_AGENT=Codex")));
        assert_every_other_command_survived(&codex_before, &now);
    }

    if stamped[1].1 {
        let now = std::fs::read_to_string(&kimi_path).expect("kimi config.toml");
        assert!(now.contains("AURA_HOOK_AGENT=Kimi"), "kimi was not stamped");
        now.parse::<toml_edit::DocumentMut>()
            .expect("kimi's config is still valid TOML after our edit");
        // Every setting that was there before is still there. This file is the
        // user's own config — model, provider, theme, keybindings — and Aura is
        // a guest in it.
        for line in kimi_before
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter(|l| !l.contains("/.aura/plugins/aura-agent/scripts/"))
        {
            assert!(now.contains(line), "kimi lost a line of the user's config: {line}");
        }
    }

    // Stamping again must change nothing at all. Wiring runs on every
    // repo-open, so a stamp that is not a no-op rewrites four config files
    // several times a day and grows a duplicate entry on each pass.
    let codex_once = std::fs::read_to_string(&codex_path).unwrap_or_default();
    let kimi_once = std::fs::read_to_string(&kimi_path).unwrap_or_default();
    let _ = aura_hooks::stamp_codex_hooks();
    let _ = aura_hooks::stamp_kimi_hooks();
    let _ = aura_hooks::stamp_opencode_plugin();
    let _ = aura_hooks::stamp_pi_extension();
    assert_eq!(codex_once, std::fs::read_to_string(&codex_path).unwrap_or_default());
    assert_eq!(kimi_once, std::fs::read_to_string(&kimi_path).unwrap_or_default());
}

/// Every command in `before` that is not ours is still in `after`.
///
/// Ours is excluded on purpose: a stamp under a different HOME finds our old
/// entry pointing at a script that is no longer there, and replacing it is the
/// rule rather than a regression. Everyone else's entry is untouchable.
///
/// Both sides are parsed rather than compared as text — a command carrying
/// double quotes, which is how at least one other tool writes its own hooks,
/// is escaped differently in the file than it reads in memory.
fn assert_every_other_command_survived(before: &str, after: &str) {
    let Ok(was) = serde_json::from_str::<serde_json::Value>(before) else {
        return; // nothing was there, or it was not JSON we can read
    };
    let now = commands(&serde_json::from_str(after).expect("we wrote valid JSON"));
    for (event, cmd) in commands(&was) {
        if cmd.contains("/.aura/plugins/aura-agent/scripts/") {
            continue; // ours, and replacing a stale one is the point
        }
        assert!(
            now.contains(&(event.clone(), cmd.clone())),
            "the {event} hook `{cmd}` was removed by our stamp",
        );
    }
}

/// Every (event, command) pair in a hooks document.
fn commands(doc: &serde_json::Value) -> Vec<(String, String)> {
    let Some(events) = doc.get("hooks").and_then(|h| h.as_object()) else {
        return Vec::new();
    };
    events
        .iter()
        .flat_map(|(event, entries)| {
            entries
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|e| e.get("hooks")?.as_array())
                .flatten()
                .filter_map(|h| h.get("command")?.as_str())
                .map(|c| (event.clone(), c.to_string()))
                .collect::<Vec<_>>()
        })
        .collect()
}
