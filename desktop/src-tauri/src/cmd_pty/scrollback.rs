//! Cold-restore terminal scrollback.
//!
//! When the daemon isn't hosting a session (the default, daemon off) or
//! the child has truly exited, a relaunched terminal has no live process
//! to reconnect to — so we replay the last screen-ful of output as inert
//! text above a fresh prompt. VS Code does the same with its
//! serialized-terminal restore. This is layer (B) of the locked
//! persistence decision; layer (A) is the daemon live-reconnect.
//!
//! On disk:
//!   `~/.aura/terminal-sessions/<sha256(repo_root)[..16]>/<term_id>.scrollback.gz`
//!
//! gzip (flate2), atomic tmp+rename (`fs_atomic`), hard cap on the
//! COMPRESSED payload. `load` returns `""` on any miss so a first launch
//! never errors; `prune` GCs files whose `term_id` left the persisted
//! workspace snapshot.

use std::io::{Read, Write};
use std::path::PathBuf;

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};

/// Hard ceiling on the COMPRESSED scrollback kept per tab. Terminal text
/// gzips ~10×, so 2 MiB compressed ≈ ~20 MiB raw — far more than the
/// ~1000-line replay the frontend caps to, but bounded so a runaway
/// `yes` loop can't fill the disk.
const SCROLLBACK_CAP: usize = 2 * 1024 * 1024;

fn sessions_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".aura");
    p.push("terminal-sessions");
    Some(p)
}

/// Per-repo dir keyed by a short sha256 of the repo root so two
/// projects' tabs never collide and the path stays filesystem-safe
/// regardless of the repo's real path.
fn repo_dir(repo_root: &str) -> Option<PathBuf> {
    let mut hasher = Sha256::new();
    hasher.update(repo_root.as_bytes());
    let hex = hex::encode(hasher.finalize());
    let mut p = sessions_root()?;
    p.push(&hex[..16]);
    Some(p)
}

/// Sanitize the term id before it becomes a filename. It's a UUID we
/// mint, but a hand-edited snapshot could smuggle a path separator, so we
/// strip everything but `[A-Za-z0-9_-]`. Stripping alone would COLLIDE —
/// `a/b` and `ab` would map to the same file, letting one tab clobber
/// another's scrollback (or mis-prune it). So: when the id is already
/// filename-safe (the normal UUID case) we keep it verbatim — existing
/// files still resolve — but the moment a char gets stripped (or the id
/// is empty) we append a short hash of the FULL original, which two
/// distinct ids can never share.
fn safe_term_id(term_id: &str) -> String {
    let cleaned: String = term_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if cleaned == term_id && !cleaned.is_empty() {
        return cleaned;
    }
    let mut hasher = Sha256::new();
    hasher.update(term_id.as_bytes());
    let hex = hex::encode(hasher.finalize());
    if cleaned.is_empty() {
        format!("id-{}", &hex[..16])
    } else {
        format!("{}-{}", cleaned, &hex[..16])
    }
}

fn scrollback_path(repo_root: &str, term_id: &str) -> Option<PathBuf> {
    let mut p = repo_dir(repo_root)?;
    p.push(format!("{}.scrollback.gz", safe_term_id(term_id)));
    Some(p)
}

/// Persist a tab's scrollback. `data` is the raw serialized terminal
/// buffer (xterm's SerializeAddon output) as UTF-8 bytes. Compresses,
/// trims the head to fit the compressed cap, then writes atomically.
#[tauri::command]
pub fn pty_scrollback_save(
    repo_root: String,
    term_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let Some(path) = scrollback_path(&repo_root, &term_id) else {
        return Err("no HOME — cannot persist scrollback".into());
    };
    let mut raw = data;
    let mut encoded = gzip(&raw)?;
    // Keep the freshest tail under the COMPRESSED cap. Estimate the raw
    // budget from the achieved ratio, trim the head, recompress — then
    // RE-CHECK: a tail can compress worse than the whole (e.g. the head
    // was a long repetitive build log, the tail is high-entropy), so a
    // single pass isn't guaranteed to land under the hard cap. Loop a
    // bounded number of times, always shrinking `raw`, with a 0.9 margin
    // so the recompress reliably fits rather than hugging the ceiling.
    let mut guard = 0;
    while encoded.len() > SCROLLBACK_CAP && !raw.is_empty() && guard < 4 {
        guard += 1;
        let ratio = (encoded.len() as f64 / raw.len() as f64).max(0.01);
        let raw_budget = (((SCROLLBACK_CAP as f64) * 0.9) / ratio) as usize;
        raw = if raw_budget < raw.len() {
            raw[raw.len() - raw_budget..].to_vec()
        } else {
            // Ratio ~1 (incompressible) — the estimate can't shrink the
            // budget below the current length, so drop the oldest half
            // outright to guarantee forward progress instead of spinning.
            raw[raw.len() / 2..].to_vec()
        };
        encoded = gzip(&raw)?;
    }
    crate::fs_atomic::write_bytes(&path, &encoded)
}

