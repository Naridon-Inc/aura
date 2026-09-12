//! Dialects described by a file instead of by a patch to this tree.
//!
//! # Why
//!
//! The four dialects beside this one are Rust: adding a fifth agent CLI means
//! editing Aura, building Aura and shipping Aura. That is fine for the agents
//! our own team happens to use and useless for the one you use — and the
//! difference between "supports six agents" and "supports yours" is the whole
//! of it, because a person whose agent is unsupported does not see a partial
//! product, they see an empty one.
//!
//! A manifest is a JSON file saying where a CLI keeps its transcripts and how
//! to recognise a prompt in them. Drop it in `~/.aura/dialects/` and every
//! command that reads history — `aura why`, `aura import`, `aura recap`,
//! `aura dispatch` — reads that agent too. Nothing is compiled, nothing is
//! installed, and nothing about Aura has to know the agent exists.
//!
//! # What it can and cannot express
//!
//! It covers one shape: **a JSONL transcript per session**. That is what
//! Claude Code, Codex, Kimi and OpenCode all write, and what almost every
//! agent CLI writes, because appending a line per turn is the obvious way to
//! keep a log you may crash halfway through.
//!
//! It does not cover a transcript in SQLite, in Protobuf, or spread across
//! several files that must be joined. An agent shaped like that still needs a
//! Rust dialect implementing [`History`] directly — the trait is the contract,
//! and this module is one implementation of it that happens to be data-driven.
//! Saying so plainly is better than a manifest format that grows a query
//! language and still cannot do it.
//!
//! # Privacy
//!
//! Same rule as every dialect: this reads local files and returns owned
//! strings to a caller that decides what to show. A manifest names paths and
//! JSON keys. It cannot name a destination, and nothing here opens a socket.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::{
    head_rows, home, message_text, mtime_secs, parse_ts, rev_lines, stale_for, History, Prompt,
    Scope, Session,
};

/// Where a manifest's session id comes from.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum IdFrom {
    /// `…/threads/<id>.jsonl` — the filename without its extension.
    #[default]
    FileStem,
    /// `…/sessions/<id>/transcript.jsonl` — the directory holding the file.
    ParentDir,
}

/// Which rows are prompts, and where the text is.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct RowRule {
    /// Every one of these dotted paths must equal its value for a row to match.
    #[serde(default)]
    pub when: BTreeMap<String, serde_json::Value>,
    /// If any of these matches, the row is rejected — this is what keeps tool
    /// results, sub-agent turns and compaction summaries from being counted as
    /// things the person typed.
    #[serde(default)]
    pub unless: BTreeMap<String, serde_json::Value>,
    /// The row is rejected if any of these paths is present at all, whatever
    /// its value. This is how a transcript that files tool output under the
    /// user's own role — every one of them does — is told apart from the
    /// person typing: the tool row carries a key the typed row never has.
    #[serde(default)]
    pub absent: Vec<String>,
    /// Dotted path to the text. A string or a content-block array; anything
    /// else reads as empty.
    #[serde(default)]
    pub text: String,
    /// Reject a prompt whose text starts with any of these. Harnesses inject
    /// their own blocks into the user role — slash-command expansions, hook
    /// output, reminders — and showing one back as "what was requested" is
    /// worse than showing nothing.
    #[serde(default)]
    pub reject_text_prefix: Vec<String>,
    /// Also reject text that is exactly one XML-ish element, open tag to
    /// matching close tag with nothing outside it: that was assembled by a
    /// program. Someone writing *about* a tag writes words around it, so
    /// `write a <command> parser` survives. Shared with the compiled dialects
    /// rather than reimplemented, so a manifest and a Rust dialect agree.
    #[serde(default)]
    pub reject_injected_text: bool,
}

impl RowRule {
    fn is_empty(&self) -> bool {
        self.when.is_empty() && self.unless.is_empty()
    }

    fn matches(&self, row: &serde_json::Value) -> bool {
        // A rule with no `when` matches nothing rather than everything. The
        // other reading would make a manifest that forgot its `step` block
        // report every line of the transcript as work the agent did.
        if self.when.is_empty() {
            return false;
        }
        if !self.when.iter().all(|(k, v)| dig(row, k) == Some(v)) {
            return false;
        }
        if self.absent.iter().any(|k| dig(row, k).is_some()) {
            return false;
        }
        !self.unless.iter().any(|(k, v)| dig(row, k) == Some(v))
    }

