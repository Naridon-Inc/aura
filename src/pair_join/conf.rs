//! The token file and the note beside it.
//!
//! `computer.conf` is the only place the computer's token lives. It is read by
//! systemd (`EnvironmentFile=`) or by `sh` (the LaunchAgent), so it is plain
//! `KEY=value` lines — and every value is checked before it is written, so
//! nothing in it can be read as anything but a value by either.
//!
//! `computer.json` says what this computer is connected to, without the token,
//! so `aura join` run twice and `aura leave` can answer in plain words.

use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Marks a token file this command wrote. A file without it belongs to an
/// Aura-managed computer, which this command never touches.
pub const JOINED_BY: &str = "AURA_JOINED_BY";
pub const JOINED_BY_PAIR: &str = "pair";

pub struct Conf {
    pub runner_token: String,
    pub place_id: String,
    pub cloud_url: String,
    pub workspaces: String,
}

// The token never reaches a log line or a panic message.
impl std::fmt::Debug for Conf {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Conf")
            .field("place_id", &self.place_id)
            .field("cloud_url", &self.cloud_url)
            .field("workspaces", &self.workspaces)
            .finish_non_exhaustive()
    }
}

pub fn render(c: &Conf) -> Result<String, String> {
    let mut out = String::new();
    for (k, v) in [
        (JOINED_BY, JOINED_BY_PAIR),
        ("AURA_RUNNER_TOKEN", c.runner_token.as_str()),
        ("AURA_PLACE_ID", c.place_id.as_str()),
        ("AURA_CLOUD_URL", c.cloud_url.as_str()),
        ("AURA_RUNNER_WORKSPACES", c.workspaces.as_str()),
    ] {
        out.push_str(k);
        out.push('=');
        out.push_str(&value(k, v)?);
        out.push('\n');
    }
    Ok(out)
}

/// A value both systemd and `sh` read as exactly itself.
///
/// Plain when it is only characters neither treats specially; single-quoted
/// when it has spaces (a home folder with a space in its name); refused when
/// it has anything that either one would expand, join or end early on.
fn value(key: &str, v: &str) -> Result<String, String> {
    if v.is_empty() {
        return Err(format!("{key} is empty"));
    }
    if v.bytes().all(|b| b.is_ascii_alphanumeric() || b"_:/.@+-".contains(&b)) {
        return Ok(v.to_string());
    }
    let unsafe_char = v
        .chars()
        .any(|c| c.is_control() || matches!(c, '\'' | '"' | '\\' | '$' | '`' | '%'));
    if unsafe_char {
        return Err(format!("{key} has characters that can't be written safely"));
    }
    Ok(format!("'{v}'"))
}

/// What a token file says, read back. Unknown lines are ignored.
#[derive(Default)]
pub struct Read {
    pub joined_by: Option<String>,
    pub runner_token: Option<String>,
    pub place_id: Option<String>,
    pub cloud_url: Option<String>,
}

impl Read {
    pub fn joined_by_pair(&self) -> bool {
        self.joined_by.as_deref() == Some(JOINED_BY_PAIR)
    }
}

pub fn parse(text: &str) -> Read {
    let mut r = Read::default();
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim().trim_matches('\'').trim_matches('"').to_string();
        if v.is_empty() {
            continue;
        }
        match k.trim() {
            JOINED_BY => r.joined_by = Some(v),
            "AURA_RUNNER_TOKEN" => r.runner_token = Some(v),
            "AURA_PLACE_ID" => r.place_id = Some(v),
            "AURA_CLOUD_URL" => r.cloud_url = Some(v),
            _ => {}
        }
    }
    r
}

/// The note beside the token.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct State {
    pub place_id: String,
    pub org_name: String,
    pub name: String,
    pub scope: String,
    pub cloud_url: String,
    pub joined_at: String,
    pub run_as: String,
}

