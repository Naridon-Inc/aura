//! Where installed extensions live on disk and how Aura reads their content.
//!
//! Everything lands under `~/.aura/vscode-extensions/`: one directory per
//! `<id>-<version>` bundle plus an `index.json` of [`InstalledExtension`]
//! records. `read_text` serves the manifest and the theme/grammar/snippet files
//! the frontend applies to Monaco — jailed to the extension's own package root,
//! size-capped, never executed.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::model::InstalledExtension;

const READ_TEXT_MAX_BYTES: u64 = 4 * 1024 * 1024; // theme/grammar/snippet JSON

/// `~/.aura/vscode-extensions`, created on demand.
pub fn extensions_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home directory")?;
    let root = home.join(".aura").join("vscode-extensions");
    fs::create_dir_all(&root).map_err(|e| format!("mkdir {}: {e}", root.display()))?;
    Ok(root)
}

fn index_path() -> Result<PathBuf, String> {
    Ok(extensions_root()?.join("index.json"))
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Default, Serialize, Deserialize)]
struct Index {
    #[serde(default)]
    extensions: Vec<InstalledExtension>,
}

pub fn load_index() -> Vec<InstalledExtension> {
    let p = match index_path() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let raw = match fs::read_to_string(&p) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str::<Index>(&raw)
        .map(|i| i.extensions)
        .unwrap_or_default()
}

fn save_index(exts: &[InstalledExtension]) -> Result<(), String> {
    let p = index_path()?;
    let idx = Index {
        extensions: exts.to_vec(),
    };
    let buf = serde_json::to_vec_pretty(&idx).map_err(|e| format!("serialize index: {e}"))?;
    let tmp = p.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&tmp, &buf).map_err(|e| format!("write index tmp: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename index: {e}")
    })
}

/// Insert or replace an extension (matched by id), preserving the prior
/// `enabled` flag on reinstall so upgrading doesn't silently re-enable a
/// deliberately disabled extension.
pub fn upsert(mut ext: InstalledExtension) -> Result<InstalledExtension, String> {
    let mut exts = load_index();
    if let Some(prev) = exts.iter().find(|e| e.id == ext.id) {
        ext.enabled = prev.enabled;
    }
    exts.retain(|e| e.id != ext.id);
    exts.insert(0, ext.clone());
    save_index(&exts)?;
    Ok(ext)
}

/// List installed extensions, dropping any whose install dir has vanished.
pub fn list() -> Vec<InstalledExtension> {
    load_index()
        .into_iter()
        .filter(|e| Path::new(&e.install_dir).is_dir())
        .collect()
}

pub fn get(id: &str) -> Option<InstalledExtension> {
    load_index().into_iter().find(|e| e.id == id)
}

pub fn set_enabled(id: &str, enabled: bool) -> Result<(), String> {
    let mut exts = load_index();
    let mut found = false;
    for e in exts.iter_mut() {
        if e.id == id {
            e.enabled = enabled;
            found = true;
        }
    }
    if !found {
        return Err(format!("unknown extension: {id}"));
    }
    save_index(&exts)
}

/// Remove an extension from the index and delete its bundle — but only if the
/// bundle actually lives inside our own extensions root (never follow an index
/// entry that points elsewhere).
pub fn remove(id: &str) -> Result<(), String> {
    let mut exts = load_index();
    let target = exts.iter().find(|e| e.id == id).cloned();
    exts.retain(|e| e.id != id);
    save_index(&exts)?;
    if let Some(e) = target {
        if let Ok(root) = extensions_root() {
            let dir = PathBuf::from(&e.install_dir);
            if dir.starts_with(&root) && dir.is_dir() {
                let _ = fs::remove_dir_all(&dir);
            }
        }
    }
    Ok(())
}

/// Read a UTF-8 asset from an installed extension's package root
/// (`<install_dir>/extension/<rel>`), jailed and size-capped. This is how the
/// frontend reads `package.json` and the theme/grammar/snippet files it points
/// at — Aura serving declarative content, never executing it.
pub fn read_text(id: &str, rel: &str) -> Result<String, String> {
    let ext = get(id).ok_or_else(|| format!("unknown extension: {id}"))?;
    let pkg_root = PathBuf::from(&ext.install_dir).join("extension");
    let path = jail_join(&pkg_root, rel)?;
    let meta = fs::metadata(&path).map_err(|e| format!("stat {rel}: {e}"))?;
    if meta.len() > READ_TEXT_MAX_BYTES {
        return Err(format!("asset too large: {rel}"));
    }
    fs::read_to_string(&path).map_err(|e| format!("read {rel}: {e}"))
}

/// Reject any relative path that could climb out of its jail. We check the
/// lexical components before touching the fs, then canonicalize and re-check
/// the prefix to also defeat symlink hops. Mirrors `cmd_plugin_proxy::jail_join`.
fn jail_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // Contributes paths are commonly written "./themes/x.json".
    let rel = rel.trim_start_matches("./");
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("absolute paths are not allowed".into());
    }
    for c in rel_path.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("path escapes extension root: {rel}")),
        }
    }
    let joined = root.join(rel_path);
    let canon = joined
        .canonicalize()
        .map_err(|e| format!("read {rel}: {e}"))?;
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("extension root unavailable: {e}"))?;
    if !canon.starts_with(&canon_root) {
        return Err(format!("path escapes extension root: {rel}"));
    }
    Ok(canon)
}
