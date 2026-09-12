// SEC-04 — signed, expiring HUMAN grants for protected operations.
//
// The audited flaw: `aura validate-tool` treated a recent agent-authored
// `log-intent` line as sufficient approval for a destructive action — the
// agent authorized itself. This module is the replacement authority for the
// protected trio (file/dir DELETE, hard RESET, FORCE-PUSH):
//
//   - A grant is issued by a HUMAN at an interactive terminal
//     (`aura grant issue`), never from a hook/MCP context: issuance refuses
//     when stdin/stdout is not a TTY or when `AURA_AGENT` is set, and
//     requires the operation typed back as confirmation.
//   - A grant is SIGNED with the repo identity key (ed25519, the same key
//     `aura refs sign` uses) over a fixed payload, so tampering with any
//     bound field invalidates it.
//   - A grant is BOUND to: repo_id + checkout_id (CAP-01 scope manifest),
//     operation, target, and optionally the expected content hash (file
//     sha256) or ref hash (HEAD commit id). A grant replayed in another
//     repo or worktree fails the scope check before the signature even
//     matters — different identity file, different key.
//   - A grant EXPIRES (default 15 minutes) and is consumed ON FIRST USE:
//     verification appends the grant_id to `.aura/grants/consumed.jsonl`
//     and removes the pending file, so replay within the window also fails.
//
// Logged intent remains attached to the verdict as PROVENANCE — who said
// they were going to do this and why — but it never flips the decision for
// a protected op. `validate_tool::gate_destructive` is the sole consumer.
//
// Residual risk, stated honestly: the identity keyfile lives in the repo
// (`.aura/awareness/identity.key`, mode 0600) so a local agent with a PTY
// could in principle drive `aura grant issue`. The TTY + AURA_AGENT +
// typed-confirmation gate raises the bar; the durable defense is that the
// consumed ledger and pending files are plain JSONL a human can audit, and
// every grant names its issuer and verifier key.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::refs_sign::load_repo_identity;
use crate::scope;

/// Grant schema version — bump on any change to [`grant_payload`].
pub const GRANT_VERSION: u32 = 1;
/// Domain-separation tag, first line of every signed grant payload.
pub const GRANT_PAYLOAD_TAG: &str = "aura-grant";
/// Default grant lifetime. Long enough to issue-then-run, short enough
/// that a forgotten grant is not a standing hole.
pub const DEFAULT_TTL_SECS: u64 = 15 * 60;
/// Tolerated forward clock skew when judging `issued_at`.
const CLOCK_SKEW_SECS: u64 = 120;

/// The protected trio. Everything else destructive stays in the existing
/// policy/intent/strict lanes — these three are the operations the audit
/// named as self-authorized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtectedOp {
    /// Deleting files/dirs outright: FileDelete tools, `rm`, `shred`,
    /// `find -delete`, `git clean -f`, `git branch -D`.
    Delete,
    /// Discarding committed/working state: `git reset --hard`,
    /// `git checkout -- .`, `git restore <paths>`, `git stash drop/clear`.
    Reset,
    /// Rewriting a remote: `git push --force[-with-lease]`, `+refspec`,
    /// `--mirror`, `--delete`.
    ForcePush,
}

impl ProtectedOp {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProtectedOp::Delete => "delete",
            ProtectedOp::Reset => "reset",
            ProtectedOp::ForcePush => "force-push",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "delete" => Some(ProtectedOp::Delete),
            "reset" => Some(ProtectedOp::Reset),
            "force-push" | "force_push" | "forcepush" => Some(ProtectedOp::ForcePush),
            _ => None,
        }
    }
}

