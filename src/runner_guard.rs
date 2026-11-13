//! Keeping the box's own credential out of the agent's reach.
//!
//! A computer answers chats by running an agent with every permission on the
//! member's checkout. Whatever that agent can read, a prompt can ask it to
//! print, and a repository can ask it to print too (a README, an issue body,
//! a test fixture written to be read by agents). The runner holds one secret
//! the agent never needs: `AURA_RUNNER_TOKEN`, the machine's own credential,
//! which reads every chat routed to this computer for the whole org.
//!
//! Two things keep it away:
//!
//!   * the agent is started without it ([`withhold`]); the turn process that
//!     starts the agent keeps it, because it is the one that reports back and
//!     pushes the branch;
//!   * on Linux, the runner and each turn mark themselves non-dumpable
//!     ([`seal_process`]), so `/proc/<pid>/environ` and `/proc/<pid>/mem` of
//!     the process holding the token are owned by root rather than by the
//!     login the agent runs as. Without this a child could read its parent's
//!     environment back through `/proc` even after being started without it.
//!
//! What this does not do: a login that can `sudo` reaches everything on the
//! machine regardless. On a shared computer, isolating members from one
//! another needs a unix user per member; this closes the paths open to an
//! agent that has no root.

use std::process::Command;

/// Variables the runner holds for itself and never passes to an agent.
pub const RUNNER_ONLY_ENV: &[&str] = &["AURA_RUNNER_TOKEN"];

/// Start `cmd` without the runner's own credentials.
pub fn withhold(cmd: &mut Command) {
    for name in RUNNER_ONLY_ENV {
        cmd.env_remove(name);
    }
}

/// Make this process's memory and environment unreadable to other processes
/// of the same login (Linux only; a no-op elsewhere). Exec resets the flag,
/// so children start ordinary; it only protects the process that calls it.
#[cfg(target_os = "linux")]
pub fn seal_process() {
    // SAFETY: prctl(PR_SET_DUMPABLE, 0) only flips a flag on the calling
    // process; it takes no pointers.
    unsafe {
        libc::prctl(libc::PR_SET_DUMPABLE, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong);
    }
}

/// See the Linux version; other systems have no `/proc` to close.
#[cfg(not(target_os = "linux"))]
pub fn seal_process() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_agent_starts_without_the_runner_token() {
        let mut cmd = Command::new("claude");
        cmd.env("AURA_RUNNER_TOKEN", "aura_runner_x");
        withhold(&mut cmd);
        let set: Vec<_> = cmd.get_envs().filter(|(k, _)| *k == "AURA_RUNNER_TOKEN").collect();
        assert_eq!(set.len(), 1);
        assert!(set[0].1.is_none(), "the token must be removed, not passed");
    }

    #[test]
    fn sealing_leaves_the_process_working() {
        seal_process();
        assert!(std::env::current_exe().is_ok(), "the process can still find itself");
        assert!(!dumpable(), "the process must no longer be dumpable");
    }

    #[cfg(target_os = "linux")]
    fn dumpable() -> bool {
        // SAFETY: reads a flag on the calling process.
        unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) != 0 }
    }

    #[cfg(not(target_os = "linux"))]
    fn dumpable() -> bool {
        false
    }
}
