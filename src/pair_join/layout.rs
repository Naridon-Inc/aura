//! Where a joined computer keeps its things, decided once.
//!
//! Three shapes, picked by the machine and by who ran `aura join`:
//!
//! * **Linux, as root** (`sudo`, or a root shell on a fresh server) — a system
//!   unit, `aura-computer.service`, with its token in
//!   `/etc/aura-runner/computer.conf`. The same unit name and token path an
//!   Aura-managed computer uses, on purpose: one box is one computer, and a
//!   join that finds a managed computer's token refuses instead of writing over
//!   it. The service never runs as root — Claude Code refuses to run unattended
//!   as root, and an agent with root can read everything on the box. It runs as
//!   the person who typed `sudo`, or, on a box where nobody did, as a dedicated
//!   `aura` account made for it.
//! * **Linux, as a normal user** — a user unit with lingering, so it starts at
//!   boot without anyone logged in, and everything under that user's home.
//! * **macOS** — a LaunchAgent for the signed-in user. Never as root.

use std::path::{Path, PathBuf};

pub const UNIT_NAME: &str = "aura-computer.service";
pub const LAUNCHD_LABEL: &str = "com.auravcs.computer";
/// The account made for a server where nobody but root exists.
pub const SERVICE_ACCOUNT: &str = "aura";
const SERVICE_ACCOUNT_HOME: &str = "/var/lib/aura";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `/etc/systemd/system`, run as a named non-root account.
    SystemdSystem,
    /// `~/.config/systemd/user` with lingering.
    SystemdUser,
    /// `~/Library/LaunchAgents`.
    Launchd,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub kind: Kind,
    /// The token file. 0600. Root's on a system unit, so the agent the service
    /// runs can't read it back.
    pub conf: PathBuf,
    /// What this computer is connected to, minus the token. 0600.
    pub state: PathBuf,
    /// The claims of joins that haven't finished, one file per code.
    pub pending: PathBuf,
    /// The unit file or the LaunchAgent plist.
    pub unit: PathBuf,
    pub log: PathBuf,
    /// Where the service starts, and the parent of `workspaces`.
    pub working_dir: PathBuf,
    /// One checkout per Aura workspace; every member's work stays in its own.
    pub workspaces: PathBuf,
    /// The account the service runs as.
    pub run_as: String,
    /// That account's home — where Claude Code keeps its sign-in.
    pub home: PathBuf,
    /// True when `run_as` is the `aura` account and it doesn't exist yet.
    pub needs_account: bool,
}

impl Layout {
    /// The system unit, run as `run_as`.
    pub fn system(run_as: &str, home: &Path, needs_account: bool) -> Self {
        let etc = PathBuf::from("/etc/aura-runner");
        let lib = PathBuf::from("/var/lib/aura-computer");
        Layout {
            kind: Kind::SystemdSystem,
            conf: etc.join("computer.conf"),
            state: etc.join("computer.json"),
            pending: etc.join("pending"),
            unit: PathBuf::from("/etc/systemd/system").join(UNIT_NAME),
            log: PathBuf::from("/var/log/aura-computer.log"),
            workspaces: lib.join("workspaces"),
            working_dir: lib,
            run_as: run_as.to_string(),
            home: home.to_path_buf(),
            needs_account,
        }
    }

    /// The user unit for `user`, whose home is `home`.
    pub fn user(user: &str, home: &Path) -> Self {
        let mut l = Self::in_home(Kind::SystemdUser, user, home);
        l.unit = home.join(".config/systemd/user").join(UNIT_NAME);
        l.log = home.join(".aura/computer/computer.log");
        l
    }

    /// The LaunchAgent for `user`, whose home is `home`.
    pub fn mac(user: &str, home: &Path) -> Self {
        let mut l = Self::in_home(Kind::Launchd, user, home);
        l.unit = home
            .join("Library/LaunchAgents")
            .join(format!("{LAUNCHD_LABEL}.plist"));
        l.log = home.join("Library/Logs/Aura/computer.log");
        l
    }

