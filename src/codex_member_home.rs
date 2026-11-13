//! A Codex home of the acting member's own, on a shared box.
//!
//! A member who signs Codex in with their ChatGPT plan saves Codex's
//! `auth.json`. The cloud hands it to the run in [`CODEX_AUTH_JSON_VAR`], a
//! variable Codex does not read. Here it becomes a file: `auth.json`, mode
//! 0600, in a directory only this box's user can open, keyed by the member. The
//! child gets `CODEX_HOME` pointing at it, and the variable itself is removed,
//! so the JSON is never in any process's environment or argv.
//!
//! Codex refreshes its tokens and rewrites `auth.json` as it goes, and a
//! refresh token is good for one use. So the file is written only when it is
//! missing or the member saved a different sign-in since; otherwise the copy
//! Codex keeps current is left alone.
//!
//! The box's own `config.toml` comes along (MCP servers, model, defaults), with
//! the credential store forced to `file` so Codex reads the `auth.json` here
//! instead of a keyring.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// The variable the cloud hands a ChatGPT plan sign-in in. Never reaches Codex.
pub const CODEX_AUTH_JSON_VAR: &str = "AURA_CODEX_AUTH_JSON";

/// Records which saved sign-in the `auth.json` beside it was written from.
const SEEDED_MARK: &str = ".aura-seeded";

/// Where members' Codex homes live on this box: `~/.aura/agent-homes/codex`.
pub fn homes_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME isn't set, so there's nowhere to keep the member's Codex sign-in")?;
    Ok(PathBuf::from(home).join(".aura").join("agent-homes").join("codex"))
}

