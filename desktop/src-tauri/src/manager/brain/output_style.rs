//! AURA-1296 — the composer's "Concise" chip, as CLI arguments.
//!
//! Claude Code has `--output-style <name>`; no other agent CLI Aura wraps has
//! an equivalent, and passing an unknown flag to one of them would make the
//! turn fail. So the mapping is: Claude gets the flag, everyone else gets
//! nothing, and a request with no style set is byte-identical to a build
//! without the chip.

/// Extra argv for this turn. Empty unless the agent is Claude Code AND a
/// style was chosen.
pub fn claude_output_style_args(agent_id: &str, style: Option<&str>) -> Vec<String> {
    let Some(style) = style.map(str::trim).filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    if !is_claude(agent_id) {
        return Vec::new();
    }
    vec!["--output-style".to_string(), style.to_string()]
}

/// Claude Code's canonical id is `claude`; older configs spell it
/// `claude_code` / `claude-code`.
fn is_claude(agent_id: &str) -> bool {
    matches!(
        agent_id.trim().to_ascii_lowercase().as_str(),
        "claude" | "claude_code" | "claude-code"
    )
}

#[cfg(test)]
mod tests {
    use super::claude_output_style_args;

    #[test]
    fn claude_gets_the_flag() {
        assert_eq!(
            claude_output_style_args("claude", Some("concise")),
            vec!["--output-style".to_string(), "concise".to_string()]
        );
        assert_eq!(
            claude_output_style_args("claude_code", Some("concise")).len(),
            2
        );
    }

    #[test]
    fn other_agents_get_nothing() {
        assert!(claude_output_style_args("gemini", Some("concise")).is_empty());
        assert!(claude_output_style_args("codex", Some("concise")).is_empty());
    }

    #[test]
    fn no_style_means_no_args() {
        assert!(claude_output_style_args("claude", None).is_empty());
        assert!(claude_output_style_args("claude", Some("  ")).is_empty());
    }
}