    fn in_home(kind: Kind, user: &str, home: &Path) -> Self {
        let conf_dir = home.join(".config/aura");
        let work = home.join(".aura/computer");
        Layout {
            kind,
            conf: conf_dir.join("computer.conf"),
            state: conf_dir.join("computer.json"),
            pending: conf_dir.join("pending"),
            unit: PathBuf::new(),
            log: PathBuf::new(),
            workspaces: work.join("workspaces"),
            working_dir: work,
            run_as: user.to_string(),
            home: home.to_path_buf(),
            needs_account: false,
        }
    }

    /// The unit's description of what it is.
    pub fn describe(&self) -> String {
        match self.kind {
            Kind::SystemdSystem => format!("system service {UNIT_NAME}, running as {}", self.run_as),
            Kind::SystemdUser => format!("user service {UNIT_NAME}"),
            Kind::Launchd => format!("login item {LAUNCHD_LABEL}"),
        }
    }
}

/// The layout for this machine and whoever is running us.
pub fn resolve() -> Result<Layout, String> {
    let root = is_root();
    if cfg!(target_os = "macos") {
        if root {
            return Err(
                "On a Mac, run this without sudo, as the person who uses this computer.".into(),
            );
        }
        let (user, home) = me()?;
        return Ok(Layout::mac(&user, &home));
    }
    if !cfg!(target_os = "linux") {
        return Err("Aura can connect Linux computers and Macs. This one is neither.".into());
    }
    if !Path::new("/run/systemd/system").exists() {
        return Err(
            "This computer doesn't use systemd, so Aura can't keep itself running here. \
             Use a Linux machine with systemd (Ubuntu, Debian, Fedora…) or a Mac."
                .into(),
        );
    }
    if root {
        if let Some(user) = crate::runner_service::sudo_user() {
            let home = crate::runner_service::passwd_home(&user)
                .ok_or_else(|| format!("Couldn't find the home folder of {user}."))?;
            return Ok(Layout::system(&user, &home, false));
        }
        let exists = crate::runner_service::passwd_home(SERVICE_ACCOUNT);
        let home = exists
            .clone()
            .unwrap_or_else(|| PathBuf::from(SERVICE_ACCOUNT_HOME));
        return Ok(Layout::system(SERVICE_ACCOUNT, &home, exists.is_none()));
    }
    let (user, home) = me()?;
    Ok(Layout::user(&user, &home))
}

pub fn is_root() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and cannot fail.
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn me() -> Result<(String, PathBuf), String> {
    let home = std::env::var("HOME")
        .ok()
        .filter(|h| !h.trim().is_empty())
        .map(PathBuf::from)
        .ok_or("HOME isn't set, so there's nowhere to keep this computer's settings.")?;
    let user = std::env::var("USER")
        .ok()
        .filter(|u| !u.trim().is_empty())
        .or_else(|| {
            std::process::Command::new("id")
                .arg("-un")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|u| !u.is_empty())
        })
        .ok_or("Couldn't tell which account this is.")?;
    Ok((user, home))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_system_computer_keeps_its_token_where_a_managed_one_does() {
        let l = Layout::system("sam", Path::new("/home/sam"), false);
        assert_eq!(l.conf, PathBuf::from("/etc/aura-runner/computer.conf"));
        assert_eq!(l.unit, PathBuf::from("/etc/systemd/system/aura-computer.service"));
        assert_eq!(l.run_as, "sam");
        assert!(l.workspaces.starts_with(&l.working_dir));
        assert!(!l.conf.starts_with(&l.home), "the agent's home never holds the token");
    }

    #[test]
    fn a_user_computer_lives_in_its_home() {
        let l = Layout::user("sam", Path::new("/home/sam"));
        assert_eq!(l.kind, Kind::SystemdUser);
        for p in [&l.conf, &l.state, &l.pending, &l.unit, &l.log, &l.workspaces] {
            assert!(p.starts_with("/home/sam"), "{} is outside the home", p.display());
        }
        assert_eq!(l.unit, PathBuf::from("/home/sam/.config/systemd/user/aura-computer.service"));
    }

    #[test]
    fn a_mac_uses_a_launch_agent() {
        let l = Layout::mac("sam", Path::new("/Users/sam"));
        assert_eq!(l.kind, Kind::Launchd);
        assert_eq!(l.unit, PathBuf::from("/Users/sam/Library/LaunchAgents/com.auravcs.computer.plist"));
        assert!(l.log.starts_with("/Users/sam/Library/Logs"));
    }
}
