//! The app's handle on a workspace's setup and archive scripts.
//!
//! The scripts are the repository's own `[worktree] setup` / `archive` in
//! `.aura/settings.toml` — the same ones `aura work new` runs from a terminal.
//! A workspace made in the app runs setup the moment it exists (after the
//! repository's copy list has been copied in); the Setup tab shows it live,
//! and keeps the log once it has ended so a failure can be read and retried.
//! Archiving a workspace runs the archive script first and waits for it.
//!
//! Events go out on [`EVENT`]: a piece of output, or the run's new state.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::workspace_scripts::{
    self, copy, store, ScriptEvent, ScriptKind, ScriptRegistry, ScriptRun, ScriptStatus, Sink,
    StartSpec,
};

pub const EVENT: &str = "workspace-script";

/// How long archiving waits on the archive script before stopping it.
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceScriptsState {
    pub setup: Option<ScriptRun>,
    pub archive: Option<ScriptRun>,
}

fn sink_for(app: &AppHandle) -> Sink {
    let app = app.clone();
    Arc::new(move |e: ScriptEvent| {
        let _ = app.emit(EVENT, e);
    })
}

fn store_dir(worktree_path: &str) -> Option<PathBuf> {
    store::root().map(|root| store::dir_for(&root, worktree_path))
}

/// The run going on now, or else the last one recorded (settled: a record
/// still saying "running" with nothing behind it was cut off).
fn last_run(registry: &ScriptRegistry, worktree_path: &str, kind: ScriptKind) -> Option<ScriptRun> {
    if let Some(live) = registry.current(worktree_path, kind) {
        return Some(live);
    }
    let dir = store_dir(worktree_path)?;
    store::read_record(&dir, kind).map(|r| workspace_scripts::settle_on_read(r, false))
}

/// The configured command for `kind`, trimmed; `None` when there isn't one.
fn configured(repo_root: &Path, kind: ScriptKind) -> Option<String> {
    let lifecycle = aura_env::load(repo_root).lifecycle;
    let cmd = match kind {
        ScriptKind::Setup => lifecycle.setup,
        ScriptKind::Archive => lifecycle.archive,
    }?;
    let cmd = cmd.trim().to_string();
    (!cmd.is_empty()).then_some(cmd)
}

/// A copy made from a repository (a linked worktree: its `.git` is a file
/// naming the repository), as opposed to the repository's own folder.
pub fn is_linked_copy(path: &Path) -> bool {
    path.join(".git").is_file()
}

/// PURE: the per-workspace port, `[3000, 3999]`, stable for a name — the same
/// derivation the CLI uses, so a workspace gets one port wherever it is set up.
pub fn port_for(name: &str) -> u16 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in name.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    3000 + (hash % 1000) as u16
}

/// PURE: what a script sees about the workspace it runs in.
pub fn script_env(repo_root: &str, worktree_path: &str, branch: &str) -> Vec<(String, String)> {
    let name = Path::new(worktree_path.trim_end_matches('/'))
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    vec![
        ("AURA_WORK_PORT".into(), port_for(&name).to_string()),
        ("AURA_WORK_NAME".into(), name),
        ("AURA_WORK_BRANCH".into(), branch.to_string()),
        ("AURA_ROOT_PATH".into(), repo_root.to_string()),
    ]
}

