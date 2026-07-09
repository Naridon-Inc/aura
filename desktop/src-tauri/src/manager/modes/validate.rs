//! Mode YAML validator — runs on every `modes_install_from_url`,
//! `modes_edit`, and pre-bundle load. Validation is deliberately strict:
//! a malformed mode at install time is an unrecoverable user-facing
//! surface (the marketplace can't ship broken modes and have the picker
//! crash), so we reject early and tell the user exactly which field
//! tripped the check.
//!
//! Two halves:
//!
//! 1. `validate(yaml)` parses the bytes via `serde_yaml` and runs a
//!    pipeline of checks (schema_version, slug format, tool whitelist,
//!    prompt size, MCP command sanitization). Returns either the
//!    typed `Mode` or a `ValidationReport` with one error per failed
//!    check — the UI surfaces all of them at once so the user only
//!    needs one round-trip to fix things.
//!
//! 2. `CANONICAL_TOOLS` / `RESERVED_TOOLS` / `sanitize_command` are the
//!    security primitives. The canonical whitelist is the closed set
//!    of tool ids modes can reference; anything outside is silently
//!    dropped after a warning. `RESERVED_TOOLS` is the subset that
//!    requires the advanced gate at install time. `sanitize_command`
//!    is the MCP bundle escape hatch — strips shell metacharacters so
//!    a malicious mode YAML can't `;rm -rf /` via mcp_bundle entries.

use serde::Serialize;

use super::schema::{MODE_SCHEMA_VERSION, Mode};

/// Closed set of tool ids the canonical aura runtime understands. Modes
/// can reference these in `tool_acl.allow` / `deny` / `advanced`; the
/// validator drops anything outside this set with a warning. New tools
/// flow in here once the runtime grows support for them.
pub const CANONICAL_TOOLS: &[&str] = &[
    // Filesystem — universally enabled, no advanced gate.
    "fs.read",
    "fs.write",
    "fs.find",
    "fs.grep",
    "fs.delete",
    // Git surface — read by default, mutations gated.
    "git.status",
    "git.diff",
    "git.log",
    "git.commit",
    "git.branch",
    // Aura semantic surface — read-only by default.
    "aura.status",
    "aura.prove",
    "aura.pr_review",
    "aura.rewind",
    "aura.snapshot",
    "aura.log_intent",
    // Shell + network — always advanced; require explicit opt-in.
    "shell.exec",
    "shell.spawn",
    "net.fetch",
    // Editor surface — drives the workpane (open file, jump, select).
    "editor.open",
    "editor.select",
    "editor.diagnostics",
    // Chat / coordination.
    "chat.ask_user",
    "chat.summarize",
    // MCP bridge — any installed MCP server is reachable via this
    // single canonical id; the server name is passed as an arg.
    "mcp.invoke",
];

/// Tools that ALWAYS require the advanced gate at install time, even
/// when the mode YAML doesn't put them in `tool_acl.advanced`. The
/// install sheet surfaces a "this mode wants shell access" banner and
/// makes the user tick a checkbox before proceeding. Keep this list
/// short — it's a UX speed-bump and shouldn't gate routine tools.
pub const RESERVED_TOOLS: &[&str] = &[
    "shell.exec",
    "shell.spawn",
    "net.fetch",
    "fs.delete",
    "git.commit",
];

/// Soft cap on `system_prompt` length. Anything beyond this is almost
/// certainly a mistake (token budget aside, the picker chip preview
/// would be unreadable). The validator rejects with `prompt_too_large`.
pub const MAX_PROMPT_CHARS: usize = 32_000;

/// Soft cap on `description` length. Marketplace cards need room.
pub const MAX_DESCRIPTION_CHARS: usize = 2_000;

