//! Build + sign an `aura_blocks::Block` from an `aura_log_intent` call so
//! every intent log entry becomes a tamper-evident, signed envelope —
//! the substrate the S1 sigstore-live gate runs on top of.
//!
//! Why this exists separately from `mcp::tool_log_intent`: the MCP path
//! does many things (transcript append, .gemini.intent file, JSONL log,
//! marker file, mothership push). Pulling the *block-shaped* slice into
//! its own module lets:
//!
//!   1. Unit tests cover the pure builder + signer without spinning up
//!      MCP / file I/O / network.
//!   2. The CLI surface (`aura attest verify <block_id>`) read these
//!      blocks back without round-tripping through the JSONL log.
//!   3. A future Rekor-publish step plug in at one place
//!      (`sign_and_persist`) without spreading sigstore concerns through
//!      the rest of mcp.rs.
//!
//! Contract:
//!   - Each intent → one `BlockKind::SentinelEvent` block with payload
//!     `Sentinel { event_type: "intent", body: { agent_id, intent, ts } }`.
//!     SentinelEvent is the closest existing kind in `aura-blocks/kinds.toml`;
//!     a dedicated `Intent` kind would require a schema bump (deferred).
//!   - Signed via `aura_attestation::sign_block_in_place`.
//!   - Persisted to `<dir>/<block_id>.json` (default
//!     `.aura/blocks/<block_id>.json`). Caller picks `dir` so tests can
//!     point at a tempdir.
//!
//! Verification round-trip: `load_signed_block(path)` →
//! `aura_attestation::verify_block`.

use aura_attestation::{SigningKey, VerifyingKey};
use aura_blocks::{
    AgentRef, AnchorRef, Attestations, Block, BlockId, BlockKind, BlockPayload, BlockState,
    DeclaredImpacts, Intent, Provenance, SCHEMA_VERSION,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use time::OffsetDateTime;

#[derive(Debug)]
pub enum IntentBlockError {
    Sign(String),
    Io(String),
    Serialize(String),
    Deserialize(String),
    Verify(String),
}

impl std::fmt::Display for IntentBlockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sign(e) => write!(f, "sign: {}", e),
            Self::Io(e) => write!(f, "io: {}", e),
            Self::Serialize(e) => write!(f, "serialize: {}", e),
            Self::Deserialize(e) => write!(f, "deserialize: {}", e),
            Self::Verify(e) => write!(f, "verify: {}", e),
        }
    }
}

impl std::error::Error for IntentBlockError {}

/// Pure builder. No I/O, no signing — produces an unsigned Block ready
/// for a signer. Extracted so tests can assert the shape independent of
/// any signing-key state.
///
/// `human_id` is the dual-identity counterpart to `agent_id`: when
/// present (resolved from env / config at the MCP layer), it is bound
/// into both `payload.body.human_id` and `provenance.on_behalf_of` so
/// the canonicalized signature covers both identities jointly. Absent
/// → block carries agent identity only and is still valid.
///
/// `intent_type` is the S2-TI canonical type tag (BugFix / Refactor /
/// FeatureAdd / Revert / Performance / Docs / Deps). Caller is
/// responsible for validating against the canonical set BEFORE calling
/// — this fn does no validation so tests + downstream callers can pass
/// through whatever the signing identity already accepted. None means
/// the block carries no type tag (legacy + untyped path, still valid).
pub fn build_intent_block(
    intent_text: &str,
    agent_id: &str,
    human_id: Option<&str>,
    origin_host: &str,
    timestamp: OffsetDateTime,
    intent_type: Option<&str>,
) -> Block {
    let mut body = json!({
        "agent_id": agent_id,
        "intent": intent_text,
        "ts_unix": timestamp.unix_timestamp(),
    });
    if let Some(h) = human_id {
        body["human_id"] = json!(h);
    }
    if let Some(t) = intent_type {
        body["intent_type"] = json!(t);
    }
    let on_behalf_of = human_id
        .map(|h| AgentRef(format!("did:aura:human/{}", sanitize_agent_id(h))));
    Block {
        id: BlockId::new(),
        schema_version: SCHEMA_VERSION,
        kind: BlockKind::SentinelEvent,
        parent_id: None,
        prior_sibling_id: None,
        supersedes_id: None,
        anchor: AnchorRef::None,
        intent: Intent {
            // Use first 120 chars as the summary; full text lives in payload.
            summary: truncate_summary(intent_text, 120),
            detail: Some(intent_text.to_string()),
            parent_intent: None,
        },
        declared_impacts: DeclaredImpacts::default(),
        actual_impacts: None,
        payload: BlockPayload::Sentinel {
            event_type: "intent".into(),
            body,
        },
        state: BlockState::Completed,
        policy: None,
        provenance: Provenance {
            actor: AgentRef(format!("did:aura:agent/{}", sanitize_agent_id(agent_id))),
            on_behalf_of,
            origin_host: origin_host.to_string(),
            signature: None,
        },
        attestations: Attestations::default(),
        extensions: BTreeMap::new(),
        created_at: timestamp,
        updated_at: timestamp,
    }
}

/// Pure builder for a `key_rotation` SentinelEvent block. Captures the
/// `(old_key_id, new_key_id)` pair, both raw pubkeys (b64url-no-pad of
/// the 32-byte ed25519 public half), and a timestamp. The caller signs
/// the returned block with the OLD key so a verifier can chain a future
/// block (signed by `new_key_id`) back to the prior identity.
///
/// The pubkey fields are what makes chain-walk verification possible:
/// `key_id` is only the first 8 bytes, but verifying a historical
/// signature needs the full 32-byte pubkey. Including both `old` and
/// `new` in every rotation makes each block self-contained — a chain
/// walker can verify a single rotation without needing the link before
/// it, and only relies on prior links to anchor trust at the genesis.
///
/// `agent_id` and `origin_host` mirror `build_intent_block` so rotation
/// blocks land in the same audit surface as intent blocks.
pub fn build_key_rotation_block(
    old_key_id: &str,
    new_key_id: &str,
    old_key_pub_b64: &str,
    new_key_pub_b64: &str,
    agent_id: &str,
    origin_host: &str,
    timestamp: OffsetDateTime,
) -> Block {
    let body = json!({
        "agent_id": agent_id,
        "old_key_id": old_key_id,
        "new_key_id": new_key_id,
        "old_key_pub_b64": old_key_pub_b64,
        "new_key_pub_b64": new_key_pub_b64,
        "ts_unix": timestamp.unix_timestamp(),
    });
    Block {
        id: BlockId::new(),
        schema_version: SCHEMA_VERSION,
        kind: BlockKind::SentinelEvent,
        parent_id: None,
        prior_sibling_id: None,
        supersedes_id: None,
        anchor: AnchorRef::None,
        intent: Intent {
            summary: format!("rotate signing key {} → {}",
                truncate_summary(old_key_id, 16),
                truncate_summary(new_key_id, 16)),
            detail: Some(format!(
                "Rotated sigstore signing identity. Block is signed by the OLD key ({}); subsequent intents are signed by the NEW key ({}).",
                old_key_id, new_key_id,
            )),
            parent_intent: None,
        },
        declared_impacts: DeclaredImpacts::default(),
        actual_impacts: None,
        payload: BlockPayload::Sentinel {
            event_type: "key_rotation".into(),
            body,
        },
        state: BlockState::Completed,
        policy: None,
        provenance: Provenance {
            actor: AgentRef(format!("did:aura:agent/{}", sanitize_agent_id(agent_id))),
            on_behalf_of: None,
            origin_host: origin_host.to_string(),
            signature: None,
        },
        attestations: Attestations::default(),
        extensions: BTreeMap::new(),
        created_at: timestamp,
        updated_at: timestamp,
    }
}

/// Sign `block` in place using `key`, then persist to `<dir>/<block_id>.json`.
/// Returns the persisted path.
///
/// Side effects: creates `dir` if missing. Does NOT touch the network —
/// Rekor publish is a separate step the caller chains.
pub fn sign_and_persist(
    mut block: Block,
    key: &SigningKey,
    dir: &Path,
) -> Result<(BlockId, PathBuf), IntentBlockError> {
    aura_attestation::sign_block_in_place(&mut block, key)
        .map_err(|e| IntentBlockError::Sign(e.to_string()))?;
    std::fs::create_dir_all(dir).map_err(|e| IntentBlockError::Io(e.to_string()))?;
    let path = dir.join(format!("{}.json", block.id.0));
    let json = serde_json::to_string_pretty(&block)
        .map_err(|e| IntentBlockError::Serialize(e.to_string()))?;
    std::fs::write(&path, json).map_err(|e| IntentBlockError::Io(e.to_string()))?;
    Ok((block.id, path))
}

/// Load a signed block from disk. Caller is responsible for verifying
/// the signature against an expected pubkey.
pub fn load_signed_block(path: &Path) -> Result<Block, IntentBlockError> {
    let raw = std::fs::read_to_string(path).map_err(|e| IntentBlockError::Io(e.to_string()))?;
    serde_json::from_str(&raw).map_err(|e| IntentBlockError::Deserialize(e.to_string()))
}

