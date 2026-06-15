//! Carryover rendering — turns an [`AuraCarryover`] into the markdown a
//! resuming brain reads, and (for `--inject`) writes that markdown into a
//! target agent's startup-context file inside an idempotent marker section.
//!
//! The marker pattern mirrors `migrate/apply.rs` / `cmd_taste.rs`: a
//! `<!-- AURA:RESUME:START -->…<!-- AURA:RESUME:END -->` block is
//! replaced in place if present, else appended — so re-running `aura
//! carryover --inject` never duplicates.

use std::fs;
use std::path::{Path, PathBuf};

use super::model::*;

const MARKER_START: &str = "<!-- AURA:RESUME:START -->";
const MARKER_END: &str = "<!-- AURA:RESUME:END -->";

/// Render the carryover as a standalone markdown document.
pub fn to_markdown(c: &AuraCarryover) -> String {
    let mut s = String::new();

    let who = c.target_agent.as_deref().unwrap_or("the next agent");
    s.push_str(&format!(
        "# Aura carryover → {who}\n\n\
         You are continuing work that was in progress under a different brain. \
         The state below is reconstructed from Aura's semantic record (signed intent log, \
         AST checkpoints, session, working tree) — continue the *work*, don't restart it.\n\n"
    ));
    s.push_str(&format!(
        "- **mode**: {} · **generated**: {} · **branch**: {}\n",
        c.mode,
        fmt_ts(c.generated_at),
        c.branch.as_deref().unwrap_or("—")
    ));
    s.push_str(&format!("- **repo**: {}\n\n", c.repo));

    if let Some(sess) = &c.session {
        s.push_str("## Session\n\n");
        s.push_str(&format!(
            "- {} on `{}`{}{}\n",
            sess.agent_id,
            sess.branch.as_deref().unwrap_or("—"),
            sess.model.as_deref().map(|m| format!(" · model `{m}`")).unwrap_or_default(),
            sess.base_commit.as_deref().map(|b| format!(" · base `{b}`")).unwrap_or_default(),
        ));
        if let Some(fp) = &sess.first_prompt {
            s.push_str(&format!("- **first ask**: {}\n", super::assemble::truncate(fp, 280)));
        }
        if let Some(sum) = &sess.summary {
            if !sum.intent.is_empty() {
                s.push_str(&format!("- **goal**: {}\n", sum.intent));
            }
            if !sum.outcome.is_empty() {
                s.push_str(&format!("- **so far**: {}\n", sum.outcome));
            }
            if !sum.open_items.is_empty() {
                s.push_str("- **open items**:\n");
                for it in &sum.open_items {
                    s.push_str(&format!("  - [ ] {it}\n"));
                }
            }
        }
        if !sess.files_touched.is_empty() {
            s.push_str(&format!(
                "- **files touched** ({}): {}\n",
                sess.files_touched.len(),
                sess.files_touched.join(", ")
            ));
        }
        s.push('\n');
    }

    if !c.intents.is_empty() {
        s.push_str("## Recent intents (why)\n\n");
        for it in &c.intents {
            let ty = it.intent_type.as_deref().map(|t| format!("[{t}] ")).unwrap_or_default();
            let signed = it
                .signed_block_id
                .as_deref()
                .map(|id| format!("  ·  signed `{id}` (verify: `aura attest verify {id}`)"))
                .unwrap_or_default();
            s.push_str(&format!("- {ty}{}{}\n", it.intent, signed));
        }
        s.push('\n');
    }

    if !c.touched_nodes.is_empty() {
        s.push_str("## Functions in play (function-level intent)\n\n");
        for n in &c.touched_nodes {
            let loc = n
                .file_path
                .as_deref()
                .map(|f| {
                    n.start_line
                        .map(|l| format!("{f}:{l}"))
                        .unwrap_or_else(|| f.to_string())
                })
                .unwrap_or_else(|| n.node_id.clone());
            let stub = if n.is_stub { " ⚠️ STUB/unfinished" } else { "" };
            let name = n.identifier.as_deref().unwrap_or(&n.node_id);
            s.push_str(&format!("- `{name}` ({loc}){stub} — {}\n", n.intent));
        }
        s.push('\n');
    }

    let wt = &c.working_tree;
    s.push_str("## Working tree (uncommitted)\n\n");
    if wt.files.is_empty() {
        s.push_str("- clean\n\n");
    } else {
        s.push_str(&format!(
            "- {} file(s), +{} / -{}\n",
            wt.files_changed.max(wt.files.len()),
            wt.insertions,
            wt.deletions
        ));
        for f in &wt.files {
            s.push_str(&format!("  - {} {}\n", f.status, f.path));
        }
        s.push('\n');
    }

    if let Some(mem) = &c.memory {
        s.push_str("## Project memory\n\n```json\n");
        s.push_str(&serde_json::to_string_pretty(mem).unwrap_or_default());
        s.push_str("\n```\n\n");
    }

    if !c.recent_turns.is_empty() {
        s.push_str("## Recent conversation\n\n");
        for t in &c.recent_turns {
            s.push_str(&format!("**{}**: {}\n\n", t.role, t.text));
        }
    }

    s
}

