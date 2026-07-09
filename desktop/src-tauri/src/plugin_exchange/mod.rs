//! Plugin Exchange — share signed plugin bundles with your team over
//! the live chat rail (#308 / Commons W1).
//!
//! Mirrors the tasks (#218) / pages (#219) sync rails: JSON envelopes
//! on a hidden system channel (`__aura_plugin_exchange`), per-device
//! seq cursor, own-echo skip, `team_has_peers` gate. The rail caps a
//! body at 64 KB, so archives travel as base64 chunks (wire.rs).
//!
//! Security invariants (design Page "Aura Commons — W1 Plugin Exchange"):
//!   1. Publishing requires the bundle to verify `Verified` against the
//!      local trust store — your own key, created by `aura plugin keygen`.
//!   2. Installing NEVER loads code: extract to staging → verify the
//!      ed25519 bundle signature → move into the install root. The
//!      registry re-verifies at scan (defense in depth).
//!   3. NO auto-trust. A bundle from an unknown key returns
//!      `needs_trust` and the UI must show the key fingerprint with an
//!      explicit "Trust" action (TOFU over the authed rail).
//!   4. The archive sha256 is checked before any byte is parsed, and
//!      `archive::unpack` independently re-enforces size/count/path caps.
//!   5. Solo repos never publish or poll (`team_has_peers` gate).

pub mod archive;
pub mod store;
pub mod wire;

use std::path::{Path, PathBuf};

use aura_attestation::VerifyingKey;
use aura_plugin_sign::{verify_bundle, SignatureStatus, TrustStore};
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};

use store::{Listing, PendingMeta, SyncCursor};
use wire::{ExchangeEnvelope, ExchangePublisher, EXCHANGE_CHANNEL};

const PLUGIN_MANIFEST: &str = "aura.plugin.json";

/// A publisher that goes offline mid-publish leaves orphaned chunk
/// dirs under `pending/`; anything quiet this long is unrecoverable
/// (the rail replays from the cursor, not from scratch).
const PENDING_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 3600);

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn local_identity(repo_root: &str) -> Result<(String, String), String> {
    let id = crate::cmd_device::effective_identity(Path::new(repo_root))?;
    Ok((id.device_id, id.display_name))
}

/// `@scope/name` → ("scope", "name"). Strict: install paths are built
/// from these parts, so anything outside [a-z0-9-] is rejected.
fn split_bundle_id(id: &str) -> Result<(String, String), String> {
    let rest = id
        .strip_prefix('@')
        .ok_or_else(|| format!("bundle id `{id}` must look like @scope/name"))?;
    let (scope, name) = rest
        .split_once('/')
        .ok_or_else(|| format!("bundle id `{id}` must look like @scope/name"))?;
    let ok = |s: &str| {
        !s.is_empty()
            && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    };
    if !ok(scope) || !ok(name) {
        return Err(format!(
            "bundle id `{id}` may only use lowercase letters, digits and `-`"
        ));
    }
    Ok((scope.to_string(), name.to_string()))
}

