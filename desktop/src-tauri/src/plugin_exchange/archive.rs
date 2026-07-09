//! Bundle archive format for the Plugin Exchange.
//!
//! Deliberately not tar: a JSON `{ "files": { "<relpath>": "<b64>" } }`
//! map, gzipped. Trivially auditable, no archive-format attack surface
//! beyond the path validation below, and no new dependency.
//!
//! Pack mirrors the signature digest's walk rules (skip dot-prefixed
//! names + symlinks) so the bytes a teammate receives are exactly the
//! bytes the publisher's signature covers.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::Path;

use base64::Engine;
use serde::{Deserialize, Serialize};

/// Hard caps enforced on BOTH pack and unpack. A malicious peer can
/// hand-craft an archive, so unpack trusts nothing.
pub const MAX_RAW_BYTES: u64 = 1024 * 1024; // 1 MiB total file bytes
pub const MAX_FILES: usize = 200;
pub const MAX_DEPTH: usize = 8;

#[derive(Serialize, Deserialize)]
struct Archive {
    /// relpath ('/'-joined) → standard-base64 file bytes. BTreeMap so
    /// packing is deterministic.
    files: BTreeMap<String, String>,
}

/// Pack `dir` into a gzipped archive. Skips dot-prefixed entries and
/// symlinks (same rules as `aura-plugin-sign`'s digest walk).
pub fn pack(dir: &Path) -> Result<Vec<u8>, String> {
    let mut files = BTreeMap::new();
    let mut total: u64 = 0;
    let mut stack = vec![(dir.to_path_buf(), String::new())];
    while let Some((d, prefix)) = stack.pop() {
        let entries = std::fs::read_dir(&d).map_err(|e| format!("{}: {e}", d.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = match entry.file_name().into_string() {
                Ok(n) => n,
                Err(_) => continue, // non-UTF8 names are unsignable; skip
            };
            if name.starts_with('.') {
                continue;
            }
            let meta = entry
                .path()
                .symlink_metadata()
                .map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                continue;
            }
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if meta.is_dir() {
                if rel.matches('/').count() + 1 >= MAX_DEPTH {
                    return Err(format!("bundle too deep at {rel} (max {MAX_DEPTH} levels)"));
                }
                stack.push((entry.path(), rel));
            } else if meta.is_file() {
                total += meta.len();
                if total > MAX_RAW_BYTES {
                    return Err(format!(
                        "bundle exceeds the {} KiB exchange cap",
                        MAX_RAW_BYTES / 1024
                    ));
                }
                if files.len() >= MAX_FILES {
                    return Err(format!("bundle has more than {MAX_FILES} files"));
                }
                let bytes =
                    std::fs::read(entry.path()).map_err(|e| format!("{rel}: {e}"))?;
                files.insert(
                    rel,
                    base64::engine::general_purpose::STANDARD.encode(bytes),
                );
            }
        }
    }
    if files.is_empty() {
        return Err("bundle directory is empty".to_string());
    }
    let json = serde_json::to_vec(&Archive { files }).map_err(|e| e.to_string())?;
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(&json).map_err(|e| e.to_string())?;
    enc.finish().map_err(|e| e.to_string())
}

/// Unpack into a list of (relpath, bytes), validating every path and
/// re-enforcing the caps. NEVER writes to disk — the caller decides
/// where extracted bytes land.
pub fn unpack(gz: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut dec = flate2::read::GzDecoder::new(gz);
    let mut json = Vec::new();
    // Decompression-bomb guard: refuse to inflate past the raw cap plus
    // generous base64/JSON overhead.
    let cap = (MAX_RAW_BYTES as usize) * 2;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = dec.read(&mut buf).map_err(|e| format!("gunzip: {e}"))?;
        if n == 0 {
            break;
        }
        json.extend_from_slice(&buf[..n]);
        if json.len() > cap {
            return Err("archive inflates past the exchange cap".to_string());
        }
    }
    let archive: Archive =
        serde_json::from_slice(&json).map_err(|e| format!("archive json: {e}"))?;
    if archive.files.len() > MAX_FILES {
        return Err(format!("archive has more than {MAX_FILES} files"));
    }
    let mut out = Vec::with_capacity(archive.files.len());
    let mut total: u64 = 0;
    for (rel, b64) in archive.files {
        validate_relpath(&rel)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| format!("{rel}: bad base64: {e}"))?;
        total += bytes.len() as u64;
        if total > MAX_RAW_BYTES {
            return Err("archive contents exceed the exchange cap".to_string());
        }
        out.push((rel, bytes));
    }
    Ok(out)
}

