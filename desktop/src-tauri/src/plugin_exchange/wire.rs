//! Wire format for the Plugin Exchange.
//!
//! Envelopes ride the existing team chat rail as JSON bodies on a
//! hidden system channel. The rail caps a message body at 64 KB
//! (aura-cloud rooms.rs), so an archive is split into base64 chunks
//! that each stay comfortably under the cap.

use serde::{Deserialize, Serialize};

/// Hidden system channel the exchange publishes on. Never rendered in
/// the chat UI (leading `__` marks system channels).
pub const EXCHANGE_CHANNEL: &str = "__aura_plugin_exchange";

/// Max base64 chars per chunk. 40,000 chars + envelope metadata stays
/// well under the rail's 64 KB body cap.
pub const CHUNK_B64_CHARS: usize = 40_000;

/// Who published a bundle. Carried on every chunk so a partial
/// publish can still be attributed and de-duplicated.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ExchangePublisher {
    /// aura-plugin-sign key id (short hash of the verifying key).
    pub key_id: String,
    /// Full ed25519 verifying key, base64. Lets a receiver trust the
    /// publisher with one explicit action — never automatically.
    pub public_key_b64: String,
    /// Publisher label as embedded in the bundle signature.
    pub label: String,
    /// Origin device — used to skip our own echoes when polling.
    pub device_id: String,
    /// Human display name for the UI.
    pub display: String,
}

/// One chunk of a publish (or a whole remove). `manifest_json` rides
/// only on chunk 0 to keep later chunks lean.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExchangeEnvelope {
    pub v: u32,
    /// "publish" | "remove"
    pub op: String,
    /// uuid v4 minted once per publish; all chunks share it.
    pub publish_id: String,
    pub bundle_id: String,
    pub version: String,
    /// Bundle manifest (aura.plugin.json) as a JSON string — chunk 0 only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_json: Option<String>,
    pub publisher: ExchangePublisher,
    pub chunk_index: usize,
    pub chunk_count: usize,
    /// Base64 slice of the gzipped archive. Empty for "remove".
    #[serde(default)]
    pub chunk_b64: String,
    /// sha256 (hex) of the complete gzipped archive — verified before
    /// any byte of the archive is parsed.
    pub archive_sha256: String,
    /// Publisher's wall-clock millis.
    pub ts: i64,
    /// Origin device id (same as publisher.device_id; top-level copy
    /// mirrors the tasks/pages sync envelopes for uniform skip logic).
    pub origin: String,
}

impl ExchangeEnvelope {
    pub fn to_body(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| e.to_string())
    }

    pub fn from_body(body: &str) -> Option<Self> {
        let env: Self = serde_json::from_str(body).ok()?;
        if env.v != 1 {
            return None;
        }
        if env.op != "publish" && env.op != "remove" {
            return None;
        }
        if env.op == "publish" {
            if env.chunk_count == 0 || env.chunk_index >= env.chunk_count {
                return None;
            }
            if env.chunk_index == 0 && env.manifest_json.is_none() {
                return None;
            }
        }
        Some(env)
    }
}

/// Split a base64 archive into chunk-sized slices. Always returns at
/// least one chunk (an empty archive is the caller's bug, but a
/// zero-chunk publish would be unparseable).
pub fn split_b64(b64: &str) -> Vec<String> {
    if b64.is_empty() {
        return vec![String::new()];
    }
    // base64 is pure ASCII, so byte slicing never splits a char.
    b64.as_bytes()
        .chunks(CHUNK_B64_CHARS)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect()
}