/// Pull display fields out of a manifest JSON string without coupling
/// to the typed manifest (a newer publisher may carry fields this
/// build doesn't know).
fn manifest_summary(manifest_json: &str, bundle_id: &str) -> (String, String, Vec<String>) {
    let v: serde_json::Value = match serde_json::from_str(manifest_json) {
        Ok(v) => v,
        Err(_) => return (bundle_id.to_string(), String::new(), Vec::new()),
    };
    let name = v["name"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(bundle_id)
        .to_string();
    let description = v["description"].as_str().unwrap_or_default().to_string();
    let capabilities = v["capabilities"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|c| c.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    (name, description, capabilities)
}

/// Rename with a copy fallback for cross-filesystem moves (repo and
/// `~/.aura/plugins` can live on different volumes).
fn move_dir(src: &Path, dest: &Path) -> Result<(), String> {
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    copy_dir(src, dest)?;
    std::fs::remove_dir_all(src).map_err(|e| e.to_string())
}

fn copy_dir(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if meta.is_dir() {
            copy_dir(&from, &to)?;
        } else if meta.is_file() {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ── Publish ─────────────────────────────────────────────────────────────

/// Publish a locally-signed bundle to the team. The bundle must verify
/// `Verified` against this machine's trust store — i.e. signed with
/// YOUR key (`aura plugin keygen` + `aura plugin sign`).
#[tauri::command]
pub fn plugin_exchange_publish(repo_root: String, dir: String) -> Result<Listing, String> {
    if !crate::cmd_team::team_has_peers(&repo_root) {
        return Err(
            "this repo has no team peers yet — the exchange shares over the team rail".into(),
        );
    }
    let bundle_dir = Path::new(&dir);
    let trust = TrustStore::load(&TrustStore::default_path()).map_err(|e| e.to_string())?;
    let (key_id, label) = match verify_bundle(bundle_dir, &trust) {
        SignatureStatus::Verified { publisher_key_id, publisher } => {
            (publisher_key_id, publisher)
        }
        SignatureStatus::Unsigned => {
            return Err(
                "bundle is unsigned — run `aura plugin keygen --publisher <you>` once, then \
                 `aura plugin sign <dir>`"
                    .into(),
            )
        }
        SignatureStatus::UnknownKey { .. } => {
            return Err("you can only publish bundles signed with your own key".into())
        }
        SignatureStatus::Invalid { reason } => {
            return Err(format!("bundle signature is invalid ({reason}) — re-sign it first"))
        }
    };
    let public_key_b64 = trust
        .keys
        .iter()
        .find(|k| k.key_id == key_id)
        .map(|k| k.public_key_b64.clone())
        .ok_or_else(|| "signing key missing from trust store — re-run `aura plugin keygen`".to_string())?;

    let manifest_json = std::fs::read_to_string(bundle_dir.join(PLUGIN_MANIFEST))
        .map_err(|e| format!("{PLUGIN_MANIFEST}: {e}"))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&manifest_json).map_err(|e| format!("{PLUGIN_MANIFEST}: {e}"))?;
    let bundle_id = manifest["id"]
        .as_str()
        .ok_or_else(|| format!("{PLUGIN_MANIFEST} has no `id`"))?
        .to_string();
    split_bundle_id(&bundle_id)?; // receivers build install paths from this — validate now
    let version = manifest["version"].as_str().unwrap_or("0.0.0").to_string();

    let gz = archive::pack(bundle_dir)?;
    let archive_sha256 = sha256_hex(&gz);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&gz);
    let chunks = wire::split_b64(&b64);

    let (device_id, display) = local_identity(&repo_root)?;
    let publisher = ExchangePublisher {
        key_id,
        public_key_b64,
        label,
        device_id: device_id.clone(),
        display,
    };
    let publish_id = uuid::Uuid::new_v4().to_string();
    let ts = now_ms();

    let chunk_count = chunks.len();
    for (chunk_index, chunk_b64) in chunks.into_iter().enumerate() {
        let env = ExchangeEnvelope {
            v: 1,
            op: "publish".into(),
            publish_id: publish_id.clone(),
            bundle_id: bundle_id.clone(),
            version: version.clone(),
            manifest_json: (chunk_index == 0).then(|| manifest_json.clone()),
            publisher: publisher.clone(),
            chunk_index,
            chunk_count,
            chunk_b64,
            archive_sha256: archive_sha256.clone(),
            ts,
            origin: device_id.clone(),
        };
        let msg =
            crate::cmd_team::new_system_message(&repo_root, EXCHANGE_CHANNEL, env.to_body()?);
        crate::cmd_team::persist_and_deliver(&repo_root, msg)?;
    }

    // Self-apply so the publisher's own browser lists it immediately
    // (the poller skips our own echoes).
    let (name, description, capabilities) = manifest_summary(&manifest_json, &bundle_id);
    let listing = Listing {
        publish_id,
        bundle_id,
        version,
        name,
        description,
        capabilities,
        publisher,
        archive_sha256,
        ts,
    };
    let root = Path::new(&repo_root);
    store::write_blob(root, &listing.publish_id, &gz)?;
    let mut index = store::load_index(root);
    store::upsert_listing(&mut index, listing.clone());
    store::save_index(root, &index)?;
    Ok(listing)
}

// ── Receive ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ExchangePollResult {
    pub changed: bool,
    pub new_listings: Vec<String>,
    pub removed: Vec<String>,
    pub next_seq: i64,
}

impl ExchangePollResult {
    fn idle(next_seq: i64) -> Self {
        Self {
            changed: false,
            new_listings: Vec::new(),
            removed: Vec::new(),
            next_seq,
        }
    }
}

/// Pull exchange envelopes published since the local cursor, assemble
/// chunked archives, verify their sha256 + caps, and update the local
/// index. Idempotent; no-op for solo repos.
#[tauri::command]
pub async fn plugin_exchange_poll(repo_root: String) -> Result<ExchangePollResult, String> {
    if !crate::cmd_team::team_has_peers(&repo_root) {
        return Ok(ExchangePollResult::idle(0));
    }
    let root = Path::new(&repo_root).to_path_buf();
    let (device_id, _) = local_identity(&repo_root)?;
    let cursor = store::load_cursor(&root);
    let since = (cursor.last_seq > 0).then_some(cursor.last_seq);

    let rows = crate::cmd_team::fetch_channel_since(&repo_root, EXCHANGE_CHANNEL, since).await?;

    let mut max_seq = cursor.last_seq;
    let mut new_listings = Vec::new();
    let mut removed = Vec::new();
    for row in &rows {
        if let Some(seq) = row.seq {
            if seq > max_seq {
                max_seq = seq;
            }
        }
        let Some(env) = ExchangeEnvelope::from_body(&row.body) else {
            continue; // not an exchange envelope (or a future version)
        };
        if !env.origin.is_empty() && env.origin == device_id {
            continue; // own echo — already self-applied at publish
        }
        match env.op.as_str() {
            "publish" => {
                if let Some(listing) = ingest_publish_chunk(&root, &env) {
                    new_listings.push(listing.publish_id.clone());
                }
            }
            "remove" => {
                if let Some(id) = ingest_remove(&root, &env) {
                    removed.push(id);
                }
            }
            _ => {}
        }
    }

    if max_seq != cursor.last_seq {
        store::save_cursor(&root, &SyncCursor { last_seq: max_seq })?;
    }
    store::gc_pending(&root, PENDING_MAX_AGE);
    let changed = !new_listings.is_empty() || !removed.is_empty();
    Ok(ExchangePollResult {
        changed,
        new_listings,
        removed,
        next_seq: max_seq,
    })
}

/// Stash one chunk; when the publish is complete, verify and index it.
/// Returns the listing only on the poll that completes assembly.
fn ingest_publish_chunk(root: &Path, env: &ExchangeEnvelope) -> Option<Listing> {
    if store::load_index(root)
        .listings
        .iter()
        .any(|l| l.publish_id == env.publish_id)
    {
        return None; // already assembled (replayed range)
    }
    if store::save_part(root, &env.publish_id, env.chunk_index, &env.chunk_b64).is_err() {
        return None;
    }
    if env.chunk_index == 0 {
        let manifest_json = env.manifest_json.as_deref().unwrap_or("{}");
        let (name, description, capabilities) = manifest_summary(manifest_json, &env.bundle_id);
        let meta = PendingMeta {
            listing: Listing {
                publish_id: env.publish_id.clone(),
                bundle_id: env.bundle_id.clone(),
                version: env.version.clone(),
                name,
                description,
                capabilities,
                publisher: env.publisher.clone(),
                archive_sha256: env.archive_sha256.clone(),
                ts: env.ts,
            },
            chunk_count: env.chunk_count,
        };
        if store::save_pending_meta(root, &env.publish_id, &meta).is_err() {
            return None;
        }
    }
    try_complete(root, &env.publish_id)
}

fn try_complete(root: &Path, publish_id: &str) -> Option<Listing> {
    let meta = store::load_pending_meta(root, publish_id)?;
    let parts = store::load_parts(root, publish_id);
    let b64 = wire::join_b64(&parts, meta.chunk_count)?;
    let gz = match base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()) {
        Ok(g) => g,
        Err(_) => {
            store::clear_parts(root, publish_id); // unrecoverable — drop it
            return None;
        }
    };
    // Integrity + safety gates BEFORE the blob is stored: the sha must
    // match what every chunk claimed, and the archive must pass the
    // unpack caps (size/count/traversal) so a poisoned blob never lands
    // on disk.
    if sha256_hex(&gz) != meta.listing.archive_sha256 {
        store::clear_parts(root, publish_id);
        return None;
    }
    if archive::unpack(&gz).is_err() {
        store::clear_parts(root, publish_id);
        return None;
    }
    if split_bundle_id(&meta.listing.bundle_id).is_err() {
        store::clear_parts(root, publish_id);
        return None;
    }
    if store::write_blob(root, publish_id, &gz).is_err() {
        return None;
    }
    let mut index = store::load_index(root);
    store::upsert_listing(&mut index, meta.listing.clone());
    if store::save_index(root, &index).is_err() {
        return None;
    }
    store::clear_parts(root, publish_id);
    Some(meta.listing)
}

