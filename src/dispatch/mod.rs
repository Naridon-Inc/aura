//! `aura dispatch` — the artifact that leaves the tool.
//!
//! Everything else Aura shows is a list, read by the person who already knows
//! what happened. A dispatch is written for the person who does not: a lead
//! pasting into a standup, a manager forwarding it on, a customer being told
//! what shipped. Pick a window, some repos and a branch, and get one document.
//!
//! It is **assembled, never narrated**. Every line traces to something on
//! disk — a commit, a symbol hash, an intent row, a prompt somebody typed, a
//! goal run — so the same window produces the same document twice, and nothing
//! in it is a model's guess about what probably happened. A summary of work
//! that quietly invents a detail is worse than no summary, because it is
//! forwarded to people with no way to check it.
//!
//! What each commit contributes, in the order a reader wants it:
//!
//! ```text
//!   commit ──▶ what changed   the symbols, not the line count   (symbols.rs)
//!          ──▶ why           the intent the agent declared      (intent log)
//!          ──▶ what was asked the prompt the person typed       (history)
//!          ──▶ what it proves the goals proven against it       (goals)
//! ```
//!
//! The third row is the one nothing else in this market can print, and it is
//! the reason the join is worth the work: intent is what the agent *said*, the
//! prompt is what was *asked*, and the gap between them is this product's
//! headline claim.

pub mod render;
pub mod symbols;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::goals::model::GoalRecord;
use crate::history::{self, History, Prompt, Scope, Session};
use crate::intent_query::{read_all_rows, IntentRow};
use crate::why;

/// Commits read per repository before the rest are counted but not detailed.
///
/// A dispatch is a document someone reads, not an archive. Past a couple of
/// hundred commits the honest thing is to say how many there were and detail
/// the newest, which is what a reader of a busy week actually wants.
const MAX_COMMITS: usize = 200;

/// Extra slack when matching a commit to the agent session that produced it.
///
/// The session is usually still open when the commit lands, but a person who
/// commits after the agent has stopped is the common case, not the exception.
const SESSION_SLACK: u64 = 6 * 3600;

/// One commit, with everything known about why it exists.
#[derive(Debug, Clone)]
pub struct Change {
    pub sha: String,
    pub short: String,
    pub author: String,
    pub email: String,
    pub at: u64,
    pub subject: String,
    pub delta: symbols::Delta,
    /// What the agent declared it was doing, and how confidently that row was
    /// matched to this commit.
    pub intent: Option<IntentRow>,
    pub intent_basis: Option<&'static str>,
    /// What the person actually asked for, from the agent's own transcript.
    pub prompt: Option<Prompt>,
    pub prompt_basis: Option<&'static str>,
    /// Goals with a run proven against this commit.
    pub goals: Vec<GoalRecord>,
}

/// One repository's contribution to a dispatch.
#[derive(Debug, Clone)]
pub struct RepoReport {
    pub name: String,
    pub root: PathBuf,
    pub branch: String,
    pub since: u64,
    pub until: u64,
    pub changes: Vec<Change>,
    /// Commits in the window past [`MAX_COMMITS`].
    pub omitted: usize,
    /// Who committed, and how many times.
    pub people: BTreeMap<String, usize>,
    /// Which agents declared intent, and how many rows each.
    pub agents: BTreeMap<String, usize>,
    /// A named failure instead of a silently empty section.
    pub problem: Option<String>,
}

impl RepoReport {
    pub fn files_touched(&self) -> usize {
        let mut all: std::collections::BTreeSet<&str> = Default::default();
        for c in &self.changes {
            all.extend(c.delta.files.iter().map(|f| f.as_str()));
        }
        all.len()
    }

    pub fn symbols_touched(&self) -> usize {
        self.changes.iter().map(|c| c.delta.total()).sum()
    }