/// Publish a signed intent block to Rekor and stamp the returned entry
/// reference back into the on-disk block under `attestations.rekor`.
///
/// Returns the entry reference on success. The caller decides whether to
/// also stamp the entry into a sidecar (e.g. JSONL row).
///
/// Re-canonicalizes the block exactly the way the signer did so the hash
/// Rekor records is the same hash the signature covers — without that,
/// `verify_inclusion` would later reject our own entry.
pub fn publish_signed_block_to_rekor(
    block_path: &Path,
    rekor_url: &str,
    pubkey_raw: &[u8; 32],
) -> Result<crate::rekor::RekorEntryRef, IntentBlockError> {
    let block = load_signed_block(block_path)?;
    let sig = block
        .provenance
        .signature
        .as_ref()
        .ok_or_else(|| IntentBlockError::Sign("block has no signature".into()))?;
    let sig_b64 = sig.sig_b64.clone();

    let canon = aura_blocks::canonicalize_for_signing(&block)
        .map_err(|e| IntentBlockError::Serialize(format!("canonicalize: {}", e)))?;

    let entry = crate::rekor::publish_hashedrekord(rekor_url, &canon, &sig_b64, pubkey_raw)
        .map_err(|e| IntentBlockError::Verify(format!("rekor publish: {}", e)))?;

    // Stamp the entry into the block file under attestations.rekor so a
    // later reader who only has the block can still resolve the entry.
    let raw = std::fs::read_to_string(block_path)
        .map_err(|e| IntentBlockError::Io(e.to_string()))?;
    let mut v: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| IntentBlockError::Deserialize(e.to_string()))?;
    if let Some(obj) = v
        .get_mut("attestations")
        .and_then(|a| a.as_object_mut())
    {
        obj.insert(
            "rekor".to_string(),
            json!({
                "uuid": entry.uuid,
                "log_index": entry.log_index,
                "rekor_url": entry.rekor_url,
            }),
        );
    }
    let pretty = serde_json::to_string_pretty(&v)
        .map_err(|e| IntentBlockError::Serialize(e.to_string()))?;
    std::fs::write(block_path, pretty).map_err(|e| IntentBlockError::Io(e.to_string()))?;

    Ok(entry)
}

/// CLI entry point for `aura attest verify <block_id>`.
///
/// Resolves `<block_id>` against `.aura/blocks/<block_id>.json`, verifies
/// the embedded ed25519 signature against the local signing key's public
/// half, and — when the block carries `attestations.rekor` — fetches the
/// Rekor entry and asserts no drift. Returns `Err(String)` on the first
/// failed check so the CLI exits non-zero, leaving the path layered:
///   block missing → signature bad → key mismatch → rekor drift.
pub fn verify_block_cli(block_id: &str, no_rekor: bool, json: bool) -> Result<(), String> {
    // Single source of truth: delegate the actual verification to
    // verify_block_structured so the CLI and the MCP tool can never
    // drift on what counts as "verified". The CLI just renders.
    let report = verify_block_structured(block_id, no_rekor)?;

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".into())
        );
        return Ok(());
    }

    println!("✓ signature verified");
    if let Some(id) = report.get("block_id").and_then(|x| x.as_str()) {
        println!("  block_id:   {}", id);
    }
    if let Some(algo) = report.get("algo").and_then(|x| x.as_str()) {
        println!("  algo:       {}", algo);
    }
    if let Some(k) = report.get("key_id").and_then(|x| x.as_str()) {
        println!("  key_id:     {}", k);
    }
    if let Some(h) = report.get("human_id").and_then(|x| x.as_str()) {
        println!("  human_id:   {}", h);
    }
    if let Some(t) = report.get("intent_type").and_then(|x| x.as_str()) {
        println!("  intent_type: {}", t);
    }
    if let Some(chain) = report.get("recovered_via_chain") {
        let hops = chain.get("hop_count").and_then(|x| x.as_i64()).unwrap_or(0);
        println!(
            "  ↳ recovered via chain-walk: {} rotation hop{}",
            hops,
            if hops == 1 { "" } else { "s" }
        );
    }
    match report.pointer("/rekor/status").and_then(|x| x.as_str()) {
        Some("none") => println!("  rekor:      (none)"),
        Some("skipped") => println!("  rekor:      (skipped via --no-rekor)"),
        Some("verified") => {
            println!("✓ rekor inclusion verified");
            if let Some(u) = report.pointer("/rekor/uuid").and_then(|x| x.as_str()) {
                println!("  uuid:       {}", u);
            }
            if let Some(idx) = report.pointer("/rekor/log_index").and_then(|x| x.as_i64()) {
                println!("  log_index:  {}", idx);
            }
            if let Some(url) = report.pointer("/rekor/rekor_url").and_then(|x| x.as_str()) {
                println!("  rekor_url:  {}", url);
            }
        }
        _ => {}
    }
    Ok(())
}

/// MCP entry point: same verifier as `verify_block_cli` but returns a
/// structured JSON object instead of printing. Layered the same way
/// (block missing → signature bad → key mismatch → rekor drift) so a
/// downstream agent can branch on the failure mode without parsing
/// human-readable text. Returns Err(String) on any failure; Ok(value)
/// when both signature and (when present and not skipped) rekor pass.
///
/// Schema:
///   { signature_verified: true,
///     block_id, algo, key_id,
///     human_id?: did:aura:human/...,
///     rekor: { status: "verified"|"none"|"skipped"|"error",
///              uuid?, log_index?, rekor_url?, error? } }
pub fn verify_block_structured(
    block_id: &str,
    no_rekor: bool,
) -> Result<serde_json::Value, String> {
    let block_path = resolve_block_path(block_id).ok_or_else(|| {
        format!(
            "block not found: .aura/blocks/{id}.json or .aura/attest/{id}.json",
            id = block_id
        )
    })?;
    let block = load_signed_block(&block_path)
        .map_err(|e| format!("load block: {}", e))?;

    let key_path = crate::manifest_sig::default_signing_key_path()?;
    let sk = aura_attestation::load_or_create(&key_path)
        .map_err(|e| format!("load local signing key: {}", e))?;
    let local_vk = sk.verifying_key();

    // Verification ladder, cheapest-to-establish-trust first:
    //   1. local key      — the block I signed myself (verify_block direct)
    //   2. team registry   — a TEAMMATE's key, trusted via the git-tracked
    //                        `.aura/team/keys.jsonl` registry. THIS is what
    //                        makes "Genuine record" re-checkable by anyone on
    //                        the team, not just the original author.
    //   3. rotation chain  — my OWN key, rotated out; walk the on-disk (and,
    //                        if needed, cloud-mirrored) rotation blocks.
    // Each higher rung only runs when the lower one reports a key_id mismatch.
    let mut team_info: Option<serde_json::Value> = None;
    let (signing_vk, chain_info) = match aura_attestation::verify_block(&block, &local_vk) {
        Ok(()) => (local_vk, None),
        Err(aura_attestation::BlockVerifyError::KeyIdMismatch { claimed, supplied }) => {
            let reg = crate::team_keys::registry_path();
            match crate::team_keys::resolve(&reg, &claimed) {
                // (2) A trusted teammate key — verify the block against it.
                Some(team_vk) if aura_attestation::verify_block(&block, &team_vk).is_ok() => {
                    let mut info = json!({ "key_id": claimed, "source": "team-registry" });
                    if let Some(e) = crate::team_keys::entry_for(&reg, &claimed) {
                        if let Some(h) = e.human_id { info["human_id"] = json!(h); }
                        if let Some(n) = e.display_name { info["display_name"] = json!(n); }
                        if let Some(em) = e.email { info["email"] = json!(em); }
                        if let Some(gh) = e.github_login { info["github_login"] = json!(gh); }
                    }
                    team_info = Some(info);
                    (team_vk, None)
                }
                // (3) Either no registry entry, or we hold one but the math
                // failed (tampered block) — fall to the rotation chain, which
                // recovers my own historical key and surfaces a precise error.
                _ => recover_via_rotation_chain(&block, &local_vk, &claimed, &supplied)?,
            }
        }
        Err(e) => return Err(format!("signature verify failed: {}", e)),
    };

    let verified_via = if team_info.is_some() {
        "team-registry"
    } else if chain_info.is_some() {
        "rotation-chain"
    } else {
        "local"
    };
    let mut out = json!({
        "signature_verified": true,
        "verified_via": verified_via,
        "block_id": block.id.0.to_string(),
        "algo": "ed25519",
        "key_id": signing_vk.key_id(),
    });
    if let Some(info) = chain_info {
        out["recovered_via_chain"] = info;
    }
    if let Some(info) = team_info {
        out["verified_via_team"] = info;
    }
    if let Some(human) = &block.provenance.on_behalf_of {
        out["human_id"] = json!(human.0);
    }

    let raw = std::fs::read_to_string(&block_path)
        .map_err(|e| format!("re-read block for rekor: {}", e))?;
    let v: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("parse block json: {}", e))?;
    // S2-TIV: surface payload.body.intent_type (stamped by S2-TIB) so
    // `aura attest verify --json` carries the typed-intent tag alongside
    // the cryptographic facts. Tolerate any non-string shape as missing
    // rather than poisoning the verify path.
    if let Some(t) = v
        .pointer("/payload/body/intent_type")
        .and_then(|x| x.as_str())
    {
        out["intent_type"] = json!(t);
    }
    let rekor_obj = v.pointer("/attestations/rekor");

    let rekor_section = match (rekor_obj, no_rekor) {
        (None, _) => json!({ "status": "none" }),
        (Some(_), true) => json!({ "status": "skipped" }),
        (Some(r), false) => {
            let uuid = r.get("uuid").and_then(|x| x.as_str())
                .ok_or_else(|| "attestations.rekor.uuid missing".to_string())?
                .to_string();
            let log_index: i64 = r.get("log_index").and_then(|x| x.as_i64())
                .ok_or_else(|| "attestations.rekor.log_index missing".to_string())?;
            let rekor_url = r.get("rekor_url").and_then(|x| x.as_str())
                .ok_or_else(|| "attestations.rekor.rekor_url missing".to_string())?
                .to_string();
            let canon = aura_blocks::canonicalize_for_signing(&block)
                .map_err(|e| format!("canonicalize for rekor verify: {}", e))?;
            let sig_b64 = block
                .provenance
                .signature
                .as_ref()
                .ok_or_else(|| "block lost its signature between checks".to_string())?
                .sig_b64
                .clone();
            let entry = crate::rekor::RekorEntryRef {
                uuid: uuid.clone(),
                log_index,
                rekor_url: rekor_url.clone(),
                sha256_hex: crate::rekor::sha256_hex(&canon),
            };
            crate::rekor::verify_inclusion(&entry, &sig_b64)
                .map_err(|e| format!("rekor verify failed: {}", e))?;
            json!({
                "status": "verified",
                "uuid": uuid,
                "log_index": log_index,
                "rekor_url": rekor_url,
            })
        }
    };
    out["rekor"] = rekor_section;

    // Scope check: surface what the block DECLARED it would write vs what it
    // ACTUALLY wrote (stamped at commit-time reconciliation), plus the
    // set-difference — files the agent touched beyond the scope it stated.
    // The desktop "Scope check" card renders this so a divergence the agent
    // never announced becomes visible, not merely recorded. `actual_writes` /
    // `undeclared_writes` are absent until the block is reconciled.
    out["declared_writes"] = json!(block.declared_impacts.writes_paths);
    if let Some(actual) = &block.actual_impacts {
        let undeclared: Vec<&String> = actual
            .writes_paths
            .iter()
            .filter(|p| !block.declared_impacts.writes_paths.contains(p))
            .collect();
        out["actual_writes"] = json!(actual.writes_paths);
        out["undeclared_writes"] = json!(undeclared);
    }

    Ok(out)
}

