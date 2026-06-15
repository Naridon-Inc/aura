//! `aura keys` dispatcher + HTTP wrappers for the identity-key endpoints.

use crate::config::ConfigManager;
use crate::crypto;

fn cloud() -> Result<(reqwest::blocking::Client, String, String), String> {
    let cfg = ConfigManager::load();
    let url = cfg.cloud_url.ok_or("not connected — run `aura connect`")?;
    let token = cfg
        .cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or("no cloud token")?;
    let c = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http: {}", e))?;
    Ok((c, url, token))
}

pub fn init(passphrase: &str) -> Result<(), String> {
    if crypto::load_identity()?.is_some() {
        return Err("identity already exists. `aura keys export` then delete .aura/keys to rotate.".into());
    }
    let enc = crypto::generate_identity(passphrase)?;
    crypto::save_identity(&enc)?;

    // Upload public key best-effort.
    if let Ok((c, url, token)) = cloud() {
        let body = serde_json::json!({ "public_key_b64": enc.public_key_b64 });
        let _ = c
            .post(format!("{}/api/v2/keys/identity", url))
            .header("Authorization", format!("Bearer {}", token))
            .json(&body)
            .send();
    }

    println!("✓ identity generated. pubkey: {}", enc.public_key_b64);
    Ok(())
}

pub fn show() -> Result<(), String> {
    match crypto::load_identity()? {
        Some(enc) => {
            println!("{}", enc.public_key_b64);
            Ok(())
        }
        None => Err("no identity — run `aura keys init --passphrase ...`".into()),
    }
}

/// `aura keys unlock <org_slug> --passphrase ...` — fetch the wrapped org
/// content key sealed to this user's identity pubkey, unwrap locally with
/// the passphrase-unlocked private key, cache the plaintext content key
/// under `(org_id, key_version)`, and mark it active. After this, every
/// subsequent `sync_push` seals bodies automatically; pulls decrypt
/// automatically.
pub fn unlock(org_slug: &str, passphrase: &str) -> Result<(), String> {
    let enc = crypto::load_identity()?
        .ok_or("no identity — run `aura keys init --passphrase ...` first")?;
    let identity_secret = crypto::unlock_identity(&enc, passphrase)?;

    let (c, url, token) = cloud()?;
    let resp = c
        .get(format!(
            "{}/api/v2/keys/wrapped?org_slug={}",
            url, org_slug
        ))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("network: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} — has an admin run `aura keys wrap-all` for this org?", resp.status()));
    }
    let v: serde_json::Value = resp.json().map_err(|e| format!("parse: {}", e))?;

    let org_id = v["org_id"].as_str().ok_or("response missing org_id")?;
    let key_version = v["key_version"].as_i64().ok_or("response missing key_version")? as i32;
    let wrapped_b64 = v["wrapped_content_key_b64"].as_str().ok_or("missing wrapped_content_key_b64")?;
    let wrap_nonce_b64 = v["wrap_nonce_b64"].as_str().ok_or("missing wrap_nonce_b64")?;
    let eph_pub_b64 = v["ephemeral_public_key_b64"].as_str().ok_or("missing ephemeral_public_key_b64")?;

    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let wrapped = b64.decode(wrapped_b64).map_err(|e| format!("wrapped b64: {}", e))?;
    let wrap_nonce = b64.decode(wrap_nonce_b64).map_err(|e| format!("nonce b64: {}", e))?;
    let eph_raw = b64.decode(eph_pub_b64).map_err(|e| format!("eph b64: {}", e))?;
    if eph_raw.len() != 32 {
        return Err("ephemeral_public_key_b64 wrong length".into());
    }
    let mut eph_pub = [0u8; 32];
    eph_pub.copy_from_slice(&eph_raw);

    let content_key =
        crypto::unwrap_content_key(&wrapped, &wrap_nonce, &eph_pub, &identity_secret)?;

    crypto::save_cached_key(&crypto::KeyCacheEntry {
        org_id: org_id.to_string(),
        key_version,
        content_key_b64: b64.encode(content_key),
    })?;
    crypto::save_active(&crypto::ActiveKey {
        org_id: org_id.to_string(),
        key_version,
    })?;

    println!(
        "✓ unlocked E2E for org {} (key_version {}). Seal active on next push.",
        org_slug, key_version
    );
    Ok(())
}

