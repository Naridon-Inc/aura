//! File-backed outbox for offline-resilient team sync.
//!
//! Every push that the daemon attempts (live events, sync_push, messages,
//! zone ops, intent writes, resolutions, PR comments) is first written to
//! `.aura/outbox/<unix_ms>-<kind>.json`. The sync loop drains the outbox,
//! posts to the cloud, and `ack`s entries that were accepted (2xx). 5xx
//! failures keep the entry for retry; 4xx drops it (poison pill).
//!
//! Atomic writes via tmp-file + rename so a crash mid-write never leaves
//! a partial entry.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Cap on queued entries; when full, oldest non-intent events are dropped
/// so critical payloads (intents, sync_pushes) survive long outages.
pub const MAX_ENTRIES: usize = 10_000;

/// Kinds recorded in the filename for routing + filtering on drain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboxKind {
    Event,
    SyncPush,
    Message,
    Zone,
    Impact,
    Intent,
    Resolve,
    PrComment,
}

impl OutboxKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            OutboxKind::Event => "event",
            OutboxKind::SyncPush => "sync_push",
            OutboxKind::Message => "message",
            OutboxKind::Zone => "zone",
            OutboxKind::Impact => "impact",
            OutboxKind::Intent => "intent",
            OutboxKind::Resolve => "resolve",
            OutboxKind::PrComment => "pr_comment",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "event" => Some(Self::Event),
            "sync_push" => Some(Self::SyncPush),
            "message" => Some(Self::Message),
            "zone" => Some(Self::Zone),
            "impact" => Some(Self::Impact),
            "intent" => Some(Self::Intent),
            "resolve" => Some(Self::Resolve),
            "pr_comment" => Some(Self::PrComment),
            _ => None,
        }
    }

    /// Payloads that should never be evicted on overflow.
    pub fn critical(&self) -> bool {
        matches!(self, Self::Intent | Self::SyncPush | Self::Resolve)
    }
}

/// One queued outbox entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub kind: String,
    pub body: serde_json::Value,
    pub created_ms: u128,
    #[serde(default)]
    pub attempts: u32,
    /// Wall-clock ms of the most recent failed send. Drives the retry
    /// backoff so a down/5xx cloud isn't re-hit with the whole queue every
    /// drain cycle. `#[serde(default)]` (→ 0) keeps entries written before
    /// this field deserializable; 0 means "never attempted" → eligible now.
    #[serde(default)]
    pub last_attempt_ms: u128,
}

/// Handle to a loaded entry on disk — lets callers ack or retry.
#[derive(Debug)]
pub struct LoadedEntry {
    pub path: PathBuf,
    pub entry: Entry,
}

fn outbox_dir() -> PathBuf {
    PathBuf::from(".aura/outbox")
}

fn ensure_dir() -> std::io::Result<PathBuf> {
    let dir = outbox_dir();
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Enqueue a payload. Atomic write via tmp + rename.
/// On overflow, drops the oldest non-critical entry to make room.
pub fn enqueue(kind: OutboxKind, body: serde_json::Value) -> std::io::Result<PathBuf> {
    let dir = ensure_dir()?;

    if count_entries(&dir) >= MAX_ENTRIES {
        evict_oldest_non_critical(&dir);
    }

    let ts = now_ms();
    let entry = Entry {
        kind: kind.as_str().to_string(),
        body,
        created_ms: ts,
        attempts: 0,
        last_attempt_ms: 0,
    };

    let filename = format!(
        "{}-{}-{}.json",
        ts,
        kind.as_str(),
        uuid::Uuid::new_v4().simple()
    );
    let tmp_path = dir.join(format!(".tmp-{}", &filename));
    let final_path = dir.join(&filename);

    let json = serde_json::to_vec_pretty(&entry).map_err(std::io::Error::other)?;
    {
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(&json)?;
        f.sync_all()?;
    }
    fs::rename(&tmp_path, &final_path)?;
    Ok(final_path)
}

/// Load all current entries, optionally filtered by kind, oldest-first.
pub fn drain(kind_filter: Option<OutboxKind>) -> Vec<LoadedEntry> {
    let dir = match ensure_dir() {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };

    let mut entries: Vec<LoadedEntry> = Vec::new();
    let iter = match fs::read_dir(&dir) {
        Ok(it) => it,
        Err(_) => return entries,
    };
    for dent in iter.flatten() {
        let path = dent.path();
        if !path.is_file() {
            continue;
        }
        let fname = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s,
            None => continue,
        };
        if fname.starts_with(".tmp-") || !fname.ends_with(".json") {
            continue;
        }
        if let Some(k) = kind_filter {
            if !fname.contains(&format!("-{}-", k.as_str())) {
                continue;
            }
        }
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let entry: Entry = match serde_json::from_slice(&bytes) {
            Ok(e) => e,
            Err(_) => {
                // Corrupt entry — discard so it doesn't block the queue.
                let _ = fs::remove_file(&path);
                continue;
            }
        };
        entries.push(LoadedEntry { path, entry });
    }
    entries.sort_by_key(|e| e.entry.created_ms);
    entries
}

