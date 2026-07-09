//! Real skill discovery across the coding agents installed on this machine.
//!
//! The Skills pane used to read only Aura's signed plugin registry, so it
//! showed "none" even when Claude Code, Codex, Gemini and Cursor each carry a
//! pile of skills/commands on disk. This scans the *actual* agent skill homes —
//! the same files those CLIs load — so what the user sees in Aura matches what
//! their agents can really do.
//!
//! We read two scopes per agent: the machine-wide home (`~/.claude/skills`,
//! `~/.codex/prompts`, …) and the project-local copy (`<repo>/.claude/…`). A
//! skill is a `<name>/SKILL.md` bundle; a command/prompt is a flat `*.md`; a
//! Cursor rule is a flat `*.mdc`. YAML frontmatter (when present) gives the
//! human name + description; otherwise we fall back to the filename and the
//! first prose line. Nothing is invented — a row here is a file you can open.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentSkill {
    /// Canonical agent id this skill belongs to ("claude", "codex", …).
    pub agent: String,
    /// Human label for grouping ("Claude Code", "Codex", …).
    pub agent_label: String,
    /// Display name — frontmatter `name`, else the file/dir stem.
    pub name: String,
    /// One plain-language line — frontmatter `description`, else first prose
    /// line of the file. Empty when the file carries neither.
    pub description: String,
    /// "skill" (a SKILL.md bundle), "command" (a slash command / prompt), or
    /// "rule" (a Cursor rule). Lets the pane label what kind of ability it is.
    pub kind: String,
    /// "user" (machine-wide home) or "project" (this repo). Shown as a chip.
    pub scope: String,
    /// Absolute path on disk, so the pane can offer "open the file".
    pub path: String,
}

/// What a single agent keeps, and where. `dir` is the dot-folder under both
/// `$HOME` and the repo root.
struct AgentDirs {
    agent: &'static str,
    label: &'static str,
    dir: &'static str,
    /// Subfolders holding flat command/prompt `*.md` files.
    command_subdirs: &'static [&'static str],
    /// Subfolders holding flat Cursor-style `*.mdc` rule files.
    rule_subdirs: &'static [&'static str],
    /// True if `<dir>/skills/<name>/SKILL.md` bundles should be scanned.
    has_skill_bundles: bool,
}

const AGENT_DIRS: &[AgentDirs] = &[
    AgentDirs {
        agent: "claude",
        label: "Claude Code",
        dir: ".claude",
        command_subdirs: &["commands"],
        rule_subdirs: &[],
        has_skill_bundles: true,
    },
    AgentDirs {
        agent: "codex",
        label: "Codex",
        dir: ".codex",
        command_subdirs: &["prompts"],
        rule_subdirs: &[],
        has_skill_bundles: true,
    },
    AgentDirs {
        agent: "gemini",
        label: "Gemini",
        dir: ".gemini",
        command_subdirs: &["commands"],
        rule_subdirs: &[],
        has_skill_bundles: true,
    },
    AgentDirs {
        agent: "cursor",
        label: "Cursor",
        dir: ".cursor",
        command_subdirs: &[],
        rule_subdirs: &["rules"],
        has_skill_bundles: false,
    },
    AgentDirs {
        agent: "opencode",
        label: "opencode",
        dir: ".opencode",
        command_subdirs: &["command", "commands"],
        rule_subdirs: &[],
        has_skill_bundles: true,
    },
];

/// Frontmatter we care about. Everything optional — most files have neither
/// field, and that's fine.
#[derive(Deserialize, Default)]
struct FrontMatter {
    name: Option<String>,
    description: Option<String>,
}

/// Pull `name`/`description` out of a leading `---\n…\n---` YAML block, plus the
/// first prose line after it (for files that carry no `description`).
fn parse_doc(text: &str) -> (FrontMatter, String) {
    let mut fm = FrontMatter::default();
    let mut body_start = 0usize;
    let trimmed = text.trim_start_matches('\u{feff}');
    if let Some(rest) = trimmed.strip_prefix("---") {
        // Find the closing fence on its own line.
        if let Some(end) = rest.find("\n---") {
            let yaml = &rest[..end];
            if let Ok(parsed) = serde_yaml::from_str::<FrontMatter>(yaml) {
                fm = parsed;
            }
            // Advance body past the closing fence line.
            let after = &rest[end + 1..]; // at "---"
            if let Some(nl) = after.find('\n') {
                body_start = text.len() - after.len() + nl + 1;
            } else {
                body_start = text.len();
            }
        }
    }
    let first_line = text[body_start.min(text.len())..]
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("---"))
        .map(|l| l.trim_start_matches('#').trim().to_string())
        .unwrap_or_default();
    (fm, first_line)
}

