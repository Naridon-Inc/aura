//! A workspace's setup and archive scripts, run on this machine.
//!
//! A new workspace is a fresh checkout: no `node_modules`, no `.env`. The
//! repository's `[worktree] setup` script is what makes it usable, and the
//! `[worktree] archive` script is what tidies up before it goes. This module
//! runs either one in the workspace's folder, keeps what it printed and how it
//! ended (see [`store`]), and tells the app as it goes through a [`Sink`]: a
//! line of output, or a change of status.
//!
//! One run per workspace and kind at a time. Starting a script that is
//! already running hands back the run in progress rather than a second copy.

pub mod copy;
pub mod store;

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ScriptKind {
    Setup,
    Archive,
}

impl ScriptKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ScriptKind::Setup => "setup",
            ScriptKind::Archive => "archive",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScriptStatus {
    Running,
    /// Asked to stop; not gone yet.
    Stopping,
    Completed,
    Failed,
    /// Stopped by the person, or by Aura closing while it ran.
    Cancelled,
    /// Never got going — the shell couldn't be started, or the repository's
    /// settings weren't trusted to run unattended.
    DidNotStart,
}

impl ScriptStatus {
    pub fn is_live(self) -> bool {
        matches!(self, ScriptStatus::Running | ScriptStatus::Stopping)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRun {
    pub kind: ScriptKind,
    pub worktree_path: String,
    pub command: String,
    pub status: ScriptStatus,
    /// Milliseconds since the epoch.
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub exit_code: Option<i32>,
    /// Why it didn't start or why it ended the way it did, when the exit code
    /// doesn't say.
    pub reason: Option<String>,
}

/// What the app hears about a run: a piece of its output, or its new state.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScriptEvent {
    pub worktree_path: String,
    pub kind: ScriptKind,
    pub chunk: Option<String>,
    pub run: Option<ScriptRun>,
}

pub type Sink = Arc<dyn Fn(ScriptEvent) + Send + Sync>;

/// What to run, where, and what the log should open with.
pub struct StartSpec {
    pub kind: ScriptKind,
    pub worktree_path: String,
    pub command: String,
    pub env: Vec<(String, String)>,
    /// Where the record and log are kept; `None` keeps nothing on disk.
    pub store_dir: Option<PathBuf>,
    /// Lines written to the log before the script's own output.
    pub preface: Vec<String>,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// PURE: how a run ended, from its exit and whether someone asked it to stop.
pub fn status_after_exit(code: Option<i32>, stop_requested: bool) -> (ScriptStatus, Option<String>) {
    if stop_requested {
        return (ScriptStatus::Cancelled, Some("Stopped".into()));
    }
    match code {
        Some(0) => (ScriptStatus::Completed, None),
        Some(_) => (ScriptStatus::Failed, None),
        None => (ScriptStatus::Failed, Some("It was killed by a signal".into())),
    }
}

/// PURE: a record read back from disk. One that still says it is running but
/// has no process behind it was cut off when Aura closed.
pub fn settle_on_read(mut run: ScriptRun, live: bool) -> ScriptRun {
    if run.status.is_live() && !live {
        run.status = ScriptStatus::Cancelled;
        run.reason = Some("Aura closed while it was running".into());
        run.ended_at = run.ended_at.or(Some(run.started_at));
    }
    run
}

struct Live {
    pid: u32,
    stop: Arc<AtomicBool>,
    run: Arc<Mutex<ScriptRun>>,
    sink: Sink,
    store_dir: Option<PathBuf>,
}

type Key = (String, ScriptKind);

/// The runs going on right now. Cheap to clone; every clone is the same set.
#[derive(Clone, Default)]
pub struct ScriptRegistry {
    live: Arc<Mutex<HashMap<Key, Live>>>,
}

fn key(worktree_path: &str, kind: ScriptKind) -> Key {
    (worktree_path.trim_end_matches('/').to_string(), kind)
}

fn save(dir: &Option<PathBuf>, run: &ScriptRun) {
    if let Some(dir) = dir {
        if let Err(e) = store::write_record(dir, run) {
            eprintln!("[workspace-scripts] couldn't save the {} record: {e}", run.kind.as_str());
        }
    }
}

fn status_event(run: &ScriptRun) -> ScriptEvent {
    ScriptEvent {
        worktree_path: run.worktree_path.clone(),
        kind: run.kind,
        chunk: None,
        run: Some(run.clone()),
    }
}

impl ScriptRegistry {
    /// The run going on now for this workspace and kind, if any.
    pub fn current(&self, worktree_path: &str, kind: ScriptKind) -> Option<ScriptRun> {
        let live = self.live.lock().unwrap();
        live.get(&key(worktree_path, kind)).map(|l| l.run.lock().unwrap().clone())
    }

    /// Start a script, or hand back the one already running.
    pub fn start(&self, spec: StartSpec, sink: Sink) -> ScriptRun {
        let k = key(&spec.worktree_path, spec.kind);
        let mut live = self.live.lock().unwrap();
        if let Some(l) = live.get(&k) {
            return l.run.lock().unwrap().clone();
        }

        let mut log = match &spec.store_dir {
            Some(dir) => {
                let _ = store::reset_log(dir, spec.kind);
                store::LogWriter::open(dir, spec.kind)
            }
            None => store::LogWriter::none(),
        };
        // The preface opens the log; it goes out to the app after the run's
        // first state, which is what tells the app a new log has begun.
        for line in &spec.preface {
            log.append(format!("{line}\n").as_bytes());
        }

        let mut run = ScriptRun {
            kind: spec.kind,
            worktree_path: spec.worktree_path.clone(),
            command: spec.command.clone(),
            status: ScriptStatus::Running,
            started_at: now_ms(),
            ended_at: None,
            exit_code: None,
            reason: None,
        };

        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(&spec.command)
            .current_dir(&spec.worktree_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Its own process group, so Stop takes down whatever it started.
            cmd.process_group(0);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                run.status = ScriptStatus::DidNotStart;
                run.ended_at = Some(now_ms());
                run.reason = Some(format!("Couldn't start a shell in this workspace: {e}"));
                log.append(format!("{}\n", run.reason.as_deref().unwrap_or_default()).as_bytes());
                save(&spec.store_dir, &run);
                sink(status_event(&run));
                return run;
            }
        };