/// Remove an entry from the queue once its payload was accepted by the server.
pub fn ack(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Bump the retry count on an entry after a transient failure, stamping the
/// attempt time so the daemon's drain loop can back off before retrying.
/// Returns the updated attempt count.
pub fn bump_attempt(path: &Path) -> std::io::Result<u32> {
    let bytes = fs::read(path)?;
    let mut entry: Entry = serde_json::from_slice(&bytes).map_err(std::io::Error::other)?;
    entry.attempts = entry.attempts.saturating_add(1);
    entry.last_attempt_ms = now_ms();
    let json = serde_json::to_vec_pretty(&entry).map_err(std::io::Error::other)?;

    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(entry.attempts)
}

/// Backoff window (ms) before a previously-failed entry is retried, growing
/// with the attempt count so a down / 5xx cloud isn't re-hit with the whole
/// queue every drain cycle. Capped at 5 min: entries are **never dropped**
/// here (provenance must survive an outage) — they just retry progressively
/// less often as failures accumulate, then resume the moment the cloud
/// recovers. `attempts == 0` (fresh) → eligible immediately.
pub fn retry_backoff_ms(attempts: u32) -> u64 {
    if attempts == 0 {
        return 0;
    }
    const BASE_MS: u64 = 5_000;
    const CAP_MS: u64 = 5 * 60_000;
    let shift = (attempts - 1).min(6); // 5s,10s,20s,40s,80s,160s,300s(cap)
    BASE_MS.saturating_mul(1u64 << shift).min(CAP_MS)
}

/// Whether an entry is still inside its retry-backoff window and should be
/// skipped on a periodic drain. Fresh entries (`attempts == 0`) and entries
/// written before backoff tracking (`last_attempt_ms == 0`) are always
/// eligible. Explicit user-triggered drains ignore this and retry eagerly.
pub fn is_backing_off(entry: &Entry) -> bool {
    if entry.attempts == 0 || entry.last_attempt_ms == 0 {
        return false;
    }
    let elapsed = now_ms().saturating_sub(entry.last_attempt_ms);
    (elapsed as u64) < retry_backoff_ms(entry.attempts)
}

/// Number of entries currently pending.
pub fn len() -> usize {
    count_entries(&outbox_dir())
}

fn count_entries(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|it| {
            it.flatten()
                .filter(|d| {
                    d.file_name()
                        .to_str()
                        .map(|n| n.ends_with(".json") && !n.starts_with(".tmp-"))
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}

fn evict_oldest_non_critical(dir: &Path) {
    let entries = drain(None);
    for e in entries {
        let is_critical = OutboxKind::from_str(&e.entry.kind)
            .map(|k| k.critical())
            .unwrap_or(true); // unknown kinds treated as critical — don't evict
        if !is_critical {
            let _ = fs::remove_file(&e.path);
            return;
        }
    }
    // All entries critical — fall back to evicting the single oldest.
    let entries = drain(None);
    if let Some(oldest) = entries.first() {
        let _ = fs::remove_file(&oldest.path);
    }
    // Silence unused-var warning for `dir` under some configurations.
    let _ = dir;
}

/// Summary of a single drain run.
#[derive(Debug, Default)]
pub struct DrainReport {
    pub acked: usize,
    pub bumped: usize,
    pub dropped: usize,
}

/// Drain the outbox against `cloud_url` using Bearer `token`. 2xx → ack
/// (removed), 4xx → drop (poison), 5xx / network → bump attempt count.
/// Returns a summary so callers can report / fail loudly. Blocking
/// reqwest is fine here — outbox drain is an explicit user action.
pub fn drain_to_cloud(cloud_url: &str, token: &str) -> DrainReport {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new());
    let base = cloud_url.trim_end_matches('/');

    let mut report = DrainReport::default();
    for loaded in drain(None) {
        let kind = match OutboxKind::from_str(&loaded.entry.kind) {
            Some(k) => k,
            None => continue,
        };
        let url = match kind {
            OutboxKind::Event => format!("{}/api/v1/live/events", base),
            OutboxKind::Message => format!("{}/api/v1/live/messages", base),
            OutboxKind::SyncPush => format!("{}/api/v1/live/sync/push", base),
            OutboxKind::Impact => format!("{}/api/v1/live/impacts", base),
            OutboxKind::Intent => format!("{}/api/v1/live/intents", base),
            // Kinds without a stable v1 endpoint yet — leave queued.
            _ => {
                report.bumped += 1;
                let _ = bump_attempt(&loaded.path);
                continue;
            }
        };
        match client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&loaded.entry.body)
            .send()
        {
            Ok(resp) if resp.status().is_success() => {
                let _ = ack(&loaded.path);
                report.acked += 1;
            }
            Ok(resp) if resp.status().is_client_error() => {
                let _ = ack(&loaded.path);
                report.dropped += 1;
            }
            _ => {
                let _ = bump_attempt(&loaded.path);
                report.bumped += 1;
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    // The outbox is cwd-relative, so these tests mutate the process cwd —
    // serialize on the same crate-wide lock every other cwd-mutating test
    // uses, or parallel tests race (a sibling's dropped tempdir becomes our
    // cwd → spurious NotFound failures).
    use crate::TEST_CWD_LOCK as SERIAL;

    /// Restores the original cwd even when the closure panics, so one failing
    /// test can't strand later tests in a deleted tempdir.
    struct CwdGuard(PathBuf);
    impl Drop for CwdGuard {
        fn drop(&mut self) {
            let _ = std::env::set_current_dir(&self.0);
        }
    }

    fn in_tempdir<F: FnOnce()>(f: F) {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _g = CwdGuard(std::env::current_dir().unwrap());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_current_dir(tmp.path()).unwrap();
        f();
    }

    #[test]
    fn roundtrip_enqueue_drain_ack() {
        in_tempdir(|| {
            let p = enqueue(OutboxKind::Event, serde_json::json!({"hi": 1})).unwrap();
            assert!(p.exists());
            assert_eq!(len(), 1);

            let drained = drain(None);
            assert_eq!(drained.len(), 1);
            assert_eq!(drained[0].entry.body["hi"], 1);

            ack(&drained[0].path).unwrap();
            assert_eq!(len(), 0);
        });
    }

    #[test]
    fn kind_filter_matches() {
        in_tempdir(|| {
            enqueue(OutboxKind::Event, serde_json::json!({"a": 1})).unwrap();
            enqueue(OutboxKind::Intent, serde_json::json!({"b": 2})).unwrap();
            assert_eq!(drain(Some(OutboxKind::Intent)).len(), 1);
            assert_eq!(drain(Some(OutboxKind::Event)).len(), 1);
            assert_eq!(drain(None).len(), 2);
        });
    }

    #[test]
    fn bump_attempt_increments() {
        in_tempdir(|| {
            let p = enqueue(OutboxKind::Message, serde_json::json!({})).unwrap();
            assert_eq!(bump_attempt(&p).unwrap(), 1);
            assert_eq!(bump_attempt(&p).unwrap(), 2);
        });
    }

    #[test]
    fn retry_backoff_grows_and_caps() {
        assert_eq!(retry_backoff_ms(0), 0);
        assert_eq!(retry_backoff_ms(1), 5_000);
        assert_eq!(retry_backoff_ms(2), 10_000);
        assert_eq!(retry_backoff_ms(3), 20_000);
        // Saturates at the 5-minute cap and never grows past it.
        assert_eq!(retry_backoff_ms(7), 300_000);
        assert_eq!(retry_backoff_ms(50), 300_000);
        assert_eq!(retry_backoff_ms(u32::MAX), 300_000);
    }

    #[test]
    fn backing_off_gates_recent_failures_only() {
        // Fresh entry (no attempts) is always eligible.
        let mut e = Entry {
            kind: "event".into(),
            body: serde_json::json!({}),
            created_ms: 0,
            attempts: 0,
            last_attempt_ms: 0,
        };
        assert!(!is_backing_off(&e));

        // A just-failed entry is inside its window → skip this cycle.
        e.attempts = 1;
        e.last_attempt_ms = now_ms();
        assert!(is_backing_off(&e));

        // A failure long enough ago is eligible again.
        e.last_attempt_ms = now_ms().saturating_sub(10_000);
        assert!(!is_backing_off(&e)); // 10s elapsed > 5s window for attempt 1

        // Legacy entry with attempts but no timestamp → eligible (back-compat).
        e.last_attempt_ms = 0;
        assert!(!is_backing_off(&e));
    }
}
