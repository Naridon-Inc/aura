//! `aura skills` — portable SKILL.md bundles for third-party agents.
//!
//! Packages Aura's capabilities as installable skill files so Claude Code,
//! Codex, Gemini and Cursor can discover them and shell out to the real
//! `aura` CLI. This is the *distribution* layer over capabilities the
//! engine already ships; nothing here re-implements engine behavior.
//!
//! Note the deliberate singular/plural split:
//!   - `aura skill`  (singular) — the agent-skill *ledger* (model routing).
//!   - `aura skills` (plural)   — these portable bundles. ← this module.
//!
//! Layout (DDD): [`catalog`] is the content (what each skill is + which
//! command it drives), [`render`] turns a def into an agent-specific file,
//! and this module owns the `list | emit | install` dispatch plus the
//! per-agent install-directory map.

pub mod catalog;
pub mod render;

use catalog::SkillDef;
use colored::Colorize;
use render::{render_skill, SkillFormat};
use std::fs;
use std::path::{Path, PathBuf};

/// CLI subcommands under `aura skills`.
#[derive(clap::Subcommand)]
pub enum SkillsAction {
    /// List the bundled portable skills and what each one does.
    List {
        /// Emit the catalog as a JSON array instead of a table.
        #[arg(long)]
        json: bool,
    },
    /// Render SKILL.md files into a directory without installing them.
    Emit {
        /// Target agent dialect — claude | codex | gemini | cursor.
        #[arg(long, default_value = "claude")]
        agent: String,
        /// Emit a single skill by name (default: all).
        #[arg(long)]
        skill: Option<String>,
        /// Emit every bundled skill (the default when --skill is absent).
        #[arg(long)]
        all: bool,
        /// Output directory. Files land as `<out>/<name>/SKILL.md` (or
        /// `<out>/<name>.mdc` for Cursor).
        #[arg(long, default_value = ".")]
        out: String,
    },
    /// Install the bundled skills into an agent's skills directory.
    Install {
        /// Target agent — claude | codex | gemini | cursor.
        agent: String,
        /// Install a single skill by name (default: all).
        #[arg(long)]
        skill: Option<String>,
        /// Install every bundled skill (the default when --skill is absent).
        #[arg(long)]
        all: bool,
        /// Write into the repo's `.<agent>/` directory (current working
        /// directory) instead of the user's home skills directory.
        #[arg(long)]
        repo: bool,
    },
}

/// A coding agent we can emit/install skills for. Each variant knows its
/// on-disk dialect and where its skills live.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentTarget {
    Claude,
    Codex,
    Gemini,
    Cursor,
}

impl AgentTarget {
    fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_lowercase().as_str() {
            "claude" | "claude-code" | "claude_code" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "gemini" | "gemini-cli" => Ok(Self::Gemini),
            "cursor" => Ok(Self::Cursor),
            other => Err(format!(
                "unknown agent '{other}' — expected one of: claude, codex, gemini, cursor"
            )),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
            Self::Cursor => "cursor",
        }
    }

    fn format(self) -> SkillFormat {
        match self {
            // Claude / Codex / Gemini all read the portable SKILL.md spec.
            Self::Claude | Self::Codex | Self::Gemini => SkillFormat::SkillMd,
            // Cursor reads `.mdc` rules.
            Self::Cursor => SkillFormat::CursorMdc,
        }
    }

    /// Directory, relative to the install root (HOME or repo cwd), that
    /// holds this agent's skills. Same relative path either way — only the
    /// root differs between home and `--repo` installs.
    fn rel_dir(self) -> &'static str {
        match self {
            Self::Claude => ".claude/skills",
            Self::Codex => ".codex/skills",
            Self::Gemini => ".gemini/skills",
            Self::Cursor => ".cursor/rules",
        }
    }

    /// Per-skill path *within* a skills directory. SKILL.md agents use a
    /// `<name>/SKILL.md` subdirectory (the Agent-Skills convention);
    /// Cursor uses a flat `<name>.mdc` file.
    fn skill_relpath(self, name: &str) -> PathBuf {
        match self.format() {
            SkillFormat::SkillMd => Path::new(name).join("SKILL.md"),
            SkillFormat::CursorMdc => PathBuf::from(format!("{name}.mdc")),
        }
    }
}

/// Resolve the user's home directory the same way the rest of aura-cli
/// does (`HOME`, falling back to `USERPROFILE` on Windows).
fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .map(PathBuf::from)
        .ok_or_else(|| "could not resolve home directory (HOME/USERPROFILE unset)".to_string())
}

/// Pick the skills to act on. A named `--skill` wins; otherwise the whole
/// catalog (so `aura skills install claude` installs everything).
fn select(skill: Option<&str>) -> Result<Vec<SkillDef>, String> {
    match skill {
        Some(name) => {
            let s = catalog::find(name).ok_or_else(|| {
                format!("no bundled skill named '{name}' — run `aura skills list` to see them")
            })?;
            Ok(vec![s])
        }
        None => Ok(catalog::catalog()),
    }
}

