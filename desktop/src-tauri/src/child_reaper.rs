//! Making sure an agent CLI dies when we say so — and when we quit.
//!
//! On 2026-08-23 QA pressed Stop on a running agent turn. The UI drew a
//! "Cancelled" marker, the command kept going, and more steps arrived after
//! the surface looked idle. Quitting Aura removed `aura-shell` and left
//! `claude -p …` alive as pid 94776 with PPID 1, still able to run tools and
//! still costing money. QA had to find it with `ps` and signal it by hand.
//!
//! Three separate holes produced that:
//!
//!   1. **We signalled one process, not the tree.** `kill(pid, SIGTERM)`
//!      reaches the CLI we spawned. The CLI's own children — a shell it ran
//!      as a tool call, a language server, whatever it started — are not its
//!      caller's problem to find. Killing a *process group* reaches all of
//!      them, which is why every agent child is now given a group of its own
//!      at spawn: we cannot signal the group we are already in without
//!      killing the app.
//!
//!   2. **We forgot the pid the moment we signalled it.** SIGTERM is a
//!      request. A process mid-syscall, or one that installs a handler and
//!      takes its time, is still there afterwards — and the registry had
//!      already dropped it, so a second Stop reported "nothing was running"
//!      and there was no path left to escalate. The pid now stays until the
//!      process is actually gone, and SIGKILL follows if SIGTERM doesn't
//!      take.
//!
//!   3. **Nothing swept on quit.** `kill_on_drop` runs when a tokio `Child`
//!      is dropped; process exit drops nothing. Anything still registered at
//!      shutdown has to be signalled explicitly.
//!
//! Unix only for the group mechanics — Windows gets the nearest equivalent
//! (`CREATE_NEW_PROCESS_GROUP` at spawn, `taskkill /T` on the way out).

use std::time::Duration;

/// How long a child gets to honour SIGTERM before SIGKILL. Long enough for
/// claude to flush partial stdout so the bubble feed doesn't truncate
/// mid-message; short enough that Stop still feels like Stop.
pub const GRACE: Duration = Duration::from_millis(1500);

/// Poll interval while waiting out `GRACE`.
const POLL: Duration = Duration::from_millis(50);

/// What happened to a child we asked to stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing was there — already exited, or never started.
    Gone,
    /// It took SIGTERM and exited within the grace period.
    Terminated,
    /// It ignored SIGTERM and we sent SIGKILL.
    Killed,
    /// We signalled it and it is *still* there. The caller must keep the pid
    /// so the next Stop can try again — reporting success here is what let a
    /// live agent look cancelled.
    Survived,
}

impl Outcome {
    /// Whether the caller may forget this pid. A survivor must be kept.
    pub fn may_forget(self) -> bool {
        !matches!(self, Outcome::Survived)
    }

    /// Whether we actually signalled something, for a UI that wants to know
    /// if Stop did anything at all.
    pub fn signalled(self) -> bool {
        matches!(self, Outcome::Terminated | Outcome::Killed | Outcome::Survived)
    }
}

/// Put a child in a process group of its own so it can later be signalled as
/// a tree without touching the app.
///
/// Call before `spawn()`. On Unix this is `setsid(2)` in the forked child,
/// which makes it a session and group leader — its pid is its pgid, so the
/// pid we already record is the group we later signal.
#[cfg(unix)]
pub fn own_process_group(cmd: &mut tokio::process::Command) {
    // SAFETY: pre_exec runs between fork and exec. setsid is async-signal-safe
    // and touches nothing this process owns.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                // Already a group leader is fine and not worth failing a
                // spawn over; any other errno is equally not fatal here —
                // we would simply fall back to signalling one process.
                let _ = std::io::Error::last_os_error();
            }
            Ok(())
        });
    }
}

#[cfg(windows)]
pub fn own_process_group(cmd: &mut tokio::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

/// Same, for a `std::process::Command`.
#[cfg(unix)]
pub fn own_process_group_std(cmd: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: as above.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                let _ = std::io::Error::last_os_error();
            }
            Ok(())
        });
    }
}

#[cfg(windows)]
pub fn own_process_group_std(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

/// Is this pid still *running*?
///
/// `kill(pid, 0)` performs the permission and existence checks without
/// sending anything. `EPERM` means it exists and isn't ours — still alive.
///
/// A process that has exited but not yet been reaped by its parent still
/// answers that check: the pid stays allocated until someone calls `wait`.
/// It cannot execute a single instruction in that state, so counting it as
/// alive is wrong twice over — it made a SIGKILLed child read as a survivor,
/// which is the one outcome that tells the caller Stop failed.
#[cfg(unix)]
pub fn alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: signal 0 sends nothing; kill(2) is safe to call with any pid.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    if rc != 0 {
        return std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    }
    !is_zombie(pid)
}

