//! Per-repo reviewer/fixer role configuration for `aura review`.
//!
//! entire.io's `entire review` lets a repo declare which agents *review*
//! a change and which agent *fixes* it. This is the persisted shape of
//! that decision, stored in `.aura/review_roles.json` so the role flow is
//! reproducible across machines and CI.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

/// The CLI-wrapper agents Replay Lab and role-review know how to drive.
/// (Native brains are shell-only; review uses the same wrappers entire does.)
pub const KNOWN_AGENTS: &[&str] = &["claude", "gemini", "codex", "cursor"];

/// Reviewer/fixer roles for one repository.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewRoles {
    /// Agent IDs that review the diff (in addition to Aura's deterministic
    /// engine, which always runs).
    pub reviewers: Vec<String>,
    /// Agent ID that applies fixes via `aura review fix`. `None` until set.
    pub fixer: Option<String>,
    /// Branch the review diffs against.
    pub base: String,
}

impl Default for ReviewRoles {
    fn default() -> Self {
        Self {
            reviewers: Vec::new(),
            fixer: None,
            base: detect_default_base(),
        }
    }
}

impl ReviewRoles {
    /// Path to the roles file under a repo root.
    pub fn path(repo_root: &Path) -> PathBuf {
        repo_root.join(".aura").join("review_roles.json")
    }

    /// Load roles for `repo_root`, falling back to a sensible default
    /// (available known agents as reviewers, first as fixer) when no file
    /// exists yet. A corrupt file is treated as absent, not fatal.
    pub fn load_or_seed(repo_root: &Path) -> Self {
        let p = Self::path(repo_root);
        if let Ok(raw) = std::fs::read_to_string(&p) {
            if let Ok(roles) = serde_json::from_str::<ReviewRoles>(&raw) {
                return roles;
            }
        }
        Self::seed(repo_root)
    }

    /// Load only if a file exists; `None` when the repo has never run setup.
    pub fn load(repo_root: &Path) -> Option<Self> {
        let raw = std::fs::read_to_string(Self::path(repo_root)).ok()?;
        serde_json::from_str(&raw).ok()
    }

    /// Build a default set from whichever known agents are installed.
    pub fn seed(repo_root: &Path) -> Self {
        let available = available_agents();
        let fixer = available.first().cloned();
        Self {
            reviewers: available,
            fixer,
            base: detect_default_base_in(repo_root),
        }
    }

    /// Persist to `.aura/review_roles.json`, creating `.aura/` if needed.
    pub fn save(&self, repo_root: &Path) -> std::io::Result<()> {
        let dir = repo_root.join(".aura");
        std::fs::create_dir_all(&dir)?;
        let body = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(Self::path(repo_root), body)
    }

    /// Reviewers limited to known, sane agent IDs (drops typos/dupes).
    pub fn sanitized_reviewers(&self) -> Vec<String> {
        let mut seen = Vec::new();
        for r in &self.reviewers {
            let r = r.trim();
            if r.is_empty() || seen.iter().any(|s: &String| s == r) {
                continue;
            }
            seen.push(r.to_string());
        }
        seen
    }
}

/// Parse a comma-separated agent list (`--reviewers claude,gemini`).
pub fn parse_agent_csv(csv: &str) -> Vec<String> {
    csv.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Which known agents have an installed binary right now.
pub fn available_agents() -> Vec<String> {
    let reg = aura_agents::registry();
    KNOWN_AGENTS
        .iter()
        .filter(|id| reg.get(**id).map(|p| p.is_available()).unwrap_or(false))
        .map(|id| id.to_string())
        .collect()
}

/// Default base branch when none is configured: prefer `main`, then
/// `master`, else `HEAD`. Run from the current directory.
pub fn detect_default_base() -> String {
    detect_default_base_in(Path::new("."))
}

fn detect_default_base_in(repo_root: &Path) -> String {
    for candidate in ["main", "master"] {
        let ok = Command::new("git")
            .args(["rev-parse", "--verify", "--quiet", candidate])
            .current_dir(repo_root)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            return candidate.to_string();
        }
    }
    "HEAD".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_csv_trims_and_drops_empties() {
        assert_eq!(parse_agent_csv("claude, gemini ,,codex"), vec![
            "claude".to_string(),
            "gemini".to_string(),
            "codex".to_string()
        ]);
        assert!(parse_agent_csv("  ").is_empty());
    }

    #[test]
    fn sanitize_dedups_and_drops_blank() {
        let roles = ReviewRoles {
            reviewers: vec![
                "claude".into(),
                " claude ".into(),
                "".into(),
                "gemini".into(),
            ],
            fixer: None,
            base: "main".into(),
        };
        assert_eq!(roles.sanitized_reviewers(), vec![
            "claude".to_string(),
            "gemini".to_string()
        ]);
    }

    #[test]
    fn roundtrip_save_load() {
        let dir = std::env::temp_dir().join(format!("aura-roles-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let roles = ReviewRoles {
            reviewers: vec!["claude".into(), "codex".into()],
            fixer: Some("claude".into()),
            base: "develop".into(),
        };
        roles.save(&dir).unwrap();
        let loaded = ReviewRoles::load(&dir).unwrap();
        assert_eq!(roles, loaded);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_has_a_base() {
        let roles = ReviewRoles::default();
        assert!(!roles.base.is_empty());
    }
}