    /// Is this text the person, or the harness wearing their role?
    fn text_is_theirs(&self, text: &str) -> bool {
        let t = text.trim();
        if t.is_empty() {
            return false;
        }
        if self.reject_text_prefix.iter().any(|p| t.starts_with(p.as_str())) {
            return false;
        }
        !(self.reject_injected_text && super::is_injected_text(t))
    }
}

/// Which JSON keys carry the facts every dialect has to answer.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Fields {
    /// Dotted path to the working directory. Absent means this dialect cannot
    /// say where it ran, and repo-scoped callers will skip its sessions rather
    /// than guess — see [`Session::cwd`].
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// Dotted path to each row's clock. Without it a session still lists, but
    /// its prompts carry no time, and `aura why` falls back to the last one.
    #[serde(default)]
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SessionsSpec {
    /// Where transcripts sit under `root`. `*` matches one path segment,
    /// `**` matches any number.
    pub glob: String,
    #[serde(default)]
    pub id_from: IdFrom,
}

/// One agent CLI, described rather than compiled.
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    /// Lower-case, stable. Must match the hook dialect id if the agent also
    /// writes intent rows, or the two halves will not join up.
    pub id: String,
    pub display: String,
    /// The directory the CLI keeps its data in. A leading `~` is $HOME.
    pub root: String,
    pub sessions: SessionsSpec,
    #[serde(default)]
    pub fields: Fields,
    #[serde(default)]
    pub prompt: RowRule,
    #[serde(default)]
    pub step: RowRule,
}

impl Manifest {
    /// Read one manifest, or say why it cannot be used.
    ///
    /// Errors carry the path because these files are hand-written by someone
    /// who is not us, and "invalid manifest" without a filename is not a
    /// message anyone can act on.
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let m: Manifest = serde_json::from_str(&text)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        m.check().map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(m)
    }

    fn check(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("`id` is empty".into());
        }
        if self.id.chars().any(|c| !c.is_ascii_alphanumeric() && c != '-' && c != '_') {
            return Err(format!(
                "`id` must be letters, digits, `-` or `_`; got {:?}",
                self.id
            ));
        }
        if self.sessions.glob.trim().is_empty() {
            return Err("`sessions.glob` is empty".into());
        }
        // A dialect that cannot recognise a prompt can still list sessions,
        // but it silently answers "nothing was asked" to the one question the
        // product is built around. Better to refuse it than to ship that.
        if self.prompt.is_empty() {
            return Err("`prompt.when` is empty — nothing would ever count as a prompt".into());
        }
        if self.prompt.text.trim().is_empty() {
            return Err("`prompt.text` is empty — there would be nothing to read back".into());
        }
        Ok(())
    }
}

/// A [`Manifest`] wearing the same trait as the compiled dialects.
pub struct ManifestDialect {
    m: Manifest,
    /// Leaked once at load. [`History::id`] and [`Session::dialect`] are
    /// `&'static str` because the compiled dialects are compile-time constants
    /// — a manifest's id is not, and this is the cost of letting the two kinds
    /// share one trait. Bounded by the number of manifest files on disk, and
    /// paid once per process.
    id: &'static str,
    display: &'static str,
}

impl ManifestDialect {
    pub fn new(m: Manifest) -> Self {
        let id: &'static str = Box::leak(m.id.clone().into_boxed_str());
        let display: &'static str = Box::leak(m.display.clone().into_boxed_str());
        Self { m, id, display }
    }

    pub fn manifest(&self) -> &Manifest {
        &self.m
    }

    fn prompt_from(&self, row: &serde_json::Value) -> Option<Prompt> {
        if !self.m.prompt.matches(row) {
            return None;
        }
        let text = dig(row, &self.m.prompt.text).map(message_text).unwrap_or_default();
        if !self.m.prompt.text_is_theirs(&text) {
            return None;
        }
        Some(Prompt { at: self.row_ts(row), text })
    }

    fn row_ts(&self, row: &serde_json::Value) -> u64 {
        self.m
            .fields
            .timestamp
            .as_deref()
            .and_then(|k| dig(row, k))
            .map(parse_ts)
            .unwrap_or(0)
    }

