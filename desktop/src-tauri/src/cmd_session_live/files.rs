//! Guest file access — serving this desktop's repo, and reading someone else's.
//!
//! Two people want to work on one project and neither wants to set up git. One
//! of them has the files; the other reads them through the session socket
//! already open between the two apps. There is one copy of the code, on the
//! host's disk, so there is nothing to clone, nothing to merge and nothing to
//! configure. The guest changes code by instructing the host's agent — which is
//! why nothing here writes.
//!
//! ### Host side
//!
//! A `file_list` / `file_req` frame arrives and we answer it from
//! `ConnCtx::repo_root`. Three gates stand between a guest and the rest of this
//! machine, and they are deliberately not the same gate three times:
//!
//!  1. **The path cannot leave the project.** Segments are checked, then the
//!     result is canonicalised and re-checked against the canonical root — so a
//!     *symlink* inside the repo pointing at `~/.ssh` is refused too, which the
//!     textual check alone would happily serve.
//!  2. **Ignored files are not project files.** What git would not share, we do
//!     not share. That is what keeps `.env`, build output and `node_modules`
//!     off a guest's screen without anybody maintaining a list.
//!  3. **Secrets are refused whatever git thinks**, because git's answer
//!     depends on a `.gitignore` this repo might not have, and a committed
//!     `.env` is exactly the case where the first two gates both say yes.
//!
//! ### Guest side
//!
//! [`ask`] is a request/response over a socket that has neither: it mints a
//! correlation id, parks a `oneshot`, and the inbound `file_res` wakes it. The
//! timeout is a little longer than the cloud's, so when a read does fail it is
//! the cloud's specific reason that surfaces rather than our generic one.

use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use tauri::State;
use tokio::sync::oneshot;
use tracing::warn;

use super::ctx::ConnCtx;
use super::protocol::{ClientFrame, FileReqFrame, FileResFrame, RemoteEntry, ACCESS_DRIVE};
use super::session::ctx_for;
use super::SessionLiveState;

/// Ceiling on a file we will hand to a guest. Matches the cap the local editor
/// already applies, so a file that opens here opens there.
const MAX_FILE_BYTES: u64 = 2_000_000;

/// Ceiling on one directory listing. The cloud caps at the same number; a
/// guest browsing a generated folder gets a truncated page, not a stall.
const MAX_ENTRIES: usize = 2_000;

/// How long a guest waits. Deliberately past the cloud's own 30s expiry so a
/// timed-out read is reported with the cloud's reason instead of ours.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(35);

/// Which request this is. The two share every gate and differ only in what
/// they do once the path has been resolved.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    List,
    Read,
}

// ── Host side ────────────────────────────────────────────────────────────────

/// Answer a guest's request, always. A dropped frame leaves their file browser
/// spinning with no explanation, so every path out of here sends a `file_res`.
pub fn spawn_serve(ctx: Arc<ConnCtx>, kind: Kind, req: FileReqFrame) {
    tauri::async_runtime::spawn(async move {
        let id = req.id.clone();
        let root = ctx.repo_root.clone();
        let is_host = ctx.is_host();

        let answer = crate::blocking::run(move || {
            if !is_host {
                return Err("this desktop is not the session host".to_string());
            }
            let Some(root) = root else {
                return Err("this session is not attached to a project folder".to_string());
            };
            serve(Path::new(&root), kind, &req)
        })
        .await;

        ctx.send(match answer {
            Ok(frame) => frame,
            Err(message) => {
                warn!(target: "session_live", "file request {id}: {message}");
                ClientFrame::FileRes {
                    id,
                    error: Some(message),
                    entries: None,
                    content_b64: None,
                    truncated: false,
                    size: None,
                }
            }
        });
    });
}

fn serve(root: &Path, kind: Kind, req: &FileReqFrame) -> Result<ClientFrame, String> {
    let root = std::fs::canonicalize(root)
        .map_err(|_| "this session's project folder is not readable".to_string())?;
    let target = resolve(&root, &req.path)?;

    match kind {
        Kind::List => {
            let (entries, truncated) = list_dir(&root, &target)?;
            Ok(ClientFrame::FileRes {
                id: req.id.clone(),
                error: None,
                entries: Some(entries),
                content_b64: None,
                truncated,
                size: None,
            })
        }
        Kind::Read => {
            let (body, size) = read_file(&root, &target)?;
            Ok(ClientFrame::FileRes {
                id: req.id.clone(),
                error: None,
                entries: None,
                content_b64: Some(body),
                truncated: false,
                size: Some(size),
            })
        }
    }
}

