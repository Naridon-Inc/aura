//! Reading an agent CLI's own session history off disk.
//!
//! # Why this exists
//!
//! Aura learns what an agent *did* from hooks — an intent row per tool call.
//! It never learns what the person *asked for*. The prompt lives in the agent's
//! own transcript, in the agent's own format, in the agent's own directory, and
//! until now nothing in the CLI read it.
//!
//! That gap costs us twice:
//!
//! 1. **`aura why`** can say a function changed and what the agent declared it
//!    was doing, but not what was asked. Intent-vs-prompt divergence is the
//!    thing Aura exists to catch; we were holding one half of the comparison.
//! 2. **`aura import`** has nothing to import. A fresh install shows an empty
//!    console, which argues against the product's own pitch, while months of
//!    real agent history sit on the same disk.
//!
//! # The contract
//!
//! A dialect answers three questions: *where does your history live*, *what
//! sessions are in it*, and *what did the person type*. That is the whole
//! [`History`] trait. Adding a seventh agent is one file implementing it plus
//! one line in [`dialects`] — not a patch spread through the CLI. This is the
//! read half of the agent-plugin contract; the write half (hooks, stamping)
//! lives in the `aura-hooks` crate. See `docs/AGENT_PLUGINS.md`.
//!
//! # Privacy
//!
//! Prompt text is the user's own words, and transcripts also hold model
//! output, tool results and file contents. Everything here reads locally and
//! returns owned strings to a caller that decides what to show. Nothing in
//! this module sends anything anywhere, and `aura import` keeps bodies on
//! disk unless the operator asks otherwise.

use std::path::{Path, PathBuf};

pub mod claude;
pub mod codex;
pub mod kimi;
pub mod manifest;
pub mod opencode;

/// One thing the person typed, and when.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    /// Unix seconds. 0 when the dialect records no clock for this row.
    pub at: u64,
    pub text: String,
}

/// One session as the agent recorded it, normalised across dialects.
///
/// `cwd` is the field that makes a session belong to a repo. A dialect that
/// cannot tell us where it ran leaves it `None`, and callers scoped to one
/// repo skip it rather than guessing — a mis-attributed session is worse than
/// a missing one.
#[derive(Debug, Clone)]
pub struct Session {
    pub dialect: &'static str,
    pub id: String,
    pub cwd: Option<String>,
    /// Some dialects record where they ran as a digest rather than a path —
    /// Kimi names its session directory `md5(cwd)`. The path cannot be
    /// recovered from it, but the only question callers actually ask —
    /// *did this run in this repo?* — still has an exact answer.
    pub cwd_digest: Option<String>,
    pub branch: Option<String>,
    pub title: Option<String>,
    pub started_at: u64,
    pub last_activity_at: u64,
    /// Prompts the person typed. Not turns — a deep run off one prompt is one.
    ///
    /// `None` means *not counted*, which is what a cheap listing returns. It is
    /// modelled as absent rather than as `0` because a listing that reported
    /// zero prompts would be stating something false about the session, and
    /// every caller that shows a count would repeat it.
    pub prompts: Option<usize>,
    /// Assistant steps, i.e. how much work the agent actually did. `None` when
    /// not counted, for the same reason as [`Session::prompts`].
    pub steps: Option<usize>,
    pub path: PathBuf,
}

impl Session {
    /// Did this session run inside `repo_root`?
    ///
    /// Prefix match, because agents run in subdirectories of a repo all the
    /// time and a session started in `repo/aura-cli` is still that repo's work.
    pub fn ran_in(&self, repo_root: &Path) -> bool {
        let root = repo_root.to_string_lossy();
        let root = root.trim_end_matches('/');
        if let Some(cwd) = self.cwd.as_deref() {
            return cwd == root || cwd.starts_with(&format!("{root}/"));
        }
        // A digest matches only the exact directory, never a subdirectory —
        // there is no prefix to test. That is a real limit, not a bug: a Kimi
        // session started one level down is not claimed by this repo rather
        // than being claimed by the wrong one.
        match self.cwd_digest.as_deref() {
            Some(d) => d == cwd_digest(root),
            None => false,
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "dialect": self.dialect,
            "id": self.id,
            "cwd": self.cwd,
            "cwd_digest": self.cwd_digest,
            "branch": self.branch,
            "title": self.title,
            "started_at": self.started_at,
            "last_activity_at": self.last_activity_at,
            "prompts": self.prompts,
            "steps": self.steps,
            "path": self.path.to_string_lossy(),
        })
    }
}

