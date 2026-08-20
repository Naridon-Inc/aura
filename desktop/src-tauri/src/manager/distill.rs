//! Bucket M3 — Auto-distillation. When `tokens::compaction_plan` says
//! the older slice is worth compacting, this module:
//!   1. Builds a digest summary of the to-compact turns (heuristic — no
//!      LLM round-trip on the hot path; the brain's next reply already
//!      consumes a model call so we keep this side cheap).
//!   2. Archives the originals to
//!      `~/.aura/manager-sessions/<sid>.archive.jsonl` so
//!      `aura episodic-recall` can still find them later.
//!   3. Replaces the compactable turns in `session.chat` with one
//!      EpisodeDigest-anchored System turn. Anchored turns survive
//!      untouched.
//!
//! Pure-data API: caller passes a `&mut ManagerSession` and the
//! `CompactionPlan` produced by `tokens::compaction_plan`. The only I/O
//! is the archive append; if HOME is unset or the write fails we still
//! mutate the chat (the visible context tier is the load-bearing tier;
//! the archive is best-effort recall fodder).

use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

use super::tokens::CompactionPlan;
use super::{AnchorKind, ChatRole, ChatTurn, ManagerSession};

/// Produce a structured prose digest of a slice of ChatTurns. Heuristic,
/// no LLM round-trip on the hot path (the brain's next reply already
/// consumes a model call, so we keep this side deterministic and cheap).
///
/// Carries the substance a cross-engine handoff needs — not just role
/// counts. From the compacted (non-anchored) slice it pulls: the opening
/// objective, files touched, code symbols discussed, the secondary user
/// asks, and any still-open questions. Anchored decisions/answers are
/// preserved verbatim elsewhere, so they are deliberately NOT duplicated
/// here. Capped near ~1000 chars so the digest itself never dominates the
/// post-compaction chat.
pub fn heuristic_digest(turns: &[ChatTurn]) -> String {
    if turns.is_empty() {
        return String::new();
    }
    let mut user_count = 0usize;
    let mut manager_count = 0usize;
    let mut system_count = 0usize;
    for t in turns {
        match t.role {
            ChatRole::User => user_count += 1,
            ChatRole::Manager => manager_count += 1,
            ChatRole::System => system_count += 1,
        }
    }

    // Objective = the first user turn's opening (up to two lines, ~180 chars).
    let topic = turns
        .iter()
        .find(|t| matches!(t.role, ChatRole::User))
        .map(|t| {
            let head = t
                .text
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .take(2)
                .collect::<Vec<_>>()
                .join(" ");
            truncate_chars(&head, 180)
        })
        .unwrap_or_default();

    let span = turns.last().map(|t| t.at).unwrap_or(0)
        - turns.first().map(|t| t.at).unwrap_or(0);

    let files = extract_file_mentions(turns);
    let symbols = extract_symbols(turns, &files);
    let asks = secondary_user_asks(turns);
    let questions = unanswered_questions(turns);

    let mut out = String::new();
    out.push_str("Earlier in this session: ");
    if !topic.is_empty() {
        out.push_str(&format!("user opened with \"{topic}\". "));
    }
    out.push_str(&format!(
        "{} user / {} manager / {} system turns",
        user_count, manager_count, system_count
    ));
    if span > 0 {
        out.push_str(&format!(" over {} seconds", span));
    }
    out.push_str(". Originals archived for episodic recall.");

    if !files.is_empty() {
        out.push_str(&format!("\nFiles: {}", files.join(", ")));
    }
    if !symbols.is_empty() {
        out.push_str(&format!("\nSymbols: {}", symbols.join(", ")));
    }
    if !asks.is_empty() {
        let quoted: Vec<String> = asks.iter().map(|a| format!("\"{a}\"")).collect();
        out.push_str(&format!("\nAlso asked: {}", quoted.join("; ")));
    }
    if !questions.is_empty() {
        let quoted: Vec<String> = questions.iter().map(|q| format!("\"{q}\"")).collect();
        out.push_str(&format!("\nOpen questions: {}", quoted.join("; ")));
    }

    truncate_chars(&out, 1000)
}

/// File extensions we treat as a real file mention (keeps prose like
/// "e.g." or "v1.2" out of the Files line).
const FILE_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "rb", "php",
    "cs", "c", "h", "cpp", "hpp", "cc", "swift", "json", "toml", "yaml", "yml", "md",
    "mdx", "txt", "css", "scss", "html", "htm", "sh", "bash", "zsh", "sql", "lock",
    "xml", "vue", "svelte", "env", "ini", "cfg", "proto", "jsonl",
];