/// Mirror a signed block from the local-only `.aura/blocks/` store into the
/// git-tracked `.aura/attest/` mirror so it travels to teammates on push.
/// Best-effort; returns true only if the copy landed. Shared by the live
/// sign path (one block per intent) and `aura attest share` (backfill all).
pub fn mirror_block_to_attest(block_id: &str) -> bool {
    let src = std::path::PathBuf::from(format!(".aura/blocks/{}.json", block_id));
    let dst_dir = std::path::Path::new(".aura/attest");
    if std::fs::create_dir_all(dst_dir).is_err() {
        return false;
    }
    let dst = dst_dir.join(format!("{}.json", block_id));
    std::fs::copy(&src, &dst).is_ok()
}

/// Publish the local signing key into the git-tracked team key registry,
/// self-signed, resolving identity hints (email/name) from git config and
/// `AURA_GITHUB_LOGIN`. Idempotent + best-effort: returns the outcome, or
/// None if the registry write failed. This is the single place both the
/// MCP sign path and the `share` backfill publish from.
pub fn publish_self_to_registry(
    sk: &SigningKey,
    human_id: Option<&str>,
    now_unix: i64,
) -> Option<crate::team_keys::PublishOutcome> {
    let reg = crate::team_keys::registry_path();
    let key_id = sk.verifying_key().key_id();
    // Skip the git-config resolution entirely once we're already published.
    if crate::team_keys::load_all(&reg).iter().any(|e| e.key_id == key_id) {
        return Some(crate::team_keys::PublishOutcome::AlreadyPresent);
    }
    let dev = crate::usage_by_dev::dev_identity();
    let identity = crate::team_keys::SelfIdentity {
        human_id: human_id.map(|s| s.to_string()),
        display_name: (!dev.name.is_empty()).then(|| dev.name.clone()),
        email: (!dev.email.is_empty()).then(|| dev.email.clone()),
        github_login: std::env::var("AURA_GITHUB_LOGIN")
            .ok()
            .filter(|s| !s.trim().is_empty()),
        agent_id: Some("MCP Agent".to_string()),
    };
    crate::team_keys::publish_self(&reg, sk, &identity, now_unix).ok()
}

/// Summary of what [`share_all_attestations`] did, for the CLI to render.
pub struct ShareReport {
    pub key_id: String,
    pub key_published: bool,
    pub already_published: bool,
    pub mirrored: usize,
    pub total_signed_blocks: usize,
}

/// Make this machine's signed records team-verifiable in one shot: publish
/// our signing key into the registry, and mirror every signed block (intent
/// + key-rotation) into the git-tracked `.aura/attest/` dir. Idempotent —
/// safe to re-run; only newly-seen files are copied. The caller then commits
/// `.aura/team/keys.jsonl` + `.aura/attest/` so teammates can re-check the
/// seals on pull.
pub fn share_all_attestations() -> Result<ShareReport, String> {
    let key_path = crate::manifest_sig::default_signing_key_path()?;
    let sk = aura_attestation::load_or_create(&key_path)
        .map_err(|e| format!("load signing key: {e}"))?;
    let key_id = sk.verifying_key().key_id();
    let human_id = std::env::var("AURA_HUMAN_ID")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let now = OffsetDateTime::now_utc().unix_timestamp();

    let outcome = publish_self_to_registry(&sk, human_id.as_deref(), now);
    let key_published = matches!(outcome, Some(crate::team_keys::PublishOutcome::Added));
    let already_published = matches!(outcome, Some(crate::team_keys::PublishOutcome::AlreadyPresent));

    let dir = std::path::Path::new(".aura/blocks");
    let mut total_signed_blocks = 0usize;
    let mut mirrored = 0usize;
    if dir.exists() {
        for entry in std::fs::read_dir(dir).map_err(|e| format!("read .aura/blocks: {e}"))? {
            let path = match entry {
                Ok(e) => e.path(),
                Err(_) => continue,
            };
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let raw = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let v: serde_json::Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // Only signed sentinel_event blocks travel — intent seals and
            // key-rotation links. Unsigned command/message blocks stay local.
            let kind = v.pointer("/kind/kind").and_then(|x| x.as_str()).unwrap_or("");
            let has_sig = v.pointer("/provenance/signature/sig_b64").is_some();
            if kind != "sentinel_event" || !has_sig {
                continue;
            }
            total_signed_blocks += 1;
            if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                if mirror_block_to_attest(id) {
                    mirrored += 1;
                }
            }
        }
    }
    Ok(ShareReport {
        key_id,
        key_published,
        already_published,
        mirrored,
        total_signed_blocks,
    })
}

