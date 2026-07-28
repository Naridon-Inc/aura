//! Shared HTTP client for native brains.
//!
//! Each native brain (`anthropic_native`, `openai_native`, `gemini_native`)
//! previously built a fresh `reqwest::Client` per stream call, discarding the
//! connection pool and TLS session on every send. `reqwest::Client` is
//! internally reference-counted and cheap to clone, and every clone shares one
//! pool — so a single process-wide client keeps connections warm across sends,
//! shaving the TLS/handshake cost off the first token. Pairs with the
//! keychain-key memo (see `keychain`) to close the per-send TTFT gap (AURA-8).

use std::sync::OnceLock;
use std::time::Duration;

/// A process-wide `reqwest::Client` whose connection pool is shared across all
/// native-brain requests. Cheap to clone — the returned handle shares the pool.
///
/// The pool is what makes this fast and also what makes it dangerous after an
/// idle spell: a socket that sat unused while the laptop slept (or while a NAT
/// or VPN quietly dropped it) is usually already dead at the far end, and
/// reusing it produces a request that never gets a reply and never errors. The
/// timeouts below exist so no send can wait forever — there is deliberately no
/// whole-request timeout, because a long answer legitimately streams for
/// minutes.
pub(crate) fn shared_client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                // Retire idle sockets rather than gambling on them.
                .pool_idle_timeout(Duration::from_secs(45))
                // Notice a half-open link mid-stream instead of waiting on a
                // socket that will never speak again.
                .tcp_keepalive(Duration::from_secs(30))
                .connect_timeout(Duration::from_secs(15))
                // Per-read, not per-request: a gap this long between bytes
                // means the connection is gone, not that the model is slow.
                .read_timeout(Duration::from_secs(120))
                .build()
                // A builder failure here would be a TLS-backend problem, not
                // a config one; fall back rather than panicking on first use.
                .unwrap_or_else(|_| reqwest::Client::new())
        })
        .clone()
}