fn read_meta(path: &Path) -> (Option<String>, String) {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let (fm, first_line) = parse_doc(&text);
    let desc = fm.description.unwrap_or(first_line);
    (fm.name, clip(&desc))
}

/// Keep descriptions to a calm single line — frontmatter occasionally holds a
/// paragraph and the pane shows one truncated row.
fn clip(s: &str) -> String {
    let one = s.replace('\n', " ");
    let one = one.trim();
    if one.chars().count() > 160 {
        let cut: String = one.chars().take(157).collect();
        format!("{cut}…")
    } else {
        one.to_string()
    }
}

fn stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

/// Scan one agent's dot-folder at `base` (which is `$HOME/.claude` or
/// `<repo>/.claude`) and push every skill/command/rule into `out`.
fn scan_agent_base(spec: &AgentDirs, base: &Path, scope: &str, out: &mut Vec<AgentSkill>) {
    if !base.is_dir() {
        return;
    }

    // 1) Skill bundles: <base>/skills/<name>/SKILL.md
    if spec.has_skill_bundles {
        let skills_dir = base.join("skills");
        if let Ok(entries) = std::fs::read_dir(&skills_dir) {
            for entry in entries.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                // Accept SKILL.md (canonical) or skill.md (lenient).
                let manifest = ["SKILL.md", "skill.md"]
                    .iter()
                    .map(|n| dir.join(n))
                    .find(|p| p.is_file());
                let Some(manifest) = manifest else { continue };
                let (fm_name, desc) = read_meta(&manifest);
                out.push(AgentSkill {
                    agent: spec.agent.into(),
                    agent_label: spec.label.into(),
                    name: fm_name.unwrap_or_else(|| stem(&dir)),
                    description: desc,
                    kind: "skill".into(),
                    scope: scope.into(),
                    path: manifest.to_string_lossy().into_owned(),
                });
            }
        }
    }

    // 2) Flat commands / prompts: <base>/<subdir>/*.md
    for sub in spec.command_subdirs {
        collect_flat(base.join(sub), "md", "command", spec, scope, out);
    }

    // 3) Flat Cursor rules: <base>/<subdir>/*.mdc
    for sub in spec.rule_subdirs {
        collect_flat(base.join(sub), "mdc", "rule", spec, scope, out);
    }
}

fn collect_flat(
    dir: PathBuf,
    ext: &str,
    kind: &str,
    spec: &AgentDirs,
    scope: &str,
    out: &mut Vec<AgentSkill>,
) {
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some(ext) {
            continue;
        }
        let (fm_name, desc) = read_meta(&path);
        out.push(AgentSkill {
            agent: spec.agent.into(),
            agent_label: spec.label.into(),
            name: fm_name.unwrap_or_else(|| stem(&path)),
            description: desc,
            kind: kind.into(),
            scope: scope.into(),
            path: path.to_string_lossy().into_owned(),
        });
    }
}

/// List the real skills/commands/rules every installed agent carries — both
/// the machine-wide home copies and the project-local ones under `repo_root`.
#[tauri::command]
pub async fn agent_skills_list(repo_root: String) -> Vec<AgentSkill> {
    let home = dirs::home_dir();
    let repo = if repo_root.trim().is_empty() {
        None
    } else {
        Some(PathBuf::from(&repo_root))
    };

    let mut out: Vec<AgentSkill> = Vec::new();
    for spec in AGENT_DIRS {
        if let Some(home) = &home {
            scan_agent_base(spec, &home.join(spec.dir), "user", &mut out);
        }
        if let Some(repo) = &repo {
            scan_agent_base(spec, &repo.join(spec.dir), "project", &mut out);
        }
    }

    // Stable, readable order: by agent, then user-scope first, then name.
    out.sort_by(|a, b| {
        a.agent
            .cmp(&b.agent)
            .then_with(|| a.scope.cmp(&b.scope))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}