/// What a caller actually wants back, so a dialect can prune before reading.
///
/// This is not an optimisation detail — it is the difference between a command
/// that answers and one that never returns. A working machine holds tens of
/// gigabytes of transcripts across every repo its owner has ever opened, and
/// `aura why` needs *one* session in *one* repo at *one* moment. Reading
/// everything to then discard almost all of it is not a slow answer, it is no
/// answer.
///
/// Both filters are honest prefilters: each dialect narrows by whatever it
/// encodes in its own paths, then [`Scope::keeps`] applies the real test to
/// what survived. A dialect that can prune nothing is still correct, just slower.
#[derive(Debug, Clone, Default)]
pub struct Scope {
    /// Only sessions that ran in this repo (or a subdirectory of it).
    pub repo_root: Option<PathBuf>,
    /// Only sessions still active at or after this moment (unix seconds).
    pub active_after: Option<u64>,
}

impl Scope {
    /// Everything on disk. Expensive by construction — say so at the call site.
    pub fn all() -> Self {
        Self::default()
    }

    pub fn repo(root: &Path) -> Self {
        Self { repo_root: Some(root.to_path_buf()), active_after: None }
    }

    pub fn since(mut self, at: u64) -> Self {
        self.active_after = Some(at);
        self
    }

    /// The real test, applied after a dialect's cheap pruning.
    pub fn keeps(&self, s: &Session) -> bool {
        if let Some(root) = &self.repo_root {
            if !s.ran_in(root) {
                return false;
            }
        }
        if let Some(at) = self.active_after {
            if s.last_activity_at < at {
                return false;
            }
        }
        true
    }
}

/// What one agent CLI's history looks like on disk.
pub trait History {
    /// Stable lower-case id, e.g. `claude`. Matches the hook dialect id.
    fn id(&self) -> &'static str;
    /// What a person calls it, e.g. `Claude Code`.
    fn display(&self) -> &'static str;
    /// Where this dialect keeps history, or `None` when it is not installed.
    fn root(&self) -> Option<PathBuf>;
    /// Locate sessions matching `scope` without reading their bodies.
    ///
    /// This is the method that has to be cheap. Where a session ran and when it
    /// was last touched are answerable from a directory name, a filename and a
    /// stat, plus the first few rows of a file — so a caller looking for one
    /// session at one moment pays for a handful of reads, not for eleven
    /// gigabytes of transcript. Counts come back `None`; use [`History::count`]
    /// when they are actually wanted.
    ///
    /// An implementation must honour [`Scope::keeps`]; narrowing before that
    /// using whatever the dialect encodes in its paths is what makes this
    /// usable on a real machine.
    fn index(&self, scope: &Scope) -> Vec<Session>;

    /// Read a located session's body: fill in the counts, and the title where
    /// only the body carries one.
    fn count(&self, session: Session) -> Session;

    /// Every matching session, fully read. Convenient and expensive — this is
    /// what `aura import` wants and what an interactive lookup should avoid.
    fn sessions(&self, scope: &Scope) -> Vec<Session> {
        self.index(scope).into_iter().map(|s| self.count(s)).collect()
    }

    /// One session by id, without reading the rest.
    ///
    /// Every dialect names a session's file or directory after its id, so this
    /// is a path probe rather than a search. The default scans, which is
    /// correct but slow; a dialect that can probe should override it.
    fn session_by_id(&self, id: &str) -> Option<Session> {
        self.index(&Scope::all()).into_iter().find(|s| s.id == id)
    }
    /// What the person typed in one session, oldest first.
    ///
    /// Reads the whole transcript. Callers that want one prompt should use
    /// [`History::prompt_before`], which does not.
    fn prompts(&self, session: &Session) -> Vec<Prompt>;

