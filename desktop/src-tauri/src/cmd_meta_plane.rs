//! Meaning-plane bridge (M4 — sovereign substrate).
//!
//! Aura keeps a portable "meaning + proof" plane *alongside* the code: for
//! every commit, the why behind each change and whether the stated goals were
//! actually achieved. Crucially this plane travels with the repo on ANY git
//! host — clone it from a fork, a mirror, GitHub or a bare server, and the
//! same record is verifiable on that clone. The CLI exposes it as two
//! read-only JSON commands; this module ferries them to the desktop frontend
//! so a calm in-app panel can show "verified on this clone" without the user
//! ever touching a terminal.
//!
//! Two surfaces:
//!   * `aura meta log --json`    → per-commit intent rows + proof verdict.
//!   * `aura meta verify --json` → a roll-up: how many commits carry intent,
//!                                 how many are proven, and what needs a look.
//!
//! This bridge is a thin shell-out + parse — the schema lives in exactly one
//! place (the engine). We never compute or repair anything here; the panel
//! renders only what the commands return. The `aura` binary is resolved the
//! same way the rest of the shell does (`resolve_aura_bin` — `$AURA_BIN`, then
//! `which aura`, then `~/.cargo/bin/aura`, finally a bare `aura`), never a
//! hardcoded path, so the bundled-CLI install path is honored.

use std::path::PathBuf;
use std::process::Command;

use crate::agent_event_listener::resolve_aura_bin;

/// Run a read-only `aura meta …` subcommand in `repo_root`, expecting
/// well-formed JSON on stdout, and return the parsed value.
///
/// Runs on a blocking thread: spawning the CLI and walking the commit history
/// blocks, and we don't want to stall the async IPC executor for it. The
/// caller has already validated `repo_root` is a directory.
async fn run_meta(repo_root: &str, args: Vec<String>) -> Result<serde_json::Value, String> {
    let cwd = PathBuf::from(repo_root);
    if !cwd.is_dir() {
        return Err(format!("repo root does not exist: {repo_root}"));
    }

    let bin = resolve_aura_bin();
    let label = args.join(" ");

    let out = tokio::task::spawn_blocking(move || {
        Command::new(&bin).args(&args).current_dir(&cwd).output()
    })
    .await
    .map_err(|e| format!("meta task join: {e}"))?
    .map_err(|e| format!("failed to spawn `aura {label}`: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "aura {label} failed (status {}): {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str::<serde_json::Value>(stdout.trim())
        .map_err(|e| format!("parse `aura {label}` json: {e}"))
}

/// Tauri command — shell `aura meta log --json` in `repo_root` and return the
/// parsed array of per-commit meaning entries (intent rows + proof verdict).
#[tauri::command]
pub async fn meta_plane_log(repo_root: String) -> Result<serde_json::Value, String> {
    run_meta(
        &repo_root,
        vec!["meta".to_string(), "log".to_string(), "--json".to_string()],
    )
    .await
}

/// Tauri command — shell `aura meta verify --json` in `repo_root` and return
/// the parsed roll-up report. When `range` is `Some`, scope the check to that
/// commit range (e.g. `origin/main..HEAD`) via `--range <r>`.
#[tauri::command]
pub async fn meta_plane_verify(
    repo_root: String,
    range: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut args = vec![
        "meta".to_string(),
        "verify".to_string(),
        "--json".to_string(),
    ];
    if let Some(r) = range {
        let r = r.trim();
        if !r.is_empty() {
            args.push("--range".to_string());
            args.push(r.to_string());
        }
    }
    run_meta(&repo_root, args).await
}
