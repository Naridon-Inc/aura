//! # aura-redact
//!
//! Always-on secret and PII scrubber for arbitrary text — the layer you run on
//! anything before it leaves the local machine: LLM prompts and transcripts,
//! error reports, telemetry, crash dumps, agent-to-agent handovers.
//!
//! Two passes, in order:
//!
//! 1. **Pattern pass** ([`mod@patterns`]) — deterministic, shape-based rules for
//!    known credential and PII formats: cloud keys (AWS, Google, Stripe),
//!    VCS tokens (GitHub, GitLab), Slack tokens + webhooks, JWTs, PEM
//!    private-key blocks, credentialed URIs (`scheme://user:pass@host`),
//!    `key = value` secret assignments, and emails. IP and PII rules are
//!    opt-in. Caller rule-packs ([`CustomRule`]) run first.
//! 2. **Entropy pass** ([`mod@entropy`]) — Shannon-entropy analysis catches
//!    random keys and base64 blobs that carry no known prefix, with a
//!    mixed-character guard so it doesn't eat git SHAs, UUIDs, or long
//!    identifiers.
//!
//! ## Quick start (conservative profile)
//!
//! ```
//! let dirty = "Email admin@example.com — token sk-proj-1234567890abcdefghij";
//! let clean = aura_redact::Redactor::scrub(dirty);
//! assert!(clean.contains("[REDACTED_EMAIL]"));
//! assert!(clean.contains("[REDACTED_TOKEN]"));
//! ```
//!
//! ## Off-box profile + a report
//!
//! ```
//! use aura_redact::{Redactor, RedactionConfig};
//!
//! let r = Redactor::with_config(RedactionConfig::strict());
//! let report = r.report("ssh root@10.0.0.1, key AKIAIOSFODNN7EXAMPLE");
//! assert!(report.text.contains("[REDACTED_AWS_KEY]"));
//! assert!(report.total() >= 1);
//! ```
//!
//! Originally extracted from [Aura](https://auravcs.com), the semantic
//! version control engine, where it scrubs every payload synced off-box.

mod config;
mod entropy;
mod patterns;

pub use config::{CustomRule, RedactionConfig};

use patterns::PatternSet;

/// A tally of what a redaction pass removed, plus the scrubbed `text`. Returned
/// by [`Redactor::report`] so a caller can log "scrubbed 3 secrets before sync"
/// or assert nothing leaked, without diffing strings.
#[derive(Clone, Debug, Default)]
pub struct RedactionReport {
    /// The redacted output.
    pub text: String,
    /// Emails replaced.
    pub emails: usize,
    /// Prefixed API tokens / cloud keys replaced.
    pub tokens: usize,
    /// PEM private-key blocks replaced.
    pub private_keys: usize,
    /// JWTs replaced.
    pub jwts: usize,
    /// Credentialed URIs whose password was stripped.
    pub credentialed_uris: usize,
    /// `key = value` secret assignments whose value was stripped.
    pub assignments: usize,
    /// Bare IPv4 addresses replaced (opt-in).
    pub ips: usize,
    /// PII items (SSN / credit card / phone) replaced (opt-in).
    pub pii: usize,
    /// High-entropy tokens replaced by the entropy pass.
    pub high_entropy: usize,
    /// Hits from caller-supplied [`CustomRule`] rule-packs.
    pub custom: usize,
}

impl RedactionReport {
    /// Total number of redactions across every category. `0` means the input
    /// was already clean.
    pub fn total(&self) -> usize {
        self.emails
            + self.tokens
            + self.private_keys
            + self.jwts
            + self.credentialed_uris
            + self.assignments
            + self.ips
            + self.pii
            + self.high_entropy
            + self.custom
    }
}

/// The scrubber. Compiles the built-in pattern set once on construction, then
/// scrubs many strings against a fixed [`RedactionConfig`].
///
/// For a one-shot call with the conservative defaults, the static
/// [`Redactor::scrub`] needs no construction.
pub struct Redactor {
    config: RedactionConfig,
    patterns: PatternSet,
}

