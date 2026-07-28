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
    /// Self-certifying public key (b64url of the 32-byte Ed25519 key) that
    /// signed this event. It travels WITH the event so any teammate can verify
    /// it without a key registry — the pubkey must re-derive the claimed
    /// `key_id` (an 8-byte fingerprint) or the binding is rejected. Excluded
    /// from [`AwarenessEvent::signing_bytes`], exactly like `key_id`/`sig`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pubkey: Option<String>,
    /// Checkout the actor was standing in. `None` = the main checkout, which is
    /// also what events written before worktrees were tracked deserialize to.
    /// Branch alone can't answer "where" — several checkouts can sit on
    /// detached HEADs, and the name is what a human actually says out loud.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
}

impl AwarenessEvent {
    /// Canonical bytes that are signed and verified — every meaningful field in
    /// a fixed order, EXCLUDING `key_id`/`sig` themselves. `serde_json` orders
    /// object keys deterministically, so sign and verify agree.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut canon = serde_json::json!({
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
        // `worktree` joins the canon only when it is actually set. Adding the
        // key unconditionally (even as `null`) would change the bytes for every
        // event signed before worktrees were tracked, and each one already on
        // disk would start failing verification.
        if let Some(wt) = &self.worktree {
            if let Some(obj) = canon.as_object_mut() {
                obj.insert("worktree".into(), serde_json::Value::String(wt.clone()));
            }
        }
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
            pubkey: None,
            worktree: None,
        };
        let before = e.signing_bytes();
        // Attaching a signature/key id/pubkey must NOT change what gets signed.
        e.sig = Some("deadbeef".into());
        e.key_id = Some("did:aura:key/zz".into());
        e.pubkey = Some("Zm9vYmFy".into());
        assert_eq!(before, e.signing_bytes());
    }

    /// Every event already on disk was signed without a `worktree` key. If
    /// adding the field changed the canon for those events, each one would
    /// start failing verification the moment this ships.
    #[test]
    fn an_unstamped_event_signs_exactly_as_it_did_before_worktrees() {
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
            pubkey: None,
            worktree: None,
        };
        let legacy = serde_json::to_vec(&serde_json::json!({
            "id": "x",
            "actor": "a",
            "is_agent": false,
            "kind": "editing",
            "repo": "r",
            "branch": "b",
            "file": serde_json::Value::Null,
            "symbol": serde_json::Value::Null,
            "intent": serde_json::Value::Null,
            "impact": serde_json::Value::Null,
            "ts": 7,
        }))
        .expect("canon");
        assert_eq!(e.signing_bytes(), legacy);

        // Stamped events sign over the checkout too, so it can't be forged.
        e.worktree = Some("barcelona".into());
        assert_ne!(e.signing_bytes(), legacy);
    }
}