/// One issued grant, exactly as stored in `.aura/grants/pending/<id>.json`.
/// Field order is fixed by the struct so the file is deterministic; the
/// signature covers [`grant_payload`], not the JSON, so formatting changes
/// can never invalidate a grant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HumanGrant {
    pub version: u32,
    pub grant_id: String,
    /// CAP-01 repo identity (`rid-<16hex>`) the grant is bound to.
    pub repo_id: String,
    /// CAP-01 checkout identity (`wtr-<12hex>`) — a grant issued in one
    /// worktree does not authorize the same op in a sibling worktree.
    pub checkout_id: String,
    /// [`ProtectedOp::as_str`] value.
    pub operation: String,
    /// What the grant authorizes: a repo-relative path for `delete`, or
    /// the normalized command segment for shell forms (`git reset --hard`,
    /// `git push --force`, `rm -rf build`).
    pub target: String,
    /// Optional content pin: sha256 hex of the target file (`delete`) or
    /// the HEAD commit id (`reset`/`force-push`) at issue time. When set,
    /// the world changing under the grant voids it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_hash: Option<String>,
    /// Human who issued it (git user.name at issue time).
    pub issued_by: String,
    pub issued_at: u64,
    pub expires_at: u64,
    /// `did:aura:key/...` of the signing (repo identity) key.
    pub key_id: String,
    /// Full verifying key, base64url no-pad — display/audit convenience.
    /// Verification uses the repo's OWN identity key, never this field.
    pub pubkey: String,
    /// Base64 (std, no pad) ed25519 signature over [`grant_payload`].
    pub sig: String,
}

/// The EXACT byte string a grant signs. Every bound field is a line; a
/// missing hash pin is the literal `-` so field positions never shift.
pub fn grant_payload(g: &HumanGrant) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        GRANT_PAYLOAD_TAG,
        g.version,
        g.grant_id,
        g.repo_id,
        g.checkout_id,
        g.operation,
        g.target,
        g.expected_hash.as_deref().unwrap_or("-"),
        g.issued_by,
        g.issued_at,
        g.expires_at,
    )
}

/// What the gate learns from a successful grant check — everything a
/// surface (CLI verdict, desktop gate card, cloud audit row) needs to
/// display the grant and its verifier consistently. This struct IS the
/// cross-surface contract: it serializes into the verdict `details`.
#[derive(Debug, Clone, Serialize)]
pub struct GrantReceipt {
    pub grant_id: String,
    pub operation: String,
    pub target: String,
    pub issued_by: String,
    pub expires_at: u64,
    /// `ed25519:<did:aura:key/...>` — the key that verified the signature.
    pub verifier: String,
}

/// Outcome of looking for a grant covering (op, one of `targets`).
#[derive(Debug)]
pub enum GrantDecision {
    /// A valid grant matched and was consumed — authorized, once.
    Granted(GrantReceipt),
    /// No pending grant even names this op+target.
    NoGrant,
    /// Grants naming this op+target exist but every one failed a check.
    /// The reasons are human-facing (expired / consumed / wrong repo /
    /// hash moved / bad signature) so the ask-card can say why.
    Rejected(Vec<String>),
}

fn grants_dir(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("grants")
}

fn pending_dir(repo_root: &Path) -> PathBuf {
    grants_dir(repo_root).join("pending")
}