    /// The last prompt at or before `at`, and how many followed it.
    ///
    /// This is what `aura why` actually asks, and asking it as "give me every
    /// prompt, then filter" reads the entire transcript — which for a long
    /// session is gigabytes, and turns a lookup into a coffee break. A dialect
    /// whose transcript is a single append-only file can answer by walking
    /// backwards from the end and stopping at the first match, so the cost is
    /// set by how far back the answer is rather than by how long the session ran.
    ///
    /// The default is correct and slow; overriding it is a performance
    /// decision, never a behavioural one.
    fn prompt_before(&self, session: &Session, at: u64) -> Option<(Prompt, usize)> {
        let all = self.prompts(session);
        let p = prompt_at(&all, at)?.clone();
        let after = all.iter().filter(|q| q.at > p.at).count();
        Some((p, after))
    }
}

/// The dialects compiled into Aura.
///
/// Order is stable so output is stable. Gemini is deliberately absent: its
/// `~/.gemini/tmp/<hash>/` directories hold a `.project_root` marker and no
/// transcript, so there is nothing to read — a dialect that would always
/// return zero sessions is worse than an honest omission, because it reads as
/// a bug rather than as "that agent does not keep history".
pub fn builtin() -> Vec<Box<dyn History>> {
    vec![
        Box::new(claude::Claude),
        Box::new(codex::Codex),
        Box::new(kimi::Kimi),
        Box::new(opencode::OpenCode),
    ]
}

/// Every dialect Aura can read history from: the compiled ones, then whatever
/// `~/.aura/dialects/` describes.
///
/// Built-ins come first and cannot be shadowed — see `manifest::discover`.
/// A manifest that fails to load is skipped here rather than reported; `aura
/// dialects` is where the reasons are shown, because a command answering a
/// different question should not print someone's config errors into its output.
pub fn dialects() -> Vec<Box<dyn History>> {
    let mut all = builtin();
    let (extra, _bad) = manifest::discover();
    for d in extra {
        all.push(Box::new(d));
    }
    all
}

/// The dialects actually present on this machine.
pub fn installed() -> Vec<Box<dyn History>> {
    dialects().into_iter().filter(|d| d.root().is_some()).collect()
}

/// Find one session by id across every dialect.
///
/// Ids are UUID-shaped in every dialect we read, so a collision across two
/// agents is not a practical concern; first match wins in [`dialects`] order.
pub fn find_session(id: &str) -> Option<(Box<dyn History>, Session)> {
    for d in dialects() {
        if let Some(s) = d.session_by_id(id) {
            return Some((d, s));
        }
    }
    None
}

/// The last thing the person typed at or before `at`.
///
/// This is the join that answers "what was asked for": an intent row carries
/// the session id and the moment the edit happened, and the prompt that caused
/// it is the most recent one preceding it. Falls back to the final prompt when
/// no timestamp is usable, because a dialect that records no per-row clock
/// still has exactly one prompt in flight at the end of a session.
pub fn prompt_at(prompts: &[Prompt], at: u64) -> Option<&Prompt> {
    if at == 0 {
        return prompts.last();
    }
    prompts
        .iter()
        .filter(|p| p.at != 0 && p.at <= at)
        .max_by_key(|p| p.at)
        .or_else(|| prompts.last())
}

/// How a dialect that hides its working directory names it: `md5(path)`.
///
/// Verified against a live Kimi tree — its `~/.kimi/sessions/<hash>/` and
/// `~/.kimi/user-history/<hash>.jsonl` are both keyed this way.
pub(crate) fn cwd_digest(path: &str) -> String {
    format!("{:x}", md5::compute(path.as_bytes()))
}

/// `$HOME`, or `None` where there is none (a daemon, a sandbox, CI).
pub(crate) fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|p| p.is_dir())
}

