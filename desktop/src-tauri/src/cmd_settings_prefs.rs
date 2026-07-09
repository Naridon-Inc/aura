//! Hand-editable user preferences at `$AURA_HOME/settings.toml`
//! (default `~/.aura/settings.toml`).
//!
//! Holds NON-SECRET UI prefs only — appearance, editor, terminal, and
//! experimental flags. API keys never land here; secrets stay in the
//! credentials store / OS keychain (cmd_settings.rs, cmd_brain.rs). The
//! frontend `settingsStore` is the single writer: it loads this once,
//! applies it live, and writes the whole document back on every change.
//!
//! ```toml
//! [appearance]
//! theme = "dark"        # dark | light | system
//! variant = "default"   # default | modal | ember
//! ade_v2 = true         # ADE redesign is the default surface
//! font_size = 13
//!
//! [editor]
//! vim = false
//! minimap = true
//! sticky_scroll = true
//! indent_guides = true
//!
//! [terminal]
//! bell = false
//! cursor_blink = true
//! scrollback = 5000
//!
//! [flags]
//! intent_inspector = false
//! provenance_replay = false
//! manager_worktrees = false
//! show_token_savings = true
//! ```

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Top-level prefs document. `#[serde(default)]` on the struct + every
/// section means a hand-edited file missing a key (or a whole section)
/// parses fine and falls back to the app default, so the format is
/// forward/backward compatible as we add fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub appearance: Appearance,
    pub editor: EditorPrefs,
    pub terminal: TerminalPrefs,
    pub flags: FlagPrefs,
    pub hud: HudPrefs,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            appearance: Appearance::default(),
            editor: EditorPrefs::default(),
            terminal: TerminalPrefs::default(),
            flags: FlagPrefs::default(),
            hud: HudPrefs::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Appearance {
    /// dark | light | system
    pub theme: String,
    /// default | modal | ember
    pub variant: String,
    /// ADE surface-redesign master flag (forces the ember pack on).
    pub ade_v2: bool,
    /// Monaco editor font size in px.
    pub font_size: u16,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            variant: "default".into(),
            // ADE surface redesign is the default surface now. The frontend
            // runs a one-time migration (settingsStore.migrateAdeV2Default)
            // that flips existing installs which persisted the opt-in's
            // `ade_v2 = false`; this keeps a freshly-seeded/back-end default
            // consistent with that.
            ade_v2: true,
            font_size: 13,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EditorPrefs {
    pub vim: bool,
    pub minimap: bool,
    pub sticky_scroll: bool,
    pub indent_guides: bool,
}

impl Default for EditorPrefs {
    fn default() -> Self {
        Self {
            vim: false,
            minimap: true,
            sticky_scroll: true,
            indent_guides: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TerminalPrefs {
    pub bell: bool,
    pub cursor_blink: bool,
    pub scrollback: u32,
    /// Id of the profile a new terminal launches with when the user
    /// hasn't picked one explicitly. `None` → the auto-seeded `$SHELL`
    /// profile (see `cmd_terminal_profiles::terminal_profile_list`).
    pub default_profile: Option<String>,
    /// Master switch for OSC-133 shell integration (per-prompt command
    /// marks → ⌘↑/⌘↓ + recent-command list). On by default; a profile
    /// can still opt out via `use_shell_integration`.
    pub shell_integration: bool,
    /// User-defined launch profiles. Empty → auto-seeded from
    /// `/etc/shells` + `$SHELL` on first `terminal_profile_list`.
    pub profiles: Vec<TerminalProfile>,
}

impl Default for TerminalPrefs {
    fn default() -> Self {
        Self {
            bell: false,
            cursor_blink: true,
            scrollback: 5000,
            default_profile: None,
            shell_integration: true,
            profiles: Vec::new(),
        }
    }
}

/// One terminal launch profile (VS Code's terminal.profiles.* analogue).
/// `path` is the shell/program; `args`/`env` layer on top of the base
/// spawn. `use_shell_integration` lets a profile (e.g. a REPL or a
/// remote-ssh shell) opt out of OSC-133 injection even when the global
/// pref is on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalProfile {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default = "default_true")]
    pub use_shell_integration: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FlagPrefs {
    pub intent_inspector: bool,
    pub provenance_replay: bool,
    pub manager_worktrees: bool,
    /// Show a per-response "Saved ~N tokens" chip in chat when a turn reached
    /// for Aura's code-graph tools instead of reading whole files. Default ON;
    /// toggled in Settings → Experimental.
    pub show_token_savings: bool,
}

impl Default for FlagPrefs {
    fn default() -> Self {
        Self {
            intent_inspector: false,
            provenance_replay: false,
            manager_worktrees: false,
            show_token_savings: true,
        }
    }
}

/// The floating HUD's (⌘⇧A) presentation prefs. Fully frontend-owned — the
/// HUD's React side reads `mode` synchronously at mount (shared localStorage)
/// and drives both the CSS shape and the native window via `hud_set_mode` /
/// `hud_set_opacity`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HudPrefs {
    /// Master on/off for the floating HUD. When false, ⌘⇧A / the menu-bar tray
    /// / programmatic summons are all no-ops (the HUD never appears). Default
    /// on. Seeded into `hud::HUD_ENABLED` at startup and flipped live via
    /// `hud_set_enabled`.
    pub enabled: bool,
    /// capsule | sidebar | minimal | ambient
    pub mode: String,
    /// Uniform window opacity, 0.2–1.0.
    pub opacity: f32,
    /// Sidebar panel content width in px (window = this + shadow gutters). The
    /// geometry is web-driven (CSS var → measured → `hud_resize`); this field
    /// only persists the choice. 240–480.
    pub sidebar_width: f32,
    /// Sidebar panel content height in px. 320–900.
    pub sidebar_height: f32,
}

impl Default for HudPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: "capsule".into(),
            opacity: 1.0,
            sidebar_width: 320.0,
            sidebar_height: 520.0,
        }
    }
}

