//! Taking credentials out of a conversation before it leaves the machine.
//!
//! A session's transcript travels to the console so the team can read what
//! was asked and what was done. Its tool results are whatever the agent ran:
//! `cat .env`, `printenv`, a `curl` with a bearer header, a config file read
//! to debug a deploy. Every one of those is a credential printed in plain
//! text, and once it is in `session_messages` it is readable by everyone in
//! the org who can open the session, and sits in every backup of the database.
//!
//! So each turn is scrubbed of the shapes credentials have: provider key
//! prefixes, private-key blocks, JWTs, the password in a connection URL, and
//! `NAME=value` lines whose name says it is a secret. A match becomes
//! `[REDACTED:<kind>]`, so a reader can still see that a key was there.
//!
//! It is deliberately narrower than the carryover redactor
//! (`continuity::redact`): code shown in a tool result must stay readable, so
//! `let token = mint_token();` is left alone and only literal values in env
//! files, quoted config and command lines are taken. Public IPs are kept too;
//! they are not credentials, and inside one org's transcript they are often
//! the subject of the work.
//!
//! The same file is compiled into `aura-cloud`, which runs it again on ingest
//! for clients that predate it. A test there holds the two copies together.

use std::sync::OnceLock;

use regex::{Captures, Regex};

struct Shape {
    kind: &'static str,
    re: Regex,
}

/// Whole-token shapes, replaced entirely. More specific shapes come first so
/// each match is named for what it really is.
fn shapes() -> &'static [Shape] {
    static SHAPES: OnceLock<Vec<Shape>> = OnceLock::new();
    SHAPES.get_or_init(|| {
        let mk = |kind: &'static str, re: &str| Shape { kind, re: Regex::new(re).expect("static scrub regex") };
        vec![
            mk(
                "private-key",
                r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
            ),
            mk("anthropic-key", r"sk-ant-[A-Za-z0-9_\-]{20,}"),
            mk("stripe-key", r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}"),
            mk("stripe-webhook-secret", r"\bwhsec_[A-Za-z0-9]{16,}"),
            mk("api-key", r"\bsk-[A-Za-z0-9_\-]{20,}"),
            mk("github-token", r"\bgh[posru]_[A-Za-z0-9]{20,}"),
            mk("github-token", r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
            mk("gitlab-token", r"\bglpat-[A-Za-z0-9_\-]{20,}"),
            mk("google-key", r"\bAIza[0-9A-Za-z_\-]{35}"),
            mk("aws-key", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
            mk("slack-token", r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"),
            mk("npm-token", r"\bnpm_[A-Za-z0-9]{36}\b"),
            mk("aura-token", r"\baura_(?:runner_|rt_|ticket_)?[0-9a-f]{32,}\b"),
            mk("jwt", r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),
            mk("bearer", r"(?i)\bbearer\s+[A-Za-z0-9._~+/\-]{20,}=*"),
        ]
    })
}

/// The password half of `scheme://user:password@host`. The user and host stay.
fn url_password() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"([A-Za-z][A-Za-z0-9+.\-]*://[^/\s:@]+:)([^@\s/]{3,})(@)").expect("static url regex")
    })
}

/// `STRIPE_SECRET_KEY=…`, `export DB_PASSWORD="…"`: an env-style name that
/// says it is a secret, then a literal value. Group 1 is kept.
fn env_assignment() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?m)((?:^|[\s;&|(])(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIALS?)[A-Z0-9_]*\s*=\s*["']?)([^"'\s$`(){}]{6,})"#,
        )
        .expect("static env regex")
    })
}

/// `"api_key": "…"` / `password: '…'` with a quoted literal value, as config
/// files and JSON print them. Group 1 and 3 are kept.
fn quoted_assignment() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)(["']?[a-z0-9_\-]*(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*)(["'])([^"'\s]{8,})(["'])"#,
        )
        .expect("static quoted regex")
    })
}

/// `text` with every credential shape replaced by `[REDACTED:<kind>]`.
pub fn scrub(text: &str) -> String {
    let mut out = text.to_string();
    for s in shapes() {
        if s.re.is_match(&out) {
            out = s.re.replace_all(&out, format!("[REDACTED:{}]", s.kind).as_str()).into_owned();
        }
    }
    out = url_password().replace_all(&out, |c: &Captures| format!("{}[REDACTED:password]{}", &c[1], &c[3])).into_owned();
    out = env_assignment().replace_all(&out, |c: &Captures| format!("{}[REDACTED:secret]", &c[1])).into_owned();
    out = quoted_assignment()
        .replace_all(&out, |c: &Captures| format!("{}{}[REDACTED:secret]{}", &c[1], &c[2], &c[4]))
        .into_owned();
    out
}