fn branch_of(worktree_path: &str) -> String {
    Command::new("git")
        .args(["-C", worktree_path, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// A run that never got going, recorded and announced like any other so the
/// Setup tab can say why.
fn did_not_start(sink: &Sink, kind: ScriptKind, worktree_path: &str, command: &str, reason: String) -> ScriptRun {
    let now = workspace_scripts::now_ms();
    let run = ScriptRun {
        kind,
        worktree_path: worktree_path.to_string(),
        command: command.to_string(),
        status: ScriptStatus::DidNotStart,
        started_at: now,
        ended_at: Some(now),
        exit_code: None,
        reason: Some(reason.clone()),
    };
    if let Some(dir) = store_dir(worktree_path) {
        let _ = store::reset_log(&dir, kind);
        let mut log = store::LogWriter::open(&dir, kind);
        log.append(format!("{reason}\n").as_bytes());
        let _ = store::write_record(&dir, &run);
    }
    sink(ScriptEvent {
        worktree_path: worktree_path.to_string(),
        kind,
        chunk: None,
        run: Some(run.clone()),
    });
    run
}

/// Start `kind` for a workspace. `Ok(None)` when the repository has no such
/// script. A repository whose sealed settings changed since they were signed
/// doesn't run them: the run is recorded as not started, with the reason.
fn start_kind(
    registry: &ScriptRegistry,
    sink: Sink,
    repo_root: &str,
    worktree_path: &str,
    kind: ScriptKind,
    preface: Vec<String>,
) -> Option<ScriptRun> {
    let root = Path::new(repo_root);
    let command = configured(root, kind)?;
    let spec = aura_env::load(root);
    let trust = aura_env::trust(root, &spec);
    if !trust.may_apply() {
        let reason = format!("Didn't run the {} script: {}", kind.as_str(), trust.describe());
        return Some(did_not_start(&sink, kind, worktree_path, &command, reason));
    }
    let env = script_env(repo_root, worktree_path, &branch_of(worktree_path));
    Some(registry.start(
        StartSpec {
            kind,
            worktree_path: worktree_path.to_string(),
            command,
            env,
            store_dir: store_dir(worktree_path),
            preface,
        },
        sink,
    ))
}

/// Right after a workspace is made: copy the repository's copy list in, then
/// start its setup script (in the background — the workspace is usable while
/// it runs). What was copied opens the setup log.
pub fn begin_setup_after_create(app: &AppHandle, registry: &ScriptRegistry, repo_root: &str, worktree_path: &str) {
    let settings = crate::cmd_repo_settings::load_settings(Path::new(repo_root));
    let preface = if settings.copy_files.is_empty() {
        Vec::new()
    } else {
        copy::copy_files_into(
            Path::new(repo_root),
            Path::new(worktree_path),
            &settings.copy_files,
            settings.copy_files_include_binaries,
        )
        .log_lines()
    };
    start_kind(registry, sink_for(app), repo_root, worktree_path, ScriptKind::Setup, preface);
}

/// How each of a workspace's scripts stands: running now, or how it last
/// ended. `None` for a script that has never run here.
#[tauri::command]
pub async fn workspace_scripts_state(
    registry: State<'_, ScriptRegistry>,
    worktree_path: String,
) -> Result<WorkspaceScriptsState, String> {
    let registry = registry.inner().clone();
    Ok(crate::blocking::run(move || WorkspaceScriptsState {
        setup: last_run(&registry, &worktree_path, ScriptKind::Setup),
        archive: last_run(&registry, &worktree_path, ScriptKind::Archive),
    })
    .await)
}

/// The end of a script's log — what the Setup tab shows on opening, before
/// live output arrives.
#[tauri::command]
pub async fn workspace_script_log(worktree_path: String, kind: ScriptKind) -> Result<String, String> {
    Ok(crate::blocking::run(move || {
        store_dir(&worktree_path)
            .map(|dir| store::read_log_tail(&dir, kind, store::LOG_TAIL_BYTES))
            .unwrap_or_default()
    })
    .await)
}

/// Run (or rerun) a workspace's script now. Hands back the run in progress
/// when it is already going.
#[tauri::command]
pub async fn workspace_script_run(
    app: AppHandle,
    registry: State<'_, ScriptRegistry>,
    repo_root: String,
    worktree_path: String,
    kind: ScriptKind,
) -> Result<ScriptRun, String> {
    let registry = registry.inner().clone();
    crate::blocking::run(move || {
        start_kind(&registry, sink_for(&app), &repo_root, &worktree_path, kind, Vec::new())
            .ok_or_else(|| format!("This repository has no {} script", kind.as_str()))
    })
    .await
}

/// Stop a running script. `None` when nothing was running.
#[tauri::command]
pub async fn workspace_script_stop(
    registry: State<'_, ScriptRegistry>,
    worktree_path: String,
    kind: ScriptKind,
) -> Result<Option<ScriptRun>, String> {
    Ok(registry.stop(&worktree_path, kind))
}

/// Before a workspace is archived: stop its setup if it is still going, run
/// the archive script, and wait for it. `None` when there is no archive
/// script. The caller decides what a failure means; the log is kept.
#[tauri::command]
pub async fn workspace_archive_script(
    app: AppHandle,
    registry: State<'_, ScriptRegistry>,
    repo_root: String,
    worktree_path: String,
) -> Result<Option<ScriptRun>, String> {
    let registry = registry.inner().clone();
    Ok(crate::blocking::run(move || {
        // Archiving a whole repository hides it; the archive script is for
        // the copies made from it, never the repository's own folder.
        if !is_linked_copy(Path::new(&worktree_path)) {
            return None;
        }
        if registry.current(&worktree_path, ScriptKind::Setup).is_some() {
            registry.stop(&worktree_path, ScriptKind::Setup);
            registry.wait(&worktree_path, ScriptKind::Setup, Duration::from_secs(5));
        }
        let started = start_kind(&registry, sink_for(&app), &repo_root, &worktree_path, ScriptKind::Archive, Vec::new())?;
        if !started.status.is_live() {
            return Some(started);
        }
        registry.wait(&worktree_path, ScriptKind::Archive, ARCHIVE_TIMEOUT);
        last_run(&registry, &worktree_path, ScriptKind::Archive)
    })
    .await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_copy_gets_the_archive_script() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let main = base.join("main");
        let copy = base.join("copy");
        std::fs::create_dir_all(main.join(".git")).unwrap();
        std::fs::create_dir_all(&copy).unwrap();
        std::fs::write(copy.join(".git"), "gitdir: ../main/.git/worktrees/copy\n").unwrap();
        assert!(!is_linked_copy(&main), "the repository's own folder");
        assert!(is_linked_copy(&copy), "a linked worktree");
        assert!(!is_linked_copy(&base.join("missing")));
    }

    #[test]
    fn port_matches_the_cli_and_stays_in_range() {
        let p = port_for("login-fix");
        assert!((3000..4000).contains(&p));
        assert_eq!(p, port_for("login-fix"));
        assert_ne!(port_for("login-fix"), port_for("login-fix-2"));
    }

    #[test]
    fn env_names_the_workspace_by_its_folder() {
        let env = script_env("/repo", "/w/brave-otter/", "work/brave-otter");
        assert_eq!(env[0].0, "AURA_WORK_PORT");
        assert_eq!(env[1], ("AURA_WORK_NAME".into(), "brave-otter".into()));
        assert_eq!(env[2], ("AURA_WORK_BRANCH".into(), "work/brave-otter".into()));
        assert_eq!(env[3], ("AURA_ROOT_PATH".into(), "/repo".into()));
    }

    #[test]
    fn a_repo_without_the_script_has_nothing_to_run() {
        let dir = tempfile::tempdir().unwrap();
        assert!(configured(dir.path(), ScriptKind::Setup).is_none());
        std::fs::create_dir_all(dir.path().join(".aura")).unwrap();
        std::fs::write(
            dir.path().join(".aura/settings.toml"),
            "[worktree]\nsetup = \"  bun install  \"\narchive = \"\"\n",
        )
        .unwrap();
        assert_eq!(configured(dir.path(), ScriptKind::Setup).as_deref(), Some("bun install"));
        assert!(configured(dir.path(), ScriptKind::Archive).is_none());
    }
}
