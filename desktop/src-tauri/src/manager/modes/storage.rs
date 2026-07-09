//! On-disk mode storage — atomic YAML writes + meta sidecar.
//!
//! Layout under `~/.aura/modes/`:
//!
//! ```text
//! ~/.aura/modes/
//!   architect.yaml       (mode definition — schema v1)
//!   architect.meta.json  (provenance — source url, blake3 pin, install_ts)
//!   code.yaml
//!   code.meta.json
//!   ...
//! ```
//!
//! Why two files? The YAML is the "thing the user can share / edit". The
//! sidecar is operational data — we don't want a `aura modes publish` to
//! leak the user's local install URL to the marketplace. Keeping the two
//! separate means the YAML round-trips cleanly through Gist publish.
//!
//! Atomicity: every write goes through `tempfile::NamedTempFile` in the
//! same directory, then `persist()` (which uses `rename(2)` on UNIX —
//! atomic on the same filesystem). Half-written modes never appear.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::ModesError;
use super::schema::Mode;
use super::validate::validate;

/// Sidecar provenance written next to every installed mode. Source URL +
/// blake3 pin let the updater detect "the marketplace silently changed
/// this mode under us" — we refuse to upgrade unless the new content
/// hashes to a fresh pin the user accepts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModeMeta {
    /// Where the mode came from. `bundled` for shipped defaults,
    /// `local` for hand-authored modes, otherwise the install URL.
    pub source: String,
    /// blake3 hash of the YAML bytes at install time. The updater
    /// re-fetches the URL, re-hashes, and only proposes an update when
    /// the new pin differs.
    pub pin_blake3: String,
    /// Unix timestamp of the install.
    pub installed_at: u64,
    /// True once the user has interacted with this mode (switched into
    /// it, edited it). Bundled defaults flip false → true after first
    /// use. Drives the "Recommended" sort in the picker.
    #[serde(default)]
    pub used: bool,
    /// User-set enabled flag. Disabled modes stay on disk (so the user
    /// can re-enable them in one click) but don't appear in the picker.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

impl ModeMeta {
    pub fn now(source: impl Into<String>, pin: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            pin_blake3: pin.into(),
            installed_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            used: false,
            enabled: true,
        }
    }
}

/// Returns `~/.aura/modes/` after ensuring the directory exists. Errors
/// bubble up as `ModesError::Io` so the caller can surface them.
pub fn modes_dir() -> Result<PathBuf, ModesError> {
    let home = dirs::home_dir().ok_or_else(|| ModesError::Io {
        message: "could not resolve $HOME".into(),
    })?;
    let p = home.join(".aura").join("modes");
    fs::create_dir_all(&p).map_err(|e| ModesError::Io {
        message: format!("create_dir_all({}): {e}", p.display()),
    })?;
    Ok(p)
}

/// Path to the YAML for a given slug. Does NOT check existence.
pub fn yaml_path(slug: &str) -> Result<PathBuf, ModesError> {
    Ok(modes_dir()?.join(format!("{slug}.yaml")))
}

/// Path to the meta sidecar for a given slug.
pub fn meta_path(slug: &str) -> Result<PathBuf, ModesError> {
    Ok(modes_dir()?.join(format!("{slug}.meta.json")))
}

