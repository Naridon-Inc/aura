// Per-person profile photos.
//
// The roster draws a deterministic animal monogram for everyone by default, and
// auto-pulls a GitHub avatar for anyone whose account we can resolve. This adds
// the third rung: a photo the user picks themselves. It's stored locally, keyed
// by email, in `~/.aura/avatars.json` — alongside `device.json` and
// `identity-overrides.json`, never inside a repo — so one photo follows the
// person across every project on this machine and never lands in git history.
//
// The value is a self-contained `data:` URL (base64), so the frontend `<img>`
// renders it with no asset-protocol wiring and it survives a copy of the JSON.
// We cap the source file so the store (and the IPC payload the frontend reads it
// back over) stay small.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine as _;

/// Largest image we'll ingest. A profile photo has no business being bigger, and
/// the whole map rides the Tauri IPC boundary on read, so keep it modest.
const MAX_AVATAR_BYTES: u64 = 3 * 1024 * 1024;

fn avatars_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".aura").join("avatars.json"))
        .ok_or_else(|| "could not resolve home directory".to_string())
}

/// Normalise the map key so a lookup by any-cased email always hits.
fn norm(email: &str) -> String {
    email.trim().to_lowercase()
}

fn read_map() -> BTreeMap<String, String> {
    let Ok(path) = avatars_path() else {
        return BTreeMap::new();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_map(map: &BTreeMap<String, String>) -> Result<(), String> {
    let path = avatars_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Map an image extension to its media type. Returns `None` for anything that
/// isn't a still image we're willing to store, so the caller can reject it with
/// a clear message instead of stashing an unusable blob.
fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

/// Every stored photo, keyed by lowercased email → `data:` URL. The frontend
/// reads this once and resolves each member against it, falling back to the
/// GitHub avatar and then the animal monogram when a person has no entry.
#[tauri::command]
pub fn identity_avatars_get() -> BTreeMap<String, String> {
    read_map()
}

/// Set a person's photo from a file they picked. Reads the file, encodes it as a
/// `data:` URL, and stores it under their email. Returns the data URL so the
/// caller can show it immediately without a round-trip through
/// `identity_avatars_get`.
#[tauri::command]
pub fn identity_avatar_set_from_path(email: String, path: String) -> Result<String, String> {
    let key = norm(&email);
    if key.is_empty() {
        return Err("no email to attach the photo to".to_string());
    }
    let p = Path::new(&path);
    let mime = image_mime(p).ok_or_else(|| {
        "That file isn't a supported image — pick a PNG, JPG, GIF, WEBP, or BMP.".to_string()
    })?;
    let meta = fs::metadata(p).map_err(|e| format!("read {}: {e}", p.display()))?;
    if meta.len() > MAX_AVATAR_BYTES {
        return Err("That image is over 3 MB — pick a smaller one.".to_string());
    }
    let bytes = fs::read(p).map_err(|e| format!("read {}: {e}", p.display()))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let data_url = format!("data:{mime};base64,{b64}");

    let mut map = read_map();
    map.insert(key, data_url.clone());
    write_map(&map)?;
    Ok(data_url)
}

/// Drop a person's photo, so they fall back to their GitHub avatar / animal
/// monogram again. Clearing an absent photo is idempotently successful.
#[tauri::command]
pub fn identity_avatar_clear(email: String) -> Result<(), String> {
    let key = norm(&email);
    let mut map = read_map();
    if map.remove(&key).is_some() {
        write_map(&map)?;
    }
    Ok(())
}
