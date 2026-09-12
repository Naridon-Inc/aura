//! What the node remembers about the capability tokens it minted.
//!
//! A capability token (see [`super::auth`]) is deliberately stateless: it is a
//! signed grant that the node verifies with nothing but its own public key, so
//! there is no server-side session to look up and nothing to go stale. That is
//! the right shape for the auth check on a git request, but it leaves an
//! operator unable to answer two ordinary questions — *what have I handed out?*
//! and *how do I take one back?* This module is the answer to both: a small
//! append-and-amend ledger of **metadata about** issued tokens.
//!
//! The distinction that matters: this file never stores a token. It stores an
//! id derived by hashing one, plus the label, scope and lifetime the operator
//! chose. Reading this ledger tells you a token exists and what it may do; it
//! does not let you use it, and it does not let anyone who copies the file mint
//! one. That property is what makes it safe to report the ledger to the cloud —
//! a cloud that could list a usable token is a cloud that could mint one.
//!
//! Revocation is enforced, not decorative. The git request path consults this
//! ledger on every authenticated request and refuses a revoked id, so a token
//! marked revoked here really does stop working. A token that is *absent* from
//! the ledger is still honoured: the capability token is self-certifying by
//! design, and tokens minted before this ledger existed (or by another copy of
//! the node key) must not be broken by the arrival of a bookkeeping file.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::auth::{CapabilityToken, CAP_PUSH, SCOPE_ALL};

/// Ledger schema version, so a later shape change can be migrated deliberately.
pub const LEDGER_VERSION: u32 = 1;

/// File name of the ledger inside the node's data root. Like `.node-key` it is
/// a plain file, so [`super::NodeStore::list`] — which only reports directories
/// ending in `.git` — never mistakes it for a hosted repo.
pub const TOKENS_FILE: &str = ".node-tokens.json";

/// Domain-separation prefix for the token id hash. Without it the same digest
/// could be produced by hashing some other Aura artifact that happened to have
/// the same bytes, and two unrelated things would share an id.
const ID_DOMAIN: &str = "aura-node-token-id/v1\n";

/// The console's two-valued view of what a token reaches: `push` covers write
/// access (and, since a push grant implies read, reading too), `fetch` is
/// read-only. The node's own capability vocabulary is `read`/`push`; this is
/// the name the wire uses.
pub const SCOPE_PUSH: &str = "push";
pub const SCOPE_FETCH: &str = "fetch";

/// Metadata about one token this node issued. Deliberately contains nothing
/// replayable — no payload, no signature, no wire form.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TokenRecord {
    #[serde(default)]
    pub schema_version: u32,
    /// Stable handle derived from the token by hashing it — see [`token_id`].
    pub id: String,
    /// Whatever the operator called it when minting. Empty if they said
    /// nothing, because inventing a name for them would be a lie in the UI.
    #[serde(default)]
    pub label: String,
    /// `push` or `fetch`.
    pub scope: String,
    /// The repo the token is scoped to, or `None` for a node-wide (`*`) grant.
    #[serde(default)]
    pub repo: Option<String>,
    pub created_at: i64,
    /// `None` when the token never expires.
    #[serde(default)]
    pub expires_at: Option<i64>,
    /// Last time this token successfully authorized a request, to the minute.
    #[serde(default)]
    pub last_used_at: Option<i64>,
    #[serde(default)]
    pub revoked: bool,
}

/// The whole ledger as it sits on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ledger {
    pub schema_version: u32,
    pub tokens: Vec<TokenRecord>,
}

impl Default for Ledger {
    fn default() -> Self {
        Ledger {
            schema_version: LEDGER_VERSION,
            tokens: Vec::new(),
        }
    }
}

impl Ledger {
    pub fn find(&self, id: &str) -> Option<&TokenRecord> {
        self.tokens.iter().find(|t| t.id == id)
    }

    fn find_mut(&mut self, id: &str) -> Option<&mut TokenRecord> {
        self.tokens.iter_mut().find(|t| t.id == id)
    }

    /// True when the ledger knows this id *and* it has been revoked. An unknown
    /// id is not revoked — see the module note on why absence must not deny.
    pub fn is_revoked(&self, id: &str) -> bool {
        self.find(id).map(|t| t.revoked).unwrap_or(false)
    }
}