pub fn rotate(org_slug: &str) -> Result<(), String> {
    let (c, url, token) = cloud()?;
    let resp = c
        .post(format!("{}/api/v2/keys/rotate", url))
        .header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({ "org_slug": org_slug }))
        .send()
        .map_err(|e| format!("network: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    println!("✓ rotation requested for org {}", org_slug);
    Ok(())
}

pub fn export(out: &str) -> Result<(), String> {
    let enc = crypto::load_identity()?.ok_or("no identity to export")?;
    let s = serde_json::to_string_pretty(&enc).map_err(|e| e.to_string())?;
    std::fs::write(out, s).map_err(|e| e.to_string())?;
    println!("✓ identity exported to {}", out);
    Ok(())
}

pub fn import(file: &str) -> Result<(), String> {
    let s = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
    let enc: crypto::EncryptedIdentity = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    crypto::save_identity(&enc)?;
    println!("✓ identity imported");
    Ok(())
}

/// Verify a signed `aura/manifest` envelope.
///
/// Reads the manifest JSON, resolves a `VerifyingKey` (from `--pubkey-b64`
/// if provided, else the local default signing key's public half), and
/// runs `manifest_sig::verify_manifest`. Prints the key_id +
/// canonicalization tag on success; returns a `String` error on failure.
pub fn sigstore_verify(manifest_path: &str, pubkey_b64: Option<&str>) -> Result<(), String> {
    use base64::Engine as _;

    let raw = std::fs::read_to_string(manifest_path)
        .map_err(|e| format!("read {}: {}", manifest_path, e))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse manifest json: {}", e))?;

    let pubkey = match pubkey_b64 {
        Some(b64) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|e| format!("decode --pubkey-b64: {}", e))?;
            if bytes.len() != 32 {
                return Err(format!("pubkey must be 32 bytes, got {}", bytes.len()));
            }
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&bytes);
            aura_attestation::VerifyingKey::from_bytes(&arr)
                .map_err(|e| format!("bad pubkey: {}", e))?
        }
        None => {
            let key_path = crate::manifest_sig::default_signing_key_path()?;
            let sk = aura_attestation::load_or_create(&key_path)
                .map_err(|e| format!("load local signing key: {}", e))?;
            sk.verifying_key()
        }
    };

    crate::manifest_sig::verify_manifest(&manifest, &pubkey)
        .map_err(|e| format!("verify failed: {}", e))?;

    println!("✓ manifest signature verified");
    println!("  key_id:           {}", pubkey.key_id());
    println!("  canonicalization: {}", crate::manifest_sig::CANON_TAG);
    println!("  algo:             {}", crate::manifest_sig::SIG_ALGO);
    Ok(())
}

/// Sign an unsigned manifest in place using the local default signing
/// key. The signature envelope shape matches what `sigstore_verify`
/// expects (algo + key_id + sig_b64 + canonicalization).
pub fn sigstore_sign(manifest_path: &str, out_path: Option<&str>) -> Result<(), String> {
    let raw = std::fs::read_to_string(manifest_path)
        .map_err(|e| format!("read {}: {}", manifest_path, e))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse manifest json: {}", e))?;

    let key_path = crate::manifest_sig::default_signing_key_path()?;
    let sk = aura_attestation::load_or_create(&key_path)
        .map_err(|e| format!("load local signing key: {}", e))?;

    let signed = crate::manifest_sig::sign_manifest(manifest, &sk)
        .map_err(|e| format!("sign: {}", e))?;

    let out = out_path.unwrap_or(manifest_path);
    std::fs::write(out, serde_json::to_string_pretty(&signed).unwrap())
        .map_err(|e| format!("write {}: {}", out, e))?;

    println!("✓ manifest signed");
    println!("  key_id: {}", sk.verifying_key().key_id());
    println!("  out:    {}", out);
    Ok(())
}