    fn session_at(&self, path: &Path) -> Option<Session> {
        let id = match self.m.sessions.id_from {
            IdFrom::FileStem => path.file_stem()?.to_string_lossy().to_string(),
            IdFrom::ParentDir => path.parent()?.file_name()?.to_string_lossy().to_string(),
        };
        // The head is where a transcript states its context: an agent writes
        // cwd and branch on the way in, not on the way out.
        let head = head_rows(path, 40);
        let first = |key: &Option<String>| -> Option<String> {
            let key = key.as_deref()?;
            head.iter()
                .find_map(|r| dig(r, key))
                .and_then(|v| v.as_str().map(str::to_string))
        };
        let started = head.iter().map(|r| self.row_ts(r)).find(|t| *t > 0);
        let mtime = mtime_secs(path);
        Some(Session {
            dialect: self.id,
            id,
            cwd: first(&self.m.fields.cwd),
            cwd_digest: None,
            branch: first(&self.m.fields.branch),
            title: first(&self.m.fields.title),
            started_at: started.unwrap_or(mtime),
            last_activity_at: mtime,
            prompts: None,
            steps: None,
            path: path.to_path_buf(),
        })
    }
}

impl History for ManifestDialect {
    fn id(&self) -> &'static str {
        self.id
    }

    fn display(&self) -> &'static str {
        self.display
    }

    fn root(&self) -> Option<PathBuf> {
        let p = expand_home(&self.m.root)?;
        p.is_dir().then_some(p)
    }

    fn index(&self, scope: &Scope) -> Vec<Session> {
        let Some(root) = self.root() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for path in walk_glob(&root, &self.m.sessions.glob) {
            // mtime rules a file out before it is opened; the real test runs
            // on what survives.
            if stale_for(&path, scope) {
                continue;
            }
            if let Some(s) = self.session_at(&path) {
                if scope.keeps(&s) {
                    out.push(s);
                }
            }
        }
        out.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
        out
    }

    fn count(&self, mut session: Session) -> Session {
        use std::io::{BufRead, BufReader};
        let Ok(file) = std::fs::File::open(&session.path) else {
            session.prompts = Some(0);
            session.steps = Some(0);
            return session;
        };
        let (mut prompts, mut steps) = (0usize, 0usize);
        let mut first_prompt: Option<String> = None;
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(row) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if let Some(p) = self.prompt_from(&row) {
                prompts += 1;
                if first_prompt.is_none() {
                    first_prompt = Some(p.text);
                }
                continue;
            }
            if self.m.step.matches(&row) {
                steps += 1;
            }
        }
        session.prompts = Some(prompts);
        session.steps = Some(steps);
        // A session with no title of its own is named by what was asked of it,
        // which is the only thing about it a person would recognise.
        if session.title.is_none() {
            session.title = first_prompt.map(|t| first_line(&t));
        }
        session
    }

    fn prompts(&self, session: &Session) -> Vec<Prompt> {
        use std::io::{BufRead, BufReader};
        let Ok(file) = std::fs::File::open(&session.path) else {
            return Vec::new();
        };
        BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(&l).ok())
            .filter_map(|r| self.prompt_from(&r))
            .collect()
    }

    fn prompt_before(&self, session: &Session, at: u64) -> Option<(Prompt, usize)> {
        // Walk back from the end and stop at the first match, so the cost is
        // set by how recent the answer is rather than by how long the session
        // ran. The default implementation reads the whole transcript.
        let mut after = 0usize;
        let mut found: Option<Prompt> = None;
        let mut newest: Option<Prompt> = None;
        rev_lines(&session.path, |line| {
            let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else {
                return true;
            };
            let Some(p) = self.prompt_from(&row) else {
                return true;
            };
            if newest.is_none() {
                newest = Some(p.clone());
            }
            // `at == 0` means the caller has no usable clock; the last prompt
            // is the one that was in flight.
            if at == 0 || (p.at != 0 && p.at <= at) {
                found = Some(p);
                return false;
            }
            after += 1;
            true
        });
        // Nothing at or before the moment: fall back to the newest prompt, the
        // same way `prompt_at` does, and report nothing after it.
        match found {
            Some(p) => Some((p, after)),
            None => newest.map(|p| (p, 0)),
        }
    }
}