/// Truncate a string to at most `max` bytes on a char boundary, appending
/// an ellipsis if anything was cut.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max.min(s.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// Does this token look like a path/filename? Returns the cleaned token.
fn looks_like_file(raw: &str) -> Option<String> {
    let tok = raw.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '/' && c != '.' && c != '_' && c != '-');
    if tok.len() < 3 || tok.len() > 80 {
        return None;
    }
    if !tok
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-'))
    {
        return None;
    }
    let dot = tok.rfind('.')?;
    let ext = &tok[dot + 1..];
    let stem = &tok[..dot];
    if stem.is_empty() || ext.is_empty() {
        return None;
    }
    let ext_l = ext.to_ascii_lowercase();
    let known = FILE_EXTS.contains(&ext_l.as_str());
    // Accept either a known code extension, or any short alnum extension on
    // a token that carries a path separator (clearly a file path).
    if known || (tok.contains('/') && ext.len() <= 6 && ext.chars().all(|c| c.is_ascii_alphanumeric())) {
        Some(tok.to_string())
    } else {
        None
    }
}

/// Distinct files mentioned across the slice, most-frequent first, top 6.
fn extract_file_mentions(turns: &[ChatTurn]) -> Vec<String> {
    let mut freq: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for t in turns {
        for tok in t.text.split(|c: char| c.is_whitespace() || matches!(c, '`' | '(' | ')' | ',' | ';' | '"' | '\'')) {
            if let Some(f) = looks_like_file(tok) {
                if !freq.contains_key(&f) {
                    order.push(f.clone());
                }
                *freq.entry(f).or_insert(0) += 1;
            }
        }
    }
    rank_top(order, &freq, 6)
}

/// True if a backtick span looks like a code symbol (identifier-ish).
fn is_symbolish(s: &str) -> bool {
    let s = s.trim();
    if s.len() < 2 || s.len() > 48 {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '.' | '<' | '>' | '(' | ')' | '[' | ']' | '!'))
        && s.chars().any(|c| c.is_ascii_alphabetic())
}

/// Strip call parens / trailing punctuation off a symbol candidate.
fn bare_symbol(s: &str) -> String {
    s.trim()
        .trim_end_matches("()")
        .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != ':')
        .to_string()
}

/// Is this a mixed-case CamelCase identifier (e.g. `BrainError`)?
fn is_camel_case(s: &str) -> bool {
    s.len() >= 3
        && s.chars().all(|c| c.is_ascii_alphanumeric())
        && s.chars().any(|c| c.is_ascii_uppercase())
        && s.chars().any(|c| c.is_ascii_lowercase())
        && s.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false)
}

/// Code symbols discussed: backtick spans first, then bare CamelCase
/// tokens. Skips anything already listed as a file. Top 6 by frequency.
fn extract_symbols(turns: &[ChatTurn], skip_files: &[String]) -> Vec<String> {
    let mut freq: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let note = |sym: String, freq: &mut std::collections::HashMap<String, usize>, order: &mut Vec<String>| {
        if sym.is_empty() || skip_files.iter().any(|f| f == &sym) {
            return;
        }
        if !freq.contains_key(&sym) {
            order.push(sym.clone());
        }
        *freq.entry(sym).or_insert(0) += 1;
    };
    for t in turns {
        // Backtick spans: split on '`', odd-indexed parts are inside backticks.
        for (i, part) in t.text.split('`').enumerate() {
            if i % 2 == 1 && is_symbolish(part) {
                let bare = bare_symbol(part);
                if bare.len() >= 2 && looks_like_file(&bare).is_none() {
                    note(bare, &mut freq, &mut order);
                }
            }
        }
        // Standalone CamelCase tokens in prose.
        for tok in t.text.split(|c: char| !c.is_ascii_alphanumeric()) {
            if is_camel_case(tok) {
                note(tok.to_string(), &mut freq, &mut order);
            }
        }
    }
    rank_top(order, &freq, 6)
}

/// Secondary user asks (every user turn after the first), first line of
/// each, deduped, up to 3.
fn secondary_user_asks(turns: &[ChatTurn]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    let mut first_skipped = false;
    for t in turns {
        if !matches!(t.role, ChatRole::User) {
            continue;
        }
        if !first_skipped {
            first_skipped = true;
            continue;
        }
        let line = t
            .text
            .lines()
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
            .unwrap_or("");
        if line.is_empty() {
            continue;
        }
        let trimmed = truncate_chars(line, 90);
        if seen.insert(trimmed.clone()) {
            out.push(trimmed);
        }
        if out.len() >= 3 {
            break;
        }
    }
    out
}

