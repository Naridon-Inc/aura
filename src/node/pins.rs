//! Client-side head-hash pinning for the signed ref-log (P2c) — rollback
//! detection layered on top of the tamper-evident chain.
//!
//! The ref-log (P2a) proves that a served history is *internally* consistent:
//! every entry is signed and hash-chained to its predecessor, so no entry can
//! be altered without breaking the chain. But a malicious or rewound node can
//! still serve a **shorter** chain that is perfectly valid on its own — drop
//! the last few entries and a force-push that erased a branch simply vanishes.
//! A single fetch cannot tell "this repo only ever had N entries" from "this
//! repo had N+3 and three were amputated."
//!
//! Detecting that needs *memory across fetches*. After verifying a ref-log the
//! client records the head it saw — the sequence number and the hash of the
//! entry at that sequence — into a small local pin store. On every later verify
//! it checks that the freshly-served log still contains that exact entry at
//! that exact sequence. Append-only growth passes; a log that shrank, or whose
//! pinned entry now hashes differently, is a rollback/fork and fails loudly.
//!
//! This is trust-on-first-use: the first pin is taken on faith, and from then
//! on silent history rewrites are caught. A stronger anchor (a shared,
//! append-only transparency log witnessed by third parties) is future work;
//! TOFU pinning is the same guarantee SSH host keys give and is enough to make
//! a rollback a detectable event rather than a silent one.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::reflog::SignedRefEntry;

/// File name of the per-user pin store under `~/.aura`.
pub const PINS_FILE: &str = "reflog-pins.json";

/// A remembered ref-log head for one repo: enough to detect a later rollback.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReflogPin {
    /// Aura repo id the pin is for.
    pub repo_id: String,
    /// Sequence number of the pinned head entry.
    pub seq: u64,
    /// `entry_hash` of the entry at `seq` (sha256 over its signing payload,
    /// which folds in the previous hash — so it commits to the whole prefix).
    pub head_hash: String,
    /// Total entries observed when the pin was taken/last advanced.
    pub count: usize,
    /// Where the log was fetched from when pinned (informational).
    pub source: String,
    /// First time this repo was pinned (unix seconds).
    pub first_seen: i64,
    /// Most recent time the pin was confirmed/advanced (unix seconds).
    pub last_seen: i64,
}

/// Outcome of checking a freshly-verified ref-log against a stored pin.
#[derive(Debug, Clone, PartialEq)]
pub enum PinVerdict {
    /// No prior pin for this repo — nothing to compare against (TOFU).
    FirstSight,
    /// The served log still contains the pinned head; it only grew (or was
    /// unchanged). `advanced` is how many entries were appended since the pin.
    Consistent { advanced: u64 },
    /// The served log diverged from what was pinned — the history was rewound,
    /// forked, or rewritten. `detail` explains how.
    Rollback { detail: String },
}

impl PinVerdict {
    /// True only for [`PinVerdict::Rollback`].
    pub fn is_rollback(&self) -> bool {
        matches!(self, PinVerdict::Rollback { .. })
    }
}

/// Default pin-store path: `~/.aura/reflog-pins.json`.
pub fn default_pins_path() -> PathBuf {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    home.join(".aura").join(PINS_FILE)
}

/// Load the pin store. A missing or empty file is an empty store, not an error.
pub fn load(path: &Path) -> Result<Vec<ReflogPin>, String> {
    match std::fs::read_to_string(path) {
        Ok(s) if s.trim().is_empty() => Ok(Vec::new()),
        Ok(s) => serde_json::from_str(&s)
            .map_err(|e| format!("parse pin store {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read pin store {}: {e}", path.display())),
    }
}

/// Persist the pin store, creating the parent directory and writing atomically
/// (temp file + rename) so a crash mid-write can't corrupt existing pins.
pub fn save(path: &Path, pins: &[ReflogPin]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
    }
    let json = serde_json::to_string_pretty(pins).map_err(|e| format!("encode pins: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename into {}: {e}", path.display()))?;
    Ok(())
}

/// Find the pin for `repo_id`, if any.
pub fn find<'a>(pins: &'a [ReflogPin], repo_id: &str) -> Option<&'a ReflogPin> {
    pins.iter().find(|p| p.repo_id == repo_id)
}

