//! Claude Code, for the account Aura runs as on a joined computer.
//!
//! A computer with Aura and no agent is connected and useless: every prompt a
//! member sends it fails at the first step. So a join that finds Claude Code
//! missing installs it with Anthropic's own installer, into the home of the
//! account the service runs as — on a server joined with sudo that is the
//! member's account or the `aura` account, never root's.
//!
//! Nothing is signed in here. Each chat fetches the member's own sign-in from
//! Aura when it starts, so the install needs no key and leaves none behind.
//!
//! `AURA_JOIN_NO_AGENT=1` skips it, for a computer whose owner installs their
//! tools some other way.

use std::process::{Command, Stdio};

use super::layout::{self, Layout};
use super::service;

/// Anthropic's installer for Claude Code. It installs to `~/.local/bin`, which
/// is on the service's `PATH`.
pub const INSTALLER: &str = "https://claude.ai/install.sh";

/// Env var that turns the install off.
pub const SKIP_ENV: &str = "AURA_JOIN_NO_AGENT";

/// What happened when the join looked for Claude Code.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// It was already there.
    Present,
    /// It wasn't, and now it is.
    Installed,
    /// It isn't, and this is why.
    Missing(String),
}

/// Make sure the service will find Claude Code, installing it when it won't.
pub fn ensure(l: &Layout) -> Outcome {
    if service::agent_ready(l) {
        return Outcome::Present;
    }
    if std::env::var(SKIP_ENV).is_ok_and(|v| !v.trim().is_empty() && v.trim() != "0") {
        return Outcome::Missing(format!("{SKIP_ENV} is set, so it wasn't installed."));
    }
    for tool in ["bash", "curl"] {
        if !on_path(tool) {
            return Outcome::Missing(format!("{tool} is needed to install it."));
        }
    }
    eprintln!("Installing Claude Code for {}…", l.run_as);
    let out = match install_command(l, layout::is_root()).stdin(Stdio::null()).output() {
        Ok(o) => o,
        Err(e) => return Outcome::Missing(format!("its installer didn't start: {e}")),
    };
    if out.status.success() && service::agent_ready(l) {
        return Outcome::Installed;
    }
    let said = String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr })
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("no reason given")
        .to_string();
    Outcome::Missing(format!("its installer failed: {said}"))
}

/// The installer, run as `l.run_as` in `l.home`. Root hands it to that account
/// with `runuser`, so nothing it writes ends up owned by root; anyone else is
/// already that account.
fn install_command(l: &Layout, root: bool) -> Command {
    let script = format!("cd \"$HOME\" && curl -fsSL {INSTALLER} | bash");
    let mut cmd = if root {
        let mut c = Command::new("runuser");
        c.args(["-u", &l.run_as, "--", "env"])
            .arg(format!("HOME={}", l.home.display()))
            .arg(format!("PATH={}", service::service_path(l)))
            .args(["bash", "-c", &script]);
        c
    } else {
        let mut c = Command::new("bash");
        c.args(["-c", &script]).env("HOME", &l.home);
        c
    };
    cmd.current_dir("/");
    cmd
}

fn on_path(tool: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(tool).is_file()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn argv(c: &Command) -> Vec<String> {
        std::iter::once(c.get_program())
            .chain(c.get_args())
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn a_server_joined_with_sudo_installs_it_for_the_account_aura_runs_as() {
        let l = Layout::system("sam", Path::new("/home/sam"), false);
        let a = argv(&install_command(&l, true));
        assert_eq!(&a[..5], ["runuser", "-u", "sam", "--", "env"]);
        assert!(a.contains(&"HOME=/home/sam".to_string()));
        assert!(a.last().unwrap().contains("curl -fsSL https://claude.ai/install.sh | bash"));
    }

    #[test]
    fn a_member_on_their_own_account_installs_it_as_themselves() {
        let l = Layout::user("sam", Path::new("/home/sam"));
        let c = install_command(&l, false);
        assert_eq!(argv(&c)[..2], ["bash", "-c"]);
        let home = c.get_envs().find(|(k, _)| *k == "HOME").and_then(|(_, v)| v);
        assert_eq!(home, Some(std::ffi::OsStr::new("/home/sam")));
    }
}