/// Questions the assistant posed whose last line ends with '?', up to 2.
fn unanswered_questions(turns: &[ChatTurn]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in turns {
        if !matches!(t.role, ChatRole::Manager) {
            continue;
        }
        let last = t
            .text
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .last()
            .unwrap_or("");
        if last.ends_with('?') {
            out.push(truncate_chars(last, 90));
        }
        if out.len() >= 2 {
            break;
        }
    }
    out
}

/// Sort candidates by frequency desc (stable on first-seen order), top n.
fn rank_top(
    order: Vec<String>,
    freq: &std::collections::HashMap<String, usize>,
    n: usize,
) -> Vec<String> {
    let mut ranked = order;
    ranked.sort_by(|a, b| freq.get(b).cmp(&freq.get(a)));
    ranked.truncate(n);
    ranked
}

fn archive_path(session_id: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".aura");
    p.push("manager-sessions");
    p.push(format!("{session_id}.archive.jsonl"));
    Some(p)
}

/// Append the to-be-compacted turns to the session's archive.jsonl.
/// Best-effort: returns Err but does not panic on I/O failure. Caller
/// proceeds with the in-memory replacement regardless.
pub fn archive_turns(session_id: &str, turns: &[&ChatTurn]) -> Result<(), String> {
    let path = archive_path(session_id).ok_or("HOME not set")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    for t in turns {
        let line = serde_json::to_string(*t)
            .map_err(|e| format!("serialize turn: {e}"))?;
        f.write_all(line.as_bytes())
            .map_err(|e| format!("write archive: {e}"))?;
        f.write_all(b"\n")
            .map_err(|e| format!("write archive newline: {e}"))?;
    }
    Ok(())
}

/// Apply a CompactionPlan: archive the compactable turns, then replace
/// them in `session.chat` with a single EpisodeDigest System turn.
/// Returns the digest text inserted, or `None` if the plan was a no-op.
pub fn apply_compaction(session: &mut ManagerSession, plan: &CompactionPlan) -> Option<String> {
    if !plan.worth_compacting || plan.compact_indices.is_empty() {
        return None;
    }

    let to_compact: Vec<&ChatTurn> = plan
        .compact_indices
        .iter()
        .filter_map(|&i| session.chat.get(i))
        .collect();

    let digest_text = heuristic_digest(&to_compact.iter().map(|t| (*t).clone()).collect::<Vec<_>>());

    // Best-effort archive — mutation proceeds either way.
    let _ = archive_turns(&session.id, &to_compact);

    // Remove from highest index down so earlier indices stay valid.
    let drop: HashSet<usize> = plan.compact_indices.iter().copied().collect();
    let insert_at = plan.compact_indices.iter().min().copied().unwrap_or(0);
    let mut kept = Vec::with_capacity(session.chat.len() - drop.len() + 1);
    for (i, turn) in session.chat.drain(..).enumerate() {
        if !drop.contains(&i) {
            kept.push(turn);
        }
    }

    let digest_turn = ChatTurn {
        role: ChatRole::System,
        text: digest_text.clone(),
        at: super::now_secs(),
        answered_question: None,
        anchor: Some(AnchorKind::EpisodeDigest),
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
    };
    let insert_index = insert_at.min(kept.len());
    kept.insert(insert_index, digest_turn);
    session.chat = kept;
    session.touch();
    Some(digest_text)
}

#[cfg(test)]
mod tests {
    use super::super::tokens::compaction_plan;
    use super::*;

    fn turn(role: ChatRole, text: &str, anchor: Option<AnchorKind>, at: u64) -> ChatTurn {
        ChatTurn {
            role,
            text: text.to_string(),
            at,
            answered_question: None,
            anchor,
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
        }
    }

    fn empty_session() -> ManagerSession {
        ManagerSession::new("test-sid".into(), "objective".into(), vec![], vec![])
    }

    #[test]
    fn digest_summarises_role_distribution() {
        let turns = vec![
            turn(ChatRole::User, "How do I auth users?", None, 100),
            turn(ChatRole::Manager, "JWT.", None, 110),
            turn(ChatRole::User, "Cookie or header?", None, 120),
        ];
        let d = heuristic_digest(&turns);
        assert!(d.contains("How do I auth users"));
        assert!(d.contains("2 user"));
        assert!(d.contains("1 manager"));
    }