        save(&spec.store_dir, &run);
        sink(status_event(&run));
        for line in &spec.preface {
            sink(ScriptEvent {
                worktree_path: spec.worktree_path.clone(),
                kind: spec.kind,
                chunk: Some(format!("{line}\n")),
                run: None,
            });
        }

        let shared_run = Arc::new(Mutex::new(run.clone()));
        let stop = Arc::new(AtomicBool::new(false));
        live.insert(
            k.clone(),
            Live {
                pid: child.id(),
                stop: stop.clone(),
                run: shared_run.clone(),
                sink: sink.clone(),
                store_dir: spec.store_dir.clone(),
            },
        );
        drop(live);

        let log = Arc::new(Mutex::new(log));
        let readers: Vec<_> = [
            child.stdout.take().map(|r| Box::new(r) as Box<dyn Read + Send>),
            child.stderr.take().map(|r| Box::new(r) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        .map(|reader| {
            let (log, sink) = (log.clone(), sink.clone());
            let (path, kind) = (spec.worktree_path.clone(), spec.kind);
            std::thread::spawn(move || pump(reader, &log, &sink, &path, kind))
        })
        .collect();

        let registry = self.clone();
        let store_dir = spec.store_dir;
        std::thread::spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code());
            for r in readers {
                let _ = r.join();
            }
            let (status, reason) = status_after_exit(code, stop.load(Ordering::SeqCst));
            let finished = {
                let mut run = shared_run.lock().unwrap();
                run.status = status;
                run.exit_code = code;
                run.reason = reason;
                run.ended_at = Some(now_ms());
                run.clone()
            };
            save(&store_dir, &finished);
            registry.live.lock().unwrap().remove(&k);
            sink(status_event(&finished));
        });

        run
    }

    /// Ask a running script to stop: a polite signal to everything it
    /// started, then a firm one if it is still there a few seconds later.
    pub fn stop(&self, worktree_path: &str, kind: ScriptKind) -> Option<ScriptRun> {
        let live = self.live.lock().unwrap();
        let l = live.get(&key(worktree_path, kind))?;
        l.stop.store(true, Ordering::SeqCst);
        let stopping = {
            let mut run = l.run.lock().unwrap();
            run.status = ScriptStatus::Stopping;
            run.clone()
        };
        save(&l.store_dir, &stopping);
        (l.sink)(status_event(&stopping));
        let pid = l.pid;
        drop(live);
        signal(pid, false);
        let registry = self.clone();
        let path = worktree_path.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            let still = registry.live.lock().unwrap().get(&key(&path, kind)).map(|l| l.pid);
            if still == Some(pid) {
                signal(pid, true);
            }
        });
        Some(stopping)
    }

    /// Wait for a run to finish, up to `timeout`; stops it past that. Returns
    /// how it ended, or `None` if nothing was running.
    pub fn wait(&self, worktree_path: &str, kind: ScriptKind, timeout: Duration) -> Option<ScriptRun> {
        let deadline = Instant::now() + timeout;
        let mut last = self.current(worktree_path, kind)?;
        let mut stopped = false;
        loop {
            match self.current(worktree_path, kind) {
                Some(run) => last = run,
                None => break,
            }
            if !stopped && Instant::now() >= deadline {
                stopped = true;
                self.stop(worktree_path, kind);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // The waiter saved the final record just before leaving the set.
        Some(last)
    }
}

/// Copy a stream into the log and out to the app, a chunk at a time, never
/// splitting a character between two chunks.
fn pump(mut reader: Box<dyn Read + Send>, log: &Mutex<store::LogWriter>, sink: &Sink, path: &str, kind: ScriptKind) {
    let mut buf = [0u8; 4096];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        log.lock().unwrap().append(&buf[..n]);
        pending.extend_from_slice(&buf[..n]);
        let text = take_text(&mut pending);
        if !text.is_empty() {
            sink(ScriptEvent { worktree_path: path.to_string(), kind, chunk: Some(text), run: None });
        }
    }
    if !pending.is_empty() {
        let text = String::from_utf8_lossy(&pending).into_owned();
        sink(ScriptEvent { worktree_path: path.to_string(), kind, chunk: Some(text), run: None });
    }
}

/// PURE: the text at the front of `pending`, leaving behind a character cut
/// in half at the end (it completes on the next read).
pub fn take_text(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let s = s.to_string();
            pending.clear();
            s
        }
        Err(e) if e.error_len().is_none() => {
            let cut = e.valid_up_to();
            let rest = pending.split_off(cut);
            let s = String::from_utf8_lossy(pending).into_owned();
            *pending = rest;
            s
        }
        Err(_) => {
            let s = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            s
        }
    }
}

#[cfg(unix)]
fn signal(pid: u32, hard: bool) {
    let sig = if hard { libc::SIGKILL } else { libc::SIGTERM };
    // The script leads its own group; signal the whole group.
    unsafe {
        libc::kill(-(pid as i32), sig);
    }
}

#[cfg(not(unix))]
fn signal(pid: u32, _hard: bool) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(test)]
mod tests;
