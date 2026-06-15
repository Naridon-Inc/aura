//! Install a user-level background unit that keeps the Aura sync daemon
//! running across logins. macOS → launchd, Linux → systemd --user,
//! fallback → nohup. Best-effort; failures are reported but non-fatal
//! because the CLI itself remains usable without the daemon.

use std::path::PathBuf;

const LABEL: &str = "com.auravcs.daemon";

/// Install and load the background unit. Returns a human description of
/// the path taken so `aura connect` can show the user what happened.
pub fn install() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("locate aura binary: {}", e))?;

    #[cfg(target_os = "macos")]
    {
        return install_launchd(&exe);
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(desc) = install_systemd_user(&exe) {
            return Ok(desc);
        }
        return spawn_nohup(&exe).map(|p| format!("nohup daemon (pid {})", p));
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        spawn_nohup(&exe).map(|p| format!("nohup daemon (pid {})", p))
    }
}

#[cfg(target_os = "macos")]
fn install_launchd(exe: &std::path::Path) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME unset".to_string())?;
    let dir = PathBuf::from(&home).join("Library/LaunchAgents");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir LaunchAgents: {}", e))?;
    let plist_path = dir.join(format!("{}.plist", LABEL));

    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{home}/.aura/daemon.out.log</string>
  <key>StandardErrorPath</key><string>{home}/.aura/daemon.err.log</string>
</dict>
</plist>
"#,
        label = LABEL,
        exe = exe.display(),
        home = home,
    );

    std::fs::write(&plist_path, plist).map_err(|e| format!("write plist: {}", e))?;

    // Best-effort load. `launchctl bootstrap gui/<uid>` is the modern form,
    // but `launchctl load -w` is broadly compatible.
    let _ = std::process::Command::new("launchctl")
        .args(["unload", plist_path.to_string_lossy().as_ref()])
        .status();
    let loaded = std::process::Command::new("launchctl")
        .args(["load", "-w", plist_path.to_string_lossy().as_ref()])
        .status();

    match loaded {
        Ok(s) if s.success() => Ok(format!("launchd unit {}", plist_path.display())),
        _ => {
            // Plist is in place; next login will pick it up.
            Ok(format!(
                "launchd plist staged at {} (loads at next login)",
                plist_path.display()
            ))
        }
    }
}

#[cfg(target_os = "linux")]
fn install_systemd_user(exe: &std::path::Path) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME unset".to_string())?;
    let dir = PathBuf::from(&home).join(".config/systemd/user");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir systemd user: {}", e))?;
    let unit_path = dir.join("aura-daemon.service");

    let unit = format!(
        "[Unit]\n\
         Description=Aura sync daemon\n\
         After=network-online.target\n\
         \n\
         [Service]\n\
         ExecStart={} daemon\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         StandardOutput=append:{}/.aura/daemon.out.log\n\
         StandardError=append:{}/.aura/daemon.err.log\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        exe.display(), home, home,
    );

    std::fs::write(&unit_path, unit).map_err(|e| format!("write unit: {}", e))?;

    let _ = std::process::Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status();
    let started = std::process::Command::new("systemctl")
        .args(["--user", "enable", "--now", "aura-daemon.service"])
        .status();

    match started {
        Ok(s) if s.success() => Ok(format!("systemd --user unit {}", unit_path.display())),
        _ => Err("systemctl --user enable failed".into()),
    }
}

#[allow(dead_code)]
fn spawn_nohup(exe: &std::path::Path) -> Result<u32, String> {
    use std::process::Stdio;
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let log_dir = PathBuf::from(&home).join(".aura");
    let _ = std::fs::create_dir_all(&log_dir);
    let out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("daemon.out.log"))
        .map_err(|e| format!("log: {}", e))?;
    let err = out.try_clone().map_err(|e| format!("dup log: {}", e))?;
    let child = std::process::Command::new(exe)
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .spawn()
        .map_err(|e| format!("spawn daemon: {}", e))?;
    Ok(child.id())
}