/// Compute the blake3 hex digest of an arbitrary byte slice. Used both
/// for install-time pinning and the marketplace updater check.
pub fn blake3_hex(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Read + validate a mode YAML from disk. Returns `None` when the file
/// is absent (so callers can probe without a `try_exists` dance) and
/// `Err` on read or validation failure.
pub fn load_mode(slug: &str) -> Result<Option<(Mode, Option<ModeMeta>)>, ModesError> {
    let yp = yaml_path(slug)?;
    if !yp.exists() {
        return Ok(None);
    }
    let yaml = fs::read_to_string(&yp).map_err(|e| ModesError::Io {
        message: format!("read {}: {e}", yp.display()),
    })?;
    let report = validate(&yaml);
    let mode = report.mode.ok_or_else(|| ModesError::Validation {
        message: format!(
            "{} failed validation: {}",
            yp.display(),
            report
                .issues
                .iter()
                .map(|i| format!("{}: {}", i.field, i.message))
                .collect::<Vec<_>>()
                .join("; ")
        ),
    })?;
    let meta = load_meta(slug)?;
    Ok(Some((mode, meta)))
}

/// Read the meta sidecar for a slug. Returns `Ok(None)` when absent
/// (the YAML may be a hand-authored local mode that never had one
/// written).
pub fn load_meta(slug: &str) -> Result<Option<ModeMeta>, ModesError> {
    let mp = meta_path(slug)?;
    if !mp.exists() {
        return Ok(None);
    }
    let s = fs::read_to_string(&mp).map_err(|e| ModesError::Io {
        message: format!("read {}: {e}", mp.display()),
    })?;
    let meta: ModeMeta = serde_json::from_str(&s).map_err(|e| ModesError::Validation {
        message: format!("meta {} is malformed: {e}", mp.display()),
    })?;
    Ok(Some(meta))
}

/// Atomically write a mode to disk. The YAML is re-serialized from the
/// `Mode` struct (canonicalising field order + indentation), then both
/// `<slug>.yaml` and `<slug>.meta.json` are written through tempfiles +
/// rename. The caller passes the original YAML text only so we can pin
/// it byte-exactly in the meta (re-serialised bytes would hash
/// differently from the marketplace's pin).
pub fn save_mode(
    mode: &Mode,
    original_yaml: &str,
    meta: &ModeMeta,
) -> Result<(), ModesError> {
    let dir = modes_dir()?;
    // YAML — serialise the Mode struct so on-disk shape is canonical.
    let yaml = serde_yaml::to_string(mode).map_err(|e| ModesError::Validation {
        message: format!("serialize mode: {e}"),
    })?;
    write_atomic(&dir.join(format!("{}.yaml", mode.id)), yaml.as_bytes())?;
    // Meta — pin against the ORIGINAL bytes the user installed, not the
    // re-serialised ones (round-tripping may reorder map keys).
    let mut meta = meta.clone();
    if meta.pin_blake3.is_empty() {
        meta.pin_blake3 = blake3_hex(original_yaml.as_bytes());
    }
    let mjson = serde_json::to_string_pretty(&meta).map_err(|e| ModesError::Validation {
        message: format!("serialize meta: {e}"),
    })?;
    write_atomic(&dir.join(format!("{}.meta.json", mode.id)), mjson.as_bytes())?;
    Ok(())
}

/// Update just the meta sidecar — used by `mark_used`, `enable`, `disable`
/// without rewriting the YAML.
pub fn save_meta(slug: &str, meta: &ModeMeta) -> Result<(), ModesError> {
    let mp = meta_path(slug)?;
    let s = serde_json::to_string_pretty(meta).map_err(|e| ModesError::Validation {
        message: format!("serialize meta: {e}"),
    })?;
    write_atomic(&mp, s.as_bytes())
}

/// List all `<slug>.yaml` files under `~/.aura/modes/`. Returns the
/// stems only, sorted. Callers pair this with `load_mode` to read each
/// entry.
pub fn list_slugs() -> Result<Vec<String>, ModesError> {
    let dir = modes_dir()?;
    let mut out = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| ModesError::Io {
        message: format!("read_dir({}): {e}", dir.display()),
    })?;
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("yaml") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                out.push(stem.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Remove `<slug>.yaml` + `<slug>.meta.json`. Idempotent — missing
/// files are not an error so the UI can call this from a confirmation
/// dialog without first probing existence.
pub fn delete_mode(slug: &str) -> Result<(), ModesError> {
    for p in [yaml_path(slug)?, meta_path(slug)?] {
        if p.exists() {
            fs::remove_file(&p).map_err(|e| ModesError::Io {
                message: format!("remove {}: {e}", p.display()),
            })?;
        }
    }
    Ok(())
}

/// Tempfile-and-rename. Lives at file scope (not method) so other
/// modules in this directory (`marketplace.rs`) can reuse it without a
/// circular dep on `storage`.
fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), ModesError> {
    let parent = target.parent().ok_or_else(|| ModesError::Io {
        message: format!("target {} has no parent", target.display()),
    })?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(|e| ModesError::Io {
        message: format!("tempfile in {}: {e}", parent.display()),
    })?;
    tmp.write_all(bytes).map_err(|e| ModesError::Io {
        message: format!("write tempfile: {e}"),
    })?;
    tmp.flush().map_err(|e| ModesError::Io {
        message: format!("flush tempfile: {e}"),
    })?;
    tmp.persist(target).map_err(|e| ModesError::Io {
        message: format!("persist {}: {e}", target.display()),
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blake3_hex_is_deterministic_and_hex() {
        let h1 = blake3_hex(b"hello");
        let h2 = blake3_hex(b"hello");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // blake3 hex digest is 64 chars
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
