//! End-to-end encryption primitives (plan W6).
//!
//! Per-org 32-byte ChaCha20-Poly1305 content key. Each user has an
//! X25519 identity keypair; the org content key is sealed to each
//! member's pubkey via ephemeral-X25519 + AEAD. Identity private key on
//! disk is encrypted under an Argon2-derived passphrase key.
//!
//! Server stores only ciphertext + nonce + key_version; it cannot read
//! bodies. Metadata (function names, file paths, user IDs) stays
//! plaintext by design — see threat model in the plan.

use std::path::PathBuf;

use argon2::{Argon2, Params, Version};
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use x25519_dalek::{PublicKey, StaticSecret};

const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;

pub type ContentKey = [u8; KEY_LEN];

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn rand_bytes(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    OsRng.fill_bytes(&mut v);
    v
}

// ── Identity keypair, stored at-rest encrypted under passphrase. ────────

#[derive(Debug, Serialize, Deserialize)]
pub struct EncryptedIdentity {
    pub public_key_b64: String,
    pub salt_b64: String,
    pub nonce_b64: String,
    pub ciphertext_b64: String, // encrypted private key
}

fn identity_path() -> PathBuf {
    PathBuf::from(".aura/keys/identity.json")
}

fn derive_kek(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let params = Params::new(65_536, 3, 1, Some(32)).map_err(|e| e.to_string())?;
    let a = Argon2::new(argon2::Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    a.hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn generate_identity(passphrase: &str) -> Result<EncryptedIdentity, String> {
    let secret = StaticSecret::random_from_rng(&mut OsRng);
    let public = PublicKey::from(&secret);
    let salt = rand_bytes(SALT_LEN);
    let kek = derive_kek(passphrase, &salt)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&kek));
    let nonce_bytes = rand_bytes(NONCE_LEN);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), secret.as_bytes().as_ref())
        .map_err(|e| format!("seal identity: {}", e))?;

    Ok(EncryptedIdentity {
        public_key_b64: b64().encode(public.as_bytes()),
        salt_b64: b64().encode(&salt),
        nonce_b64: b64().encode(&nonce_bytes),
        ciphertext_b64: b64().encode(&ct),
    })
}

pub fn save_identity(enc: &EncryptedIdentity) -> Result<(), String> {
    let path = identity_path();
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string_pretty(enc).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, s).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_identity() -> Result<Option<EncryptedIdentity>, String> {
    let path = identity_path();
    if !path.exists() {
        return Ok(None);
    }
    let s = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let enc: EncryptedIdentity = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    Ok(Some(enc))
}

pub fn unlock_identity(enc: &EncryptedIdentity, passphrase: &str) -> Result<StaticSecret, String> {
    let salt = b64().decode(&enc.salt_b64).map_err(|e| e.to_string())?;
    let nonce = b64().decode(&enc.nonce_b64).map_err(|e| e.to_string())?;
    let ct = b64().decode(&enc.ciphertext_b64).map_err(|e| e.to_string())?;
    let kek = derive_kek(passphrase, &salt)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&kek));
    let pt = cipher
        .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
        .map_err(|_| "bad passphrase".to_string())?;
    if pt.len() != 32 {
        return Err("corrupt identity".to_string());
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&pt);
    Ok(StaticSecret::from(arr))
}

// ── Org content key wrapping. ────────────────────────────────────────────

/// Seal a 32-byte content key to a member's X25519 public key. Returns
/// (wrapped_ct, nonce, ephemeral_pub).
pub fn wrap_content_key(
    content_key: &ContentKey,
    member_pub: &PublicKey,
) -> Result<(Vec<u8>, Vec<u8>, [u8; 32]), String> {
    let eph = StaticSecret::random_from_rng(&mut OsRng);
    let eph_pub = PublicKey::from(&eph);
    let shared = eph.diffie_hellman(member_pub);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(shared.as_bytes()));
    let nonce = rand_bytes(NONCE_LEN);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), content_key.as_ref())
        .map_err(|e| format!("wrap: {}", e))?;
    Ok((ct, nonce, *eph_pub.as_bytes()))
}

