//! Brain-limit classifier — W1 of the cross-engine continuity spine.
//!
//! When a brain fails a turn, the question that drives failover is not "what
//! HTTP code came back" but "would trying a *different* engine plausibly help?"
//! A 429 on Claude is worth retrying on Gemini; a context-window overflow fails
//! identically on every engine; a clean user-cancel should never failover at
//! all. This module collapses every [`BrainError`] into that single dimension
//! ([`LimitClass`] + [`LimitState`]) and keeps a process-global per-engine
//! cooldown ledger so the failover picker skips an engine that just rate-limited
//! until its window passes.
//!
//! The classifier is the only place that reasons about *why* a brain is down,
//! so the failover logic upstream stays a dumb "pick the next worthy, non-cooling
//! engine" loop.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::types::BrainError;

/// Why a brain could not serve a turn — the dimension that decides whether
/// trying a *different* engine could help.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitClass {
    /// Sign-in expired / token rejected for THIS engine. Another engine with
    /// its own credentials can serve right now.
    AuthRequired,
    /// Quota or rate limit (429 / `quota_exceeded`). A peer engine is unmetered
    /// against this one's bucket.
    RateLimited,
    /// Server 5xx / network blip — likely works on retry or elsewhere.
    Transient,
    /// Prompt/context too large — the same input fails on ANY engine, so
    /// failover is pointless.
    ContextOverflow,
    /// User asked to stop — not a failure to route around.
    Canceled,
    /// Permanent/config/bug — switching engines won't help.
    Fatal,
}

/// The failover decision for one [`BrainError`]: its class, whether a different
/// engine is worth trying, how long to avoid THIS engine, and a log line.
#[derive(Debug, Clone)]
pub struct LimitState {
    /// The classified limit dimension.
    pub class: LimitClass,
    /// Could retrying this exact turn on a DIFFERENT engine plausibly succeed?
    /// true for AuthRequired/RateLimited/Transient; false for
    /// ContextOverflow/Canceled/Fatal (a bigger-than-window prompt or a clean
    /// cancel or a config bug fails identically everywhere).
    pub failover_worthy: bool,
    /// How long to avoid THIS engine before trying it again. None when there's
    /// nothing to wait out (Canceled/Fatal/ContextOverflow).
    pub cooldown: Option<Duration>,
    /// Human one-liner for logs/telemetry (never shown raw to end users).
    pub reason: String,
}

/// How long an engine stays "cooling" after each kind of recoverable limit.
/// AuthRequired holds the longest — the engine is down until the user re-auths,
/// but another engine can serve in the meantime, so it's still failover-worthy.
const COOLDOWN_AUTH: Duration = Duration::from_secs(30 * 60);
const COOLDOWN_QUOTA: Duration = Duration::from_secs(5 * 60);
const COOLDOWN_RATE_429: Duration = Duration::from_secs(60);
const COOLDOWN_TRANSIENT_HTTP: Duration = Duration::from_secs(15);
const COOLDOWN_PROVIDER: Duration = Duration::from_secs(15);
const COOLDOWN_NETWORK: Duration = Duration::from_secs(10);
const COOLDOWN_PROCESS: Duration = Duration::from_secs(10);

/// Substrings (matched against a lowercased error message) that mean the prompt
/// exceeded the model's context window. An oversized prompt fails on every
/// engine, so any of these forces [`LimitClass::ContextOverflow`] regardless of
/// the HTTP status that carried it.
const CONTEXT_OVERFLOW_SIGNALS: &[&str] = &[
    "context length",
    "context window",
    "maximum context",
    "prompt is too long",
    "too many tokens",
    "exceeds the maximum",
];

/// True if `message` (in any case) carries a context-window-overflow signal.
fn is_context_overflow(message: &str) -> bool {
    let lower = message.to_lowercase();
    CONTEXT_OVERFLOW_SIGNALS
        .iter()
        .any(|sig| lower.contains(sig))
}

/// The shared [`LimitState`] for an oversized-prompt failure. Pulled out so the
/// message-substring check classifies identically across `Api`, `Provider`, and
/// `Other`.
fn context_overflow_state() -> LimitState {
    LimitState {
        class: LimitClass::ContextOverflow,
        failover_worthy: false,
        cooldown: None,
        reason: "context too large".to_string(),
    }
}

