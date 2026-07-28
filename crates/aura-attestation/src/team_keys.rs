//! Team key registry — the trust anchor that lets a teammate independently
//! re-check the "Genuine record" seal on *your* AI's work, cross-machine.
//!
//! ## The gap this closes
//!
//! Every signed intent block carries a `provenance.signature` with a
//! `key_id` (`did:aura:key/<first-8-bytes>`). That's enough to *recompute*
//! the signature — but only if the verifier already holds the signer's
//! full 32-byte ed25519 public key. The block does NOT embed it (the
//! `key_id` is a truncated fingerprint, not the key). So historically the
//! verifier could only check blocks signed by its OWN local key (plus the
//! local key's rotation ancestors). A teammate pulling your repo saw the
//! seal *claim* but could never re-run the math on it.
//!
//! This module is the missing piece: a small, git-tracked registry where
//! each member publishes their own signing pubkey, **self-signed**, so any
//! teammate who pulls the repo gains the material to verify everyone's
//! blocks.
//!
//! ## Trust model (stated plainly, no hand-waving)
//!
//! - The registry lives at `.aura/team/keys.jsonl` and **is committed to
//!   git** (unlike `.aura/blocks/`, which is local-only). It travels on
//!   pull, exactly like `intent_log.jsonl` and `team/team.json`.
//! - Each entry is **self-signed**: the holder of the private key signs the
//!   `(key_id, pubkey, identity)` binding. `verify_self_sig` confirms the
//!   pubkey in the row actually verifies its own attestation, so a row
//!   whose pubkey was swapped or whose identity was edited fails closed.
//! - The remaining trust ("this key really is Ashiq's, not an impostor's")
//!   is **trust-on-first-use anchored to git push access** — the same trust
//!   you already extend to every commit on the branch. The first time a
//!   member's key appears it is recorded; a later impersonation attempt
//!   (binding a different identity to a new key) is visible in `git blame`
//!   on this file. This is deliberately the *same* anchor git itself uses;
//!   a transparency-log upgrade (Rekor) is layered separately for teams
//!   that want non-repudiation beyond push-access trust.
//!
//! What this is NOT: it does not prove the human typed the intent, and it
//! cannot stop someone who has stolen a private seed from signing as that
//! key. It proves "the work sealed under key K was sealed by whoever holds
//! K, and the repo's committed history says K belongs to <member>."

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use serde::{Deserialize, Serialize};

use crate::{SignatureBytes, SigningKey, VerifyingKey};

/// One published signing identity. One JSON object per line in
/// `.aura/team/keys.jsonl`. Append-only, first-write-wins per `key_id`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TeamKeyEntry {
    /// `did:aura:key/<b64url-first-8>` — the truncated fingerprint that
    /// appears in `block.provenance.signature.key_id`. The join key.
    pub key_id: String,
    /// Full 32-byte ed25519 public key, base64url-no-pad. THIS is the
    /// material a block signature can't carry on its own.
    pub pub_b64: String,
    /// `did:aura:human/...` when the signer bound a human operator into
    /// the block (dual-identity). None for agent-only signing identities.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub human_id: Option<String>,
    /// Friendly name for surfaces ("Ashiq"). Informational.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Git/commit email this identity maps to, when known. Lets the Trace
    /// surface join a verified key back to a roster member.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// GitHub login, when known. Same join purpose as `email`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_login: Option<String>,
    /// The agent id that first published this key (`MCP Agent`, `claude`,
    /// …). Informational; not covered by the self-signature.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// First time this key was seen / published, unix seconds.
    pub first_seen_unix: i64,
    /// ed25519 signature over [`signable_bytes`], base64 (standard-no-pad,
    /// matching `aura_attestation::SignatureBytes`). Proves the holder of
    /// `pub_b64`'s private half asserts this whole binding.
    pub self_sig: String,
}

/// Identity facts a caller knows about the local signer at publish time.
/// All optional — the registry is useful with just the key, and richer
/// when the caller can supply a human/email/login to join on later.
#[derive(Debug, Clone, Default)]
pub struct SelfIdentity {
    pub human_id: Option<String>,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub github_login: Option<String>,
    pub agent_id: Option<String>,
}

/// Outcome of [`publish_self`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PublishOutcome {
    /// A new entry was appended for this key_id.
    Added,
    /// This key_id was already in the registry — no-op (idempotent).
    AlreadyPresent,
}