    /// Goals proven in this window, newest first, one entry per goal.
    pub fn goals(&self) -> Vec<&GoalRecord> {
        let mut seen: std::collections::BTreeSet<&str> = Default::default();
        let mut out = Vec::new();
        for c in &self.changes {
            for g in &c.goals {
                if seen.insert(g.id.as_str()) {
                    out.push(g);
                }
            }
        }
        out
    }

    /// Commits nobody stated a reason for.
    ///
    /// Named rather than filtered away: a dispatch that quietly omits the
    /// unexplained work reads as though every change was accounted for.
    pub fn unexplained(&self) -> usize {
        self.changes.iter().filter(|c| c.intent.is_none() && c.prompt.is_none()).count()
    }
}

/// A whole dispatch: every repo asked about, over one window.
#[derive(Debug, Clone)]
pub struct Dispatch {
    pub since: u64,
    pub until: u64,
    pub window: String,
    pub repos: Vec<RepoReport>,
}

impl Dispatch {
    pub fn commits(&self) -> usize {
        self.repos.iter().map(|r| r.changes.len()).sum()
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The repo's own name, as a person would say it.
fn repo_name(root: &Path) -> String {
    root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| root.display().to_string())
}

/// Commits on `branch` between `since` and now, newest first.
///
/// Shells out to git for the same reason [`crate::why`] does: a revwalk with
/// tree diffs over a week of history is seconds of work git does in
/// milliseconds, and a report nobody waits for is a report nobody runs.
fn commit_shas(root: &Path, branch: &str, since: u64) -> Result<Vec<String>, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["log", "--no-merges", "--format=%H", &format!("--since=@{since}"), branch])
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr);
        let msg = msg.lines().next().unwrap_or("git log failed").to_string();
        return Err(msg);
    }
    Ok(String::from_utf8_lossy(&out.stdout).lines().map(|l| l.to_string()).collect())
}

/// The branch a repo is on right now, for the default.
fn current_branch(repo: &git2::Repository) -> String {
    repo.head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .unwrap_or_else(|| "HEAD".to_string())
}

/// Index goals by the commit they were proven against, so a hundred commits
/// cost one read of the ledger rather than a hundred.
fn goals_by_commit(root: &Path) -> BTreeMap<String, Vec<GoalRecord>> {
    let mut out: BTreeMap<String, Vec<GoalRecord>> = BTreeMap::new();
    for g in crate::goals::store::load(root) {
        let mut commits: Vec<String> =
            g.runs.iter().filter_map(|r| r.commit.clone()).collect();
        commits.sort();
        commits.dedup();
        for c in commits {
            out.entry(c).or_default().push(g.clone());
        }
    }
    out
}

/// Did somebody state this reason, or did a hook record a tool call?
///
/// Both are true rows and both belong in the log. Only one of them answers
/// *why*, and a dispatch that prints "Claude Edit on foo.rs" where a stated
/// reason existed has thrown away the better answer it already had.
fn is_stated(r: &IntentRow) -> bool {
    r.source.as_deref() != Some("hook_auto")
}

/// Tools that only look at code. A hook row for one of these describes no
/// change at all, so it can never be the reason a commit exists.
const READ_ONLY: &[&str] = &["Read", "Glob", "Grep", "WebFetch", "WebSearch", "LS", "NotebookRead"];

/// Drop the hook rows that record a read.
///
/// Applied to hook rows only: a person who *wrote* "Read the spec first, then
/// …" is stating a reason, and filtering that would be censoring the record.
fn is_useful(r: &IntentRow) -> bool {
    if is_stated(r) {
        return true;
    }
    !READ_ONLY.iter().any(|t| {
        r.intent.contains(&format!("running {t} on")) || r.intent.contains(&format!(" {t} on "))
    })
}

