//! Tamper-evident, signed ref-log for a hosted repo.
//!
//! Plain git hosting is trust-me: the host can rewrite branch history and no
//! client can tell. This module is the sovereign-substrate answer — every ref
//! update the node accepts is recorded as a **signed, hash-chained** entry, so
//! any client can fetch the log and prove for itself that the branch history it
//! sees is the history the node actually served, in order, with nothing
//! inserted, dropped, or rewritten.
//!
//! Each entry is one line of NDJSON in `<repo>.git/aura-reflog.jsonl`:
//!   * `seq`  — 0-based position; must equal the line's index (no gaps).
//!   * `prev` — the [`SignedRefEntry::entry_hash`] of the previous entry
//!     (empty for `seq 0`). This is the chain link: remove, reorder, or edit
//!     any earlier entry and every later `prev` stops matching.
//!   * `ref` / `old` / `new` — which ref moved and between which oids
//!     (`old`/`new` are the 40-hex zero oid for a create / delete).
//!   * `signer` / `pubkey` / `sig` — Ed25519 over [`SignedRefEntry::signing_payload`].
//!     The full pubkey is embedded, so an entry is self-certifying: a verifier
//!     needs nothing but the line itself (and, for trust, to confirm the signer
//!     is the node they expect).
//!
//! What this proves and what it doesn't: the chain detects any tampering with,
//! insertion into, or reordering *within* the log. It does **not** by itself
//! detect a wholesale rollback (dropping a suffix of entries) — the remaining
//! prefix is still internally valid. A client that remembers the last head hash
//! it saw (trust-on-first-use) gets rollback detection for free; a shared
//! transparency log would make it universal. That is P2's next increment.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use aura_attestation::{SignatureBytes, SigningKey, VerifyingKey};

/// Signed-entry schema version, bound into the signature so the payload layout
/// is unambiguous and can be migrated deliberately.
pub const REFLOG_VERSION: u32 = 1;

/// The all-zero oid git uses for "no such object" — a ref create has this as
/// `old`, a ref delete has it as `new`.
pub const ZERO_OID: &str = "0000000000000000000000000000000000000000";

/// `prev` value for the very first entry: the chain's genesis link.
pub const GENESIS_PREV: &str = "";

/// File name of a repo's ref-log, stored inside its bare directory. It is not a
/// git object path, so `git http-backend` never serves it; the node serves it
/// over its own `…/aura/reflog` route.
pub const REFLOG_FILE: &str = "aura-reflog.jsonl";

/// One ref that moved during a push — the unit the ref-log records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefChange {
    pub reference: String,
    pub old: String,
    pub new: String,
}

/// A single signed, chain-linked entry in a repo's ref-log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedRefEntry {
    pub seq: u64,
    #[serde(default)]
    pub schema_version: u32,
    pub prev: String,
    pub repo_id: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub old: String,
    pub new: String,
    pub ts: i64,
    pub signer: String,
    /// base64url (no pad) of the 32-byte Ed25519 verifying key.
    pub pubkey: String,
    /// base64 (standard, no pad) of the 64-byte detached signature.
    pub sig: String,
}

impl SignedRefEntry {
    /// The exact bytes covered by the signature *and* hashed into the chain.
    /// Newline-delimited and versioned so the layout is unambiguous. Excludes
    /// `signer`/`pubkey`/`sig` (those authenticate the payload, they are not
    /// part of it).
    pub fn signing_payload(&self) -> String {
        format!(
            "aura-reflog\nv{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
            self.schema_version,
            self.seq,
            self.prev,
            self.repo_id,
            self.reference,
            self.old,
            self.new,
            self.ts,
        )
    }

    /// Content hash of this entry (sha256 of the signing payload), used as the
    /// `prev` link of the entry that follows it.
    pub fn entry_hash(&self) -> String {
        sha256_hex(self.signing_payload().as_bytes())
    }

