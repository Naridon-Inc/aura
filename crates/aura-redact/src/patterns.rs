//! The pattern pass: deterministic, shape-based redaction of known secret and
//! PII formats. Runs before the entropy pass so anything with a recognisable
//! shape (a `ghp_…` token, a `user:pass@host` URI, a PEM block) is caught by
//! its name rather than by luck of entropy.
//!
//! Three kinds of rule live here:
//!
//! * **Literal shapes** — a regex per known credential format (cloud keys,
//!   VCS tokens, JWTs, private-key blocks). Compiled once into [`PatternSet`].
//! * **Structure-preserving rewrites** — credentialed URIs and `key = value`
//!   assignments, redacted with a closure so the *non-secret* structure
//!   (scheme, host, the key name) survives and the line stays legible.
//! * **Gated rules** — IPv4 (only when [`RedactionConfig::redact_ips`]) and PII
//!   (only when [`RedactionConfig::pii`]), off by default to avoid mangling
//!   ordinary source and prose.
//!
//! The regex crate has no look-around, so every rule is written to match in one
//! forward pass; the structure-preserving rules use capture groups + a closure
//! rather than look-behind.

use regex::{Captures, Regex};

use crate::config::RedactionConfig;
use crate::RedactionReport;

/// One literal-shape rule: a compiled matcher, its replacement, and which
/// report bucket a hit increments.
struct Shape {
    re: Regex,
    placeholder: &'static str,
    bucket: Bucket,
}

/// Which [`RedactionReport`] counter a hit bumps. PEM private-key blocks are
/// counted directly in [`PatternSet::scrub`] (not via a shape), so there's no
/// `PrivateKey` arm here.
#[derive(Clone, Copy)]
enum Bucket {
    Token,
    Jwt,
}

/// All built-in matchers, compiled once. Build with [`PatternSet::new`] and
/// reuse across many [`scrub`](PatternSet::scrub) calls — compilation is the
/// expensive part.
pub struct PatternSet {
    pem: Regex,
    cred_uri: Regex,
    assignment: Regex,
    shapes: Vec<Shape>,
    email: Regex,
    phone: Regex,
    ssn: Regex,
    credit_card: Regex,
    ipv4: Regex,
}