/// How an agent should be named in a summary.
///
/// `hook_auto` is a source, not an agent — it is what old hook rows carried
/// before they learned to name the CLI that made the change. Printing it in a
/// list headed "Agents" invents a product nobody uses. Those rows still open
/// with the agent's own name ("Claude Edit on …"), so the name is recoverable;
/// where it is not, the row says so rather than guessing.
pub(crate) fn agent_label(id: &str, intent: &str) -> String {
    /// The CLIs whose hooks write into this log. Matching a name is only ever
    /// used to recover one that was already written down, never to attribute a
    /// row to an agent that never claimed it.
    const AGENTS: &[&str] =
        &["claude", "codex", "gemini", "cursor", "kimi", "opencode", "pi", "copilot"];
    if id.is_empty() || id == "hook_auto" {
        let first = intent.split_whitespace().next().unwrap_or("");
        if AGENTS.iter().any(|a| a.eq_ignore_ascii_case(first)) {
            return titled(first);
        }
        return "unnamed agent".to_string();
    }
    titled(id)
}

fn titled(name: &str) -> String {
    let mut c = name.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => name.to_string(),
    }
}

/// Every intent log this repository writes to.
///
/// A linked worktree keeps its own `.aura/`, but half a session's reasons are
/// logged through the main checkout — the MCP server holds one repo open, and
/// it is not this one. Reading only the worktree's log drops those rows and
/// leaves a dispatch quietly missing the best answer it had.
fn intent_logs(root: &Path, repo: &git2::Repository) -> Vec<PathBuf> {
    let mine = root.join(".aura").join("intent_log.jsonl");
    let mut paths = vec![mine.clone()];
    if let Some(main) = repo.commondir().parent() {
        let theirs = main.join(".aura").join("intent_log.jsonl");
        if theirs != mine && theirs.exists() {
            paths.push(theirs);
        }
    }
    paths
}

/// Read every log, once each, with the duplicates dropped.
///
/// The same row can appear in both books when a session logged through the MCP
/// server and the hooks both. Counting it twice would inflate the agent tally
/// for no reason.
fn rows_from(paths: &[PathBuf]) -> Vec<IntentRow> {
    let mut seen: BTreeSet<(u64, String)> = BTreeSet::new();
    let mut rows = Vec::new();
    for p in paths {
        for r in read_all_rows(p) {
            if seen.insert((r.timestamp, r.intent.clone())) {
                rows.push(r);
            }
        }
    }
    rows
}

/// Choose the row that best explains a commit.
///
/// Stated reasons are considered first, and only if none of them fall in the
/// commit's window does a hook row get to speak for it. The basis string still
/// comes from [`crate::why::pick_intent`], so a reader is told whether the row
/// named this file or merely happened alongside it.
fn explain<'a>(
    stated: &'a [IntentRow],
    all: &'a [IntentRow],
    file: &str,
    at: u64,
    window_start: u64,
) -> Option<(&'a IntentRow, &'static str)> {
    why::pick_intent(stated, file, at, window_start)
        .or_else(|| why::pick_intent(all, file, at, window_start))
}

/// Find the session a commit belongs to, and the prompt that was live in it.
///
/// Two tiers, and which one was used is carried through to the reader. An
/// intent row naming a session is a statement; a session that was running in
/// this repo across this moment is an inference. Printing them identically
/// would turn a good guess into a false claim.
fn prompt_for(
    dialects: &[Box<dyn History>],
    sessions: &[(usize, Session)],
    repo_root: &Path,
    intent: Option<&IntentRow>,
    at: u64,
) -> Option<(Prompt, &'static str)> {
    if let Some(id) = intent.and_then(|r| r.session_id.as_deref()) {
        if let Some((i, s)) = sessions.iter().find(|(_, s)| s.id == id) {
            if let Some((p, _)) = dialects[*i].prompt_before(s, at) {
                return Some((p, "the session the agent logged"));
            }
        }
    }
    let candidates: Vec<Session> = sessions.iter().map(|(_, s)| s.clone()).collect();
    let picked = why::pick_session_by_time(candidates, repo_root, at)?;
    let i = sessions.iter().find(|(_, s)| s.id == picked.id).map(|(i, _)| *i)?;
    let (p, _) = dialects[i].prompt_before(&picked, at)?;
    Some((p, "the session live in this repo at the time"))
}