/// A file's last-modified time in unix seconds, or 0 when it cannot be read.
pub(crate) fn mtime_secs(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Can this file be skipped without opening it?
///
/// A transcript is appended to as the session runs, so its mtime is that
/// session's last activity. A file untouched since before the moment we care
/// about cannot contain a session that was live at it. Unreadable metadata
/// reads as 0 and is never skipped — cheapness must not cost correctness.
pub(crate) fn stale_for(path: &Path, scope: &Scope) -> bool {
    match scope.active_after {
        Some(at) => {
            let m = mtime_secs(path);
            m != 0 && m < at
        }
        None => false,
    }
}

/// Visit a file's lines from the last to the first.
///
/// `f` returns `false` to stop, which is the whole point: a caller looking for
/// the most recent row matching something reads the tail of the file and stops,
/// instead of streaming a multi-gigabyte transcript it will throw away.
///
/// Chunked from the end, carrying the partial line at a chunk's head into the
/// next read so no line is ever split across two calls.
pub(crate) fn rev_lines<F: FnMut(&str) -> bool>(path: &Path, mut f: F) {
    use std::io::{Read, Seek, SeekFrom};
    const CHUNK: u64 = 256 * 1024;

    let Ok(mut file) = std::fs::File::open(path) else {
        return;
    };
    let Ok(len) = file.seek(SeekFrom::End(0)) else {
        return;
    };
    let mut pos = len;
    // Bytes from the previous (later) chunk that belong to a line whose start
    // is in the chunk we are about to read.
    let mut carry: Vec<u8> = Vec::new();

    while pos > 0 {
        let take = CHUNK.min(pos);
        pos -= take;
        if file.seek(SeekFrom::Start(pos)).is_err() {
            return;
        }
        let mut buf = vec![0u8; take as usize];
        if file.read_exact(&mut buf).is_err() {
            return;
        }
        buf.extend_from_slice(&carry);

        // Line boundaries as ranges rather than owned copies: a transcript is
        // hundreds of megabytes, and allocating a Vec per line to throw it away
        // one predicate later costs more than the read did.
        let mut breaks: Vec<usize> = vec![0];
        breaks.extend(buf.iter().enumerate().filter(|(_, b)| **b == b'\n').map(|(i, _)| i + 1));
        breaks.push(buf.len() + 1);

        // The first range is a fragment whose start is in the chunk we have not
        // read yet — unless this chunk began the file.
        let first = if pos == 0 { 0 } else { 1 };
        for w in breaks[first..].windows(2).rev() {
            let (start, end) = (w[0], w[1].saturating_sub(1).min(buf.len()));
            if start >= end {
                continue;
            }
            if let Ok(text) = std::str::from_utf8(&buf[start..end]) {
                if !f(text) {
                    return;
                }
            }
        }
        carry = if pos == 0 { Vec::new() } else { buf[..breaks[1].saturating_sub(1).min(buf.len())].to_vec() };
    }
}

/// The first `max` parseable rows of a JSONL file.
///
/// A session's start time and working directory are on its first rows, so a
/// listing reads a few lines instead of a file that can run to hundreds of
/// megabytes. Bounded by rows read, not rows parsed, so a file whose head is
/// all unparseable does not turn into a full scan.
pub(crate) fn head_rows(path: &Path, max: usize) -> Vec<serde_json::Value> {
    use std::io::{BufRead, BufReader};
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .take(max)
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect()
}

/// How Claude names the directory for a working directory: every byte that is
/// not a letter or digit becomes `-`.
///
/// Lossy and irreversible, but it does not need reversing. Encoding is
/// per-character, so the encoding of a repo root is a *prefix* of the encoding
/// of every directory inside it — which is exactly the test "did this session
/// run somewhere in this repo", answered without opening a single file.
pub(crate) fn claude_dir_name(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Parse the timestamp spellings agent CLIs actually use.
///
/// Three appear in the wild and all three have to work: RFC-3339 strings
/// (Claude, Codex), epoch milliseconds (Kimi, OpenCode) and epoch seconds.
/// Milliseconds are told from seconds by magnitude — anything past ~2001 in
/// seconds is still in the 1970s when read as milliseconds, so the threshold
/// is unambiguous for any clock we will ever see.
pub(crate) fn parse_ts(v: &serde_json::Value) -> u64 {
    const MS_FLOOR: u64 = 100_000_000_000; // ~1973 in ms, ~5138 in seconds
    match v {
        serde_json::Value::Number(n) => {
            let raw = n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)).unwrap_or(0);
            if raw >= MS_FLOOR { raw / 1000 } else { raw }
        }
        serde_json::Value::String(s) => {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                return dt.timestamp().max(0) as u64;
            }
            match s.parse::<u64>() {
                Ok(raw) if raw >= MS_FLOOR => raw / 1000,
                Ok(raw) => raw,
                Err(_) => 0,
            }
        }
        _ => 0,
    }
}