    /// Build and sign one entry. `prev` must be the previous entry's
    /// `entry_hash` (or [`GENESIS_PREV`] for `seq 0`).
    #[allow(clippy::too_many_arguments)]
    pub fn sign_new(
        seq: u64,
        prev: impl Into<String>,
        repo_id: impl Into<String>,
        reference: impl Into<String>,
        old: impl Into<String>,
        new: impl Into<String>,
        ts: i64,
        key: &SigningKey,
    ) -> Self {
        let mut e = SignedRefEntry {
            seq,
            schema_version: REFLOG_VERSION,
            prev: prev.into(),
            repo_id: repo_id.into(),
            reference: reference.into(),
            old: old.into(),
            new: new.into(),
            ts,
            signer: key.key_id(),
            pubkey: B64URL.encode(key.verifying_key().to_bytes()),
            sig: String::new(),
        };
        e.sig = key.sign(e.signing_payload().as_bytes()).to_b64();
        e
    }

    /// Verify this entry's signature in isolation: the embedded pubkey decodes,
    /// its derived `key_id` matches the claimed `signer`, and the signature
    /// covers the canonical payload. Returns the verified key on success.
    pub fn verify_sig(&self) -> Result<VerifyingKey, String> {
        let raw = B64URL
            .decode(self.pubkey.as_bytes())
            .map_err(|e| format!("seq {}: bad pubkey base64: {e}", self.seq))?;
        let arr: [u8; 32] = raw
            .as_slice()
            .try_into()
            .map_err(|_| format!("seq {}: pubkey is {} bytes, expected 32", self.seq, raw.len()))?;
        let vk = VerifyingKey::from_bytes(&arr)
            .map_err(|e| format!("seq {}: bad pubkey: {e}", self.seq))?;
        if vk.key_id() != self.signer {
            return Err(format!(
                "seq {}: signer {} does not match embedded pubkey {}",
                self.seq,
                self.signer,
                vk.key_id()
            ));
        }
        let sig = SignatureBytes::from_b64(&self.sig)
            .map_err(|e| format!("seq {}: bad signature: {e}", self.seq))?;
        vk.verify(self.signing_payload().as_bytes(), &sig)
            .map_err(|_| format!("seq {}: signature does not verify (tampered entry)", self.seq))?;
        Ok(vk)
    }
}

/// Result of verifying a full chain: how it ends up and who vouched for it.
#[derive(Debug, Clone)]
pub struct ChainSummary {
    pub count: usize,
    /// `entry_hash` of the last entry (empty for an empty log). A client can
    /// pin this to detect a later rollback.
    pub head_hash: String,
    /// Distinct signer key_ids seen, in first-seen order. A healthy
    /// single-node log has exactly one.
    pub signers: Vec<String>,
    /// The ref → oid state after replaying every entry (deleted refs removed),
    /// sorted by ref name.
    pub refs: Vec<(String, String)>,
}

/// Verify a whole ref-log: sequence has no gaps, every signature is valid, and
/// each `prev` links to the real hash of the entry before it. Optionally binds
/// the log to an expected `repo_id`. Returns the replayed head state on success
/// or a human-readable description of the first break.
pub fn verify_chain(
    entries: &[SignedRefEntry],
    expected_repo_id: Option<&str>,
) -> Result<ChainSummary, String> {
    let mut signers: Vec<String> = Vec::new();
    let mut refs: Vec<(String, String)> = Vec::new();

    for (i, entry) in entries.iter().enumerate() {
        if entry.seq != i as u64 {
            return Err(format!(
                "sequence gap: entry at index {i} claims seq {} (expected {i})",
                entry.seq
            ));
        }
        if let Some(rid) = expected_repo_id {
            if entry.repo_id != rid {
                return Err(format!(
                    "seq {i}: repo_id {} does not match expected {rid}",
                    entry.repo_id
                ));
            }
        }
        entry.verify_sig()?;
        let expected_prev = if i == 0 {
            GENESIS_PREV.to_string()
        } else {
            entries[i - 1].entry_hash()
        };
        if entry.prev != expected_prev {
            return Err(format!(
                "broken chain at seq {i}: prev {} does not link to the previous entry",
                entry.prev
            ));
        }
        if !signers.contains(&entry.signer) {
            signers.push(entry.signer.clone());
        }
        // Replay the ref state.
        replay(&mut refs, &entry.reference, &entry.new);
    }

    let head_hash = entries.last().map(|e| e.entry_hash()).unwrap_or_default();
    refs.sort();
    Ok(ChainSummary {
        count: entries.len(),
        head_hash,
        signers,
        refs,
    })
}

fn replay(refs: &mut Vec<(String, String)>, reference: &str, new: &str) {
    refs.retain(|(name, _)| name != reference);
    if new != ZERO_OID {
        refs.push((reference.to_string(), new.to_string()));
    }
}