/// Default registry path, relative to the repo root: `.aura/team/keys.jsonl`.
pub fn registry_path() -> PathBuf {
    PathBuf::from(".aura").join("team").join("keys.jsonl")
}

/// Domain-separated, deterministic message that the self-signature covers.
///
/// Manual line-oriented framing (not JSON) so the bytes are trivially
/// stable across machines and human-auditable: there is no field-ordering
/// or whitespace ambiguity to get wrong. The leading version tag is a
/// domain separator so a self-sig can never be replayed as some other
/// ed25519 signature in the system.
///
/// Covers every security-relevant field: the key fingerprint, the full
/// pubkey, the identity binding, and the first-seen timestamp. `agent_id`
/// is intentionally excluded — it's informational and may legitimately
/// differ between the publish call and any later read.
pub fn signable_bytes(
    key_id: &str,
    pub_b64: &str,
    human_id: Option<&str>,
    display_name: Option<&str>,
    email: Option<&str>,
    github_login: Option<&str>,
    first_seen_unix: i64,
) -> Vec<u8> {
    let msg = format!(
        "aura-team-key-v1\n{key_id}\n{pub_b64}\n{human}\n{name}\n{email}\n{gh}\n{seen}",
        key_id = key_id,
        pub_b64 = pub_b64,
        human = human_id.unwrap_or(""),
        name = display_name.unwrap_or(""),
        email = email.unwrap_or(""),
        gh = github_login.unwrap_or(""),
        seen = first_seen_unix,
    );
    msg.into_bytes()
}

impl TeamKeyEntry {
    /// The bytes this entry's `self_sig` is computed over.
    fn signable(&self) -> Vec<u8> {
        signable_bytes(
            &self.key_id,
            &self.pub_b64,
            self.human_id.as_deref(),
            self.display_name.as_deref(),
            self.email.as_deref(),
            self.github_login.as_deref(),
            self.first_seen_unix,
        )
    }

    /// Parse `pub_b64` into a usable verifying key. None on any malformed
    /// encoding / wrong length / invalid curve point.
    pub fn verifying_key(&self) -> Option<VerifyingKey> {
        let bytes = B64URL.decode(self.pub_b64.as_bytes()).ok()?;
        let arr: [u8; 32] = bytes.as_slice().try_into().ok()?;
        VerifyingKey::from_bytes(&arr).ok()
    }

    /// True iff the pubkey in this row verifies its own self-signature AND
    /// the `key_id` actually derives from that pubkey. Fails closed on any
    /// parse error. This is what makes a tampered registry row inert: edit
    /// the email, swap the pubkey, or forge the fingerprint and this
    /// returns false.
    pub fn verify_self_sig(&self) -> bool {
        let Some(vk) = self.verifying_key() else {
            return false;
        };
        // The fingerprint must be the real fingerprint of the pubkey —
        // otherwise an attacker could file a row under a victim's key_id
        // while carrying their own (self-consistent) pubkey + signature.
        if vk.key_id() != self.key_id {
            return false;
        }
        let Ok(sig) = SignatureBytes::from_b64(&self.self_sig) else {
            return false;
        };
        vk.verify(&self.signable(), &sig).is_ok()
    }
}

/// Read every well-formed entry from the registry. Missing file → empty
/// vec (not an error). Malformed lines are skipped silently so a single
/// bad row never blinds the whole registry — mirrors the mixed-corpus
/// tolerance of the rotation-chain scanner.
pub fn load_all(path: &Path) -> Vec<TeamKeyEntry> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<TeamKeyEntry>(l).ok())
        .collect()
}

/// Find the entry for a `key_id`, returning it only if its self-signature
/// checks out. First valid match wins (append-only, TOFU). A row that
/// fails `verify_self_sig` is treated as if absent — a forged row cannot
/// shadow or pre-empt the genuine one.
pub fn entry_for(path: &Path, key_id: &str) -> Option<TeamKeyEntry> {
    load_all(path)
        .into_iter()
        .find(|e| e.key_id == key_id && e.verify_self_sig())
}

/// Resolve a `key_id` to a trusted verifying key via the registry. This is
/// the verifier's entry point: given a block signed by `key_id`, hand back
/// the pubkey to check it against — or None if we have no trusted record
/// of that key.
pub fn resolve(path: &Path, key_id: &str) -> Option<VerifyingKey> {
    entry_for(path, key_id).and_then(|e| e.verifying_key())
}