pub fn read_state(path: &Path) -> Option<State> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Write `contents` to `path` so that nobody but its owner can ever read it —
/// not even for the moment between creating the file and narrowing its mode.
///
/// A temporary file is created `0600` in the same folder and renamed over the
/// old one, so a reader sees either the old file or the new one, never half.
/// `owner` hands the file to another account (the service account) before it
/// takes its name.
pub fn write_private(path: &Path, contents: &[u8], owner: Option<(u32, u32)>) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no folder", path.display()))?;
    private_dir(dir, owner)?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("aura"),
        std::process::id()
    ));
    let _ = std::fs::remove_file(&tmp);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let result = (|| {
        let mut f = opts
            .open(&tmp)
            .map_err(|e| format!("couldn't write {}: {e}", path.display()))?;
        f.write_all(contents)
            .and_then(|_| f.sync_all())
            .map_err(|e| format!("couldn't write {}: {e}", path.display()))?;
        if let Some((uid, gid)) = owner {
            chown(&tmp, uid, gid)?;
        }
        std::fs::rename(&tmp, path).map_err(|e| format!("couldn't write {}: {e}", path.display()))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Make `dir` (and any missing parents) and close it to everyone but `owner`.
/// Only the last folder is narrowed: parents like `~/.config` are the user's
/// own business.
pub fn private_dir(dir: &Path, owner: Option<(u32, u32)>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("couldn't make {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("couldn't close {}: {e}", dir.display()))?;
    }
    if let Some((uid, gid)) = owner {
        chown(dir, uid, gid)?;
    }
    Ok(())
}

#[cfg(unix)]
pub fn chown(path: &Path, uid: u32, gid: u32) -> Result<(), String> {
    std::os::unix::fs::chown(path, Some(uid), Some(gid))
        .map_err(|e| format!("couldn't hand {} to its account: {e}", path.display()))
}

#[cfg(not(unix))]
pub fn chown(_path: &Path, _uid: u32, _gid: u32) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conf() -> Conf {
        Conf {
            runner_token: "aura_runner_0123abcd".into(),
            place_id: "6f1c2a8e-1b2c-4d5e-8f90-123456789abc".into(),
            cloud_url: "https://api.auravcs.com".into(),
            workspaces: "/home/sam/.aura/computer/workspaces".into(),
        }
    }

    #[test]
    fn a_token_file_round_trips_and_is_marked_as_ours() {
        let text = render(&conf()).unwrap();
        assert!(text.starts_with("AURA_JOINED_BY=pair\n"));
        let r = parse(&text);
        assert!(r.joined_by_pair());
        assert_eq!(r.runner_token.as_deref(), Some("aura_runner_0123abcd"));
        assert_eq!(r.cloud_url.as_deref(), Some("https://api.auravcs.com"));
    }

    #[test]
    fn a_managed_computers_file_is_not_ours() {
        let managed = "AURA_RUNNER_TOKEN=aura_runner_x\nAURA_PLACE_ID=p\nAURA_CLOUD_URL=https://a\n";
        assert!(!parse(managed).joined_by_pair());
    }

    #[test]
    fn a_folder_with_a_space_is_quoted_and_anything_shell_like_is_refused() {
        let mut c = conf();
        c.workspaces = "/Users/Sam Lee/.aura/computer/workspaces".into();
        assert!(render(&c).unwrap().contains("AURA_RUNNER_WORKSPACES='/Users/Sam Lee/.aura/computer/workspaces'\n"));
        for bad in ["/x/$(id)", "/x/`id`", "/x/'q", "/x/a\nAURA_RUNNER_TOKEN=evil", "/x/%h", ""] {
            c.workspaces = bad.into();
            assert!(render(&c).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn debug_output_hides_the_token() {
        assert!(!format!("{:?}", conf()).contains("aura_runner_"));
    }

    #[test]
    fn a_private_file_is_owner_only_from_its_first_byte() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deep/computer.conf");
        write_private(&path, b"A=1\n", None).unwrap();
        write_private(&path, b"A=2\n", None).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "A=2\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(path.parent().unwrap()), 0o700);
        }
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }
}