/// Path of a repo's ref-log inside its bare directory.
pub fn reflog_path(repo_git_dir: &Path) -> PathBuf {
    repo_git_dir.join(REFLOG_FILE)
}

/// Read + parse a repo's ref-log (no verification). A missing file is an empty
/// log, not an error.
pub fn read_entries(repo_git_dir: &Path) -> Result<Vec<SignedRefEntry>, String> {
    let path = reflog_path(repo_git_dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    parse_ndjson(&raw)
}

/// Parse NDJSON (one [`SignedRefEntry`] per non-empty line).
pub fn parse_ndjson(raw: &str) -> Result<Vec<SignedRefEntry>, String> {
    let mut out = Vec::new();
    for (n, line) in raw.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let entry: SignedRefEntry =
            serde_json::from_str(line).map_err(|e| format!("line {}: {e}", n + 1))?;
        out.push(entry);
    }
    Ok(out)
}

/// Append signed entries for the refs that changed in a push. Reads the current
/// log to continue the sequence + chain, signs one entry per change, and
/// appends them atomically-per-line to the NDJSON file. Returns the new entries.
pub fn append_changes(
    repo_git_dir: &Path,
    repo_id: &str,
    changes: &[RefChange],
    ts: i64,
    key: &SigningKey,
) -> Result<Vec<SignedRefEntry>, String> {
    if changes.is_empty() {
        return Ok(Vec::new());
    }
    let existing = read_entries(repo_git_dir)?;
    let mut seq = existing.len() as u64;
    let mut prev = existing
        .last()
        .map(|e| e.entry_hash())
        .unwrap_or_else(|| GENESIS_PREV.to_string());

    let mut new_entries = Vec::with_capacity(changes.len());
    for change in changes {
        let entry = SignedRefEntry::sign_new(
            seq,
            prev.clone(),
            repo_id,
            &change.reference,
            &change.old,
            &change.new,
            ts,
            key,
        );
        prev = entry.entry_hash();
        seq += 1;
        new_entries.push(entry);
    }

    let mut buf = String::new();
    for entry in &new_entries {
        buf.push_str(&serde_json::to_string(entry).map_err(|e| format!("serialize entry: {e}"))?);
        buf.push('\n');
    }
    let path = reflog_path(repo_git_dir);
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    f.write_all(buf.as_bytes())
        .map_err(|e| format!("append {}: {e}", path.display()))?;
    Ok(new_entries)
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(reference: &str, old: &str, new: &str) -> RefChange {
        RefChange {
            reference: reference.to_string(),
            old: old.to_string(),
            new: new.to_string(),
        }
    }

    fn oid(tag: u8) -> String {
        // A distinct, well-formed 40-hex oid per tag.
        std::iter::repeat(format!("{tag:02x}")).take(20).collect()
    }

    /// Build a signed chain of `changes` under one key, as the node would.
    fn build_chain(repo_id: &str, changes: &[RefChange], key: &SigningKey) -> Vec<SignedRefEntry> {
        let mut seq = 0u64;
        let mut prev = GENESIS_PREV.to_string();
        let mut out = Vec::new();
        for c in changes {
            let e = SignedRefEntry::sign_new(
                seq, prev.clone(), repo_id, &c.reference, &c.old, &c.new, 1_700_000_000 + seq as i64, key,
            );
            prev = e.entry_hash();
            seq += 1;
            out.push(e);
        }
        out
    }

    #[test]
    fn valid_chain_verifies_and_replays_head() {
        let key = SigningKey::generate();
        let changes = vec![
            change("refs/heads/main", ZERO_OID, &oid(1)),
            change("refs/heads/main", &oid(1), &oid(2)),
            change("refs/tags/v1", ZERO_OID, &oid(3)),
        ];
        let chain = build_chain("repoA", &changes, &key);
        let summary = verify_chain(&chain, Some("repoA")).expect("valid chain must verify");
        assert_eq!(summary.count, 3);
        assert_eq!(summary.signers, vec![key.key_id()]);
        // Head state: main at oid2, v1 at oid3.
        assert_eq!(
            summary.refs,
            vec![
                ("refs/heads/main".to_string(), oid(2)),
                ("refs/tags/v1".to_string(), oid(3)),
            ]
        );
    }

    #[test]
    fn delete_removes_ref_from_head() {
        let key = SigningKey::generate();
        let changes = vec![
            change("refs/heads/tmp", ZERO_OID, &oid(1)),
            change("refs/heads/tmp", &oid(1), ZERO_OID),
        ];
        let chain = build_chain("r", &changes, &key);
        let summary = verify_chain(&chain, None).unwrap();
        assert!(summary.refs.is_empty(), "deleted ref must not survive replay");
    }

    #[test]
    fn tampered_new_oid_breaks_signature() {
        let key = SigningKey::generate();
        let changes = vec![change("refs/heads/main", ZERO_OID, &oid(1))];
        let mut chain = build_chain("r", &changes, &key);
        chain[0].new = oid(9); // rewrite the recorded target without re-signing
        let err = verify_chain(&chain, None).unwrap_err();
        assert!(err.contains("does not verify"), "got: {err}");
    }

    #[test]
    fn removing_a_middle_entry_breaks_the_chain() {
        let key = SigningKey::generate();
        let changes = vec![
            change("refs/heads/main", ZERO_OID, &oid(1)),
            change("refs/heads/main", &oid(1), &oid(2)),
            change("refs/heads/main", &oid(2), &oid(3)),
        ];
        let mut chain = build_chain("r", &changes, &key);
        chain.remove(1); // drop the middle update
        // seq now reads 0,2 → gap detected before the chain link even matters.
        let err = verify_chain(&chain, None).unwrap_err();
        assert!(err.contains("sequence gap") || err.contains("broken chain"), "got: {err}");
    }

    #[test]
    fn reordering_breaks_the_chain() {
        let key = SigningKey::generate();
        let changes = vec![
            change("refs/heads/main", ZERO_OID, &oid(1)),
            change("refs/heads/main", &oid(1), &oid(2)),
        ];
        let mut chain = build_chain("r", &changes, &key);
        chain.swap(0, 1);
        let err = verify_chain(&chain, None).unwrap_err();
        assert!(err.contains("sequence gap") || err.contains("broken chain"), "got: {err}");
    }

    #[test]
    fn foreign_key_swap_is_rejected() {
        let node = SigningKey::generate();
        let attacker = SigningKey::generate();
        let changes = vec![change("refs/heads/main", ZERO_OID, &oid(1))];
        let mut chain = build_chain("r", &changes, &node);
        // Attacker re-signs the same content with their own key + pubkey. The
        // entry is internally consistent, so verify_sig passes — trust comes
        // from the caller pinning the expected signer, surfaced in `signers`.
        let forged = SignedRefEntry::sign_new(
            0, GENESIS_PREV, "r", "refs/heads/main", ZERO_OID, oid(1), 1_700_000_000, &attacker,
        );
        chain[0] = forged;
        let summary = verify_chain(&chain, None).unwrap();
        assert_eq!(summary.signers, vec![attacker.key_id()]);
        assert_ne!(summary.signers, vec![node.key_id()]);
    }

    #[test]
    fn repo_id_binding_is_enforced() {
        let key = SigningKey::generate();
        let changes = vec![change("refs/heads/main", ZERO_OID, &oid(1))];
        let chain = build_chain("real-repo", &changes, &key);
        let err = verify_chain(&chain, Some("other-repo")).unwrap_err();
        assert!(err.contains("does not match expected"), "got: {err}");
    }

    #[test]
    fn ndjson_round_trips() {
        let key = SigningKey::generate();
        let changes = vec![
            change("refs/heads/main", ZERO_OID, &oid(1)),
            change("refs/heads/main", &oid(1), &oid(2)),
        ];
        let chain = build_chain("r", &changes, &key);
        let mut raw = String::new();
        for e in &chain {
            raw.push_str(&serde_json::to_string(e).unwrap());
            raw.push('\n');
        }
        let parsed = parse_ndjson(&raw).unwrap();
        verify_chain(&parsed, Some("r")).expect("round-tripped chain must verify");
        assert_eq!(parsed.len(), 2);
    }

    #[test]
    fn empty_log_is_a_valid_empty_chain() {
        let summary = verify_chain(&[], None).unwrap();
        assert_eq!(summary.count, 0);
        assert!(summary.head_hash.is_empty());
        assert!(summary.refs.is_empty());
    }
}
