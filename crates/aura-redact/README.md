# aura-redact

[![Crates.io](https://img.shields.io/crates/v/aura-redact.svg)](https://crates.io/crates/aura-redact)
[![docs.rs](https://docs.rs/aura-redact/badge.svg)](https://docs.rs/aura-redact)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Always-on secret & PII scrubber.** A pattern pass catches 20+ known
credential shapes by name, then a Shannon-entropy pass catches the random keys
that have no recognisable prefix — with a guard so it doesn't eat your git SHAs.

```toml
[dependencies]
aura-redact = "0.2"
```

## Why

Pure regex scanners miss random tokens that match no known prefix. Pure entropy
scanners flag commit hashes, UUIDs, and long identifiers. `aura-redact` runs
both, in order: the pattern pass claims the obvious credentials (`ghp_…`,
`sk-ant-…`, AWS `AKIA…`, JWTs, PEM blocks, `user:pass@host` URIs, emails), and
the entropy pass sweeps up the rest — while a mixed-character guard spares the
high-entropy strings that legitimately live in source.

It's the last line of defence before text leaves the machine: LLM prompts and
transcripts, error trackers, telemetry, support bundles, agent handovers.

## Quick start

```rust
use aura_redact::Redactor;

let dirty = "
    Auth:  ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789
    From:  alice@example.com
    DB:    postgres://app:s3cr3tP4ss@db.example.com:5432/prod
    Token: sk-ant-api03-kJ8s2nF3lPq9wXvB7tYzM5cR1aH4dGuEi6oN
";

println!("{}", Redactor::scrub(dirty));
```

```
    Auth:  [REDACTED_TOKEN]
    From:  [REDACTED_EMAIL]
    DB:    postgres://app:[REDACTED]@db.example.com:5432/prod
    Token: [REDACTED_TOKEN]
```

Note the URI keeps its scheme, user, and host — only the password is removed —
so the line stays legible.

## Two profiles

The **default** profile is conservative: safe to run on arbitrary source and
prose. It redacts credentials and high-entropy secrets but leaves bare IPs,
version strings, git SHAs, and personal data alone.

The **strict** profile is the send-nothing-sensitive-off-box profile: it also
redacts IPs (public ranges) and PII, lowers the entropy bar, and drops the
mixed-character guard.

```rust
use aura_redact::{Redactor, RedactionConfig};

let r = Redactor::with_config(RedactionConfig::strict());
let report = r.report("ssh root@8.8.8.8, key AKIAIOSFODNN7EXAMPLE");

println!("{}", report.text);     // → ssh root@[REDACTED_IP], key [REDACTED_AWS_KEY]
println!("{}", report.total());  // → 2  (1 ip + 1 token)
```

`report()` returns a `RedactionReport` with per-category counts (`emails`,
`tokens`, `private_keys`, `ips`, `high_entropy`, …) plus the scrubbed `text`,
so you can log "scrubbed N secrets before sync" or assert nothing leaked.

## Custom rule-packs

Scrub house-specific secret shapes the built-ins don't know about:

```rust
use aura_redact::{Redactor, RedactionConfig, CustomRule};

let cfg = RedactionConfig::default()
    .add_rule(CustomRule::new("internal-id", r"INT-[0-9]{6}", "[REDACTED_INTERNAL]")?);

let clean = Redactor::with_config(cfg).run("ticket INT-481509");
// → ticket [REDACTED_INTERNAL]
```

Custom rules run first, so a house rule outranks the generic patterns.

## What it catches

| Category | Method | Default |
|----------|--------|---------|
| Emails | pattern | ✅ on |
| GitHub / GitLab / npm tokens (`ghp_…`, `glpat-…`, `npm_…`) | pattern | ✅ on |
| Cloud keys — AWS `AKIA`/`ASIA`, Google `AIza`, Stripe `sk_live_…` | pattern | ✅ on |
| Slack tokens (`xox…`) + incoming webhooks | pattern | ✅ on |
| Anthropic / OpenAI `sk-…`, SendGrid `SG.…`, JWTs | pattern | ✅ on |
| PEM private-key blocks | pattern | ✅ on |
| Credentialed URIs (`scheme://user:pass@host`) | pattern (password only) | ✅ on |
| `password = …` / `secret: …` assignments | pattern (value only) | ✅ on |
| Random / base64 / hex keys with no prefix | Shannon entropy | ✅ on |
| Bare IPv4 (public ranges) | pattern | ⚪ strict / opt-in |
| PII — SSN, credit card, phone | pattern | ⚪ strict / opt-in |
| git SHAs, UUIDs, long identifiers, normal English | **preserved** | — |

## Entropy guard

The entropy pass defaults to **4.5 bits/char over a 20-char floor**, and
requires a token to mix character classes (a letter *and* a digit or symbol)
before redacting. A 40-char lowercase hex git SHA sits near 4.0 and is all one
class, so it survives the default profile — exactly the false positive that
makes naïve entropy scanners unusable on real repos. The strict profile drops
the guard and the floor to catch all-hex and all-alpha blobs too.

## Origin

Extracted from [Aura](https://auravcs.com) — the semantic version control
engine for AI-generated code. Aura runs `aura-redact` on every payload before it
forwards source-derived strings to external LLM APIs or syncs them off-box.

## License

Apache-2.0