/// Publish an already-signed manifest to a Rekor transparency log.
/// Computes the canonical-bytes hash that was signed (manifest with
/// `signature` slot zeroed), POSTs a hashedrekord entry, writes the
/// returned UUID + log index to a sidecar JSON file.
pub fn rekor_publish(
    manifest_path: &str,
    rekor_url: &str,
    sidecar_out: Option<&str>,
) -> Result<(), String> {
    let raw = std::fs::read_to_string(manifest_path)
        .map_err(|e| format!("read {}: {}", manifest_path, e))?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse manifest json: {}", e))?;

    let sig_env = manifest
        .get("signature")
        .ok_or_else(|| "manifest has no signature field — sign first".to_string())?;
    let sig_b64 = sig_env
        .get("sig_b64")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "manifest signature missing sig_b64".to_string())?
        .to_string();
    let claimed_key_id = sig_env
        .get("key_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "manifest signature missing key_id".to_string())?
        .to_string();

    // Resolve the local pubkey to embed in the Rekor entry. Must match
    // the signature's key_id or Rekor will accept an entry that nobody
    // can later attribute back to us.
    let key_path = crate::manifest_sig::default_signing_key_path()?;
    let sk = aura_attestation::load_or_create(&key_path)
        .map_err(|e| format!("load local signing key: {}", e))?;
    let vk = sk.verifying_key();
    if vk.key_id() != claimed_key_id {
        return Err(format!(
            "local key_id {} does not match manifest signature key_id {}",
            vk.key_id(),
            claimed_key_id
        ));
    }
    let pubkey_bytes: [u8; 32] = vk.to_bytes();

    // Recompute the canonical bytes the signer hashed: manifest with
    // signature zeroed, run through aura_blocks::canonicalize.
    let mut probe = manifest.clone();
    probe["signature"] = serde_json::Value::Null;
    let canon = aura_blocks::canonicalize(&probe)
        .map_err(|e| format!("canonicalize for rekor: {}", e))?;

    let entry = crate::rekor::publish_hashedrekord(rekor_url, &canon, &sig_b64, &pubkey_bytes)
        .map_err(|e| format!("rekor publish: {}", e))?;

    let sidecar_path = sidecar_out
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{}.rekor.json", manifest_path));
    std::fs::write(
        &sidecar_path,
        serde_json::to_string_pretty(&entry).unwrap(),
    )
    .map_err(|e| format!("write sidecar {}: {}", sidecar_path, e))?;

    // Also stamp the rekor uuid into the manifest itself so verifiers
    // who only have the manifest can still resolve.
    if let Some(obj) = manifest["signature"].as_object_mut() {
        obj.insert(
            "rekor".to_string(),
            serde_json::json!({
                "uuid": entry.uuid,
                "log_index": entry.log_index,
                "rekor_url": entry.rekor_url,
            }),
        );
    }
    std::fs::write(
        manifest_path,
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .map_err(|e| format!("rewrite manifest {}: {}", manifest_path, e))?;

    println!("✓ published to rekor");
    println!("  uuid:       {}", entry.uuid);
    println!("  log_index:  {}", entry.log_index);
    println!("  rekor_url:  {}", entry.rekor_url);
    println!("  sidecar:    {}", sidecar_path);
    Ok(())
}

/// Verify a manifest's Rekor entry. Reads the manifest + its sidecar,
/// fetches the entry from Rekor by UUID, and asserts the logged hash +
/// signature still match what we have locally.
pub fn rekor_verify(manifest_path: &str, sidecar_path: Option<&str>) -> Result<(), String> {
    let sidecar_path = sidecar_path
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{}.rekor.json", manifest_path));
    let entry_raw = std::fs::read_to_string(&sidecar_path)
        .map_err(|e| format!("read sidecar {}: {}", sidecar_path, e))?;
    let entry: crate::rekor::RekorEntryRef = serde_json::from_str(&entry_raw)
        .map_err(|e| format!("parse sidecar: {}", e))?;

    let raw = std::fs::read_to_string(manifest_path)
        .map_err(|e| format!("read manifest {}: {}", manifest_path, e))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse manifest: {}", e))?;
    let sig_b64 = manifest
        .pointer("/signature/sig_b64")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "manifest signature missing sig_b64".to_string())?;

    crate::rekor::verify_inclusion(&entry, sig_b64)
        .map_err(|e| format!("rekor verify: {}", e))?;

    println!("✓ rekor entry verified");
    println!("  uuid:       {}", entry.uuid);
    println!("  log_index:  {}", entry.log_index);
    println!("  sha256:     {}", entry.sha256_hex);
    Ok(())
}