/// Has this pid exited and simply not been reaped yet?
///
/// `waitid` with `WNOHANG | WNOWAIT` asks the kernel whether the child has a
/// termination status waiting, without consuming it. Not consuming it is the
/// point: whoever spawned the child owns the `wait` that clears it — the
/// stream reader in `cmd_agent_stream`, or a test's own `Child` — and taking
/// the status out from under that waiter turns its `wait` into an ECHILD
/// error and loses the exit code the surface reports.
///
/// Only answers for our own children. Anything else returns ECHILD, which
/// reads here as "not a zombie we know about" and leaves `alive` to its
/// signal-based answer.
#[cfg(unix)]
fn is_zombie(pid: u32) -> bool {
    // SAFETY: siginfo_t is a plain C struct with no invariants that a zeroed
    // value violates; waitid fills it in or leaves it as written.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // SAFETY: P_PID selects one process id; the buffer is exactly the
    // siginfo_t waitid writes. WNOWAIT means the child stays reapable.
    let rc = unsafe {
        libc::waitid(
            libc::P_PID,
            pid,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if rc != 0 {
        return false;
    }
    // With WNOHANG and nothing to report, waitid succeeds and leaves the
    // struct as it found it — so a filled-in si_signo is the "it has exited"
    // signal, and zero means still running.
    info.si_signo != 0
}

/// Signal one process group and wait for it, escalating if it does not go.
///
/// `pid` must be a group leader — see [`own_process_group`]. If it isn't
/// (an older spawn path, or setsid failed), the negative-pid kill fails with
/// ESRCH and we fall back to signalling the single process, which is exactly
/// the previous behaviour rather than a regression.
#[cfg(unix)]
pub fn terminate_tree(pid: u32) -> Outcome {
    if !alive(pid) {
        return Outcome::Gone;
    }

    signal_tree(pid, libc::SIGTERM);
    if wait_for_exit(pid, GRACE) {
        return Outcome::Terminated;
    }

    signal_tree(pid, libc::SIGKILL);
    // SIGKILL cannot be caught, but the process still has to be reaped, and
    // a zombie answers kill(pid, 0). Give it a short moment.
    if wait_for_exit(pid, Duration::from_millis(500)) {
        Outcome::Killed
    } else {
        Outcome::Survived
    }
}

#[cfg(windows)]
pub fn terminate_tree(pid: u32) -> Outcome {
    // /T takes the whole tree, /F skips the polite request.
    let ok = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        Outcome::Killed
    } else {
        Outcome::Gone
    }
}

/// Send `sig` to the whole group, falling back to the single process.
#[cfg(unix)]
fn signal_tree(pid: u32, sig: i32) {
    // SAFETY: killpg/kill with a pid from our own spawn. A failure here means
    // the target is already gone, which the caller's next poll will see.
    unsafe {
        // Negative pid = "the process group with this id".
        if libc::kill(-(pid as i32), sig) == -1 {
            libc::kill(pid as i32, sig);
        }
    }
}

#[cfg(unix)]
fn wait_for_exit(pid: u32, budget: Duration) -> bool {
    let deadline = std::time::Instant::now() + budget;
    loop {
        if !alive(pid) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(POLL);
    }
}

/// Every child we have spawned that must not outlive the app, by pid.
///
/// A tokio `Child` cleans itself up when it is *dropped*; quitting the app
/// drops nothing, so anything still in here at shutdown would be reparented to
/// init and keep running. [`sweep`] is the last thing that can stop that, and
/// it is why this is a process-wide book rather than a per-surface one — the
/// agent-stream registry, the manager brain and the crew loop all spawn
/// children, and only one of them had an owner at exit.
static TRACKED: std::sync::Mutex<std::collections::BTreeMap<u32, String>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

/// Record a child that must die with the app. `what` is for the shutdown log.
pub fn track(pid: Option<u32>, what: &str) {
    let Some(pid) = pid else { return };
    if let Ok(mut g) = TRACKED.lock() {
        g.insert(pid, what.to_string());
    }
}

/// Forget a child — it has been reaped, and its pid may now be reused.
pub fn forget(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    if let Ok(mut g) = TRACKED.lock() {
        g.remove(&pid);
    }
}

/// Stop everything still tracked. Returns how many were still running.
///
/// Call once, on the way out. Safe to call after the per-surface registries
/// have done their own sweep: an already-dead pid reports `Gone`.
pub fn sweep() -> usize {
    let live: Vec<(u32, String)> = match TRACKED.lock() {
        Ok(mut g) => std::mem::take(&mut *g).into_iter().collect(),
        Err(_) => return 0,
    };
    let mut stopped = 0;
    for (pid, what) in live {
        match terminate_tree(pid) {
            Outcome::Gone => {}
            Outcome::Survived => {
                stopped += 1;
                tracing::warn!(pid, what = %what, "child outlived SIGKILL at shutdown");
            }
            _ => {
                stopped += 1;
                tracing::info!(pid, what = %what, "stopped a child at shutdown");
            }
        }
    }
    stopped
}

/// Terminates a child's whole process group when it goes out of scope.
///
/// `tokio::process::Command::kill_on_drop` covers the child we spawned and
/// nothing it spawned in turn — and only when the `Child` is actually
/// dropped. This guard closes the first half: dropping a chat stream early,
/// or unwinding out of it, takes the group with it.
///
/// Call [`TreeGuard::disarm`] once the child has been waited on. After a
/// process is reaped its pid is free for the kernel to hand to someone else,
/// and signalling a recycled pid would hit a stranger.
pub struct TreeGuard {
    pid: Option<u32>,
}

impl TreeGuard {
    /// Guard `pid`. `None` — a child that reported no pid — guards nothing.
    pub fn new(pid: Option<u32>) -> Self {
        Self::named(pid, "agent child")
    }

    /// Guard `pid`, labelling it for the shutdown log. Guarding also enters
    /// the child in [`TRACKED`], so a quit that never drops this guard still
    /// reaches the process.
    pub fn named(pid: Option<u32>, what: &str) -> Self {
        track(pid, what);
        Self { pid }
    }

    /// Stop guarding: the child has been reaped and its pid may be reused.
    pub fn disarm(&mut self) {
        forget(self.pid);
        self.pid = None;
    }
}

impl Drop for TreeGuard {
    fn drop(&mut self) {
        let Some(pid) = self.pid.take() else { return };
        forget(Some(pid));
        // The usual drop is a cancelled turn's task being aborted on a runtime
        // worker, and `terminate_tree` waits out the grace period — holding a
        // worker for a second and a half stalls unrelated chat. Hand it to the
        // blocking pool where there is one; on the quit path there is no
        // runtime and the wait is what we want anyway.
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn_blocking(move || {
                    terminate_tree(pid);
                });
            }
            Err(_) => {
                terminate_tree(pid);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_survivor_must_not_be_forgotten() {
        // The registry drops a pid when may_forget() says so. Forgetting a
        // survivor is precisely what made a second Stop report "nothing was
        // running" while the agent kept working.
        assert!(!Outcome::Survived.may_forget());
        assert!(Outcome::Gone.may_forget());
        assert!(Outcome::Terminated.may_forget());
        assert!(Outcome::Killed.may_forget());
    }

    #[test]
    fn stop_reports_it_did_something_only_when_it_did() {
        assert!(!Outcome::Gone.signalled());
        assert!(Outcome::Terminated.signalled());
        assert!(Outcome::Killed.signalled());
        assert!(
            Outcome::Survived.signalled(),
            "we did signal it; the UI should not claim nothing was running"
        );
    }

    #[test]
    fn the_grace_period_leaves_room_to_flush_but_still_feels_immediate() {
        assert!(GRACE >= Duration::from_millis(500), "too short to flush stdout");
        assert!(GRACE <= Duration::from_secs(3), "Stop must feel like Stop");
    }

    #[cfg(unix)]
    #[test]
    fn pid_zero_is_never_alive() {
        // kill(0, …) means "my own process group" — treating it as a live
        // child would make a stray zero signal the app itself.
        assert!(!alive(0));
    }

    #[cfg(unix)]
    #[test]
    fn this_process_is_alive_and_an_absurd_pid_is_not() {
        assert!(alive(std::process::id()));
        // Above any plausible pid_max on macOS or Linux.
        assert!(!alive(4_000_000_000));
    }

    /// A temp path nothing else will collide with, for a child to report
    /// readiness or a pid through.
    #[cfg(unix)]
    fn marker(tag: &str) -> std::path::PathBuf {
        static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        std::env::temp_dir().join(format!(
            "aura-reaper-{}-{}-{}.tmp",
            tag,
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    /// Block until `path` exists, or give up. Returns its contents.
    #[cfg(unix)]
    fn await_marker(path: &std::path::Path) -> Option<String> {
        for _ in 0..200 {
            if let Ok(s) = std::fs::read_to_string(path) {
                if !s.trim().is_empty() {
                    return Some(s.trim().to_string());
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        None
    }

    #[cfg(unix)]
    #[test]
    fn a_child_that_ignores_sigterm_is_still_killed() {
        // The exact shape of the bug: a process that catches SIGTERM and
        // carries on. It must not survive Stop.
        //
        // The shell reports readiness *after* installing the trap. Signalling
        // the instant spawn returns catches it before that line runs, when
        // SIGTERM still has its default disposition — which tests the opposite
        // of what this is about.
        let ready = marker("ready");
        let script = format!("trap '' TERM; echo up > {}; while :; do sleep 0.2; done", ready.display());
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", &script]);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        own_process_group_std(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sh");
        let pid = child.id();

        assert!(
            await_marker(&ready).is_some(),
            "the child never got as far as installing its trap"
        );
        assert!(alive(pid), "precondition: the child is running");

        let outcome = terminate_tree(pid);
        assert_eq!(
            outcome,
            Outcome::Killed,
            "SIGTERM was ignored, so SIGKILL must have followed"
        );
        let _ = child.wait();
        let _ = std::fs::remove_file(&ready);
        assert!(!alive(pid));
    }

    #[cfg(unix)]
    #[test]
    fn a_guarded_child_is_tracked_until_it_is_disarmed() {
        // The tracking book is what makes quit reach a child nobody dropped.
        let ready = marker("tracked");
        let script = format!("echo up > {}; while :; do sleep 0.2; done", ready.display());
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", &script]);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        own_process_group_std(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sh");
        let pid = child.id();
        assert!(await_marker(&ready).is_some(), "child never started");

        let mut guard = TreeGuard::named(Some(pid), "test child");
        assert!(TRACKED.lock().unwrap().contains_key(&pid), "guarding must track");
        guard.disarm();
        assert!(
            !TRACKED.lock().unwrap().contains_key(&pid),
            "a reaped pid must leave the book — it can be handed to someone else"
        );

        terminate_tree(pid);
        let _ = child.wait();
        let _ = std::fs::remove_file(&ready);
    }

    #[cfg(unix)]
    #[test]
    fn dropping_a_guard_takes_the_group_with_it() {
        let ready = marker("guard");
        let script = format!("echo up > {}; while :; do sleep 0.2; done", ready.display());
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", &script]);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        own_process_group_std(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sh");
        let pid = child.id();
        assert!(await_marker(&ready).is_some(), "child never started");

        drop(TreeGuard::new(Some(pid)));
        let _ = child.wait();
        let _ = std::fs::remove_file(&ready);
        assert!(!alive(pid), "the guard did not reap on drop");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancelled_turn_reaps_without_stalling_the_runtime() {
        // The production drop is an aborted task on a runtime worker. It must
        // still take the group, and it must not hold the worker while it waits
        // out the grace period.
        let ready = marker("cancel");
        let script = format!("echo up > {}; while :; do sleep 0.2; done", ready.display());
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", &script]);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        own_process_group_std(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sh");
        let pid = child.id();
        assert!(await_marker(&ready).is_some(), "child never started");

        let started = std::time::Instant::now();
        drop(TreeGuard::new(Some(pid)));
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "drop blocked the worker instead of handing the wait off"
        );

        let mut gone = false;
        for _ in 0..100 {
            if !alive(pid) {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        let _ = child.wait();
        let _ = std::fs::remove_file(&ready);
        assert!(gone, "a cancelled turn left its child running");
    }

    #[cfg(unix)]
    #[test]
    fn a_disarmed_guard_signals_nothing() {
        // After a child is reaped its pid is free for the kernel to reuse, so
        // a guard that fires late would signal a stranger's process group.
        let ready = marker("disarm");
        let script = format!("echo up > {}; while :; do sleep 0.2; done", ready.display());
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", &script]);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        own_process_group_std(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sh");
        let pid = child.id();
        assert!(await_marker(&ready).is_some(), "child never started");

        let mut guard = TreeGuard::new(Some(pid));
        guard.disarm();
        drop(guard);
        assert!(alive(pid), "a disarmed guard must not signal");

        terminate_tree(pid);
        let _ = child.wait();
        let _ = std::fs::remove_file(&ready);
    }

    #[cfg(unix)]
    #[test]
    fn a_grandchild_dies_with_its_parent() {
        // The orphan QA found was not the process we signalled — it was
        // something that process had started. Killing the group is the only
        // way to reach it.
        let marker = std::env::temp_dir().join(format!(
            "aura-reaper-{}-{}.pid",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let script = format!(
            "sh -c 'while :; do sleep 0.2; done' & echo $! > {}; wait",
            marker.display()
        );
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", &script]);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        own_process_group_std(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sh");
        let parent = child.id();

        // Wait for the grandchild to record its pid.
        let mut grandchild = 0u32;
        for _ in 0..100 {
            if let Ok(s) = std::fs::read_to_string(&marker) {
                if let Ok(p) = s.trim().parse::<u32>() {
                    grandchild = p;
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(grandchild > 0, "grandchild never reported its pid");
        assert!(alive(grandchild), "precondition: the grandchild is running");

        terminate_tree(parent);
        let _ = child.wait();

        // Give the group signal a moment to land on the grandchild.
        let mut still_there = true;
        for _ in 0..50 {
            if !alive(grandchild) {
                still_there = false;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = std::fs::remove_file(&marker);
        assert!(
            !still_there,
            "the grandchild outlived the stop — this is pid 94776 all over again"
        );
    }
}