/// A remove is honored only when it comes from the same publisher key
/// that created the listing — a peer cannot evict someone else's bundle.
fn ingest_remove(root: &Path, env: &ExchangeEnvelope) -> Option<String> {
    let mut index = store::load_index(root);
    let listing = index
        .listings
        .iter()
        .find(|l| l.publish_id == env.publish_id)?
        .clone();
    if listing.publisher.key_id != env.publisher.key_id {
        return None;
    }
    store::remove_listing(&mut index, &env.publish_id)?;
    store::save_index(root, &index).ok()?;
    let _ = std::fs::remove_file(store::blob_path(root, &env.publish_id));
    Some(env.publish_id.clone())
}

// ── Browse / install / trust ────────────────────────────────────────────

#[derive(Serialize)]
pub struct ExchangeRow {
    #[serde(flatten)]
    pub listing: Listing,
    /// A bundle with this id is present in the local install root.
    pub installed: bool,
    /// The publisher's key is in this machine's trust store.
    pub trusted: bool,
    /// Published from this device.
    pub mine: bool,
}

#[tauri::command]
pub fn plugin_exchange_list(repo_root: String) -> Result<Vec<ExchangeRow>, String> {
    let root = Path::new(&repo_root);
    let index = store::load_index(root);
    let trust = TrustStore::load(&TrustStore::default_path()).unwrap_or_default();
    let install_root = crate::plugin_host::registry::default_install_root();
    let device_id = local_identity(&repo_root)
        .map(|(id, _)| id)
        .unwrap_or_default();
    Ok(index
        .listings
        .into_iter()
        .map(|listing| {
            let installed = split_bundle_id(&listing.bundle_id)
                .map(|(scope, name)| install_root.join(format!("@{scope}")).join(&name).is_dir())
                .unwrap_or(false);
            let trusted = trust.find(&listing.publisher.key_id).is_some();
            let mine = !device_id.is_empty() && listing.publisher.device_id == device_id;
            ExchangeRow {
                listing,
                installed,
                trusted,
                mine,
            }
        })
        .collect())
}