/// Slash commands and the harness's own injected blocks are not the user
/// asking for something, and showing one as "what was requested" is worse than
/// showing nothing.
///
/// The named prefixes are the blocks seen in live transcripts. The general
/// rule beneath them catches the rest: a message that *is* one XML-ish element,
/// open tag to matching close tag with nothing outside it, was assembled by a
/// program. Someone writing about a tag writes words around it, so
/// `write a <command> parser` is still a prompt.
pub(crate) fn is_injected_text(text: &str) -> bool {
    let t = text.trim();
    const INJECTED: &[&str] = &[
        "<command-",
        "<local-command",
        "<system-reminder",
        "<task-notification",
        "<function_results",
        // A command the user ran in the harness's own terminal, and what it
        // printed. The output in particular is the worst thing to quote back:
        // it is long, it is machine text, and it carries local absolute paths
        // that were never part of anyone's request.
        "<bash-input",
        "<bash-stdout",
        "<bash-stderr",
        "Caveat: The messages below",
    ];
    if INJECTED.iter().any(|p| t.starts_with(p)) {
        return true;
    }
    is_whole_xml_block(t)
}

/// Is this text nothing but XML-ish elements, one after another?
///
/// One element was the original rule, and it missed the shape that actually
/// shows up: a harness that reports a shell command emits the command and its
/// output as two sibling blocks in one message, so the text opens with one tag
/// name and closes with a different one. Matching a run of elements catches
/// that without loosening the rule that matters — a message with prose outside
/// the tags still reads as a prompt, which is why `write a <command> parser`
/// stays one.
fn is_whole_xml_block(t: &str) -> bool {
    let mut rest = t.trim();
    let mut seen = false;
    while let Some(after) = rest.strip_prefix('<') {
        let name: String = after
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        if name.is_empty() {
            return false;
        }
        // First close tag wins. Same-name nesting would end an element early
        // and leave a remainder that parses as prose, so the answer is "this
        // is a prompt" — the safe way to be wrong about machine text.
        let close = format!("</{name}>");
        let Some(end) = rest.find(&close) else {
            return false;
        };
        rest = rest[end + close.len()..].trim_start();
        seen = true;
    }
    seen && rest.is_empty()
}

/// Flatten the several shapes a chat message body takes into plain text.
///
/// A prompt is a string in the simple case and a content-block array in the
/// rich one (`[{type:"text",text:...}, {type:"image",...}]`). Non-text blocks
/// are dropped rather than rendered as a placeholder: the caller is showing
/// this to a person who asked what was requested, and `[image]` is noise.
pub(crate) fn message_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.trim().to_string(),
        serde_json::Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(|it| {
                    if let Some(s) = it.as_str() {
                        return Some(s.to_string());
                    }
                    let obj = it.as_object()?;
                    if obj.get("type").and_then(|t| t.as_str()) != Some("text") {
                        return None;
                    }
                    obj.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                })
                .collect();
            parts.join("\n").trim().to_string()
        }
        serde_json::Value::Object(o) => o
            .get("content")
            .map(message_text)
            .or_else(|| o.get("text").and_then(|t| t.as_str()).map(|s| s.trim().to_string()))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

/// Read a JSONL file into parsed rows, skipping anything unparseable.
///
/// Transcripts are appended to by a live process, so the last line is
/// routinely half-written. Skipping bad lines is the normal case here, not
/// error handling.
pub(crate) fn read_jsonl(path: &Path) -> Vec<serde_json::Value> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

#[cfg(test)]
mod tests {

    #[test]
    fn reading_backwards_returns_every_line_in_reverse_across_chunks() {
        // The file is deliberately larger than one read chunk: the bug this
        // guards is a line split across a chunk boundary being dropped or cut
        // in half, which would silently lose a prompt.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.jsonl");
        let lines: Vec<String> = (0..40_000).map(|i| format!("{{\"n\":{i},\"pad\":\"{}\"}}", "x".repeat(20))).collect();
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > 256 * 1024, "must span several chunks");

