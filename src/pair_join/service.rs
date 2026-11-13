//! Keep Aura running on a joined computer: through reboots, logouts and
//! crashes, without a terminal left open.
//!
//! On Linux the unit is rendered by [`crate::runner_service::render_unit`] —
//! the same template, `UMask=0077` and restart policy as every other runner —
//! under its own name, `aura-computer.service`. On a Mac it is a LaunchAgent
//! ([`super::launchd`]).

use std::path::{Path, PathBuf};

use super::layout::{Kind, Layout, SERVICE_ACCOUNT, UNIT_NAME};
use crate::runner_service::{self, Scope, UnitSpec};

/// What the service runs: every project's cloud work and chats, with Claude
/// Code as the agent.
pub const SERVE_ARGS: &[&str] = &["--all-projects", "--agent", "claude"];

/// The `PATH` the service runs with — where Claude Code and the tools it calls
/// are installed, which is not where a service looks by default.
pub fn service_path(l: &Layout) -> String {
    match l.kind {
        Kind::Launchd => {
            let h = l.home.display();
            format!(
                "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\
                 {h}/.local/bin:{h}/.claude/local:{h}/.npm-global/bin:{h}/.cargo/bin"
            )
        }
        _ => runner_service::service_path(&l.home),
    }
}

/// True when the service will find Claude Code.
pub fn agent_ready(l: &Layout) -> bool {
    service_path(l)
        .split(':')
        .any(|dir| Path::new(dir).join("claude").is_file())
}

/// The systemd unit for this layout.
pub fn unit_text(l: &Layout, bin: &Path, name: &str) -> String {
    let spec = UnitSpec {
        scope: match l.kind {
            Kind::SystemdSystem => Scope::System,
            _ => Scope::User,
        },
        bin: bin.to_path_buf(),
        user: l.run_as.clone(),
        // `%` starts a systemd specifier; a computer's name has no business
        // expanding into anything.
        name: name.replace('%', ""),
        env_file: l.conf.clone(),
        agent_env_file: None,
        log_file: l.log.clone(),
        working_dir: l.working_dir.clone(),
        path: service_path(l),
        serve_args: SERVE_ARGS.iter().map(|s| s.to_string()).collect(),
        cpu_quota: None,
        memory_max: None,
        memory_swap_max: None,
        tasks_max: None,
        max_file_size: None,
    };
    runner_service::render_unit(&spec)
}

/// Make the account the service runs as, on a server where only root exists.
/// A system account: no password, so nobody logs in as it; a shell, because
/// the tools an agent runs expect one.
pub fn ensure_account(l: &Layout) -> Result<(), String> {
    if !l.needs_account || ids(&l.run_as).is_some() {
        return Ok(());
    }
    let home = l.home.display().to_string();
    runner_service::run(
        "useradd",
        &["--system", "--user-group", "--create-home", "--home-dir", &home, "--shell", "/bin/bash", SERVICE_ACCOUNT],
    )
    .map_err(|e| format!("couldn't make the '{SERVICE_ACCOUNT}' account to run Aura as: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&l.home, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// The account's uid and gid.
pub fn ids(user: &str) -> Option<(u32, u32)> {
    #[cfg(unix)]
    {
        let c = std::ffi::CString::new(user).ok()?;
        // SAFETY: `c` is a valid NUL-terminated string that outlives the call,
        // and the record is copied out before anything else touches passwd.
        let pw = unsafe { libc::getpwnam(c.as_ptr()) };
        if pw.is_null() {
            return None;
        }
        // SAFETY: non-null, just returned by getpwnam.
        unsafe { Some(((*pw).pw_uid, (*pw).pw_gid)) }
    }
    #[cfg(not(unix))]
    {
        let _ = user;
        None
    }
}

/// The folders the service works in, and its log, made and handed to the
/// account it runs as — closed to every other account on the box.
pub fn prepare(l: &Layout) -> Result<(), String> {
    let owner = match l.kind {
        Kind::SystemdSystem => Some(
            ids(&l.run_as).ok_or_else(|| format!("there's no account called {}", l.run_as))?,
        ),
        _ => None,
    };
    super::conf::private_dir(&l.working_dir, owner)?;
    super::conf::private_dir(&l.workspaces, owner)?;
    if let Some(dir) = l.log.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("couldn't make {}: {e}", dir.display()))?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(&l.log)
        .map_err(|e| format!("couldn't make {}: {e}", l.log.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&l.log, std::fs::Permissions::from_mode(0o600));
    }
    if let Some((uid, gid)) = owner {
        super::conf::chown(&l.log, uid, gid)?;
    }
    Ok(())
}

/// Install (or rewrite) the service and (re)start it, so a new token takes
/// effect. Returns things worth telling the person that didn't stop it.
pub fn install(l: &Layout, bin: &Path, name: &str) -> Result<Vec<String>, String> {
    match l.kind {
        Kind::Launchd => super::launchd::install(l, bin, &service_path(l)).map(|_| Vec::new()),
        Kind::SystemdSystem | Kind::SystemdUser => install_systemd(l, bin, name),
    }
}

fn install_systemd(l: &Layout, bin: &Path, name: &str) -> Result<Vec<String>, String> {
    let scope = scope(l);
    let mut notes = Vec::new();
    if let Some(dir) = l.unit.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("couldn't make {}: {e}", dir.display()))?;
    }
    std::fs::write(&l.unit, unit_text(l, bin, name))
        .map_err(|e| format!("couldn't write {}: {e}", l.unit.display()))?;
    if scope == Scope::User {
        // Without lingering a user service stops at logout and never starts at
        // boot — "connected" would mean "while someone is logged in".
        if runner_service::linger(&l.run_as).is_err() {
            notes.push(
                "Aura will stop when you log out of this computer. To keep it running, \
                 run the same line with sudo."
                    .to_string(),
            );
        }
    }
    runner_service::systemctl(scope, &["daemon-reload"])?;
    runner_service::systemctl(scope, &["enable", UNIT_NAME])?;
    runner_service::systemctl(scope, &["restart", UNIT_NAME])?;
    Ok(notes)
}