/// Re-join chunks collected from the rail. Caller passes them indexed;
/// any gap means the publish is still pending.
pub fn join_b64(parts: &[(usize, String)], chunk_count: usize) -> Option<String> {
    if parts.len() < chunk_count {
        return None;
    }
    let mut ordered: Vec<Option<&str>> = vec![None; chunk_count];
    for (idx, b64) in parts {
        if *idx >= chunk_count {
            return None; // malformed — index out of range
        }
        ordered[*idx] = Some(b64.as_str());
    }
    let mut joined = String::new();
    for slot in ordered {
        joined.push_str(slot?);
    }
    Some(joined)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_publisher() -> ExchangePublisher {
        ExchangePublisher {
            key_id: "abcd1234".into(),
            public_key_b64: "cHVibGljLWtleQ==".into(),
            label: "Acme Tools".into(),
            device_id: "dev-1".into(),
            display: "Ada".into(),
        }
    }

    #[test]
    fn envelope_roundtrips_through_body() {
        let env = ExchangeEnvelope {
            v: 1,
            op: "publish".into(),
            publish_id: "pub-1".into(),
            bundle_id: "@acme/tools".into(),
            version: "1.0.0".into(),
            manifest_json: Some("{\"id\":\"@acme/tools\"}".into()),
            publisher: demo_publisher(),
            chunk_index: 0,
            chunk_count: 2,
            chunk_b64: "QUJD".into(),
            archive_sha256: "deadbeef".into(),
            ts: 1_700_000_000_000,
            origin: "dev-1".into(),
        };
        let body = env.to_body().unwrap();
        let back = ExchangeEnvelope::from_body(&body).unwrap();
        assert_eq!(back.publish_id, "pub-1");
        assert_eq!(back.chunk_count, 2);
        assert_eq!(back.manifest_json.as_deref(), Some("{\"id\":\"@acme/tools\"}"));
    }

    #[test]
    fn from_body_rejects_garbage_and_bad_shapes() {
        assert!(ExchangeEnvelope::from_body("not json").is_none());
        assert!(ExchangeEnvelope::from_body("{\"v\":1}").is_none());
        // Wrong version
        let mut env = ExchangeEnvelope {
            v: 2,
            op: "publish".into(),
            publish_id: "p".into(),
            bundle_id: "b".into(),
            version: "1".into(),
            manifest_json: Some("{}".into()),
            publisher: demo_publisher(),
            chunk_index: 0,
            chunk_count: 1,
            chunk_b64: String::new(),
            archive_sha256: "x".into(),
            ts: 0,
            origin: "dev-1".into(),
        };
        assert!(ExchangeEnvelope::from_body(&env.to_body().unwrap()).is_none());
        // Unknown op
        env.v = 1;
        env.op = "explode".into();
        assert!(ExchangeEnvelope::from_body(&env.to_body().unwrap()).is_none());
        // chunk 0 of a publish must carry the manifest
        env.op = "publish".into();
        env.manifest_json = None;
        assert!(ExchangeEnvelope::from_body(&env.to_body().unwrap()).is_none());
        // index out of range
        env.manifest_json = Some("{}".into());
        env.chunk_index = 1;
        env.chunk_count = 1;
        assert!(ExchangeEnvelope::from_body(&env.to_body().unwrap()).is_none());
    }

    #[test]
    fn split_join_roundtrip() {
        let b64 = "A".repeat(CHUNK_B64_CHARS * 2 + 17);
        let chunks = split_b64(&b64);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].len(), CHUNK_B64_CHARS);
        assert_eq!(chunks[2].len(), 17);
        let parts: Vec<(usize, String)> =
            chunks.into_iter().enumerate().collect();
        assert_eq!(join_b64(&parts, 3).unwrap(), b64);
    }

    #[test]
    fn join_reports_pending_on_gaps_and_rejects_bad_index() {
        let parts = vec![(0usize, "AA".to_string()), (2usize, "CC".to_string())];
        assert!(join_b64(&parts, 3).is_none()); // missing chunk 1
        let bad = vec![(5usize, "XX".to_string())];
        assert!(join_b64(&bad, 1).is_none()); // out of range
    }

    #[test]
    fn split_handles_small_and_empty() {
        assert_eq!(split_b64(""), vec![String::new()]);
        let chunks = split_b64("QUJD");
        assert_eq!(chunks, vec!["QUJD".to_string()]);
        assert_eq!(join_b64(&[(0, "QUJD".into())], 1).unwrap(), "QUJD");
    }
}
