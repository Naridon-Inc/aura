//! Key rotation chain walker.
//!
//! When a verifier sees a block whose signature `key_id` doesn't match
//! the local pubkey, the local key may simply be a successor of the
//! signer — produced by one or more `aura keys sigstore-rotate` calls.
//! This module walks the on-disk rotation blocks back from the local
//! pubkey to recover the historical pubkey that signed the block under
//! review, so the verifier can complete the signature check instead of
//! rejecting blanket-style.
//!
//! Trust model:
//!
//!   - The local keyfile is the trust root. Its pubkey is what we
//!     unconditionally believe.
//!   - Each rotation block is signed by the OLD key and announces the
//!     NEW key (full pubkey, not just key_id). To accept it, the
//!     walker must verify the rotation's own signature against the
//!     OLD pubkey — which it learns from the SAME rotation block's
//!     `body.old_key_pub_b64` for the genesis hop, and from the next
//!     newer rotation's `body.new_key_pub_b64` for every subsequent
//!     hop.
//!   - Each link's `body.new_key_pub_b64` MUST hash to the next
//!     newer pubkey we already trust. If it doesn't, the chain is
//!     forged at that point and we reject.
//!
//! What this is NOT: a transparency-log substitute. The walker only
//! proves "the key that signed block X was at one point delegated by
//! the key that holds the current keyfile." It cannot detect that an
//! attacker who steals the seed would have produced a valid chain —
//! that's a Rekor / Sigstore concern handled separately.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use serde_json::Value;

use crate::block::verify_block;
use crate::keys::VerifyingKey;
use aura_blocks::Block;

/// One step in a recovered chain. `block_id` is the rotation block's
/// id, useful for surfacing which rotations were traversed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainHop {
    pub rotation_block_id: String,
    pub old_key_id: String,
    pub new_key_id: String,
}

/// Successful chain-walk result. `recovered_pub` is the pubkey that
/// signed the block under review. `hops` is ordered newest → oldest;
/// the last hop's `old_key_id` equals the target.
#[derive(Debug, Clone)]
pub struct ChainResult {
    pub recovered_pub: VerifyingKey,
    pub hops: Vec<ChainHop>,
}

#[derive(Debug, thiserror::Error)]
pub enum ChainError {
    #[error("read blocks dir {0}: {1}")]
    ReadDir(PathBuf, String),
    #[error("no key_rotation blocks found under {0}")]
    NoRotationsFound(PathBuf),
    #[error("chain broken: no rotation block announces {needle} as new_key_id")]
    ChainBroken { needle: String },
    #[error("rotation {block_id}: {field} not valid b64url: {why}")]
    PubB64Malformed {
        block_id: String,
        field: &'static str,
        why: String,
    },
    #[error("rotation {block_id}: {field} is {got} bytes, expected 32")]
    PubLenWrong {
        block_id: String,
        field: &'static str,
        got: usize,
    },
    #[error("rotation {block_id}: {field} bytes not a valid ed25519 pubkey: {why}")]
    PubBytesInvalid {
        block_id: String,
        field: &'static str,
        why: String,
    },
    #[error("rotation {block_id}: {field}={pub_key_id} but body claims {claimed}")]
    PubKeyIdMismatch {
        block_id: String,
        field: &'static str,
        pub_key_id: String,
        claimed: String,
    },
    #[error("rotation {block_id} signature did not verify against announcing key: {why}")]
    RotationSigInvalid { block_id: String, why: String },
    #[error("rotation {block_id} parse error: {why}")]
    RotationParse { block_id: String, why: String },
    #[error("walker exceeded max hops ({0}) — possible cycle in rotation graph")]
    TooManyHops(usize),
}

/// Cap on chain depth. Real-world rotations are infrequent; an
/// unbounded walker risks DoS on a malicious rotation graph with a
/// cycle. 1024 is generous and still bounds the worst case.
const MAX_HOPS: usize = 1024;

#[derive(Debug, Clone)]
struct RotationRow {
    block_id: String,
    path: PathBuf,
    old_key_id: String,
    new_key_id: String,
    old_pub_b64: String,
    new_pub_b64: String,
}

