//! Open-in-editor — detect the external code editors installed on this
//! machine and launch one focused on a file or folder.
//!
//! Complements `cmd_files::fs_reveal_in_finder` (which only opens the OS
//! file manager). Two seams:
//!   * `editors_list`  — probe for installed editors, newest-first, so the
//!     UI can render an "Open in…" submenu with only real choices.
//!   * `editor_open`   — launch a chosen editor on a path.
//!
//! Detection is deliberately conservative — we only surface an editor we
//! can actually launch. macOS resolves editors by `.app` bundle presence
//! (launched via `open -a`) and by CLI shim on PATH; Linux/Windows resolve
//! purely by CLI shim. The always-present "System default" entry defers to
//! the OS file association (`open` / `xdg-open` / `explorer`).

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/// A launchable editor the UI can offer. `available` is always true for
/// entries returned by `editors_list` (we filter to installed editors);
/// the field is kept explicit so the shape is self-describing on the wire.
#[derive(Debug, Clone, Serialize)]
pub struct EditorInfo {
    pub id: String,
    pub name: String,
    pub available: bool,
}

/// Static description of one editor. `app_names` are macOS bundle display
/// names (each tried as `/Applications/<name>.app`, then `~/Applications`);
/// `cli` are the command-line launcher shims probed on PATH — used directly
/// on Linux/Windows and preferred everywhere because they open the exact
/// file/folder and reuse an existing window.
struct EditorSpec {
    id: &'static str,
    name: &'static str,
    app_names: &'static [&'static str],
    cli: &'static [&'static str],
}

/// The editors Aura knows how to launch. GUI editors only — terminal
/// editors (vim/emacs -nw) are omitted because a detached GUI launch has
/// no TTY to attach to. Ordered so the popular general editors lead.
const EDITORS: &[EditorSpec] = &[
    EditorSpec { id: "vscode", name: "VS Code", app_names: &["Visual Studio Code"], cli: &["code"] },
    EditorSpec { id: "cursor", name: "Cursor", app_names: &["Cursor"], cli: &["cursor"] },
    EditorSpec { id: "windsurf", name: "Windsurf", app_names: &["Windsurf"], cli: &["windsurf"] },
    EditorSpec { id: "zed", name: "Zed", app_names: &["Zed"], cli: &["zed"] },
    EditorSpec { id: "vscode-insiders", name: "VS Code Insiders", app_names: &["Visual Studio Code - Insiders"], cli: &["code-insiders"] },
    EditorSpec { id: "sublime", name: "Sublime Text", app_names: &["Sublime Text"], cli: &["subl"] },
    EditorSpec { id: "intellij", name: "IntelliJ IDEA", app_names: &["IntelliJ IDEA", "IntelliJ IDEA Community Edition"], cli: &["idea"] },
    EditorSpec { id: "webstorm", name: "WebStorm", app_names: &["WebStorm"], cli: &["webstorm"] },
    EditorSpec { id: "pycharm", name: "PyCharm", app_names: &["PyCharm", "PyCharm Community Edition"], cli: &["pycharm", "charm"] },
    EditorSpec { id: "goland", name: "GoLand", app_names: &["GoLand"], cli: &["goland"] },
    EditorSpec { id: "rustrover", name: "RustRover", app_names: &["RustRover"], cli: &["rustrover"] },
    EditorSpec { id: "clion", name: "CLion", app_names: &["CLion"], cli: &["clion"] },
    EditorSpec { id: "phpstorm", name: "PhpStorm", app_names: &["PhpStorm"], cli: &["phpstorm"] },
    EditorSpec { id: "rubymine", name: "RubyMine", app_names: &["RubyMine"], cli: &["rubymine"] },
];

