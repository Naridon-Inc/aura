//! Claude Code history: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
//!
//! The directory name is a lossy encoding of the working directory (every
//! non-alphanumeric byte becomes `-`), so it cannot be decoded back into a
//! path. We read `cwd` and `gitBranch` off the rows themselves instead, which
//! are exact.
//!
//! Transcripts get very large — a long session is hundreds of thousands of
//! lines, most of them file snapshots and hook records. Both passes below
//! prefilter on the raw line before parsing JSON, so a scan touches serde only
//! for the handful of row types that carry what we want.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use super::{
    claude_dir_name, head_rows, home, is_injected_text, message_text, mtime_secs, parse_ts,
    stale_for, History, Prompt, Scope, Session,
};

pub struct Claude;

/// Row types worth parsing. Everything else in a transcript — file snapshots,
/// hook records, permission-mode flips, queue operations — is skipped without
/// touching serde.
const WANTED: &[&str] = &["\"user\"", "\"assistant\"", "\"ai-title\""];

fn line_is_interesting(line: &str) -> bool {
    WANTED.iter().any(|t| line.contains(t))
}

/// Rows a prompt scan can rule out without parsing them.
///
/// The expensive rows in a transcript are exactly the ones that are never a
/// prompt: a `toolUseResult` can carry a whole file, and handing serde a
/// megabyte to learn it is not a prompt is most of what a scan costs.
///
/// Matching is on the raw JSON *key* — quote, name, quote, colon — which
/// cannot appear inside a string value, because there the quotes are escaped.
/// So a person who types the word `toolUseResult` at Claude still has their
/// prompt read back to them.
fn ruled_out(line: &str) -> bool {
    const KEYS: &[&str] = &[
        "\"toolUseResult\":",
        "\"isMeta\":true",
        "\"isSidechain\":true",
        "\"isCompactSummary\":true",
    ];
    !line.contains("\"user\"") || KEYS.iter().any(|k| line.contains(k))
}

/// Is this row a prompt the person actually typed?
///
/// A `type: "user"` row is *not* automatically a prompt. Claude writes tool
/// results, compaction summaries, sidechain (subagent) turns and injected meta
/// rows under the same type. Counting those as prompts would report a session
/// driven by one instruction as having had ninety.
/// `pub(crate)` so the manifest dialect's tests can check themselves against
/// it: the worked example in `docs/dialects/claude-code.json` is only a proof
/// that the manifest format is expressive enough if it classifies rows exactly
/// the way the compiled dialect does.
pub(crate) fn is_typed_prompt(o: &serde_json::Value) -> bool {
    if o.get("type").and_then(|t| t.as_str()) != Some("user") {
        return false;
    }
    for flag in ["isMeta", "isSidechain", "isCompactSummary", "isVisibleInTranscriptOnly"] {
        if o.get(flag).and_then(|b| b.as_bool()).unwrap_or(false) {
            return false;
        }
    }
    // Present only on rows that carry a tool's output back to the model.
    if o.get("toolUseResult").is_some() {
        return false;
    }
    true
}

struct Scan {
    cwd: Option<String>,
    branch: Option<String>,
    title: Option<String>,
    first_ts: u64,
    last_ts: u64,
    prompts: usize,
    steps: usize,
}

fn scan(path: &PathBuf) -> Option<Scan> {
    let file = std::fs::File::open(path).ok()?;
    let mut s = Scan {
        cwd: None,
        branch: None,
        title: None,
        first_ts: 0,
        last_ts: 0,
        prompts: 0,
        steps: 0,
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if !line_is_interesting(&line) {
            continue;
        }
        let Ok(o) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        match o.get("type").and_then(|t| t.as_str()) {
            Some("ai-title") => {
                s.title = o.get("aiTitle").and_then(|t| t.as_str()).map(|t| t.to_string());
                continue;
            }
            Some("assistant") => s.steps += 1,
            Some("user") => {
                if is_typed_prompt(&o) {
                    let text = message_text(o.get("message").unwrap_or(&serde_json::Value::Null));
                    if !text.is_empty() && !is_injected_text(&text) {
                        s.prompts += 1;
                    }
                }
            }
            _ => continue,
        }
        if s.cwd.is_none() {
            s.cwd = o.get("cwd").and_then(|c| c.as_str()).map(|c| c.to_string());
        }
        if s.branch.is_none() {
            s.branch = o
                .get("gitBranch")
                .and_then(|b| b.as_str())
                .filter(|b| !b.is_empty())
                .map(|b| b.to_string());
        }
        if let Some(ts) = o.get("timestamp") {
            let t = parse_ts(ts);
            if t > 0 {
                if s.first_ts == 0 {
                    s.first_ts = t;
                }
                s.last_ts = t;
            }
        }
    }
    Some(s)
}