/// CLI surface for `aura attest share`. Runs [`share_all_attestations`] and
/// renders the result. Plain-language by default (the audience is a
/// non-engineer who wants their teammates to be able to double-check the
/// AI's work); `--json` for scripts. Verb tense is past — nothing here is a
/// promise, it already happened on disk.
pub fn share_attestations_cli(json: bool) -> Result<(), String> {
    let report = share_all_attestations()?;

    if json {
        let out = serde_json::json!({
            "key_id": report.key_id,
            "key_published": report.key_published,
            "already_published": report.already_published,
            "mirrored": report.mirrored,
            "total_signed_blocks": report.total_signed_blocks,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".into())
        );
        return Ok(());
    }

    if report.key_published {
        println!("✓ Your teammates can now check your AI work.");
        println!("  Shared the key they need to verify it's really yours.");
    } else if report.already_published {
        println!("✓ Your teammates can already check your AI work.");
        println!("  Your verification key was shared earlier — nothing to re-share.");
    } else {
        // publish_self_to_registry returned None → registry write failed.
        // Don't claim success we didn't achieve.
        println!("⚠ Couldn't share your verification key just now.");
        println!("  Your records below were still copied for the team.");
    }

    if report.total_signed_blocks == 0 {
        println!();
        println!("  No sealed records yet — nothing to copy. As soon as the AI");
        println!("  makes a change with a \"why\", it gets sealed and travels here.");
    } else {
        println!();
        println!(
            "  Copied {} of {} sealed record{} into your team's shared folder.",
            report.mirrored,
            report.total_signed_blocks,
            if report.total_signed_blocks == 1 { "" } else { "s" }
        );
    }

    println!();
    println!("  Next: commit + push so your team gets the update. Then anyone");
    println!("  can run `aura attest verify <id>` and confirm it on their own");
    println!("  machine — no need to take your word for it.");
    Ok(())
}

/// Resolve a block id to its on-disk JSON, checking both the local-only
/// store (`.aura/blocks/`) and the git-tracked attestation mirror
/// (`.aura/attest/`). A teammate who pulled the repo has only the mirror —
/// the local store is gitignored — so this fallback is what lets the seal
/// be re-checked on a fresh clone. Local store wins when both exist.
fn resolve_block_path(block_id: &str) -> Option<std::path::PathBuf> {
    let local = std::path::PathBuf::from(format!(".aura/blocks/{}.json", block_id));
    if local.exists() {
        return Some(local);
    }
    let mirror = std::path::PathBuf::from(format!(".aura/attest/{}.json", block_id));
    if mirror.exists() {
        return Some(mirror);
    }
    None
}

/// Recover the historical pubkey that signed `block` by walking the on-disk
/// key-rotation chain rooted at the local key, then verify against it. Used
/// when a block was signed by a key that has since been rotated out — i.e.
/// the signer is a PAST version of *this* identity, not a teammate. If the
/// local chain is incomplete and cloud creds are present, pulls the cloud
/// mirror once and retries.
///
/// Returns `(recovered_pub, Some(chain_info_json))` on success. Extracted
/// from the verify ladder so [`verify_block_structured`] stays readable and
/// the team-registry rung sits cleanly beside this one.
fn recover_via_rotation_chain(
    block: &Block,
    local_vk: &VerifyingKey,
    claimed: &str,
    supplied: &str,
) -> Result<(VerifyingKey, Option<serde_json::Value>), String> {
    // Rotation blocks live in the local store on the author's machine, but a
    // teammate on a fresh clone only has the git-tracked mirror — so try the
    // local store first, then fall back to `.aura/attest/` before reaching
    // for the cloud.
    let blocks_dir = std::path::Path::new(".aura/blocks");
    let attest_dir = std::path::Path::new(".aura/attest");
    let mut auto_pulled_from_cloud = false;
    let chain = match aura_attestation::walk_chain(blocks_dir, claimed, local_vk)
        .or_else(|_| aura_attestation::walk_chain(attest_dir, claimed, local_vk))
    {
        Ok(c) => c,
        Err(first_err) => {
            // Chain broken locally. If cloud creds are present, pull the
            // mirror once and retry — covers the "fresh machine, never saw a
            // rotation" case where the chain only exists on another disk.
            let pull = pull_rotation_chain_from_cloud("MCP Agent");
            let pull_status = pull.get("status").and_then(|s| s.as_str()).unwrap_or("");
            if pull_status == "pulled" {
                auto_pulled_from_cloud = true;
                aura_attestation::walk_chain(blocks_dir, claimed, local_vk)
                    .map_err(|retry_err| format!(
                        "signature verify failed: key_id mismatch (signature claims {}, local is {}); local chain-walk failed: {}; cloud pull succeeded but retry failed: {}",
                        claimed, supplied, first_err, retry_err,
                    ))?
            } else {
                let pull_reason = pull
                    .get("reason")
                    .or_else(|| pull.get("error"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("unknown");
                return Err(format!(
                    "signature verify failed: key_id mismatch (signature claims {}, local is {}); chain-walk recovery failed: {}; cloud auto-pull {}: {}",
                    claimed, supplied, first_err, pull_status, pull_reason,
                ));
            }
        }
    };
    // Retry verify with the recovered pubkey. If THIS fails, we found a
    // chain to the right identity but the signature math is bad — surface as
    // a verify failure, not a chain failure.
    aura_attestation::verify_block(block, &chain.recovered_pub).map_err(|e| {
        format!(
            "signature verify failed against chain-recovered pubkey ({}): {}",
            claimed, e,
        )
    })?;
    let hops: Vec<serde_json::Value> = chain
        .hops
        .iter()
        .map(|h| {
            json!({
                "rotation_block_id": h.rotation_block_id,
                "old_key_id": h.old_key_id,
                "new_key_id": h.new_key_id,
            })
        })
        .collect();
    let info = json!({
        "target_key_id": claimed,
        "local_key_id": supplied,
        "hops": hops,
        "hop_count": chain.hops.len(),
        "auto_pulled_from_cloud": auto_pulled_from_cloud,
    });
    Ok((chain.recovered_pub, Some(info)))
}

/// Read a block's `created_at` as an RFC-3339 string.
///
/// The field is written by `time::OffsetDateTime`'s own `Serialize`, which
/// is *positional* — `[year, ordinalDay, hour, minute, second, nanosecond,
/// offsetHours, offsetMinutes, offsetSeconds]`, not a string. Reading it with
/// `as_str()` therefore always missed, and every row came back with the
/// placeholder `"?"`; the desktop attestation panel printed that straight
/// through as `Sealed: ? ago` on blocks that carry a perfectly good stamp.
///
/// Returns `None` when the field is absent or in a shape we can't read, so
/// callers can omit the row rather than show a placeholder as if it were data.
fn read_created_at(value: Option<&serde_json::Value>) -> Option<String> {
    let value = value?;
    if let Some(s) = value.as_str() {
        return Some(s.to_string());
    }
    let parsed: OffsetDateTime = serde_json::from_value(value.clone()).ok()?;
    parsed
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

/// MCP entry point: same scan as `list_blocks_cli` but returns a JSON
/// array (one object per block) instead of printing. Lets a downstream
/// agent enumerate signed intents through MCP and feed each id into
/// `aura_attest_verify`. Schema per row matches the JSON-mode output of
/// the CLI.
///
/// `human_filter`: when Some, return only rows whose block was signed
/// with a matching human identity. Match is case-sensitive against
/// either slot (payload.body.human_id or provenance.on_behalf_of) so
/// the caller can pass either the raw env value or the canonical DID.
pub fn list_blocks_structured(
    human_filter: Option<&str>,
    intent_type_filter: Option<&str>,
) -> Result<serde_json::Value, String> {
    let dir = std::path::Path::new(".aura/blocks");
    if !dir.exists() {
        return Ok(json!([]));
    }
    let mut entries: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("read .aura/blocks: {}", e))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
        .collect();
    entries.sort();

    let mut rows: Vec<serde_json::Value> = Vec::new();
    for path in &entries {
        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("?").to_string();
        let kind = v.pointer("/kind/kind")
            .and_then(|x| x.as_str())
            .unwrap_or("?").to_string();
        let created_at = read_created_at(v.get("created_at"));
        let has_sig = v.pointer("/provenance/signature/sig_b64").is_some();
        let has_rekor = v.pointer("/attestations/rekor/uuid").is_some();
        // Same precedence as list_blocks_cli text output: prefer the
        // canonical DID form so list and verify render identical
        // identity strings for the same block.
        let human_id = v
            .pointer("/provenance/on_behalf_of")
            .and_then(|x| x.as_str())
            .or_else(|| {
                v.pointer("/payload/body/human_id")
                    .and_then(|x| x.as_str())
            })
            .map(|s| s.to_string());
        // S2-TIL: surface the typed-intent tag stamped by S2-TIB so a
        // caller can both filter on it AND see it in the row output
        // without re-reading the file.
        let intent_type = v
            .pointer("/payload/body/intent_type")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        // Apply filter: skip rows where neither slot matches the
        // requested human. Match against both raw and DID-form so the
        // caller can pass either string.
        if let Some(needle) = human_filter {
            let raw_match = v
                .pointer("/payload/body/human_id")
                .and_then(|x| x.as_str())
                .map(|s| s == needle)
                .unwrap_or(false);
            let did_match = v
                .pointer("/provenance/on_behalf_of")
                .and_then(|x| x.as_str())
                .map(|s| s == needle)
                .unwrap_or(false);
            if !raw_match && !did_match {
                continue;
            }
        }
        // S2-TIL: intent_type filter. Exact match against the canonical
        // tag stamped at sign time. Untyped blocks (intent_type field
        // absent) are excluded when a filter is present — that matches
        // aura_intent_query's semantics.
        if let Some(needle) = intent_type_filter {
            if intent_type.as_deref() != Some(needle) {
                continue;
            }
        }
        let mut row = json!({
            "id": id,
            "kind": kind,
            "created_at": created_at,
            "signature": has_sig,
            "rekor": has_rekor,
        });
        if let Some(h) = &human_id {
            row["human_id"] = json!(h);
        }
        if let Some(t) = &intent_type {
            row["intent_type"] = json!(t);
        }
        rows.push(row);
    }
    Ok(json!(rows))
}

/// CLI entry point for `aura attest list`. Scans `.aura/blocks/*.json`
/// and prints one row per block (id, kind, created_at, sig?, rekor?) so
/// a user can quickly see which intents have signatures + transparency
/// log entries without opening each JSON file by hand.
///
/// Order: lexical by file name (UUIDs sort stably). Newest-first ordering
/// would need parsing every file twice; lex order is good enough for the
/// initial surface and stable across runs.
pub fn list_blocks_cli(
    json: bool,
    human_filter: Option<&str>,
    intent_type_filter: Option<&str>,
) -> Result<(), String> {
    // Single source of truth: delegate the scan to list_blocks_structured
    // so the CLI and the MCP tool can never drift on schema or filtering.
    let value = list_blocks_structured(human_filter, intent_type_filter)?;
    let rows: &Vec<serde_json::Value> = match value.as_array() {
        Some(a) => a,
        None => {
            if json {
                println!("[]");
            } else {
                println!("(no .aura/blocks directory yet — log an intent first)");
            }
            return Ok(());
        }
    };

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(rows).unwrap_or_else(|_| "[]".into())
        );
    } else if rows.is_empty() {
        if intent_type_filter.is_some() && human_filter.is_some() {
            println!("(no signed blocks match the human + intent_type filter combination)");
        } else if intent_type_filter.is_some() {
            println!("(no signed blocks match that intent_type filter)");
        } else if human_filter.is_some() {
            println!("(no signed blocks match that human filter)");
        } else {
            println!("(no signed blocks under .aura/blocks)");
        }
    } else {
        println!(
            "{:<36}  {:<14}  {:<32}  sig  rekor  {:<12}  human_id",
            "id", "kind", "created_at", "intent_type"
        );
        for r in rows {
            println!(
                "{:<36}  {:<14}  {:<32}  {:<3}  {:<5}  {:<12}  {}",
                r["id"].as_str().unwrap_or("?"),
                r["kind"].as_str().unwrap_or("?"),
                r["created_at"].as_str().unwrap_or("?"),
                if r["signature"].as_bool().unwrap_or(false) { "✓" } else { "·" },
                if r["rekor"].as_bool().unwrap_or(false) { "✓" } else { "·" },
                r.get("intent_type").and_then(|x| x.as_str()).unwrap_or("·"),
                r.get("human_id").and_then(|x| x.as_str()).unwrap_or("·"),
            );
        }
        println!("({} block{})", rows.len(), if rows.len() == 1 { "" } else { "s" });
    }
    Ok(())
}

/// Rotate the local sigstore signing key and persist a `key_rotation`
/// SentinelEvent block signed by the OLD key. The block is the chain
/// link a verifier walks back when they see a future intent signed by
/// the NEW key — without it, the new key would look unattributed.
///
/// Returns a structured JSON envelope so the CLI and (future) MCP
/// surface render identical output:
///   { "rotation_block_id", "old_key_id", "new_key_id", "block_path" }
///
/// Errors as a string so it composes with the rest of the `*_cli`
/// surface in this module.
pub fn rotate_signing_key_structured(
    agent_id: &str,
    origin_host: &str,
) -> Result<serde_json::Value, String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};

    let key_path = crate::manifest_sig::default_signing_key_path()?;
    let (old_sk, new_sk) = aura_attestation::keyfile::rotate_key(&key_path)
        .map_err(|e| format!("rotate_key: {}", e))?;
    let old_vk = old_sk.verifying_key();
    let new_vk = new_sk.verifying_key();
    let old_key_id = old_vk.key_id();
    let new_key_id = new_vk.key_id();
    let old_key_pub_b64 = B64URL.encode(old_vk.to_bytes());
    let new_key_pub_b64 = B64URL.encode(new_vk.to_bytes());

    let block = build_key_rotation_block(
        &old_key_id,
        &new_key_id,
        &old_key_pub_b64,
        &new_key_pub_b64,
        agent_id,
        origin_host,
        OffsetDateTime::now_utc(),
    );
    let dir = std::path::Path::new(".aura/blocks");
    let (block_id, path) = sign_and_persist(block, &old_sk, dir)
        .map_err(|e| format!("sign_and_persist: {}", e))?;

    // S1-CS Phase W: best-effort push to cloud so a teammate or fresh
    // machine can pull the rotation chain and verify rotated blocks
    // they didn't witness locally. Cloud unreachable / no creds is
    // non-fatal — local rotation already succeeded and the on-disk
    // chain still works for the original signer.
    let cloud_status = push_rotation_to_cloud(
        agent_id,
        &block_id.0.to_string(),
        &old_key_id,
        &new_key_id,
        &old_key_pub_b64,
        &new_key_pub_b64,
        &path,
    );

    let mut envelope = json!({
        "rotation_block_id": block_id.0.to_string(),
        "old_key_id": old_key_id,
        "new_key_id": new_key_id,
        "block_path": path.to_string_lossy(),
        "cloud": cloud_status,
    });
    // Lift `cloud` to a tidy envelope for callers that only care about
    // the boolean — keeps the human CLI line short.
    if let Some(pushed) = cloud_status_field(&envelope, "pushed") {
        envelope["cloud_pushed"] = json!(pushed);
    }
    Ok(envelope)
}

