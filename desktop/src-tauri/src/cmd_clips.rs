//! Clipboard tray — durable workspace clipboard backed by `~/.aura/clips/`.
//!
//! Captures pasted screenshots and dragged-in files so they can be
//! referenced by an absolute path the agent (Claude/Gemini/Codex) can
//! actually read. Solves the "drag screenshot into Claude → file path
//! goes stale and Claude can't access it" problem.
//!
//! Layout on disk:
//!   ~/.aura/clips/                          — flat directory
//!     2026-05-07T14-22-31_screenshot.png    — image clip
//!     2026-05-07T14-22-58_diagram.svg       — file clip (copied)
//!
//! Entries are listed newest-first and capped to MAX_ENTRIES so the
//! directory doesn't grow unbounded — older entries are pruned on
//! every write.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};

const MAX_ENTRIES: usize = 50;

#[derive(Serialize, Deserialize, Clone)]
pub struct ClipEntry {
    pub id: String,
    /// "image" or "file" — drives icon + preview rendering on the
    /// frontend. Images render as a thumbnail; files as a generic
    /// document chip with the original extension.
    pub kind: String,
    /// Human-friendly name (without timestamp prefix).
    pub name: String,
    /// Absolute path on disk. Frontend uses this both for preview
    /// (via the convertFileSrc protocol) and as the drag payload.
    pub path: String,
    /// Unix milliseconds of capture.
    pub created_at: u64,
    pub size: u64,
}

fn clips_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir unavailable".to_string())?;
    let dir = home.join(".aura").join("clips");
    fs::create_dir_all(&dir).map_err(|e| format!("create clips dir: {e}"))?;
    Ok(dir)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn iso_stamp(ms: u64) -> String {
    // 2026-05-07T14-22-31 — colons replaced so the stamp is filename-safe
    // on every platform.
    let secs = (ms / 1000) as i64;
    let nsecs = ((ms % 1000) * 1_000_000) as u32;
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(secs, nsecs)
        .unwrap_or_else(chrono::Utc::now);
    dt.format("%Y-%m-%dT%H-%M-%S").to_string()
}

fn entry_for(path: &PathBuf) -> Option<ClipEntry> {
    let meta = fs::metadata(path).ok()?;
    let name = path.file_name()?.to_string_lossy().to_string();
    // Strip the leading timestamp prefix when surfacing the name. The
    // raw timestamp is preserved on disk so listings stay sortable.
    let display_name = name
        .splitn(2, '_')
        .nth(1)
        .map(|s| s.to_string())
        .unwrap_or_else(|| name.clone());
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let is_image = matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp");
    let kind = if is_image { "image" } else { "file" }.to_string();
    let created_at = meta
        .created()
        .or_else(|_| meta.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(now_ms);
    Some(ClipEntry {
        id: name.clone(),
        kind,
        name: display_name,
        path: path.to_string_lossy().to_string(),
        created_at,
        size: meta.len(),
    })
}

/// Newest-first listing of every clip currently on disk. The frontend
/// polls this on tray-open and after each save so the list stays fresh
/// without a watcher.
#[tauri::command]
pub fn clips_list() -> Result<Vec<ClipEntry>, String> {
    let dir = clips_dir()?;
    let mut entries: Vec<ClipEntry> = fs::read_dir(&dir)
        .map_err(|e| format!("read clips dir: {e}"))?
        .filter_map(|res| res.ok())
        .filter(|de| de.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|de| entry_for(&de.path()))
        .collect();
    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(entries)
}

/// Persist an inline-pasted image. `data_b64` is a bare base-64 PNG
/// payload (not a data: URL) — the frontend strips the prefix before
/// invoking. Returns the saved entry so the UI can splice it into the
/// list without a re-list.
#[tauri::command]
pub fn clips_save_image(name: String, data_b64: String) -> Result<ClipEntry, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("decode b64: {e}"))?;
    let dir = clips_dir()?;
    let stamp = iso_stamp(now_ms());
    let safe_name = sanitise(&name).unwrap_or_else(|| "screenshot.png".to_string());
    let safe_name = if safe_name.to_lowercase().ends_with(".png") {
        safe_name
    } else {
        format!("{safe_name}.png")
    };
    let filename = format!("{stamp}_{safe_name}");
    let path = dir.join(&filename);
    fs::write(&path, &bytes).map_err(|e| format!("write clip: {e}"))?;
    prune(&dir);
    entry_for(&path).ok_or_else(|| "saved but cannot stat".to_string())
}

/// Copy a file (an in-app drop, or a "Add file…" picker selection) into
/// the clips dir so its path stays valid even if the source moves.
#[tauri::command]
pub fn clips_save_file(orig_path: String) -> Result<ClipEntry, String> {
    import_external_file(&PathBuf::from(&orig_path))
}

