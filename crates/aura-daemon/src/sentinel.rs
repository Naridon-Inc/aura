//! Sentinel mailbox writer.
//!
//! aura-cli's `SentinelManager::send_message` writes per-message JSON
//! files into `<root>/messages/` and touches `<root>/unread_pending`. The
//! daemon SendMessage RPC is a direct pass-through: same schema, same
//! layout, so a message written here is indistinguishable from one sent
//! via `aura_sentinel_send` — and the same inbox readers pick it up.
//!
//! Keeping the writer in the daemon (vs depending on aura-cli) avoids a
//! bin → lib inversion. The schema is stable; if it ever changes, both
//! sides update together.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use aura_daemon_client::error::{ProtocolError, ProtocolErrorKind};

/// Wire shape of a sentinel message on disk. Byte-for-byte compatible
/// with `aura-cli::sentinel::SentinelMessage` so the same inbox reader
/// handles both writers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SentinelMessage {
    pub id: String,
    pub from_session: String,
    pub from_agent: String,
    /// `None` is a broadcast to every active session.
    pub to_session: Option<String>,
    pub content: String,
    pub timestamp: u64,
    /// Sessions that have read the message. The sender is treated as
    /// having read their own message (matches aura-cli behaviour).
    pub read_by: Vec<String>,
}

/// Write a sentinel message under `root`. Returns the generated message
/// id so the caller can echo it back over the RPC for logging.
pub fn send_message(
    root: &Path,
    from_session: &str,
    from_agent: &str,
    to_session: Option<&str>,
    content: &str,
) -> Result<String, ProtocolError> {
    let messages_dir = root.join("messages");
    fs::create_dir_all(&messages_dir).map_err(|e| io_err("create messages dir", e))?;

    // aura-cli's inbox keys messages by id and uses a short random
    // prefix (first 8 chars of a v4 UUID). Match the exact shape so
    // both writers stay schema-compatible.
    let id = format!(
        "msg-{}",
        &Uuid::new_v4().to_string()[..8],
    );
    let msg = SentinelMessage {
        id: id.clone(),
        from_session: from_session.to_string(),
        from_agent: from_agent.to_string(),
        to_session: to_session.map(str::to_string),
        content: content.to_string(),
        timestamp: now_secs(),
        read_by: vec![from_session.to_string()],
    };

    let path = messages_dir.join(format!("{id}.json"));
    let json = serde_json::to_vec_pretty(&msg).map_err(|e| {
        ProtocolError::new(
            ProtocolErrorKind::Codec,
            format!("sentinel message encode: {e}"),
        )
    })?;
    atomic_write(&path, &json)?;

    // The unread marker is an mtime-only file that aura-cli's inbox
    // poller stats to detect "something new" without scanning the
    // messages dir every tick. Touch it on every send so receivers
    // across worktrees notice the delivery on their next check.
    let marker = root.join("unread_pending");
    touch(&marker)?;

    Ok(id)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), ProtocolError> {
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| io_err("tmp create", e))?;
        f.write_all(bytes).map_err(|e| io_err("tmp write", e))?;
        f.sync_all().map_err(|e| io_err("tmp sync", e))?;
    }
    fs::rename(&tmp, path).map_err(|e| io_err("rename", e))
}

fn touch(path: &Path) -> Result<(), ProtocolError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err("marker parent", e))?;
    }
    // Opening with create+write-truncate updates mtime. Content stays
    // empty — aura-cli treats the file's existence + mtime as the
    // signal, not its body.
    let _ = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|e| io_err("marker open", e))?;
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn io_err(what: &str, e: std::io::Error) -> ProtocolError {
    ProtocolError::new(
        ProtocolErrorKind::Unavailable,
        format!("sentinel {what}: {e}"),
    )
}

/// Mode attached to a zone claim. Matches aura-cli's `ZoneMode` so the
/// same JSON file is readable by both sides. `Warn` is advisory (other
/// agents see "x holds zone y"); `Block` hardens it into a gate that
/// aura-cli can use to stop conflicting edits.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ZoneMode {
    Warn,
    Block,
}

/// On-disk shape of a zone rule. Byte-for-byte compatible with
/// `aura-cli::sentinel::ZoneRule`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneRule {
    pub zone_id: String,
    pub session_id: String,
    pub patterns: Vec<String>,
    pub mode: ZoneMode,
}

/// Write a zone claim under `root`. Returns the zone id so the RPC can
/// echo it back to the caller (useful for later release).
pub fn claim_zone(
    root: &Path,
    session_id: &str,
    patterns: Vec<String>,
    mode: ZoneMode,
) -> Result<String, ProtocolError> {
    let zones_dir = root.join("zones");
    fs::create_dir_all(&zones_dir).map_err(|e| io_err("create zones dir", e))?;

    let zone_id = format!("zone-{}", &Uuid::new_v4().to_string()[..8]);
    let zone = ZoneRule {
        zone_id: zone_id.clone(),
        session_id: session_id.to_string(),
        patterns,
        mode,
    };

    let path = zones_dir.join(format!("{zone_id}.json"));
    let json = serde_json::to_vec_pretty(&zone).map_err(|e| {
        ProtocolError::new(ProtocolErrorKind::Codec, format!("zone encode: {e}"))
    })?;
    atomic_write(&path, &json)?;

    Ok(zone_id)
}

/// Resolve the default sentinel root inside a directory's `.aura/` tree.
/// Used by tests and the aura-term embedded daemon to place the mailbox
/// in the worktree's `.aura/sentinel/` — the same location aura-cli's
/// CLI sentinel code targets.
pub fn default_root_for(dir: &Path) -> PathBuf {
    dir.join(".aura").join("sentinel")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn send_creates_message_and_touches_marker() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();

        let id = send_message(
            &root,
            "session-a",
            "claude-opus",
            Some("session-b"),
            "hello from daemon",
        )
        .expect("send ok");

        assert!(id.starts_with("msg-"));
        let path = root.join("messages").join(format!("{id}.json"));
        let raw = fs::read_to_string(&path).unwrap();
        let back: SentinelMessage = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.id, id);
        assert_eq!(back.from_session, "session-a");
        assert_eq!(back.from_agent, "claude-opus");
        assert_eq!(back.to_session.as_deref(), Some("session-b"));
        assert_eq!(back.content, "hello from daemon");
        assert_eq!(back.read_by, vec!["session-a".to_string()]);
        assert!(back.timestamp > 0);

        // Marker file exists.
        assert!(root.join("unread_pending").exists());
    }

    #[test]
    fn broadcast_message_has_no_target() {
        let tmp = TempDir::new().unwrap();
        let id = send_message(tmp.path(), "sess", "agent", None, "broadcast").unwrap();
        let path = tmp.path().join("messages").join(format!("{id}.json"));
        let back: SentinelMessage =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(back.to_session.is_none());
    }

    #[test]
    fn two_sends_produce_distinct_files() {
        let tmp = TempDir::new().unwrap();
        let a = send_message(tmp.path(), "s", "a", None, "one").unwrap();
        let b = send_message(tmp.path(), "s", "a", None, "two").unwrap();
        assert_ne!(a, b);
        let dir = tmp.path().join("messages");
        let count = fs::read_dir(&dir).unwrap().count();
        assert_eq!(count, 2);
    }
}