fn cloud_status_field(envelope: &serde_json::Value, key: &str) -> Option<bool> {
    envelope
        .get("cloud")
        .and_then(|c| c.get(key))
        .and_then(|v| v.as_bool())
}

/// Push a rotation envelope to the configured aura-cloud instance.
/// Returns a small JSON status object — never errors back up. Three
/// shapes:
///
///   * `{ "status": "skipped", "reason": "no_cloud_creds" }`
///   * `{ "status": "pushed",  "pushed": true,  "deduped": false, "id": "..." }`
///   * `{ "status": "error",   "pushed": false, "error": "..." }`
///
/// Why best-effort: a CLI that fails to rotate just because the cloud
/// is offline is hostile — local rotation is the load-bearing step,
/// the cloud mirror is a teammate-discoverability boost. The envelope
/// surfaces enough state for a caller (or e2e) to assert the cloud
/// path either ran or didn't.
fn push_rotation_to_cloud(
    agent_id: &str,
    rotation_block_id: &str,
    old_key_id: &str,
    new_key_id: &str,
    old_key_pub_b64: &str,
    new_key_pub_b64: &str,
    block_path: &Path,
) -> serde_json::Value {
    use base64::{engine::general_purpose::STANDARD as B64STD, Engine};

    let cfg = crate::config::ConfigManager::load();
    let cloud_url = match cfg.cloud_url {
        Some(u) if !u.trim().is_empty() => u,
        _ => return json!({ "status": "skipped", "reason": "no_cloud_url" }),
    };
    let token = match cfg
        .cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
    {
        Some(t) if !t.trim().is_empty() => t,
        _ => return json!({ "status": "skipped", "reason": "no_cloud_token" }),
    };

    // Re-load the signed block from disk so the canonical bytes the
    // server records are byte-identical to what the verifier computes
    // on the rotation block file later. Using the in-memory `block`
    // would also work, but loading from disk catches a "we wrote one
    // thing and read another" bug at the rotate boundary itself.
    let signed = match load_signed_block(block_path) {
        Ok(b) => b,
        Err(e) => return json!({ "status": "error", "pushed": false, "error": format!("re-read block: {}", e) }),
    };
    let canon = match aura_blocks::canonicalize_for_signing(&signed) {
        Ok(c) => c,
        Err(e) => return json!({ "status": "error", "pushed": false, "error": format!("canonicalize: {}", e) }),
    };
    let sig_b64 = match signed.provenance.signature.as_ref() {
        Some(s) => s.sig_b64.clone(),
        None => return json!({ "status": "error", "pushed": false, "error": "block has no signature" }),
    };
    let ts_unix = signed.created_at.unix_timestamp();
    let block_canon_b64 = B64STD.encode(&canon);

    let body = json!({
        "agent_id": agent_id,
        "rotation_block_id": rotation_block_id,
        "old_key_id": old_key_id,
        "new_key_id": new_key_id,
        "old_key_pub_b64": old_key_pub_b64,
        "new_key_pub_b64": new_key_pub_b64,
        "block_canon_b64": block_canon_b64,
        "sig_b64": sig_b64,
        "ts_unix": ts_unix,
    });

    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return json!({ "status": "error", "pushed": false, "error": format!("http client: {}", e) }),
    };
    let url = format!("{}/api/v2/key-rotations", cloud_url.trim_end_matches('/'));
    let resp = match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
    {
        Ok(r) => r,
        Err(e) => return json!({ "status": "error", "pushed": false, "error": format!("network: {}", e) }),
    };
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        return json!({
            "status": "error",
            "pushed": false,
            "error": format!("HTTP {}", code),
        });
    }
    let parsed: serde_json::Value = match resp.json() {
        Ok(v) => v,
        Err(e) => return json!({ "status": "error", "pushed": false, "error": format!("parse: {}", e) }),
    };
    json!({
        "status": "pushed",
        "pushed": true,
        "deduped": parsed.get("deduped").and_then(|v| v.as_bool()).unwrap_or(false),
        "id": parsed.get("id").cloned().unwrap_or(serde_json::Value::Null),
    })
}

