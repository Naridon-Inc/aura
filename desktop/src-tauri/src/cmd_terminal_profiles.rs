//! Terminal launch profiles (VS Code's `terminal.profiles.*` analogue).
//!
//! Named distinctly from `cmd_profiles.rs` (which is agent/git *identity*
//! profiles) — this is purely "which shell + args + env does a new
//! terminal tab launch with". Profiles live in the same
//! `~/.aura/settings.toml` `[terminal]` section the rest of the prefs
//! use; the frontend `settingsStore` stays the single TOML writer for
//! everything *except* these three mutating commands, which round-trip
//! the whole document atomically.
//!
//! `resolve_terminal_launch` is the bridge `cmd_pty::pty_open` calls: it
//! turns a profile id into the concrete `(shell, args, env)` to spawn,
//! folding in the workspace's git/agent identity via
//! `cmd_profiles::build_profile_env` so a terminal commits as the same
//! author an agent in the same repo would.

use serde::Serialize;

use crate::cmd_settings_prefs::{load_app_settings, update_app_settings, TerminalProfile};

/// Auto-seed profiles from `/etc/shells` + `$SHELL` the first time the
/// user has none. Returns the discovered shells as profiles, `$SHELL`
/// (or `/bin/zsh`) first so it becomes the implicit default.
fn seed_profiles() -> Vec<TerminalProfile> {
    let preferred = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    // Candidate shells: the user's $SHELL plus anything in /etc/shells,
    // de-duped, keeping only paths that actually exist.
    let mut paths: Vec<String> = vec![preferred.clone()];
    if let Ok(contents) = std::fs::read_to_string("/etc/shells") {
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            paths.push(line.to_string());
        }
    }

    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        if !seen.insert(path.clone()) {
            continue;
        }
        if !std::path::Path::new(&path).exists() {
            continue;
        }
        let name = std::path::Path::new(&path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        out.push(TerminalProfile {
            id: name.clone(),
            name,
            path: path.clone(),
            args: Vec::new(),
            env: Vec::new(),
            icon: None,
            use_shell_integration: true,
        });
    }

    // Pathological box with no readable shells — still hand back one
    // entry so the picker isn't empty and pty_open has something to
    // spawn.
    if out.is_empty() {
        out.push(TerminalProfile {
            id: "zsh".into(),
            name: "zsh".into(),
            path: preferred,
            args: Vec::new(),
            env: Vec::new(),
            icon: None,
            use_shell_integration: true,
        });
    }
    out
}

/// The terminal profiles to show in the `+` / "Select Default Profile"
/// menus. Auto-seeds (and persists) on first call when the user has
/// none, so the UI always has at least the system shells.
#[tauri::command]
pub fn terminal_profile_list() -> Result<Vec<TerminalProfile>, String> {
    let settings = load_app_settings();
    if !settings.terminal.profiles.is_empty() {
        return Ok(settings.terminal.profiles);
    }
    let seeded = seed_profiles();
    let result = seeded.clone();
    // Best-effort persist; a read-only HOME shouldn't break listing. The
    // re-check inside the closure guards against another thread having
    // seeded between our load above and acquiring the write lock.
    let _ = update_app_settings(move |s| {
        if s.terminal.profiles.is_empty() {
            s.terminal.profiles = seeded;
        }
        Ok(())
    });
    Ok(result)
}

/// Fetch one profile by id, or `None` if unknown. The frontend uses this
/// to render the active profile's name/icon in the toolbar dropdown.
#[tauri::command]
pub fn terminal_profile_get(id: String) -> Result<Option<TerminalProfile>, String> {
    Ok(terminal_profile_list()?.into_iter().find(|p| p.id == id))
}

/// The configured default profile id — what a bare ⌘N terminal launches.
/// Falls back to the first (auto-seeded `$SHELL`) profile so the toolbar's
/// "default" marker and radio always resolve to a real entry. `None` only
/// when there are genuinely no profiles (never, post-seed).
#[tauri::command]
pub fn terminal_profile_default() -> Result<Option<String>, String> {
    let settings = load_app_settings();
    let profiles = terminal_profile_list()?;
    let configured = settings
        .terminal
        .default_profile
        .filter(|id| profiles.iter().any(|p| &p.id == id));
    Ok(configured.or_else(|| profiles.first().map(|p| p.id.clone())))
}

/// Set the default launch profile (the one a bare ⌘N terminal uses).
/// Validates the id against the known list so a stale menu click can't
/// strand the default on a deleted profile.
#[tauri::command]
pub fn terminal_profile_set_default(id: String) -> Result<(), String> {
    update_app_settings(move |settings| {
        if settings.terminal.profiles.is_empty() {
            settings.terminal.profiles = seed_profiles();
        }
        if !settings.terminal.profiles.iter().any(|p| p.id == id) {
            return Err(format!("unknown terminal profile: {id}"));
        }
        settings.terminal.default_profile = Some(id);
        Ok(())
    })
}

/// What a terminal should actually spawn: the resolved shell binary, its
/// args, and the env to layer on (workspace git/agent identity +
/// per-profile env), plus whether OSC-133 shell integration should be
/// injected for this launch.
#[derive(Debug, Clone, Serialize)]
pub struct TerminalLaunch {
    pub shell: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub use_shell_integration: bool,
}

/// Resolve a launch for `repo_root` using `profile_id` (or the default,
/// or the first seeded profile when neither is given). Folds in
/// `build_profile_env` so the terminal inherits the workspace's HOME /
/// GIT_AUTHOR_* identity exactly like an agent spawn does.
///
/// `use_shell_integration` is the AND of the global pref and the
/// profile's own opt-in — `pty_open` only injects OSC-133 when both say
/// yes.
pub fn resolve_terminal_launch(repo_root: &str, profile_id: Option<&str>) -> TerminalLaunch {
    let settings = load_app_settings();
    let mut profiles = settings.terminal.profiles.clone();
    if profiles.is_empty() {
        profiles = seed_profiles();
    }

    // Pick: explicit id → configured default → first seeded.
    let chosen = profile_id
        .and_then(|id| profiles.iter().find(|p| p.id == id))
        .or_else(|| {
            settings
                .terminal
                .default_profile
                .as_deref()
                .and_then(|id| profiles.iter().find(|p| p.id == id))
        })
        .or_else(|| profiles.first());

    let (shell, mut args, mut env, profile_integ) = match chosen {
        Some(p) => (
            p.path.clone(),
            p.args.clone(),
            p.env.clone(),
            p.use_shell_integration,
        ),
        None => (
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string()),
            Vec::new(),
            Vec::new(),
            true,
        ),
    };

    // Workspace identity (HOME swap + GIT_AUTHOR_*/COMMITTER_*) goes
    // last so it overrides any profile env that collides.
    for kv in crate::cmd_profiles::build_profile_env(repo_root, None) {
        env.push(kv);
    }
    // Defensive default in case a profile shipped no args — keep the
    // vec allocated so callers can push without re-checking.
    args.shrink_to_fit();

    TerminalLaunch {
        shell,
        args,
        env,
        use_shell_integration: settings.terminal.shell_integration && profile_integ,
    }
}