// ─── discovery ──────────────────────────────────────────────────────────────

/// Where manifests live. `AURA_DIALECTS_DIR` overrides it, which is how the
/// tests get a tree of their own instead of the developer's real one.
pub fn dialects_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("AURA_DIALECTS_DIR") {
        return Some(PathBuf::from(dir));
    }
    Some(home()?.join(".aura").join("dialects"))
}

/// Every usable manifest on disk, and every one that isn't, with the reason.
///
/// Both halves are returned because a manifest that fails to parse is the
/// single most likely thing to go wrong for someone writing their first one,
/// and a dialect that silently does not appear is indistinguishable from one
/// that appeared and found nothing.
pub fn discover() -> (Vec<ManifestDialect>, Vec<String>) {
    match dialects_dir() {
        Some(dir) => discover_in(&dir),
        None => (Vec::new(), Vec::new()),
    }
}

/// [`discover`], against a named directory. Split out so the tests get a tree
/// of their own rather than the developer's real one.
pub fn discover_in(dir: &Path) -> (Vec<ManifestDialect>, Vec<String>) {
    let mut ok = Vec::new();
    let mut bad = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (ok, bad);
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    // Stable order so output is stable, whatever the filesystem hands back.
    paths.sort();

    let builtin: Vec<&str> = super::builtin().iter().map(|d| d.id()).collect();
    for p in paths {
        match Manifest::load(&p) {
            Ok(m) => {
                if builtin.contains(&m.id.as_str()) {
                    // Refusing rather than overriding: a manifest that shadows
                    // a compiled dialect would change what `aura why` answers
                    // with no sign that it had, and the compiled one is the
                    // one with the agent's edge cases in it.
                    bad.push(format!(
                        "{}: `{}` is a built-in dialect and cannot be replaced by a manifest",
                        p.display(),
                        m.id
                    ));
                    continue;
                }
                if ok.iter().any(|d: &ManifestDialect| d.m.id == m.id) {
                    bad.push(format!("{}: duplicate dialect id `{}`", p.display(), m.id));
                    continue;
                }
                ok.push(ManifestDialect::new(m));
            }
            Err(e) => bad.push(e),
        }
    }
    (ok, bad)
}

// ─── small helpers ──────────────────────────────────────────────────────────

/// Read a dotted path out of a JSON row: `message.content`, `meta.git.branch`.
///
/// Deliberately not JSON Pointer: the keys these files hold are ordinary
/// identifiers, and `message.content` is what someone writing a manifest will
/// try first. A key containing a literal `.` is not reachable, which no
/// transcript format we have seen needs.
fn dig<'a>(row: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut cur = row;
    for part in path.split('.') {
        if part.is_empty() {
            return None;
        }
        cur = cur.get(part)?;
    }
    Some(cur)
}

/// `~/.amp` → `/Users/mo/.amp`. A path with no `~` is returned as written, so
/// an absolute root works and a relative one is left for the caller to reject.
fn expand_home(root: &str) -> Option<PathBuf> {
    let root = root.trim();
    if root == "~" {
        return home();
    }
    match root.strip_prefix("~/") {
        Some(rest) => Some(home()?.join(rest)),
        None => Some(PathBuf::from(root)),
    }
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or("").trim().to_string()
}

/// Expand `sessions.glob` against `root`.
///
/// `*` matches within one path segment; `**` matches any number of segments.
/// Small on purpose — a transcript layout is two or three levels deep, and a
/// full glob implementation would be more surface than the feature has.
fn walk_glob(root: &Path, pattern: &str) -> Vec<PathBuf> {
    let parts: Vec<&str> = pattern.split('/').filter(|p| !p.is_empty()).collect();
    let mut out = Vec::new();
    walk_from(root, &parts, &mut out);
    out.sort();
    out
}

