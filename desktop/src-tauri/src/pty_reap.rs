//! Tearing down a PTY child so its *work* stops too.
//!
//! Every close path in the app used to do one thing: `child.kill()`, which
//! on unix is `kill(pid, SIGKILL)` aimed at the shell and nothing else. That
//! is the single method guaranteed NOT to clean up after itself, because
//! SIGKILL cannot be caught, so the shell never gets to hang up the jobs it
//! started.
//!
//! And an interactive shell puts every job in its own process group — that is
//! what job control is. So `npm run dev`, a `cargo watch`, a dev server, a
//! test runner: none of them are in the shell's group, none of them are
//! signalled, and all of them are still holding the PTY slave open and the
//! port bound long after the tab is gone. Measured, not assumed: fork a shell
//! on a PTY, background a `sleep`, SIGKILL the shell, and the sleep is still
//! there afterwards, reparented to init.
//!
//! What a terminal emulator actually does when you close a window is hang up
//! the line, and that is what this does:
//!
//!   1. `SIGHUP` to the child's process group. The shell handles it and
//!      forwards it to its jobs, which is the mechanism the whole "closing
//!      the terminal stops what was running in it" contract rests on.
//!   2. A short grace period, then `SIGKILL` to the same group, for anything
//!      that trapped or ignored the hangup.
//!
//! The grace pass runs on a detached thread so no close path waits on it —
//! the tab should disappear the instant it is clicked.
//!
//! On Windows there are no process groups in this sense; `Child::kill` is
//! already the whole story there, so that is what this falls back to.

use portable_pty::Child;

/// How long a process gets to act on the hangup before it is killed
/// outright. Long enough for a shell to signal its jobs and for those to
/// run an exit handler; short enough that nothing observable lingers.
#[cfg(unix)]
const GRACE_MS: u64 = 400;

/// Hang up a PTY child and everything it started, then make sure.
///
/// Best-effort by design: a child that already exited, a pid we cannot
/// read, a group that has gone — none of those are errors the caller can
/// do anything about, and all of them mean the job is done.
pub fn hangup_and_reap(child: &mut (dyn Child + Send + Sync)) {
    let pid = child.process_id();
    #[cfg(unix)]
    {
        if let Some(pid) = pid {
            if hangup_group_unix(pid as i32) {
                return;
            }
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
    // No pid to aim at (or Windows) — the direct kill is all there is.
    let _ = child.kill();
}

/// SIGHUP the child's process group now and SIGKILL it shortly after.
/// Returns false when we could not resolve a group safe to signal, in
/// which case the caller falls back to killing the child directly.
#[cfg(unix)]
fn hangup_group_unix(pid: i32) -> bool {
    // The PTY child is `setsid`-ed at spawn, so it leads its own session
    // and its pgid is normally its own pid. Read it rather than assume:
    // signalling the wrong group is how a bug here takes the whole app
    // down with it.
    let pgid = unsafe { libc::getpgid(pid) };
    let pgid = if pgid > 0 { pgid } else { pid };

    // Refuse to signal a group that isn't safely below us. pgid 1 is init;
    // our own group contains this process, so hanging it up would close the
    // app the moment a user closed a terminal tab.
    let own = unsafe { libc::getpgrp() };
    if pgid <= 1 || pgid == own {
        return false;
    }

    unsafe { libc::killpg(pgid, libc::SIGHUP) };

    // The insurance pass. Detached: closing a tab must not block on a
    // process deciding how to die.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(GRACE_MS));
        // killpg on a group that has fully exited just returns ESRCH.
        unsafe { libc::killpg(pgid, libc::SIGKILL) };
    });
    true
}

#[cfg(test)]
mod tests {
    /// The guard that keeps a bug here from being catastrophic. Our own
    /// process group must never be a legal target — a terminal tab closing
    /// would take the whole app with it.
    #[cfg(unix)]
    #[test]
    fn never_signals_its_own_group() {
        let own = unsafe { libc::getpgrp() };
        assert!(
            !super::hangup_group_unix(std::process::id() as i32),
            "signalling our own group (pgid {own}) must be refused",
        );
    }
}