        let mut seen = Vec::new();
        rev_lines(&path, |l| {
            seen.push(l.to_string());
            true
        });
        assert_eq!(seen.len(), lines.len());
        let mut expected = lines.clone();
        expected.reverse();
        assert_eq!(seen, expected, "every line, whole, newest first");
    }

    #[test]
    fn reading_backwards_stops_when_the_caller_has_its_answer() {
        // The whole point: a caller looking for one recent row must not pay
        // for the rest of a multi-gigabyte transcript.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.jsonl");
        let body: String = (0..40_000).map(|i| format!("line {i}\n")).collect();
        std::fs::write(&path, body).unwrap();

        let mut count = 0usize;
        rev_lines(&path, |_| {
            count += 1;
            count < 3
        });
        assert_eq!(count, 3, "stopped on the third line, not after forty thousand");
    }

    #[test]
    fn a_file_with_no_trailing_newline_keeps_its_last_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("small.jsonl");
        std::fs::write(&path, "first\nsecond\nthird").unwrap();
        let mut seen = Vec::new();
        rev_lines(&path, |l| {
            seen.push(l.to_string());
            true
        });
        assert_eq!(seen, vec!["third", "second", "first"]);
    }

    use super::*;

    #[test]
    fn timestamps_arrive_in_three_spellings_and_all_three_work() {
        // Claude and Codex write RFC-3339; Kimi and OpenCode write epoch ms.
        // All four spellings below are the same instant, 2026-08-24T16:48:07Z.
        const AT: u64 = 1_787_590_087;
        assert_eq!(parse_ts(&serde_json::json!("2026-08-24T16:48:07Z")), AT);
        assert_eq!(parse_ts(&serde_json::json!(AT)), AT);
        assert_eq!(parse_ts(&serde_json::json!(AT * 1000)), AT);
        // A stringified number is still a number.
        assert_eq!(parse_ts(&serde_json::json!(format!("{}", AT * 1000))), AT);
        // An offset is honoured, not ignored — the same instant, written local.
        assert_eq!(parse_ts(&serde_json::json!("2026-08-24T18:48:07+02:00")), AT);
        // Anything we cannot read is 0, never a wrong date.
        assert_eq!(parse_ts(&serde_json::json!("last tuesday")), 0);
        assert_eq!(parse_ts(&serde_json::json!(null)), 0);
    }

    #[test]
    fn a_prompt_is_read_from_a_string_or_from_content_blocks() {
        assert_eq!(message_text(&serde_json::json!("fix the bug")), "fix the bug");
        let blocks = serde_json::json!([
            {"type": "text", "text": "fix the bug"},
            {"type": "image", "source": {}},
            {"type": "text", "text": "in auth.rs"}
        ]);
        // The image block is dropped rather than rendered as a placeholder.
        assert_eq!(message_text(&blocks), "fix the bug\nin auth.rs");
        // A message envelope unwraps to its content.
        let msg = serde_json::json!({"role": "user", "content": "ship it"});
        assert_eq!(message_text(&msg), "ship it");
    }

    #[test]
    fn the_prompt_that_caused_an_edit_is_the_last_one_before_it() {
        let prompts = vec![
            Prompt { at: 100, text: "first".into() },
            Prompt { at: 200, text: "second".into() },
            Prompt { at: 400, text: "third".into() },
        ];
        // An edit at 300 was caused by the prompt at 200 — not by the one that
        // came after it, which is the whole point of the ordering.
        assert_eq!(prompt_at(&prompts, 300).unwrap().text, "second");
        assert_eq!(prompt_at(&prompts, 200).unwrap().text, "second");
        assert_eq!(prompt_at(&prompts, 9999).unwrap().text, "third");
        // Before any prompt, fall back rather than claim nothing was asked.
        assert_eq!(prompt_at(&prompts, 50).unwrap().text, "third");
        assert!(prompt_at(&[], 300).is_none());
    }

    #[test]
    fn a_session_belongs_to_the_repo_it_ran_under() {
        let mk = |cwd: Option<&str>| Session {
            dialect: "claude",
            id: "s".into(),
            cwd: cwd.map(|s| s.to_string()),
            cwd_digest: None,
            branch: None,
            title: None,
            started_at: 0,
            last_activity_at: 0,
            prompts: Some(0),
            steps: Some(0),
            path: PathBuf::new(),
        };
        let root = Path::new("/repo");
        assert!(mk(Some("/repo")).ran_in(root));
        // A subdirectory of the repo is still the repo's work.
        assert!(mk(Some("/repo/aura-cli")).ran_in(root));
        // A sibling that merely shares a prefix is NOT.
        assert!(!mk(Some("/repo-other")).ran_in(root));
        // Unknown cwd never guesses.
        assert!(!mk(None).ran_in(root));
    }
}