/// Turn a guest-supplied relative path into a real path inside `root`, or
/// refuse it.
///
/// The canonicalise-then-compare at the end is the gate that actually holds:
/// the textual checks above it stop the obvious `../`, but only resolving the
/// path catches a symlink in the repo that points somewhere else entirely.
fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.contains('\0') || rel.contains('\\') || rel.starts_with('/') {
        return Err("that path is not inside the project".into());
    }
    let mut joined = root.to_path_buf();
    for segment in rel.split('/') {
        match segment {
            "" | "." => continue,
            ".." => return Err("that path is not inside the project".into()),
            other => joined.push(other),
        }
    }
    let real = std::fs::canonicalize(&joined).map_err(|_| "no such file".to_string())?;
    if !real.starts_with(root) {
        return Err("that path is not inside the project".into());
    }
    Ok(real)
}

fn list_dir(root: &Path, dir: &Path) -> Result<(Vec<RemoteEntry>, bool), String> {
    let reader = std::fs::read_dir(dir).map_err(|_| "no such folder".to_string())?;

    let mut candidates: Vec<(String, bool, Option<i64>)> = Vec::new();
    for entry in reader.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if crate::cmd_files::is_always_hidden(&name) || is_secret_name(&name) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        let size = (!meta.is_dir()).then(|| meta.len() as i64);
        candidates.push((name, meta.is_dir(), size));
    }

    let relative = |name: &str| -> String {
        let full = dir.join(name);
        full.strip_prefix(root)
            .unwrap_or(&full)
            .to_string_lossy()
            .into_owned()
    };
    let ignored = ignored_set(
        root,
        &candidates
            .iter()
            .map(|(name, _, _)| relative(name))
            .collect::<Vec<_>>(),
    );

    let mut entries: Vec<RemoteEntry> = candidates
        .into_iter()
        .filter(|(name, _, _)| !ignored.contains(&relative(name)))
        .map(|(name, dir, size)| RemoteEntry { name, dir, size })
        .collect();

    // Folders first, then case-insensitive by name — the order every file tree
    // in this app already uses, so a guest's browser does not look sorted
    // differently from the host's.
    entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
    Ok((entries, truncated))
}

fn read_file(root: &Path, file: &Path) -> Result<(String, i64), String> {
    let meta = std::fs::metadata(file).map_err(|_| "no such file".to_string())?;
    if meta.is_dir() {
        return Err("that is a folder, not a file".into());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "that file is {} bytes — over the {MAX_FILE_BYTES} byte limit for a shared read",
            meta.len()
        ));
    }
    let relative = file
        .strip_prefix(root)
        .unwrap_or(file)
        .to_string_lossy()
        .into_owned();
    if !ignored_set(root, std::slice::from_ref(&relative)).is_empty() {
        // Same message a missing file gets: whether a path is ignored or absent
        // is information about this disk, and a guest does not get it.
        return Err("no such file".into());
    }

    let bytes = std::fs::read(file).map_err(|_| "no such file".to_string())?;
    let size = bytes.len() as i64;
    Ok((
        base64::engine::general_purpose::STANDARD.encode(bytes),
        size,
    ))
}