/// One validation problem. `field` is the dotted path inside the YAML
/// (`tool_acl.allow[2]`); `message` is a one-line, user-facing string.
/// `level` distinguishes hard errors (parse rejects) from warnings
/// (silently dropped fields).
#[derive(Debug, Clone, Serialize)]
pub struct ValidationIssue {
    pub level: IssueLevel,
    pub field: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueLevel {
    Error,
    Warning,
}

/// Aggregate result of one validate() call. `mode` is `Some` ONLY when
/// `issues` contains no `Error`s; warnings don't block the parse and
/// the cleaned-up `Mode` is returned alongside them so the UI can
/// render both.
#[derive(Debug, Clone, Serialize)]
pub struct ValidationReport {
    pub ok: bool,
    pub issues: Vec<ValidationIssue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<Mode>,
}

impl ValidationReport {
    fn err(field: &str, message: impl Into<String>) -> ValidationIssue {
        ValidationIssue {
            level: IssueLevel::Error,
            field: field.into(),
            message: message.into(),
        }
    }
    fn warn(field: &str, message: impl Into<String>) -> ValidationIssue {
        ValidationIssue {
            level: IssueLevel::Warning,
            field: field.into(),
            message: message.into(),
        }
    }

    fn has_errors(&self) -> bool {
        self.issues.iter().any(|i| i.level == IssueLevel::Error)
    }
}

/// Parse + validate a YAML payload. Returns the typed `Mode` on success
/// (possibly with warnings) or a populated `ValidationReport.issues` on
/// hard failure. Never panics — every parse error and bounds check
/// converts to a structured issue so the UI can render them in a list.
pub fn validate(yaml: &str) -> ValidationReport {
    let mut issues: Vec<ValidationIssue> = Vec::new();

    let parsed: Result<Mode, _> = serde_yaml::from_str(yaml);
    let mut mode = match parsed {
        Ok(m) => m,
        Err(e) => {
            issues.push(ValidationReport::err("$root", format!("invalid YAML: {e}")));
            return ValidationReport {
                ok: false,
                issues,
                mode: None,
            };
        }
    };

    // schema_version — strict equality. Future variants migrate up
    // before we hit this check.
    if mode.schema_version != MODE_SCHEMA_VERSION {
        issues.push(ValidationReport::err(
            "schema_version",
            format!(
                "expected {}, found {} — re-export the mode from a newer aura",
                MODE_SCHEMA_VERSION, mode.schema_version
            ),
        ));
    }

    // id — lowercase kebab-case, [a-z0-9-_], 1..=64 chars.
    if mode.id.is_empty() {
        issues.push(ValidationReport::err("id", "id must be non-empty"));
    } else if mode.id.len() > 64 {
        issues.push(ValidationReport::err(
            "id",
            "id too long — max 64 chars",
        ));
    } else if !mode
        .id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        issues.push(ValidationReport::err(
            "id",
            "id must be lowercase alphanumeric + `-`/`_`",
        ));
    }

    // display_name — non-empty, capped.
    if mode.display_name.trim().is_empty() {
        issues.push(ValidationReport::err(
            "display_name",
            "display_name must be non-empty",
        ));
    } else if mode.display_name.len() > 128 {
        issues.push(ValidationReport::warn(
            "display_name",
            "display_name >128 chars — picker chip will truncate",
        ));
    }

    // description — capped (warn rather than reject).
    if mode.description.len() > MAX_DESCRIPTION_CHARS {
        issues.push(ValidationReport::warn(
            "description",
            format!(
                "description >{} chars — marketplace card will truncate",
                MAX_DESCRIPTION_CHARS
            ),
        ));
    }

    // system_prompt — non-empty + capped.
    if mode.system_prompt.trim().is_empty() {
        issues.push(ValidationReport::err(
            "system_prompt",
            "system_prompt must be non-empty",
        ));
    } else if mode.system_prompt.len() > MAX_PROMPT_CHARS {
        issues.push(ValidationReport::err(
            "system_prompt",
            format!(
                "system_prompt >{} chars — split into a /skill or trim",
                MAX_PROMPT_CHARS
            ),
        ));
    }

