//! The bundle digest — what an ed25519 plugin signature actually signs.
//!
//! See the crate docs for the exact byte layout. The digest is
//! deliberately computed from the FILESYSTEM state of the bundle
//! directory, not from any in-memory registry view, so the CLI signing
//! a directory and the shell verifying the installed copy hash the
//! same bytes by construction.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::canonical::canonical_json;

/// Version tag mixed into the digest so a future v2 layout can never
/// collide with v1 signatures.
pub const DIGEST_VERSION: &str = "aura-plugin-digest-v1";

/// The manifest filename whose `signature` field carries the bundle
/// signature (and which is therefore hashed canonically, not raw).
pub const PLUGIN_MANIFEST: &str = "aura.plugin.json";

/// Compute the 32-byte digest of a bundle directory.
///
/// Errors are IO/parse only — an unsigned bundle still has a digest
/// (that's what `aura plugin sign` signs).
pub fn bundle_digest(dir: &Path) -> Result<[u8; 32], io::Error> {
    let manifest_path = dir.join(PLUGIN_MANIFEST);
    let raw = fs::read_to_string(&manifest_path)?;
    let mut manifest: Value = serde_json::from_str(&raw)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("{PLUGIN_MANIFEST}: {e}")))?;
    if let Some(obj) = manifest.as_object_mut() {
        obj.remove("signature");
    }
    let canon = canonical_json(&manifest);

    let mut hasher = Sha256::new();
    hasher.update(DIGEST_VERSION.as_bytes());
    hasher.update(b"\n");
    hasher.update(b"manifest\0");
    hasher.update(canon.as_bytes());
    hasher.update(b"\0");

    for (rel, abs) in collect_files(dir)? {
        let bytes = fs::read(&abs)?;
        let file_hash = hex(&Sha256::digest(&bytes));
        hasher.update(rel.as_bytes());
        hasher.update(b"\0");
        hasher.update(file_hash.as_bytes());
        hasher.update(b"\0");
    }

    Ok(hasher.finalize().into())
}

/// Every signed file under the bundle, as (relpath, abspath), sorted by
/// relpath bytes. Relpaths always use '/' separators so macOS/Linux and
/// a future Windows port hash identically.
///
/// Excluded by design:
/// - the plugin manifest itself (covered canonically — see crate docs)
/// - any path component starting with '.' (`.git`, `.DS_Store`, editor
///   droppings — they are not part of what runs)
/// - symlinks (a link must never extend the signed surface outside the
///   bundle; a signed bundle ships real files)
fn collect_files(root: &Path) -> Result<Vec<(String, PathBuf)>, io::Error> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else {
                continue; // non-UTF8 names can't be represented in the digest
            };
            if name_str.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let meta = fs::symlink_metadata(&path)?;
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                if dir == *root && name_str == PLUGIN_MANIFEST {
                    continue;
                }
                let rel = path
                    .strip_prefix(root)
                    .expect("walked path is under root")
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push((rel, path));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_bundle(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join(PLUGIN_MANIFEST),
            r#"{"id": "@t/x", "version": "0.1.0", "entry": "worker.js"}"#,
        )
        .unwrap();
        fs::write(dir.join("worker.js"), "console.log('hi')\n").unwrap();
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("assets/a.txt"), "a\n").unwrap();
    }

    #[test]
    fn digest_is_deterministic() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        let d1 = bundle_digest(tmp.path()).unwrap();
        let d2 = bundle_digest(tmp.path()).unwrap();
        assert_eq!(d1, d2);
    }

    #[test]
    fn manifest_key_order_does_not_change_digest() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        let d1 = bundle_digest(tmp.path()).unwrap();
        fs::write(
            tmp.path().join(PLUGIN_MANIFEST),
            r#"{"version": "0.1.0", "entry": "worker.js", "id": "@t/x"}"#,
        )
        .unwrap();
        let d2 = bundle_digest(tmp.path()).unwrap();
        assert_eq!(d1, d2);
    }

    #[test]
    fn signature_field_is_excluded_from_digest() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        let d1 = bundle_digest(tmp.path()).unwrap();
        fs::write(
            tmp.path().join(PLUGIN_MANIFEST),
            r#"{"id": "@t/x", "version": "0.1.0", "entry": "worker.js",
                "signature": {"algorithm": "ed25519", "publisher_key_id": "k", "signature": "s"}}"#,
        )
        .unwrap();
        let d2 = bundle_digest(tmp.path()).unwrap();
        assert_eq!(d1, d2, "embedding a signature must not change the digest");
    }

    #[test]
    fn editing_any_file_changes_digest() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        let d1 = bundle_digest(tmp.path()).unwrap();
        fs::write(tmp.path().join("worker.js"), "console.log('evil')\n").unwrap();
        let d2 = bundle_digest(tmp.path()).unwrap();
        assert_ne!(d1, d2);
    }

    #[test]
    fn adding_a_file_changes_digest() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        let d1 = bundle_digest(tmp.path()).unwrap();
        fs::write(tmp.path().join("extra.js"), "x").unwrap();
        let d2 = bundle_digest(tmp.path()).unwrap();
        assert_ne!(d1, d2);
    }

    #[test]
    fn manifest_capability_edit_changes_digest() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        let d1 = bundle_digest(tmp.path()).unwrap();
        fs::write(
            tmp.path().join(PLUGIN_MANIFEST),
            r#"{"id": "@t/x", "version": "0.1.0", "entry": "worker.js", "capabilities": ["fs:read:**"]}"#,
        )
        .unwrap();
        let d2 = bundle_digest(tmp.path()).unwrap();
        assert_ne!(d1, d2, "privilege escalation in the manifest must break the signature");
    }

    #[test]
    fn dotfiles_and_symlinks_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path());
        let d1 = bundle_digest(tmp.path()).unwrap();
        fs::write(tmp.path().join(".DS_Store"), "junk").unwrap();
        fs::create_dir_all(tmp.path().join(".git")).unwrap();
        fs::write(tmp.path().join(".git/config"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hosts", tmp.path().join("hosts-link")).unwrap();
        let d2 = bundle_digest(tmp.path()).unwrap();
        assert_eq!(d1, d2);
    }
}
