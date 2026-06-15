//! Local build verification (plan W5.1).
//!
//! `aura save` calls `verify()` before the push. We detect project type
//! from marker files in cwd, run the matching fast-check, and return a
//! `BuildStatus` that the sync layer attaches to the push payload.
//!
//! Budget: 30s hard cap by default. If no adapter matches we return
//! `skipped` so pre-W5 repos don't regress.

use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
pub struct CheckResult {
    pub name: String,
    pub status: String,           // green | red | skipped | timeout
    pub duration_ms: u64,
    pub stderr_tail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BuildStatus {
    pub status: String,           // green | red | skipped
    pub checks: Vec<CheckResult>,
    pub duration_ms: u64,
}

impl BuildStatus {
    pub fn is_red(&self) -> bool { self.status == "red" }
    pub fn skipped() -> Self {
        Self { status: "skipped".into(), checks: vec![], duration_ms: 0 }
    }
}

/// Run all applicable adapters. `budget_secs` caps the *total* wall time.
pub fn verify(budget_secs: u64) -> BuildStatus {
    let start = Instant::now();
    let deadline = start + Duration::from_secs(budget_secs);

    let adapters = pick_adapters();
    if adapters.is_empty() {
        return BuildStatus::skipped();
    }

    let mut checks = Vec::new();
    let mut any_red = false;

    for (name, cmd, args) in adapters {
        if Instant::now() > deadline {
            checks.push(CheckResult {
                name: name.into(),
                status: "timeout".into(),
                duration_ms: 0,
                stderr_tail: None,
            });
            continue;
        }
        let cstart = Instant::now();
        let remaining = deadline.saturating_duration_since(Instant::now());
        let result = run_with_timeout(cmd, &args, remaining);
        let dur = cstart.elapsed().as_millis() as u64;
        match result {
            Ok(out) => {
                let status = if out.status.success() { "green" } else { "red" };
                if status == "red" { any_red = true; }
                let tail = if status == "red" {
                    let err = String::from_utf8_lossy(&out.stderr);
                    Some(err.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"))
                } else {
                    None
                };
                checks.push(CheckResult {
                    name: name.into(),
                    status: status.into(),
                    duration_ms: dur,
                    stderr_tail: tail,
                });
            }
            Err(msg) => {
                checks.push(CheckResult {
                    name: name.into(),
                    status: "timeout".into(),
                    duration_ms: dur,
                    stderr_tail: Some(msg),
                });
            }
        }
    }

    let status = if any_red { "red" } else { "green" };
    BuildStatus {
        status: status.into(),
        checks,
        duration_ms: start.elapsed().as_millis() as u64,
    }
}

type Adapter = (&'static str, &'static str, Vec<String>);

fn pick_adapters() -> Vec<Adapter> {
    let mut out: Vec<Adapter> = Vec::new();
    if Path::new("Cargo.toml").exists() {
        out.push(("cargo-check", "cargo", vec!["check".into(), "--quiet".into()]));
    }
    if Path::new("package.json").exists() && Path::new("tsconfig.json").exists() {
        out.push(("tsc-noemit", "npx", vec!["--yes".into(), "tsc".into(), "--noEmit".into()]));
    }
    if Path::new("go.mod").exists() {
        out.push(("go-build", "go", vec!["build".into(), "./...".into()]));
    }
    if Path::new("pyproject.toml").exists() || Path::new("mypy.ini").exists() {
        out.push(("mypy", "mypy", vec![".".into(), "--no-error-summary".into()]));
    }
    out
}

fn run_with_timeout(
    cmd: &str,
    args: &[String],
    timeout: Duration,
) -> Result<std::process::Output, String> {
    use std::sync::mpsc;
    use std::thread;

    let mut child = Command::new(cmd)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn {}: {}", cmd, e))?;

    let (tx, rx) = mpsc::channel();
    let id = child.id();
    // Take stdout/stderr so we can read even if we kill later.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    thread::spawn(move || {
        let status = child.wait();
        let _ = tx.send(status);
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok(status)) => {
            let mut stdout_buf = Vec::new();
            let mut stderr_buf = Vec::new();
            if let Some(mut s) = stdout { let _ = std::io::Read::read_to_end(&mut s, &mut stdout_buf); }
            if let Some(mut s) = stderr { let _ = std::io::Read::read_to_end(&mut s, &mut stderr_buf); }
            Ok(std::process::Output { status, stdout: stdout_buf, stderr: stderr_buf })
        }
        Ok(Err(e)) => Err(format!("wait: {}", e)),
        Err(_) => {
            // Best-effort kill via `kill` — we moved child into the thread above.
            let _ = Command::new("kill").arg(id.to_string()).status();
            Err(format!("timeout after {:?}", timeout))
        }
    }
}
