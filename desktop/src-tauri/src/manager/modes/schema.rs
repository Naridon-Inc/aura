//! Mode YAML schema — v0.2.32 MM.1.
//!
//! A *mode* is a portable specialist persona that the user can install,
//! switch into, and share. Each mode is a YAML file with a `system_prompt`,
//! a tool ACL, hints about which Brain/model to prefer, and a tiny UI
//! shroud (accent color, badge). The shape is intentionally close to
//! Cursor's "modes" / Cline's "personas" so users can port their files
//! across editors with `aura modes import`.
//!
//! Storage layout: `~/.aura/modes/<slug>.yaml` — one file per installed
//! mode. A sidecar `<slug>.meta.json` carries provenance the YAML itself
//! shouldn't (source URL, blake3 pin, install time). Bundled defaults
//! ship under `aura-shell/resources/modes/` and are merged on top of any
//! installed file with the same slug.
//!
//! Schema versioning: the top-level `schema_version` field is the only
//! migration knob. v1 is the current shape; future variants either bump
//! `schema_version` and live behind a `from_v1`-style upgrader, or add
//! optional fields and stay at v1.

use serde::{Deserialize, Serialize};

/// Current mode schema version. Bump only on breaking changes; additive
/// fields default to `Default::default()` and stay at v1.
pub const MODE_SCHEMA_VERSION: u32 = 1;

/// Tool ACL — what tools the mode is allowed to use, what it cannot, and
/// which sensitive tools require an explicit advanced toggle. Empty
/// vectors mean "no opinion" (use the canonical default whitelist).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ToolAcl {
    /// Explicit allow-list. When non-empty, ONLY these tools are
    /// permitted (intersected with `CANONICAL_TOOLS`).
    #[serde(default)]
    pub allow: Vec<String>,
    /// Explicit deny-list — applied after `allow`. Useful to forbid
    /// `shell.exec` even on a mode that otherwise opts into everything.
    #[serde(default)]
    pub deny: Vec<String>,
    /// Tools the mode WANTS but which require the user to flip an
    /// "advanced" toggle at install time (shell.exec, write side-effects,
    /// network egress). Subset of `CANONICAL_TOOLS`.
    #[serde(default)]
    pub advanced: Vec<String>,
}

/// Zone routing hints — soft preferences the planner uses when fanning
/// out subagents. `prefers` boosts the mode's affinity for matching
/// paths; `avoids` reduces it. Both accept glob-like patterns
/// (`src/auth/**`, `docs/*.md`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ZoneHints {
    #[serde(default)]
    pub prefers: Vec<String>,
    #[serde(default)]
    pub avoids: Vec<String>,
}

/// Minimal UI shroud — the picker uses these to colour the mode chip
/// in the composer. Both fields are optional; the picker falls back to
/// the default accent/badge if unset.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UiShroud {
    /// Hex color string (`#7c3aed`) or a CSS variable name. Validated
    /// loosely — anything that parses as a non-empty string is accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    /// Short label (≤4 chars typical) drawn on the chip. "ARC" for
    /// architect, "DBG" for debug, etc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
}

/// One installed mode. Top-level shape mirrors the YAML on disk 1:1
/// (serde rename to snake_case is implicit — every field uses the same
/// name in Rust and YAML).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mode {
    /// Always `MODE_SCHEMA_VERSION` on write. The validator rejects
    /// anything else (no silent downgrades).
    pub schema_version: u32,
    /// Stable slug — also the filename stem on disk. Lowercase, kebab-
    /// case, ≤64 chars. The validator enforces this.
    pub id: String,
    /// Human-facing name shown in the picker ("Code Specialist").
    pub display_name: String,
    /// One-paragraph description for the marketplace card.
    pub description: String,
    /// Author handle / display name. Free-form string.
    #[serde(default)]
    pub author: String,
    /// Searchable tags for the marketplace ("rust", "debugging").
    #[serde(default)]
    pub tags: Vec<String>,
    /// The system prompt prepended to every turn while this mode is
    /// active. Must be non-empty; the validator enforces a soft cap of
    /// 32k chars so we don't ship megabyte prompts to the model.
    pub system_prompt: String,
    /// Tool ACL. Empty fields mean "use canonical default".
    #[serde(default)]
    pub tool_acl: ToolAcl,
    /// Preferred Brain provider id (`anthropic_native`,
    /// `cli_wrapper:claude_code`, …). `None` = use the user's active
    /// brain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_brain: Option<String>,
    /// Preferred model string (`claude-opus-4-7`, `gpt-5`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brain_model: Option<String>,
    /// Zone hints — soft routing preferences. Optional everywhere.
    #[serde(default)]
    pub zone_hints: ZoneHints,
    /// Default lane the mode runs in. Free-form string; the planner
    /// uses this as a hint when no explicit `--lane` is passed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane_default: Option<String>,
    /// Optional list of MCP server names to enable while this mode is
    /// active. The composer surfaces a one-click "enable bundle" affordance.
    #[serde(default)]
    pub mcp_bundle: Vec<String>,
    /// UI shroud — accent + badge for the picker chip.
    #[serde(default)]
    pub ui: UiShroud,
}

impl Mode {
    /// True when this mode is one of the bundled defaults that ships
    /// inside the binary (`architect`, `code`, `debug`). Callers use it
    /// to disable Uninstall in the UI.
    pub fn is_bundled_default(&self) -> bool {
        matches!(self.id.as_str(), "architect" | "code" | "debug")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_round_trips_through_yaml() {
        let m = Mode {
            schema_version: MODE_SCHEMA_VERSION,
            id: "smoke".into(),
            display_name: "Smoke".into(),
            description: "test fixture".into(),
            author: "me".into(),
            tags: vec!["x".into()],
            system_prompt: "be helpful".into(),
            tool_acl: ToolAcl {
                allow: vec!["fs.read".into()],
                deny: vec!["shell.exec".into()],
                advanced: vec![],
            },
            default_brain: Some("anthropic_native".into()),
            brain_model: Some("claude-opus-4-7".into()),
            zone_hints: ZoneHints {
                prefers: vec!["src/**".into()],
                avoids: vec![],
            },
            lane_default: Some("review".into()),
            mcp_bundle: vec![],
            ui: UiShroud {
                accent: Some("#7c3aed".into()),
                badge: Some("SMK".into()),
            },
        };
        let s = serde_yaml::to_string(&m).unwrap();
        let back: Mode = serde_yaml::from_str(&s).unwrap();
        assert_eq!(back.id, m.id);
        assert_eq!(back.tool_acl.allow, m.tool_acl.allow);
        assert_eq!(back.ui.accent, m.ui.accent);
    }

    #[test]
    fn bundled_default_check_is_id_match() {
        let mut m = Mode {
            schema_version: MODE_SCHEMA_VERSION,
            id: "architect".into(),
            display_name: "x".into(),
            description: "x".into(),
            author: "x".into(),
            tags: vec![],
            system_prompt: "x".into(),
            tool_acl: ToolAcl::default(),
            default_brain: None,
            brain_model: None,
            zone_hints: ZoneHints::default(),
            lane_default: None,
            mcp_bundle: vec![],
            ui: UiShroud::default(),
        };
        assert!(m.is_bundled_default());
        m.id = "third_party".into();
        assert!(!m.is_bundled_default());
    }
}
