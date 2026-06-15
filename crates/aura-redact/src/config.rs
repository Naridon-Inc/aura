//! Configuration for a [`crate::Redactor`].
//!
//! The default profile is deliberately conservative — it redacts credentials
//! and high-entropy secrets but leaves bare IP addresses, version strings and
//! personal data alone, so it's safe to run on arbitrary source and prose
//! without mangling it. The [`RedactionConfig::strict`] profile is the
//! always-on, send-nothing-sensitive-off-box profile: it additionally redacts
//! IPs and PII and lowers the entropy bar.

use regex::Regex;

/// A caller-supplied redaction rule. Aura's CLI compiles a project's
/// `.aura/redactors/*` rule-packs into these and hands them to the redactor,
/// so teams can scrub house-specific secret shapes (internal token formats,
/// customer identifiers) the built-in patterns don't know about.
#[derive(Clone, Debug)]
pub struct CustomRule {
    /// Human label, surfaced in the [`crate::RedactionReport`].
    pub name: String,
    /// The compiled matcher.
    pub regex: Regex,
    /// What to substitute for each match (e.g. `[REDACTED_INTERNAL]`).
    pub placeholder: String,
}

impl CustomRule {
    /// Compile a rule from a raw regex string. Returns the regex error if the
    /// pattern is invalid, so a bad rule-pack fails loudly at load instead of
    /// silently scrubbing nothing.
    pub fn new(
        name: impl Into<String>,
        pattern: &str,
        placeholder: impl Into<String>,
    ) -> Result<Self, regex::Error> {
        Ok(Self {
            name: name.into(),
            regex: Regex::new(pattern)?,
            placeholder: placeholder.into(),
        })
    }
}

/// How a [`crate::Redactor`] behaves. Build [`RedactionConfig::default`] for the
/// conservative profile, [`RedactionConfig::strict`] for the off-box profile, or
/// tweak fields directly.
#[derive(Clone, Debug)]
pub struct RedactionConfig {
    /// Run the Shannon-entropy pass — catches random keys with no known prefix.
    pub entropy: bool,
    /// Minimum bits/char to treat a token as a secret. Default `4.5`. A 40-char
    /// hex git SHA tops out near `4.0`, so this leaves commit hashes intact.
    pub entropy_threshold: f64,
    /// Minimum token length the entropy pass considers. Default `20`.
    pub entropy_min_len: usize,
    /// Require a high-entropy token to also carry a digit or a base64 symbol
    /// before redacting. Default `true` — protects long camelCase identifiers
    /// and hex hashes from being eaten by the entropy pass.
    pub entropy_require_mixed: bool,
    /// Redact bare IPv4 addresses. Default `false`: bare IPs aren't secrets and
    /// the pattern can't be told apart from a four-part version string, so it's
    /// opt-in. Credentials embedded in a URL (`scheme://user:pass@host`) are
    /// always redacted regardless of this flag.
    pub redact_ips: bool,
    /// When [`Self::redact_ips`] is on, also redact private / loopback /
    /// link-local ranges (`10.x`, `192.168.x`, `127.x`, …). Default `false` —
    /// local addresses are common in dev configs and aren't sensitive.
    pub redact_private_ips: bool,
    /// Redact personally-identifiable info: phone numbers, SSNs, credit cards.
    /// Opt-in (default `false`) to match least-surprise. Emails are treated as
    /// credential-adjacent and redacted regardless.
    pub pii: bool,
    /// Caller rule-packs, applied first (highest priority) so a house rule can
    /// claim a match before the generic patterns do.
    pub custom_rules: Vec<CustomRule>,
}

impl Default for RedactionConfig {
    fn default() -> Self {
        Self {
            entropy: true,
            entropy_threshold: 4.5,
            entropy_min_len: 20,
            entropy_require_mixed: true,
            redact_ips: false,
            redact_private_ips: false,
            pii: false,
            custom_rules: Vec::new(),
        }
    }
}

impl RedactionConfig {
    /// The off-box profile: redact everything plausibly sensitive before text
    /// leaves the machine (telemetry, cloud sync, handover to another agent).
    /// Turns on IP + PII redaction, lowers the entropy bar, and drops the mixed
    /// guard so even pure-alphabetic high-entropy blobs are caught.
    pub fn strict() -> Self {
        Self {
            entropy: true,
            // 3.5 bits/char, below hex's 4.0 ceiling, so all-lowercase hex
            // secrets (and git SHAs — acceptable collateral off-box) are caught.
            entropy_threshold: 3.5,
            entropy_min_len: 12,
            entropy_require_mixed: false,
            redact_ips: true,
            redact_private_ips: false,
            pii: true,
            custom_rules: Vec::new(),
        }
    }

    /// Toggle PII redaction.
    pub fn with_pii(mut self, on: bool) -> Self {
        self.pii = on;
        self
    }

    /// Toggle bare-IP redaction.
    pub fn with_ips(mut self, on: bool) -> Self {
        self.redact_ips = on;
        self
    }

    /// Set the entropy threshold (bits/char).
    pub fn with_entropy_threshold(mut self, bits: f64) -> Self {
        self.entropy_threshold = bits;
        self
    }

    /// Append a custom rule-pack rule.
    pub fn add_rule(mut self, rule: CustomRule) -> Self {
        self.custom_rules.push(rule);
        self
    }
}
