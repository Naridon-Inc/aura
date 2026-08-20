//! The discovery half of the handshake: `~/.claude/ide/<port>.lock`.
//!
//! Agent CLIs don't get told where Aura is — they *find* it. Claude Code
//! lists every `*.lock` in this directory newest-first, reads the JSON, and
//! connects to whichever one matches the project it was launched in. The
//! port is not in the file: it is the **filename**. Getting that wrong means
//! the CLI dials port 0 and silently never attaches.
//!
//! The directory is shared with VS Code and the JetBrains plugin, so we only
//! ever touch the one file we wrote.
//!
//! ## Why `pid` matters
//!
//! The CLI reaps lock files whose `pid` is no longer alive — that's how a
//! crashed IDE stops advertising a dead port. So `pid` must be this
//! process's, and the file must be removed on a clean exit. It also gates
//! auto-connect: a lock whose pid isn't an ancestor of the CLI is ignored
//! unless `CLAUDE_CODE_SSE_PORT` names its port, which is exactly why the
//! spawn sites set that variable.

use std::io;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::protocol::IDE_NAME;

/// `~/.claude/ide`. Fixed by the CLI — not configurable, not ours to move.
pub fn lock_dir() -> PathBuf {
    let mut p = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push(".claude");
    p.push("ide");
    p
}

/// The one file this process owns. The port lives here and nowhere else.
pub fn lock_path(port: u16) -> PathBuf {
    lock_dir().join(format!("{port}.lock"))
}

/// The JSON body. Split out from [`write`] so the shape can be asserted
/// without touching the real `~/.claude` of whoever runs the tests.
///
/// `transport: "ws"` is what selects the WebSocket dialer; without it the
/// CLI would try `http://host:port/sse` instead and get nothing.
pub fn lock_body(pid: u32, workspace_folders: &[String], auth_token: &str) -> Value {
    json!({
        "pid": pid,
        "workspaceFolders": workspace_folders,
        "ideName": IDE_NAME,
        "transport": "ws",
        "runningInWindows": cfg!(target_os = "windows"),
        "authToken": auth_token,
    })
}

/// Publish this process as an available IDE. Returns the path written so the
/// caller can hand it straight to [`remove_at`] on shutdown rather than
/// rebuilding it from a port it might have since forgotten.
pub fn write(port: u16, workspace_folders: &[String], auth_token: &str) -> io::Result<PathBuf> {
    let dir = lock_dir();
    std::fs::create_dir_all(&dir)?;
    let path = lock_path(port);
    let body = lock_body(std::process::id(), workspace_folders, auth_token);
    std::fs::write(&path, serde_json::to_vec(&body)?)?;
    restrict(&path);
    Ok(path)
}

/// Rewrite the body in place, keeping the same port/filename. Used when the
/// set of open projects changes — a stale `workspaceFolders` would make the
/// CLI decide Aura isn't the IDE for the repo it was launched in.
pub fn rewrite(path: &Path, workspace_folders: &[String], auth_token: &str) -> io::Result<()> {
    let body = lock_body(std::process::id(), workspace_folders, auth_token);
    std::fs::write(path, serde_json::to_vec(&body)?)?;
    restrict(path);
    Ok(())
}

/// Stop advertising. Best-effort: if this fails the CLI's own reaper clears
/// the file once it notices our pid is gone.
pub fn remove_at(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// The token in this file is a bearer capability for a loopback port, so
/// keep it off other accounts on a shared machine. Best-effort — a failure
/// here is not a reason to refuse to serve.
#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_lives_in_the_filename_not_the_body() {
        // The CLI parses the port out of `<port>.lock`. A body field would
        // be ignored, and a differently-named file would send it to the
        // wrong port entirely.
        let p = lock_path(51234);
        assert_eq!(p.file_name().unwrap(), "51234.lock");
        assert!(lock_body(1, &[], "t").get("port").is_none());
    }

    #[test]
    fn lock_dir_is_the_well_known_claude_path() {
        let d = lock_dir();
        assert!(d.ends_with("ide"));
        assert!(d.parent().unwrap().ends_with(".claude"));
    }

    #[test]
    fn body_selects_the_websocket_dialer() {
        let b = lock_body(99, &["/repo".into()], "secret");
        assert_eq!(b["transport"], "ws");
        assert_eq!(b["pid"], 99);
        assert_eq!(b["ideName"], "Aura");
        assert_eq!(b["authToken"], "secret");
        assert_eq!(b["workspaceFolders"][0], "/repo");
    }

    #[test]
    fn body_reports_a_live_pid_so_the_reaper_leaves_it_alone() {
        // Written with this process's id: the CLI unlinks any lock whose pid
        // is dead, so a placeholder here would delete us mid-session.
        let b = lock_body(std::process::id(), &[], "t");
        assert_eq!(b["pid"], std::process::id());
    }

    #[test]
    fn workspace_folders_serialise_as_a_plain_array() {
        // The CLI matches the CLI's cwd against these with a prefix test; a
        // nested or object-wrapped shape reads as "no folders" and the lock
        // is treated as belonging to another project.
        let b = lock_body(1, &["/a".into(), "/b".into()], "t");
        assert_eq!(b["workspaceFolders"], json!(["/a", "/b"]));
    }
}
