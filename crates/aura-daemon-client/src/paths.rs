//! Platform-specific resolution of the daemon's socket + keyfile paths.
//!
//! macOS: `~/Library/Application Support/aura/{daemon.sock, daemon.key}`
//! Linux / other: `~/.aura/{daemon.sock, daemon.key}`
//!
//! Callers pass explicit paths in tests (via `DaemonPaths::custom`) so the
//! integration suite never touches a user's real socket.

use std::path::{Path, PathBuf};

use crate::error::{ProtocolError, ProtocolErrorKind};

#[derive(Debug, Clone)]
pub struct DaemonPaths {
    pub dir: PathBuf,
    pub socket: PathBuf,
    pub keyfile: PathBuf,
}

impl DaemonPaths {
    pub fn platform_default() -> Result<Self, ProtocolError> {
        let home = std::env::var_os("HOME").ok_or_else(|| {
            ProtocolError::new(
                ProtocolErrorKind::Unavailable,
                "HOME environment variable is not set",
            )
        })?;
        let home = PathBuf::from(home);

        let dir = if cfg!(target_os = "macos") {
            home.join("Library")
                .join("Application Support")
                .join("aura")
        } else {
            home.join(".aura")
        };

        Ok(Self::custom(dir))
    }

    pub fn custom(dir: impl Into<PathBuf>) -> Self {
        let dir = dir.into();
        let socket = dir.join("daemon.sock");
        let keyfile = dir.join("daemon.key");
        Self {
            dir,
            socket,
            keyfile,
        }
    }

    pub fn with_names(dir: impl Into<PathBuf>, socket_name: &str, key_name: &str) -> Self {
        let dir = dir.into();
        let socket = dir.join(socket_name);
        let keyfile = dir.join(key_name);
        Self {
            dir,
            socket,
            keyfile,
        }
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    pub fn keyfile(&self) -> &Path {
        &self.keyfile
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_layout() {
        let p = DaemonPaths::custom("/tmp/aura-test");
        assert_eq!(p.socket(), Path::new("/tmp/aura-test/daemon.sock"));
        assert_eq!(p.keyfile(), Path::new("/tmp/aura-test/daemon.key"));
    }
}
