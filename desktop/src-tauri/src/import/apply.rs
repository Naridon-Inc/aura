//! Landing imported things in Aura: chats, scripts, rules and MCP servers.
//!
//! Every writer here writes only to Aura's own places (`~/.aura/…`, a repo's
//! `.aura/settings.toml`, its AGENTS.md). The other app's files are read
//! elsewhere and never opened for writing.

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::cmd_agent_history::PrerollTurn;
use crate::manager::{ChatRole, ChatTurn, ManagerSession, ProjectRef};

use super::ledger::imports_dir;

/// How many of an imported chat's most recent messages open in the chat.
/// The same window a resumed CLI session keeps: rendering thousands of turns
/// at once froze the chat surface. The older ones go to the session's own
/// archive and the untouched original is copied beside the ledger.
pub const KEEP_TURNS: usize = 400;

/// One conversation to bring over.
pub struct ChatImport {
    /// Source id (`conductor`) and the name people know it by (`Conductor`).
    pub source: &'static str,
    pub source_name: &'static str,
    /// The conversation's id in the source; names the raw copy.
    pub source_key: String,
    pub title: String,
    /// The folder the chat is about; it lists under this project in Aura.
    pub root: String,
    pub created_ms: i64,
    pub updated_ms: i64,
    /// The brand mark for the replies (`cli:claude_code`, `cli:codex`, …).
    pub brain: &'static str,
    pub turns: Vec<PrerollTurn>,
    /// The source's own records for this chat, one JSON line each, kept as
    /// a compressed copy so nothing the source held is lost in mapping.
    pub raw: Vec<String>,
}

fn safe_name(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Write the source's records for one chat to
/// `~/.aura/imports/<source>/<key>.jsonl.gz`. Ours to overwrite on a re-import.
pub fn write_raw_copy(source: &str, key: &str, lines: &[String]) -> Result<PathBuf, String> {
    let dir = imports_dir().ok_or("HOME not set")?.join(source);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{}.jsonl.gz", safe_name(key)));
    let file = std::fs::File::create(&path).map_err(|e| format!("create {}: {e}", path.display()))?;
    let mut gz = flate2::write::GzEncoder::new(std::io::BufWriter::new(file), flate2::Compression::default());
    for line in lines {
        gz.write_all(line.as_bytes()).map_err(|e| format!("write copy: {e}"))?;
        gz.write_all(b"\n").map_err(|e| format!("write copy: {e}"))?;
    }
    gz.finish()
        .and_then(|mut w| w.flush())
        .map_err(|e| format!("finish copy: {e}"))?;
    Ok(path)
}

fn note_turn(text: String, at: u64) -> ChatTurn {
    ChatTurn {
        role: ChatRole::Manager,
        text,
        at,
        answered_question: None,
        anchor: None,
        attachments: Vec::new(),
        brain: None,
        tool_calls: Vec::new(),
        thinking: None,
        saved_tokens: None,
        input_tokens: None,
        output_tokens: None,
        model: None,
        cost_usd: None,
        cost_estimated: None,
        cloud_key: None,
        cloud_id: None,
    }
}

fn map_turns(turns: Vec<PrerollTurn>, brain: &str) -> Vec<ChatTurn> {
    let mut mapped = crate::cmd_manager::map_preroll_turns(turns, "claude");
    for t in mapped.iter_mut() {
        if t.brain.is_some() {
            t.brain = Some(brain.to_string());
        }
    }
    mapped
}

fn ms_to_secs(ms: i64) -> u64 {
    (ms.max(0) / 1000) as u64
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Save one conversation as an Aura chat. Returns the new session id.
///
/// The chat is written straight to disk like any closed conversation: it
/// shows in the project's chat list, opens like one, and can be carried on
/// with any brain. It is not pushed to the cloud — it was private to this
/// Mac in the app it came from, and stays that way until the person shares it.
pub fn save_chat(c: ChatImport) -> Result<String, String> {
    if c.turns.is_empty() {
        return Err("it has no messages".into());
    }
    let raw_path = write_raw_copy(c.source, &c.source_key, &c.raw)?;

    let objective = Some(c.title.trim().to_string())
        .filter(|t| !t.is_empty())
        .or_else(|| {
            c.turns
                .iter()
                .find(|t| t.role == "user")
                .map(|t| crate::manager::summarize_objective(&t.text))
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| format!("Chat from {}", c.source_name));

    let total = c.turns.len();
    let mut turns = c.turns;
    let older: Vec<PrerollTurn> = if total > KEEP_TURNS {
        turns.drain(..total - KEEP_TURNS).collect()
    } else {
        Vec::new()
    };
    let mut chat = map_turns(turns, c.brain);
    let first_at = chat.first().map(|t| t.at).unwrap_or_else(|| ms_to_secs(c.created_ms));
    let mut note = format!(
        "Brought over from {} — {}.",
        c.source_name,
        plural(total, "message", "messages")
    );
    if !older.is_empty() {
        note.push_str(&format!(
            " The latest {KEEP_TURNS} are shown here; the {} before them {} kept in this chat's archive.",
            older.len(),
            if older.len() == 1 { "is" } else { "are" }
        ));
    }
    note.push_str(&format!(" A full copy of the original is at {}.", raw_path.display()));
    chat.insert(0, note_turn(note, first_at.saturating_sub(1)));

    let id = uuid::Uuid::new_v4().to_string();
    let project = ProjectRef {
        root: c.root.clone(),
        label: crate::cmd_manager::project_label(&c.root),
    };
    let mut session = ManagerSession::new(id.clone(), objective, vec![project], Vec::new());
    session.chat = chat;
    if c.created_ms > 0 {
        session.created_at = ms_to_secs(c.created_ms);
    }
    session.updated_at = ms_to_secs(c.updated_ms.max(c.created_ms)).max(session.created_at);

    if !older.is_empty() {
        let archived = map_turns(older, c.brain);
        let refs: Vec<&ChatTurn> = archived.iter().collect();
        crate::manager::distill::archive_turns(&id, &refs)?;
    }
    crate::manager::persist::save(&session)?;
    Ok(id)
}

/// Scripts and prompts another app kept for a repo.
#[derive(Default, Clone, Debug, PartialEq)]
pub struct Scripts {
    pub setup: Option<String>,
    pub run: Option<String>,
    pub archive: Option<String>,
    pub review: Option<String>,
    pub pr: Option<String>,
    pub conflicts: Option<String>,
}

fn non_empty(s: &Option<String>) -> Option<String> {
    s.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()).map(str::to_string)
}

impl Scripts {
    /// The labels of the fields that hold something, for the item's detail.
    pub fn labels(&self) -> Vec<&'static str> {
        [
            (&self.setup, "setup"),
            (&self.run, "run"),
            (&self.archive, "archive"),
            (&self.review, "review prompt"),
            (&self.pr, "PR prompt"),
            (&self.conflicts, "conflicts prompt"),
        ]
        .into_iter()
        .filter(|(v, _)| non_empty(v).is_some())
        .map(|(_, l)| l)
        .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.labels().is_empty()
    }
}

/// Fill the repo's Aura settings with the scripts it doesn't have yet.
/// Anything already set in Aura wins — the person chose it here. Returns the
/// labels of what was written (empty: everything was already set).
pub fn merge_scripts(root: &Path, s: &Scripts) -> Result<Vec<&'static str>, String> {
    let mut settings = crate::cmd_repo_settings::load_settings(root);
    let mut wrote = Vec::new();
    let mut fill = |slot: &mut Option<String>, from: &Option<String>, label: &'static str| {
        if non_empty(slot).is_none() {
            if let Some(v) = non_empty(from) {
                *slot = Some(v);
                wrote.push(label);
            }
        }
    };
    fill(&mut settings.setup, &s.setup, "setup");
    fill(&mut settings.run, &s.run, "run");
    fill(&mut settings.archive, &s.archive, "archive");
    fill(&mut settings.review_instructions, &s.review, "review prompt");
    fill(&mut settings.pr_instructions, &s.pr, "PR prompt");
    fill(&mut settings.conflict_instructions, &s.conflicts, "conflicts prompt");
    if !wrote.is_empty() {
        crate::cmd_repo_settings::save_settings(root, &settings)?;
    }
    Ok(wrote)
}

