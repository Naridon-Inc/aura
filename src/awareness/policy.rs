//! Per-repo privacy policy for broadcasting un-pushed work (AURA-15 / M3b).
//!
//! The awareness plane shares *meaning* about in-flight work — never code
//! bytes — but even metadata has gradations: a symbol name can reveal an
//! unannounced feature, a file path can reveal a security fix in progress.
//! This module owns the dial:
//!
//! - `off`          — fully dark. Nothing leaves the machine (no push, no pull).
//! - `intent-only`  — share only the *why* (kind + intent prose). File paths,
//!                    symbols, and impact summaries are stripped.
//! - `symbols`      — **default.** Share intent + impacted files/symbols.
//!                    Pure metadata; still never code bytes.
//! - `diffs`        — additionally allow Live function-body sync to push
//!                    un-pushed code to the team relay.
//!
//! The policy lives at `.aura/privacy.json` (repo-local, like the rest of the
//! awareness state) so every agent and surface in the repo obeys the same
//! dial. It is enforced at the *broadcast boundary*: the local capture in
//! `.aura/awareness/events.jsonl` keeps full (already-redacted) fidelity so
//! throttling and your own radar stay precise, and [`outbound_view`] derives
//! the filtered copy that actually leaves the box — re-signed, because the
//! original signature covers the unfiltered fields.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::identity;
use super::model::AwarenessEvent;

/// How much of the in-flight work this repo broadcasts to the team.
/// Ordering matters: each level is a superset of the one before it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum SharePolicy {
    /// Nothing leaves the machine; the repo doesn't pull peers' events either.
    Off,
    /// Kind + intent prose only — paths, symbols, and impact are stripped.
    IntentOnly,
    /// Intent + impacted files/symbols (metadata, never code). The default.
    Symbols,
    /// Everything `Symbols` shares, plus Live function-body (code) sync.
    Diffs,
}

impl SharePolicy {
    /// Parse a human/CLI token. Accepts a few spellings per level.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.trim().to_ascii_lowercase().as_str() {
            "off" | "none" | "dark" => Self::Off,
            "intent-only" | "intent_only" | "intentonly" | "intent" => Self::IntentOnly,
            "symbols" | "symbol" | "default" => Self::Symbols,
            "diffs" | "diff" | "code" | "all" => Self::Diffs,
            _ => return None,
        })
    }

    /// Canonical token (also what is serialized into `.aura/privacy.json`).
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::IntentOnly => "intent-only",
            Self::Symbols => "symbols",
            Self::Diffs => "diffs",
        }
    }

    /// One-line human description for `aura radar privacy` / `status`.
    pub fn describe(&self) -> &'static str {
        match self {
            Self::Off => "fully dark — nothing is broadcast and peers' events are not pulled",
            Self::IntentOnly => "shares only the why (kind + intent); paths, symbols, impact stripped",
            Self::Symbols => "shares intent + impacted files/symbols — metadata, never code bytes",
            Self::Diffs => "shares metadata AND allows Live function-body (code) sync",
        }
    }

    /// May awareness events leave the machine at all?
    pub fn allows_broadcast(&self) -> bool {
        *self != Self::Off
    }

    /// May Live sync push un-pushed *code* (function bodies) off the box?
    pub fn allows_code_sync(&self) -> bool {
        *self == Self::Diffs
    }
}

impl Default for SharePolicy {
    fn default() -> Self {
        Self::Symbols
    }
}

/// On-disk shape of `.aura/privacy.json`. A struct (not a bare string) so
/// future per-channel dials (e.g. zones, sessions) land additively.
#[derive(Serialize, Deserialize, Default)]
struct PrivacyFile {
    #[serde(default)]
    share: Option<String>,
}

fn policy_path() -> PathBuf {
    PathBuf::from(".aura").join("privacy.json")
}

/// Load the repo's policy; missing/unparseable file → the `Symbols` default.
/// cwd-relative like the rest of the awareness store.
pub fn load() -> SharePolicy {
    let Ok(body) = fs::read_to_string(policy_path()) else {
        return SharePolicy::default();
    };
    serde_json::from_str::<PrivacyFile>(&body)
        .ok()
        .and_then(|f| f.share.as_deref().and_then(SharePolicy::parse))
        .unwrap_or_default()
}

/// Persist the policy (atomic tmp + rename, like the event store).
pub fn save(policy: SharePolicy) -> Result<(), String> {
    let path = policy_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&PrivacyFile {
        share: Some(policy.as_str().to_string()),
    })
    .map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Derive the copy of `ev` that may leave the machine under `policy`.
