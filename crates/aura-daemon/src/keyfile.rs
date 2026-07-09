//! Keyfile management. 32-byte random secret, written 0600.
//!
//! Policy: if `daemon.key` already exists we *reuse* it rather than
//! overwriting. This matches the architecture doc's goal of stable local
//! auth — clients that cached the secret across daemon restarts keep
//! working. Rotation is a separate, explicit capability (future wave).

use std::io;
use std::path::Path;

use rand::{thread_rng, RngCore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use aura_daemon_client::error::{ProtocolError, ProtocolErrorKind};

pub const KEY_LEN: usize = 32;

#[cfg(unix)]
const KEY_MODE: u32 = 0o600;

/// Ensure the parent directory exists with mode 0700 (owner-only).
pub async fn ensure_dir(dir: &Path) -> Result<(), ProtocolError> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(ProtocolError::from_io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o700);
        std::fs::set_permissions(dir, perms).map_err(ProtocolError::from_io)?;
    }
    Ok(())
}

/// Load the existing keyfile or create a new one. Returns the 32-byte secret.
pub async fn load_or_create(path: &Path) -> Result<Vec<u8>, ProtocolError> {
    if tokio::fs::try_exists(path).await.unwrap_or(false) {
        let secret = read_existing(path).await?;
        if secret.len() == KEY_LEN {
            return Ok(secret);
        }
        return Err(ProtocolError::new(
            ProtocolErrorKind::Handshake,
            format!(
                "existing daemon.key has wrong length {} (expected {})",
                secret.len(),
                KEY_LEN
            ),
        ));
    }

    let mut secret = vec![0u8; KEY_LEN];
    thread_rng().fill_bytes(&mut secret);
    write_new(path, &secret).await?;
    Ok(secret)
}

async fn read_existing(path: &Path) -> Result<Vec<u8>, ProtocolError> {
    let mut f = tokio::fs::File::open(path)
        .await
        .map_err(ProtocolError::from_io)?;
    let mut buf = Vec::with_capacity(KEY_LEN);
    f.read_to_end(&mut buf)
        .await
        .map_err(ProtocolError::from_io)?;
    Ok(buf)
}

async fn write_new(path: &Path, secret: &[u8]) -> Result<(), ProtocolError> {
    let mut opts = tokio::fs::OpenOptions::new();
    opts.create_new(true).write(true);
    #[cfg(unix)]
    {
        opts.mode(KEY_MODE);
    }
    let mut f = match opts.open(path).await {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            // Raced with another process writing the same keyfile.
            // Load whatever landed instead of clobbering.
            return Err(ProtocolError::from_io(e));
        }
        Err(e) => return Err(ProtocolError::from_io(e)),
    };
    f.write_all(secret).await.map_err(ProtocolError::from_io)?;
    f.flush().await.map_err(ProtocolError::from_io)?;

    // Belt-and-braces: explicitly reassert 0600 in case the umask clipped us.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(KEY_MODE);
        std::fs::set_permissions(path, perms).map_err(ProtocolError::from_io)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn creates_32_byte_keyfile() {
        let dir = TempDir::new().unwrap();
        ensure_dir(dir.path()).await.unwrap();
        let path = dir.path().join("daemon.key");
        let a = load_or_create(&path).await.unwrap();
        assert_eq!(a.len(), 32);

        let b = load_or_create(&path).await.unwrap();
        assert_eq!(a, b, "second call must return the same secret");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[tokio::test]
    async fn rejects_wrong_length_keyfile() {
        let dir = TempDir::new().unwrap();
        ensure_dir(dir.path()).await.unwrap();
        let path = dir.path().join("daemon.key");
        tokio::fs::write(&path, b"short").await.unwrap();
        let err = load_or_create(&path).await.unwrap_err();
        assert!(matches!(err.kind, ProtocolErrorKind::Handshake));
    }
}
