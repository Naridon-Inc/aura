//! Node extension-host sidecar — the transport that lets a real VS Code
//! extension's `main` program run.
//!
//! Tier 0/1 (themes, grammars, snippets, web `browser` extensions) need no Node:
//! the contributes router and the in-page Web-Worker host cover them. But a
//! *language* extension — Python, Rust, Go, ESLint — ships a `main` Node entry
//! whose `activate()` spins up a Language Server and talks LSP. That can't run in
//! a browser worker (no child processes, no real `require`). So we spawn a Node
//! sidecar (`resources/ext-host/host.js`) and speak a tiny JSON-lines protocol to
//! it over stdio — the SAME message shapes the web host emits
//! (`registerLanguageProvider` / `provideResult` / `setDiagnostics` …), so the
//! frontend's Monaco bridge (`extHostMonacoLang` / `extHostMonacoDiag`) is reused
//! verbatim. The sidecar, in turn, runs the extension's `main`, spawns its
//! language server, and bridges LSP completion/hover/diagnostics back up.
//!
//! This module is ONLY the transport:
//!   • resolve a `node` binary robustly (a bundled desktop app rarely inherits
//!     the user's shell PATH, so we probe the usual install locations),
//!   • spawn the sidecar with piped stdio,
//!   • pump stdout lines → `ext-host:msg` Tauri events (one JSON object per line),
//!   • pump stderr lines → `ext-host:log` (the sidecar logs there, never stdout,
//!     so the protocol channel stays clean),
//!   • `ext_host_send` writes one JSON line to the sidecar's stdin.
//!
//! All extension-running logic lives in `host.js`; all Monaco wiring lives in the
//! frontend. One sidecar process hosts every enabled Node extension (mirroring VS
//! Code's single shared extension host).

use std::path::PathBuf;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

/// Managed state: the single live sidecar (if any). `tokio::sync::Mutex` because
/// every touch happens from an async command.
#[derive(Default)]
pub struct ExtHostState {
    inner: Mutex<Option<Running>>,
}

struct Running {
    child: Child,
    stdin: ChildStdin,
}

impl ExtHostState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Locate a usable `node`. A packaged macOS app launched from Finder gets a bare
/// PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so the user's nvm/homebrew/volta node
/// is invisible to a plain `Command::new("node")`. We therefore probe, in order:
///   1. an explicit `AURA_NODE_BIN` override,
///   2. `/usr/bin/which node` (works when launched from a terminal that exported
///      a full PATH),
///   3. the well-known install locations, newest nvm version last-wins.
/// Returns a concrete, existing path or a plain-language error the UI can show.
fn resolve_node() -> Result<PathBuf, String> {
    if let Ok(explicit) = std::env::var("AURA_NODE_BIN") {
        let p = PathBuf::from(explicit.trim());
        if p.is_file() {
            return Ok(p);
        }
    }

    if let Some(p) = which_node() {
        return Ok(p);
    }

    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin/node"));
        candidates.push(home.join(".volta/bin/node"));
        candidates.push(home.join(".bun/bin/node"));
        candidates.push(home.join("n/bin/node"));
        // nvm: ~/.nvm/versions/node/<ver>/bin/node — pick the highest version.
        if let Some(p) = newest_nvm_node(&home) {
            candidates.push(p);
        }
        // fnm: ~/.local/state/fnm_multishells/* or ~/.fnm/node-versions/*
        if let Some(p) = newest_fnm_node(&home) {
            candidates.push(p);
        }
    }
    for c in candidates {
        if c.is_file() {
            return Ok(c);
        }
    }
    Err("Node.js wasn't found on this machine. Install Node (https://nodejs.org) or set AURA_NODE_BIN to run extensions that need it.".to_string())
}

fn which_node() -> Option<PathBuf> {
    let out = std::process::Command::new("/usr/bin/which")
        .arg("node")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        let p = PathBuf::from(trimmed);
        if p.is_file() {
            Some(p)
        } else {
            None
        }
    }
}

/// Highest `~/.nvm/versions/node/<ver>/bin/node`. Version compare is a simple
/// lexical-on-numeric-segments sort, which is good enough to prefer v22 over v18.
fn newest_nvm_node(home: &std::path::Path) -> Option<PathBuf> {
    let base = home.join(".nvm/versions/node");
    let mut best: Option<(Vec<u64>, PathBuf)> = None;
    for entry in std::fs::read_dir(&base).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let node = entry.path().join("bin/node");
        if !node.is_file() {
            continue;
        }
        let ver = parse_semver(name.trim_start_matches('v'));
        if best.as_ref().map(|(b, _)| ver > *b).unwrap_or(true) {
            best = Some((ver, node));
        }
    }
    best.map(|(_, p)| p)
}