fn consumed_path(repo_root: &Path) -> PathBuf {
    grants_dir(repo_root).join("consumed.jsonl")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

/// Current pin value for (op, target): file sha256 for a delete whose
/// target resolves to a readable file, HEAD commit id for reset/force-push.
/// `None` when there is nothing to pin against (no file / no HEAD).
pub fn current_pin(repo_root: &Path, op: ProtectedOp, target: &str) -> Option<String> {
    match op {
        ProtectedOp::Delete => {
            let p = Path::new(target);
            let abs = if p.is_absolute() {
                p.to_path_buf()
            } else {
                repo_root.join(p)
            };
            std::fs::read(&abs).ok().map(|b| sha256_hex(&b))
        }
        ProtectedOp::Reset | ProtectedOp::ForcePush => {
            let repo = git2::Repository::discover(repo_root).ok()?;
            let head = repo.head().ok()?;
            head.peel_to_commit().ok().map(|c| c.id().to_string())
        }
    }
}

/// True when this process looks like a human at a terminal — the issuance
/// gate. Hook and MCP contexts run with piped stdio, so they fail this;
/// `AURA_AGENT` marks agent-driven shells that do own a PTY.
fn interactive_human() -> bool {
    if std::env::var("AURA_AGENT").is_ok() {
        return false;
    }
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// Issue a grant. Human-gated: refuses outside an interactive terminal and
/// requires the operation typed back. `pin` captures the current content /
/// ref hash so the grant voids if the world moves. Returns the stored grant.
pub fn issue(
    repo_root: &Path,
    op: ProtectedOp,
    target: &str,
    ttl_secs: u64,
    pin: bool,
) -> Result<HumanGrant, String> {
    if target.trim().is_empty() {
        return Err("grant target is empty — name the file or command form to authorize".into());
    }
    if !interactive_human() {
        return Err(
            "`aura grant issue` only runs for a human at an interactive terminal — \
             agents cannot issue their own authorization for a protected operation"
                .into(),
        );
    }

    // Typed confirmation: the human re-types the operation word. Read from
    // the real stdin (a TTY, per the gate above).
    println!(
        "About to grant `{}` on `{}` for {} minute(s).",
        op.as_str(),
        target,
        ttl_secs.div_ceil(60)
    );
    println!("Type the operation ({}) to confirm:", op.as_str());
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .map_err(|e| format!("could not read confirmation: {e}"))?;
    if line.trim() != op.as_str() {
        return Err(format!(
            "confirmation mismatch — expected `{}`, got `{}`; no grant issued",
            op.as_str(),
            line.trim()
        ));
    }

    let repo = git2::Repository::discover(repo_root)
        .map_err(|e| format!("not inside a git repository: {}", e.message()))?;
    let sk = load_repo_identity(&repo)?;
    let identity = scope::repo_identity(repo_root)
        .map_err(|e| format!("no Aura repo identity ({e}) — is this repo opted into Aura?"))?;
    let checkout = scope::checkout_id(repo_root);

    let issued_by = repo
        .config()
        .ok()
        .and_then(|c| c.get_string("user.name").ok())
        .unwrap_or_else(|| "unknown".to_string());

    let now = now_secs();
    let mut grant = HumanGrant {
        version: GRANT_VERSION,
        grant_id: uuid::Uuid::new_v4().to_string(),
        repo_id: identity.repo_id,
        checkout_id: checkout,
        operation: op.as_str().to_string(),
        target: target.to_string(),
        expected_hash: if pin {
            current_pin(repo_root, op, target)
        } else {
            None
        },
        issued_by,
        issued_at: now,
        expires_at: now.saturating_add(ttl_secs.max(60)),
        key_id: sk.key_id(),
        pubkey: B64URL.encode(sk.verifying_key().to_bytes()),
        sig: String::new(),
    };
    grant.sig = sk.sign(grant_payload(&grant).as_bytes()).to_b64();

    store_issued(repo_root, &grant)?;
    Ok(grant)
}

/// Persist an already-signed grant into the pending store. Split from
/// [`issue`] so tests can mint grants without a TTY — the TTY gate guards
/// the CLI entry point, not the storage format.
pub fn store_issued(repo_root: &Path, grant: &HumanGrant) -> Result<(), String> {
    let dir = pending_dir(repo_root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{}.json", grant.grant_id));
    let body = serde_json::to_string_pretty(grant).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(())
}

/// All pending grants, unparseable files skipped (they can't verify anyway).
pub fn list_pending(repo_root: &Path) -> Vec<HumanGrant> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(pending_dir(repo_root)) else {
        return out;
    };
    for e in entries.flatten() {
        if let Ok(raw) = std::fs::read_to_string(e.path()) {
            if let Ok(g) = serde_json::from_str::<HumanGrant>(&raw) {
                out.push(g);
            }
        }
    }
    out.sort_by_key(|g| g.issued_at);
    out
}

/// Remove a pending grant by id. Revocation is always safe — no TTY gate.
pub fn revoke(repo_root: &Path, grant_id: &str) -> Result<bool, String> {
    let path = pending_dir(repo_root).join(format!("{grant_id}.json"));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("cannot remove {}: {e}", path.display())),
    }
}