/// The stable handle for a token: the first 8 bytes of a domain-separated
/// SHA-256 over its wire form, in hex.
///
/// Hashing rather than storing means the id is derivable at auth time (the
/// request presents the token, we hash it and look it up) while being useless
/// to anyone who reads the ledger — a 16-hex-character digest cannot be turned
/// back into the signed grant it names.
pub fn token_id(token_wire: &str) -> String {
    let mut h = Sha256::new();
    h.update(ID_DOMAIN.as_bytes());
    h.update(token_wire.trim().as_bytes());
    hex::encode(&h.finalize()[..8])
}

/// Which of the two wire scopes a set of node capabilities amounts to.
pub fn scope_for(caps: &[String]) -> &'static str {
    if caps.iter().any(|c| c == CAP_PUSH) {
        SCOPE_PUSH
    } else {
        SCOPE_FETCH
    }
}

pub fn ledger_path(root: &Path) -> PathBuf {
    root.join(TOKENS_FILE)
}

/// Read the ledger. A missing file is an empty ledger, not an error — a node
/// that has never minted a token has handed out nothing to report.
pub fn load(root: &Path) -> Result<Ledger, String> {
    let path = ledger_path(root);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Ledger::default()),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))
}

/// Write the ledger back, write-then-rename so a crash mid-write cannot leave a
/// half-parsed file that makes the node forget every token it ever issued.
pub fn save(root: &Path, ledger: &Ledger) -> Result<(), String> {
    let path = ledger_path(root);
    let body =
        serde_json::to_string_pretty(ledger).map_err(|e| format!("serialize token ledger: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, format!("{body}\n"))
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename into {}: {e}", path.display()))?;
    Ok(())
}

/// Record that a token was just minted. Returns its id so the mint command can
/// show the operator the handle they will later revoke by.
pub fn record_issue(
    root: &Path,
    token_wire: &str,
    label: &str,
    claims: &CapabilityToken,
) -> Result<String, String> {
    let id = token_id(token_wire);
    let record = TokenRecord {
        schema_version: LEDGER_VERSION,
        id: id.clone(),
        label: label.trim().to_string(),
        scope: scope_for(&claims.caps).to_string(),
        repo: (claims.repo_id != SCOPE_ALL).then(|| claims.repo_id.clone()),
        created_at: claims.iat,
        // The token's own `exp` uses 0 for "never"; the ledger and the wire say
        // that with an absent value instead, which is what a UI can render.
        expires_at: (claims.exp != 0).then_some(claims.exp),
        last_used_at: None,
        revoked: false,
    };
    let mut ledger = load(root)?;
    // Minting is not idempotent in general, but re-recording the same token
    // (same bytes, same id) must not create a second row.
    if let Some(existing) = ledger.find_mut(&id) {
        *existing = record;
    } else {
        ledger.tokens.push(record);
    }
    save(root, &ledger)?;
    Ok(id)
}

/// Coarse resolution for `last_used_at`. A busy node would otherwise rewrite
/// the ledger on every single git request just to move a timestamp by a
/// millisecond, so we only persist when the recorded value is this stale.
const USED_WRITE_INTERVAL_SECS: i64 = 60;

/// Note that `id` just authorized a request. Best-effort by design: two
/// concurrent requests can race and one write can lose the other's timestamp,
/// which costs at most a minute of resolution on a field that is a convenience,
/// never a control.
pub fn touch_used(root: &Path, id: &str, now: i64) {
    let mut ledger = match load(root) {
        Ok(l) => l,
        Err(_) => return,
    };
    let Some(record) = ledger.find_mut(id) else {
        return;
    };
    if let Some(prev) = record.last_used_at {
        if now - prev < USED_WRITE_INTERVAL_SECS {
            return;
        }
    }
    record.last_used_at = Some(now);
    let _ = save(root, &ledger);
}

/// Mark a token revoked. Returns the record as it now stands, or an error if
/// the node never recorded that id — refusing loudly beats reporting success
/// for a token that will go on working.
pub fn revoke(root: &Path, id: &str) -> Result<TokenRecord, String> {
    let mut ledger = load(root)?;
    let Some(record) = ledger.find_mut(id) else {
        return Err(format!(
            "no token '{id}' was issued by this node — run `aura node tokens` to see the ids it knows"
        ));
    };
    record.revoked = true;
    let out = record.clone();
    save(root, &ledger)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::auth::normalize_caps;
    use aura_attestation::SigningKey;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn id_is_stable_and_does_not_contain_the_token() {
        let id = token_id("auracap1.payload.signature");
        assert_eq!(id, token_id("auracap1.payload.signature"));
        assert_eq!(id.len(), 16);
        assert!(!id.contains("auracap1"));
        assert_ne!(id, token_id("auracap1.payload.signatura"));
    }

    #[test]
    fn issuing_records_metadata_but_never_the_token() {
        let dir = tmp();
        let key = SigningKey::generate();
        let claims = CapabilityToken::new("repo-a", normalize_caps(true, false), 1_000, 3_600);
        let wire = claims.clone().issue(&key).unwrap();
        // `issue` stamps the issuer, so re-parse to get the claims as recorded.
        let claims = CapabilityToken::parse_and_verify(&wire, &key.verifying_key()).unwrap();

        let id = record_issue(dir.path(), &wire, "ci runner", &claims).unwrap();
        let on_disk = std::fs::read_to_string(ledger_path(dir.path())).unwrap();
        assert!(
            !on_disk.contains(&wire),
            "the ledger must never persist the token itself"
        );
        assert!(!on_disk.contains("auracap1"));

        let ledger = load(dir.path()).unwrap();
        let rec = ledger.find(&id).unwrap();
        assert_eq!(rec.label, "ci runner");
        assert_eq!(rec.scope, SCOPE_PUSH);
        assert_eq!(rec.repo.as_deref(), Some("repo-a"));
        assert_eq!(rec.created_at, 1_000);
        assert_eq!(rec.expires_at, Some(4_600));
        assert!(!rec.revoked);
    }

    #[test]
    fn node_wide_and_never_expiring_are_recorded_as_absent_values() {
        let dir = tmp();
        let key = SigningKey::generate();
        let wire = CapabilityToken::new(SCOPE_ALL, normalize_caps(false, true), 500, 0)
            .issue(&key)
            .unwrap();
        let claims = CapabilityToken::parse_and_verify(&wire, &key.verifying_key()).unwrap();
        let id = record_issue(dir.path(), &wire, "", &claims).unwrap();

        let rec = load(dir.path()).unwrap().find(&id).unwrap().clone();
        assert_eq!(rec.repo, None, "`*` is the absence of a repo scope");
        assert_eq!(rec.expires_at, None, "`exp: 0` means never expires");
        assert_eq!(rec.scope, SCOPE_FETCH);
    }

    #[test]
    fn revoking_sticks_and_unknown_ids_are_refused() {
        let dir = tmp();
        let key = SigningKey::generate();
        let wire = CapabilityToken::new("r", normalize_caps(true, false), 1, 0)
            .issue(&key)
            .unwrap();
        let claims = CapabilityToken::parse_and_verify(&wire, &key.verifying_key()).unwrap();
        let id = record_issue(dir.path(), &wire, "x", &claims).unwrap();

        assert!(!load(dir.path()).unwrap().is_revoked(&id));
        revoke(dir.path(), &id).unwrap();
        assert!(load(dir.path()).unwrap().is_revoked(&id));

        assert!(revoke(dir.path(), "deadbeefdeadbeef").is_err());
        // An id the ledger has never seen is not revoked — absence must not deny.
        assert!(!load(dir.path()).unwrap().is_revoked("deadbeefdeadbeef"));
    }

    #[test]
    fn last_used_is_coarse_but_advances() {
        let dir = tmp();
        let key = SigningKey::generate();
        let wire = CapabilityToken::new("r", normalize_caps(false, true), 1, 0)
            .issue(&key)
            .unwrap();
        let claims = CapabilityToken::parse_and_verify(&wire, &key.verifying_key()).unwrap();
        let id = record_issue(dir.path(), &wire, "", &claims).unwrap();

        touch_used(dir.path(), &id, 10_000);
        assert_eq!(load(dir.path()).unwrap().find(&id).unwrap().last_used_at, Some(10_000));
        // Within the write interval the timestamp is deliberately not moved.
        touch_used(dir.path(), &id, 10_030);
        assert_eq!(load(dir.path()).unwrap().find(&id).unwrap().last_used_at, Some(10_000));
        touch_used(dir.path(), &id, 10_100);
        assert_eq!(load(dir.path()).unwrap().find(&id).unwrap().last_used_at, Some(10_100));
    }

    #[test]
    fn missing_ledger_reads_as_empty() {
        let dir = tmp();
        let ledger = load(dir.path()).unwrap();
        assert!(ledger.tokens.is_empty());
    }
}