/// Reject anything that could escape the extraction dir: absolute
/// paths, `..`, backslashes, empty components, dot-prefixed names,
/// excessive depth.
fn validate_relpath(rel: &str) -> Result<(), String> {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\\') || rel.contains('\0') {
        return Err(format!("illegal archive path `{rel}`"));
    }
    let components: Vec<&str> = rel.split('/').collect();
    if components.len() > MAX_DEPTH {
        return Err(format!("archive path `{rel}` too deep"));
    }
    for c in &components {
        if c.is_empty() || *c == ".." || c.starts_with('.') {
            return Err(format!("illegal archive path `{rel}`"));
        }
    }
    Ok(())
}

/// Extract an unpacked file list into `dest` (creating parents). The
/// paths were validated by `unpack`, so this is a straight write.
pub fn extract_to(dest: &Path, files: &[(String, Vec<u8>)]) -> Result<(), String> {
    for (rel, bytes) in files {
        let path = dest.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, bytes).map_err(|e| format!("{rel}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_bundle(dir: &Path) {
        std::fs::create_dir_all(dir.join("panels")).unwrap();
        std::fs::write(dir.join("aura.plugin.json"), b"{\"id\": \"@t/x\"}").unwrap();
        std::fs::write(dir.join("worker.js"), b"console.log('hi')").unwrap();
        std::fs::write(dir.join("panels/p.html"), b"<html></html>").unwrap();
        std::fs::write(dir.join(".secret"), b"never-shipped").unwrap();
    }

    #[test]
    fn pack_unpack_roundtrip_skips_dotfiles() {
        let tmp = tempfile::tempdir().unwrap();
        demo_bundle(tmp.path());
        let gz = pack(tmp.path()).unwrap();
        let files = unpack(&gz).unwrap();
        let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["aura.plugin.json", "panels/p.html", "worker.js"]);
        assert!(!names.contains(&".secret"));
        let worker = files.iter().find(|(n, _)| n == "worker.js").unwrap();
        assert_eq!(worker.1, b"console.log('hi')");
    }

    #[test]
    fn extract_writes_nested_paths() {
        let tmp = tempfile::tempdir().unwrap();
        demo_bundle(tmp.path());
        let gz = pack(tmp.path()).unwrap();
        let files = unpack(&gz).unwrap();
        let dest = tmp.path().join("out");
        extract_to(&dest, &files).unwrap();
        assert_eq!(
            std::fs::read(dest.join("panels/p.html")).unwrap(),
            b"<html></html>"
        );
    }

    #[test]
    fn traversal_paths_are_rejected() {
        for bad in ["../evil", "/abs", "a/../b", "a//b", ".hidden", "a/.hidden", "a\\b"] {
            let mut files = BTreeMap::new();
            files.insert(
                bad.to_string(),
                base64::engine::general_purpose::STANDARD.encode(b"x"),
            );
            let json = serde_json::to_vec(&Archive { files }).unwrap();
            let mut enc =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            enc.write_all(&json).unwrap();
            let gz = enc.finish().unwrap();
            assert!(unpack(&gz).is_err(), "expected rejection for `{bad}`");
        }
    }

    #[test]
    fn oversized_bundle_is_refused_at_pack() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("big.bin"),
            vec![0u8; (MAX_RAW_BYTES + 1) as usize],
        )
        .unwrap();
        assert!(pack(tmp.path()).is_err());
    }

    #[test]
    fn unpack_enforces_caps_independently() {
        // Hand-craft an archive that lies about nothing but is too big.
        let mut files = BTreeMap::new();
        files.insert(
            "big.bin".to_string(),
            base64::engine::general_purpose::STANDARD
                .encode(vec![0u8; (MAX_RAW_BYTES + 1) as usize]),
        );
        let json = serde_json::to_vec(&Archive { files }).unwrap();
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(&json).unwrap();
        let gz = enc.finish().unwrap();
        assert!(unpack(&gz).is_err());
    }
}
