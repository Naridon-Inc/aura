//! Canonicalization scheme for signed envelopes.
//!
//! Signatures on [`crate::Block`] cover the envelope serialized via this
//! scheme — NOT whatever bytes happen to come out of `serde_json::to_vec`.
//! Without a specified canonicalization, two honest clients can produce
//! different byte sequences for the same logical value and signatures
//! verified on one will fail on the other.
//!
//! Scheme: **JCS (RFC 8785, JSON Canonicalization Scheme).** Deterministic
//! key ordering (UTF-16 code-unit lex), UTF-8 output, no insignificant
//! whitespace, RFC 8259 string escapes, integer numbers only.
//!
//! The [`CANONICALIZATION`] const versions the scheme itself so it can
//! migrate in year 5 without invalidating historical signatures — verifiers
//! pick the canonicalization implementation keyed on this tag.
//!
//! # Integer-only number policy
//!
//! RFC 8785 defers to ECMA-262 `Number.prototype.toString` for number
//! serialization. Implementing that correctly for `f64` is non-trivial
//! (shortest round-trip with ES2019 rounding rules). The [`Block`] schema
//! and all op payloads are integer-only by construction, so we reject
//! non-integer numbers with [`CanonError::FloatNotSupported`] rather than
//! ship a subtly-wrong float encoder. If a float column is ever added,
//! flip this flag deliberately in a migration wave.
//!
//! [`Block`]: crate::Block

use std::collections::BTreeMap;

use serde_json::{Number, Value};
use thiserror::Error;

use crate::block::Block;

/// Versioned canonicalization tag. Store this alongside every signature so
/// verifiers route to the right implementation.
pub const CANONICALIZATION: &str = "jcs-rfc8785-v1";

#[derive(Debug, Error)]
pub enum CanonError {
    #[error("serde_json: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("non-integer numbers are not supported in canonicalized Aura envelopes; got {0}")]
    FloatNotSupported(String),
    #[error("expected JSON object at provenance path, got {0}")]
    ProvenanceShape(&'static str),
}

/// Canonicalize a [`serde_json::Value`] into a deterministic UTF-8 byte
/// sequence per RFC 8785.
///
/// - Object members are emitted in lexicographic order of their keys'
///   UTF-16 code units.
/// - Arrays preserve their source order.
/// - Strings are escaped per RFC 8259 §7 with JCS's specific choice of
///   short escapes.
/// - Numbers must be integers representable as JSON (`i64` or `u64`).
///   Floats are rejected.
/// - No insignificant whitespace.
pub fn canonicalize(value: &Value) -> Result<Vec<u8>, CanonError> {
    let mut out = Vec::with_capacity(64);
    write_value(&mut out, value)?;
    Ok(out)
}

/// Top-level [`Block`] fields maintained by the reducer, not the signer.
/// Stripped from the canonical form before signing so a signature produced
/// at proposal time still verifies after the reducer walks the block
/// through its state FSM.
///
/// If you add a new `BlockOp` variant that writes a new top-level column
/// on the Block envelope, add its key here in the same commit — otherwise
/// signatures break the moment that op fires.
const MUTABLE_TOPLEVEL_KEYS: &[&str] = &[
    "state",
    "updated_at",
    "actual_impacts",
    "policy",
    "attestations",
    "extensions",
];

/// Canonicalize a [`Block`] for signing.
///
/// The canonical form covers only the **immutable envelope** — identity,
/// intent, declared impacts, payload, provenance (minus signature), and
/// `created_at`. Reducer-maintained fields (`state`, `updated_at`,
/// `actual_impacts`, `policy`, `attestations`, `extensions`) are stripped
/// before canonicalization so a signature minted at proposal time keeps
/// verifying after the reducer walks the block through Running →
/// Completed. Those fields have their own integrity story: the `block_ops`
/// log is the source of truth, and future waves will sign ops individually.
///
/// Signature is self-referential: `block.provenance.signature` is the
/// slot the signer fills in, so we zero it before canonicalizing. That
/// zeroing is idempotent — passing an already-signed block produces the
/// same bytes as passing the unsigned version.
pub fn canonicalize_for_signing(block: &Block) -> Result<Vec<u8>, CanonError> {
    let mut value = serde_json::to_value(block)?;
    zero_provenance_signature(&mut value)?;
    strip_mutable_toplevel_fields(&mut value)?;
    canonicalize(&value)
}

fn zero_provenance_signature(value: &mut Value) -> Result<(), CanonError> {
    let obj = value
        .as_object_mut()
        .ok_or(CanonError::ProvenanceShape("block is not an object"))?;
    let prov = obj
        .get_mut("provenance")
        .ok_or(CanonError::ProvenanceShape("missing provenance"))?
        .as_object_mut()
        .ok_or(CanonError::ProvenanceShape("provenance is not an object"))?;
    prov.insert("signature".to_string(), Value::Null);
    Ok(())
}

fn strip_mutable_toplevel_fields(value: &mut Value) -> Result<(), CanonError> {
    let obj = value
        .as_object_mut()
        .ok_or(CanonError::ProvenanceShape("block is not an object"))?;
    for k in MUTABLE_TOPLEVEL_KEYS {
        obj.remove(*k);
    }
    Ok(())
}

fn write_value(out: &mut Vec<u8>, v: &Value) -> Result<(), CanonError> {
    match v {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Number(n) => write_number(out, n)?,
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_value(out, item)?;
            }
            out.push(b']');
        }
        Value::Object(map) => {
            // JCS mandates lexicographic ordering by the UTF-16 encoding of
            // the key. BTreeMap keyed on `Vec<u16>` gives exactly that.
            let mut sorted: BTreeMap<Vec<u16>, (&str, &Value)> = BTreeMap::new();
            for (k, val) in map {
                sorted.insert(k.encode_utf16().collect(), (k.as_str(), val));
            }
            out.push(b'{');
            for (i, (_, (k, val))) in sorted.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_string(out, k);
                out.push(b':');
                write_value(out, val)?;
            }
            out.push(b'}');
        }
    }
    Ok(())
}