/// Classify a [`BrainError`] into a failover decision.
///
/// The rules are intentionally explicit (one arm per variant) rather than
/// data-driven so the mapping reads like the spec it implements. Context-window
/// overflow is checked BEFORE the HTTP status table for the message-bearing
/// variants, because an oversized prompt often arrives as a 400 that would
/// otherwise be misclassified as `Fatal`.
pub fn classify_limit(err: &BrainError) -> LimitState {
    match err {
        BrainError::AuthRequired { .. } => LimitState {
            class: LimitClass::AuthRequired,
            failover_worthy: true,
            cooldown: Some(COOLDOWN_AUTH),
            reason: "auth expired".to_string(),
        },
        BrainError::QuotaExceeded { .. } => LimitState {
            class: LimitClass::RateLimited,
            failover_worthy: true,
            cooldown: Some(COOLDOWN_QUOTA),
            reason: "quota exceeded".to_string(),
        },
        BrainError::Api { status, message } => {
            // An oversized-prompt error often rides a 400; classify it as
            // ContextOverflow first so it isn't swept into the generic-4xx
            // Fatal bucket below.
            if is_context_overflow(message) {
                return context_overflow_state();
            }
            classify_status(*status)
        }
        BrainError::Provider { message, .. } => {
            // Provider is the "couldn't classify, maybe retry once" bucket: run
            // the same context check, otherwise treat as transient and let the
            // failover picker try a peer engine.
            if is_context_overflow(message) {
                return context_overflow_state();
            }
            LimitState {
                class: LimitClass::Transient,
                failover_worthy: true,
                cooldown: Some(COOLDOWN_PROVIDER),
                reason: "provider error".to_string(),
            }
        }
        BrainError::Network { .. } => LimitState {
            class: LimitClass::Transient,
            failover_worthy: true,
            cooldown: Some(COOLDOWN_NETWORK),
            reason: "network blip".to_string(),
        },
        BrainError::Process { .. } => LimitState {
            // A CLI child that died may come back; another engine can serve in
            // the meantime, so this is failover-worthy.
            class: LimitClass::Transient,
            failover_worthy: true,
            cooldown: Some(COOLDOWN_PROCESS),
            reason: "process died".to_string(),
        },
        BrainError::Canceled => LimitState {
            class: LimitClass::Canceled,
            failover_worthy: false,
            cooldown: None,
            reason: "canceled".to_string(),
        },
        BrainError::Parse { .. } => LimitState {
            // A stream we can't parse is a bug, not a limit.
            class: LimitClass::Fatal,
            failover_worthy: false,
            cooldown: None,
            reason: "unrecoverable: parse".to_string(),
        },
        BrainError::Keychain { .. } => LimitState {
            // A missing/locked key for THIS engine; another engine may have its
            // own key, so failover is worthwhile and the cooldown mirrors auth.
            class: LimitClass::AuthRequired,
            failover_worthy: true,
            cooldown: Some(COOLDOWN_AUTH),
            reason: "keychain locked".to_string(),
        },
        BrainError::UnknownProvider { .. } => LimitState {
            class: LimitClass::Fatal,
            failover_worthy: false,
            cooldown: None,
            reason: "unrecoverable: unknown_provider".to_string(),
        },
        BrainError::Other { message } => {
            if is_context_overflow(message) {
                return context_overflow_state();
            }
            LimitState {
                class: LimitClass::Fatal,
                failover_worthy: false,
                cooldown: None,
                reason: "unrecoverable: other".to_string(),
            }
        }
    }
}