/// Minimal URL component encoder — reserves the safe set for agent_id
/// (alphanumeric, dash, underscore, dot, tilde — RFC 3986 unreserved)
/// and percent-encodes everything else. Keeps us off reqwest's optional
/// `query` feature.
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// Materialise rotation chain blocks from the cloud mirror into
/// `.aura/blocks/<id>.json` so a fresh machine can run
/// `aura_attestation::walk_chain` against the local on-disk view.
///
/// Idempotent — a row whose target file is already byte-identical to
/// what we'd write is reported as `skipped_existing`. New or differing
/// rows land as `pulled`. Per-row errors are collected so a single bad
/// row doesn't kill the rest of the pull.
///
/// Returns a structured envelope:
/// ```text
/// { "status": "skipped" | "pulled",
///   "agent_id": "MCP Agent",
///   "pulled":          [<block_id>, ...],
///   "skipped_existing":[<block_id>, ...],
///   "errors":          [{"row": <i>, "error": "..."}, ...] }
/// ```
///
/// Best-effort: missing creds → `status: "skipped"` with a reason.
/// Same boundary as `push_rotation_to_cloud` — keeps the local view
/// authoritative, the cloud as a teammate-discoverability boost.
pub fn pull_rotation_chain_from_cloud(agent_id: &str) -> serde_json::Value {
    use base64::{engine::general_purpose::STANDARD as B64STD, Engine};

    let cfg = crate::config::ConfigManager::load();
    let cloud_url = match cfg.cloud_url {
        Some(u) if !u.trim().is_empty() => u,
        _ => return json!({ "status": "skipped", "reason": "no_cloud_url" }),
    };
    let token = match cfg
        .cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
    {
        Some(t) if !t.trim().is_empty() => t,
        _ => return json!({ "status": "skipped", "reason": "no_cloud_token" }),
    };

    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return json!({ "status": "error", "error": format!("http client: {}", e) }),
    };
    // URL-encode agent_id ourselves so we don't depend on reqwest's
    // optional `query` feature flag — keeps the dep surface minimal.
    let encoded = url_encode(agent_id);
    let url = format!(
        "{}/api/v2/key-rotations?agent_id={}",
        cloud_url.trim_end_matches('/'),
        encoded
    );
    let resp = match client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
    {
        Ok(r) => r,
        Err(e) => return json!({ "status": "error", "error": format!("network: {}", e) }),
    };
    if !resp.status().is_success() {
        return json!({
            "status": "error",
            "error": format!("HTTP {}", resp.status().as_u16()),
        });
    }
    let parsed: serde_json::Value = match resp.json() {
        Ok(v) => v,
        Err(e) => return json!({ "status": "error", "error": format!("parse: {}", e) }),
    };
    let rows = match parsed.get("rotations").and_then(|x| x.as_array()) {
        Some(r) => r.clone(),
        None => return json!({ "status": "error", "error": "response missing rotations[]" }),
    };

    let dir = Path::new(".aura/blocks");
    if let Err(e) = std::fs::create_dir_all(dir) {
        return json!({ "status": "error", "error": format!("mkdir: {}", e) });
    }

    let mut pulled = Vec::new();
    let mut skipped_existing = Vec::new();
    let mut errors = Vec::new();

    for (i, row) in rows.iter().enumerate() {
        let row_block_id = row.get("rotation_block_id").and_then(|x| x.as_str()).unwrap_or("");
        let canon_b64 = row.get("block_canon_b64").and_then(|x| x.as_str()).unwrap_or("");
        let sig_b64 = row.get("sig_b64").and_then(|x| x.as_str()).unwrap_or("");
        let old_key_id = row.get("old_key_id").and_then(|x| x.as_str()).unwrap_or("");
        if row_block_id.is_empty() || canon_b64.is_empty() || sig_b64.is_empty() || old_key_id.is_empty() {
            errors.push(json!({ "row": i, "error": "row missing required field" }));
            continue;
        }

        let canon_bytes = match B64STD.decode(canon_b64) {
            Ok(b) => b,
            Err(e) => {
                errors.push(json!({ "row": i, "block_id": row_block_id, "error": format!("decode canon: {}", e) }));
                continue;
            }
        };
        let mut block_value: serde_json::Value = match serde_json::from_slice(&canon_bytes) {
            Ok(v) => v,
            Err(e) => {
                errors.push(json!({ "row": i, "block_id": row_block_id, "error": format!("parse canon: {}", e) }));
                continue;
            }
        };
        // The on-disk id must match the row's rotation_block_id —
        // anything else means the cloud handed us a different block
        // and writing it under the row's id would corrupt the chain.
        let canon_id = block_value.get("id").and_then(|x| x.as_str()).unwrap_or("");
        if canon_id != row_block_id {
            errors.push(json!({
                "row": i, "block_id": row_block_id,
                "error": format!("canon id={} != row block_id={}", canon_id, row_block_id)
            }));
            continue;
        }

        // Inject the signature stanza so verifiers see a complete signed
        // block. The OLD key signed the rotation (per S1-KR design) so
        // key_id = old_key_id. Algo is fixed — Aura signs ed25519 only.
        if let Some(prov) = block_value.get_mut("provenance").and_then(|x| x.as_object_mut()) {
            prov.insert(
                "signature".to_string(),
                json!({
                    "algo":  "ed25519",
                    "key_id": old_key_id,
                    "sig_b64": sig_b64,
                }),
            );
        } else {
            errors.push(json!({ "row": i, "block_id": row_block_id, "error": "canon missing provenance" }));
            continue;
        }

        // Re-inject the mutable envelope fields that `canonicalize_for_signing`
        // strips. Without these the file fails to deserialize as `Block`
        // (`state` and `updated_at` are required), which would break
        // `walk_chain` the moment the verifier tries to read it. Rotation
        // blocks land in `Completed` immediately at proposal time
        // (build_key_rotation_block), so that's the right state to stamp
        // back. `updated_at` mirrors `created_at` for the same reason.
        if let Some(obj) = block_value.as_object_mut() {
            obj.entry("state").or_insert(json!("completed"));
            if let Some(created) = obj.get("created_at").cloned() {
                obj.entry("updated_at").or_insert(created);
            }
            obj.entry("attestations").or_insert(json!({ "items": [] }));
        }

        let target = dir.join(format!("{}.json", row_block_id));
        let pretty = match serde_json::to_string_pretty(&block_value) {
            Ok(s) => s,
            Err(e) => {
                errors.push(json!({ "row": i, "block_id": row_block_id, "error": format!("serialize: {}", e) }));
                continue;
            }
        };

        // Idempotency: if the file on disk is byte-identical to what we'd
        // write, skip. `pretty` is deterministic from `block_value`, and
        // `block_value` is deterministic from the cloud's canon + the
        // injected signature stanza — so two pulls of the same row produce
        // the same bytes, and a re-pull is a no-op.
        if target.exists() {
            if let Ok(existing_raw) = std::fs::read_to_string(&target) {
                if existing_raw == pretty {
                    skipped_existing.push(row_block_id.to_string());
                    continue;
                }
            }
        }

        if let Err(e) = std::fs::write(&target, pretty) {
            errors.push(json!({ "row": i, "block_id": row_block_id, "error": format!("write: {}", e) }));
            continue;
        }
        pulled.push(row_block_id.to_string());
    }

    json!({
        "status": "pulled",
        "agent_id": agent_id,
        "pulled": pulled,
        "skipped_existing": skipped_existing,
        "errors": errors,
    })
}

/// CLI entry point for `aura keys sigstore-pull`. Materialises the
/// cloud rotation chain into `.aura/blocks/`. Renders text or JSON.
pub fn pull_rotation_chain_cli(json: bool) -> Result<(), String> {
    let v = pull_rotation_chain_from_cloud("MCP Agent");
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&v).unwrap_or_else(|_| "{}".into())
        );
        return Ok(());
    }
    match v.get("status").and_then(|s| s.as_str()) {
        Some("skipped") => {
            let reason = v.get("reason").and_then(|x| x.as_str()).unwrap_or("");
            println!("✗ sigstore-pull skipped ({})", reason);
            Err(format!("skipped: {}", reason))
        }
        Some("error") => {
            let err = v.get("error").and_then(|x| x.as_str()).unwrap_or("?");
            println!("✗ sigstore-pull error: {}", err);
            Err(format!("error: {}", err))
        }
        Some("pulled") => {
            let pulled = v.get("pulled").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0);
            let skipped = v.get("skipped_existing").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0);
            let errs = v.get("errors").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0);
            println!("✓ sigstore-pull complete");
            println!("  pulled:           {}", pulled);
            println!("  skipped_existing: {}", skipped);
            if errs > 0 {
                println!("  errors:           {}", errs);
            }
            Ok(())
        }
        _ => Err("unexpected envelope shape".to_string()),
    }
}