/// Internal: copy an arbitrary on-disk file into the clips dir. Shared
/// between the `clips_save_file` Tauri command and the screenshot
/// auto-import watcher (`clips_watch`).
pub fn import_external_file(src: &std::path::Path) -> Result<ClipEntry, String> {
    if !src.is_file() {
        return Err(format!("not a file: {}", src.display()));
    }
    let dir = clips_dir()?;
    let stamp = iso_stamp(now_ms());
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let safe_name = sanitise(&name).unwrap_or_else(|| "file".to_string());
    let filename = format!("{stamp}_{safe_name}");
    let dest = dir.join(&filename);
    fs::copy(src, &dest).map_err(|e| format!("copy clip: {e}"))?;
    prune(&dir);
    entry_for(&dest).ok_or_else(|| "saved but cannot stat".to_string())
}

/// Return the clip's bytes as a `data:` URL. Lets the frontend render
/// thumbnails without enabling the asset protocol (which needs a
/// scope-list and CSP work). Cap of 50 entries × a few MB is fine to
/// hold in memory; the alternative (dragging asset paths through
/// convertFileSrc) is only worth it once we exceed that.
#[tauri::command]
pub fn clips_read_dataurl(id: String) -> Result<String, String> {
    let dir = clips_dir()?;
    let safe = sanitise(&id).unwrap_or_default();
    let path = dir.join(&safe);
    if !path.is_file() {
        return Err("not found".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| format!("read: {e}"))?;
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// Push a clip image into the OS clipboard so the next paste-byte
/// (Ctrl+V) sent to a TUI agent is treated as an image attachment
/// rather than a typed string. We decode the on-disk PNG/JPEG into
/// raw RGBA8 (arboard requires that shape on macOS/X11/Win) and call
/// `set_image`. Non-image clips are rejected — callers should fall
/// back to typing the path.
#[tauri::command]
pub fn clips_copy_image_to_os(id: String) -> Result<(), String> {
    let dir = clips_dir()?;
    let safe = sanitise(&id).unwrap_or_default();
    let path = dir.join(&safe);
    if !path.is_file() {
        return Err("not found".to_string());
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp") {
        return Err(format!("not an image clip: .{ext}"));
    }
    let bytes = fs::read(&path).map_err(|e| format!("read: {e}"))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("decode: {e}"))?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::Owned(rgba.into_raw()),
        })
        .map_err(|e| format!("set_image: {e}"))?;
    Ok(())
}

/// Does the OS clipboard currently hold an image?
///
/// Asked by the terminal's ⌘V path. A PTY carries bytes, so we cannot hand a
/// screenshot to a coding agent through it — but Claude Code and Codex read
/// the pasteboard themselves when they see Ctrl+V, so the correct move for an
/// image is to forward that byte rather than paste text. We can't ask the
/// webview: `navigator.clipboard.read()` needs a permission gesture in
/// WKWebView and returns nothing useful for a screenshot, which is precisely
/// why ⌘V looked like it did nothing while Ctrl+V worked.
///
/// False on any failure — the caller then falls back to the text paste, which
/// is the behaviour that already worked.
#[tauri::command]
pub fn clipboard_has_image() -> bool {
    let Ok(mut clipboard) = arboard::Clipboard::new() else {
        return false;
    };
    // Text wins when both are present: a copied path or command is what the
    // user meant to paste, and pasting it is non-destructive either way.
    if clipboard.get_text().map(|t| !t.is_empty()).unwrap_or(false) {
        return false;
    }
    clipboard.get_image().is_ok()
}

#[tauri::command]
pub fn clips_remove(id: String) -> Result<(), String> {
    let dir = clips_dir()?;
    let path = dir.join(sanitise(&id).unwrap_or_default());
    if path.is_file() {
        fs::remove_file(&path).map_err(|e| format!("remove clip: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn clips_clear() -> Result<(), String> {
    let dir = clips_dir()?;
    if let Ok(entries) = fs::read_dir(&dir) {
        for de in entries.flatten() {
            if de.file_type().map(|t| t.is_file()).unwrap_or(false) {
                let _ = fs::remove_file(de.path());
            }
        }
    }
    Ok(())
}

fn sanitise(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    let cleaned: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn prune(dir: &PathBuf) {
    let mut entries: Vec<(PathBuf, u64)> = match fs::read_dir(dir) {
        Ok(it) => it
            .filter_map(|de| de.ok())
            .filter(|de| de.file_type().map(|t| t.is_file()).unwrap_or(false))
            .filter_map(|de| {
                let path = de.path();
                let mtime = de
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                Some((path, mtime))
            })
            .collect(),
        Err(_) => return,
    };
    if entries.len() <= MAX_ENTRIES {
        return;
    }
    entries.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _) in entries.into_iter().skip(MAX_ENTRIES) {
        let _ = fs::remove_file(path);
    }
}