/// Map a bare HTTP status (from [`BrainError::Api`]) onto a [`LimitState`],
/// after the caller has already ruled out a context-window message. Split out
/// so the status table reads as a single ordered cascade.
fn classify_status(status: u16) -> LimitState {
    match status {
        401 | 403 => LimitState {
            class: LimitClass::AuthRequired,
            failover_worthy: true,
            cooldown: Some(COOLDOWN_AUTH),
            reason: format!("auth rejected ({status})"),
        },
        429 => LimitState {
            class: LimitClass::RateLimited,
            failover_worthy: true,
            cooldown: Some(COOLDOWN_RATE_429),
            reason: "rate limited (429)".to_string(),
        },
        408 => LimitState {
            class: LimitClass::Transient,
            failover_worthy: true,
            cooldown: Some(COOLDOWN_TRANSIENT_HTTP),
            reason: "request timeout (408)".to_string(),
        },
        413 => LimitState {
            class: LimitClass::ContextOverflow,
            failover_worthy: false,
            cooldown: None,
            reason: "payload too large (413)".to_string(),
        },
        s if s >= 500 => LimitState {
            class: LimitClass::Transient,
            failover_worthy: true,
            cooldown: Some(COOLDOWN_TRANSIENT_HTTP),
            reason: "server 5xx".to_string(),
        },
        // Any other 4xx is a malformed client request — switching engines won't
        // fix it, so it's fatal and not failover-worthy.
        _ => LimitState {
            class: LimitClass::Fatal,
            failover_worthy: false,
            cooldown: None,
            reason: format!("unrecoverable: client_error ({status})"),
        },
    }
}

/// Process-global ledger of when each engine's cooldown EXPIRES, keyed by
/// `provider_id`. Lazily initialised so the module has no startup cost when no
/// engine has ever been rate-limited.
static COOLDOWNS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

/// Borrow the cooldown ledger, initialising it on first use.
fn cooldowns() -> &'static Mutex<HashMap<String, Instant>> {
    COOLDOWNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Mark `engine` as cooling for `dur` from now. After an engine is
/// rate-limited / transient-failed, the failover picker skips it until the
/// window passes. Overwrites any earlier expiry for the same engine (the
/// freshest failure wins). Keyed by `provider_id` (e.g. `"anthropic_native"`,
/// `"cli_wrapper:gemini"`, `"aura_pro"`).
pub fn mark_cooldown(engine: &str, dur: Duration) {
    let expiry = Instant::now() + dur;
    cooldowns()
        .lock()
        .unwrap()
        .insert(engine.to_string(), expiry);
}

/// True if `engine` is still within its cooldown window right now.
pub fn is_cooling(engine: &str) -> bool {
    let now = Instant::now();
    cooldowns()
        .lock()
        .unwrap()
        .get(engine)
        .is_some_and(|&expiry| expiry > now)
}