impl Redactor {
    /// A redactor with the conservative [`RedactionConfig::default`] profile.
    pub fn new() -> Self {
        Self::with_config(RedactionConfig::default())
    }

    /// A redactor with a caller-chosen profile (e.g. [`RedactionConfig::strict`]
    /// or a builder-customised one).
    pub fn with_config(config: RedactionConfig) -> Self {
        Self { config, patterns: PatternSet::new() }
    }

    /// Scrub `text` and return just the redacted string. Use [`Self::report`]
    /// when you also want the tally.
    pub fn run(&self, text: &str) -> String {
        self.report(text).text
    }

    /// Scrub `text` and return a full [`RedactionReport`] (counts + the
    /// redacted text). Runs the pattern pass, then the entropy pass.
    pub fn report(&self, text: &str) -> RedactionReport {
        let mut report = RedactionReport::default();
        let after_patterns = self.patterns.scrub(text, &self.config, &mut report);
        let (after_entropy, n) =
            entropy::scrub(&after_patterns, &self.config, "[REDACTED_HIGH_ENTROPY]");
        report.high_entropy += n;
        report.text = after_entropy;
        report
    }

    /// One-shot convenience: scrub `text` with the conservative default profile.
    /// Equivalent to `Redactor::new().run(text)` but spelled as a static so the
    /// common "just clean this string" call needs no value. Compiles the pattern
    /// set per call — for hot loops, build one [`Redactor`] and reuse it.
    pub fn scrub(text: &str) -> String {
        Redactor::new().run(text)
    }
}

impl Default for Redactor {
    fn default() -> Self {
        Self::new()
    }
}

/// Crate-root convenience equal to [`Redactor::scrub`] — `aura_redact::scrub(s)`.
pub fn scrub(text: &str) -> String {
    Redactor::scrub(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_email_redaction() {
        let input = "Contact me at admin@example.com for keys.";
        let output = Redactor::scrub(input);
        assert!(output.contains("[REDACTED_EMAIL]"));
        assert!(!output.contains("admin@example.com"));
    }

    #[test]
    fn test_high_entropy_redaction() {
        // API tokens with known prefixes should be caught by pattern matching.
        let input = "Token: sk-proj-1234567890abcdefghij";
        let output = Redactor::scrub(input);
        assert!(
            output.contains("[REDACTED_TOKEN]"),
            "Expected token redaction for sk- prefix. Got: {output}"
        );

        // GitHub token prefix.
        let input2 = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ12345";
        let output2 = Redactor::scrub(input2);
        assert!(
            output2.contains("[REDACTED_TOKEN]"),
            "Expected token redaction for ghp_ prefix. Got: {output2}"
        );
    }

    #[test]
    fn test_low_entropy_preservation() {
        // Normal English sentence (low entropy) — nothing should be touched.
        let input = "This is a perfectly normal sentence that should not be redacted.";
        let output = Redactor::scrub(input);
        assert!(!output.contains("[REDACTED]"));
        assert_eq!(input, output);
    }

    #[test]
    fn report_counts_and_carries_text() {
        let r = Redactor::new();
        let rep = r.report("mail a@b.co and key sk-ant-api03-abcdefghijklmnopqrstuvwx");
        assert_eq!(rep.emails, 1);
        assert_eq!(rep.tokens, 1);
        assert!(rep.total() >= 2);
        assert!(rep.text.contains("[REDACTED_EMAIL]"));
        assert!(rep.text.contains("[REDACTED_TOKEN]"));
    }

    #[test]
    fn crate_root_scrub_matches_static() {
        let s = "admin@example.com";
        assert_eq!(scrub(s), Redactor::scrub(s));
    }

    #[test]
    fn strict_profile_is_more_aggressive() {
        let text = "host 8.8.8.8 ssn 123-45-6789";
        let lenient = Redactor::new().report(text);
        let strict = Redactor::with_config(RedactionConfig::strict()).report(text);
        assert!(strict.total() > lenient.total());
    }
}