    // tool_acl — drop anything not in CANONICAL_TOOLS, warn rather
    // than reject. The intent is forward-compatible YAMLs (a mode
    // referencing a new tool we haven't shipped yet still loads).
    let drop_unknown = |list: &mut Vec<String>, field: &str, issues: &mut Vec<ValidationIssue>| {
        let mut kept = Vec::with_capacity(list.len());
        for (i, t) in list.iter().enumerate() {
            if CANONICAL_TOOLS.contains(&t.as_str()) {
                kept.push(t.clone());
            } else {
                issues.push(ValidationReport::warn(
                    &format!("tool_acl.{field}[{i}]"),
                    format!("unknown tool `{t}` — dropped"),
                ));
            }
        }
        *list = kept;
    };
    drop_unknown(&mut mode.tool_acl.allow, "allow", &mut issues);
    drop_unknown(&mut mode.tool_acl.deny, "deny", &mut issues);
    drop_unknown(&mut mode.tool_acl.advanced, "advanced", &mut issues);

    // mcp_bundle — sanitize each entry. The bundle is a list of MCP
    // server NAMES, not commands; we still strip metacharacters in case
    // the user pastes a full command line by mistake.
    for (i, name) in mode.mcp_bundle.iter_mut().enumerate() {
        let cleaned = sanitize_command(name);
        if cleaned != *name {
            issues.push(ValidationReport::warn(
                &format!("mcp_bundle[{i}]"),
                "stripped shell metacharacters from mcp_bundle entry",
            ));
            *name = cleaned;
        }
    }

    let mut report = ValidationReport {
        ok: true,
        issues,
        mode: None,
    };
    let bad = report.has_errors();
    report.ok = !bad;
    if !bad {
        report.mode = Some(mode);
    }
    report
}

/// Strip shell metacharacters from a string. Used on MCP bundle entries
/// and on any place a mode YAML can influence a subprocess argument.
/// Whitelist approach — keep alphanumerics, `-`, `_`, `.`, `/`, `:`,
/// `@`. Everything else gets dropped.
pub fn sanitize_command(input: &str) -> String {
    input
        .chars()
        .filter(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '-' | '_' | '.' | '/' | ':' | '@')
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_yaml() -> String {
        format!(
            r#"
schema_version: {ver}
id: smoke
display_name: Smoke
description: test
author: tests
tags: [test]
system_prompt: be helpful
tool_acl:
  allow: [fs.read]
  deny: []
  advanced: []
"#,
            ver = MODE_SCHEMA_VERSION
        )
    }

    #[test]
    fn validate_accepts_minimal() {
        let r = validate(&minimal_yaml());
        assert!(r.ok, "issues: {:?}", r.issues);
        assert!(r.mode.is_some());
    }

    #[test]
    fn validate_rejects_wrong_schema_version() {
        let bad = minimal_yaml().replace(
            &format!("schema_version: {}", MODE_SCHEMA_VERSION),
            "schema_version: 99",
        );
        let r = validate(&bad);
        assert!(!r.ok);
        assert!(r.issues.iter().any(|i| i.field == "schema_version"));
    }

    #[test]
    fn validate_drops_unknown_tools_with_warning() {
        let yaml = minimal_yaml().replace(
            "allow: [fs.read]",
            "allow: [fs.read, not.a.tool]",
        );
        let r = validate(&yaml);
        assert!(r.ok, "issues: {:?}", r.issues);
        let m = r.mode.unwrap();
        assert_eq!(m.tool_acl.allow, vec!["fs.read".to_string()]);
        assert!(r
            .issues
            .iter()
            .any(|i| i.level == IssueLevel::Warning && i.field.starts_with("tool_acl.allow")));
    }

    #[test]
    fn validate_rejects_empty_prompt() {
        let yaml = minimal_yaml().replace("system_prompt: be helpful", "system_prompt: \"\"");
        let r = validate(&yaml);
        assert!(!r.ok);
        assert!(r.issues.iter().any(|i| i.field == "system_prompt"));
    }

    #[test]
    fn sanitize_command_strips_metachars() {
        assert_eq!(sanitize_command("atlassian"), "atlassian");
        assert_eq!(sanitize_command("rm -rf /;evil"), "rm-rf/evil");
        assert_eq!(sanitize_command("npx @scope/pkg"), "npx@scope/pkg");
    }

    #[test]
    fn reserved_tools_is_subset_of_canonical() {
        for t in RESERVED_TOOLS {
            assert!(
                CANONICAL_TOOLS.contains(t),
                "RESERVED_TOOLS contains `{t}` which isn't in CANONICAL_TOOLS",
            );
        }
    }
}