fn walk_from(dir: &Path, parts: &[&str], out: &mut Vec<PathBuf>) {
    // A traversal bounded by the pattern's depth, not by the tree's: `**` is
    // the only part that recurses, and it is bounded below.
    let Some((head, rest)) = parts.split_first() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if *head == "**" {
            // `**` may match nothing, so try the rest here as well as below.
            if path.is_dir() {
                walk_from(&path, parts, out);
            }
            if rest.is_empty() {
                if path.is_file() {
                    out.push(path);
                }
            } else if segment_matches(rest[0], &name) {
                if rest.len() == 1 {
                    if path.is_file() {
                        out.push(path);
                    }
                } else if path.is_dir() {
                    walk_from(&path, &rest[1..], out);
                }
            }
            continue;
        }
        if !segment_matches(head, &name) {
            continue;
        }
        if rest.is_empty() {
            if path.is_file() {
                out.push(path);
            }
        } else if path.is_dir() {
            walk_from(&path, rest, out);
        }
    }
}

/// One `*`-containing segment against one filename.
fn segment_matches(pattern: &str, name: &str) -> bool {
    if pattern == "*" || pattern == "**" {
        return true;
    }
    if !pattern.contains('*') {
        return pattern == name;
    }
    let mut rest = name;
    let chunks: Vec<&str> = pattern.split('*').collect();
    let last = chunks.len() - 1;
    for (i, chunk) in chunks.iter().enumerate() {
        if chunk.is_empty() {
            continue;
        }
        if i == 0 {
            if !rest.starts_with(chunk) {
                return false;
            }
            rest = &rest[chunk.len()..];
            continue;
        }
        if i == last && !pattern.ends_with('*') {
            return rest.ends_with(chunk) && rest.len() >= chunk.len();
        }
        match rest.find(chunk) {
            Some(at) => rest = &rest[at + chunk.len()..],
            None => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    /// A manifest rooted at a real directory, so the whole trait can be driven
    /// without touching $HOME — which is process-global and shared with every
    /// other test in this binary.
    fn dialect_at(root: &Path) -> ManifestDialect {
        let m: Manifest = serde_json::from_value(serde_json::json!({
            "id": "amp",
            "display": "Amp",
            "root": root.to_string_lossy(),
            "sessions": { "glob": "threads/*/*.jsonl" },
            "fields": { "cwd": "cwd", "branch": "gitBranch", "timestamp": "ts" },
            "prompt": {
                "when": { "role": "user" },
                "absent": ["toolResult"],
                "text": "content"
            },
            "step": { "when": { "role": "assistant" } }
        }))
        .unwrap();
        m.check().unwrap();
        ManifestDialect::new(m)
    }

    fn transcript(root: &Path) -> PathBuf {
        let p = root.join("threads").join("t1").join("sess-1.jsonl");
        write(
            &p,
            concat!(
                r#"{"role":"user","ts":1000,"cwd":"/repo","gitBranch":"main","content":"first ask"}"#,
                "\n",
                r#"{"role":"assistant","ts":1010,"content":"working"}"#,
                "\n",
                r#"{"role":"user","ts":1020,"toolResult":{"out":"ok"},"content":"tool output"}"#,
                "\n",
                r#"{"role":"assistant","ts":1030,"content":"more"}"#,
                "\n",
                r#"{"role":"user","ts":1040,"content":"second ask"}"#,
                "\n",
            ),
        );
        p
    }

    // ─── the format refuses what it cannot honour ──────────────────────────

    #[test]
    fn a_manifest_that_could_never_find_a_prompt_is_refused() {
        // Loading it and finding nothing would look exactly like an agent that
        // was never used, which is the one wrong answer here.
        let bad: Manifest = serde_json::from_value(serde_json::json!({
            "id": "x", "display": "X", "root": "~/.x",
            "sessions": { "glob": "*.jsonl" },
            "prompt": { "text": "content" }
        }))
        .unwrap();
        assert!(bad.check().unwrap_err().contains("nothing would ever count"));
    }

    #[test]
    fn an_id_has_to_be_usable_as_one() {
        let mk = |id: &str| -> Manifest {
            serde_json::from_value(serde_json::json!({
                "id": id, "display": "X", "root": "~/.x",
                "sessions": { "glob": "*.jsonl" },
                "prompt": { "when": {"role":"user"}, "text": "content" }
            }))
            .unwrap()
        };
        assert!(mk("amp-2").check().is_ok());
        assert!(mk("").check().is_err());
        assert!(mk("my agent").check().is_err());
    }

    // ─── reading a transcript ──────────────────────────────────────────────

    #[test]
    fn a_session_is_located_without_reading_its_body() {
        let dir = tempfile::tempdir().unwrap();
        transcript(dir.path());
        let d = dialect_at(dir.path());

        let found = d.index(&Scope::all());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "sess-1");
        assert_eq!(found[0].cwd.as_deref(), Some("/repo"));
        assert_eq!(found[0].branch.as_deref(), Some("main"));
        assert_eq!(found[0].started_at, 1000);
        // Counting is what `count` is for; an index that reported 0 would be
        // stating something false about the session.
        assert_eq!(found[0].prompts, None);
    }

    #[test]
    fn tool_output_filed_under_the_users_role_is_not_a_prompt() {
        // Every transcript format does this, and counting it would report a
        // session driven by two asks as having had three.
        let dir = tempfile::tempdir().unwrap();
        transcript(dir.path());
        let d = dialect_at(dir.path());
        let s = d.count(d.index(&Scope::all()).remove(0));
        assert_eq!(s.prompts, Some(2));
        assert_eq!(s.steps, Some(2));
        assert_eq!(
            d.prompts(&s).iter().map(|p| p.text.as_str()).collect::<Vec<_>>(),
            vec!["first ask", "second ask"]
        );
    }

    #[test]
    fn a_session_with_no_title_is_named_by_what_was_asked() {
        let dir = tempfile::tempdir().unwrap();
        transcript(dir.path());
        let d = dialect_at(dir.path());
        let s = d.count(d.index(&Scope::all()).remove(0));
        assert_eq!(s.title.as_deref(), Some("first ask"));
    }

    #[test]
    fn the_ask_behind_a_moment_is_found_from_the_end() {
        let dir = tempfile::tempdir().unwrap();
        transcript(dir.path());
        let d = dialect_at(dir.path());
        let s = d.index(&Scope::all()).remove(0);

        // An edit at 1035 was asked for at 1000, and one prompt followed it.
        let (p, after) = d.prompt_before(&s, 1035).unwrap();
        assert_eq!(p.text, "first ask");
        assert_eq!(after, 1);

        // At the end of the session, the last ask with nothing after it.
        let (p, after) = d.prompt_before(&s, 9999).unwrap();
        assert_eq!(p.text, "second ask");
        assert_eq!(after, 0);

        // No usable clock falls back to the ask that was in flight.
        assert_eq!(d.prompt_before(&s, 0).unwrap().0.text, "second ask");

        // Before the session began there is no ask to point at, so the newest
        // is returned rather than nothing — the same rule `prompt_at` uses.
        assert_eq!(d.prompt_before(&s, 1).unwrap().0.text, "second ask");
    }

    #[test]
    fn a_session_that_ran_somewhere_else_is_not_this_repos() {
        let dir = tempfile::tempdir().unwrap();
        transcript(dir.path());
        let d = dialect_at(dir.path());
        assert_eq!(d.index(&Scope::repo(Path::new("/repo"))).len(), 1);
        assert_eq!(d.index(&Scope::repo(Path::new("/elsewhere"))).len(), 0);
    }

    // ─── paths ─────────────────────────────────────────────────────────────

    #[test]
    fn a_glob_matches_segment_by_segment() {
        assert!(segment_matches("*", "anything"));
        assert!(segment_matches("*.jsonl", "sess-1.jsonl"));
        assert!(!segment_matches("*.jsonl", "sess-1.json"));
        assert!(segment_matches("ses_*", "ses_abc"));
        assert!(!segment_matches("ses_*", "abc"));
        assert!(segment_matches("exact", "exact"));
        assert!(!segment_matches("exact", "exacts"));
    }

    #[test]
    fn a_double_star_crosses_any_number_of_directories_including_none() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("a.jsonl"), "{}");
        write(&dir.path().join("x").join("b.jsonl"), "{}");
        write(&dir.path().join("x").join("y").join("c.jsonl"), "{}");
        write(&dir.path().join("x").join("y").join("skip.txt"), "{}");

        let found = walk_glob(dir.path(), "**/*.jsonl");
        let names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["a.jsonl", "b.jsonl", "c.jsonl"]);
    }

    #[test]
    fn a_dotted_path_reads_a_nested_key() {
        let row = serde_json::json!({"message": {"content": "hi"}, "flat": 1});
        assert_eq!(dig(&row, "message.content").unwrap(), "hi");
        assert_eq!(dig(&row, "flat").unwrap(), 1);
        assert!(dig(&row, "message.missing").is_none());
        assert!(dig(&row, "").is_none());
    }

    #[test]
    fn a_root_outside_home_is_taken_as_written() {
        assert_eq!(expand_home("/opt/agent").unwrap(), PathBuf::from("/opt/agent"));
    }

    // ─── the proof ─────────────────────────────────────────────────────────

    #[test]
    fn the_shipped_example_re_expresses_the_compiled_claude_dialect() {
        // Step 4 of AURA-290: the format is only an extension story if it can
        // express a dialect we already ship. This runs the example manifest's
        // prompt rule and the compiled dialect's own predicate over the row
        // shapes that actually appear in a Claude transcript, and requires
        // them to agree on every one.
        // Two checkouts, one file. Here the crate sits under `aura-cli/`, so
        // the docs tree is one level up; in the published repository the crate
        // is the root and the same tree is right beside it. Hard-coding either
        // shape makes the test pass in one checkout and fail in the other on a
        // file that did not move, so look in both.
        let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let relative = Path::new("docs").join("dialects").join("claude-code.json");
        let path = [crate_dir.join("..").join(&relative), crate_dir.join(&relative)]
            .into_iter()
            .find(|candidate| candidate.exists())
            .expect("the shipped example must be somewhere in this checkout");
        let m = Manifest::load(&path).expect("the shipped example must load");
        assert_eq!(m.id, "claude-code-manifest");

        let rows = [
            serde_json::json!({"type":"user","message":{"content":"fix the retry"}}),
            serde_json::json!({"type":"assistant","message":{"content":"ok"}}),
            serde_json::json!({"type":"user","isMeta":true,"message":{"content":"x"}}),
            serde_json::json!({"type":"user","isSidechain":true,"message":{"content":"x"}}),
            serde_json::json!({"type":"user","isCompactSummary":true,"message":{"content":"x"}}),
            serde_json::json!({"type":"user","isVisibleInTranscriptOnly":true,"message":{"content":"x"}}),
            serde_json::json!({"type":"user","toolUseResult":{"stdout":""},"message":{"content":"x"}}),
            serde_json::json!({"type":"ai-title","title":"Retry backoff"}),
        ];
        for row in &rows {
            assert_eq!(
                m.prompt.matches(row),
                super::super::claude::is_typed_prompt(row),
                "row classified differently: {row}"
            );
        }

        // And the text half: the harness wearing the user's role is rejected
        // by both, and a person writing about a tag is rejected by neither.
        assert!(!m.prompt.text_is_theirs("<command-name>/clear</command-name>"));
        assert!(!m.prompt.text_is_theirs("<system-reminder>be careful</system-reminder>"));
        assert!(m.prompt.text_is_theirs("write a <command> parser"));
    }

    #[test]
    fn a_manifest_cannot_shadow_a_compiled_dialect() {
        // Overriding one silently would change what `aura why` answers, and
        // the compiled dialect is the one with the agent's edge cases in it.
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("claude.json"),
            r#"{"id":"claude","display":"Mine","root":"~/.x",
                "sessions":{"glob":"*.jsonl"},
                "prompt":{"when":{"role":"user"},"text":"content"}}"#,
        );
        write(
            &dir.path().join("amp.json"),
            r#"{"id":"amp","display":"Amp","root":"~/.amp",
                "sessions":{"glob":"*.jsonl"},
                "prompt":{"when":{"role":"user"},"text":"content"}}"#,
        );

        let (ok, bad) = discover_in(dir.path());
        assert_eq!(ok.iter().map(|d| d.id()).collect::<Vec<_>>(), vec!["amp"]);
        assert_eq!(bad.len(), 1);
        assert!(bad[0].contains("built-in"));
    }

    #[test]
    fn a_manifest_that_does_not_parse_says_which_file() {
        // These are hand-written by someone who is not us; "invalid manifest"
        // with no filename is not a message anyone can act on.
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("broken.json"), "{ not json");
        let (ok, bad) = discover_in(dir.path());
        assert!(ok.is_empty());
        assert_eq!(bad.len(), 1);
        assert!(bad[0].contains("broken.json"));
    }
}