///
/// `None` means "don't broadcast this event at all". When fields are stripped
/// the event is RE-SIGNED with the repo identity — the original signature
/// covers the unfiltered fields, so it would (correctly) fail verification on
/// the filtered shape. Unchanged events keep their original signature.
pub fn outbound_view(ev: &AwarenessEvent, policy: SharePolicy) -> Option<AwarenessEvent> {
    match policy {
        SharePolicy::Off => None,
        SharePolicy::Symbols | SharePolicy::Diffs => Some(ev.clone()),
        SharePolicy::IntentOnly => {
            let mut out = ev.clone();
            out.file = None;
            out.symbol = None;
            out.impact = None;
            out.key_id = None;
            out.sig = None;
            if let Some(key) = identity::load() {
                let sig = key.sign(&out.signing_bytes());
                out.key_id = Some(key.key_id());
                out.sig = Some(sig.to_b64());
            }
            Some(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::awareness::model::AwarenessKind;
    use crate::TEST_CWD_LOCK as SERIAL;

    struct CwdGuard(std::path::PathBuf);
    impl Drop for CwdGuard {
        fn drop(&mut self) {
            let _ = std::env::set_current_dir(&self.0);
        }
    }

    fn enter_tmp() -> (CwdGuard, tempfile::TempDir) {
        let g = CwdGuard(std::env::current_dir().expect("cwd"));
        let d = tempfile::tempdir().expect("tmp");
        std::env::set_current_dir(d.path()).expect("cd");
        (g, d)
    }

    fn ev() -> AwarenessEvent {
        AwarenessEvent {
            id: "e1".into(),
            actor: "claude@test".into(),
            is_agent: true,
            kind: AwarenessKind::Editing,
            repo: "demo/repo".into(),
            branch: "main".into(),
            file: Some("src/auth.rs".into()),
            symbol: Some("login".into()),
            intent: Some("harden token check".into()),
            impact: Some("touches session refresh".into()),
            ts: 42,
            key_id: Some("did:aura:key/zz".into()),
            sig: Some("deadbeef".into()),
            pubkey: None,
            worktree: None,
        }
    }

    #[test]
    fn parse_roundtrips_and_accepts_aliases() {
        for p in [
            SharePolicy::Off,
            SharePolicy::IntentOnly,
            SharePolicy::Symbols,
            SharePolicy::Diffs,
        ] {
            assert_eq!(SharePolicy::parse(p.as_str()), Some(p));
        }
        assert_eq!(SharePolicy::parse("intent_only"), Some(SharePolicy::IntentOnly));
        assert_eq!(SharePolicy::parse("CODE"), Some(SharePolicy::Diffs));
        assert_eq!(SharePolicy::parse("nonsense"), None);
    }

    #[test]
    fn missing_file_defaults_to_symbols() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();
        assert_eq!(load(), SharePolicy::Symbols);
    }

    #[test]
    fn save_load_roundtrips() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();
        for p in [
            SharePolicy::Off,
            SharePolicy::IntentOnly,
            SharePolicy::Symbols,
            SharePolicy::Diffs,
        ] {
            save(p).expect("save");
            assert_eq!(load(), p);
        }
    }

    #[test]
    fn levels_are_ordered_supersets() {
        assert!(SharePolicy::Off < SharePolicy::IntentOnly);
        assert!(SharePolicy::IntentOnly < SharePolicy::Symbols);
        assert!(SharePolicy::Symbols < SharePolicy::Diffs);
        assert!(!SharePolicy::Off.allows_broadcast());
        assert!(SharePolicy::IntentOnly.allows_broadcast());
        assert!(!SharePolicy::Symbols.allows_code_sync());
        assert!(SharePolicy::Diffs.allows_code_sync());
    }

    #[test]
    fn outbound_view_enforces_each_level() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp(); // identity::load() finds no key here

        let e = ev();

        // off → nothing leaves.
        assert!(outbound_view(&e, SharePolicy::Off).is_none());

        // symbols/diffs → byte-identical copy, original signature intact.
        let s = outbound_view(&e, SharePolicy::Symbols).expect("symbols");
        assert_eq!(s.file.as_deref(), Some("src/auth.rs"));
        assert_eq!(s.sig.as_deref(), Some("deadbeef"));

        // intent-only → paths/symbols/impact stripped, intent kept. The stale
        // signature is replaced: identity::load() mints a repo-local key on
        // first use (even here), so the filtered shape gets a FRESH signature.
        let i = outbound_view(&e, SharePolicy::IntentOnly).expect("intent-only");
        assert_eq!(i.intent.as_deref(), Some("harden token check"));
        assert!(i.file.is_none() && i.symbol.is_none() && i.impact.is_none());
        assert_ne!(i.sig.as_deref(), Some("deadbeef"), "stale sig must not survive");
        assert_ne!(i.key_id.as_deref(), Some("did:aura:key/zz"));
        assert!(i.sig.is_some() && i.key_id.is_some(), "stripped event is re-signed");
    }
}