/// Build one repository's report.
pub fn for_repo(root: &Path, branch: Option<&str>, since: u64, until: u64) -> RepoReport {
    let name = repo_name(root);
    let mut report = RepoReport {
        name,
        root: root.to_path_buf(),
        branch: branch.unwrap_or("HEAD").to_string(),
        since,
        until,
        changes: Vec::new(),
        omitted: 0,
        people: BTreeMap::new(),
        agents: BTreeMap::new(),
        problem: None,
    };

    let repo = match git2::Repository::open(root) {
        Ok(r) => r,
        Err(e) => {
            report.problem = Some(format!("not a git repository: {e}"));
            return report;
        }
    };
    if branch.is_none() {
        report.branch = current_branch(&repo);
    }

    let shas = match commit_shas(root, &report.branch, since) {
        Ok(s) => s,
        Err(e) => {
            report.problem = Some(e);
            return report;
        }
    };
    if shas.len() > MAX_COMMITS {
        report.omitted = shas.len() - MAX_COMMITS;
    }

    let rows: Vec<IntentRow> =
        rows_from(&intent_logs(root, &repo)).into_iter().filter(is_useful).collect();
    let stated: Vec<IntentRow> = rows.iter().filter(|r| is_stated(r)).cloned().collect();
    let goals = goals_by_commit(root);

    // Sessions are indexed once for the whole window. `index` locates them
    // without reading their bodies, which is what keeps a repo with years of
    // transcripts from costing minutes here.
    let scope = Scope::repo(root).since(since.saturating_sub(SESSION_SLACK));
    let dialects: Vec<Box<dyn History>> = history::installed();
    let mut sessions: Vec<(usize, Session)> = Vec::new();
    for (i, d) in dialects.iter().enumerate() {
        for s in d.index(&scope) {
            sessions.push((i, s));
        }
    }

    // One parser and one blob cache for the whole window: neighbouring commits
    // share most of their blobs, and building a parser per commit is the kind
    // of cost that turns a report into something nobody waits for.
    let mut cache = match symbols::Cache::new() {
        Some(c) => c,
        None => {
            report.problem = Some("could not start the semantic parser".to_string());
            return report;
        }
    };

    for sha in shas.into_iter().take(MAX_COMMITS) {
        let Ok(oid) = git2::Oid::from_str(&sha) else { continue };
        let Ok(commit) = repo.find_commit(oid) else { continue };
        let at = commit.time().seconds().max(0) as u64;
        if at > until {
            continue;
        }
        let author = commit.author();
        let delta = symbols::delta_for(&repo, &mut cache, &commit);

        let window_start = commit
            .parent(0)
            .ok()
            .map(|p| p.time().seconds().max(0) as u64)
            .unwrap_or_else(|| at.saturating_sub(SESSION_SLACK));
        // The commit's own files are what an intent row would name, so the
        // first file it touched is the best single anchor for the match.
        let anchor = delta.files.first().cloned().unwrap_or_default();
        let picked = explain(&stated, &rows, &anchor, at, window_start);
        let (intent, intent_basis) = match picked {
            Some((r, basis)) => (Some(r.clone()), Some(basis)),
            None => (None, None),
        };
        if let Some(r) = intent.as_ref() {
            *report.agents.entry(agent_label(&r.agent_id, &r.intent)).or_insert(0) += 1;
        }

        let (prompt, prompt_basis) =
            match prompt_for(&dialects, &sessions, root, intent.as_ref(), at) {
                Some((p, basis)) => (Some(p), Some(basis)),
                None => (None, None),
            };

        let who = author.name().unwrap_or("unknown").to_string();
        *report.people.entry(who.clone()).or_insert(0) += 1;

        report.changes.push(Change {
            short: sha[..7.min(sha.len())].to_string(),
            sha: sha.clone(),
            author: who,
            email: author.email().unwrap_or("").to_string(),
            at,
            subject: commit.summary().unwrap_or("").to_string(),
            delta,
            intent,
            intent_basis,
            prompt,
            prompt_basis,
            goals: goals.get(&sha).cloned().unwrap_or_default(),
        });
    }

    report
}