/// Render the carryover as a dense XML context block — the machine-facing
/// face of the same struct `to_markdown` renders. This is what the portable
/// `aura handover` paste-block emits: an external agent's system-rules
/// parser lifts the tags cleanly, where prose markdown would be ambiguous.
/// Same data, same source of truth; only the serialization differs.
pub fn to_xml(c: &AuraCarryover) -> String {
    let mut s = String::new();
    let who = c.target_agent.as_deref().unwrap_or("the next agent");

    s.push_str("<aura_semantic_context");
    s.push_str(&format!(" for=\"{}\"", xml_attr(who)));
    s.push_str(&format!(" mode=\"{}\"", xml_attr(&c.mode)));
    s.push_str(&format!(" generated=\"{}\"", xml_attr(&fmt_ts(c.generated_at))));
    if let Some(b) = &c.branch {
        s.push_str(&format!(" branch=\"{}\"", xml_attr(b)));
    }
    s.push_str(&format!(" repo=\"{}\"", xml_attr(&c.repo)));
    s.push_str(">\n");

    if let Some(sess) = &c.session {
        s.push_str(&format!(
            "  <session agent=\"{}\"{}{}{}>\n",
            xml_attr(&sess.agent_id),
            sess.branch.as_deref().map(|b| format!(" branch=\"{}\"", xml_attr(b))).unwrap_or_default(),
            sess.model.as_deref().map(|m| format!(" model=\"{}\"", xml_attr(m))).unwrap_or_default(),
            sess.base_commit.as_deref().map(|b| format!(" base=\"{}\"", xml_attr(b))).unwrap_or_default(),
        ));
        if let Some(fp) = &sess.first_prompt {
            s.push_str(&format!(
                "    <first_ask>{}</first_ask>\n",
                xml_text(&super::assemble::truncate(fp, 280))
            ));
        }
        if let Some(sum) = &sess.summary {
            if !sum.intent.is_empty() {
                s.push_str(&format!("    <goal>{}</goal>\n", xml_text(&sum.intent)));
            }
            if !sum.outcome.is_empty() {
                s.push_str(&format!("    <so_far>{}</so_far>\n", xml_text(&sum.outcome)));
            }
            for it in &sum.open_items {
                s.push_str(&format!("    <open_item>{}</open_item>\n", xml_text(it)));
            }
        }
        for f in &sess.files_touched {
            s.push_str(&format!("    <file_touched>{}</file_touched>\n", xml_text(f)));
        }
        s.push_str("  </session>\n");
    }

    if !c.intents.is_empty() {
        s.push_str("  <intents>\n");
        for it in &c.intents {
            s.push_str("    <intent");
            if let Some(t) = &it.intent_type {
                s.push_str(&format!(" type=\"{}\"", xml_attr(t)));
            }
            if let Some(id) = &it.signed_block_id {
                s.push_str(&format!(" signed=\"{}\"", xml_attr(id)));
            }
            s.push_str(&format!(">{}</intent>\n", xml_text(&it.intent)));
        }
        s.push_str("  </intents>\n");
    }

    if !c.touched_nodes.is_empty() {
        s.push_str("  <functions_in_play>\n");
        for n in &c.touched_nodes {
            let name = n.identifier.as_deref().unwrap_or(&n.node_id);
            s.push_str(&format!(
                "    <node name=\"{}\" kind=\"{}\"",
                xml_attr(name),
                xml_attr(&n.kind)
            ));
            if let Some(f) = &n.file_path {
                let loc = n.start_line.map(|l| format!("{f}:{l}")).unwrap_or_else(|| f.clone());
                s.push_str(&format!(" at=\"{}\"", xml_attr(&loc)));
            }
            if n.is_stub {
                s.push_str(" stub=\"true\"");
            }
            s.push_str(&format!(">{}</node>\n", xml_text(&n.intent)));
        }
        s.push_str("  </functions_in_play>\n");
    }

    let wt = &c.working_tree;
    s.push_str(&format!(
        "  <working_tree files=\"{}\" insertions=\"{}\" deletions=\"{}\">\n",
        wt.files_changed.max(wt.files.len()),
        wt.insertions,
        wt.deletions
    ));
    for f in &wt.files {
        s.push_str(&format!(
            "    <file status=\"{}\">{}</file>\n",
            xml_attr(&f.status),
            xml_text(&f.path)
        ));
    }
    s.push_str("  </working_tree>\n");

    if let Some(mem) = &c.memory {
        s.push_str("  <project_memory>");
        s.push_str(&xml_text(&serde_json::to_string(mem).unwrap_or_default()));
        s.push_str("</project_memory>\n");
    }

    if !c.recent_turns.is_empty() {
        s.push_str("  <recent_conversation>\n");
        for t in &c.recent_turns {
            s.push_str(&format!(
                "    <turn role=\"{}\">{}</turn>\n",
                xml_attr(&t.role),
                xml_text(&t.text)
            ));
        }
        s.push_str("  </recent_conversation>\n");
    }

    s.push_str("</aura_semantic_context>\n");
    s
}