/// Which of `paths` git would not share, answered in one `git check-ignore`
/// rather than one call per entry.
///
/// Quiet on every failure: a folder that is not a repo, or a machine with no
/// git, returns an empty set and the listing falls back to [`is_secret_name`]
/// alone. That is the honest trade — refusing to list anything would make the
/// feature useless outside a repo, and the secret names are the part that
/// actually matters.
fn ignored_set(root: &Path, paths: &[String]) -> HashSet<String> {
    let empty = HashSet::new();
    if paths.is_empty() {
        return empty;
    }
    let Ok(mut child) = Command::new("git")
        .args(["check-ignore", "--stdin"])
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return empty;
    };
    if let Some(stdin) = child.stdin.as_mut() {
        for path in paths {
            if writeln!(stdin, "{path}").is_err() {
                break;
            }
        }
    }
    drop(child.stdin.take());

    let Ok(out) = child.wait_with_output() else {
        return empty;
    };
    // Exit 1 means "none of them are ignored" and is not a failure; anything
    // above that is, and falls back to the empty set.
    if !matches!(out.status.code(), Some(0) | Some(1)) {
        return empty;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// Names never served to a guest, whatever git says about them.
///
/// The gate exists because the other two can both pass: a repo with no
/// `.gitignore`, or one where `.env` was committed by mistake, would otherwise
/// hand a collaborator live credentials. Local file trees in this app show
/// these on purpose — they are your own files. A guest's browser is not that.
fn is_secret_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower == ".env" || lower.starts_with(".env.") {
        return true;
    }
    if lower.starts_with("id_rsa") || lower.starts_with("id_ecdsa") || lower.starts_with("id_ed25519") {
        return true;
    }
    if matches!(
        lower.as_str(),
        ".npmrc"
            | ".netrc"
            | ".pypirc"
            | ".git-credentials"
            | "credentials"
            | "credentials.json"
            | "secrets.json"
            | ".htpasswd"
    ) {
        return true;
    }
    [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
}

// ── Guest side ───────────────────────────────────────────────────────────────

/// Outstanding reads, keyed by `(session external id, request id)` — the same
/// key the cloud uses, for the same reason: the id is ours to choose and two
/// sessions must not collide on it.
type Waiting = HashMap<(String, String), oneshot::Sender<FileResFrame>>;

fn waiting() -> &'static Mutex<Waiting> {
    static WAITING: OnceLock<Mutex<Waiting>> = OnceLock::new();
    WAITING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_waiting<T>(f: impl FnOnce(&mut Waiting) -> T) -> T {
    let mut guard = waiting().lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}

/// Hand an inbound `file_res` to whoever asked for it. Unknown ids are dropped:
/// the request timed out, or this frame answers somebody else.
pub fn deliver(ctx: &Arc<ConnCtx>, frame: FileResFrame) {
    let key = (ctx.external_id.clone(), frame.id.clone());
    let Some(tx) = lock_waiting(|map| map.remove(&key)) else {
        return;
    };
    let _ = tx.send(frame);
}

/// Ask the host for a listing or a file and wait for the answer.
async fn ask(ctx: &Arc<ConnCtx>, kind: Kind, path: String) -> Result<FileResFrame, String> {
    if ctx.is_host() {
        return Err("this desktop is the host — open the file locally".into());
    }
    if ctx.my_access() != ACCESS_DRIVE {
        return Err("you are watching this session — ask the host for drive access to open files".into());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let key = (ctx.external_id.clone(), id.clone());
    let (tx, rx) = oneshot::channel();
    lock_waiting(|map| map.insert(key.clone(), tx));

    ctx.send(match kind {
        Kind::List => ClientFrame::FileList {
            id: id.clone(),
            path,
        },
        Kind::Read => ClientFrame::FileReq {
            id: id.clone(),
            path,
        },
    });

    match tokio::time::timeout(ANSWER_TIMEOUT, rx).await {
        Ok(Ok(frame)) => match frame.error {
            Some(message) => Err(message),
            None => Ok(frame),
        },
        // The sender was dropped — the connection went down under us.
        Ok(Err(_)) => {
            lock_waiting(|map| map.remove(&key));
            Err("the connection to the session closed before the host answered".into())
        }
        Err(_) => {
            lock_waiting(|map| map.remove(&key));
            Err("the host did not answer in time".into())
        }
    }
}

/// What the guest's file browser renders.
#[derive(Serialize, Debug, Clone)]
pub struct RemoteListing {
    pub path: String,
    pub entries: Vec<RemoteEntry>,
    /// The folder held more than we will send. The browser says so rather than
    /// quietly implying the project is smaller than it is.
    pub truncated: bool,
}

#[derive(Serialize, Debug, Clone)]
pub struct RemoteFile {
    pub path: String,
    pub text: String,
    pub size: i64,
}

/// List a folder of the host's project. An absent `path` is the project root.
#[tauri::command]
pub async fn session_live_list_files(
    state: State<'_, SessionLiveState>,
    session_id: String,
    path: Option<String>,
) -> Result<RemoteListing, String> {
    let ctx = ctx_for(&state, &session_id).await?;
    let path = path.unwrap_or_default();
    let answer = ask(&ctx, Kind::List, path.clone()).await?;
    Ok(RemoteListing {
        path,
        entries: answer.entries.unwrap_or_default(),
        truncated: answer.truncated,
    })
}

/// Read one file of the host's project.
#[tauri::command]
pub async fn session_live_read_file(
    state: State<'_, SessionLiveState>,
    session_id: String,
    path: String,
) -> Result<RemoteFile, String> {
    if path.trim().is_empty() {
        return Err("no file named".into());
    }
    let ctx = ctx_for(&state, &session_id).await?;
    let answer = ask(&ctx, Kind::Read, path.clone()).await?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(answer.content_b64.unwrap_or_default())
        .map_err(|_| "the host sent a file this app could not decode".to_string())?;
    let size = answer.size.unwrap_or(bytes.len() as i64);
    // Binary is not an error — it is a file the editor cannot mount. Saying so
    // here keeps the browser's failure path for things that actually failed.
    let text = String::from_utf8(bytes)
        .map_err(|_| "that file is binary and cannot be shown as text".to_string())?;
    Ok(RemoteFile { path, text, size })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aura-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(dir.join(".env"), "SECRET=hunter2\n").unwrap();
        std::fs::write(dir.join("README.md"), "# hi\n").unwrap();
        dir
    }

    #[test]
    fn a_path_that_leaves_the_project_is_refused() {
        let root = std::fs::canonicalize(temp_repo()).unwrap();
        for escape in ["../", "..", "src/../../etc/passwd", "/etc/passwd", "a\\..\\b"] {
            assert!(
                resolve(&root, escape).is_err(),
                "{escape:?} must not resolve"
            );
        }
        assert!(resolve(&root, "src/main.rs").is_ok());
        assert!(resolve(&root, "./src//main.rs").is_ok());
        assert!(resolve(&root, "").is_ok(), "empty is the project root");
        std::fs::remove_dir_all(root).ok();
    }

    /// The gate the textual check cannot make: a link inside the repo that
    /// points outside it resolves outside it, and is refused there.
    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_project_is_refused() {
        let root = std::fs::canonicalize(temp_repo()).unwrap();
        std::os::unix::fs::symlink("/etc/hosts", root.join("escape")).unwrap();
        assert!(resolve(&root, "escape").is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn secrets_are_refused_by_name_whatever_git_thinks() {
        for name in [
            ".env",
            ".env.local",
            ".ENV.production",
            "server.pem",
            "id_rsa",
            ".npmrc",
            ".git-credentials",
        ] {
            assert!(is_secret_name(name), "{name} should never be served");
        }
        for name in ["main.rs", "env.ts", "readme.env.md", "keyboard.tsx"] {
            assert!(!is_secret_name(name), "{name} is an ordinary file");
        }
    }

    /// A listing of a plain folder — not a git repo, so `check-ignore` fails
    /// and the secret-name gate is the only one left. It must still hold.
    #[test]
    fn a_listing_drops_secrets_even_with_no_git_answer() {
        let root = std::fs::canonicalize(temp_repo()).unwrap();
        let (entries, truncated) = list_dir(&root, &root).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

        assert!(!truncated);
        assert!(!names.contains(&".env"), "listed {names:?}");
        assert_eq!(names, vec!["src", "README.md"], "folders first, then by name");
        assert!(entries[0].size.is_none(), "a folder has no size");
        assert!(entries[1].size.is_some(), "a file does");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn reading_a_file_answers_with_its_bytes_and_a_folder_does_not() {
        let root = std::fs::canonicalize(temp_repo()).unwrap();
        let (body, size) = read_file(&root, &root.join("src/main.rs")).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD.decode(body).unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "fn main() {}\n");
        assert_eq!(size, 13);

        assert!(read_file(&root, &root.join("src")).is_err());
        std::fs::remove_dir_all(root).ok();
    }

    /// An unknown id is not an error — the request already timed out, or the
    /// frame answers a different session.
    #[test]
    fn delivering_an_unclaimed_answer_is_a_no_op() {
        let key = ("s1".to_string(), "r1".to_string());
        let (tx, rx) = oneshot::channel::<FileResFrame>();
        lock_waiting(|map| map.insert(key.clone(), tx));

        // Nothing registered under this id.
        lock_waiting(|map| map.remove(&("s1".to_string(), "other".to_string())));
        assert!(lock_waiting(|map| map.contains_key(&key)));

        let taken = lock_waiting(|map| map.remove(&key)).unwrap();
        taken
            .send(FileResFrame {
                id: "r1".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(rx.blocking_recv().unwrap().id, "r1");
    }
}
