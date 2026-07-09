//! Soundboard storage — short audio clips played into a live LiveKit
//! room as a one-shot audio track.
//!
//! Layout on disk:
//!
//! ~/.aura/soundboard/<repo-hash>/<clip-id>.<ext>
//!
//! Each clip is one file. `clip-id` is "<unix-millis>-<safe-name>".
//! The `<repo-hash>` is the first 16 hex chars of SHA-256(repoRoot) so
//! clips don't leak across repos. We do not store any metadata sidecar
//! — filename carries the upload time + display name.
//!
//! The TS layer reads the bytes via `soundboard_read` and publishes
//! them as a LiveKit LocalAudioTrack from an in-browser AudioContext.
//! The desktop side intentionally does not touch LiveKit — keeps the
//! audio pipeline in one place and avoids splitting the JWT/SFU
//! handshake across processes.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SoundboardClip {
    /// File-system-safe id derived from upload time + sanitized name.
    pub id: String,
    /// User-facing display name (the original filename minus extension).
    pub name: String,
    /// File extension without leading dot — `mp3`, `wav`, `ogg`.
    pub ext: String,
    /// Upload millis (unix) — derived from the id prefix; surfaced so
    /// the UI can sort newest-first without re-parsing the id.
    pub uploaded_at_ms: u64,
    /// Bytes on disk — UI uses this to refuse playback of clips that
    /// got truncated by a bad upload.
    pub size_bytes: u64,
}

fn repo_hash(repo_root: &str) -> String {
    let mut h = Sha256::new();
    h.update(repo_root.as_bytes());
    let out = h.finalize();
    hex_short(&out)
}

fn hex_short(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(16);
    for b in bytes.iter().take(8) {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "no HOME directory".to_string())
}

fn clips_dir(repo_root: &str) -> Result<PathBuf, String> {
    let mut p = home_dir()?;
    p.push(".aura");
    p.push("soundboard");
    p.push(repo_hash(repo_root));
    Ok(p)
}

fn sanitize_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => out.push(ch),
            ' ' | '.' => out.push('_'),
            _ => {}
        }
    }
    if out.is_empty() {
        out.push_str("clip");
    }
    if out.len() > 48 {
        out.truncate(48);
    }
    out
}

fn parse_id_for_ts(id: &str) -> u64 {
    // ids look like "<millis>-<safe-name>".
    if let Some(dash) = id.find('-') {
        if let Ok(ms) = id[..dash].parse::<u64>() {
            return ms;
        }
    }
    0
}

fn ext_from_path(p: &std::path::Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn stem(p: &std::path::Path) -> String {
    p.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

fn read_dir_clips(dir: &std::path::Path) -> Vec<SoundboardClip> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = ext_from_path(&path);
        if !matches!(ext.as_str(), "mp3" | "wav" | "ogg" | "m4a") {
            continue;
        }
        let id = stem(&path);
        let display = id
            .splitn(2, '-')
            .nth(1)
            .unwrap_or(&id)
            .replace('_', " ");
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(SoundboardClip {
            id: id.clone(),
            name: display,
            ext,
            uploaded_at_ms: parse_id_for_ts(&id),
            size_bytes: size,
        });
    }
    out.sort_by(|a, b| a.uploaded_at_ms.cmp(&b.uploaded_at_ms));
    out
}

#[tauri::command]
pub async fn soundboard_list(repo_root: String) -> Result<Vec<SoundboardClip>, String> {
    let dir = clips_dir(&repo_root)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    Ok(read_dir_clips(&dir))
}

#[tauri::command]
pub async fn soundboard_upload(
    repo_root: String,
    name: String,
    ext: String,
    bytes: Vec<u8>,
) -> Result<SoundboardClip, String> {
    if bytes.is_empty() {
        return Err("empty clip".into());
    }
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("clip too large (>2 MB)".into());
    }
    let ext_lc = ext.to_ascii_lowercase();
    if !matches!(ext_lc.as_str(), "mp3" | "wav" | "ogg" | "m4a") {
        return Err(format!("unsupported audio format: {}", ext));
    }
    let dir = clips_dir(&repo_root)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {}", e))?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let safe = sanitize_name(&name);
    let id = format!("{}-{}", now_ms, safe);
    let mut out_path = dir.clone();
    out_path.push(format!("{}.{}", id, ext_lc));
    fs::write(&out_path, &bytes).map_err(|e| format!("write: {}", e))?;
    Ok(SoundboardClip {
        id,
        name: safe.replace('_', " "),
        ext: ext_lc,
        uploaded_at_ms: now_ms,
        size_bytes: bytes.len() as u64,
    })
}

#[tauri::command]
pub async fn soundboard_read(
    repo_root: String,
    clip_id: String,
) -> Result<Vec<u8>, String> {
    let dir = clips_dir(&repo_root)?;
    if !dir.exists() {
        return Err("no clips for this repo".into());
    }
    // Find the file with this stem (don't trust caller's claimed ext).
    let entries = fs::read_dir(&dir).map_err(|e| format!("read_dir: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if stem(&path) == clip_id {
            return fs::read(&path).map_err(|e| format!("read: {}", e));
        }
    }
    Err(format!("clip not found: {}", clip_id))
}

#[tauri::command]
pub async fn soundboard_delete(
    repo_root: String,
    clip_id: String,
) -> Result<(), String> {
    let dir = clips_dir(&repo_root)?;
    if !dir.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(&dir).map_err(|e| format!("read_dir: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if stem(&path) == clip_id {
            fs::remove_file(&path).map_err(|e| format!("remove: {}", e))?;
            return Ok(());
        }
    }
    Ok(())
}
