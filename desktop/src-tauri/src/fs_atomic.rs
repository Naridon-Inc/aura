//! Process-safe atomic write helper. Two writers racing on the same
//! target file used to clobber each other's tmp file (we used a fixed
//! `<name>.json.tmp` suffix), surfacing as:
//!
//!   "rename: No such file or directory (os error 2)"
//!
//! when the loser tried to `fs::rename` a tmp the winner had already
//! moved into place. The bug bit `tasks_list` hard — heal-on-read fires
//! a save on every call and a double-mount of the Tasks workpane
//! (React StrictMode, or two callers in the same paint) was enough to
//! trigger it.
//!
//! Fix: route every `.aura/**` json/jsonl save through
//! `tempfile::NamedTempFile::new_in(parent)` so each writer gets a
//! unique tmp name, then `persist()` it onto the target. Persist is
//! still a `rename(2)` under the hood — atomic on the same filesystem
//! — but never collides because the tmp name is randomised.

use std::io::Write as _;
use std::path::Path;

use serde::Serialize;
use tempfile::NamedTempFile;

/// Write `bytes` to `target` atomically (tempfile in the same dir,
/// then rename). Creates the parent dir if missing.
pub fn write_bytes(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target.parent().ok_or_else(|| {
        format!("atomic write target {} has no parent", target.display())
    })?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    let mut tmp = NamedTempFile::new_in(parent)
        .map_err(|e| format!("tempfile in {}: {}", parent.display(), e))?;
    tmp.write_all(bytes)
        .map_err(|e| format!("write tempfile: {}", e))?;
    tmp.flush().map_err(|e| format!("flush tempfile: {}", e))?;
    tmp.persist(target)
        .map_err(|e| format!("persist {}: {}", target.display(), e.error))?;
    Ok(())
}

/// Serialize `value` as pretty JSON and write atomically.
pub fn write_json_pretty<T: Serialize>(target: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(value)
        .map_err(|e| format!("serialize {}: {}", target.display(), e))?;
    write_bytes(target, &json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn concurrent_writers_do_not_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let target = Arc::new(dir.path().join("hot.json"));
        let mut handles = Vec::new();
        for i in 0..20 {
            let t = target.clone();
            handles.push(thread::spawn(move || {
                let payload = format!("{{\"writer\":{}}}", i);
                write_bytes(&t, payload.as_bytes()).expect("atomic write must not race");
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let final_bytes = std::fs::read(&*target).unwrap();
        assert!(final_bytes.starts_with(b"{\"writer\":"));
    }

    #[test]
    fn writes_through_missing_parent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("nested").join("does").join("not").join("exist.json");
        write_bytes(&target, b"{}").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"{}");
    }
}