pub fn unwrap_content_key(
    wrapped_ct: &[u8],
    nonce: &[u8],
    ephemeral_pub: &[u8; 32],
    member_secret: &StaticSecret,
) -> Result<ContentKey, String> {
    let eph_pub = PublicKey::from(*ephemeral_pub);
    let shared = member_secret.diffie_hellman(&eph_pub);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(shared.as_bytes()));
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce), wrapped_ct)
        .map_err(|e| format!("unwrap: {}", e))?;
    if pt.len() != KEY_LEN {
        return Err("bad content key length".into());
    }
    let mut out = [0u8; KEY_LEN];
    out.copy_from_slice(&pt);
    Ok(out)
}

pub fn generate_content_key() -> ContentKey {
    let mut k = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut k);
    k
}

// ── Body seal / open. ────────────────────────────────────────────────────

pub fn seal(content_key: &ContentKey, plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(content_key));
    let nonce = rand_bytes(NONCE_LEN);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|e| format!("seal: {}", e))?;
    Ok((ct, nonce))
}

pub fn open(content_key: &ContentKey, ciphertext: &[u8], nonce: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(content_key));
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|e| format!("open: {}", e))
}

// ── Content-key cache on disk (unwrapped). Kept process-local; file is
//    written with mode 0600 where supported. This lets the push/pull
//    loops seal/open without re-prompting for a passphrase on every op.
//    Users can opt out by setting AURA_E2E_NO_CACHE=1 — then the key
//    stays only in process memory and must be re-unlocked per CLI run.

fn cache_path() -> PathBuf {
    PathBuf::from(".aura/keys/cache.json")
}

#[derive(Debug, Serialize, Deserialize)]
pub struct KeyCacheEntry {
    pub org_id: String,
    pub key_version: i32,
    pub content_key_b64: String,
}