/// Escape XML element text (`&`, `<`, `>`).
fn xml_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Escape an XML attribute value — element-text escaping plus `"`.
fn xml_attr(s: &str) -> String {
    xml_text(s).replace('"', "&quot;")
}

/// Result of an `--inject` write.
#[derive(Debug, Clone, serde::Serialize)]
pub struct InjectResult {
    pub path: String,
    pub created: bool,
}

/// Write the carryover markdown into the target agent's context file,
/// inside the idempotent `AURA:RESUME` marker section. Returns the path
/// and whether the file was created fresh.
pub fn inject(c: &AuraCarryover, agent: &str, repo_root: &Path) -> Result<InjectResult, String> {
    let file = repo_root.join(context_filename(agent));
    let existing = fs::read_to_string(&file).unwrap_or_default();
    let created = existing.is_empty();

    let body = format!("{MARKER_START}\n{}\n{MARKER_END}", to_markdown(c).trim_end());
    let merged = upsert_marker_section(&existing, &body);

    write_atomic(&file, &merged)?;
    Ok(InjectResult {
        path: file.to_string_lossy().to_string(),
        created,
    })
}

/// Map an agent name to the startup-context file it reads on launch.
fn context_filename(agent: &str) -> &'static str {
    match agent.trim().to_ascii_lowercase().as_str() {
        "claude" | "claude_code" | "claude-code" => "CLAUDE.md",
        "gemini" | "gemini_cli" | "gemini-cli" => "GEMINI.md",
        "cursor" => ".cursorrules",
        // Kimi auto-loads AGENTS.md (the cross-vendor standard), NOT a "KIMI.md"
        // — verified live: a sentinel in KIMI.md never reaches Kimi's context,
        // only AGENTS.md does. Its `--agent-file` flag is a YAML persona spec,
        // not a context file, so it can't be used to inject a carryover.
        // codex, opencode, kimi and unknown agents all read AGENTS.md.
        _ => "AGENTS.md",
    }
}

/// Startup-context filenames `inject` may write, paired with the agent
/// that reads each — the reverse of [`context_filename`], used by
/// [`find_resume_blocks`] to scan a repo for injected carryovers.
///
/// AGENTS.md is the shared cross-vendor file (codex, kimi, opencode all read
/// it); we label it "codex" only as a display fallback — the carryover body
/// names its real target agent. KIMI.md stays listed so `aura resume` can still
/// detect and consume blocks injected by older Aura versions that wrote it.
const CONTEXT_FILES: &[(&str, &str)] = &[
    ("CLAUDE.md", "claude"),
    ("GEMINI.md", "gemini"),
    ("AGENTS.md", "codex"),
    ("KIMI.md", "kimi"),
    (".cursorrules", "cursor"),
];