/// Read `--repos` into repository roots.
///
/// An entry that is not a repository is reported as its own failed section
/// rather than dropped: a dispatch that silently omits a repo somebody asked
/// for is a dispatch that under-reports the week.
pub fn roots_from(repos: Option<&str>) -> Result<Vec<PathBuf>, String> {
    let Some(list) = repos.map(str::trim).filter(|s| !s.is_empty()) else {
        let repo = git2::Repository::discover(".")
            .map_err(|_| "not inside a git repository — pass --repos".to_string())?;
        let root = repo
            .workdir()
            .ok_or_else(|| "a bare repository has no working tree".to_string())?
            .to_path_buf();
        return Ok(vec![root]);
    };
    let mut out = Vec::new();
    for entry in list.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let path = PathBuf::from(shellexpand(entry));
        match git2::Repository::discover(&path).ok().and_then(|r| r.workdir().map(|w| w.to_path_buf())) {
            Some(root) => out.push(root),
            None => return Err(format!("`{entry}` is not inside a git repository")),
        }
    }
    if out.is_empty() {
        return Err("no repositories in --repos".to_string());
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// Expand a leading `~` so `--repos ~/code/app` works from a shell that did
/// not do it for us (a quoted argument, a config file, a cron line).
fn shellexpand(path: &str) -> String {
    let home = std::env::var_os("HOME").map(|h| h.to_string_lossy().to_string());
    expand_home(path, home.as_deref())
}

/// The rule on its own, so it can be tested without writing to the process
/// environment — which every other test in this binary is reading at the same
/// time.
fn expand_home(path: &str, home: Option<&str>) -> String {
    match (path.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => format!("{home}/{rest}"),
        _ => path.to_string(),
    }
}

/// Assemble a dispatch.
pub fn assemble(roots: &[PathBuf], branch: Option<&str>, window: &str, since: u64) -> Dispatch {
    let until = now();
    Dispatch {
        since,
        until,
        window: window.to_string(),
        repos: roots.iter().map(|r| for_repo(r, branch, since, until)).collect(),
    }
}

/// Command entry point. Returns a process exit code.
pub fn cli(
    since: Option<&str>,
    repos: Option<&str>,
    branch: Option<&str>,
    json: bool,
    markdown: bool,
    out: Option<&str>,
) -> i32 {
    let fail = |msg: String| -> i32 {
        if json {
            println!("{}", serde_json::json!({ "error": msg }));
        } else {
            eprintln!("✗ {msg}");
        }
        1
    };

    let window = since.unwrap_or("1w");
    let Some(start) = crate::import_history::parse_since(window, now()) else {
        return fail(format!(
            "could not read `--since {window}` — try `1d`, `1w`, `30d` or `2026-01-01`"
        ));
    };

    let roots = match roots_from(repos) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    let dispatch = assemble(&roots, branch, window, start);

    // A file is markdown whatever the flags say: nobody writes a terminal
    // rendering, escape codes and all, to a path they intend to send on.
    let text = if json {
        serde_json::to_string_pretty(&render::to_json(&dispatch)).unwrap_or_default()
    } else if markdown || out.is_some() {
        render::markdown(&dispatch)
    } else {
        String::new()
    };

    if let Some(path) = out {
        if let Err(e) = std::fs::write(path, &text) {
            return fail(format!("could not write {path}: {e}"));
        }
        println!("✓ wrote {path}");
        return 0;
    }
    if text.is_empty() {
        render::terminal(&dispatch);
    } else {
        println!("{text}");
    }
    0
}

/// Fixtures shared by this module's tests and the renderer's, so both are
/// exercised against the same shape rather than two hand-built ones that
/// drift apart.
#[cfg(test)]
pub(crate) mod tests_support {
    use super::*;

    pub fn change() -> Change {
        Change {
            sha: "a".repeat(40),
            short: "aaaaaaa".into(),
            author: "Dev".into(),
            email: "dev@example.com".into(),
            at: 1_787_529_600,
            subject: "tighten the parser".into(),
            delta: symbols::Delta {
                files: vec!["src/parse.rs".into()],
                added: vec!["parse".into()],
                ..Default::default()
            },
            intent: Some(IntentRow {
                timestamp: 1_787_529_500,
                agent_id: "claude".into(),
                intent: "tighten the parser".into(),
                intent_type: None,
                signed_block_id: None,
                key_id: None,
                source: None,
                file: Some("src/parse.rs".into()),
                session_id: Some("s1".into()),
                stated_at: None,
                change: None,
                tool: None,
            }),
            intent_basis: Some("names this file"),
            prompt: Some(Prompt { at: 1_787_529_000, text: "make it stricter".into() }),
            prompt_basis: Some("the session the agent logged"),
            goals: Vec::new(),
        }
    }

    fn report(changes: Vec<Change>, problem: Option<&str>) -> RepoReport {
        RepoReport {
            name: "app".into(),
            root: PathBuf::from("/repo"),
            branch: "main".into(),
            since: 1_787_000_000,
            until: 1_787_600_000,
            changes,
            omitted: 0,
            people: BTreeMap::new(),
            agents: BTreeMap::new(),
            problem: problem.map(|p| p.to_string()),
        }
    }

    fn wrap(repos: Vec<RepoReport>) -> Dispatch {
        Dispatch { since: 1_787_000_000, until: 1_787_600_000, window: "1w".into(), repos }
    }

    pub fn dispatch_with_change() -> Dispatch {
        wrap(vec![report(vec![change()], None)])
    }

    pub fn dispatch_with_problem() -> Dispatch {
        wrap(vec![report(Vec::new(), Some("no such branch"))])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(intent: Option<&str>, prompt: Option<&str>, files: &[&str]) -> Change {
        Change {
            sha: "a".repeat(40),
            short: "aaaaaaa".into(),
            author: "Dev".into(),
            email: "dev@example.com".into(),
            at: 1_787_000_000,
            subject: "do the thing".into(),
            delta: symbols::Delta {
                files: files.iter().map(|f| f.to_string()).collect(),
                added: vec!["parse".into()],
                ..Default::default()
            },
            intent: intent.map(|t| IntentRow {
                timestamp: 1_787_000_000,
                agent_id: "claude".into(),
                intent: t.into(),
                intent_type: None,
                signed_block_id: None,
                key_id: None,
                source: None,
                file: None,
                session_id: None,
                stated_at: None,
                change: None,
                tool: None,
            }),
            intent_basis: intent.map(|_| "names this file"),
            prompt: prompt.map(|t| Prompt { at: 1_786_999_000, text: t.into() }),
            prompt_basis: prompt.map(|_| "the session the agent logged"),
            goals: Vec::new(),
        }
    }

    fn report(changes: Vec<Change>) -> RepoReport {
        RepoReport {
            name: "app".into(),
            root: PathBuf::from("/repo"),
            branch: "main".into(),
            since: 1_786_000_000,
            until: 1_787_100_000,
            changes,
            omitted: 0,
            people: BTreeMap::new(),
            agents: BTreeMap::new(),
            problem: None,
        }
    }

    #[test]
    fn a_file_touched_by_two_commits_is_counted_once() {
        let r = report(vec![
            change(None, None, &["src/a.rs", "src/b.rs"]),
            change(None, None, &["src/b.rs"]),
        ]);
        assert_eq!(r.files_touched(), 2);
        assert_eq!(r.symbols_touched(), 2, "one added symbol per commit");
    }

    #[test]
    fn a_commit_nobody_explained_is_counted_rather_than_hidden() {
        // The number a reader most needs is how much of the week has no stated
        // reason. Dropping those commits would make every dispatch look fully
        // accounted for, which is the one thing it must never do.
        let r = report(vec![
            change(Some("tighten the parser"), None, &["src/a.rs"]),
            change(None, Some("make it stricter"), &["src/b.rs"]),
            change(None, None, &["src/c.rs"]),
        ]);
        assert_eq!(r.unexplained(), 1);
    }

    #[test]
    fn a_tilde_path_is_expanded_from_home() {
        assert_eq!(expand_home("~/code/app", Some("/home/someone")), "/home/someone/code/app");
        assert_eq!(expand_home("/abs/path", Some("/home/someone")), "/abs/path");
        assert_eq!(expand_home("relative", Some("/home/someone")), "relative");
        // No HOME is not a reason to mangle the path into `/code/app`.
        assert_eq!(expand_home("~/code/app", None), "~/code/app");
    }

    fn hook_row(intent: &str) -> IntentRow {
        IntentRow {
            timestamp: 100,
            agent_id: "hook_auto".into(),
            intent: intent.into(),
            intent_type: None,
            signed_block_id: None,
            key_id: None,
            source: Some("hook_auto".into()),
            file: None,
            session_id: None,
            stated_at: None,
            change: None,
            tool: None,
        }
    }

    #[test]
    fn a_hook_row_for_a_read_is_not_a_reason_a_commit_exists() {
        assert!(!is_useful(&hook_row("running Read on WaveDispatchPanel.tsx")));
        assert!(!is_useful(&hook_row("Claude Grep on src/main.rs")));
        assert!(is_useful(&hook_row("Claude Edit on src/main.rs")));
        assert!(is_useful(&hook_row("Claude Write on src/new.rs")));
    }

    #[test]
    fn a_stated_reason_that_mentions_reading_is_kept() {
        // Filtering this would be censoring the record: somebody wrote it.
        let mut r = hook_row("Read the spec first, then rewrote the parser around it");
        r.source = None;
        r.agent_id = "claude".into();
        assert!(is_useful(&r));
    }

    #[test]
    fn a_stated_reason_beats_a_hook_row_that_merely_names_the_file() {
        // The hook row names the file, which is why::pick_intent's strongest
        // tier — and it still says less than the reason somebody typed.
        let mut said = hook_row("swap the retry to exponential backoff");
        said.source = None;
        said.agent_id = "claude".into();
        said.timestamp = 90;
        let mut hook = hook_row("Claude Edit on src/main.rs");
        hook.file = Some("src/main.rs".into());
        hook.timestamp = 95;

        let all = vec![said.clone(), hook];
        let stated = vec![said];
        let (picked, _) = explain(&stated, &all, "src/main.rs", 100, 50).unwrap();
        assert_eq!(picked.intent, "swap the retry to exponential backoff");
    }

    #[test]
    fn a_commit_with_only_hook_rows_still_gets_one() {
        let mut hook = hook_row("Claude Edit on src/main.rs");
        hook.file = Some("src/main.rs".into());
        let all = vec![hook];
        let (picked, _) = explain(&[], &all, "src/main.rs", 100, 50).unwrap();
        assert_eq!(picked.intent, "Claude Edit on src/main.rs");
    }

    #[test]
    fn a_source_is_not_printed_as_though_it_were_an_agent() {
        assert_eq!(agent_label("claude", "anything"), "Claude");
        assert_eq!(agent_label("Claude", "anything"), "Claude");
        assert_eq!(agent_label("codex", "anything"), "Codex");
        // A hook row opens with the agent's own name, so the name survives.
        assert_eq!(agent_label("hook_auto", "Claude Edit on src/main.rs"), "Claude");
        // And where it does not, the row says so instead of inventing one.
        assert_eq!(agent_label("hook_auto", "running Read on foo.rs"), "unnamed agent");
        assert_eq!(agent_label("", ""), "unnamed agent");
    }

    #[test]
    fn a_repos_list_that_names_no_repository_says_which_one() {
        let err = roots_from(Some("/definitely/not/a/repo")).unwrap_err();
        assert!(err.contains("/definitely/not/a/repo"), "names the entry: {err}");
    }
}