fn newest_fnm_node(home: &std::path::Path) -> Option<PathBuf> {
    let base = home.join(".fnm/node-versions");
    let mut best: Option<(Vec<u64>, PathBuf)> = None;
    for entry in std::fs::read_dir(&base).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // fnm stores node under <ver>/installation/bin/node
        let node = entry.path().join("installation/bin/node");
        if !node.is_file() {
            continue;
        }
        let ver = parse_semver(name.trim_start_matches('v'));
        if best.as_ref().map(|(b, _)| ver > *b).unwrap_or(true) {
            best = Some((ver, node));
        }
    }
    best.map(|(_, p)| p)
}

fn parse_semver(s: &str) -> Vec<u64> {
    s.split('.')
        .map(|seg| {
            seg.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

/// Resolve the bundled host script. In `tauri dev` this is the source file under
/// `src-tauri/resources/`; in a packaged build it's inside the app bundle.
fn host_script(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve("resources/ext-host/host.js", BaseDirectory::Resource)
        .map_err(|e| format!("locate ext-host script: {e}"))
}

/// Start the sidecar if it isn't already running. Idempotent: a live host is
/// reused; a dead one (the child exited) is replaced. Returns the resolved node
/// path on success so the caller can surface "running on node vX".
#[tauri::command]
pub async fn ext_host_start(
    app: AppHandle,
    state: State<'_, ExtHostState>,
) -> Result<String, String> {
    let mut guard = state.inner.lock().await;
    if let Some(run) = guard.as_mut() {
        // Still alive? Reuse it. `try_wait` returns Ok(None) while running.
        match run.child.try_wait() {
            Ok(None) => return Ok("already-running".to_string()),
            _ => {
                *guard = None; // exited — fall through and respawn
            }
        }
    }

    let node = resolve_node()?;
    let script = host_script(&app)?;
    if !script.is_file() {
        return Err(format!(
            "extension host script missing at {}",
            script.display()
        ));
    }

    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // Hand the sidecar the same node binary so it spawns language servers
    // (NodeModule LSP servers) with a node it knows exists.
    cmd.env("AURA_EXT_HOST_NODE", &node);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn node ext-host: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout handle")?;
    let stderr = child.stderr.take().ok_or("no stderr handle")?;
    let stdin = child.stdin.take().ok_or("no stdin handle")?;

    // stdout = the protocol channel: one JSON object per line → ext-host:msg.
    let app_out = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if line.is_empty() {
                continue;
            }
            let _ = app_out.emit("ext-host:msg", &line);
        }
        // stdout closed → the host went away. Tell the frontend so it can reset.
        let _ = app_out.emit("ext-host:exit", ());
    });

    // stderr = diagnostics/logs only (the sidecar never writes protocol here).
    let app_err = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_err.emit("ext-host:log", &line);
        }
    });

    *guard = Some(Running { child, stdin });
    Ok(node.to_string_lossy().to_string())
}

/// Write one JSON line to the sidecar's stdin. The caller is responsible for the
/// JSON being a single line (no embedded raw newlines — `JSON.stringify` escapes
/// them, so this holds for every protocol message).
#[tauri::command]
pub async fn ext_host_send(state: State<'_, ExtHostState>, json: String) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    let run = guard
        .as_mut()
        .ok_or("extension host is not running")?;
    let mut line = json;
    line.push('\n');
    run.stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write to ext-host: {e}"))?;
    run.stdin
        .flush()
        .await
        .map_err(|e| format!("flush ext-host: {e}"))?;
    Ok(())
}

/// Is the sidecar currently alive?
#[tauri::command]
pub async fn ext_host_status(state: State<'_, ExtHostState>) -> Result<bool, String> {
    let mut guard = state.inner.lock().await;
    Ok(match guard.as_mut() {
        Some(run) => matches!(run.child.try_wait(), Ok(None)),
        None => false,
    })
}

/// Stop the sidecar by SIGKILLing the node host.
///
/// NOTE on the language servers it spawned: on Unix a SIGKILL does NOT cascade to
/// child processes — they're reparented, not killed. What actually reaps them is
/// the LSP *parent-process watchdog*: `languageclient-shim.js` passes
/// `processId: process.pid` (the host's pid) in the `initialize` params, and a
/// spec-compliant server (rust-analyzer, pylsp, gopls, tsserver, the ESLint
/// server …) polls that pid and self-exits once the host is gone. So compliant
/// servers terminate within their poll interval; a non-compliant one could linger
/// until the OS cleans up at app exit. (A future hardening is to put the sidecar in
/// its own process group and kill the whole group — Unix-specific, wants a live
/// test before it ships.)
#[tauri::command]
pub async fn ext_host_stop(state: State<'_, ExtHostState>) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if let Some(mut run) = guard.take() {
        let _ = run.child.start_kill();
    }
    Ok(())
}