pub fn save_cached_key(entry: &KeyCacheEntry) -> Result<(), String> {
    if std::env::var("AURA_E2E_NO_CACHE").is_ok() {
        return Ok(());
    }
    let path = cache_path();
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let mut all: Vec<KeyCacheEntry> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    all.retain(|e| !(e.org_id == entry.org_id && e.key_version == entry.key_version));
    all.push(KeyCacheEntry {
        org_id: entry.org_id.clone(),
        key_version: entry.key_version,
        content_key_b64: entry.content_key_b64.clone(),
    });
    let s = serde_json::to_string(&all).map_err(|e| e.to_string())?;
    std::fs::write(&path, s).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn load_cached_key(org_id: &str, key_version: i32) -> Option<ContentKey> {
    let all: Vec<KeyCacheEntry> = std::fs::read_to_string(cache_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let entry = all
        .into_iter()
        .find(|e| e.org_id == org_id && e.key_version == key_version)?;
    let raw = b64().decode(&entry.content_key_b64).ok()?;
    if raw.len() != KEY_LEN {
        return None;
    }
    let mut k = [0u8; KEY_LEN];
    k.copy_from_slice(&raw);
    Some(k)
}

// ── Active-key marker: what the push path consults per payload. ──────────
//
// `.aura/keys/active.json` is written by `aura keys unlock` — it names the
// (org_id, key_version) whose cached content key should seal outgoing
// bodies. Absent marker = non-E2E org = plaintext push, unchanged.

#[derive(Debug, Serialize, Deserialize)]
pub struct ActiveKey {
    pub org_id: String,
    pub key_version: i32,
}

fn active_path() -> PathBuf {
    PathBuf::from(".aura/keys/active.json")
}

pub fn load_active() -> Option<ActiveKey> {
    std::fs::read_to_string(active_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

pub fn save_active(a: &ActiveKey) -> Result<(), String> {
    let path = active_path();
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string(a).map_err(|e| e.to_string())?;
    std::fs::write(&path, s).map_err(|e| e.to_string())
}

/// Seal a plaintext body under the currently-active org content key, if any.
/// Returns base64-encoded (ciphertext, nonce, key_version). `None` when the
/// repo/user is not in E2E mode → caller falls back to plaintext push.
pub fn maybe_seal_body(plaintext: &[u8]) -> Option<(String, String, i32)> {
    let active = load_active()?;
    let key = load_cached_key(&active.org_id, active.key_version)?;
    let (ct, nonce) = seal(&key, plaintext).ok()?;
    Some((
        b64().encode(&ct),
        b64().encode(&nonce),
        active.key_version,
    ))
}

/// Decrypt a pulled body using the currently-active org's cached content
/// key, matched on key_version. Returns Err when no active key, no cached
/// key for that version, or the AEAD tag fails. Caller should treat any
/// error as "skip this function" rather than panic.
pub fn decrypt_for_active(ct_b64: &str, nonce_b64: &str, key_version: i32) -> Result<String, String> {
    let active = load_active().ok_or("no active E2E key")?;
    let key = load_cached_key(&active.org_id, key_version)
        .ok_or_else(|| format!("no cached content key for version {}", key_version))?;
    let ct = b64().decode(ct_b64).map_err(|e| format!("bad ct b64: {}", e))?;
    let nonce = b64().decode(nonce_b64).map_err(|e| format!("bad nonce b64: {}", e))?;
    let pt = open(&key, &ct, &nonce)?;
    String::from_utf8(pt).map_err(|e| format!("body not utf-8: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let key: ContentKey = rand_content_key();
        let body = b"fn apply_limiter() { /* v1 */ }";
        let (ct, nonce) = seal(&key, body).expect("seal");
        assert_ne!(&ct, body, "ciphertext must differ from plaintext");
        let opened = open(&key, &ct, &nonce).expect("open");
        assert_eq!(&opened, body);
    }

    #[test]
    fn open_fails_with_wrong_key() {
        let k1 = rand_content_key();
        let k2 = rand_content_key();
        let (ct, nonce) = seal(&k1, b"secret").unwrap();
        assert!(open(&k2, &ct, &nonce).is_err());
    }

    #[test]
    fn wrap_unwrap_content_key_roundtrip() {
        let content_key = rand_content_key();

        let alice_secret = StaticSecret::random_from_rng(&mut OsRng);
        let alice_pub = PublicKey::from(&alice_secret);

        let (wrapped, nonce, eph_pub) =
            wrap_content_key(&content_key, &alice_pub).expect("wrap");

        let unwrapped =
            unwrap_content_key(&wrapped, &nonce, &eph_pub, &alice_secret).expect("unwrap");

        assert_eq!(unwrapped, content_key);
    }

    fn rand_content_key() -> ContentKey {
        let mut k = [0u8; KEY_LEN];
        OsRng.fill_bytes(&mut k);
        k
    }

    /// Full roundtrip: save an active marker + cached content key, seal a
    /// body through `maybe_seal_body`, decrypt through `decrypt_for_active`,
    /// and assert we recover the original plaintext. Runs in a tempdir so
    /// the on-disk `.aura/keys/*` files don't leak into the real repo.
    #[test]
    fn active_key_seal_then_decrypt_roundtrip() {
        // The cwd is process-global; every test that moves it must hold the
        // one shared lock, or it yanks the ground out from under a test in
        // another module (and `CwdGuard` puts it back even on panic).
        let _lk = crate::TEST_CWD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("aura-crypto-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let _cwd = crate::worktree::testing::CwdGuard::enter();
        std::env::set_current_dir(&tmp).unwrap();

        let org_id = "org-abc";
        let version = 7;
        let key = rand_content_key();
        save_cached_key(&KeyCacheEntry {
            org_id: org_id.to_string(),
            key_version: version,
            content_key_b64: b64().encode(key),
        })
        .unwrap();
        save_active(&ActiveKey {
            org_id: org_id.to_string(),
            key_version: version,
        })
        .unwrap();

        let body = b"fn secret() { /* top secret */ }";
        let (ct_b64, nonce_b64, ver) = maybe_seal_body(body).expect("seal");
        assert_eq!(ver, version);

        let pt = decrypt_for_active(&ct_b64, &nonce_b64, ver).expect("decrypt");
        assert_eq!(pt.as_bytes(), body);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