    #[test]
    fn apply_compaction_replaces_with_digest() {
        let mut s = empty_session();
        // 12 boring older turns + 5 hot. Older slice is non-anchored.
        for i in 0..12 {
            s.push_chat(ChatRole::User, format!("turn {i}"));
        }
        for i in 12..17 {
            s.push_chat(ChatRole::Manager, format!("reply {i}"));
        }
        let plan = compaction_plan(&s.chat, 5);
        assert!(plan.worth_compacting);
        let digest = apply_compaction(&mut s, &plan).expect("digest produced");
        assert!(digest.starts_with("Earlier in this session"));
        // 17 - 12 + 1 = 6 turns remain (5 hot + 1 digest).
        assert_eq!(s.chat.len(), 6);
        // First turn is the digest.
        assert!(matches!(
            s.chat[0].anchor,
            Some(AnchorKind::EpisodeDigest)
        ));
        assert!(matches!(s.chat[0].role, ChatRole::System));
    }

    #[test]
    fn apply_compaction_preserves_anchors() {
        let mut s = empty_session();
        // Older slice: 9 boring + 1 anchored at index 5.
        for i in 0..10 {
            if i == 5 {
                s.push_anchored(
                    ChatRole::Manager,
                    "PIN ME".into(),
                    AnchorKind::PlanDecision,
                );
            } else {
                s.push_chat(ChatRole::User, format!("t{i}"));
            }
        }
        // 5 hot
        for i in 10..15 {
            s.push_chat(ChatRole::Manager, format!("r{i}"));
        }
        let plan = compaction_plan(&s.chat, 5);
        assert!(plan.worth_compacting);
        apply_compaction(&mut s, &plan);
        // PIN ME survives.
        assert!(s.chat.iter().any(|t| t.text == "PIN ME"));
        // Digest exists.
        assert!(s.chat.iter().any(|t| matches!(
            t.anchor,
            Some(AnchorKind::EpisodeDigest)
        )));
    }

    #[test]
    fn apply_compaction_noops_below_threshold() {
        let mut s = empty_session();
        for i in 0..10 {
            s.push_chat(ChatRole::User, format!("t{i}"));
        }
        let plan = compaction_plan(&s.chat, 5);
        assert!(!plan.worth_compacting);
        let result = apply_compaction(&mut s, &plan);
        assert!(result.is_none());
        assert_eq!(s.chat.len(), 10);
    }

    #[test]
    fn digest_carries_files_and_symbols() {
        let turns = vec![
            turn(
                ChatRole::User,
                "Compaction skipped in cmd_brain_chat.rs — wire `maybe_compact_for_turn` like legacy.rs does.",
                None,
                100,
            ),
            turn(
                ChatRole::Manager,
                "Done. The native path now calls `maybe_compact_session_inner` before rebuilding from distill.rs.",
                None,
                110,
            ),
        ];
        let d = heuristic_digest(&turns);
        assert!(d.contains("Files:"), "digest: {d}");
        assert!(d.contains("cmd_brain_chat.rs"), "digest: {d}");
        assert!(d.contains("legacy.rs"), "digest: {d}");
        assert!(d.contains("Symbols:"), "digest: {d}");
        assert!(d.contains("maybe_compact_for_turn"), "digest: {d}");
    }

    #[test]
    fn digest_excludes_prose_dotted_tokens() {
        // "e.g." and "v1.2" are NOT files; they must not pollute the Files line.
        let turns = vec![turn(
            ChatRole::User,
            "Use it e.g. for v1.2 builds, nothing else.",
            None,
            100,
        )];
        let d = heuristic_digest(&turns);
        assert!(!d.contains("Files:"), "digest leaked prose tokens: {d}");
    }

    #[test]
    fn digest_lists_secondary_asks_and_open_questions() {
        let turns = vec![
            turn(ChatRole::User, "Build the continuity spine.", None, 100),
            turn(ChatRole::Manager, "Which engine should be primary?", None, 110),
            turn(ChatRole::User, "Are token savings measured?", None, 120),
        ];
        let d = heuristic_digest(&turns);
        assert!(d.contains("Also asked:"), "digest: {d}");
        assert!(d.contains("Are token savings measured?"), "digest: {d}");
        assert!(d.contains("Open questions:"), "digest: {d}");
        assert!(d.contains("Which engine should be primary?"), "digest: {d}");
    }
}