/// Publish the local signing key into the registry, self-signed. Idempotent:
/// if `key_id` is already recorded (by any line, even one that fails
/// verification — we never silently overwrite history), returns
/// [`PublishOutcome::AlreadyPresent`] without writing.
///
/// Append-only by design: we add a line, never rewrite the file, so the
/// git history of who-published-what stays intact and auditable.
pub fn publish_self(
    path: &Path,
    key: &SigningKey,
    identity: &SelfIdentity,
    now_unix: i64,
) -> Result<PublishOutcome, String> {
    let vk = key.verifying_key();
    let key_id = vk.key_id();

    // Idempotence check against *any* existing line for this key_id,
    // including malformed ones, so repeated calls never duplicate.
    if load_all(path).iter().any(|e| e.key_id == key_id) {
        return Ok(PublishOutcome::AlreadyPresent);
    }

    let pub_b64 = B64URL.encode(vk.to_bytes());
    let msg = signable_bytes(
        &key_id,
        &pub_b64,
        identity.human_id.as_deref(),
        identity.display_name.as_deref(),
        identity.email.as_deref(),
        identity.github_login.as_deref(),
        now_unix,
    );
    let self_sig = key.sign(&msg).to_b64();

    let entry = TeamKeyEntry {
        key_id,
        pub_b64,
        human_id: identity.human_id.clone(),
        display_name: identity.display_name.clone(),
        email: identity.email.clone(),
        github_login: identity.github_login.clone(),
        agent_id: identity.agent_id.clone(),
        first_seen_unix: now_unix,
        self_sig,
    };

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let line = serde_json::to_string(&entry).map_err(|e| format!("serialize entry: {e}"))?;
    append_line(path, &line).map_err(|e| format!("append {}: {e}", path.display()))?;
    Ok(PublishOutcome::Added)
}

