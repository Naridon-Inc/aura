//! Secret redaction for cross-agent carryover.
//!
//! A carryover bundles the intent log, transcript tail, project memory,
//! and working-tree paths — any of which can carry a credential a human
//! pasted into chat, an env value captured in memory, or a server IP.
//! Track A hands that payload to *external* agents (Gemini/Kimi/Codex
//! CLIs, possibly their clouds), so it MUST be scrubbed before it leaves
//! the box — the project's standing rule: never ship secrets off-box.
//!
//! This pass runs by default in every carryover path (defense in depth);
//! the local in-app brain-swap may opt out with `--no-redact`. It targets
//! well-known credential shapes (aligned with the Semantic Sentinel
//! vocabulary in `parser.rs`), PEM private-key blocks, `key=value`
//! assignments, and *public* IPv4 addresses (private ranges are left
//! intact so local code/config survives). Matches become
//! `[REDACTED:<kind>]`.

use std::net::Ipv4Addr;
use std::sync::OnceLock;

use regex::{Captures, Regex};

use super::model::*;

struct Pattern {
    kind: &'static str,
    re: Regex,
}

/// Token-shaped credential patterns, replaced whole. Order matters:
/// the more specific `sk-ant-` / PEM block must precede the broader
/// `sk-` rule so each match is tagged with its true kind.
fn token_patterns() -> &'static [Pattern] {
    static PATTERNS: OnceLock<Vec<Pattern>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let mk = |kind: &'static str, re: &str| Pattern {
            kind,
            re: Regex::new(re).expect("static redaction regex"),
        };
        vec![
            mk(
                "private-key",
                r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
            ),
            mk("anthropic-key", r"sk-ant-[A-Za-z0-9_\-]{20,}"),
            mk("api-key", r"sk-[A-Za-z0-9]{20,}"),
            mk("github-token", r"gh[posru]_[A-Za-z0-9]{20,}"),
            mk("github-token", r"github_pat_[A-Za-z0-9_]{20,}"),
            mk("google-key", r"AIza[0-9A-Za-z_\-]{35}"),
            mk("aws-key", r"AKIA[0-9A-Z]{16}"),
            mk("slack-token", r"xox[baprs]-[A-Za-z0-9\-]{10,}"),
            mk("bearer", r"(?i)bearer\s+[A-Za-z0-9._\-]{20,}"),
        ]
    })
}

/// `api_key = "…"` / `password: '…'` style assignments. Group 1 is the
/// key + operator (kept); the value is redacted. Conservative on the
/// value (≥8 non-space chars) but biased toward over-redaction, since a
/// leaked secret is far worse than a redacted doc string.
fn assignment_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)((?:api[_-]?key|secret|passwd|password|access[_-]?token|auth[_-]?token|token)\s*["']?\s*[:=]\s*["']?)([^"'\s]{8,})"#,
        )
        .expect("static assignment regex")
    })
}

fn ipv4_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b").expect("static ipv4 regex"))
}

/// True when a path's *filename* announces a secret store — SSH/TLS keys,
/// env files, credential bundles. The carryover only carries paths+stats
/// (contents are caught by the PEM/token rules), but the inventory itself
/// must not advertise "here is the private key." Matches the basename so
/// `deploy/keys/id_ed25519` and `.env.production` are both caught.
fn is_sensitive_filename(path: &str) -> bool {
    let base = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase();
    // Exact private-key / credential-store names.
    const EXACT: [&str; 8] = [
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
        ".netrc",
        ".pgpass",
        ".npmrc",
        ".htpasswd",
    ];
    if EXACT.contains(&base.as_str()) {
        return true;
    }
    // Secret-bearing extensions.
    const EXT: [&str; 6] = [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"];
    if EXT.iter().any(|e| base.ends_with(e)) {
        return true;
    }
    // .env and any .env.<variant> (but not e.g. "prevent.txt").
    if base == ".env" || base.starts_with(".env.") {
        return true;
    }
    // Anything that names itself a credential/secret store.
    base.contains("credentials") || base.contains("secret")
}

/// Public = routable on the internet. Private/loopback/link-local/etc.
/// addresses are kept so local dev config (127.0.0.1, 192.168.x) stays
/// readable in the carryover.
fn is_public_v4(ip: &Ipv4Addr) -> bool {
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || ip.octets()[0] == 0)
}