/// Walk the rotation chain stored under `blocks_dir` from `local_pub`
/// back to `target_key_id`. Returns the recovered pubkey and the
/// hop list on success.
///
/// Fast path: if `local_pub.key_id() == target_key_id`, returns
/// immediately with zero hops — the caller's verifier was passed the
/// correct key already.
pub fn walk_chain(
    blocks_dir: &Path,
    target_key_id: &str,
    local_pub: &VerifyingKey,
) -> Result<ChainResult, ChainError> {
    let local_id = local_pub.key_id();
    if local_id == target_key_id {
        return Ok(ChainResult {
            recovered_pub: *local_pub,
            hops: Vec::new(),
        });
    }

    let rows = scan_rotation_blocks(blocks_dir)?;
    if rows.is_empty() {
        return Err(ChainError::NoRotationsFound(blocks_dir.to_path_buf()));
    }
    let by_new: HashMap<String, RotationRow> = rows
        .into_iter()
        .map(|r| (r.new_key_id.clone(), r))
        .collect();

    let mut cur_pub = *local_pub;
    let mut cur_id = local_id;
    let mut hops = Vec::<ChainHop>::new();

    for _ in 0..MAX_HOPS {
        let row = by_new.get(&cur_id).ok_or_else(|| ChainError::ChainBroken {
            needle: cur_id.clone(),
        })?;

        // Sanity: row.new_key_pub_b64 must decode to the pubkey we
        // currently trust. Without this check, an attacker could insert
        // a rotation block whose body fields mismatch the actual key
        // we're chasing and break the chain semantics silently.
        let announced_new = decode_pub(&row.new_pub_b64, &row.block_id, "new_key_pub_b64")?;
        if announced_new.key_id() != cur_id {
            return Err(ChainError::PubKeyIdMismatch {
                block_id: row.block_id.clone(),
                field: "new_key_pub_b64",
                pub_key_id: announced_new.key_id(),
                claimed: cur_id.clone(),
            });
        }
        if announced_new != cur_pub {
            // key_id matched (first 8 bytes) but full pubkey didn't —
            // a deliberately crafted collision attempt. Fail loud.
            return Err(ChainError::PubKeyIdMismatch {
                block_id: row.block_id.clone(),
                field: "new_key_pub_b64",
                pub_key_id: announced_new.key_id(),
                claimed: format!("{} (full pubkey divergence)", cur_id),
            });
        }

        // The OLD pubkey announced in the same block is what signed
        // this rotation. We must verify the rotation's signature
        // against it before trusting `old_key_id`.
        let old_pub = decode_pub(&row.old_pub_b64, &row.block_id, "old_key_pub_b64")?;
        if old_pub.key_id() != row.old_key_id {
            return Err(ChainError::PubKeyIdMismatch {
                block_id: row.block_id.clone(),
                field: "old_key_pub_b64",
                pub_key_id: old_pub.key_id(),
                claimed: row.old_key_id.clone(),
            });
        }
        let block: Block = load_block(&row.path).map_err(|e| ChainError::RotationParse {
            block_id: row.block_id.clone(),
            why: e,
        })?;
        verify_block(&block, &old_pub).map_err(|e| ChainError::RotationSigInvalid {
            block_id: row.block_id.clone(),
            why: e.to_string(),
        })?;

        hops.push(ChainHop {
            rotation_block_id: row.block_id.clone(),
            old_key_id: row.old_key_id.clone(),
            new_key_id: row.new_key_id.clone(),
        });

        cur_pub = old_pub;
        cur_id = row.old_key_id.clone();

        if cur_id == target_key_id {
            return Ok(ChainResult {
                recovered_pub: cur_pub,
                hops,
            });
        }
    }

    Err(ChainError::TooManyHops(MAX_HOPS))
}

fn scan_rotation_blocks(dir: &Path) -> Result<Vec<RotationRow>, ChainError> {
    let mut out = Vec::new();
    let read = std::fs::read_dir(dir)
        .map_err(|e| ChainError::ReadDir(dir.to_path_buf(), e.to_string()))?;
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let v: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Only sentinel_event blocks with event_type=key_rotation.
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
        let body = match v.pointer("/payload/body") {
            Some(b) => b,
            None => continue,
        };
        let old_key_id = body
            .get("old_key_id")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let new_key_id = body
            .get("new_key_id")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let old_pub_b64 = body
            .get("old_key_pub_b64")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let new_pub_b64 = body
            .get("new_key_pub_b64")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let block_id = v
            .get("id")
            .and_then(|x| x.as_str())
            .unwrap_or("?")
            .to_string();
        // A rotation block missing any of these fields is from an
        // older schema (pre-S1-KV) and can't participate in chain
        // walking — skip silently rather than abort the scan, so a
        // mixed corpus still returns the rows that ARE valid.
        if let (Some(o), Some(n), Some(op), Some(np)) =
            (old_key_id, new_key_id, old_pub_b64, new_pub_b64)
        {
            out.push(RotationRow {
                block_id,
                path,
                old_key_id: o,
                new_key_id: n,
                old_pub_b64: op,
                new_pub_b64: np,
            });
        }
    }
    Ok(out)
}