/// Stop the service and remove it. Missing is fine — the point is that it's
/// not running.
pub fn remove(l: &Layout) -> Result<(), String> {
    match l.kind {
        Kind::Launchd => super::launchd::remove(l),
        Kind::SystemdSystem | Kind::SystemdUser => {
            let scope = scope(l);
            let _ = runner_service::systemctl(scope, &["disable", "--now", UNIT_NAME]);
            remove_file(&l.unit)?;
            let _ = runner_service::systemctl(scope, &["daemon-reload"]);
            Ok(())
        }
    }
}

fn scope(l: &Layout) -> Scope {
    if l.kind == Kind::SystemdSystem {
        Scope::System
    } else {
        Scope::User
    }
}

pub fn remove_file(path: &PathBuf) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("couldn't remove {}: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_system_computer_runs_as_its_person_reads_root_s_token_and_never_runs_as_root() {
        let l = Layout::system("sam", Path::new("/home/sam"), false);
        let u = unit_text(&l, Path::new("/usr/local/bin/aura"), "build box");
        assert!(u.contains("User=sam\n"));
        assert!(!u.contains("User=root"));
        assert!(u.contains("EnvironmentFile=/etc/aura-runner/computer.conf\n"));
        assert!(u.contains("ExecStart=/usr/local/bin/aura runner serve --all-projects --agent claude\n"));
        assert!(u.contains("UMask=0077\n"));
        assert!(u.contains("Restart=always\n"));
        assert!(u.contains("WorkingDirectory=/var/lib/aura-computer\n"));
        assert!(u.contains("WantedBy=multi-user.target\n"));
        assert!(u.contains("/home/sam/.local/bin"), "Claude Code's own install folder is on the PATH");
    }

    #[test]
    fn a_user_computer_is_a_user_unit() {
        let l = Layout::user("sam", Path::new("/home/sam"));
        let u = unit_text(&l, Path::new("/home/sam/.local/bin/aura"), "laptop");
        assert!(!u.contains("User="));
        assert!(u.contains("EnvironmentFile=/home/sam/.config/aura/computer.conf\n"));
        assert!(u.contains("WantedBy=default.target\n"));
    }

    #[test]
    fn a_name_cannot_smuggle_a_specifier_into_the_unit() {
        let l = Layout::user("sam", Path::new("/home/sam"));
        let u = unit_text(&l, Path::new("/usr/bin/aura"), "box %h %u");
        let desc = u.lines().find(|l| l.starts_with("Description=")).unwrap();
        assert!(!desc.contains('%'));
    }

    #[test]
    fn a_mac_looks_for_claude_where_people_install_it() {
        let l = Layout::mac("sam", Path::new("/Users/sam"));
        let p = service_path(&l);
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/Users/sam/.local/bin", "/Users/sam/.claude/local"] {
            assert!(p.split(':').any(|d| d == dir), "{dir} missing from {p}");
        }
    }

    #[test]
    fn the_folders_and_log_are_closed_to_everyone_else() {
        let dir = tempfile::tempdir().unwrap();
        let l = Layout::user("sam", dir.path());
        prepare(&l).unwrap();
        prepare(&l).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&l.workspaces), 0o700);
            assert_eq!(mode(&l.working_dir), 0o700);
            assert_eq!(mode(&l.log), 0o600);
        }
    }
}
