//! Keyfile storage. The 32-byte seed is written with mode 0600.
//!
//! Rotation: `rotate_key(path)` loads the existing key, generates a
//! fresh one, and replaces the file atomically (write-temp + rename).
//! The caller is responsible for emitting a `key_rotation` block signed
//! by the OLD key — that's what closes the chain a verifier walks back.

use std::io;
use std::io::{Read, Write};
use std::path::Path;

use crate::error::AttestationError;
use crate::keys::SigningKey;

#[cfg(unix)]
const KEY_MODE: u32 = 0o600;

pub fn save_signing_key(key: &SigningKey, path: &Path) -> Result<(), AttestationError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(KEY_MODE);
    }
    let mut f = opts.open(path)?;
    f.write_all(key.seed_bytes())?;
    f.flush()?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(KEY_MODE);
        std::fs::set_permissions(path, perms)?;
    }

    Ok(())
}

pub fn load_signing_key(path: &Path) -> Result<SigningKey, AttestationError> {
    let mut f = std::fs::File::open(path)?;
    let mut buf = Vec::with_capacity(32);
    f.read_to_end(&mut buf)?;
    if buf.len() != 32 {
        return Err(AttestationError::KeyfileLength(buf.len()));
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&buf);
    Ok(SigningKey::from_seed(seed))
}

/// Load the key at `path`, creating a fresh one if the file is absent.
/// Convenience entrypoint for callers that don't care about the
/// create-vs-load distinction.
pub fn load_or_create(path: &Path) -> Result<SigningKey, AttestationError> {
    match load_signing_key(path) {
        Ok(k) => Ok(k),
        Err(AttestationError::Io(e)) if e.kind() == io::ErrorKind::NotFound => {
            let k = SigningKey::generate();
            save_signing_key(&k, path)?;
            Ok(k)
        }
        Err(e) => Err(e),
    }
}

/// Rotate the keyfile at `path`. Errors if the file does not exist —
/// rotation is meaningful only when there is a prior identity to chain
/// from. On success, returns `(old_key, new_key)` so the caller can
/// emit a `key_rotation` block signed by `old_key` that names both
/// `key_id`s.
///
/// File replacement is atomic: the new seed is written to a sibling
/// temp file with mode 0600, then renamed over `path`. A crash mid-way
/// either leaves the original intact (rename hasn't happened) or the
/// new file in place (rename completed) — never a half-written keyfile.
pub fn rotate_key(path: &Path) -> Result<(SigningKey, SigningKey), AttestationError> {
    let old = load_signing_key(path)?;
    let new = SigningKey::generate();

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("signing.key");
    let tmp = parent.join(format!(".{}.rotate.tmp", file_name));

    // Mirror save_signing_key's mode handling, but write to the temp
    // path so the rename is atomic.
    let mut opts = std::fs::OpenOptions::new();
    opts.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(KEY_MODE);
    }
    let mut f = opts.open(&tmp)?;
    f.write_all(new.seed_bytes())?;
    f.flush()?;
    drop(f);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(KEY_MODE);
        std::fs::set_permissions(&tmp, perms)?;
    }

    std::fs::rename(&tmp, path)?;
    Ok((old, new))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn create_then_load_roundtrip() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("signing.key");
        let a = load_or_create(&p).unwrap();
        let b = load_or_create(&p).unwrap();
        assert_eq!(a.key_id(), b.key_id());
        assert_eq!(a.seed_bytes(), b.seed_bytes());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn rejects_wrong_length_keyfile() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("signing.key");
        std::fs::write(&p, b"only-five-bytes????").unwrap();
        let err = load_signing_key(&p).unwrap_err();
        assert!(matches!(err, AttestationError::KeyfileLength(_)));
    }

    #[test]
    fn rotate_writes_new_key_atomically_and_returns_pair() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("signing.key");
        let original = load_or_create(&p).unwrap();
        let original_id = original.key_id();

        let (old, new) = rotate_key(&p).unwrap();
        assert_eq!(old.key_id(), original_id, "old key matches what was on disk before rotate");
        assert_ne!(new.key_id(), original_id, "rotate produced a fresh key");

        // Disk now holds the NEW key.
        let after = load_signing_key(&p).unwrap();
        assert_eq!(after.key_id(), new.key_id());

        // No leftover temp file.
        let temp = dir.path().join(".signing.key.rotate.tmp");
        assert!(!temp.exists(), "rotation temp file was cleaned up via rename");

        // Permissions preserved on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn rotate_errors_when_no_prior_keyfile_exists() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("missing.key");
        let err = rotate_key(&p).unwrap_err();
        assert!(matches!(err, AttestationError::Io(_)),
            "rotate refuses to invent an identity from nothing");
    }

    #[test]
    fn sign_then_reload_then_verify() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("signing.key");
        let sk = load_or_create(&p).unwrap();
        let sig = sk.sign(b"payload");

        // Simulate a process restart: drop the key, reload from disk.
        drop(sk);
        let sk2 = load_signing_key(&p).unwrap();
        sk2.verifying_key()
            .verify(b"payload", &sig)
            .expect("reloaded key verifies signature from original instance");
    }
}
