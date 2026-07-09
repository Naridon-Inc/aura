//! Cross-platform secret storage with a dev-build file fallback.
//!
//! Release builds keep secrets in the OS keychain — macOS Keychain,
//! Windows Credential Manager, Linux Secret Service — via the `keyring`
//! crate. That is the right home for a signed, shipped app: the OS
//! encrypts the value at rest and binds the "always allow" grant to the
//! app's stable Developer-ID signature.
//!
//! Debug builds (`tauri dev`) store secrets in a `0600` file under
//! `~/.aura/dev-secrets/<service>.json` instead. The reason is a real
//! developer-experience trap: a dev binary is ad-hoc signed and its code
//! signature changes on *every* rebuild, so macOS Keychain treats each
//! launch as a brand-new program reaching for the same item and re-prompts
//! for the login-keychain password — even after "Always Allow", because
//! that grant was bound to the previous build's signature. The file store
//! sidesteps the keychain entirely so local development never hits that
//! prompt. It is compiled *out* of release builds.
//!
//! Both backends present the same `(service, account) → value` map and
//! the same contract: `get` returns `Ok(None)` when nothing is stored,
//! `delete` is idempotent, and every other failure is a real error.
//!
//! All four secret namespaces in the app route through here — integration
//! tokens (`aura-integrations`), MCP OAuth (`aura-mcp-oauth`), brain API
//! keys (`aura-shell`), and plugin secrets — so the dev fallback covers
//! all of them at once and the keychain service separation is preserved
//! one-file-per-service.

// ── Release: OS keychain ────────────────────────────────────────────────

/// Read a stored secret. `Ok(None)` means "nothing stored under this slot".
#[cfg(not(debug_assertions))]
pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
    let entry =
        keyring::Entry::new(service, account).map_err(|e| format!("keyring entry: {e}"))?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring get: {e}")),
    }
}

/// Store a secret, overwriting any existing value.
#[cfg(not(debug_assertions))]
pub fn set(service: &str, account: &str, value: &str) -> Result<(), String> {
    let entry =
        keyring::Entry::new(service, account).map_err(|e| format!("keyring entry: {e}"))?;
    entry
        .set_password(value)
        .map_err(|e| format!("keyring set: {e}"))
}

/// Delete a secret. Idempotent — removing an absent slot is a no-op.
#[cfg(not(debug_assertions))]
pub fn delete(service: &str, account: &str) -> Result<(), String> {
    let entry =
        keyring::Entry::new(service, account).map_err(|e| format!("keyring entry: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete: {e}")),
    }
}

// ── Debug: 0600 file under ~/.aura/dev-secrets ──────────────────────────

#[cfg(debug_assertions)]
pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
    file::get_in(&file::store_dir()?, service, account)
}

#[cfg(debug_assertions)]
pub fn set(service: &str, account: &str, value: &str) -> Result<(), String> {
    file::set_in(&file::store_dir()?, service, account, value)
}

#[cfg(debug_assertions)]
pub fn delete(service: &str, account: &str) -> Result<(), String> {
    file::delete_in(&file::store_dir()?, service, account)
}

/// File-backed secret store, used only in debug builds. Kept as a small
/// directory-parameterised core (`*_in`) so it can be unit-tested against
/// a tempdir without touching the real `~/.aura`.
#[cfg(debug_assertions)]
mod file {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    /// `~/.aura/dev-secrets` — sibling of the other home-scoped Aura state
    /// (`~/.aura/manager-sessions`, `~/.aura/settings.toml`). Deliberately
    /// the *home* `.aura`, never the repo's git-tracked `.aura/`, so a dev
    /// secret can't be committed.
    pub fn store_dir() -> Result<PathBuf, String> {
        let home = dirs::home_dir().ok_or_else(|| "no home directory".to_string())?;
        Ok(home.join(".aura").join("dev-secrets"))
    }