/// Append a single line (plus newline) to a file, creating it if missing.
/// Open-append is atomic enough for line-granular writes on the platforms
/// we target; the registry is low-frequency (once per new key) so we don't
/// need the tmp+rename dance the block writer uses for whole-file safety.
fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    f.write_all(line.as_bytes())?;
    f.write_all(b"\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn ident() -> SelfIdentity {
        SelfIdentity {
            human_id: Some("did:aura:human/ashiq".into()),
            display_name: Some("Ashiq".into()),
            email: Some("ashiq@naridon.com".into()),
            github_login: Some("MHASK".into()),
            agent_id: Some("MCP Agent".into()),
        }
    }

    #[test]
    fn publish_then_resolve_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.jsonl");
        let sk = SigningKey::from_seed([1u8; 32]);

        let out = publish_self(&path, &sk, &ident(), 1_700_000_000).unwrap();
        assert_eq!(out, PublishOutcome::Added);

        let resolved = resolve(&path, &sk.verifying_key().key_id())
            .expect("published key must resolve");
        assert_eq!(resolved, sk.verifying_key());
    }

    #[test]
    fn publish_is_idempotent() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.jsonl");
        let sk = SigningKey::from_seed([2u8; 32]);

        assert_eq!(
            publish_self(&path, &sk, &ident(), 1_700_000_000).unwrap(),
            PublishOutcome::Added
        );
        assert_eq!(
            publish_self(&path, &sk, &ident(), 1_700_000_999).unwrap(),
            PublishOutcome::AlreadyPresent
        );
        // Exactly one line.
        let lines = std::fs::read_to_string(&path).unwrap();
        assert_eq!(lines.lines().filter(|l| !l.trim().is_empty()).count(), 1);
    }

    #[test]
    fn self_sig_verifies_on_published_entry() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.jsonl");
        let sk = SigningKey::from_seed([3u8; 32]);
        publish_self(&path, &sk, &ident(), 1_700_000_000).unwrap();
        let entries = load_all(&path);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].verify_self_sig());
    }

    #[test]
    fn tampered_email_fails_self_sig() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.jsonl");
        let sk = SigningKey::from_seed([4u8; 32]);
        publish_self(&path, &sk, &ident(), 1_700_000_000).unwrap();

        let mut entry = load_all(&path).pop().unwrap();
        entry.email = Some("attacker@evil.com".into());
        assert!(
            !entry.verify_self_sig(),
            "editing a signed field must invalidate the self-sig"
        );
        // And the registry must not resolve a tampered row.
        let mut entries = load_all(&path);
        entries[0].email = Some("attacker@evil.com".into());
        let rewritten = entries
            .iter()
            .map(|e| serde_json::to_string(e).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&path, rewritten).unwrap();
        assert!(
            resolve(&path, &sk.verifying_key().key_id()).is_none(),
            "tampered row must not resolve"
        );
    }

    #[test]
    fn swapped_pubkey_fails_self_sig() {
        // Attacker keeps the victim's key_id + self_sig but swaps in their
        // own pubkey. key_id no longer derives from pub_b64 → rejected
        // before we even check the signature.
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.jsonl");
        let victim = SigningKey::from_seed([5u8; 32]);
        let attacker = SigningKey::from_seed([6u8; 32]);
        publish_self(&path, &victim, &ident(), 1_700_000_000).unwrap();

        let mut entry = load_all(&path).pop().unwrap();
        entry.pub_b64 = B64URL.encode(attacker.verifying_key().to_bytes());
        assert!(!entry.verify_self_sig());
    }

    #[test]
    fn forged_keyid_with_consistent_pubkey_rejected() {
        // Attacker files a row under the victim's key_id but carries their
        // OWN pubkey and a valid self-sig over it. The key_id↔pubkey
        // derivation check must catch the mismatch.
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.jsonl");
        let victim = SigningKey::from_seed([7u8; 32]);
        let attacker = SigningKey::from_seed([8u8; 32]);

        let victim_key_id = victim.verifying_key().key_id();
        let pub_b64 = B64URL.encode(attacker.verifying_key().to_bytes());
        // Self-sign with the ATTACKER key over a payload claiming the
        // victim's key_id — internally consistent for the attacker key,
        // but the key_id won't derive from the attacker pubkey.
        let msg = signable_bytes(&victim_key_id, &pub_b64, None, None, None, None, 1);
        let self_sig = attacker.sign(&msg).to_b64();
        let entry = TeamKeyEntry {
            key_id: victim_key_id.clone(),
            pub_b64,
            human_id: None,
            display_name: None,
            email: None,
            github_login: None,
            agent_id: None,
            first_seen_unix: 1,
            self_sig,
        };
        std::fs::write(&path, serde_json::to_string(&entry).unwrap()).unwrap();
        assert!(entry.verify_self_sig() == false);
        assert!(resolve(&path, &victim_key_id).is_none());
    }

    #[test]
    fn unknown_key_resolves_none() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.jsonl");
        let sk = SigningKey::from_seed([9u8; 32]);
        publish_self(&path, &sk, &ident(), 1_700_000_000).unwrap();
        let stranger = SigningKey::from_seed([99u8; 32]);
        assert!(resolve(&path, &stranger.verifying_key().key_id()).is_none());
    }

    #[test]
    fn missing_file_is_empty_not_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nope.jsonl");
        assert!(load_all(&path).is_empty());
        assert!(resolve(&path, "did:aura:key/whatever").is_none());
    }

    #[test]
    fn malformed_line_skipped_good_line_kept() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.jsonl");
        let sk = SigningKey::from_seed([10u8; 32]);
        publish_self(&path, &sk, &ident(), 1_700_000_000).unwrap();
        // Prepend garbage + a blank line.
        let good = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, format!("not json at all\n\n{good}")).unwrap();
        let entries = load_all(&path);
        assert_eq!(entries.len(), 1, "good line survives a malformed neighbour");
        assert!(resolve(&path, &sk.verifying_key().key_id()).is_some());
    }

    #[test]
    fn two_members_each_resolve_independently() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.jsonl");
        let a = SigningKey::from_seed([20u8; 32]);
        let b = SigningKey::from_seed([21u8; 32]);
        publish_self(&path, &a, &ident(), 1_700_000_000).unwrap();
        publish_self(&path, &b, &SelfIdentity::default(), 1_700_000_100).unwrap();
        assert_eq!(resolve(&path, &a.verifying_key().key_id()), Some(a.verifying_key()));
        assert_eq!(resolve(&path, &b.verifying_key().key_id()), Some(b.verifying_key()));
    }
}