/// The `provider_id`s still cooling right now. Prunes expired entries as a side
/// effect so the ledger never grows unbounded.
pub fn cooling_engines() -> Vec<String> {
    let now = Instant::now();
    let mut ledger = cooldowns().lock().unwrap();
    ledger.retain(|_, &mut expiry| expiry > now);
    ledger.keys().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_required_is_failover_worthy_with_cooldown() {
        let s = classify_limit(&BrainError::AuthRequired {
            message: "session expired".to_string(),
        });
        assert_eq!(s.class, LimitClass::AuthRequired);
        assert!(s.failover_worthy);
        assert!(s.cooldown.is_some());
    }

    #[test]
    fn quota_exceeded_is_rate_limited() {
        let s = classify_limit(&BrainError::QuotaExceeded {
            message: "over budget".to_string(),
            tokens_used: Some(100),
            monthly_token_limit: Some(100),
        });
        assert_eq!(s.class, LimitClass::RateLimited);
        assert!(s.failover_worthy);
        assert!(s.cooldown.is_some());
    }

    #[test]
    fn api_429_is_rate_limited() {
        let s = classify_limit(&BrainError::Api {
            status: 429,
            message: "slow down".to_string(),
        });
        assert_eq!(s.class, LimitClass::RateLimited);
        assert!(s.failover_worthy);
        assert!(s.cooldown.is_some());
    }

    #[test]
    fn api_503_is_transient() {
        let s = classify_limit(&BrainError::Api {
            status: 503,
            message: "upstream down".to_string(),
        });
        assert_eq!(s.class, LimitClass::Transient);
        assert!(s.failover_worthy);
        assert!(s.cooldown.is_some());
    }

    #[test]
    fn api_413_is_context_overflow_not_worthy() {
        let s = classify_limit(&BrainError::Api {
            status: 413,
            message: "payload too large".to_string(),
        });
        assert_eq!(s.class, LimitClass::ContextOverflow);
        assert!(!s.failover_worthy);
        assert!(s.cooldown.is_none());
    }

    #[test]
    fn api_400_is_fatal() {
        let s = classify_limit(&BrainError::Api {
            status: 400,
            message: "bad request".to_string(),
        });
        assert_eq!(s.class, LimitClass::Fatal);
        assert!(!s.failover_worthy);
        assert!(s.cooldown.is_none());
    }

    #[test]
    fn network_is_transient_worthy() {
        let s = classify_limit(&BrainError::Network {
            message: "dns failure".to_string(),
        });
        assert_eq!(s.class, LimitClass::Transient);
        assert!(s.failover_worthy);
        assert!(s.cooldown.is_some());
    }

    #[test]
    fn canceled_is_not_worthy() {
        let s = classify_limit(&BrainError::Canceled);
        assert_eq!(s.class, LimitClass::Canceled);
        assert!(!s.failover_worthy);
        assert!(s.cooldown.is_none());
    }

    #[test]
    fn parse_is_fatal() {
        let s = classify_limit(&BrainError::Parse {
            message: "bad json".to_string(),
        });
        assert_eq!(s.class, LimitClass::Fatal);
        assert!(!s.failover_worthy);
        assert!(s.cooldown.is_none());
    }

    #[test]
    fn unknown_provider_is_fatal() {
        let s = classify_limit(&BrainError::UnknownProvider {
            provider_id: "made_up".to_string(),
        });
        assert_eq!(s.class, LimitClass::Fatal);
        assert!(!s.failover_worthy);
        assert!(s.cooldown.is_none());
    }

    #[test]
    fn context_overflow_message_overrides_400_status() {
        // A 400 alone is Fatal, but an oversized-prompt message must win and
        // classify ContextOverflow (not failover-worthy — same input fails
        // everywhere).
        let s = classify_limit(&BrainError::Api {
            status: 400,
            message: "This model's maximum context length is 200000 tokens".to_string(),
        });
        assert_eq!(s.class, LimitClass::ContextOverflow);
        assert!(!s.failover_worthy);
        assert!(s.cooldown.is_none());
    }

    #[test]
    fn provider_context_overflow_message_classifies_overflow() {
        let s = classify_limit(&BrainError::Provider {
            status: Some(500),
            message: "the prompt is too long for this model".to_string(),
        });
        assert_eq!(s.class, LimitClass::ContextOverflow);
        assert!(!s.failover_worthy);
    }

    #[test]
    fn provider_without_overflow_is_transient() {
        let s = classify_limit(&BrainError::Provider {
            status: None,
            message: "gateway hiccup".to_string(),
        });
        assert_eq!(s.class, LimitClass::Transient);
        assert!(s.failover_worthy);
        assert!(s.cooldown.is_some());
    }

    #[test]
    fn keychain_is_auth_required_worthy() {
        let s = classify_limit(&BrainError::Keychain {
            message: "key not found".to_string(),
        });
        assert_eq!(s.class, LimitClass::AuthRequired);
        assert!(s.failover_worthy);
        assert!(s.cooldown.is_some());
    }

    #[test]
    fn cooldown_ledger_marks_and_reports() {
        // Unique engine id so the process-global map can't be touched by a
        // concurrent test.
        let engine = "test_engine_marks_and_reports";
        assert!(!is_cooling(engine), "fresh engine must not be cooling");

        mark_cooldown(engine, Duration::from_secs(60));
        assert!(is_cooling(engine), "marked engine must be cooling");
        assert!(
            cooling_engines().iter().any(|e| e == engine),
            "marked engine must appear in cooling_engines()"
        );
    }

    #[test]
    fn unmarked_engine_is_not_cooling() {
        let engine = "test_engine_never_marked";
        assert!(!is_cooling(engine));
        assert!(!cooling_engines().iter().any(|e| e == engine));
    }

    #[test]
    fn expired_cooldown_is_pruned() {
        let engine = "test_engine_expires_fast";
        // Zero-duration cooldown: the expiry instant is now, so it is already in
        // the past by the time we check (Instant::now() advances), hence pruned.
        mark_cooldown(engine, Duration::from_secs(0));
        assert!(!is_cooling(engine), "zero-duration cooldown must not cool");
        assert!(
            !cooling_engines().iter().any(|e| e == engine),
            "expired cooldown must be pruned out of cooling_engines()"
        );
    }
}