/// Redact every known secret shape from a single string.
pub fn redact_text(input: &str) -> String {
    let mut out = input.to_string();
    for p in token_patterns() {
        if p.re.is_match(&out) {
            out = p
                .re
                .replace_all(&out, format!("[REDACTED:{}]", p.kind).as_str())
                .into_owned();
        }
    }
    out = assignment_re()
        .replace_all(&out, |c: &Captures| format!("{}[REDACTED:secret]", &c[1]))
        .into_owned();
    out = ipv4_re()
        .replace_all(&out, |c: &Captures| {
            let m = &c[0];
            match m.parse::<Ipv4Addr>() {
                Ok(ip) if is_public_v4(&ip) => "[REDACTED:ip]".to_string(),
                _ => m.to_string(),
            }
        })
        .into_owned();
    out
}

fn redact_opt(s: &mut Option<String>) {
    if let Some(v) = s.as_mut() {
        *v = redact_text(v);
    }
}

fn redact_vec(v: &mut [String]) {
    for s in v.iter_mut() {
        *s = redact_text(s);
    }
}

/// Walk a JSON value and redact every string leaf in place (keys are
/// left alone — only values can carry a secret).
fn redact_json(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::String(s) => *s = redact_text(s),
        serde_json::Value::Array(items) => items.iter_mut().for_each(redact_json),
        serde_json::Value::Object(map) => map.values_mut().for_each(redact_json),
        _ => {}
    }
}

/// Scrub every free-text field of an assembled carryover. Runs over
/// fields present in *both* modes (intent text, memory) — not just the
/// transcript — because memory and intents can carry secrets regardless
/// of how much conversation rides along.
pub fn redact_carryover(c: &mut AuraCarryover) {
    if let Some(sess) = c.session.as_mut() {
        redact_opt(&mut sess.first_prompt);
        if let Some(sum) = sess.summary.as_mut() {
            sum.intent = redact_text(&sum.intent);
            sum.outcome = redact_text(&sum.outcome);
            redact_vec(&mut sum.open_items);
            redact_vec(&mut sum.learnings);
        }
    }
    for it in c.intents.iter_mut() {
        it.intent = redact_text(&it.intent);
    }
    for n in c.touched_nodes.iter_mut() {
        n.intent = redact_text(&n.intent);
        redact_opt(&mut n.signature);
    }
    for f in c.working_tree.files.iter_mut() {
        if is_sensitive_filename(&f.path) {
            f.path = "[REDACTED:sensitive-file]".to_string();
        } else {
            f.path = redact_text(&f.path);
        }
    }
    if let Some(mem) = c.memory.as_mut() {
        redact_json(mem);
    }
    for t in c.recent_turns.iter_mut() {
        t.text = redact_text(&t.text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_known_credential_shapes() {
        let s = "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz0123";
        let r = redact_text(s);
        assert!(r.contains("[REDACTED:anthropic-key]"));
        assert!(r.contains("[REDACTED:github-token]"));
        assert!(!r.contains("sk-ant-api03"));
        assert!(!r.contains("ghp_abc"));
    }

    #[test]
    fn redacts_public_ip_keeps_private() {
        let r = redact_text("prod is 51.102.104.41 but local is 192.168.1.10 and 127.0.0.1");
        assert!(r.contains("[REDACTED:ip]"));
        assert!(r.contains("192.168.1.10"), "private IP must survive");
        assert!(r.contains("127.0.0.1"), "loopback must survive");
        assert!(!r.contains("51.102.104.41"));
    }

    #[test]
    fn redacts_assignment_values() {
        let r = redact_text(r#"API_KEY="supersecretvalue123" remains"#);
        assert!(r.contains("[REDACTED:secret]"));
        assert!(!r.contains("supersecretvalue123"));
    }

    #[test]
    fn leaves_clean_text_untouched() {
        let clean = "Refactored authenticate() to use exponential backoff.";
        assert_eq!(redact_text(clean), clean);
    }

    #[test]
    fn flags_secret_bearing_filenames() {
        assert!(is_sensitive_filename("deploy/keys/id_ed25519"));
        assert!(is_sensitive_filename(".env.production"));
        assert!(is_sensitive_filename("certs/server.pem"));
        assert!(is_sensitive_filename("aws_credentials.json"));
        assert!(is_sensitive_filename(".npmrc"));
        // Ordinary source paths survive the inventory untouched.
        assert!(!is_sensitive_filename("src/auth.rs"));
        assert!(!is_sensitive_filename("docs/prevent.md"));
        assert!(!is_sensitive_filename("README.md"));
    }
}
