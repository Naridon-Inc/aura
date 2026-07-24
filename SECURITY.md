# Security Policy

Aura is a Git-native intelligence layer for AI coding agents, built in Rust and
released under the Apache 2.0 license. We take the security of Aura — and of the
projects that depend on it — seriously. This document explains which versions we
support, how to report a vulnerability, and what you can expect in return.

## Supported Versions

Aura is pre-1.0 and ships frequently. Security fixes land on the latest released
version; we do not backport fixes to older point releases. Before reporting an
issue, please upgrade to the latest release and confirm it still reproduces there.

| Version | Supported |
|---|---|
| Latest released version (current 0.19.x minor line as of writing) | ✅ |
| Older releases | ❌ — please upgrade to the latest release |

Install or upgrade with:

```bash
curl -fsSL https://auravcs.com/install.sh | bash
```

You can check your installed version with `aura --version`.

## Reporting a Vulnerability

**Please report security issues privately. Do not open a public GitHub issue,
pull request, or discussion for a suspected vulnerability.**

The primary channel is GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (under **Security advisories**).
3. Fill in the advisory form.

This opens a private advisory visible only to you and the maintainers — no email
account or PGP key is required. If you cannot use GitHub's private reporting, the
maintainers can also be reached by opening a draft security advisory through the
same Security tab.

### What to include

A good report helps us confirm and fix the issue quickly. Where possible, include:

- A clear description of the vulnerability and its impact.
- The affected component (the CLI, a specific crate, the desktop app, the MCP
  server, or the Git hooks).
- The Aura version (`aura --version`) and your OS/platform.
- Step-by-step instructions to reproduce, ideally with a minimal example repo or
  command sequence.
- Any proof-of-concept, logs, or stack traces.
- Your assessment of severity and a suggested remediation, if you have one.

## Scope

**In scope** — the open-source Aura project:

- The `aura` CLI.
- The Rust crates in this repository.
- The desktop application.
- The MCP server and the tools it exposes.
- The Git hooks Aura installs via `aura enable`.

Examples of issues we especially want to hear about: a Git hook that can be
tricked into running attacker-controlled code, the MCP server exposing data or
actions it should not, secret-scanning that can be bypassed, the deletion guard
or intent verification being silently defeated, or memory-safety bugs in the
crates.

**Out of scope:**

- The hosted service at auravcs.com and its infrastructure. It is not part of
  this open-source repository; please report those issues through a channel for
  the hosted service if you have one.
- Vulnerabilities in third-party dependencies — please report those to the
  upstream project. If a dependency issue affects Aura specifically, we still
  want to know.
- Social engineering of maintainers or users.
- Physical attacks, and attacks that require an already-compromised host or
  operating system.
- Reports produced solely by automated scanners with no demonstrated impact.
- Missing hardening that is not itself exploitable. Best-practice suggestions are
  welcome as ordinary issues rather than security reports.

## What to Expect

The following are good-faith targets, not contractual guarantees:

- **Acknowledgement** within a few business days.
- **Updates** as we investigate — we will keep you posted on our assessment and
  progress.
- **Coordinated disclosure** — we will work with you on a fix and a disclosure
  timeline, and credit you in the advisory unless you would rather remain
  anonymous.

Aura is maintained by a small team, so complex issues may take longer to resolve.
We appreciate your patience.

## Safe Harbor

We support good-faith security research. If you make a sincere effort to follow
this policy, we will consider your research authorized, will not pursue or support
legal action against you for it, and will work with you to understand and resolve
the issue quickly.

To stay within good faith:

- Only test against your own installations and repositories — never against other
  users or the hosted service.
- Do not access, modify, or delete data that is not yours.
- Avoid privacy violations, service disruption, and destruction of data.
- Give us a reasonable amount of time to fix the issue before disclosing it
  publicly.

Thank you for helping keep Aura and its users safe.