/// Write `contents` to `path`, creating parent directories as needed.
fn write_file(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    fs::write(path, contents).map_err(|e| format!("failed to write {}: {e}", path.display()))
}

pub fn run(action: &SkillsAction) -> Result<(), String> {
    match action {
        SkillsAction::List { json } => list(*json),
        SkillsAction::Emit {
            agent,
            skill,
            all: _,
            out,
        } => emit(agent, skill.as_deref(), out),
        SkillsAction::Install {
            agent,
            skill,
            all: _,
            repo,
        } => install(agent, skill.as_deref(), *repo),
    }
}

fn list(json: bool) -> Result<(), String> {
    let skills = catalog::catalog();
    if json {
        let rows: Vec<serde_json::Value> = skills
            .iter()
            .map(|s| {
                serde_json::json!({
                    "name": s.name,
                    "title": s.title,
                    "description": s.description,
                    "commands": s.usage.iter().map(|u| u.command).collect::<Vec<_>>(),
                })
            })
            .collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&rows).unwrap_or_else(|_| "[]".into())
        );
        return Ok(());
    }
    println!(
        "{} portable skill(s) — install into any agent with {}",
        skills.len().to_string().bold(),
        "aura skills install <agent>".cyan(),
    );
    for s in &skills {
        println!("  {} — {}", s.name.green().bold(), s.title);
    }
    println!(
        "\nRun {} to write SKILL.md files, or {} to drop them into an agent.",
        "aura skills emit --all --out <dir>".cyan(),
        "aura skills install claude".cyan(),
    );
    Ok(())
}

fn emit(agent: &str, skill: Option<&str>, out: &str) -> Result<(), String> {
    let target = AgentTarget::parse(agent)?;
    let skills = select(skill)?;
    let out_dir = PathBuf::from(out);
    let mut written = 0usize;
    for s in &skills {
        let dest = out_dir.join(target.skill_relpath(s.name));
        let contents = render_skill(s, target.format());
        write_file(&dest, &contents)?;
        println!("  {} {}", "✓".green(), dest.display());
        written += 1;
    }
    println!(
        "{} emitted {} skill file(s) for {} into {}",
        "→".green().bold(),
        written,
        target.id().bold(),
        out_dir.display(),
    );
    Ok(())
}

fn install(agent: &str, skill: Option<&str>, repo: bool) -> Result<(), String> {
    let target = AgentTarget::parse(agent)?;
    let skills = select(skill)?;
    let root = if repo {
        std::env::current_dir().map_err(|e| format!("could not resolve current dir: {e}"))?
    } else {
        home_dir()?
    };
    let base = root.join(target.rel_dir());
    let mut written = 0usize;
    for s in &skills {
        let dest = base.join(target.skill_relpath(s.name));
        let contents = render_skill(s, target.format());
        write_file(&dest, &contents)?;
        println!("  {} {}", "✓".green(), dest.display());
        written += 1;
    }
    let scope = if repo { "this repo" } else { "your home directory" };
    println!(
        "{} installed {} Aura skill(s) for {} into {} ({})",
        "→".green().bold(),
        written,
        target.id().bold(),
        base.display(),
        scope,
    );
    println!(
        "  {} restart {} (or reload its skills) to pick them up.",
        "·".dimmed(),
        target.id(),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_parse_accepts_aliases_and_rejects_unknown() {
        assert_eq!(AgentTarget::parse("claude").unwrap(), AgentTarget::Claude);
        assert_eq!(AgentTarget::parse("Claude-Code").unwrap(), AgentTarget::Claude);
        assert_eq!(AgentTarget::parse("cursor").unwrap(), AgentTarget::Cursor);
        assert!(AgentTarget::parse("aider").is_err());
    }

    #[test]
    fn skill_relpath_matches_dialect() {
        // SKILL.md agents nest under a per-skill directory.
        assert_eq!(
            AgentTarget::Claude.skill_relpath("aura-review"),
            Path::new("aura-review").join("SKILL.md"),
        );
        // Cursor writes a flat `.mdc` file.
        assert_eq!(
            AgentTarget::Cursor.skill_relpath("aura-review"),
            PathBuf::from("aura-review.mdc"),
        );
    }

    #[test]
    fn select_named_skill_or_all() {
        assert_eq!(select(Some("aura-prove")).unwrap().len(), 1);
        assert!(select(Some("does-not-exist")).is_err());
        assert_eq!(select(None).unwrap().len(), catalog::catalog().len());
    }

    #[test]
    fn rel_dir_is_dotagent_scoped() {
        assert_eq!(AgentTarget::Claude.rel_dir(), ".claude/skills");
        assert_eq!(AgentTarget::Cursor.rel_dir(), ".cursor/rules");
    }
}