/// Load a tab's scrollback for cold replay. Returns `""` on any miss
/// (no file, unreadable, corrupt gzip) — a blank restore is strictly
/// better than a console error on a fresh terminal.
#[tauri::command]
pub fn pty_scrollback_load(repo_root: String, term_id: String) -> Result<String, String> {
    let Some(path) = scrollback_path(&repo_root, &term_id) else {
        return Ok(String::new());
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(String::new());
    };
    let mut decoder = GzDecoder::new(&bytes[..]);
    let mut raw = Vec::new();
    if decoder.read_to_end(&mut raw).is_err() {
        return Ok(String::new());
    }
    // Scrollback is raw terminal bytes that may split a multibyte char
    // at the trim boundary — lossy decode so a torn char can't fail the
    // whole restore.
    Ok(String::from_utf8_lossy(&raw).into_owned())
}

/// Delete scrollback files whose `term_id` is no longer in the persisted
/// snapshot — called after rehydrate so closed tabs don't leak history
/// onto disk forever. Missing dir / unreadable entries are a no-op.
#[tauri::command]
pub fn pty_scrollback_prune(
    repo_root: String,
    keep_term_ids: Vec<String>,
) -> Result<(), String> {
    let Some(dir) = repo_dir(&repo_root) else {
        return Ok(());
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(()); // nothing persisted yet
    };
    let keep: std::collections::HashSet<String> =
        keep_term_ids.iter().map(|s| safe_term_id(s)).collect();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(stem) = name.strip_suffix(".scrollback.gz") else {
            continue;
        };
        if !keep.contains(stem) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

fn gzip(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(data).map_err(|e| e.to_string())?;
    enc.finish().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gunzip(bytes: &[u8]) -> Vec<u8> {
        let mut d = GzDecoder::new(bytes);
        let mut out = Vec::new();
        d.read_to_end(&mut out).unwrap();
        out
    }

    #[test]
    fn gzip_round_trips() {
        let payload = b"\x1b[32m$ ls -la\x1b[0m\r\ntotal 0\r\n".repeat(50);
        let encoded = gzip(&payload).unwrap();
        assert_eq!(gunzip(&encoded), payload);
    }

    #[test]
    fn safe_term_id_keeps_clean_ids_verbatim() {
        // A real minted UUID is already filename-safe — unchanged, so
        // scrollback files written before this hardening still resolve.
        assert_eq!(
            safe_term_id("3f2a-9c1b_term"),
            "3f2a-9c1b_term".to_string()
        );
    }

    #[test]
    fn safe_term_id_disambiguates_mangled_ids() {
        // A path-bearing id is stripped to safe chars but disambiguated by
        // a hash of the original, so it never resolves to a bare filename.
        let a = safe_term_id("../../etc/passwd");
        assert!(a.starts_with("etcpasswd-"));
        // Two distinct ids that strip to the SAME chars must NOT collide.
        let x = safe_term_id("a/b");
        let y = safe_term_id("ab");
        assert_ne!(x, y, "distinct ids collided: {x} == {y}");
        // An id that sanitizes to empty still yields a stable, safe name.
        assert!(safe_term_id("///").starts_with("id-"));
    }

    #[test]
    fn repo_dir_is_short_hex() {
        let d = repo_dir("/Users/x/proj").unwrap();
        let leaf = d.file_name().unwrap().to_string_lossy();
        assert_eq!(leaf.len(), 16);
        assert!(leaf.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