/// Home directory from the environment (HOME on unix, USERPROFILE on
/// Windows). Kept local so this module has no dependency on the rest of
/// the crate.
fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key).map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// Directories to scan for CLI shims. A GUI app on macOS often launches
/// with a minimal PATH, so we union the inherited PATH with the common
/// shim locations Homebrew / JetBrains Toolbox / user installs use.
fn path_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for extra in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"] {
        let pb = PathBuf::from(extra);
        if !dirs.contains(&pb) {
            dirs.push(pb);
        }
    }
    if let Some(home) = home_dir() {
        for extra in [".local/bin", "Library/Application Support/JetBrains/Toolbox/scripts"] {
            dirs.push(home.join(extra));
        }
    }
    dirs
}

/// Resolve a CLI launcher shim to a concrete executable path on PATH.
/// On Windows the shim is usually a `.cmd`/`.exe`, so we try those first.
fn which(bin: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let candidates = [format!("{bin}.cmd"), format!("{bin}.exe"), bin.to_string()];
    #[cfg(not(windows))]
    let candidates = [bin.to_string()];
    for dir in path_dirs() {
        for c in &candidates {
            let full = dir.join(c);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

/// macOS `.app` bundle path for any of the given display names, if present
/// under `/Applications` or `~/Applications`.
#[cfg(target_os = "macos")]
fn mac_app_path(app_names: &[&str]) -> Option<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = home_dir() {
        roots.push(home.join("Applications"));
    }
    for root in roots {
        for name in app_names {
            let p = root.join(format!("{name}.app"));
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

/// Is this editor launchable on this machine?
fn is_available(spec: &EditorSpec) -> bool {
    if spec.cli.iter().any(|c| which(c).is_some()) {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        return mac_app_path(spec.app_names).is_some();
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Spawn a detached GUI process. We don't wait — editors are long-running.
/// Success means the process launched, not that a window appeared.
fn run_detached(mut cmd: Command) -> Result<(), String> {
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// List every installed editor plus the always-present system default.
#[tauri::command]
pub async fn editors_list() -> Result<Vec<EditorInfo>, String> {
    let mut out: Vec<EditorInfo> = EDITORS
        .iter()
        .filter(|s| is_available(s))
        .map(|s| EditorInfo {
            id: s.id.to_string(),
            name: s.name.to_string(),
            available: true,
        })
        .collect();
    out.push(EditorInfo {
        id: "default".to_string(),
        name: "System default".to_string(),
        available: true,
    });
    Ok(out)
}

/// Open `path` (a file or folder) in the editor identified by `editor_id`.
/// `"default"` defers to the OS file association.
#[tauri::command]
pub async fn editor_open(path: String, editor_id: String) -> Result<(), String> {
    crate::blocking::run(move || {
        let target = PathBuf::from(&path);
        if !target.exists() {
            return Err(format!("path does not exist: {path}"));
        }

        if editor_id == "default" {
            return open_with_os_default(&target);
        }

        let spec = EDITORS
            .iter()
            .find(|s| s.id == editor_id)
            .ok_or_else(|| format!("unknown editor: {editor_id}"))?;

        // Prefer the CLI shim — it opens the exact target and reuses a window.
        for c in spec.cli {
            if let Some(bin) = which(c) {
                let mut cmd = Command::new(&bin);
                cmd.arg(&target);
                return run_detached(cmd);
            }
        }

        // macOS fallback: launch the bundle via `open -a`.
        #[cfg(target_os = "macos")]
        {
            if let Some(app) = mac_app_path(spec.app_names) {
                let mut cmd = Command::new("open");
                cmd.arg("-a").arg(&app).arg(&target);
                return run_detached(cmd);
            }
        }

        Err(format!("{} is not installed", spec.name))
    })
    .await
}

/// Open a path in the OS-associated application.
fn open_with_os_default(target: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        cmd.arg(target);
        run_detached(cmd)
    }
    #[cfg(target_os = "windows")]
    {
        // `explorer <path>` opens a folder in Explorer or a file in its
        // associated app — the closest Windows analogue to `open`.
        let mut cmd = Command::new("explorer");
        cmd.arg(target);
        run_detached(cmd)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(target);
        run_detached(cmd)
    }
}
