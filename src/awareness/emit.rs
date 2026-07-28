//! Build, sign, and persist an awareness event. Identity (repo + branch +
//! actor) is derived from git so any agent that shells out to `aura radar emit`
//! lands a correctly-attributed event without extra config.

use std::sync::OnceLock;

use aura_redact::{RedactionConfig, Redactor};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use uuid::Uuid;

use super::identity;
use super::model::{AwarenessEvent, AwarenessKind};
use super::store;
use crate::live_events;

/// Redactor for free-text prose fields (`intent`, `impact`). These are the
/// human/agent sentences most likely to have a literal token, host, or PII
/// pasted into them, and they leave the box, so they get the off-box
/// [`RedactionConfig::strict`] profile (also strips bare IPs + PII and uses a
/// lower entropy bar). Built once — each `Redactor` compiles ~20 regexes — and
/// reused for every event.
fn prose_redactor() -> &'static Redactor {
    static R: OnceLock<Redactor> = OnceLock::new();
    R.get_or_init(|| Redactor::with_config(RedactionConfig::strict()))
}

/// Redactor for identifier fields (`symbol`, `file`). Defensive only: a real
/// symbol name or path is an ordinary identifier, so the conservative default
/// profile's mixed-character entropy guard leaves SHAs, UUIDs, and normal paths
/// untouched while still catching a prefixed credential that somehow ended up in
/// one. Built once and reused.
fn ident_redactor() -> &'static Redactor {
    static R: OnceLock<Redactor> = OnceLock::new();
    R.get_or_init(Redactor::new)
}

/// Scrub an optional outbound field through `r`, preserving `None`.
fn scrub_opt(r: &Redactor, v: Option<String>) -> Option<String> {
    v.map(|s| r.run(&s))
}

/// Fields a caller supplies; everything else (id, repo, branch, actor, ts,
/// signature) is filled in here.
pub struct EmitInput {
    pub kind: AwarenessKind,
    pub file: Option<String>,
    pub symbol: Option<String>,
    pub intent: Option<String>,
    pub impact: Option<String>,
    /// When set, this is an AI agent emitting under the given label
    /// (e.g. `claude@cursor`). When `None`, the human git user is the actor.
    pub agent: Option<String>,
}

/// Construct the event, sign it with the repo-local identity (M3a) when one is
/// available, persist it to the local store, and return it. Cross-machine push
/// rides `LiveTransport` (AURA-15): a detached, throttled `radar sync` is
/// kicked after the local append so hooks never block on the network.
pub fn emit(input: EmitInput) -> AwarenessEvent {
    let is_agent = input.agent.is_some();
    let actor = input.agent.unwrap_or_else(live_events::git_user);

    // Scrub every outbound free-text field BEFORE the event is built, signed,
    // and persisted — the signature must cover the redacted bytes, and the
    // on-disk copy must never carry a secret either. Prose fields get the
    // off-box strict profile; identifiers get the conservative one.
    let mut ev = AwarenessEvent {
        id: Uuid::new_v4().to_string(),
        actor,
        is_agent,
        kind: input.kind,
        repo: live_events::repo_name(),
        branch: live_events::current_branch(),
        file: scrub_opt(ident_redactor(), input.file),
        symbol: scrub_opt(ident_redactor(), input.symbol),
        intent: scrub_opt(prose_redactor(), input.intent),
        impact: scrub_opt(prose_redactor(), input.impact),
        ts: live_events::now_ms(),
        key_id: None,
        sig: None,
        pubkey: None,
        // Which checkout this came from. Peers reading the shared feed see
        // "claude, in barcelona" instead of a branch name they have to map
        // back to a directory themselves.
        worktree: crate::worktree::paths::current_worktree(),
    };

    // M3a: sign the canonical bytes so the event can't be spoofed by another
    // actor. The 32-byte verifying key rides along (self-certifying) so any
    // teammate can verify on ingest without a key registry — the pubkey
    // re-derives `key_id`, pinning the two together. Unsigned emission still
    // works if no keystore is available.
    if let Some(key) = identity::load() {
        let sig = key.sign(&ev.signing_bytes());
        ev.key_id = Some(key.key_id());
        ev.sig = Some(sig.to_b64());
        ev.pubkey = Some(B64URL.encode(key.verifying_key().to_bytes()));
    }

    let _ = store::append(&ev);
    // AURA-15: kick the (policy-gated, throttled, detached) broadcast so the
    // event reaches teammates' radars. Never blocks, never fails the emit.
    super::broadcast::maybe_spawn_sync();
    ev
}

/// Global per-actor firehose cap for the auto-emitters: even across many
/// *distinct* targets (an agent sweeping 50 files in one refactor), at most
/// [`RATE_CAP`] events per actor land per [`RATE_WINDOW_MS`]. The per-target
/// throttle below can't catch that case — each file is a fresh target. Manual
/// `aura radar emit` calls [`emit`] directly and is deliberately not capped.
const RATE_CAP: usize = 20;
const RATE_WINDOW_MS: u64 = 60_000;