/// The box's own Codex config, if it has one.
pub fn box_config() -> Option<String> {
    let dir = std::env::var("CODEX_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".codex")))?;
    fs::read_to_string(dir.join("config.toml")).ok()
}

/// One member's directory under `root`. The member's id is hashed, so nothing
/// in it can climb out of `root` and the name says nothing about who it is.
pub fn member_dir(root: &Path, member: &str) -> PathBuf {
    let digest = Sha256::digest(format!("aura-codex-home:{member}").as_bytes());
    root.join(hex::encode(&digest[..16]))
}

/// What seeding did, for the log. Never a value.
#[derive(Debug, PartialEq, Eq)]
pub enum Seeded {
    /// `auth.json` was written from the member's saved sign-in.
    Written,
    /// The member's `auth.json` was already from this sign-in; Codex's own
    /// refreshed copy was kept.
    Kept,
}

/// Write the member's Codex home under `root` from `auth_json`, with
/// `box_config` as its `config.toml`. Returns the directory to use as
/// `CODEX_HOME`.
pub fn seed(root: &Path, member: &str, auth_json: &str, box_config: Option<&str>) -> Result<(PathBuf, Seeded), String> {
    let dir = member_dir(root, member);
    private_dir(root)?;
    private_dir(&dir)?;

    let mark = hex::encode(Sha256::digest(auth_json.as_bytes()));
    let auth = dir.join("auth.json");
    let unchanged = auth.is_file() && fs::read_to_string(dir.join(SEEDED_MARK)).is_ok_and(|m| m.trim() == mark);
    let seeded = if unchanged {
        Seeded::Kept
    } else {
        write_private(&dir, "auth.json", auth_json.as_bytes())?;
        write_private(&dir, SEEDED_MARK, mark.as_bytes())?;
        Seeded::Written
    };
    write_private(&dir, "config.toml", config_for_member(box_config).as_bytes())?;
    Ok((dir, seeded))
}

/// The box's config with the credential store forced to `file`. A top-level
/// key has to come before the first table, so the forced key goes first and
/// any top-level one the box set is dropped.
pub fn config_for_member(box_config: Option<&str>) -> String {
    let mut out = String::from("cli_auth_credentials_store = \"file\"\n");
    let mut in_table = false;
    for line in box_config.unwrap_or("").lines() {
        let t = line.trim_start();
        if t.starts_with('[') {
            in_table = true;
        }
        let key = t.split(['=', ' ', '\t']).next().unwrap_or("");
        if !in_table && key == "cli_auth_credentials_store" {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn private_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("making the member's Codex home: {e}"))?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("locking the member's Codex home: {e}"))
}

/// Write `name` in `dir` as 0600, through a temporary file and a rename, so
/// Codex never reads half a file.
fn write_private(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let tmp = dir.join(format!(".{name}.tmp"));
    let _ = fs::remove_file(&tmp);
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| format!("writing the member's Codex {name}: {e}"))?;
    f.write_all(bytes)
        .and_then(|_| f.sync_all())
        .map_err(|e| format!("writing the member's Codex {name}: {e}"))?;
    fs::rename(&tmp, dir.join(name)).map_err(|e| format!("writing the member's Codex {name}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mode(p: &Path) -> u32 {
        fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn the_sign_in_becomes_a_private_file_in_a_private_home() {
        let root = tempfile::tempdir().unwrap();
        let (dir, s) = seed(root.path(), "member-1", r#"{"tokens":{"refresh_token":"fake-1"}}"#, None).unwrap();
        assert_eq!(s, Seeded::Written);
        assert!(dir.starts_with(root.path()));
        assert_eq!(fs::read_to_string(dir.join("auth.json")).unwrap(), r#"{"tokens":{"refresh_token":"fake-1"}}"#);
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join("auth.json")), 0o600);
        assert_eq!(mode(&dir.join("config.toml")), 0o600);
    }

    #[test]
    fn codex_s_refreshed_copy_is_kept_until_the_member_saves_another() {
        let root = tempfile::tempdir().unwrap();
        let saved = r#"{"tokens":{"refresh_token":"fake-1"}}"#;
        let (dir, _) = seed(root.path(), "m", saved, None).unwrap();
        // Codex refreshed and rewrote its file.
        fs::write(dir.join("auth.json"), r#"{"tokens":{"refresh_token":"fake-2"}}"#).unwrap();
        let (_, s) = seed(root.path(), "m", saved, None).unwrap();
        assert_eq!(s, Seeded::Kept);
        assert!(fs::read_to_string(dir.join("auth.json")).unwrap().contains("fake-2"));
        // The member reconnected: the new sign-in wins.
        let (_, s) = seed(root.path(), "m", r#"{"tokens":{"refresh_token":"fake-3"}}"#, None).unwrap();
        assert_eq!(s, Seeded::Written);
        assert!(fs::read_to_string(dir.join("auth.json")).unwrap().contains("fake-3"));
        // Codex's file went missing: written again.
        fs::remove_file(dir.join("auth.json")).unwrap();
        let (_, s) = seed(root.path(), "m", r#"{"tokens":{"refresh_token":"fake-3"}}"#, None).unwrap();
        assert_eq!(s, Seeded::Written);
    }

    #[test]
    fn members_get_separate_homes_named_by_nothing_they_typed() {
        let root = Path::new("/box");
        let a = member_dir(root, "alice");
        assert_ne!(a, member_dir(root, "bob"));
        assert_eq!(a.parent(), Some(root));
        assert!(!a.to_string_lossy().contains("alice"));
        assert_eq!(member_dir(root, "../../etc").parent(), Some(root));
    }

    #[test]
    fn the_box_config_comes_along_with_the_store_forced_to_file() {
        let box_cfg = "model = \"gpt-5\"\ncli_auth_credentials_store = \"keyring\"\n\n[mcp_servers.aura]\ncommand = \"aura\"\ncli_auth_credentials_store = \"x\"\n";
        let got = config_for_member(Some(box_cfg));
        assert!(got.starts_with("cli_auth_credentials_store = \"file\"\n"));
        assert!(!got.contains("\"keyring\""));
        assert!(got.contains("model = \"gpt-5\""));
        assert!(got.contains("[mcp_servers.aura]\ncommand = \"aura\""));
        assert!(got.contains("cli_auth_credentials_store = \"x\""), "a key inside a table is not the top-level one");
        assert_eq!(config_for_member(None), "cli_auth_credentials_store = \"file\"\n");
    }
}
