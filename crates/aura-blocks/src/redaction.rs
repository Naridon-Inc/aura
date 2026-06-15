//! Redaction is a supervisor responsibility — NOT an opt-in afterthought.
//!
//! Every byte that enters a [`BlockOpPayload::AppendOutput`] passes through a
//! [`Redactor`] BEFORE the op is enqueued for sync or durability. Raw bytes
//! are never stored. The audit trail consists of:
//!
//!   - the already-redacted `bytes_b64` that replaces sensitive ranges
//!     with placeholders,
//!   - a list of [`RedactionMark`]s recording *what* was stripped, at which
//!     offset of the pre-redaction stream, and *why*.
//!
//! A secret ref declared in `Block.declared_impacts.mutates_secrets` is
//! automatically added to the block-local redactor's watchlist. That means an
//! agent that echoes an env var inside a bash heredoc will see its output
//! redacted before it leaves the process. This is the "week 3" incident
//! you don't want to debug in production.
//!
//! [`BlockOpPayload::AppendOutput`]: crate::BlockOpPayload::AppendOutput

use serde::{Deserialize, Serialize};

/// Why a range was redacted. Extending this enum is a minor-version bump.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RedactionKind {
    /// Matched a declared secret reference from `mutates_secrets`.
    SecretRef {
        /// The secret ref that matched — never the secret value.
        ref_id: String,
    },
    /// Matched a PII classifier (email, phone, credit-card regex, etc.).
    Pii {
        /// Classifier name, e.g. "email", "e164-phone".
        classifier: String,
    },
    /// Matched a named custom rule loaded from policy.toml.
    CustomRule {
        /// Stable rule identifier.
        rule_id: String,
    },
}

/// A single redacted range in a pre-redaction byte stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedactionMark {
    /// Byte offset in the PRE-redaction stream.
    pub offset: u32,
    /// Byte length of the redacted range in the pre-redaction stream.
    pub length: u32,
    pub kind: RedactionKind,
    /// What appears in the post-redaction bytes in place of the removed
    /// range (e.g. `"[REDACTED:SecretRef]"`). Purely cosmetic; the offsets
    /// above are the source of truth.
    pub placeholder: String,
}

/// A redactor sits in the PTY → BlockOp bridge's hot path. It MUST be pure,
/// deterministic, and allocation-conservative — it runs on every chunk of
/// output from every running block.
pub trait Redactor: Send + Sync {
    /// Return the redacted bytes plus a description of what was stripped.
    ///
    /// Offsets in the returned marks refer to the pre-redaction `input`.
    fn redact(&self, input: &[u8]) -> (Vec<u8>, Vec<RedactionMark>);
}

/// Pass-through redactor. Use only in tests and local dev; never wire this
/// into a production supervisor.
#[allow(dead_code)]
pub struct NullRedactor;

impl Redactor for NullRedactor {
    fn redact(&self, input: &[u8]) -> (Vec<u8>, Vec<RedactionMark>) {
        (input.to_vec(), Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_redactor_is_identity() {
        let (out, marks) = NullRedactor.redact(b"hello");
        assert_eq!(out, b"hello");
        assert!(marks.is_empty());
    }

    #[test]
    fn redaction_mark_roundtrip() {
        let m = RedactionMark {
            offset: 4,
            length: 10,
            kind: RedactionKind::SecretRef {
                ref_id: "OPENAI_API_KEY".into(),
            },
            placeholder: "[REDACTED:SecretRef]".into(),
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: RedactionMark = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }
}
