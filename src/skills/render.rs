//! Render a [`SkillDef`] into the on-disk file an agent loads.
//!
//! Two output dialects:
//!   - [`SkillFormat::SkillMd`] — the portable Agent-Skills `SKILL.md`
//!     (YAML frontmatter `name` + `description`, then a markdown body).
//!     Used by Claude Code, Codex and Gemini, which all read the same
//!     spec.
//!   - [`SkillFormat::CursorMdc`] — Cursor's `.mdc` rule (frontmatter
//!     `description` + `alwaysApply`, then the same body). Cursor does not
//!     read the `name` key, so it is dropped.
//!
//! The body is built deterministically from the structured fields so the
//! two dialects stay in lockstep — only the frontmatter differs.

use super::catalog::SkillDef;

/// The on-disk dialect a target agent expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillFormat {
    /// Portable `SKILL.md` (Claude Code / Codex / Gemini).
    SkillMd,
    /// Cursor `.mdc` rule.
    CursorMdc,
}

/// Build the markdown body shared by every dialect: heading, when-to-use,
/// the runnable commands, and any notes. No frontmatter here.
fn render_body(skill: &SkillDef) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", skill.title));
    out.push_str(skill.when_to_use);
    out.push_str("\n\n## How to run\n\n");
    for ex in skill.usage {
        out.push_str(&format!("{}:\n\n```bash\n{}\n```\n\n", ex.label, ex.command));
    }
    if !skill.notes.is_empty() {
        out.push_str("## Notes\n\n");
        out.push_str(skill.notes);
        out.push('\n');
    }
    out
}

/// Escape a string for use as a double-quoted YAML scalar. The catalog
/// descriptions can contain `:` and backticks; quoting + escaping `"` and
/// `\` keeps the frontmatter valid for any parser.
fn yaml_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

/// Render the full file contents for one skill in the requested dialect.
pub fn render_skill(skill: &SkillDef, format: SkillFormat) -> String {
    let body = render_body(skill);
    match format {
        SkillFormat::SkillMd => format!(
            "---\nname: {}\ndescription: {}\n---\n\n{}",
            skill.name,
            yaml_quote(skill.description),
            body,
        ),
        SkillFormat::CursorMdc => format!(
            "---\ndescription: {}\nalwaysApply: false\n---\n\n{}",
            yaml_quote(skill.description),
            body,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::catalog;

    #[test]
    fn skillmd_has_name_and_description_frontmatter() {
        let s = catalog::find("aura-review").expect("seed skill present");
        let out = render_skill(&s, SkillFormat::SkillMd);
        assert!(out.starts_with("---\n"));
        assert!(out.contains("name: aura-review\n"));
        assert!(out.contains("description: \""));
        // Body carries the real command, not a placeholder.
        assert!(out.contains("aura pr-review --base main"));
        assert!(out.contains("## How to run"));
    }

    #[test]
    fn cursor_mdc_drops_name_and_adds_always_apply() {
        let s = catalog::find("aura-prove").expect("seed skill present");
        let out = render_skill(&s, SkillFormat::CursorMdc);
        assert!(!out.contains("name: aura-prove"));
        assert!(out.contains("alwaysApply: false"));
        assert!(out.contains("aura goal-trace"));
    }

    #[test]
    fn description_with_quotes_is_escaped() {
        // The prove skill's description embeds a quoted goal — make sure
        // the inner quote is escaped so the frontmatter stays valid.
        let s = catalog::find("aura-prove").expect("seed skill present");
        let out = render_skill(&s, SkillFormat::SkillMd);
        assert!(out.contains("\\\""), "inner quotes should be backslash-escaped");
    }

    #[test]
    fn every_seed_skill_renders_both_dialects() {
        for s in catalog::catalog() {
            let md = render_skill(&s, SkillFormat::SkillMd);
            let mdc = render_skill(&s, SkillFormat::CursorMdc);
            assert!(md.contains(&format!("name: {}", s.name)));
            assert!(mdc.contains("alwaysApply: false"));
            // Each skill must teach at least one runnable command.
            assert!(!s.usage.is_empty(), "{} has no usage", s.name);
        }
    }
}
