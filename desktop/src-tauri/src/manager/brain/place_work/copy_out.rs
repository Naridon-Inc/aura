//! "Put this workspace's files in a folder on my laptop." — the Sync to a
//! local directory switch and Transfer to local…, both of which end in this.
//!
//! What travels is what git tracks in the workspace's folder on the machine,
//! as it is on disk there now: an edit the agent has not committed comes
//! along, and `node_modules`, build output and anything else the project
//! ignores does not. The machine packs the files with `tar` and this laptop
//! unpacks them as they arrive, over the one ssh stream `Place::stream`
//! opens — no second transport, no file the size of the project written
//! anywhere on the way.
//!
//! Files land over whatever the folder already holds. Nothing in it is
//! deleted: a file removed on the machine stays here until you remove it,
//! which is the safe way round for a folder you chose.

use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};

use super::{outcome, Place, Work};

/// How many files git tracks there, counted on the NULs `-z` ends each with,
/// so a name with a newline in it is still one file.
const COUNT: &str = "git ls-files -z | tr -cd '\\000' | wc -c";
/// The tracked files as one tar stream on stdout. `--ignore-failed-read`
/// because a tracked file the agent deleted is not a reason to send nothing.
const PACK: &str = "git ls-files -z | tar --null --ignore-failed-read -T - -cf -";
/// A large repository over a slow link takes minutes; one that takes longer
/// than this is stuck, not slow.
const LIMIT: Duration = Duration::from_secs(600);

/// What arrived, said back to the person who asked.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CopiedOut {
    pub files: u64,
    pub folder: String,
}

/// The folder on this laptop, checked before anything is made in it.
pub(crate) fn folder_of(dest: &str) -> Result<PathBuf, String> {
    let dest = dest.trim();
    let path = Path::new(dest);
    if dest.is_empty() || !path.is_absolute() {
        return Err("Choose a folder on this computer to copy the workspace into.".to_string());
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("{dest:?} isn't a folder path this can use."));
    }
    Ok(path.to_path_buf())
}

async fn drain<R: AsyncRead + Unpin>(from: Option<R>) -> String {
    let mut said = String::new();
    if let Some(mut r) = from {
        let _ = r.read_to_string(&mut said).await;
    }
    said.trim().to_string()
}

/// Copy the files git tracks in the workspace's folder on the machine into
/// `dest` on this laptop.
#[tauri::command]
pub async fn place_work_copy_out(
    machine_id: String,
    root: String,
    remote_root: Option<String>,
    dest: String,
) -> Result<CopiedOut, String> {
    let folder = folder_of(&dest)?;
    let w = Work::at_worktree(Place::at_machine(&machine_id)?, &root, remote_root.as_deref())?;
    let label = w.place.label().to_string();
    let files: u64 = outcome(&w.ask(COUNT).await?)?
        .trim()
        .parse()
        .map_err(|_| format!("{label} didn't say which files git tracks in the workspace."))?;
    std::fs::create_dir_all(&folder)
        .map_err(|e| format!("Couldn't make {}: {e}", folder.display()))?;

    let mut remote = w.place.stream(PACK).await?;
    let mut local = tokio::process::Command::new("tar")
        .arg("-xf")
        .arg("-")
        .arg("-C")
        .arg(&folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Couldn't start tar on this computer: {e}"))?;
    let mut from = remote.stdout.take().ok_or("The machine's side of the copy has no output.")?;
    let mut into = local.stdin.take().ok_or("This computer's side of the copy has no input.")?;
    let remote_err = remote.stderr.take();
    let local_err = local.stderr.take();

    let run = async {
        let pipe = async move {
            let copied = tokio::io::copy(&mut from, &mut into).await;
            // Closing tar's input is what tells it the stream is over.
            drop(into);
            copied
        };
        let (copied, there, here) = tokio::join!(pipe, drain(remote_err), drain(local_err));
        let sent = remote.wait().await.map_err(|e| format!("wait: {e}"))?;
        let unpacked = local.wait().await.map_err(|e| format!("wait: {e}"))?;
        if !sent.success() {
            return Err(if there.is_empty() {
                format!("{label} stopped sending the files (exit {:?}).", sent.code())
            } else {
                there
            });
        }
        if !unpacked.success() {
            return Err(if here.is_empty() {
                format!("Unpacking into {} failed (exit {:?}).", folder.display(), unpacked.code())
            } else {
                here
            });
        }
        copied.map_err(|e| format!("The copy broke off: {e}"))?;
        Ok(())
    };
    tokio::time::timeout(LIMIT, run)
        .await
        .map_err(|_| format!("Copying from {label} took longer than ten minutes, so it was stopped."))??;
    Ok(CopiedOut {
        files,
        folder: folder.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_absolute_folder_is_copied_into() {
        assert!(folder_of("/Users/me/Cloud/app").is_ok());
        assert!(folder_of("  /Users/me/Cloud/app  ").is_ok());
        assert!(folder_of("").is_err());
        assert!(folder_of("Cloud/app").is_err());
        assert!(folder_of("/Users/me/../../etc").is_err());
    }
}