    /// One file per keychain service. Service names here are fixed slugs
    /// (`aura-integrations`, …) but we sanitise anyway so an odd char can
    /// never escape the directory.
    fn sanitize(service: &str) -> String {
        service
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    }

    fn path_for(dir: &Path, service: &str) -> PathBuf {
        dir.join(format!("{}.json", sanitize(service)))
    }

    fn read_map(dir: &Path, service: &str) -> Result<BTreeMap<String, String>, String> {
        let p = path_for(dir, service);
        match std::fs::read(&p) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("decode {}: {e}", p.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(format!("read {}: {e}", p.display())),
        }
    }

    fn write_map(
        dir: &Path,
        service: &str,
        map: &BTreeMap<String, String>,
    ) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
        let p = path_for(dir, service);
        let tmp = p.with_extension("json.tmp");
        let bytes =
            serde_json::to_vec_pretty(map).map_err(|e| format!("encode: {e}"))?;
        std::fs::write(&tmp, &bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        restrict(&tmp)?;
        // Atomic swap so a crash mid-write can't leave a half-file.
        std::fs::rename(&tmp, &p).map_err(|e| format!("rename {}: {e}", p.display()))?;
        restrict(&p)?;
        Ok(())
    }

    /// Owner-only (0600) so a stray secret file isn't world-readable.
    #[cfg(unix)]
    fn restrict(p: &Path) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod {}: {e}", p.display()))
    }

    #[cfg(not(unix))]
    fn restrict(_p: &Path) -> Result<(), String> {
        Ok(())
    }

    pub fn get_in(dir: &Path, service: &str, account: &str) -> Result<Option<String>, String> {
        Ok(read_map(dir, service)?.get(account).cloned())
    }

    pub fn set_in(
        dir: &Path,
        service: &str,
        account: &str,
        value: &str,
    ) -> Result<(), String> {
        let mut map = read_map(dir, service)?;
        map.insert(account.to_string(), value.to_string());
        write_map(dir, service, &map)
    }

    pub fn delete_in(dir: &Path, service: &str, account: &str) -> Result<(), String> {
        let mut map = read_map(dir, service)?;
        if map.remove(account).is_some() {
            write_map(dir, service, &map)?;
        }
        Ok(())
    }
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::file;

    #[test]
    fn file_store_roundtrips_and_is_owner_only() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();

        // Absent → None.
        assert_eq!(file::get_in(dir, "aura-integrations", "jira").unwrap(), None);

        // Set then read back.
        file::set_in(dir, "aura-integrations", "jira", "tok-1").unwrap();
        assert_eq!(
            file::get_in(dir, "aura-integrations", "jira").unwrap(),
            Some("tok-1".to_string())
        );

        // A second account shares the service file without clobbering the first.
        file::set_in(dir, "aura-integrations", "github", "tok-2").unwrap();
        assert_eq!(
            file::get_in(dir, "aura-integrations", "github").unwrap(),
            Some("tok-2".to_string())
        );
        assert_eq!(
            file::get_in(dir, "aura-integrations", "jira").unwrap(),
            Some("tok-1".to_string())
        );

        // Overwrite.
        file::set_in(dir, "aura-integrations", "jira", "tok-1b").unwrap();
        assert_eq!(
            file::get_in(dir, "aura-integrations", "jira").unwrap(),
            Some("tok-1b".to_string())
        );

        // Delete is real, and deleting an absent slot is a no-op.
        file::delete_in(dir, "aura-integrations", "jira").unwrap();
        assert_eq!(file::get_in(dir, "aura-integrations", "jira").unwrap(), None);
        file::delete_in(dir, "aura-integrations", "absent").unwrap();

        // Different services land in different files (mirrors keychain separation).
        file::set_in(dir, "aura-shell", "anthropic", "sk-xxx").unwrap();
        assert!(dir.join("aura-shell.json").exists());
        assert!(dir.join("aura-integrations.json").exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("aura-shell.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "secret file must be owner-only");
        }
    }
}