/// CLI entry point for `aura keys sigstore-rotate`. Wraps
/// `rotate_signing_key_structured` and renders text or JSON.
pub fn rotate_signing_key_cli(json: bool) -> Result<(), String> {
    let v = rotate_signing_key_structured("MCP Agent", "local")?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&v).unwrap_or_else(|_| "{}".into())
        );
    } else {
        println!("✓ rotated sigstore signing key");
        println!("  rotation_block_id: {}", v["rotation_block_id"].as_str().unwrap_or(""));
        println!("  old_key_id:        {}", v["old_key_id"].as_str().unwrap_or(""));
        println!("  new_key_id:        {}", v["new_key_id"].as_str().unwrap_or(""));
        println!("  block_path:        {}", v["block_path"].as_str().unwrap_or(""));
        match v.pointer("/cloud/status").and_then(|s| s.as_str()) {
            Some("pushed") => {
                let dedup = v.pointer("/cloud/deduped").and_then(|x| x.as_bool()).unwrap_or(false);
                println!("  cloud:             pushed{}", if dedup { " (deduped)" } else { "" });
            }
            Some("skipped") => {
                let reason = v.pointer("/cloud/reason").and_then(|x| x.as_str()).unwrap_or("");
                println!("  cloud:             skipped ({})", reason);
            }
            Some("error") => {
                let err = v.pointer("/cloud/error").and_then(|x| x.as_str()).unwrap_or("?");
                println!("  cloud:             error — {}", err);
            }
            _ => {}
        }
    }
    Ok(())
}

/// Compare local rotation blocks (under `.aura/blocks/`) against the
/// cloud's rotation mirror (`GET /api/v2/key-rotations`) and report
/// drift WITHOUT writing anything. Used by `aura doctor` to surface
/// the case where a teammate published a rotation and the local agent
/// has not pulled it yet (cloud_only) or where the agent rotated
/// locally but the push hasn't landed (local_only).
///
/// Returns one of:
///   { "status": "skipped", "reason": "no_cloud_url" | "no_cloud_token" }
///   { "status": "error",   "error":  "..." }
///   { "status": "ok",
///     "agent_id": "...",
///     "local_count":  N, "cloud_count": M,
///     "local_only":  ["block_id", ...],   // present locally, missing in cloud
///     "cloud_only":  ["block_id", ...],   // present in cloud, missing locally
///     "synced":      ["block_id", ...]    // present on both sides
///   }
///
/// "Drift" for the doctor's purposes is `local_only.len() + cloud_only.len() > 0`.
/// The local set is whatever `scan_rotation_blocks` would see (sentinel_event
/// blocks with event_type=key_rotation) — the same predicate `walk_chain` uses,
/// so a clean drift report means walk_chain has the same view as the cloud.
pub fn cloud_rotation_chain_drift(agent_id: &str) -> serde_json::Value {
    let cfg = crate::config::ConfigManager::load();
    let cloud_url = match cfg.cloud_url {
        Some(u) if !u.trim().is_empty() => u,
        _ => return json!({ "status": "skipped", "reason": "no_cloud_url" }),
    };
    let token = match cfg
        .cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
    {
        Some(t) if !t.trim().is_empty() => t,
        _ => return json!({ "status": "skipped", "reason": "no_cloud_token" }),
    };

    // Scan local .aura/blocks/ for rotation blocks. Mirrors the
    // predicate in aura_attestation::chain::scan_rotation_blocks so
    // doctor and walk_chain agree on what counts as "a rotation".
    let dir = Path::new(".aura/blocks");
    let mut local_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    if dir.is_dir() {
        if let Ok(read) = std::fs::read_dir(dir) {
            for entry in read.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let raw = match std::fs::read_to_string(&path) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let v: serde_json::Value = match serde_json::from_str(&raw) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let kind = v.pointer("/kind/kind").and_then(|x| x.as_str()).unwrap_or("");
                if kind != "sentinel_event" {
                    continue;
                }
                let evt = v
                    .pointer("/payload/event_type")
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                if evt != "key_rotation" {
                    continue;
                }
                if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                    local_ids.insert(id.to_string());
                }
            }
        }
    }

    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return json!({ "status": "error", "error": format!("http client: {}", e) }),
    };
    let encoded = url_encode(agent_id);
    let url = format!(
        "{}/api/v2/key-rotations?agent_id={}",
        cloud_url.trim_end_matches('/'),
        encoded
    );
    let resp = match client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
    {
        Ok(r) => r,
        Err(e) => return json!({ "status": "error", "error": format!("network: {}", e) }),
    };
    if !resp.status().is_success() {
        return json!({
            "status": "error",
            "error": format!("HTTP {}", resp.status().as_u16()),
        });
    }
    let parsed: serde_json::Value = match resp.json() {
        Ok(v) => v,
        Err(e) => return json!({ "status": "error", "error": format!("parse: {}", e) }),
    };
    let rows = match parsed.get("rotations").and_then(|x| x.as_array()) {
        Some(r) => r.clone(),
        None => return json!({ "status": "error", "error": "response missing rotations[]" }),
    };
    let mut cloud_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for row in &rows {
        if let Some(id) = row.get("rotation_block_id").and_then(|x| x.as_str()) {
            cloud_ids.insert(id.to_string());
        }
    }

    let local_only: Vec<String> = local_ids.difference(&cloud_ids).cloned().collect();
    let cloud_only: Vec<String> = cloud_ids.difference(&local_ids).cloned().collect();
    let synced: Vec<String> = local_ids.intersection(&cloud_ids).cloned().collect();

    json!({
        "status": "ok",
        "agent_id": agent_id,
        "local_count": local_ids.len(),
        "cloud_count": cloud_ids.len(),
        "local_only": local_only,
        "cloud_only": cloud_only,
        "synced":     synced,
    })
}