fn consumed_ids(repo_root: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(consumed_path(repo_root)) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter_map(|v| {
            v.get("grant_id")
                .and_then(|g| g.as_str())
                .map(String::from)
        })
        .collect()
}

fn mark_consumed(repo_root: &Path, g: &HumanGrant, verifier: &str) -> Result<(), String> {
    let dir = grants_dir(repo_root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let row = serde_json::json!({
        "grant_id": g.grant_id,
        "operation": g.operation,
        "target": g.target,
        "issued_by": g.issued_by,
        "consumed_at": now_secs(),
        "verifier": verifier,
    });
    let mut line = row.to_string();
    line.push('\n');
    use std::io::Write;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(consumed_path(repo_root))
        .and_then(|mut f| f.write_all(line.as_bytes()))
        .map_err(|e| e.to_string())?;
    // Pending file removal is best-effort — the consumed ledger is the
    // authority, so a survived file still cannot be replayed.
    let _ = std::fs::remove_file(pending_dir(repo_root).join(format!("{}.json", g.grant_id)));
    Ok(())
}

/// Check one grant against the world, WITHOUT consuming. Returns the
/// verifier string on success, a human-facing reason on failure.
pub fn check_grant(
    repo_root: &Path,
    g: &HumanGrant,
    op: ProtectedOp,
    targets: &[String],
) -> Result<String, String> {
    if g.version != GRANT_VERSION {
        return Err(format!("unsupported grant version {}", g.version));
    }
    if g.operation != op.as_str() {
        return Err(format!(
            "grant is for `{}`, not `{}`",
            g.operation,
            op.as_str()
        ));
    }
    if !targets.iter().any(|t| t == &g.target) {
        return Err(format!("grant targets `{}`, not this action", g.target));
    }

    // Scope binding BEFORE signature: a cross-repo/worktree replay should
    // say "wrong repo", not "bad signature".
    let identity = scope::repo_identity(repo_root)
        .map_err(|e| format!("cannot read repo identity: {e}"))?;
    if g.repo_id != identity.repo_id {
        return Err(format!(
            "grant is bound to repo `{}`, this repo is `{}`",
            g.repo_id, identity.repo_id
        ));
    }
    let checkout = scope::checkout_id(repo_root);
    if g.checkout_id != checkout {
        return Err(format!(
            "grant is bound to checkout `{}`, this checkout is `{}`",
            g.checkout_id, checkout
        ));
    }

    // Signature: MUST verify against this repo's own identity key. The
    // embedded pubkey is display-only — trusting it would let any key
    // self-certify.
    let repo = git2::Repository::discover(repo_root)
        .map_err(|e| format!("not a git repository: {}", e.message()))?;
    let sk = load_repo_identity(&repo).map_err(|e| format!("cannot load verifier key: {e}"))?;
    let vk = sk.verifying_key();
    let sig = aura_attestation::SignatureBytes::from_b64(&g.sig)
        .map_err(|_| "grant signature is malformed".to_string())?;
    vk.verify(grant_payload(g).as_bytes(), &sig)
        .map_err(|_| "grant signature does not verify against the repo identity key".to_string())?;

    let now = now_secs();
    if g.issued_at > now.saturating_add(CLOCK_SKEW_SECS) {
        return Err("grant is issued in the future".to_string());
    }
    if now > g.expires_at {
        return Err(format!(
            "grant expired {} second(s) ago",
            now.saturating_sub(g.expires_at)
        ));
    }

    if consumed_ids(repo_root).iter().any(|id| id == &g.grant_id) {
        return Err("grant was already used — grants are one-time".to_string());
    }

    if let Some(expected) = &g.expected_hash {
        match current_pin(repo_root, op, &g.target) {
            Some(actual) if &actual == expected => {}
            Some(actual) => {
                return Err(format!(
                    "content pin mismatch — grant pinned {}, current is {}",
                    &expected[..12.min(expected.len())],
                    &actual[..12.min(actual.len())]
                ));
            }
            None => {
                return Err("content pin set but the target no longer resolves".to_string());
            }
        }
    }

    Ok(format!("ed25519:{}", vk.key_id()))
}

/// The gate's entry point: find a pending grant authorizing `op` on one of
/// `targets`, verify every binding, and CONSUME it. One grant, one action.
pub fn find_and_consume(repo_root: &Path, op: ProtectedOp, targets: &[String]) -> GrantDecision {
    let pending = list_pending(repo_root);
    let named: Vec<&HumanGrant> = pending
        .iter()
        .filter(|g| g.operation == op.as_str() && targets.iter().any(|t| t == &g.target))
        .collect();
    if named.is_empty() {
        return GrantDecision::NoGrant;
    }

    let mut reasons = Vec::new();
    for g in named {
        match check_grant(repo_root, g, op, targets) {
            Ok(verifier) => {
                if let Err(e) = mark_consumed(repo_root, g, &verifier) {
                    reasons.push(format!(
                        "grant {} verified but could not be consumed ({e}) — refusing rather \
                         than allowing a replayable grant",
                        &g.grant_id[..8.min(g.grant_id.len())]
                    ));
                    continue;
                }
                return GrantDecision::Granted(GrantReceipt {
                    grant_id: g.grant_id.clone(),
                    operation: g.operation.clone(),
                    target: g.target.clone(),
                    issued_by: g.issued_by.clone(),
                    expires_at: g.expires_at,
                    verifier,
                });
            }
            Err(reason) => {
                reasons.push(format!(
                    "grant {}: {reason}",
                    &g.grant_id[..8.min(g.grant_id.len())]
                ));
            }
        }
    }
    GrantDecision::Rejected(reasons)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_attestation::{save_signing_key, SigningKey};

    /// A scratch git repo with an Aura identity key and `.aura/` opt-in.
    fn scratch_repo() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().to_path_buf();
        let repo = git2::Repository::init(&root).expect("git init");
        std::fs::create_dir_all(root.join(".aura")).expect(".aura");
        // Root commit so repo_id derives from history. Seed content is
        // unique per repo — two fixtures must never share a root-commit
        // sha, or their content-derived repo_ids would legitimately match.
        std::fs::write(
            root.join("seed.txt"),
            format!("seed {}", uuid::Uuid::new_v4()),
        )
        .unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(Path::new("seed.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "seed", &tree, &[])
            .unwrap();
        // Repo identity signing key (what `aura identity` creates).
        let key = SigningKey::generate();
        save_signing_key(&key, &root.join(".aura/awareness/identity.key")).unwrap();
        (tmp, root)
    }

    /// Mint + sign + store a grant directly (bypassing the TTY gate, which
    /// guards the CLI entry point, not the format).
    fn mint(
        root: &Path,
        op: ProtectedOp,
        target: &str,
        ttl: i64,
        pin: bool,
    ) -> HumanGrant {
        let repo = git2::Repository::discover(root).unwrap();
        let sk = load_repo_identity(&repo).unwrap();
        let identity = scope::repo_identity(root).unwrap();
        let now = now_secs();
        let mut g = HumanGrant {
            version: GRANT_VERSION,
            grant_id: uuid::Uuid::new_v4().to_string(),
            repo_id: identity.repo_id,
            checkout_id: scope::checkout_id(root),
            operation: op.as_str().to_string(),
            target: target.to_string(),
            expected_hash: if pin { current_pin(root, op, target) } else { None },
            issued_by: "human-tester".to_string(),
            issued_at: now,
            expires_at: (now as i64 + ttl).max(0) as u64,
            key_id: sk.key_id(),
            pubkey: B64URL.encode(sk.verifying_key().to_bytes()),
            sig: String::new(),
        };
        g.sig = sk.sign(grant_payload(&g).as_bytes()).to_b64();
        store_issued(root, &g).unwrap();
        g
    }

    #[test]
    fn valid_grant_authorizes_exactly_once() {
        let (_tmp, root) = scratch_repo();
        std::fs::write(root.join("doomed.rs"), "fn gone() {}").unwrap();
        mint(&root, ProtectedOp::Delete, "doomed.rs", 600, true);

        let targets = vec!["doomed.rs".to_string()];
        match find_and_consume(&root, ProtectedOp::Delete, &targets) {
            GrantDecision::Granted(r) => {
                assert_eq!(r.operation, "delete");
                assert_eq!(r.issued_by, "human-tester");
                assert!(r.verifier.starts_with("ed25519:did:aura:key/"));
            }
            other => panic!("first use must grant, got {other:?}"),
        }
        // Replay: same op, same target — the consumed ledger must refuse.
        match find_and_consume(&root, ProtectedOp::Delete, &targets) {
            GrantDecision::NoGrant => {} // pending file removed on consume
            GrantDecision::Rejected(r) => {
                assert!(r.iter().any(|m| m.contains("already used")), "{r:?}")
            }
            GrantDecision::Granted(_) => panic!("a grant must never authorize twice"),
        }
    }

    #[test]
    fn replay_survives_a_restored_pending_file() {
        // Even if the pending file is copied back (or removal failed), the
        // consumed ledger alone must block reuse.
        let (_tmp, root) = scratch_repo();
        let g = mint(&root, ProtectedOp::Reset, "git reset --hard", 600, false);
        let targets = vec!["git reset --hard".to_string()];
        assert!(matches!(
            find_and_consume(&root, ProtectedOp::Reset, &targets),
            GrantDecision::Granted(_)
        ));
        store_issued(&root, &g).unwrap(); // adversary restores the file
        match find_and_consume(&root, ProtectedOp::Reset, &targets) {
            GrantDecision::Rejected(r) => {
                assert!(r.iter().any(|m| m.contains("already used")), "{r:?}")
            }
            other => panic!("restored grant must stay consumed, got {other:?}"),
        }
    }

    #[test]
    fn expired_grant_is_rejected() {
        let (_tmp, root) = scratch_repo();
        mint(&root, ProtectedOp::ForcePush, "git push --force", -30, false);
        match find_and_consume(
            &root,
            ProtectedOp::ForcePush,
            &["git push --force".to_string()],
        ) {
            GrantDecision::Rejected(r) => {
                assert!(r.iter().any(|m| m.contains("expired")), "{r:?}")
            }
            other => panic!("expired grant must reject, got {other:?}"),
        }
    }

    #[test]
    fn cross_repo_grant_is_rejected() {
        let (_tmp_a, root_a) = scratch_repo();
        let (_tmp_b, root_b) = scratch_repo();
        // Issued in repo A, replayed in repo B.
        let g = mint(&root_a, ProtectedOp::Delete, "doomed.rs", 600, false);
        store_issued(&root_b, &g).unwrap();
        match find_and_consume(&root_b, ProtectedOp::Delete, &["doomed.rs".to_string()]) {
            GrantDecision::Rejected(r) => {
                assert!(r.iter().any(|m| m.contains("bound to repo")), "{r:?}")
            }
            other => panic!("cross-repo grant must reject, got {other:?}"),
        }
    }

    #[test]
    fn tampered_target_breaks_the_signature() {
        let (_tmp, root) = scratch_repo();
        let mut g = mint(&root, ProtectedOp::Delete, "harmless.txt", 600, false);
        // Adversary repoints the signed grant at a different file.
        g.target = "src/main.rs".to_string();
        store_issued(&root, &g).unwrap();
        match find_and_consume(&root, ProtectedOp::Delete, &["src/main.rs".to_string()]) {
            GrantDecision::Rejected(r) => {
                assert!(
                    r.iter().any(|m| m.contains("signature does not verify")),
                    "{r:?}"
                )
            }
            other => panic!("tampered grant must reject, got {other:?}"),
        }
    }

    #[test]
    fn foreign_key_cannot_self_certify() {
        // A grant signed by some OTHER key (with its pubkey embedded) must
        // fail — verification trusts only the repo identity key.
        let (_tmp, root) = scratch_repo();
        let attacker = SigningKey::generate();
        let identity = scope::repo_identity(&root).unwrap();
        let now = now_secs();
        let mut g = HumanGrant {
            version: GRANT_VERSION,
            grant_id: uuid::Uuid::new_v4().to_string(),
            repo_id: identity.repo_id,
            checkout_id: scope::checkout_id(&root),
            operation: "delete".to_string(),
            target: "victim.rs".to_string(),
            expected_hash: None,
            issued_by: "mallory".to_string(),
            issued_at: now,
            expires_at: now + 600,
            key_id: attacker.key_id(),
            pubkey: B64URL.encode(attacker.verifying_key().to_bytes()),
            sig: String::new(),
        };
        g.sig = attacker.sign(grant_payload(&g).as_bytes()).to_b64();
        store_issued(&root, &g).unwrap();
        match find_and_consume(&root, ProtectedOp::Delete, &["victim.rs".to_string()]) {
            GrantDecision::Rejected(r) => {
                assert!(
                    r.iter().any(|m| m.contains("signature does not verify")),
                    "{r:?}"
                )
            }
            other => panic!("foreign-key grant must reject, got {other:?}"),
        }
    }

    #[test]
    fn content_pin_voids_when_the_file_changes() {
        let (_tmp, root) = scratch_repo();
        std::fs::write(root.join("pinned.rs"), "fn v1() {}").unwrap();
        mint(&root, ProtectedOp::Delete, "pinned.rs", 600, true);
        // The file changes after issuance — the pin must void the grant.
        std::fs::write(root.join("pinned.rs"), "fn v2_new_content() {}").unwrap();
        match find_and_consume(&root, ProtectedOp::Delete, &["pinned.rs".to_string()]) {
            GrantDecision::Rejected(r) => {
                assert!(r.iter().any(|m| m.contains("pin mismatch")), "{r:?}")
            }
            other => panic!("moved pin must reject, got {other:?}"),
        }
    }

    #[test]
    fn wrong_operation_or_target_is_no_grant() {
        let (_tmp, root) = scratch_repo();
        mint(&root, ProtectedOp::Delete, "a.txt", 600, false);
        // Same target, different op → the delete grant must not leak.
        assert!(matches!(
            find_and_consume(&root, ProtectedOp::Reset, &["a.txt".to_string()]),
            GrantDecision::NoGrant
        ));
        // Same op, different target.
        assert!(matches!(
            find_and_consume(&root, ProtectedOp::Delete, &["b.txt".to_string()]),
            GrantDecision::NoGrant
        ));
    }

    #[test]
    fn revoke_removes_a_pending_grant() {
        let (_tmp, root) = scratch_repo();
        let g = mint(&root, ProtectedOp::Delete, "x.txt", 600, false);
        assert_eq!(list_pending(&root).len(), 1);
        assert!(revoke(&root, &g.grant_id).unwrap());
        assert!(list_pending(&root).is_empty());
        assert!(matches!(
            find_and_consume(&root, ProtectedOp::Delete, &["x.txt".to_string()]),
            GrantDecision::NoGrant
        ));
        // Revoking again reports "was not there" rather than erroring.
        assert!(!revoke(&root, &g.grant_id).unwrap());
    }
}
