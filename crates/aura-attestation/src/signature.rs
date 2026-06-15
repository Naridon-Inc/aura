use base64::{engine::general_purpose::STANDARD_NO_PAD as B64, Engine};
use serde::{Deserialize, Serialize};

use crate::error::AttestationError;

/// Detached ed25519 signature. 64 bytes, fixed-size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignatureBytes(#[serde(with = "serde_bytes_array")] pub [u8; 64]);

impl SignatureBytes {
    pub fn as_bytes(&self) -> &[u8; 64] {
        &self.0
    }

    pub fn to_b64(&self) -> String {
        B64.encode(self.0)
    }

    pub fn from_b64(s: &str) -> Result<Self, AttestationError> {
        let raw = B64
            .decode(s.as_bytes())
            .map_err(|e| AttestationError::Base64(e.to_string()))?;
        if raw.len() != 64 {
            return Err(AttestationError::Base64(format!(
                "signature b64 decoded to {} bytes (expected 64)",
                raw.len()
            )));
        }
        let mut out = [0u8; 64];
        out.copy_from_slice(&raw);
        Ok(Self(out))
    }
}

/// Serde helper: serialize `[u8; 64]` as a CBOR/JSON byte blob rather
/// than as an array of 64 integers. Keeps the wire form compact.
mod serde_bytes_array {
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8; 64], s: S) -> Result<S::Ok, S::Error> {
        serde_bytes::serialize(bytes.as_slice(), s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 64], D::Error> {
        let v: Vec<u8> = serde_bytes::deserialize(d)?;
        if v.len() != 64 {
            return Err(serde::de::Error::custom(format!(
                "expected 64 bytes, got {}",
                v.len()
            )));
        }
        let mut out = [0u8; 64];
        out.copy_from_slice(&v);
        Ok(out)
    }
}