fn truncate_summary(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

fn sanitize_agent_id(s: &str) -> String {
    // Keep alnum + dash; collapse anything else to '-'. Keeps the did:
    // string parse-friendly without us having to URL-encode.
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_attestation::SigningKey;
    use aura_blocks::BlockKind;

    fn fixed_ts() -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap()
    }

    #[test]
    fn build_produces_sentinel_event_intent_payload() {
        let b = build_intent_block(
            "Refactor apply_limiter for clarity",
            "MCP Agent",
            None,
            "laptop",
            fixed_ts(),
            None,
        );
        assert!(matches!(b.kind, BlockKind::SentinelEvent));
        match &b.payload {
            BlockPayload::Sentinel { event_type, body } => {
                assert_eq!(event_type, "intent");
                assert_eq!(body["agent_id"], "MCP Agent");
                assert_eq!(body["intent"], "Refactor apply_limiter for clarity");
                assert_eq!(body["ts_unix"], 1_700_000_000_i64);
                assert!(body.get("human_id").is_none(), "absent human_id stays absent");
                assert!(body.get("intent_type").is_none(), "absent intent_type stays absent");
            }
            other => panic!("expected Sentinel payload, got {:?}", other),
        }
        assert_eq!(b.intent.summary, "Refactor apply_limiter for clarity");
        assert_eq!(b.intent.detail.as_deref(), Some("Refactor apply_limiter for clarity"));
        assert_eq!(b.provenance.origin_host, "laptop");
        assert!(b.provenance.on_behalf_of.is_none());
        // No signature yet — that's a separate step.
        assert!(b.provenance.signature.is_none());
    }

    #[test]
    fn teammate_block_verifies_via_registry_not_local_key() {
        // The end-to-end proof that the seal-verifiability gap is closed:
        // a block signed by a TEAMMATE's key (A) is re-checkable by someone
        // whose LOCAL key is a different one (B), purely because A published
        // into the team key registry. This mirrors exactly the rungs
        // `verify_block_structured` walks: local verify fails with
        // KeyIdMismatch → registry resolves the signer's trusted pubkey →
        // verify succeeds against it.
        use crate::team_keys;
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("keys.jsonl");

        // Teammate A signs an intent block.
        let teammate = SigningKey::from_seed([171u8; 32]);
        let mut block = build_intent_block(
            "Tightened the retry backoff so we stop hammering the rate limiter",
            "MCP Agent",
            Some("ashiq@naridon"),
            "ashiq-laptop",
            fixed_ts(),
            Some("BugFix"),
        );
        aura_attestation::sign_block_in_place(&mut block, &teammate).unwrap();

        // A publishes their key into the shared registry.
        let ident = team_keys::SelfIdentity {
            human_id: Some("did:aura:human/ashiq".into()),
            display_name: Some("Ashiq".into()),
            email: Some("ashiq@naridon.com".into()),
            github_login: Some("MHASK".into()),
            agent_id: Some("MCP Agent".into()),
        };
        team_keys::publish_self(&reg, &teammate, &ident, 1_700_000_000).unwrap();

        // My local key B is unrelated.
        let me = SigningKey::from_seed([99u8; 32]);
        let my_vk = me.verifying_key();
        assert_ne!(my_vk.key_id(), teammate.verifying_key().key_id());

        // Rung 1 (local): must fail with a key_id mismatch — I did not sign it.
        let claimed = match aura_attestation::verify_block(&block, &my_vk) {
            Err(aura_attestation::BlockVerifyError::KeyIdMismatch { claimed, .. }) => claimed,
            other => panic!("expected KeyIdMismatch against local key, got {other:?}"),
        };
        assert_eq!(claimed, teammate.verifying_key().key_id());

        // Rung 2 (team registry): resolves A's trusted pubkey and verifies.
        let team_vk = team_keys::resolve(&reg, &claimed)
            .expect("teammate key must resolve from the registry");
        aura_attestation::verify_block(&block, &team_vk)
            .expect("block must verify against the registry-trusted teammate key");

        // The resolved identity is what the surface shows next to the seal.
        let entry = team_keys::entry_for(&reg, &claimed).unwrap();
        assert_eq!(entry.display_name.as_deref(), Some("Ashiq"));
        assert_eq!(entry.email.as_deref(), Some("ashiq@naridon.com"));
    }

    #[test]
    fn tampered_teammate_block_does_not_verify_via_registry() {
        // Counter-balance: the registry must not rubber-stamp a tampered
        // block. Same setup, but the intent is edited after signing — the
        // registry resolves the right key, yet the signature math fails.
        use crate::team_keys;
        let dir = tempfile::tempdir().unwrap();
        let reg = dir.path().join("keys.jsonl");
        let teammate = SigningKey::from_seed([200u8; 32]);
        let mut block = build_intent_block(
            "Legit change", "MCP Agent", None, "host", fixed_ts(), None,
        );
        aura_attestation::sign_block_in_place(&mut block, &teammate).unwrap();
        team_keys::publish_self(&reg, &teammate, &team_keys::SelfIdentity::default(), 1).unwrap();

        // Tamper after signing.
        block.intent.summary = "Exfiltrate secrets".into();

        let claimed = teammate.verifying_key().key_id();
        let team_vk = team_keys::resolve(&reg, &claimed).unwrap();
        assert!(
            aura_attestation::verify_block(&block, &team_vk).is_err(),
            "a tampered teammate block must NOT verify even with a trusted key"
        );
    }

    #[test]
    fn build_with_human_id_binds_dual_identity() {
        let b = build_intent_block(
            "Sign on behalf of operator",
            "MCP Agent",
            Some("ashiq@naridon"),
            "laptop",
            fixed_ts(),
            None,
        );
        match &b.payload {
            BlockPayload::Sentinel { body, .. } => {
                assert_eq!(body["human_id"], "ashiq@naridon");
            }
            _ => panic!("expected Sentinel payload"),
        }
        let on_behalf = b.provenance.on_behalf_of.expect("on_behalf_of must be set");
        assert_eq!(on_behalf.0, "did:aura:human/ashiq-naridon");
    }

    #[test]
    fn long_intent_summary_is_truncated_with_ellipsis() {
        let long = "x".repeat(500);
        let b = build_intent_block(&long, "agent", None, "host", fixed_ts(), None);
        assert_eq!(b.intent.summary.chars().count(), 120);
        assert!(b.intent.summary.ends_with('…'));
        // Detail keeps the full text — no data loss.
        assert_eq!(b.intent.detail.as_deref(), Some(long.as_str()));
    }

    #[test]
    fn agent_id_with_special_chars_is_sanitized_in_did() {
        let b = build_intent_block("intent", "agent/with spaces & symbols!", None, "h", fixed_ts(), None);
        assert_eq!(b.provenance.actor.0, "did:aura:agent/agent-with-spaces---symbols-");
    }

    #[test]
    fn build_with_intent_type_stamps_into_payload_body() {
        // S2-TIB: when caller supplies a canonical type, it lands in
        // payload.body so the on-disk envelope mirrors the JSONL row.
        let b = build_intent_block(
            "Fix race in apply_limiter",
            "MCP",
            None,
            "host",
            fixed_ts(),
            Some("BugFix"),
        );
        match &b.payload {
            BlockPayload::Sentinel { body, .. } => {
                assert_eq!(body["intent_type"], "BugFix");
            }
            _ => panic!("expected Sentinel payload"),
        }
    }

    #[test]
    fn typed_intent_block_signs_and_verifies_with_intent_type_in_canon() {
        // S2-TIB contract: the signature must cover intent_type so a
        // verifier rejects post-hoc tampering of the type tag.
        let dir = tempfile::tempdir().unwrap();
        let key = SigningKey::from_seed([9u8; 32]);
        let block = build_intent_block(
            "typed",
            "MCP",
            None,
            "host",
            fixed_ts(),
            Some("Refactor"),
        );
        let (_, path) = sign_and_persist(block, &key, dir.path()).unwrap();
        let mut loaded = load_signed_block(&path).unwrap();
        // 1. Round-trip verifies cleanly.
        aura_attestation::verify_block(&loaded, &key.verifying_key())
            .expect("typed intent block must verify");
        match &loaded.payload {
            BlockPayload::Sentinel { body, .. } => {
                assert_eq!(body["intent_type"], "Refactor");
            }
            _ => panic!("expected Sentinel payload"),
        }
        // 2. Tampering with intent_type after signing breaks verify
        //    (canon must cover the field).
        if let BlockPayload::Sentinel { body, .. } = &mut loaded.payload {
            body["intent_type"] = json!("BugFix");
        } else {
            panic!("expected Sentinel payload");
        }
        assert!(
            aura_attestation::verify_block(&loaded, &key.verifying_key()).is_err(),
            "verify must reject tampered intent_type",
        );
    }

    #[test]
    fn sign_and_persist_writes_signed_block_loadable_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let key = SigningKey::from_seed([42u8; 32]);
        let block = build_intent_block("test", "MCP", None, "host", fixed_ts(), None);
        let block_id = block.id;
        let (returned_id, path) = sign_and_persist(block, &key, dir.path()).unwrap();
        assert_eq!(returned_id, block_id);
        assert!(path.exists());

        let loaded = load_signed_block(&path).unwrap();
        assert_eq!(loaded.id, block_id);
        assert!(loaded.provenance.signature.is_some());
        // Signature must verify against the same pubkey.
        aura_attestation::verify_block(&loaded, &key.verifying_key())
            .expect("freshly signed intent block must verify");
    }

    #[test]
    fn dual_identity_block_signs_and_verifies() {
        let dir = tempfile::tempdir().unwrap();
        let key = SigningKey::from_seed([7u8; 32]);
        let block = build_intent_block(
            "joint-sign",
            "MCP",
            Some("ashiq"),
            "host",
            fixed_ts(),
            None,
        );
        let (_, path) = sign_and_persist(block, &key, dir.path()).unwrap();
        let loaded = load_signed_block(&path).unwrap();
        assert_eq!(
            loaded.provenance.on_behalf_of.as_ref().map(|a| a.0.as_str()),
            Some("did:aura:human/ashiq")
        );
        // Joint signature must still verify since canonicalization
        // covers the new field.
        aura_attestation::verify_block(&loaded, &key.verifying_key())
            .expect("dual-identity block must verify");
    }

    #[test]
    fn verify_rejects_intent_block_signed_by_different_key() {
        let dir = tempfile::tempdir().unwrap();
        let key = SigningKey::from_seed([1u8; 32]);
        let other = SigningKey::from_seed([2u8; 32]);
        let block = build_intent_block("test", "MCP", None, "host", fixed_ts(), None);
        let (_, path) = sign_and_persist(block, &key, dir.path()).unwrap();
        let loaded = load_signed_block(&path).unwrap();
        // Wrong key → key_id mismatch fires before signature math.
        assert!(aura_attestation::verify_block(&loaded, &other.verifying_key()).is_err());
    }

    #[test]
    fn rotation_block_carries_both_pubkeys_in_body() {
        // Chain-walk verification (S1-KV) needs the full 32-byte pubkey
        // for both the OLD and NEW key in every rotation — key_id is
        // only the first 8 bytes, not enough to verify a historical
        // signature. This test pins that contract at the builder level
        // so a future refactor can't quietly drop a field.
        let b = build_key_rotation_block(
            "did:aura:key/old00000000",
            "did:aura:key/new00000000",
            "AAAA_old_pub_b64",
            "BBBB_new_pub_b64",
            "MCP Agent",
            "laptop",
            fixed_ts(),
        );
        match &b.payload {
            BlockPayload::Sentinel { event_type, body } => {
                assert_eq!(event_type, "key_rotation");
                assert_eq!(body["old_key_id"], "did:aura:key/old00000000");
                assert_eq!(body["new_key_id"], "did:aura:key/new00000000");
                assert_eq!(body["old_key_pub_b64"], "AAAA_old_pub_b64");
                assert_eq!(body["new_key_pub_b64"], "BBBB_new_pub_b64");
                assert_eq!(body["ts_unix"], 1_700_000_000_i64);
            }
            other => panic!("expected Sentinel payload, got {:?}", other),
        }
    }

    #[test]
    fn tampered_intent_text_in_payload_breaks_signature() {
        let dir = tempfile::tempdir().unwrap();
        let key = SigningKey::from_seed([3u8; 32]);
        let block = build_intent_block("original intent", "MCP", None, "host", fixed_ts(), None);
        let (_, path) = sign_and_persist(block, &key, dir.path()).unwrap();
        let mut loaded = load_signed_block(&path).unwrap();
        // Tamper with the body inside the Sentinel payload.
        if let BlockPayload::Sentinel { body, .. } = &mut loaded.payload {
            body["intent"] = json!("tampered after sign");
        } else {
            panic!("expected Sentinel payload");
        }
        assert!(aura_attestation::verify_block(&loaded, &key.verifying_key()).is_err());
    }
}