fn decode_pub(b64: &str, block_id: &str, field: &'static str) -> Result<VerifyingKey, ChainError> {
    let bytes = B64URL
        .decode(b64)
        .map_err(|e| ChainError::PubB64Malformed {
            block_id: block_id.to_string(),
            field,
            why: e.to_string(),
        })?;
    let arr: [u8; 32] =
        bytes.as_slice().try_into().map_err(|_| ChainError::PubLenWrong {
            block_id: block_id.to_string(),
            field,
            got: bytes.len(),
        })?;
    VerifyingKey::from_bytes(&arr).map_err(|e| ChainError::PubBytesInvalid {
        block_id: block_id.to_string(),
        field,
        why: e.to_string(),
    })
}

fn load_block(path: &Path) -> Result<Block, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block::sign_block_in_place;
    use crate::keys::SigningKey;
    use aura_blocks::{
        AgentRef, AnchorRef, Attestations, BlockId, BlockKind, BlockPayload, BlockState,
        DeclaredImpacts, Intent, Provenance, SCHEMA_VERSION,
    };
    use serde_json::json;
    use std::collections::BTreeMap;
    use tempfile::tempdir;
    use time::OffsetDateTime;

    fn make_rotation_block(
        old: &SigningKey,
        new: &SigningKey,
        ts: i64,
    ) -> Block {
        let old_vk = old.verifying_key();
        let new_vk = new.verifying_key();
        let body = json!({
            "agent_id": "test",
            "old_key_id": old_vk.key_id(),
            "new_key_id": new_vk.key_id(),
            "old_key_pub_b64": B64URL.encode(old_vk.to_bytes()),
            "new_key_pub_b64": B64URL.encode(new_vk.to_bytes()),
            "ts_unix": ts,
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
                summary: "rotate".into(),
                detail: None,
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
                actor: AgentRef("did:aura:agent/test".into()),
                on_behalf_of: None,
                origin_host: "test".into(),
                signature: None,
            },
            attestations: Attestations::default(),
            extensions: BTreeMap::new(),
            created_at: OffsetDateTime::from_unix_timestamp(ts).unwrap(),
            updated_at: OffsetDateTime::from_unix_timestamp(ts).unwrap(),
        }
    }

    fn persist_signed(block: &mut Block, signer: &SigningKey, dir: &Path) {
        sign_block_in_place(block, signer).unwrap();
        let path = dir.join(format!("{}.json", block.id.0));
        let json = serde_json::to_string_pretty(block).unwrap();
        std::fs::write(path, json).unwrap();
    }

    #[test]
    fn fast_path_no_rotation_needed() {
        let dir = tempdir().unwrap();
        let local = SigningKey::from_seed([1u8; 32]);
        let res = walk_chain(dir.path(), &local.verifying_key().key_id(), &local.verifying_key())
            .unwrap();
        assert!(res.hops.is_empty());
        assert_eq!(res.recovered_pub, local.verifying_key());
    }

    #[test]
    fn single_hop_recovers_old_pub() {
        // local key is K1; target is K0; one rotation block bridges.
        let dir = tempdir().unwrap();
        let k0 = SigningKey::from_seed([10u8; 32]);
        let k1 = SigningKey::from_seed([11u8; 32]);
        let mut rot = make_rotation_block(&k0, &k1, 1700);
        persist_signed(&mut rot, &k0, dir.path());

        let res = walk_chain(dir.path(), &k0.verifying_key().key_id(), &k1.verifying_key())
            .unwrap();
        assert_eq!(res.recovered_pub, k0.verifying_key());
        assert_eq!(res.hops.len(), 1);
        assert_eq!(res.hops[0].old_key_id, k0.verifying_key().key_id());
        assert_eq!(res.hops[0].new_key_id, k1.verifying_key().key_id());
    }

    #[test]
    fn multi_hop_walks_back_to_genesis() {
        // K0 → K1 → K2 → K3 (local). Verifier needs K0.
        let dir = tempdir().unwrap();
        let k0 = SigningKey::from_seed([20u8; 32]);
        let k1 = SigningKey::from_seed([21u8; 32]);
        let k2 = SigningKey::from_seed([22u8; 32]);
        let k3 = SigningKey::from_seed([23u8; 32]);
        let mut r1 = make_rotation_block(&k0, &k1, 1700);
        persist_signed(&mut r1, &k0, dir.path());
        let mut r2 = make_rotation_block(&k1, &k2, 1701);
        persist_signed(&mut r2, &k1, dir.path());
        let mut r3 = make_rotation_block(&k2, &k3, 1702);
        persist_signed(&mut r3, &k2, dir.path());

        let res = walk_chain(dir.path(), &k0.verifying_key().key_id(), &k3.verifying_key())
            .unwrap();
        assert_eq!(res.recovered_pub, k0.verifying_key());
        assert_eq!(res.hops.len(), 3);
        // Newest first.
        assert_eq!(res.hops[0].new_key_id, k3.verifying_key().key_id());
        assert_eq!(res.hops[2].old_key_id, k0.verifying_key().key_id());
    }

    #[test]
    fn missing_link_breaks_chain() {
        // K0 → K1 exists; K1 → K2 missing; local is K2 looking for K0.
        let dir = tempdir().unwrap();
        let k0 = SigningKey::from_seed([30u8; 32]);
        let k1 = SigningKey::from_seed([31u8; 32]);
        let k2 = SigningKey::from_seed([32u8; 32]);
        let mut r1 = make_rotation_block(&k0, &k1, 1700);
        persist_signed(&mut r1, &k0, dir.path());
        // Note: NO r2 written.

        let err = walk_chain(dir.path(), &k0.verifying_key().key_id(), &k2.verifying_key())
            .unwrap_err();
        match err {
            ChainError::ChainBroken { needle } => {
                assert_eq!(needle, k2.verifying_key().key_id());
            }
            other => panic!("expected ChainBroken, got {:?}", other),
        }
    }

    #[test]
    fn tampered_rotation_signature_rejected() {
        let dir = tempdir().unwrap();
        let k0 = SigningKey::from_seed([40u8; 32]);
        let k1 = SigningKey::from_seed([41u8; 32]);
        let mut rot = make_rotation_block(&k0, &k1, 1700);
        sign_block_in_place(&mut rot, &k0).unwrap();
        // Tamper with body AFTER signing — body bytes change but
        // signature stays.
        let path = dir.path().join(format!("{}.json", rot.id.0));
        let mut raw: Value = serde_json::to_value(&rot).unwrap();
        raw["payload"]["body"]["agent_id"] = json!("tampered-agent");
        std::fs::write(&path, serde_json::to_string_pretty(&raw).unwrap()).unwrap();

        let err = walk_chain(dir.path(), &k0.verifying_key().key_id(), &k1.verifying_key())
            .unwrap_err();
        match err {
            ChainError::RotationSigInvalid { .. } => {}
            other => panic!("expected RotationSigInvalid, got {:?}", other),
        }
    }

    #[test]
    fn forged_new_pub_rejected() {
        // Attacker writes a rotation that claims K2's key_id but
        // actually carries a different pubkey under new_key_pub_b64.
        // The walker must catch the divergence.
        let dir = tempdir().unwrap();
        let k0 = SigningKey::from_seed([50u8; 32]);
        let k1_real = SigningKey::from_seed([51u8; 32]);
        let k1_fake = SigningKey::from_seed([52u8; 32]);
        let mut rot = make_rotation_block(&k0, &k1_real, 1700);
        if let BlockPayload::Sentinel { body, .. } = &mut rot.payload {
            // Keep the key_id from k1_real but swap pubkey bytes for
            // k1_fake — first 8 bytes won't match → mismatch fires.
            body["new_key_pub_b64"] = json!(B64URL.encode(k1_fake.verifying_key().to_bytes()));
        }
        persist_signed(&mut rot, &k0, dir.path());
        // local is k1_real; walker scans and finds row where new_key_id == k1_real.key_id()
        let err =
            walk_chain(dir.path(), &k0.verifying_key().key_id(), &k1_real.verifying_key())
                .unwrap_err();
        match err {
            ChainError::PubKeyIdMismatch { field, .. } => {
                assert_eq!(field, "new_key_pub_b64");
            }
            other => panic!("expected PubKeyIdMismatch, got {:?}", other),
        }
    }

    #[test]
    fn empty_dir_yields_no_rotations() {
        let dir = tempdir().unwrap();
        let local = SigningKey::from_seed([60u8; 32]);
        let target = SigningKey::from_seed([61u8; 32]).verifying_key().key_id();
        let err = walk_chain(dir.path(), &target, &local.verifying_key()).unwrap_err();
        match err {
            ChainError::NoRotationsFound(_) => {}
            other => panic!("expected NoRotationsFound, got {:?}", other),
        }
    }

    #[test]
    fn pre_s1kv_rotation_block_skipped() {
        // A rotation block from before S1-KV won't have the pub_b64
        // fields. Scan must skip it (not abort) so callers with mixed
        // corpora still get useful rows.
        let dir = tempdir().unwrap();
        let stub = json!({
            "id": "deadbeef-old-style",
            "kind": { "kind": "sentinel_event" },
            "payload": {
                "event_type": "key_rotation",
                "body": {
                    "agent_id": "x",
                    "old_key_id": "did:aura:key/old",
                    "new_key_id": "did:aura:key/new",
                    "ts_unix": 1
                }
            }
        });
        std::fs::write(
            dir.path().join("old-style.json"),
            serde_json::to_string_pretty(&stub).unwrap(),
        )
        .unwrap();
        let rows = scan_rotation_blocks(dir.path()).unwrap();
        assert!(rows.is_empty(), "old-style rotation must be skipped");
    }
}