#[cfg(test)]
mod tests {
    use super::scrub;

    #[test]
    fn provider_keys_are_taken_whole() {
        // Each fixture is built from two halves so no whole key-shaped literal
        // sits in the source for a secret scanner to stop a push over.
        let cases = [
            (concat!("sk-", "ant-api03-abcdefghijklmnopqrstuvwxyz0123"), "anthropic-key"),
            (concat!("sk_", "live_51HabcdefghijklmnopqrSTUV"), "stripe-key"),
            (concat!("rk_", "test_51HabcdefghijklmnopqrSTUV"), "stripe-key"),
            (concat!("whs", "ec_abcdefghijklmnopqrstuv"), "stripe-webhook-secret"),
            (concat!("sk-", "proj-abcdefghijklmnopqrstuvwx"), "api-key"),
            (concat!("ghp", "_abcdefghijklmnopqrstuvwxyz012345"), "github-token"),
            (concat!("git", "hub_pat_11ABCDEFG0abcdefghijklmn"), "github-token"),
            (concat!("glp", "at-abcdefghijklmnopqrst"), "gitlab-token"),
            (concat!("AKI", "AABCDEFGHIJKLMNOP"), "aws-key"),
            (concat!("xox", "b-1234567890-abcdef"), "slack-token"),
            (concat!("npm", "_abcdefghijklmnopqrstuvwxyz0123456789"), "npm-token"),
            ("aura_runner_0123456789abcdef0123456789abcdef0123456789abcdef", "aura-token"),
            ("aura_0123456789abcdef0123456789abcdef0123456789abcdef", "aura-token"),
            ("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "jwt"),
        ];
        for (secret, kind) in cases {
            let said = scrub(&format!("the value is {secret} ok"));
            assert_eq!(said, format!("the value is [REDACTED:{kind}] ok"), "{secret}");
        }
    }

    #[test]
    fn an_env_file_dump_keeps_its_names_and_loses_its_values() {
        let env = "DATABASE_HOST=db.internal\nSTRIPE_SECRET_KEY=abcdef123456\nexport GH_TOKEN=\"abcdef123456\"\nAPP_PASSWORD='hunter2hunter2'\nPORT=3000\n";
        let said = scrub(env);
        assert!(said.contains("DATABASE_HOST=db.internal"), "{said}");
        assert!(said.contains("STRIPE_SECRET_KEY=[REDACTED:secret]"), "{said}");
        assert!(said.contains("export GH_TOKEN=\"[REDACTED:secret]"), "{said}");
        assert!(said.contains("APP_PASSWORD='[REDACTED:secret]"), "{said}");
        assert!(said.contains("PORT=3000"));
        assert!(!said.contains("hunter2") && !said.contains("abcdef123456"), "{said}");
    }

    #[test]
    fn a_command_line_secret_is_taken_and_a_variable_reference_is_not() {
        let said = scrub("OPENAI_API_KEY=abcd1234efgh ./run.sh && echo $OPENAI_API_KEY");
        assert_eq!(said, "OPENAI_API_KEY=[REDACTED:secret] ./run.sh && echo $OPENAI_API_KEY");
        assert_eq!(scrub("API_TOKEN=$(cat token.txt)"), "API_TOKEN=$(cat token.txt)");
    }

    #[test]
    fn a_connection_url_keeps_its_user_and_host() {
        let said = scrub("postgres://aura:s3cretpass@db.example.com:5432/aura");
        assert_eq!(said, "postgres://aura:[REDACTED:password]@db.example.com:5432/aura");
    }

    #[test]
    fn quoted_config_values_go_and_code_stays_readable() {
        let said = scrub(r#"{"api_key": "abcdefgh12345678", "name": "aura"}"#);
        assert_eq!(said, r#"{"api_key": "[REDACTED:secret]", "name": "aura"}"#);
        for code in [
            "let token = mint_token(&state);",
            "fn password_hash(password: &str) -> String",
            "const TOKEN_TTL: u64 = 3600;",
            "if api_key.is_empty() { return; }",
            "see https://docs.example.com/path for details",
        ] {
            assert_eq!(scrub(code), code, "code must survive untouched");
        }
    }

    #[test]
    fn private_key_blocks_and_bearer_headers_go() {
        let pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
        assert_eq!(scrub(pem), "[REDACTED:private-key]");
        let said = scrub("curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012' https://api");
        assert_eq!(said, "curl -H 'Authorization: [REDACTED:bearer]' https://api");
    }

    #[test]
    fn plain_prose_is_untouched() {
        let prose = "I changed the retry to back off exponentially and the tests pass on 10.0.0.4.";
        assert_eq!(scrub(prose), prose);
    }
}
