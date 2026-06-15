//! Awareness-plane event model — the small, signed, semantic records of in-flight
//! work. Append-only; the durable log is `.aura/awareness/events.jsonl`.

use serde::{Deserialize, Serialize};

/// What kind of in-flight activity an event reports.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AwarenessKind {
    /// Began working on a target.
    Started,
    /// Actively editing a target.
    Editing,
    /// Declared an intent (the *why*).
    Intent,
    /// Reported a projected blast-radius.
    Impact,
    /// Claimed/released a zone (a region of code).
    Zone,
    /// Paused work on a target.
    Paused,
    /// Abandoned in-flight work (others can stop waiting on it).
    Abandoned,
    /// Landed the work as a commit.
    Committed,
}

impl AwarenessKind {
    /// Parse a human/CLI string into a kind. Accepts a couple of short aliases.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.trim().to_ascii_lowercase().as_str() {
            "started" | "start" => Self::Started,
            "editing" | "edit" => Self::Editing,
            "intent" => Self::Intent,
            "impact" => Self::Impact,
            "zone" | "claim" => Self::Zone,
            "paused" | "pause" => Self::Paused,
            "abandoned" | "abandon" => Self::Abandoned,
            "committed" | "commit" => Self::Committed,
            _ => return None,
        })
    }

    /// The canonical lowercase token (also what is serialized).
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Editing => "editing",
            Self::Intent => "intent",
            Self::Impact => "impact",
            Self::Zone => "zone",
            Self::Paused => "paused",
            Self::Abandoned => "abandoned",
            Self::Committed => "committed",
        }
    }

    /// A glyph for the radar feed.
    pub fn glyph(&self) -> &'static str {
        match self {
            Self::Started => "▶",
            Self::Editing => "✎",
            Self::Intent => "✦",
            Self::Impact => "⚡",
            Self::Zone => "▣",
            Self::Paused => "⏸",
            Self::Abandoned => "✕",
            Self::Committed => "✔",
        }
    }
}

/// A single awareness event.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AwarenessEvent {
    pub id: String,
    /// Display identity of the actor: an agent label like `claude@cursor`, or
    /// the human's git user name.
    pub actor: String,
    /// True when an AI agent authored this; false for a human.
    #[serde(default)]
    pub is_agent: bool,
    pub kind: AwarenessKind,
    pub repo: String,
    pub branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// The AST node (function/class) being touched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    /// The *why*.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    /// Projected blast-radius summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub impact: Option<String>,
    /// Emit time, unix milliseconds.
    pub ts: u64,
    /// Signer key id (`did:aura:key/...`) when the event is signed (M3a).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    /// Base64 Ed25519 signature over [`AwarenessEvent::signing_bytes`] (M3a).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
}

impl AwarenessEvent {
    /// Canonical bytes that are signed and verified — every meaningful field in
    /// a fixed order, EXCLUDING `key_id`/`sig` themselves. `serde_json` orders
    /// object keys deterministically, so sign and verify agree.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let canon = serde_json::json!({
            "id": self.id,
            "actor": self.actor,
            "is_agent": self.is_agent,
            "kind": self.kind.as_str(),
            "repo": self.repo,
            "branch": self.branch,
            "file": self.file,
            "symbol": self.symbol,
            "intent": self.intent,
            "impact": self.impact,
            "ts": self.ts,
        });
        serde_json::to_vec(&canon).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_parse_roundtrips() {
        for k in [
            AwarenessKind::Started,
            AwarenessKind::Editing,
            AwarenessKind::Intent,
            AwarenessKind::Impact,
            AwarenessKind::Zone,
            AwarenessKind::Paused,
            AwarenessKind::Abandoned,
            AwarenessKind::Committed,
        ] {
            assert_eq!(AwarenessKind::parse(k.as_str()), Some(k));
        }
        assert_eq!(AwarenessKind::parse("nonsense"), None);
    }

    #[test]
    fn signing_bytes_exclude_signature_fields() {
        let mut e = AwarenessEvent {
            id: "x".into(),
            actor: "a".into(),
            is_agent: false,
            kind: AwarenessKind::Editing,
            repo: "r".into(),
            branch: "b".into(),
            file: None,
            symbol: None,
            intent: None,
            impact: None,
            ts: 7,
            key_id: None,
            sig: None,
        };
        let before = e.signing_bytes();
        // Attaching a signature/key id must NOT change what gets signed.
        e.sig = Some("deadbeef".into());
        e.key_id = Some("did:aura:key/zz".into());
        assert_eq!(before, e.signing_bytes());
    }
}