/// The rule files a repo holds that `aura migrate` folds into AGENTS.md.
/// Mirrors the CLI's list so the page can count them without running it.
pub fn rule_files(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = [".cursorrules", ".windsurfrules", ".clinerules"]
        .into_iter()
        .filter(|rel| {
            std::fs::read_to_string(root.join(rel))
                .map(|t| !t.trim().is_empty())
                .unwrap_or(false)
        })
        .map(str::to_string)
        .collect();
    if let Ok(entries) = std::fs::read_dir(root.join(".cursor").join("rules")) {
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.ends_with(".mdc") || n.ends_with(".md"))
            .map(|n| format!(".cursor/rules/{n}"))
            .collect();
        names.sort();
        out.extend(names);
    }
    out
}

/// What `aura migrate --apply` did in one repo.
#[derive(Debug, PartialEq)]
pub struct Migrated {
    pub wrote: bool,
    pub sources: usize,
}

/// Run `aura migrate --apply --json` in `root`: the CLI owns the merge into
/// AGENTS.md (a fenced block, one entry per source, hashed so a re-run is a
/// no-op, the old AGENTS.md backed up). One writer for that file, not two.
pub fn migrate_rules(root: &Path) -> Result<Migrated, String> {
    let bin = crate::agent_event_listener::resolve_aura_bin();
    let out = std::process::Command::new(&bin)
        .args(["migrate", "--apply", "--json"])
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("couldn't run the aura helper: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        return Err(if err.is_empty() {
            format!("aura migrate exited with {}", out.status)
        } else {
            err.lines().last().unwrap_or(err).to_string()
        });
    }
    parse_migrate(&String::from_utf8_lossy(&out.stdout))
}

pub fn parse_migrate(stdout: &str) -> Result<Migrated, String> {
    let v: serde_json::Value =
        serde_json::from_str(stdout.trim()).map_err(|e| format!("couldn't read aura migrate's answer: {e}"))?;
    Ok(Migrated {
        wrote: v.get("wrote_agents_md").and_then(|b| b.as_bool()).unwrap_or(false),
        sources: v.get("sources").and_then(|s| s.as_array()).map(|a| a.len()).unwrap_or(0),
    })
}