/// Insert `pin`, replacing any existing pin for the same repo.
pub fn upsert(pins: &mut Vec<ReflogPin>, pin: ReflogPin) {
    if let Some(slot) = pins.iter_mut().find(|p| p.repo_id == pin.repo_id) {
        *slot = pin;
    } else {
        pins.push(pin);
    }
}

/// Check a freshly-verified, seq-ordered set of ref-log entries against an
/// existing pin. `entries` must already have passed [`super::reflog::verify_chain`]
/// (so the chain itself is sound); this only compares against remembered state.
pub fn check(pin: Option<&ReflogPin>, entries: &[SignedRefEntry]) -> PinVerdict {
    let pin = match pin {
        None => return PinVerdict::FirstSight,
        Some(p) => p,
    };

    let top = match entries.iter().map(|e| e.seq).max() {
        None => {
            return PinVerdict::Rollback {
                detail: format!(
                    "log is now empty, but a head at seq {} was pinned ({} entr{} seen before)",
                    pin.seq,
                    pin.count,
                    plural(pin.count as u64)
                ),
            };
        }
        Some(t) => t,
    };

    if top < pin.seq {
        let gone = pin.seq - top;
        return PinVerdict::Rollback {
            detail: format!(
                "served head is at seq {top}, but seq {} was pinned — history shrank by {gone} entr{}",
                pin.seq,
                plural(gone)
            ),
        };
    }

    // The log is long enough to still hold the pinned entry; require it to be
    // present and byte-identical (same entry_hash).
    match entries.iter().find(|e| e.seq == pin.seq) {
        None => PinVerdict::Rollback {
            detail: format!("pinned entry at seq {} is missing from the served log", pin.seq),
        },
        Some(at) => {
            let h = at.entry_hash();
            if h != pin.head_hash {
                PinVerdict::Rollback {
                    detail: format!(
                        "entry at seq {} was rewritten (now {}…, pinned {}…) — the branch history diverged",
                        pin.seq,
                        short_hash(&h),
                        short_hash(&pin.head_hash)
                    ),
                }
            } else {
                PinVerdict::Consistent {
                    advanced: top - pin.seq,
                }
            }
        }
    }
}

/// Build a pin (or advance an existing one) from a verified set of entries.
/// Returns `None` if there is nothing to pin (empty log). `first_seen` is
/// carried over from `existing` when advancing.
pub fn build_pin(
    existing: Option<&ReflogPin>,
    entries: &[SignedRefEntry],
    source: &str,
    now: i64,
) -> Option<ReflogPin> {
    let head = entries.iter().max_by_key(|e| e.seq)?;
    let first_seen = existing.map(|p| p.first_seen).unwrap_or(now);
    Some(ReflogPin {
        repo_id: head.repo_id.clone(),
        seq: head.seq,
        head_hash: head.entry_hash(),
        count: entries.len(),
        source: source.to_string(),
        first_seen,
        last_seen: now,
    })
}

fn short_hash(h: &str) -> &str {
    &h[..h.len().min(12)]
}