/// Where and when, from the head of the file and its mtime.
///
/// The first rows carry `cwd` and `gitBranch`, and the mtime is when the
/// transcript was last appended to — which is what "last activity" means for a
/// file a live session writes to. Neither needs the body.
fn locate(path: PathBuf) -> Option<Session> {
    let head = head_rows(&path, 40);
    let id = path.file_stem()?.to_str()?.to_string();
    let cwd = head
        .iter()
        .find_map(|o| o.get("cwd").and_then(|c| c.as_str()))
        .map(|c| c.to_string());
    let branch = head
        .iter()
        .find_map(|o| o.get("gitBranch").and_then(|b| b.as_str()))
        .filter(|b| !b.is_empty())
        .map(|b| b.to_string());
    let started_at = head
        .iter()
        .filter_map(|o| o.get("timestamp").map(parse_ts))
        .find(|t| *t > 0)
        .unwrap_or(0);
    Some(Session {
        dialect: "claude",
        id,
        cwd,
        cwd_digest: None,
        branch,
        title: None,
        started_at,
        last_activity_at: mtime_secs(&path),
        prompts: None,
        steps: None,
        path,
    })
}

impl History for Claude {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn display(&self) -> &'static str {
        "Claude Code"
    }

    fn root(&self) -> Option<PathBuf> {
        let p = home()?.join(".claude").join("projects");
        p.is_dir().then_some(p)
    }

    fn index(&self, scope: &Scope) -> Vec<Session> {
        let Some(root) = self.root() else {
            return Vec::new();
        };
        // The directory name encodes the working directory, so a repo-scoped
        // caller reads one project's transcripts instead of every project the
        // machine has ever opened. On a working laptop that is the difference
        // between megabytes and tens of gigabytes.
        let want = scope
            .repo_root
            .as_ref()
            .map(|r| claude_dir_name(r.to_string_lossy().trim_end_matches('/')));

        let mut out = Vec::new();
        let Ok(projects) = std::fs::read_dir(&root) else {
            return out;
        };
        for project in projects.flatten() {
            if let Some(want) = &want {
                let name = project.file_name();
                let name = name.to_string_lossy();
                // Prefix, not equality: a session started in a subdirectory of
                // the repo encodes to the repo's name plus a suffix.
                if !name.starts_with(want.as_str()) {
                    continue;
                }
            }
            let Ok(files) = std::fs::read_dir(project.path()) else {
                continue;
            };
            for f in files.flatten() {
                let path = f.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                if stale_for(&path, scope) {
                    continue;
                }
                let Some(session) = locate(path) else { continue };
                if scope.keeps(&session) {
                    out.push(session);
                }
            }
        }
        out.sort_by_key(|s| s.last_activity_at);
        out
    }

    fn count(&self, session: Session) -> Session {
        let Some(s) = scan(&session.path) else {
            return session;
        };
        Session {
            // The full read is authoritative about the times too: mtime is a
            // good enough bound for choosing a file, not for reporting one.
            started_at: if s.first_ts > 0 { s.first_ts } else { session.started_at },
            last_activity_at: if s.last_ts > 0 { s.last_ts } else { session.last_activity_at },
            branch: s.branch.or(session.branch),
            title: s.title.or(session.title),
            prompts: Some(s.prompts),
            steps: Some(s.steps),
            ..session
        }
    }

    /// A transcript is named `<id>.jsonl`, so finding one is a stat per project
    /// directory rather than a read of every transcript on the disk.
    fn session_by_id(&self, id: &str) -> Option<Session> {
        let root = self.root()?;
        for project in std::fs::read_dir(&root).ok()?.flatten() {
            let path = project.path().join(format!("{id}.jsonl"));
            if path.is_file() {
                return locate(path);
            }
        }
        None
    }

    fn prompts(&self, session: &Session) -> Vec<Prompt> {
        let Ok(file) = std::fs::File::open(&session.path) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if ruled_out(&line) {
                continue;
            }
            let Ok(o) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if !is_typed_prompt(&o) {
                continue;
            }
            let text = message_text(o.get("message").unwrap_or(&serde_json::Value::Null));
            if text.is_empty() || is_injected_text(&text) {
                continue;
            }
            let at = o.get("timestamp").map(parse_ts).unwrap_or(0);
            out.push(Prompt { at, text });
        }
        out
    }

    /// Walks the transcript backwards and stops at the answer.
    ///
    /// The rows are append-only and in order, so the last prompt at or before
    /// `at` is found by reading the tail — and the prompts that came after it
    /// are exactly the ones stepped over on the way. A long session costs the
    /// same as a short one, because what is read is the distance back to the
    /// answer, not the length of the file.
    fn prompt_before(&self, session: &Session, at: u64) -> Option<(Prompt, usize)> {
        let mut after = 0usize;
        let mut newest: Option<Prompt> = None;
        let mut found: Option<Prompt> = None;
        super::rev_lines(&session.path, |line| {
            if ruled_out(line) {
                return true;
            }
            let Ok(o) = serde_json::from_str::<serde_json::Value>(line) else {
                return true;
            };
            if !is_typed_prompt(&o) {
                return true;
            }
            let text = message_text(o.get("message").unwrap_or(&serde_json::Value::Null));
            if text.is_empty() || is_injected_text(&text) {
                return true;
            }
            let p = Prompt { at: o.get("timestamp").map(parse_ts).unwrap_or(0), text };
            if newest.is_none() {
                newest = Some(p.clone());
            }
            // A row with no clock cannot be placed either side of the anchor,
            // so it is neither the answer nor counted as following it.
            if p.at == 0 {
                return true;
            }
            if at == 0 || p.at <= at {
                found = Some(p);
                return false;
            }
            after += 1;
            true
        });
        found.map(|p| (p, after)).or_else(|| newest.map(|p| (p, 0)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(v: serde_json::Value) -> serde_json::Value {
        v
    }

    #[test]
    fn a_tool_result_is_not_something_the_person_typed() {
        // Claude files tool output under type "user". Counting it as a prompt
        // is how a one-instruction session reports ninety.
        assert!(!is_typed_prompt(&row(serde_json::json!({
            "type": "user",
            "toolUseResult": {"stdout": "ok"},
            "message": {"role": "user", "content": "ok"}
        }))));
        assert!(is_typed_prompt(&row(serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": "fix it"}
        }))));
    }

    #[test]
    fn subagent_and_compaction_turns_are_not_prompts() {
        for flag in ["isSidechain", "isCompactSummary", "isMeta"] {
            let mut o = serde_json::json!({"type": "user", "message": {"content": "x"}});
            o[flag] = serde_json::json!(true);
            assert!(!is_typed_prompt(&o), "{flag} should disqualify a row");
        }
    }

    #[test]
    fn an_assistant_row_is_never_a_prompt() {
        assert!(!is_typed_prompt(&row(serde_json::json!({
            "type": "assistant",
            "message": {"content": "sure"}
        }))));
    }

    #[test]
    fn harness_injected_text_is_not_a_request() {
        assert!(is_injected_text("<command-name>/clear</command-name>"));
        assert!(is_injected_text("<system-reminder>be careful</system-reminder>"));
        assert!(is_injected_text("  <local-command-stdout>x"));
        assert!(!is_injected_text("write a <command> parser"));
    }

    #[test]
    fn a_message_that_is_only_a_tag_block_was_assembled_by_a_program() {
        // Found in a live transcript, and it read as the person's request
        // until this rule existed.
        assert!(is_injected_text(
            "<task-notification>\n<task-id>bt4</task-id>\n</task-notification>"
        ));
        // Any block-shaped injection, not just the ones we have met.
        assert!(is_injected_text("<hook-output>ran 4 checks</hook-output>"));
        // Words around a tag mean a person wrote it.
        assert!(!is_injected_text("fix <div> nesting in the header</div> please"));
        assert!(!is_injected_text("why is <task-notification> in my prompt output?"));
        // Known harness markers are judged on their prefix alone, so a message
        // that opens with one is dropped even if a person typed it deliberately.
        // That trade is on purpose: reading an injected block back to someone as
        // "what you asked for" is a worse failure than losing a rare message
        // that happens to begin with a marker.
        assert!(is_injected_text("<system-reminder> is showing up in why output"));
    }

    #[test]
    fn the_prefilter_keeps_every_row_type_the_scan_reads() {
        // If this drifts, the scan silently stops counting — the failure mode
        // is a session that reports zero steps, not an error.
        assert!(line_is_interesting(r#"{"type":"user","message":{}}"#));
        assert!(line_is_interesting(r#"{"type":"assistant","message":{}}"#));
        assert!(line_is_interesting(r#"{"type":"ai-title","aiTitle":"x"}"#));
        assert!(!line_is_interesting(r#"{"type":"file-history-snapshot"}"#));
    }
}