/// Like [`emit`], but suppressed if the same actor already emitted the same
/// `kind` + target within `within_ms` — or if the actor has hit the global
/// [`RATE_CAP`]. This is what the auto-emitters (hooks, watcher) use so a tight
/// edit loop OR a wide sweep yields a calm signal, not a firehose. Returns
/// `None` when throttled.
pub fn emit_throttled(input: EmitInput, within_ms: u64) -> Option<AwarenessEvent> {
    let actor = input
        .agent
        .clone()
        .unwrap_or_else(live_events::git_user);
    let now = live_events::now_ms();
    if store::has_recent(
        &actor,
        input.kind,
        input.file.as_deref(),
        input.symbol.as_deref(),
        within_ms,
        now,
    ) {
        return None;
    }
    if store::count_recent_by_actor(&actor, RATE_WINDOW_MS, now) >= RATE_CAP {
        return None;
    }
    Some(emit(input))
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

    fn input(symbol: &str) -> EmitInput {
        EmitInput {
            kind: AwarenessKind::Editing,
            file: Some("src/auth.rs".into()),
            symbol: Some(symbol.into()),
            intent: None,
            impact: None,
            agent: Some("claude@test".into()),
        }
    }

    #[test]
    fn throttle_collapses_a_tight_edit_loop() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();

        // First edit of `login` lands.
        assert!(emit_throttled(input("login"), 60_000).is_some());
        // Same actor+kind+target inside the window is suppressed — this is the
        // firehose guard the auto-emitters depend on.
        assert!(emit_throttled(input("login"), 60_000).is_none());
        assert!(emit_throttled(input("login"), 60_000).is_none());
        // A different symbol is its own target, so it still emits.
        assert!(emit_throttled(input("logout"), 60_000).is_some());

        // Exactly one `login` editing event persisted despite three calls.
        let logins = store::read_all()
            .iter()
            .filter(|e| e.kind == AwarenessKind::Editing && e.symbol.as_deref() == Some("login"))
            .count();
        assert_eq!(logins, 1);
    }

    #[test]
    fn rate_cap_stops_a_wide_sweep() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();

        // An agent sweeping many DISTINCT files — each is a fresh target, so
        // the per-target throttle never fires. The global cap must.
        let mut landed = 0;
        for i in 0..(RATE_CAP + 10) {
            let ev = emit_throttled(
                EmitInput {
                    kind: AwarenessKind::Editing,
                    file: Some(format!("src/file_{i}.rs")),
                    symbol: None,
                    intent: None,
                    impact: None,
                    agent: Some("claude@test".into()),
                },
                60_000,
            );
            if ev.is_some() {
                landed += 1;
            }
        }
        assert_eq!(landed, RATE_CAP, "cap must bound a wide sweep");

        // A DIFFERENT actor is not collateral damage of the noisy one.
        assert!(emit_throttled(
            EmitInput {
                kind: AwarenessKind::Editing,
                file: Some("src/other.rs".into()),
                symbol: None,
                intent: None,
                impact: None,
                agent: Some("gemini@test".into()),
            },
            60_000,
        )
        .is_some());
    }

    #[test]
    fn secrets_are_scrubbed_before_sign_and_persist() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();

        const SECRET: &str = "sk-ant-api03-abcdefghijklmnopqrstuvwx";
        let ev = emit(EmitInput {
            kind: AwarenessKind::Intent,
            file: Some("src/auth.rs".into()),
            symbol: Some("login".into()),
            intent: Some(format!("wire OAuth with token {SECRET}")),
            // Public IP — strict scrubs these (private 10.x/192.168.x stay, by
            // design: they're common, non-sensitive dev addresses).
            impact: Some("rollout touches host 8.8.8.8".into()),
            agent: Some("claude@test".into()),
        });

        // The literal token never reaches the returned (signed) event...
        let intent = ev.intent.as_deref().unwrap_or_default();
        assert!(!intent.contains(SECRET), "token leaked into intent: {intent}");
        assert!(intent.contains("[REDACTED"), "intent not scrubbed: {intent}");
        // ...and the off-box prose profile also strips the bare public IP.
        let impact = ev.impact.as_deref().unwrap_or_default();
        assert!(!impact.contains("8.8.8.8"), "ip leaked into impact: {impact}");
        // Ordinary identifiers (real symbol + path) survive untouched.
        assert_eq!(ev.symbol.as_deref(), Some("login"));
        assert_eq!(ev.file.as_deref(), Some("src/auth.rs"));

        // The persisted on-disk copy is the scrubbed one, not the raw input.
        let persisted = store::read_all();
        assert!(
            persisted.iter().any(|e| e
                .intent
                .as_deref()
                .is_some_and(|s| s.contains("[REDACTED"))),
            "no scrubbed intent persisted"
        );
        assert!(
            !persisted.iter().any(|e| e
                .intent
                .as_deref()
                .is_some_and(|s| s.contains(SECRET))),
            "raw secret reached the on-disk store"
        );
    }
}