fn plural(n: u64) -> &'static str {
    if n == 1 {
        "y"
    } else {
        "ies"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::reflog::{self, ZERO_OID};
    use aura_attestation::SigningKey;

    // Build a signed, chained ref-log of `n` single-branch pushes. Fully
    // deterministic given `(key, repo, n)`, so a longer chain shares the exact
    // prefix of a shorter one — which is what append-only growth looks like.
    fn chain(key: &SigningKey, repo: &str, n: u64) -> Vec<SignedRefEntry> {
        chain_salt(key, repo, n, 0)
    }

    // Like `chain`, but `salt` shifts the object ids so the produced history is
    // genuinely different content (a fork/rewrite), which changes every
    // `entry_hash` — what a rollback-that-diverges looks like on the wire.
    fn chain_salt(key: &SigningKey, repo: &str, n: u64, salt: u64) -> Vec<SignedRefEntry> {
        let mut prev = reflog::GENESIS_PREV.to_string();
        let mut out = Vec::new();
        for i in 0..n {
            let old = if i == 0 {
                ZERO_OID.to_string()
            } else {
                format!("{:040x}", i + salt)
            };
            let new = format!("{:040x}", i + 1 + salt);
            let e = SignedRefEntry::sign_new(
                i,
                prev.clone(),
                repo,
                "refs/heads/main",
                old,
                new,
                i as i64,
                key,
            );
            prev = e.entry_hash();
            out.push(e);
        }
        out
    }

    fn pin_from(entries: &[SignedRefEntry]) -> ReflogPin {
        build_pin(None, entries, "test", 1_000).expect("non-empty")
    }

    #[test]
    fn first_sight_when_no_pin() {
        let k = SigningKey::generate();
        let entries = chain(&k, "repo-a", 3);
        assert_eq!(check(None, &entries), PinVerdict::FirstSight);
    }

    #[test]
    fn append_only_growth_is_consistent() {
        let k = SigningKey::generate();
        let three = chain(&k, "repo-a", 3);
        let pin = pin_from(&three);
        // Grow to 5 entries (same prefix — deterministic chain).
        let five = chain(&k, "repo-a", 5);
        assert_eq!(three[2].entry_hash(), five[2].entry_hash()); // prefix identical
        assert_eq!(check(Some(&pin), &five), PinVerdict::Consistent { advanced: 2 });
    }

    #[test]
    fn unchanged_log_is_consistent_zero() {
        let k = SigningKey::generate();
        let three = chain(&k, "repo-a", 3);
        let pin = pin_from(&three);
        assert_eq!(check(Some(&pin), &three), PinVerdict::Consistent { advanced: 0 });
    }

    #[test]
    fn shrunk_log_is_rollback() {
        let k = SigningKey::generate();
        let five = chain(&k, "repo-a", 5);
        let pin = pin_from(&five);
        let three = chain(&k, "repo-a", 3);
        assert!(check(Some(&pin), &three).is_rollback());
    }

    #[test]
    fn rewritten_entry_is_rollback() {
        let k = SigningKey::generate();
        let good = chain(&k, "repo-a", 3);
        let pin = pin_from(&good);
        // A fork: same length and signer, but different content (salted oids),
        // so the entry at the pinned seq hashes differently.
        let forked = chain_salt(&k, "repo-a", 3, 100);
        assert!(check(Some(&pin), &forked).is_rollback());
    }

    #[test]
    fn same_content_resigned_is_not_a_rollback() {
        // The pin commits to history *content*, not the signer — a different
        // key serving identical content is caught by --expect-key, not the pin.
        let k = SigningKey::generate();
        let good = chain(&k, "repo-a", 3);
        let pin = pin_from(&good);
        let other = SigningKey::generate();
        let resigned = chain(&other, "repo-a", 3);
        assert_eq!(
            check(Some(&pin), &resigned),
            PinVerdict::Consistent { advanced: 0 }
        );
    }

    #[test]
    fn empty_served_log_against_pin_is_rollback() {
        let k = SigningKey::generate();
        let three = chain(&k, "repo-a", 3);
        let pin = pin_from(&three);
        assert!(check(Some(&pin), &[]).is_rollback());
    }

    #[test]
    fn load_missing_is_empty() {
        let p = std::env::temp_dir().join("aura-pins-does-not-exist-xyz.json");
        let _ = std::fs::remove_file(&p);
        assert_eq!(load(&p).unwrap(), Vec::new());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let k = SigningKey::generate();
        let entries = chain(&k, "repo-rt", 2);
        let pin = pin_from(&entries);
        let dir = std::env::temp_dir().join(format!("aura-pins-rt-{}", std::process::id()));
        let path = dir.join(PINS_FILE);
        let mut pins = Vec::new();
        upsert(&mut pins, pin.clone());
        save(&path, &pins).unwrap();
        let back = load(&path).unwrap();
        assert_eq!(back, vec![pin]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn upsert_replaces_same_repo() {
        let k = SigningKey::generate();
        let mut pins = Vec::new();
        upsert(&mut pins, pin_from(&chain(&k, "r", 2)));
        upsert(&mut pins, pin_from(&chain(&k, "r", 4)));
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].seq, 3); // seq of the 4th entry (0-indexed)
        assert_eq!(pins[0].count, 4);
    }

    #[test]
    fn build_pin_advances_but_keeps_first_seen() {
        let k = SigningKey::generate();
        let two = chain(&k, "r", 2);
        let first = build_pin(None, &two, "s", 100).unwrap();
        let four = chain(&k, "r", 4);
        let advanced = build_pin(Some(&first), &four, "s", 200).unwrap();
        assert_eq!(advanced.first_seen, 100); // preserved
        assert_eq!(advanced.last_seen, 200);
        assert_eq!(advanced.seq, 3);
    }
}