/// A context file in the repo carrying an injected `AURA:RESUME` block.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ResumeBlock {
    /// Absolute path to the context file.
    pub path: String,
    /// Agent the block was written for, inferred from the filename.
    pub agent: String,
    /// The carryover markdown inside the marker pair (markers stripped).
    pub body: String,
    /// File mtime as unix seconds — newest wins when several exist.
    pub modified: u64,
}

/// Scan `repo_root` for context files carrying an injected `AURA:RESUME`
/// block, newest first. Empty when no brain has injected a carryover.
pub fn find_resume_blocks(repo_root: &Path) -> Vec<ResumeBlock> {
    let mut out = Vec::new();
    for (file, agent) in CONTEXT_FILES {
        let path = repo_root.join(file);
        let Ok(content) = fs::read_to_string(&path) else { continue };
        let Some(body) = extract_marker_body(&content) else { continue };
        let modified = fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(ResumeBlock {
            path: path.to_string_lossy().to_string(),
            agent: (*agent).to_string(),
            body,
            modified,
        });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

/// Extract the text between the marker pair (markers themselves removed),
/// or `None` when the file has no complete `AURA:RESUME` section.
fn extract_marker_body(content: &str) -> Option<String> {
    let start = content.find(MARKER_START)?;
    let end = content.find(MARKER_END)?;
    if end < start {
        return None;
    }
    Some(content[start + MARKER_START.len()..end].trim().to_string())
}

/// Remove the `AURA:RESUME` marker section from `path`, preserving the
/// surrounding content, and return the carryover body it held. This is
/// the one-shot "consume" half of [`inject`]: a handoff is read once then
/// cleared, so a stale carryover never lingers in the context file and
/// re-triggers on the next launch.
pub fn consume(path: &Path) -> Result<String, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let body = extract_marker_body(&content)
        .ok_or_else(|| format!("no AURA:RESUME block in {}", path.display()))?;
    let stripped = strip_marker_section(&content);
    write_atomic(path, &stripped)?;
    Ok(body)
}

/// Remove the marker section from `existing`, rejoining the surrounding
/// content cleanly. Inverse of [`upsert_marker_section`].
fn strip_marker_section(existing: &str) -> String {
    if let (Some(start), Some(end)) = (existing.find(MARKER_START), existing.find(MARKER_END)) {
        if end >= start {
            let end_full = end + MARKER_END.len();
            let head = existing[..start].trim_end();
            let tail = existing[end_full..].trim_start();
            let mut out = String::with_capacity(existing.len());
            out.push_str(head);
            if !head.is_empty() && !tail.is_empty() {
                out.push_str("\n\n");
            }
            out.push_str(tail);
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            return out;
        }
    }
    existing.to_string()
}

/// Replace the marker section in `existing` if present, else append it.
fn upsert_marker_section(existing: &str, block: &str) -> String {
    if let (Some(start), Some(end)) = (existing.find(MARKER_START), existing.find(MARKER_END)) {
        if end >= start {
            let end_full = end + MARKER_END.len();
            let mut out = String::with_capacity(existing.len() + block.len());
            out.push_str(&existing[..start]);
            out.push_str(block);
            out.push_str(&existing[end_full..]);
            return out;
        }
    }
    if existing.trim().is_empty() {
        format!("{block}\n")
    } else {
        format!("{}\n\n{block}\n", existing.trim_end())
    }
}

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let tmp: PathBuf = path.with_extension("aura-resume.tmp");
    fs::write(&tmp, content).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename into {}: {e}", path.display()))
}

/// Format a unix timestamp as `YYYY-MM-DD HH:MM UTC`, falling back to the
/// raw seconds if chrono can't represent it.
fn fmt_ts(secs: u64) -> String {
    chrono::DateTime::from_timestamp(secs as i64, 0)
        .map(|dt| dt.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_else(|| secs.to_string())
}