impl PatternSet {
    /// Compile the full built-in rule set. Panics only on a bug in these
    /// literal patterns (they're const), never on user input.
    pub fn new() -> Self {
        // Specific shapes first so they claim a match before the generic
        // `sk-…` / entropy fallbacks. Each `\b`-anchored where a bare prefix
        // would otherwise bleed into surrounding text.
        let shape_defs: &[(&str, &str, Bucket)] = &[
            // GitHub: ghp_/gho_/ghu_/ghs_/ghr_ (classic) + github_pat_ (fine-grained).
            // Floor is permissive (20, not the canonical 36) so truncated /
            // example tokens still redact — over-catching a token is safe.
            (r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b", "[REDACTED_TOKEN]", Bucket::Token),
            (r"\bgithub_pat_[A-Za-z0-9_]{22,}\b", "[REDACTED_TOKEN]", Bucket::Token),
            // GitLab personal access token.
            (r"\bglpat-[A-Za-z0-9_\-]{20,}\b", "[REDACTED_TOKEN]", Bucket::Token),
            // AWS access key id (long-term AKIA + temporary ASIA).
            (r"\b(AKIA|ASIA)[A-Z0-9]{16}\b", "[REDACTED_AWS_KEY]", Bucket::Token),
            // Google API key.
            (r"\bAIza[A-Za-z0-9_\-]{35}\b", "[REDACTED_TOKEN]", Bucket::Token),
            // Slack tokens (bot/user/app/refresh) + incoming webhooks.
            (r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b", "[REDACTED_TOKEN]", Bucket::Token),
            (r"https://hooks\.slack\.com/services/[A-Za-z0-9/]+", "[REDACTED_WEBHOOK]", Bucket::Token),
            // SendGrid API key.
            (r"\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\b", "[REDACTED_TOKEN]", Bucket::Token),
            // npm automation token.
            (r"\bnpm_[A-Za-z0-9]{36}\b", "[REDACTED_TOKEN]", Bucket::Token),
            // Stripe live/test secret/restricted/publishable keys.
            (r"\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}\b", "[REDACTED_TOKEN]", Bucket::Token),
            // Anthropic — before the generic `sk-` so it claims the match.
            (r"\bsk-ant-[A-Za-z0-9_\-]{20,}\b", "[REDACTED_TOKEN]", Bucket::Token),
            // OpenAI / generic `sk-` style key.
            (r"\bsk-[A-Za-z0-9_\-]{20,}\b", "[REDACTED_TOKEN]", Bucket::Token),
            // JWT (header.payload.signature, base64url).
            (
                r"\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b",
                "[REDACTED_JWT]",
                Bucket::Jwt,
            ),
        ];

        let shapes = shape_defs
            .iter()
            .map(|(p, ph, b)| Shape {
                re: Regex::new(p).expect("built-in pattern compiles"),
                placeholder: ph,
                bucket: *b,
            })
            .collect();

        Self {
            // PEM private-key block — `(?s)` so `.` spans the multi-line body.
            pem: Regex::new(
                r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
            )
            .unwrap(),
            // scheme://[user]:password@host — keep everything but the password.
            cred_uri: Regex::new(
                r"(?P<scheme>[a-zA-Z][a-zA-Z0-9+.\-]*://)(?P<user>[^:@/\s]*):(?P<pw>[^@/\s]+)@",
            )
            .unwrap(),
            // key = value / key: value for secret-ish keys — keep the key, redact
            // the value. Value can't start with `[` so an already-redacted
            // placeholder isn't re-chewed.
            assignment: Regex::new(
                r#"(?i)\b(?P<key>passwords?|passwd|pwd|secret|secrets|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|auth[_-]?token|private[_-]?key)(?P<sep>\s*[:=]\s*)(?P<q>["']?)(?P<val>[^\s"',;\[][^\s"',;]*)"#,
            )
            .unwrap(),
            shapes,
            email: Regex::new(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}").unwrap(),
            // Phone: optional +CC then 9–14 digits with space/dot/hyphen/paren
            // separators. Deliberately requires a separator so bare long
            // integers (ids, timestamps) don't trip it.
            phone: Regex::new(
                r"\+?\d{1,3}[\s.\-]\(?\d{2,4}\)?[\s.\-]\d{3,4}[\s.\-]\d{3,4}\b",
            )
            .unwrap(),
            ssn: Regex::new(r"\b\d{3}-\d{2}-\d{4}\b").unwrap(),
            credit_card: Regex::new(r"\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b").unwrap(),
            ipv4: Regex::new(r"\b(?P<a>\d{1,3})\.(?P<b>\d{1,3})\.(?P<c>\d{1,3})\.(?P<d>\d{1,3})\b")
                .unwrap(),
        }
    }

    /// Apply the pattern pass to `text`, honouring `cfg`'s gates, and record
    /// hit counts into `report`. Returns the scrubbed text. The entropy pass
    /// runs separately (in the facade) after this.
    pub fn scrub(&self, text: &str, cfg: &RedactionConfig, report: &mut RedactionReport) -> String {
        let mut s = text.to_string();

        // 0. Custom rule-packs first — a house rule outranks the generics.
        for rule in &cfg.custom_rules {
            let hits = rule.regex.find_iter(&s).count();
            if hits > 0 {
                s = rule.regex.replace_all(&s, rule.placeholder.as_str()).into_owned();
                report.custom += hits;
            }
        }

        // 1. PEM private-key blocks.
        let pem_hits = self.pem.find_iter(&s).count();
        if pem_hits > 0 {
            s = self.pem.replace_all(&s, "[REDACTED_PRIVATE_KEY]").into_owned();
            report.private_keys += pem_hits;
        }

        // 2. Credentialed URIs — keep scheme+user+host, drop the password.
        let mut uri_hits = 0usize;
        s = self
            .cred_uri
            .replace_all(&s, |c: &Captures| {
                uri_hits += 1;
                format!("{}{}:[REDACTED]@", &c["scheme"], &c["user"])
            })
            .into_owned();
        report.credentialed_uris += uri_hits;

        // 3. Literal credential shapes.
        for shape in &self.shapes {
            let hits = shape.re.find_iter(&s).count();
            if hits == 0 {
                continue;
            }
            s = shape.re.replace_all(&s, shape.placeholder).into_owned();
            match shape.bucket {
                Bucket::Token => report.tokens += hits,
                Bucket::Jwt => report.jwts += hits,
            }
        }

        // 4. key = value assignments — keep the key, redact the value.
        let mut assign_hits = 0usize;
        s = self
            .assignment
            .replace_all(&s, |c: &Captures| {
                assign_hits += 1;
                format!("{}{}{}[REDACTED]", &c["key"], &c["sep"], &c["q"])
            })
            .into_owned();
        report.assignments += assign_hits;

        // 5. Emails — credential-adjacent, always on.
        let email_hits = self.email.find_iter(&s).count();
        if email_hits > 0 {
            s = self.email.replace_all(&s, "[REDACTED_EMAIL]").into_owned();
            report.emails += email_hits;
        }

        // 6. PII — opt-in.
        if cfg.pii {
            let mut pii_hits = 0usize;
            for (re, ph) in [
                (&self.ssn, "[REDACTED_SSN]"),
                (&self.credit_card, "[REDACTED_CC]"),
                (&self.phone, "[REDACTED_PHONE]"),
            ] {
                let hits = re.find_iter(&s).count();
                if hits > 0 {
                    s = re.replace_all(&s, ph).into_owned();
                    pii_hits += hits;
                }
            }
            report.pii += pii_hits;
        }

        // 7. Bare IPv4 — opt-in, with octet validation + private-range gate.
        if cfg.redact_ips {
            let redact_private = cfg.redact_private_ips;
            let mut ip_hits = 0usize;
            s = self
                .ipv4
                .replace_all(&s, |c: &Captures| {
                    let octets = ["a", "b", "c", "d"].map(|k| c[k].parse::<u32>().unwrap_or(999));
                    let whole = c.get(0).map(|m| m.as_str().to_string()).unwrap_or_default();
                    // Any octet >255 → not an IP (version string, build id). Leave it.
                    if octets.iter().any(|&o| o > 255) {
                        return whole;
                    }
                    if !redact_private && is_private(octets) {
                        return whole;
                    }
                    ip_hits += 1;
                    "[REDACTED_IP]".to_string()
                })
                .into_owned();
            report.ips += ip_hits;
        }

        s
    }
}

impl Default for PatternSet {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether an IPv4 falls in a private / loopback / link-local / CGNAT range —
/// the addresses that are common in dev configs and aren't sensitive, so the
/// default IP redaction leaves them alone.
fn is_private(o: [u32; 4]) -> bool {
    match o {
        [10, _, _, _] => true,                       // 10.0.0.0/8
        [127, _, _, _] => true,                      // loopback
        [169, 254, _, _] => true,                    // link-local
        [192, 168, _, _] => true,                    // 192.168.0.0/16
        [172, b, _, _] if (16..=31).contains(&b) => true, // 172.16.0.0/12
        [100, b, _, _] if (64..=127).contains(&b) => true, // CGNAT 100.64.0.0/10
        [0, _, _, _] => true,                        // "this network"
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CustomRule, RedactionConfig};

    fn run(text: &str, cfg: &RedactionConfig) -> (String, RedactionReport) {
        let ps = PatternSet::new();
        let mut rep = RedactionReport::default();
        let out = ps.scrub(text, cfg, &mut rep);
        (out, rep)
    }

    #[test]
    fn redacts_github_and_anthropic_tokens() {
        let cfg = RedactionConfig::default();
        let (out, rep) = run(
            "gh=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 an=sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
            &cfg,
        );
        assert!(!out.contains("ghp_aBcD"), "{out}");
        assert!(!out.contains("sk-ant-api03"), "{out}");
        assert_eq!(rep.tokens, 2);
    }

    #[test]
    fn keeps_uri_structure_drops_password() {
        let cfg = RedactionConfig::default();
        let (out, rep) =
            run("DATABASE_URL=postgres://app:s3cr3tP4ss@db.example.com:5432/prod", &cfg);
        assert!(out.contains("postgres://app:[REDACTED]@"), "{out}");
        assert!(!out.contains("s3cr3tP4ss"), "{out}");
        assert_eq!(rep.credentialed_uris, 1);
    }

    #[test]
    fn keeps_key_redacts_assignment_value() {
        let cfg = RedactionConfig::default();
        let (out, _) = run(r#"api_key = "Zm9vYmFyYmF6cXV4MTIzNA=="#, &cfg);
        assert!(out.contains("api_key"), "{out}");
        assert!(out.contains("[REDACTED]"), "{out}");
        assert!(!out.contains("Zm9vYmFy"), "{out}");
    }

    #[test]
    fn redacts_pem_block() {
        let cfg = RedactionConfig::default();
        let pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
        let (out, rep) = run(pem, &cfg);
        assert_eq!(out, "[REDACTED_PRIVATE_KEY]");
        assert_eq!(rep.private_keys, 1);
    }

    #[test]
    fn ip_off_by_default_on_under_strict() {
        let public = "Edge at 203.0.113.41 here";
        let (out_def, _) = run(public, &RedactionConfig::default());
        assert!(out_def.contains("203.0.113.41"), "default keeps IPs: {out_def}");

        let (out_strict, rep) = run(public, &RedactionConfig::strict());
        assert!(out_strict.contains("[REDACTED_IP]"), "strict redacts: {out_strict}");
        assert_eq!(rep.ips, 1);
    }

    #[test]
    fn strict_keeps_private_ip() {
        // strict() redacts IPs but leaves private ranges (redact_private_ips off).
        let (out, _) = run("local 192.168.1.10 and loop 127.0.0.1", &RedactionConfig::strict());
        assert!(out.contains("192.168.1.10"), "private kept: {out}");
        assert!(out.contains("127.0.0.1"), "loopback kept: {out}");
    }

    #[test]
    fn version_string_is_not_an_ip() {
        // strict turns IP redaction on; a 4-part version with an octet >255
        // must not be mistaken for an address.
        let (out, _) = run("aura 1.300.0.1 released", &RedactionConfig::strict());
        assert!(out.contains("1.300.0.1"), "version kept: {out}");
    }

    #[test]
    fn custom_rule_outranks_generics() {
        let cfg = RedactionConfig::default()
            .add_rule(CustomRule::new("internal", r"INT-[0-9]{6}", "[REDACTED_INTERNAL]").unwrap());
        let (out, rep) = run("ref INT-123456 done", &cfg);
        assert!(out.contains("[REDACTED_INTERNAL]"), "{out}");
        assert_eq!(rep.custom, 1);
    }

    #[test]
    fn pii_gated_off_by_default() {
        let ssn = "ssn 123-45-6789";
        let (out_def, _) = run(ssn, &RedactionConfig::default());
        assert!(out_def.contains("123-45-6789"), "default keeps PII: {out_def}");
        let (out_pii, rep) = run(ssn, &RedactionConfig::default().with_pii(true));
        assert!(out_pii.contains("[REDACTED_SSN]"), "{out_pii}");
        assert_eq!(rep.pii, 1);
    }
}