fn write_number(out: &mut Vec<u8>, n: &Number) -> Result<(), CanonError> {
    if let Some(u) = n.as_u64() {
        out.extend_from_slice(u.to_string().as_bytes());
        return Ok(());
    }
    if let Some(i) = n.as_i64() {
        out.extend_from_slice(i.to_string().as_bytes());
        return Ok(());
    }
    Err(CanonError::FloatNotSupported(n.to_string()))
}

fn write_string(out: &mut Vec<u8>, s: &str) {
    out.push(b'"');
    for ch in s.chars() {
        match ch {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\x08' => out.extend_from_slice(b"\\b"),
            '\x09' => out.extend_from_slice(b"\\t"),
            '\x0a' => out.extend_from_slice(b"\\n"),
            '\x0c' => out.extend_from_slice(b"\\f"),
            '\x0d' => out.extend_from_slice(b"\\r"),
            c if (c as u32) < 0x20 => {
                // Other C0 controls: \u00XX, lowercase hex per JCS.
                let code = c as u32;
                out.extend_from_slice(
                    format!("\\u{:04x}", code).as_bytes(),
                );
            }
            c => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    out.push(b'"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn primitives() {
        assert_eq!(canonicalize(&Value::Null).unwrap(), b"null");
        assert_eq!(canonicalize(&Value::Bool(true)).unwrap(), b"true");
        assert_eq!(canonicalize(&Value::Bool(false)).unwrap(), b"false");
        assert_eq!(canonicalize(&json!(0)).unwrap(), b"0");
        assert_eq!(canonicalize(&json!(-1)).unwrap(), b"-1");
        assert_eq!(canonicalize(&json!(u64::MAX)).unwrap(), u64::MAX.to_string().as_bytes());
    }

    #[test]
    fn floats_rejected() {
        let v = json!(1.5);
        let err = canonicalize(&v).unwrap_err();
        assert!(matches!(err, CanonError::FloatNotSupported(_)));
    }

    #[test]
    fn object_key_ordering_is_stable() {
        // Two identical objects with different insertion order canonicalize
        // byte-equal. This is the whole point.
        let a: Value = serde_json::from_str(r#"{"b":1,"a":2}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"a":2,"b":1}"#).unwrap();
        assert_eq!(canonicalize(&a).unwrap(), canonicalize(&b).unwrap());
        assert_eq!(canonicalize(&a).unwrap(), br#"{"a":2,"b":1}"# as &[u8]);
    }

    #[test]
    fn utf16_ordering_differs_from_byte_ordering_for_supplementary_plane() {
        // U+1F600 😀 encodes as surrogate pair (😀) in UTF-16.
        // U+FF01 ！ encodes as single unit ！. In UTF-16 lex order:
        // \uD83D < ！, so "😀" sorts before "！". In UTF-8 bytes,
        // 😀 = F0 9F 98 80 and ！ = EF BC 81, so raw-byte order is the
        // opposite. JCS mandates UTF-16 order.
        let v: Value = serde_json::from_str("{\"\u{FF01}\":1,\"\u{1F600}\":2}").unwrap();
        let out = canonicalize(&v).unwrap();
        let text = std::str::from_utf8(&out).unwrap();
        let pos_emoji = text.find('\u{1F600}').unwrap();
        let pos_bang = text.find('\u{FF01}').unwrap();
        assert!(
            pos_emoji < pos_bang,
            "expected UTF-16 order (emoji before ！), got: {text}"
        );
    }

    #[test]
    fn strings_escape_required_chars() {
        let v = json!("a\"b\\c\nd\te\x01f");
        let expected: &[u8] = b"\"a\\\"b\\\\c\\nd\\te\\u0001f\"";
        assert_eq!(canonicalize(&v).unwrap(), expected);
    }

    #[test]
    fn strings_emit_bmp_and_supplementary_as_utf8() {
        // Non-ASCII BMP and supplementary plane chars pass through as raw
        // UTF-8 bytes (they are not escape-required per RFC 8259).
        let v = json!("ünicode 🎯 ok");
        let out = canonicalize(&v).unwrap();
        assert_eq!(out, b"\"\xc3\xbcnicode \xf0\x9f\x8e\xaf ok\"");
    }

    #[test]
    fn nested_structure_round_trips() {
        let v = json!({
            "z": [1, 2, {"y": "inner", "x": null}],
            "a": {"deep": {"deeper": true}}
        });
        let out = canonicalize(&v).unwrap();
        // Re-parsing + re-canonicalizing is a fixpoint.
        let reparsed: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(canonicalize(&reparsed).unwrap(), out);
    }

    #[test]
    fn canonicalize_for_signing_zeros_existing_signature() {
        use crate::block::{
            AgentRef, AnchorRef, Attestations, Block, BlockPayload, BlockState,
            DeclaredImpacts, Intent, Provenance, Signature, SCHEMA_VERSION,
        };
        use crate::BlockKind;
        use std::collections::BTreeMap;
        use time::OffsetDateTime;

        fn sample(sig: Option<Signature>) -> Block {
            Block {
                id: crate::BlockId::new(),
                schema_version: SCHEMA_VERSION,
                kind: BlockKind::Command,
                parent_id: None,
                prior_sibling_id: None,
                supersedes_id: None,
                anchor: AnchorRef::None,
                intent: Intent {
                    summary: "test".into(),
                    detail: None,
                    parent_intent: None,
                },
                declared_impacts: DeclaredImpacts::default(),
                actual_impacts: None,
                payload: BlockPayload::Command {
                    command: "ls".into(),
                    shell: Some("bash".into()),
                    cwd: "/".into(),
                },
                state: BlockState::Proposed,
                policy: None,
                provenance: Provenance {
                    actor: AgentRef("did:aura:user/x".into()),
                    on_behalf_of: None,
                    origin_host: "host".into(),
                    signature: sig,
                },
                attestations: Attestations::default(),
                extensions: BTreeMap::new(),
                created_at: OffsetDateTime::UNIX_EPOCH,
                updated_at: OffsetDateTime::UNIX_EPOCH,
            }
        }

        // Same block, two different signature values — bytes must match.
        let mut b_unsigned = sample(None);
        let mut b_fake_sig = sample(Some(Signature {
            algo: "ed25519".into(),
            key_id: "did:aura:key/zzzz".into(),
            sig_b64: "AAAA".into(),
        }));
        // Freeze id so the two blocks are byte-equivalent.
        let fixed_id = b_unsigned.id;
        b_unsigned.id = fixed_id;
        b_fake_sig.id = fixed_id;

        let a = canonicalize_for_signing(&b_unsigned).unwrap();
        let b = canonicalize_for_signing(&b_fake_sig).unwrap();
        assert_eq!(a, b, "signature slot must be zeroed for signing");

        // And the zeroed slot is literally null in the canonicalized bytes.
        let text = std::str::from_utf8(&a).unwrap();
        assert!(text.contains("\"signature\":null"), "canonical form: {text}");
    }

    #[test]
    fn canonicalize_for_signing_strips_reducer_fields() {
        // Blocks differing ONLY in reducer-maintained fields (state,
        // updated_at, actual_impacts, policy, attestations, extensions)
        // must canonicalize to the same bytes. Without this, every
        // Transition op would invalidate the proposal's signature.
        use crate::block::{
            ActualImpacts, AgentRef, AnchorRef, Attestations, Block, BlockPayload,
            BlockState, CapabilityGrade, DeclaredImpacts, Intent, PolicyDecision,
            Provenance, SCHEMA_VERSION,
        };
        use crate::BlockKind;
        use std::collections::BTreeMap;
        use time::OffsetDateTime;

        let id = crate::BlockId::new();
        let created_at = OffsetDateTime::UNIX_EPOCH;

        let base = Block {
            id,
            schema_version: SCHEMA_VERSION,
            kind: BlockKind::Command,
            parent_id: None,
            prior_sibling_id: None,
            supersedes_id: None,
            anchor: AnchorRef::None,
            intent: Intent {
                summary: "run tests".into(),
                detail: None,
                parent_intent: None,
            },
            declared_impacts: DeclaredImpacts::default(),
            actual_impacts: None,
            payload: BlockPayload::Command {
                command: "cargo test".into(),
                shell: Some("bash".into()),
                cwd: "/repo".into(),
            },
            state: BlockState::Proposed,
            policy: None,
            provenance: Provenance {
                actor: AgentRef("did:aura:user/x".into()),
                on_behalf_of: None,
                origin_host: "host".into(),
                signature: None,
            },
            attestations: Attestations::default(),
            extensions: BTreeMap::new(),
            created_at,
            updated_at: created_at,
        };

        // Mutate every reducer-maintained field. Immutable envelope
        // stays identical.
        let mut reduced = base.clone();
        reduced.state = BlockState::Completed;
        reduced.updated_at = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();
        reduced.actual_impacts = Some(ActualImpacts::default());
        reduced.policy = Some(PolicyDecision {
            verdict: CapabilityGrade::Auto,
            rules_fired: vec!["policy.auto".into()],
            reason: "allowed by default".into(),
            decided_by: AgentRef("did:aura:policy-engine".into()),
            decided_at: created_at,
            gate_reviewer: None,
        });
        reduced.attestations.items.push(serde_json::json!({
            "kind": "test-evidence",
            "ref": "sha256:abc",
        }));
        reduced
            .extensions
            .insert("gate.excluded_children".into(), serde_json::json!([]));

        let a = canonicalize_for_signing(&base).unwrap();
        let b = canonicalize_for_signing(&reduced).unwrap();
        assert_eq!(
            a, b,
            "reducer-maintained fields must not contribute to the signing canonical form"
        );

        // Spot-check: the stripped keys literally don't appear in the
        // canonical bytes.
        let text = std::str::from_utf8(&a).unwrap();
        for k in ["\"state\":", "\"updated_at\":", "\"actual_impacts\":", "\"policy\":", "\"attestations\":", "\"extensions\":"] {
            assert!(!text.contains(k), "leaked reducer key {k}: {text}");
        }

        // Sanity: immutable envelope keys ARE present.
        for k in ["\"id\":", "\"intent\":", "\"payload\":", "\"provenance\":", "\"created_at\":"] {
            assert!(text.contains(k), "missing envelope key {k}: {text}");
        }
    }
}