#[derive(Serialize)]
pub struct NeedsTrust {
    pub key_id: String,
    pub label: String,
}

#[derive(Serialize)]
pub struct InstallResult {
    pub installed: bool,
    /// Set when the publisher's key isn't trusted yet — the UI must
    /// show the fingerprint and offer an explicit Trust action.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_trust: Option<NeedsTrust>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_dir: Option<String>,
}

/// Install a published bundle: blob → staging → ed25519 verify → move
/// into the install root. Never loads a byte of plugin code, and fails
/// closed on any signature problem.
#[tauri::command]
pub fn plugin_exchange_install(
    repo_root: String,
    publish_id: String,
) -> Result<InstallResult, String> {
    let root = Path::new(&repo_root);
    let index = store::load_index(root);
    let listing = index
        .listings
        .iter()
        .find(|l| l.publish_id == publish_id)
        .ok_or_else(|| format!("no exchange listing {publish_id}"))?;

    let gz = store::read_blob(root, &publish_id)?;
    if sha256_hex(&gz) != listing.archive_sha256 {
        return Err("archive blob does not match its published sha256".into());
    }
    let files = archive::unpack(&gz)?;

    let staging = store::exchange_root(root)
        .join("staging")
        .join(publish_id.replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "_"));
    let _ = std::fs::remove_dir_all(&staging);
    archive::extract_to(&staging, &files)?;

    let cleanup = |staging: &PathBuf| {
        let _ = std::fs::remove_dir_all(staging);
    };

    let trust = TrustStore::load(&TrustStore::default_path()).map_err(|e| e.to_string())?;
    match verify_bundle(&staging, &trust) {
        SignatureStatus::Verified { .. } => {
            let (scope, name) = split_bundle_id(&listing.bundle_id)?;
            let dest = crate::plugin_host::registry::default_install_root()
                .join(format!("@{scope}"))
                .join(&name);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            if dest.exists() {
                std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
            }
            move_dir(&staging, &dest)?;
            Ok(InstallResult {
                installed: true,
                needs_trust: None,
                install_dir: Some(dest.to_string_lossy().into_owned()),
            })
        }
        SignatureStatus::UnknownKey { publisher_key_id } => {
            cleanup(&staging);
            Ok(InstallResult {
                installed: false,
                needs_trust: Some(NeedsTrust {
                    key_id: publisher_key_id,
                    label: listing.publisher.label.clone(),
                }),
                install_dir: None,
            })
        }
        SignatureStatus::Unsigned => {
            cleanup(&staging);
            Err("bundle arrived unsigned — refusing to install".into())
        }
        SignatureStatus::Invalid { reason } => {
            cleanup(&staging);
            Err(format!("bundle failed signature verification ({reason}) — refusing to install"))
        }
    }
}

