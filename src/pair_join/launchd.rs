//! The Mac half of keeping Aura running: a LaunchAgent in the signed-in
//! user's session, started at login and restarted if it stops.
//!
//! launchd has no `EnvironmentFile=`, so the agent starts `/bin/sh`, which
//! reads the token file into the environment and replaces itself with
//! `aura runner serve`. The token never appears in the plist, in `ps`, or on
//! a command line — only in the `0600` file and the process's environment.

use std::path::Path;
use std::time::Duration;

use super::layout::{Layout, LAUNCHD_LABEL};
use super::service::SERVE_ARGS;

/// The script the agent starts. `$0` is the token file and `$1` the binary,
/// passed as separate arguments so neither is ever parsed as shell; the serve
/// flags are fixed words.
fn launcher() -> String {
    format!(r#"set -a; . "$0"; set +a; exec "$1" runner serve {}"#, SERVE_ARGS.join(" "))
}

pub fn plist_text(l: &Layout, bin: &Path, path: &str) -> String {
    let args = [
        "/bin/sh".to_string(),
        "-c".to_string(),
        launcher(),
        l.conf.display().to_string(),
        bin.display().to_string(),
    ];
    let program_args: String = args
        .iter()
        .map(|a| format!("        <string>{}</string>\n", xml(a)))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
{program_args}    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{path}</string>
        <key>HOME</key>
        <string>{home}</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>{work}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>15</integer>
    <key>Nice</key>
    <integer>5</integer>
    <key>Umask</key>
    <integer>63</integer>
    <key>StandardOutPath</key>
    <string>{log}</string>
    <key>StandardErrorPath</key>
    <string>{log}</string>
</dict>
</plist>
"#,
        label = LAUNCHD_LABEL,
        path = xml(path),
        home = xml(&l.home.display().to_string()),
        work = xml(&l.working_dir.display().to_string()),
        log = xml(&l.log.display().to_string()),
    )
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn domain() -> String {
    #[cfg(unix)]
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    #[cfg(not(unix))]
    let uid = 0;
    format!("gui/{uid}")
}

pub fn install(l: &Layout, bin: &Path, path: &str) -> Result<(), String> {
    if let Some(dir) = l.unit.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("couldn't make {}: {e}", dir.display()))?;
    }
    std::fs::write(&l.unit, plist_text(l, bin, path))
        .map_err(|e| format!("couldn't write {}: {e}", l.unit.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&l.unit, std::fs::Permissions::from_mode(0o644));
    }
    let domain = domain();
    let target = format!("{domain}/{LAUNCHD_LABEL}");
    let plist = l.unit.display().to_string();
    // Unload the old one first so the new token is what runs. launchd can take
    // a moment to let go of it, during which a bootstrap fails; try again
    // briefly rather than report a failure that fixes itself.
    let _ = crate::runner_service::run("launchctl", &["bootout", &target]);
    let _ = crate::runner_service::run("launchctl", &["enable", &target]);
    let mut last = String::new();
    for _ in 0..10 {
        match crate::runner_service::run("launchctl", &["bootstrap", &domain, &plist]) {
            Ok(()) => return Ok(()),
            Err(e) => last = e,
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Err(last)
}

pub fn remove(l: &Layout) -> Result<(), String> {
    let target = format!("{}/{LAUNCHD_LABEL}", domain());
    let _ = crate::runner_service::run("launchctl", &["bootout", &target]);
    super::service::remove_file(&l.unit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plist_keeps_aura_running_without_the_token_in_it() {
        let l = Layout::mac("sam", Path::new("/Users/sam"));
        let p = plist_text(&l, Path::new("/Users/sam/.local/bin/aura"), "/usr/bin:/bin");
        assert!(p.contains("<string>com.auravcs.computer</string>"));
        assert!(p.contains("<key>KeepAlive</key>\n    <true/>"));
        assert!(p.contains("<key>RunAtLoad</key>\n    <true/>"));
        assert!(p.contains("<string>/Users/sam/.config/aura/computer.conf</string>"));
        assert!(p.contains("runner serve --all-projects --agent claude"));
        assert!(!p.contains("aura_runner_"));
        assert!(p.contains("<integer>63</integer>"), "umask 077");
    }

    #[test]
    fn a_folder_name_cannot_break_out_of_the_plist() {
        let l = Layout::mac("sam", Path::new("/Users/a&b<c>"));
        let p = plist_text(&l, Path::new("/x/aura"), "/usr/bin");
        assert!(p.contains("/Users/a&amp;b&lt;c&gt;"));
        assert!(!p.contains("a&b<c>"));
    }
}
