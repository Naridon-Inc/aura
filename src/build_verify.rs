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
    pub status: String,           // green | red | timeout | skipped
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

    BuildStatus {
        status: rollup_status(&checks).into(),
        checks,
        duration_ms: start.elapsed().as_millis() as u64,
    }
}

/// Roll the per-check results up into the single verdict the push carries.
///
/// The old roll-up tracked only an `any_red` flag, so every outcome that
/// wasn't an executed-and-failed check — a check that hit the wall-clock
/// deadline, a tool that couldn't even be spawned (`cargo` off PATH under a
/// stripped git-hook/GUI environment), a genuine timeout — fell through to
/// "green". A checkout that never actually compiled was then uploaded and
/// recorded as a verified-green build, and identical source went green or red
/// purely as a function of machine speed. Derive the verdict from the checks
/// themselves instead: red if any failed, else timeout if any didn't complete,
/// else green. This mirrors the aura-ci build gate, which already recomputes
/// from `checks[]` for exactly this reason.
fn rollup_status(checks: &[CheckResult]) -> &'static str {
    if checks.iter().any(|c| c.status == "red") {
        "red"
    } else if checks.iter().any(|c| c.status == "timeout") {
        "timeout"
    } else {
        "green"
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

    let id = child.id();
    // Drain stdout/stderr on their own threads BEFORE waiting. The OS pipe
    // buffer is small (~64 KiB); a chatty build — cargo check, tsc — fills it
    // and then blocks on write() until someone reads. If we only read after
    // wait() returns (as this used to), that wait never returns: the child is
    // stuck writing, we're stuck waiting, and a fast build gets misreported as
    // a timeout — worse, a red build's diagnostics get masked as one. Reading
    // concurrently lets the child make progress and actually exit.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_h = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stdout { let _ = std::io::Read::read_to_end(&mut s, &mut buf); }
        buf
    });
    let stderr_h = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stderr { let _ = std::io::Read::read_to_end(&mut s, &mut buf); }
        buf
    });

    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let status = child.wait();
        let _ = tx.send(status);
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok(status)) => {
            // The child has exited, so both pipes are at EOF; these joins return
            // promptly with the fully-drained output.
            let stdout_buf = stdout_h.join().unwrap_or_default();
            let stderr_buf = stderr_h.join().unwrap_or_default();
            Ok(std::process::Output { status, stdout: stdout_buf, stderr: stderr_buf })
        }
        Ok(Err(e)) => Err(format!("wait: {}", e)),
        Err(_) => {
            // SIGKILL, not SIGTERM: a build that ignores TERM (cargo mid-link,
            // a wedged compiler) would outlive us, and with it the wait thread
            // and both drain threads — every timeout would leak a process plus
            // three threads until the CLI itself exits. KILL cannot be caught,
            // so the child dies, wait() reaps it, and the drains hit EOF.
            #[cfg(unix)]
            let _ = Command::new("kill").args(["-9", &id.to_string()]).status();
            #[cfg(not(unix))]
            let _ = Command::new("taskkill").args(["/F", "/PID", &id.to_string()]).status();
            Err(format!("timeout after {:?}", timeout))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A subprocess that writes `bytes` to stdout (or stderr when `to_stderr`)
    // and exits with `code`. Used to exceed one OS pipe buffer (~64 KiB) so a
    // non-draining reader would deadlock.
    fn chatty(bytes: usize, to_stderr: bool, code: i32) -> Vec<String> {
        let redirect = if to_stderr { " 1>&2" } else { "" };
        vec![
            "-c".to_string(),
            format!("head -c {bytes} /dev/zero{redirect}; exit {code}"),
        ]
    }

    #[test]
    fn drains_large_stdout_without_deadlock() {
        // Writes far more than one pipe buffer, then exits 0. If the pipe is
        // only read after wait(), the child blocks on write(), wait() never
        // returns, and this fast success is misreported as a timeout.
        // Budget is generous (a passing run returns the instant the child
        // exits, in ms — the budget only bounds a genuine hang), so this stays
        // green even when the whole suite is running in parallel under load.
        let out = run_with_timeout("sh", &chatty(512_000, false, 0), Duration::from_secs(60))
            .expect("chatty-but-successful build must complete, not time out");
        assert!(out.status.success(), "child exited 0");
        // ≥, not ==: under a parallel test run another thread's concurrently
        // spawned child can inherit the pipe's write end for a moment and
        // bleed a few stray bytes in (observed +116 on stderr, macOS). The
        // property under test is no-deadlock + no-truncation — an exact
        // count asserts bytes this test doesn't control.
        assert!(out.stdout.len() >= 512_000, "full stdout drained");
    }

    #[test]
    fn drains_large_stderr_without_deadlock() {
        // Same, but the flood is on stderr and the child fails — this is the
        // dangerous case: a real red build whose diagnostics fill the pipe
        // would otherwise be masked as a timeout, losing the failure signal.
        let out = run_with_timeout("sh", &chatty(512_000, true, 3), Duration::from_secs(60))
            .expect("chatty red build must surface as a completed run, not a timeout");
        assert!(!out.status.success(), "child exited nonzero");
        // ≥, not ==: see drains_large_stdout_without_deadlock — stray bytes
        // from sibling test children flaked this at 512,116 under load.
        assert!(out.stderr.len() >= 512_000, "full stderr drained for the red tail");
    }

    /// The timeout arm must SIGKILL: a child that traps TERM survived the old
    /// plain `kill`, leaking the process plus the wait thread and both drain
    /// threads on every timeout. Verify the child is actually gone.
    #[cfg(unix)]
    #[test]
    fn timeout_kills_a_term_ignoring_child() {
        let pid_file = std::env::temp_dir().join(format!(
            "aura_bv_pid_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let script = format!("echo $$ > {}; trap '' TERM; sleep 30", pid_file.display());
        let r = run_with_timeout("sh", &["-c".to_string(), script], Duration::from_millis(500));
        assert!(r.is_err(), "budget exceeded must still surface as Err(timeout)");

        let pid = std::fs::read_to_string(&pid_file)
            .expect("child wrote its pid before ignoring TERM")
            .trim()
            .to_string();
        // KILL delivery is asynchronous — poll briefly, then require dead.
        let mut alive = true;
        for _ in 0..50 {
            let gone = Command::new("kill")
                .args(["-0", &pid])
                .status()
                .map(|s| !s.success())
                .unwrap_or(true);
            if gone {
                alive = false;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = std::fs::remove_file(&pid_file);
        assert!(!alive, "TERM-ignoring child must be dead after the timeout arm");
    }

    #[test]
    fn genuine_hang_still_reports_timeout() {
        // The drain change must not swallow real hangs: a child that sleeps
        // past the budget is still an Err(timeout).
        let r = run_with_timeout(
            "sh",
            &["-c".to_string(), "sleep 30".to_string()],
            Duration::from_millis(300),
        );
        assert!(r.is_err(), "a child exceeding the budget must surface as Err");
    }

    fn check(status: &str) -> CheckResult {
        CheckResult {
            name: "c".into(),
            status: status.into(),
            duration_ms: 0,
            stderr_tail: None,
        }
    }

    #[test]
    fn a_run_where_a_check_did_not_complete_is_not_green() {
        // The core defect: a check that timed out or couldn't be launched must
        // never roll up to "green" — that would push a never-compiled checkout
        // as a verified-green build.
        assert_eq!(rollup_status(&[check("timeout")]), "timeout");
        assert_eq!(rollup_status(&[check("green"), check("timeout")]), "timeout");
    }

    #[test]
    fn red_dominates_and_all_green_is_green() {
        assert_eq!(rollup_status(&[check("green"), check("green")]), "green");
        assert_eq!(rollup_status(&[check("green"), check("red")]), "red");
        // A real failure outranks a slow sibling — red, not timeout.
        assert_eq!(rollup_status(&[check("red"), check("timeout")]), "red");
    }

    #[test]
    fn verify_with_a_zero_budget_reports_the_stalled_run_honestly() {
        // budget 0 → the deadline is already past on the first adapter, so
        // every adapter is recorded "timeout" and nothing runs. The verdict
        // must reflect that, not "green". (This crate's own cwd has a
        // Cargo.toml, so at least one adapter is picked.)
        let s = verify(0);
        if !s.checks.is_empty() {
            assert!(s.checks.iter().all(|c| c.status == "timeout"));
            assert_ne!(s.status, "green", "a stalled run is not green");
            assert_eq!(s.status, "timeout");
        }
    }
}