/// Explicitly trust a listing's publisher key (TOFU over the authed
/// rail). The key bytes must hash to the key id the listing claims.
#[tauri::command]
pub fn plugin_exchange_trust(repo_root: String, publish_id: String) -> Result<(), String> {
    let root = Path::new(&repo_root);
    let index = store::load_index(root);
    let listing = index
        .listings
        .iter()
        .find(|l| l.publish_id == publish_id)
        .ok_or_else(|| format!("no exchange listing {publish_id}"))?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(listing.publisher.public_key_b64.as_bytes())
        .map_err(|e| format!("publisher key is not valid base64: {e}"))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "publisher key is not a 32-byte ed25519 key".to_string())?;
    let vk = VerifyingKey::from_bytes(&arr).map_err(|e| e.to_string())?;
    if vk.key_id() != listing.publisher.key_id {
        return Err("publisher key does not match its claimed fingerprint".into());
    }

    let path = TrustStore::default_path();
    let mut trust = TrustStore::load(&path).map_err(|e| e.to_string())?;
    trust.add_key(&vk, &listing.publisher.label);
    trust.save(&path).map_err(|e| e.to_string())
}

/// Withdraw one of YOUR listings: emit the `remove` envelope peers
/// already honor (publisher-key-matched in `ingest_remove`), then drop
/// the local listing + blob. Gated on the listing having been published
/// from this device — you cannot evict a teammate's bundle, and the
/// envelope carries the original publisher key so receivers enforce the
/// same rule independently.
#[tauri::command]
pub fn plugin_exchange_unpublish(repo_root: String, publish_id: String) -> Result<(), String> {
    let root = Path::new(&repo_root);
    let mut index = store::load_index(root);
    let listing = index
        .listings
        .iter()
        .find(|l| l.publish_id == publish_id)
        .cloned()
        .ok_or_else(|| format!("no exchange listing {publish_id}"))?;
    let (device_id, _) = local_identity(&repo_root)?;
    if listing.publisher.device_id != device_id {
        return Err("only the publishing device can unpublish a listing".into());
    }

    // Tell the team BEFORE touching local state — if the rail write
    // fails, the listing stays so we never sit in a half-removed state
    // peers know nothing about.
    if crate::cmd_team::team_has_peers(&repo_root) {
        let env = ExchangeEnvelope {
            v: 1,
            op: "remove".into(),
            publish_id: publish_id.clone(),
            bundle_id: listing.bundle_id.clone(),
            version: listing.version.clone(),
            manifest_json: None,
            publisher: listing.publisher.clone(),
            chunk_index: 0,
            chunk_count: 0,
            chunk_b64: String::new(),
            archive_sha256: listing.archive_sha256.clone(),
            ts: now_ms(),
            origin: device_id,
        };
        let msg =
            crate::cmd_team::new_system_message(&repo_root, EXCHANGE_CHANNEL, env.to_body()?);
        crate::cmd_team::persist_and_deliver(&repo_root, msg)?;
    }

    store::remove_listing(&mut index, &publish_id);
    store::save_index(root, &index)?;
    let _ = std::fs::remove_file(store::blob_path(root, &publish_id));
    store::clear_parts(root, &publish_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_ids_are_validated_strictly() {
        assert_eq!(
            split_bundle_id("@acme/tools").unwrap(),
            ("acme".to_string(), "tools".to_string())
        );
        for bad in [
            "acme/tools",
            "@acme",
            "@Acme/tools",
            "@acme/../evil",
            "@acme/to ols",
            "@/x",
            "@a/",
        ] {
            assert!(split_bundle_id(bad).is_err(), "expected rejection for `{bad}`");
        }
    }

    #[test]
    fn manifest_summary_degrades_gracefully() {
        let (name, desc, caps) = manifest_summary(
            r#"{"name":"Demo","description":"d","capabilities":["ui:toast"]}"#,
            "@a/x",
        );
        assert_eq!((name.as_str(), desc.as_str()), ("Demo", "d"));
        assert_eq!(caps, vec!["ui:toast"]);
        let (name, _, caps) = manifest_summary("not json", "@a/x");
        assert_eq!(name, "@a/x");
        assert!(caps.is_empty());
    }

    #[test]
    fn try_complete_assembles_and_rejects_tampered_sha() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        // Build a real archive from a demo bundle.
        let bundle = root.join("bundle");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("aura.plugin.json"), b"{\"id\":\"@a/x\"}").unwrap();
        std::fs::write(bundle.join("worker.js"), b"x").unwrap();
        let gz = archive::pack(&bundle).unwrap();
        let sha = sha256_hex(&gz);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&gz);
        let chunks = wire::split_b64(&b64);

        let listing = Listing {
            publish_id: "pub-1".into(),
            bundle_id: "@a/x".into(),
            version: "1.0.0".into(),
            name: "X".into(),
            description: String::new(),
            capabilities: Vec::new(),
            publisher: ExchangePublisher {
                key_id: "k1".into(),
                public_key_b64: "cHVi".into(),
                label: "Acme".into(),
                device_id: "dev-2".into(),
                display: "Bea".into(),
            },
            archive_sha256: sha,
            ts: 1,
        };
        let meta = PendingMeta {
            listing: listing.clone(),
            chunk_count: chunks.len(),
        };
        store::save_pending_meta(root, "pub-1", &meta).unwrap();
        // Incomplete: no parts yet.
        assert!(try_complete(root, "pub-1").is_none());
        for (i, c) in chunks.iter().enumerate() {
            store::save_part(root, "pub-1", i, c).unwrap();
        }
        let done = try_complete(root, "pub-1").expect("assembles");
        assert_eq!(done.bundle_id, "@a/x");
        assert_eq!(store::load_index(root).listings.len(), 1);
        assert!(store::read_blob(root, "pub-1").is_ok());

        // Tampered: same parts, wrong sha → dropped, nothing stored.
        let mut bad_meta = meta;
        bad_meta.listing.publish_id = "pub-2".into();
        bad_meta.listing.archive_sha256 = "0".repeat(64);
        store::save_pending_meta(root, "pub-2", &bad_meta).unwrap();
        for (i, c) in chunks.iter().enumerate() {
            store::save_part(root, "pub-2", i, c).unwrap();
        }
        assert!(try_complete(root, "pub-2").is_none());
        assert!(store::read_blob(root, "pub-2").is_err());
    }

    #[test]
    fn remove_requires_matching_publisher_key() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let publisher = ExchangePublisher {
            key_id: "k1".into(),
            public_key_b64: "cHVi".into(),
            label: "Acme".into(),
            device_id: "dev-2".into(),
            display: "Bea".into(),
        };
        let mut index = store::load_index(root);
        store::upsert_listing(
            &mut index,
            Listing {
                publish_id: "pub-1".into(),
                bundle_id: "@a/x".into(),
                version: "1".into(),
                name: "X".into(),
                description: String::new(),
                capabilities: Vec::new(),
                publisher: publisher.clone(),
                archive_sha256: "f".into(),
                ts: 1,
            },
        );
        store::save_index(root, &index).unwrap();

        let mut env = ExchangeEnvelope {
            v: 1,
            op: "remove".into(),
            publish_id: "pub-1".into(),
            bundle_id: "@a/x".into(),
            version: "1".into(),
            manifest_json: None,
            publisher: ExchangePublisher {
                key_id: "EVIL".into(),
                ..publisher.clone()
            },
            chunk_index: 0,
            chunk_count: 0,
            chunk_b64: String::new(),
            archive_sha256: "f".into(),
            ts: 2,
            origin: "dev-3".into(),
        };
        // Wrong key → refused, listing intact.
        assert!(ingest_remove(root, &env).is_none());
        assert_eq!(store::load_index(root).listings.len(), 1);
        // Right key → removed.
        env.publisher.key_id = "k1".into();
        assert_eq!(ingest_remove(root, &env).as_deref(), Some("pub-1"));
        assert!(store::load_index(root).listings.is_empty());
    }

    /// The exact envelope `plugin_exchange_unpublish` emits (zero
    /// chunks, no manifest) must survive `from_body` — the publish-only
    /// chunk validation must not reject removes.
    #[test]
    fn unpublish_remove_envelope_roundtrips() {
        let env = ExchangeEnvelope {
            v: 1,
            op: "remove".into(),
            publish_id: "pub-1".into(),
            bundle_id: "@a/x".into(),
            version: "1".into(),
            manifest_json: None,
            publisher: ExchangePublisher {
                key_id: "k1".into(),
                public_key_b64: "cHVi".into(),
                label: "Acme".into(),
                device_id: "dev-1".into(),
                display: "Ada".into(),
            },
            chunk_index: 0,
            chunk_count: 0,
            chunk_b64: String::new(),
            archive_sha256: "f".into(),
            ts: 9,
            origin: "dev-1".into(),
        };
        let body = env.to_body().unwrap();
        let parsed = ExchangeEnvelope::from_body(&body).expect("remove parses");
        assert_eq!(parsed.op, "remove");
        assert_eq!(parsed.publish_id, "pub-1");
        assert_eq!(parsed.publisher.key_id, "k1");
    }
}