/// Resolve the TOML path, honoring `$AURA_HOME` so sandbox/CI profiles can
/// isolate their settings (mirrors integrations/config.rs).
fn settings_path() -> Result<PathBuf, String> {
    if let Ok(home) = std::env::var("AURA_HOME") {
        return Ok(PathBuf::from(home).join("settings.toml"));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no HOME / USERPROFILE".to_string())?;
    Ok(PathBuf::from(home).join(".aura").join("settings.toml"))
}

/// Synchronous load for in-process callers (e.g. `cmd_terminal_profiles`
/// resolving a launch profile). Falls back to `AppSettings::default()`
/// when the file is missing or unparseable — a bad hand-edit shouldn't
/// brick terminal spawning.
pub fn load_app_settings() -> AppSettings {
    let Ok(path) = settings_path() else {
        return AppSettings::default();
    };
    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| toml::from_str::<AppSettings>(&raw).ok())
        .unwrap_or_default()
}

/// Serializes every writer of `settings.toml`. The frontend `settingsStore`
/// and the `terminal_profile_*` commands each do a read-modify-write on the
/// same document; without a guard two concurrent cycles read the same copy
/// and the later write clobbers the earlier one's section (lost update).
/// One in-process lock makes each RMW atomic — Tauri runs a single app
/// instance, so cross-process contention isn't in scope.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

/// Raw atomic write (temp sibling + rename). Caller MUST hold `SETTINGS_LOCK`
/// — the fixed `.toml.tmp` name is only collision-free because the lock
/// admits one writer at a time.
fn write_settings_atomic(settings: &AppSettings) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }
    let body =
        toml::to_string_pretty(settings).map_err(|e| format!("serialize settings: {e}"))?;
    let tmp = path.with_extension("toml.tmp");
    fs::write(&tmp, body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename into {}: {e}", path.display()))?;
    Ok(())
}

/// Atomic read-modify-write of the settings document. Loads the current
/// file under the lock, hands it to `f`, then writes the result back —
/// nothing else can interleave a load/save in between. This is the ONLY
/// way callers should mutate one section (terminal profiles, default
/// profile, …) and write the whole document back. `f` may return `Err` to
/// abort the write (e.g. validation failed) leaving the file untouched.
pub fn update_app_settings<F>(f: F) -> Result<(), String>
where
    F: FnOnce(&mut AppSettings) -> Result<(), String>,
{
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = load_app_settings();
    f(&mut settings)?;
    write_settings_atomic(&settings)
}

/// Load the prefs. Returns `None` when the file doesn't exist yet so the
/// caller can run a one-time migration from the legacy localStorage keys
/// before writing the first TOML.
#[tauri::command]
pub async fn settings_prefs_load() -> Result<Option<AppSettings>, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw =
        fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let parsed = toml::from_str::<AppSettings>(&raw)
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    Ok(Some(parsed))
}

/// Persist the prefs the frontend owns. The JS `settingsStore` models only
/// appearance / editor / flags + the three terminal toggles — it has no
/// concept of terminal launch *profiles*, the *default profile*, or the
/// shell-integration switch, which the `terminal_profile_*` commands write
/// into the SAME document. So we must NOT blindly write the whole incoming
/// struct: its `terminal.profiles` / `default_profile` / `shell_integration`
/// arrive as serde defaults (empty / none / true) and would silently wipe
/// the user's saved profiles and chosen default. Merge instead — overlay
/// only the frontend-owned fields onto the on-disk copy, under the lock.
#[tauri::command]
pub async fn settings_prefs_save(settings: AppSettings) -> Result<(), String> {
    update_app_settings(move |disk| {
        disk.appearance = settings.appearance;
        disk.editor = settings.editor;
        disk.flags = settings.flags;
        disk.hud = settings.hud;
        disk.terminal.bell = settings.terminal.bell;
        disk.terminal.cursor_blink = settings.terminal.cursor_blink;
        disk.terminal.scrollback = settings.terminal.scrollback;
        // disk.terminal.{profiles, default_profile, shell_integration}
        // are backend-owned — left as loaded from disk.
        Ok(())
    })
}
