//! `aura why <file>:<line>` — why is this line the way it is?
//!
//! Git answers *who* and *when*. Aura already records *what the agent said it
//! was doing*. Neither answers the question a person actually asks when they
//! land on a strange line, which is **what was someone trying to get?**
//!
//! That answer lives in the agent's own transcript — the prompt the person
//! typed — and until now nothing read it. So this walks the whole chain:
//!
//! ```text
//! file:line ──blame──▶ commit ──window──▶ intent row ──session_id──▶ transcript
//!                         │                    │                        │
//!                     who, when          what the agent            what the
//!                                        said it was doing         person asked
//! ```
//!
//! **Each link degrades on its own.** A commit with no intent row still shows
//! its prompt, because sessions are matched by the time they were live in this
//! repo when no row names one. An intent row with no session still shows the
//! intent. Nothing is invented to fill a gap — a missing link is printed as
//! missing, because a plausible wrong answer here is worse than no answer.
//!
//! **A rename does not break the chain.** Every row is addressed to whatever
//! the path was on the day it was written, so a file that has been moved has
//! half its reasons filed under a name the reader has never typed. The lookup
//! therefore runs over every path the file has had, per git's own `--follow`,
//! and says which name a row was addressed to when it was not the current one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use colored::*;

use crate::history;
use crate::intent_query::{read_all_rows, IntentRow};

/// Where a lookup starts: a path, and optionally one line in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub path: String,
    pub line: Option<usize>,
}

/// Split `src/main.rs:120` into its parts.
///
/// A bare path is a whole-file question and keeps `line: None`. Windows-style
/// `C:\…` and a path that merely ends in a colon are left as paths, since a
/// line number that isn't a number is a typo, not a line number.
pub fn parse_target(raw: &str) -> Target {
    if let Some((path, tail)) = raw.rsplit_once(':') {
        if !path.is_empty() {
            if let Ok(n) = tail.parse::<usize>() {
                if n > 0 {
                    return Target { path: path.to_string(), line: Some(n) };
                }
            }
        }
    }
    Target { path: raw.to_string(), line: None }
}

/// What blame said about one line.
#[derive(Debug, Clone)]
pub struct Landed {
    pub sha: String,
    pub short: String,
    pub author: String,
    pub email: String,
    pub at: u64,
    pub subject: String,
    /// Files in that commit other than the one asked about — context for
    /// "this line changed as part of something larger".
    pub siblings: Vec<String>,
    /// Time of the parent commit; the lower bound of the window in which the
    /// work for this commit was actually done.
    pub parent_at: Option<u64>,
}

/// Everything `why` found, in one shape so the renderer and `--json` agree.
#[derive(Debug, Clone)]
pub struct Answer {
    pub target: Target,
    pub landed: Option<Landed>,
    /// True when the line asked about is not committed at all.
    pub uncommitted: bool,
    pub intent: Option<IntentRow>,
    /// How the intent row was chosen — stated plainly rather than implied,
    /// since "the row that names this file" and "a row logged around then"
    /// are very different levels of confidence.
    pub intent_basis: Option<&'static str>,
    pub session: Option<history::Session>,
    pub session_basis: Option<&'static str>,
    pub prompt: Option<history::Prompt>,
    /// Prompts in the same session after the one shown — the rest of the ask.
    pub later_prompts: usize,
    /// Aura checkpoint note attached to the commit, if one was written.
    pub checkpoint: Option<serde_json::Value>,
    /// Paths this file has had before its current one, oldest last. Empty for
    /// a file that was never renamed. Shown because an answer drawn from a row
    /// addressed to a name the reader has never seen looks like a mistake
    /// until the rename is on the page next to it.
    pub former_paths: Vec<String>,
}

/// How wide a net to cast when a commit has no parent to bound the window.
///
/// Six hours is deliberately generous: an intent row landing hours before the
/// commit is still that commit's story, and the alternative to a wide window
/// is no answer at all. The basis string tells the reader which it was.
const FALLBACK_WINDOW: u64 = 6 * 3600;

/// Choose the intent row that best explains a commit.
///
/// Two tiers, and the tier is reported rather than hidden. A row naming the
/// same file is evidence; a row logged in the same window is a reasonable
/// guess. Collapsing the two into one number would make a guess look like a
/// fact, which is the failure mode this whole command exists to avoid.
pub fn pick_intent<'a>(
    rows: &'a [IntentRow],
    file: &str,
    commit_at: u64,
    window_start: u64,
) -> Option<(&'a IntentRow, &'static str)> {
    pick_intent_across(rows, &[file], commit_at, window_start)
}

/// The same choice, made over every name the file has ever had.
///
/// A rename splits a file's reasons in two. Everything written before it names
/// the old path, and the reader only has the new one, so the strongest tier
/// finds nothing and the answer silently drops to the weakest — which, in a
/// busy window, is some other file's intent presented as this one's. That is
/// the exact failure this command exists to avoid, so a former name is its own
/// tier: still evidence, and said to be about the path the file used to have.
///
/// `files` is ordered newest name first; see [`known_as`].
pub fn pick_intent_across<'a>(
    rows: &'a [IntentRow],
    files: &[&str],
    commit_at: u64,
    window_start: u64,
) -> Option<(&'a IntentRow, &'static str)> {
    let in_window = |r: &IntentRow| r.timestamp <= commit_at && r.timestamp >= window_start;

    for (i, name) in files.iter().enumerate() {
        let named: Option<&IntentRow> = rows
            .iter()
            .filter(|r| in_window(r))
            .filter(|r| r.file.as_deref().is_some_and(|f| paths_match(f, name)))
            .max_by_key(|r| r.timestamp);
        if let Some(r) = named {
            let basis = if i == 0 {
                "names this file"
            } else {
                "names this file under the path it had then"
            };
            return Some((r, basis));
        }
    }

    rows.iter()
        .filter(|r| in_window(r))
        .max_by_key(|r| r.timestamp)
        .map(|r| (r, "logged while this commit was being written"))
}

/// Every path this file has been known by, current name first.
///
/// `--follow` is git's own rename detection, and it is the only thing in the
/// repository that knows `src/backoff.rs` used to be `src/retry.rs`. Nothing
/// else can close that gap: an intent row is addressed to whatever the path
/// was on the day it was written, and a reader typing today's path would never
/// reach it.
///
/// `--diff-filter=R` with an empty `--format` keeps the output to the rename
/// records themselves — measured at 63ms against this repo's own `main.rs`,
/// which is the worst path here — and a git that cannot answer leaves the
/// current name alone rather than failing the lookup.
fn known_as(repo: &git2::Repository, rel: &Path) -> Vec<String> {
    let mut names = vec![rel.to_string_lossy().to_string()];
    let Some(workdir) = repo.workdir() else {
        return names;
    };
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(workdir)
        .args(["log", "--follow", "--diff-filter=R", "--name-status", "--format="])
        .arg("--")
        .arg(rel)
        .output();
    let Ok(out) = out else {
        return names;
    };
    if !out.status.success() {
        return names;
    }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        // `R097<TAB>old/path<TAB>new/path`. The similarity score rides on the
        // status letter, so match the letter and ignore the number.
        let mut parts = line.split('\t');
        if !parts.next().is_some_and(|status| status.starts_with('R')) {
            continue;
        }
        let Some(old) = parts.next().map(str::trim) else {
            continue;
        };
        if !old.is_empty() && !names.iter().any(|n| n == old) {
            names.push(old.to_string());
        }
    }
    names
}

/// Do two recorded paths refer to the same file?
///
/// Rows are written from several places — a hook that knew the repo-relative
/// path, a tool that had an absolute one — so this compares from the right,
/// which is exact for a repo-relative path and correct for an absolute one.
pub fn paths_match(recorded: &str, asked: &str) -> bool {
    let a = recorded.trim_start_matches("./");
    let b = asked.trim_start_matches("./");
    a == b || a.ends_with(&format!("/{b}")) || b.ends_with(&format!("/{a}"))
}

/// Pick the agent session that was live in this repo when the commit landed.
///
/// This is the link that makes `why` work on history nobody instrumented: an
/// intent row naming a session is better evidence, but a session that was
/// running in this very repo, spanning this very moment, is a real answer
/// where the alternative is a shrug.
pub fn pick_session_by_time(
    sessions: Vec<history::Session>,
    repo_root: &Path,
    at: u64,
) -> Option<history::Session> {
    sessions
        .into_iter()
        .filter(|s| s.ran_in(repo_root))
        .filter(|s| s.started_at <= at && at <= s.last_activity_at.saturating_add(FALLBACK_WINDOW))
        // Shortest session that still contains the moment: the tightest fit is
        // the least likely to be a long-running session that merely overlaps.
        .min_by_key(|s| s.last_activity_at.saturating_sub(s.started_at))
}

/// `known` is every name the file has had (see [`known_as`]), so a commit from
/// before a rename does not list the file itself among the things that changed
/// *with* it — under the old name it would otherwise look like a sibling.
fn commit_facts(repo: &git2::Repository, oid: git2::Oid, known: &[String]) -> Option<Landed> {
    let commit = repo.find_commit(oid).ok()?;
    let author = commit.author();
    let at = commit.time().seconds().max(0) as u64;
    let parent = commit.parent(0).ok();
    let parent_at = parent.as_ref().map(|p| p.time().seconds().max(0) as u64);

    // Same reasoning as `last_commit_for`: a merge's diff against its first
    // parent is the whole branch, which is not "what else changed with this".
    let mut siblings = Vec::new();
    if let Some(p) = parent.as_ref().filter(|_| commit.parent_count() == 1) {
        if let (Ok(a), Ok(b)) = (p.tree(), commit.tree()) {
            if let Ok(diff) = repo.diff_tree_to_tree(Some(&a), Some(&b), None) {
                for d in diff.deltas() {
                    if let Some(p) = d.new_file().path().and_then(|p| p.to_str()) {
                        if !known.iter().any(|k| paths_match(p, k)) {
                            siblings.push(p.to_string());
                        }
                    }
                }
            }
        }
    }
    siblings.sort();
    siblings.dedup();

    Some(Landed {
        sha: oid.to_string(),
        short: oid.to_string()[..7.min(oid.to_string().len())].to_string(),
        author: author.name().unwrap_or("unknown").to_string(),
        email: author.email().unwrap_or("").to_string(),
        at,
        subject: commit.summary().unwrap_or("").to_string(),
        siblings,
        parent_at,
    })
}

/// Blame one line, taking local edits into account.
///
/// A file being edited right now has different line numbers from the one in
/// HEAD, so blaming HEAD's copy and indexing it with the reader's line number
/// answers about a different line. `blame_buffer` maps the working copy back
/// onto the blame, which is the only way this is correct on a dirty tree —
/// Which commit last wrote one line.
///
/// Shells out to `git blame` rather than using libgit2's, because the two are
/// not the same algorithm in practice: git stops walking history the moment
/// the line is accounted for, and libgit2 keeps going. Measured on this repo's
/// own 16,000-line `main.rs` — 0.1s against 13.5s for the identical answer.
/// A command that answers in thirteen seconds is one nobody runs twice.
///
/// git blames the working copy, so a line that exists only there comes back as
/// the zero oid — which is an answer ("you wrote this and haven't committed
/// it"), not a failure, and the caller renders it as one.
fn blame_line(repo: &git2::Repository, rel: &Path, line: usize) -> Option<git2::Oid> {
    match blame_via_git(repo, rel, line) {
        // git ran and gave a verdict — including "this line has no commit",
        // which is a real answer and must not be retried the slow way.
        Some(verdict) => verdict,
        // git could not be run at all. Fall back rather than refuse to answer.
        None => blame_via_libgit2(repo, rel, line),
    }
}

/// `Some(verdict)` when git ran; `None` when it could not be run at all.
fn blame_via_git(repo: &git2::Repository, rel: &Path, line: usize) -> Option<Option<git2::Oid>> {
    let workdir = repo.workdir()?;
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(workdir)
        .args(["blame", "--porcelain", "-L"])
        .arg(format!("{line},{line}"))
        .arg("--")
        .arg(rel)
        .output()
        .ok()?;
    if !out.status.success() {
        // A line past the end of the file, or a path git will not blame. git
        // has answered; there is nothing a second attempt would find.
        return Some(None);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Porcelain's first field is the commit the line came from.
    let sha = text.lines().next().and_then(|l| l.split_whitespace().next());
    Some(sha.and_then(|s| git2::Oid::from_str(s).ok()))
}

/// The in-process blame, kept for a machine with no `git` on its PATH.
fn blame_via_libgit2(repo: &git2::Repository, rel: &Path, line: usize) -> Option<git2::Oid> {
    // Bounded to a band around the line: this path is already the slow one,
    // and blaming 16,000 lines to report on one is the reason it is slow.
    const DRIFT: usize = 200;
    let mut opts = git2::BlameOptions::new();
    opts.min_line(line.saturating_sub(DRIFT).max(1));
    opts.max_line(line + DRIFT);
    let blame = repo.blame_file(rel, Some(&mut opts)).ok()?;
    let workdir = repo.workdir()?;
    let full = workdir.join(rel);
    // A buffer git cannot map (binary, or an encoding change) still has a HEAD
    // blame worth showing, so a failed mapping falls back rather than giving up.
    let buf = std::fs::read(&full).ok();
    let mapped = buf.as_ref().and_then(|b| blame.blame_buffer(b).ok());
    match mapped.as_ref() {
        Some(m) => m.get_line(line).map(|h| h.final_commit_id()),
        None => blame.get_line(line).map(|h| h.final_commit_id()),
    }
}

/// The last commit that touched a path, for a whole-file question.
///
/// Merges are skipped. A merge's first-parent diff contains everything that
/// landed on the branch, so crediting one would answer "why is this file the
/// way it is" with *"a pull request touched two thousand files"* — true, and
/// useless. Content is authored by the commit that wrote it.
fn last_commit_for(repo: &git2::Repository, rel: &Path) -> Option<git2::Oid> {
    match last_commit_via_git(repo, rel) {
        Some(verdict) => verdict,
        None => last_commit_via_libgit2(repo, rel),
    }
}

/// `Some(verdict)` when git ran; `None` when it could not be run at all.
///
/// `--no-merges` is the same rule the walk below applies, expressed in git's
/// own vocabulary, and `-1` lets git stop at the first hit instead of diffing
/// every commit in the repository — 6.3s down to milliseconds here.
fn last_commit_via_git(repo: &git2::Repository, rel: &Path) -> Option<Option<git2::Oid>> {
    let workdir = repo.workdir()?;
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(workdir)
        .args(["log", "-1", "--no-merges", "--format=%H", "--"])
        .arg(rel)
        .output()
        .ok()?;
    if !out.status.success() {
        return Some(None);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Some(text.trim().lines().next().and_then(|l| git2::Oid::from_str(l.trim()).ok()))
}

/// The in-process walk, kept for a machine with no `git` on its PATH.
fn last_commit_via_libgit2(repo: &git2::Repository, rel: &Path) -> Option<git2::Oid> {
    let mut walk = repo.revwalk().ok()?;
    walk.push_head().ok()?;
    walk.set_sorting(git2::Sort::TIME).ok()?;
    for oid in walk.flatten() {
        let commit = repo.find_commit(oid).ok()?;
        if commit.parent_count() > 1 {
            continue;
        }
        let tree = commit.tree().ok()?;
        let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
        let diff = repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
            .ok()?;
        let touched = diff.deltas().any(|d| {
            d.new_file().path().is_some_and(|p| p == rel) || d.old_file().path().is_some_and(|p| p == rel)
        });
        if touched {
            return Some(oid);
        }
    }
    None
}

/// Read the Aura checkpoint note attached to a commit, if any.
fn checkpoint_note(repo: &git2::Repository, oid: git2::Oid) -> Option<serde_json::Value> {
    let note = repo.find_note(Some("refs/notes/aura"), oid).ok()?;
    serde_json::from_str(note.message()?).ok()
}

/// Make a path repo-relative, whatever the caller typed.
fn relativise(repo_root: &Path, raw: &str) -> PathBuf {
    let p = Path::new(raw);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().map(|c| c.join(p)).unwrap_or_else(|_| p.to_path_buf())
    };
    // `canonicalize` resolves `..` and symlinks, but fails on a path that does
    // not exist — a deleted file is still a fair question, so fall back.
    let abs = abs.canonicalize().unwrap_or(abs);
    let root = repo_root.canonicalize().unwrap_or_else(|_| repo_root.to_path_buf());
    abs.strip_prefix(&root).map(|p| p.to_path_buf()).unwrap_or_else(|_| PathBuf::from(raw))
}

/// Assemble the answer. Pure of printing so `--json` and the human form are
/// the same finding rendered twice, never two lookups that can disagree.
pub fn answer(raw_target: &str) -> Result<Answer, String> {
    let target = parse_target(raw_target);
    let repo = git2::Repository::discover(".").map_err(|e| format!("not a git repository: {e}"))?;
    let repo_root = repo
        .workdir()
        .ok_or_else(|| "this is a bare repository — there are no files to explain".to_string())?
        .to_path_buf();

    let rel = relativise(&repo_root, &target.path);
    let rel_str = rel.to_string_lossy().to_string();

    let oid = match target.line {
        Some(n) => blame_line(&repo, &rel, n),
        None => last_commit_for(&repo, &rel),
    };

    let mut out = Answer {
        target: Target { path: rel_str.clone(), line: target.line },
        landed: None,
        uncommitted: false,
        intent: None,
        intent_basis: None,
        session: None,
        session_basis: None,
        prompt: None,
        later_prompts: 0,
        checkpoint: None,
        former_paths: Vec::new(),
    };

    let Some(oid) = oid else {
        return Err(format!(
            "no commit has touched {rel_str} — is the path right, and is it tracked?"
        ));
    };
    if oid.is_zero() {
        // Blame reports the zero oid for a line that exists only in the
        // working tree. That is an answer, not a failure.
        out.uncommitted = true;
        return Ok(out);
    }

    // Everything the file has been called, so a commit from before a rename is
    // read against the name it actually had at the time.
    let known = known_as(&repo, &rel);
    let known_refs: Vec<&str> = known.iter().map(String::as_str).collect();
    out.former_paths = known.iter().skip(1).cloned().collect();

    let landed = commit_facts(&repo, oid, &known);
    let commit_at = landed.as_ref().map(|l| l.at).unwrap_or(0);
    let window_start = landed
        .as_ref()
        .and_then(|l| l.parent_at)
        .unwrap_or_else(|| commit_at.saturating_sub(FALLBACK_WINDOW));
    out.checkpoint = checkpoint_note(&repo, oid);
    out.landed = landed;

    let rows = read_all_rows(&repo_root.join(".aura").join("intent_log.jsonl"));
    if let Some((row, basis)) = pick_intent_across(&rows, &known_refs, commit_at, window_start) {
        out.intent = Some(row.clone());
        out.intent_basis = Some(basis);
    }

    // The session named by the intent row is the strongest link; falling back
    // to "what was running here then" is what makes this work on history that
    // predates any instrumentation at all.
    let named = out.intent.as_ref().and_then(|r| r.session_id.clone());
    let found = match named.as_deref().and_then(history::find_session) {
        Some((dialect, session)) => Some((dialect, session, "named by the intent row")),
        None => {
            // Scoped to this repo and to sessions still live around the
            // commit. Unscoped this reads every transcript on the machine,
            // which on a working laptop is tens of gigabytes — the command
            // would not answer at all.
            let scope = history::Scope::repo(&repo_root)
                .since(commit_at.saturating_sub(FALLBACK_WINDOW));
            let mut all = Vec::new();
            let mut by_dialect: BTreeMap<&'static str, Box<dyn history::History>> = BTreeMap::new();
            for d in history::installed() {
                            // `index`, not `sessions`: picking which session was live needs
                // when it ran, never how many prompts it held, and counting
                // reads every candidate transcript end to end.
                all.extend(d.index(&scope));
                by_dialect.insert(d.id(), d);
            }
            pick_session_by_time(all, &repo_root, commit_at).and_then(|s| {
                by_dialect
                    .remove(s.dialect)
                    .map(|d| (d, s, "was live in this repo when the commit landed"))
            })
        }
    };

    if let Some((dialect, session, basis)) = found {
        // Anchor on the intent row when there is one: it is closer to the edit
        // than the commit is, and a commit can land long after the work.
        let anchor = out.intent.as_ref().map(|r| r.timestamp).filter(|t| *t > 0).unwrap_or(commit_at);
            if let Some((p, later)) = dialect.prompt_before(&session, anchor) {
            out.prompt = Some(p);
            out.later_prompts = later;
        }
        out.session = Some(session);
        out.session_basis = Some(basis);
    }

    Ok(out)
}

// ─── rendering ──────────────────────────────────────────────────────────────

fn ago(then: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if then == 0 || then > now {
        return "just now".to_string();
    }
    let d = now - then;
    match d {
        0..=59 => "just now".to_string(),
        60..=3599 => format!("{}m ago", d / 60),
        3600..=86_399 => format!("{}h ago", d / 3600),
        _ => format!("{}d ago", d / 86_400),
    }
}

/// Wrap at a readable width and indent continuation lines under the first.
fn wrap(text: &str, width: usize, indent: &str) -> String {
    let mut lines = Vec::new();
    for para in text.lines() {
        let mut cur = String::new();
        for word in para.split_whitespace() {
            if !cur.is_empty() && cur.chars().count() + 1 + word.chars().count() > width {
                lines.push(std::mem::take(&mut cur));
            }
            if !cur.is_empty() {
                cur.push(' ');
            }
            cur.push_str(word);
        }
        lines.push(cur);
    }
    lines.join(&format!("\n{indent}"))
}

fn field(label: &str, body: &str) {
    println!("  {:<9}{}", label.bold(), body);
}

pub fn render(a: &Answer) {
    let where_ = match a.target.line {
        Some(n) => format!("{}:{}", a.target.path, n),
        None => a.target.path.clone(),
    };
    println!("\n{}\n", where_.bold().cyan());

    if a.uncommitted {
        println!("  {}", "This line is not committed yet — it only exists in your working tree.".yellow());
        println!("  {}\n", "Commit it and ask again, or ask about a line that has landed.".dimmed());
        return;
    }

    if let Some(l) = &a.landed {
        field(
            "Landed",
            &format!(
                "{}  {}  ·  {}",
                l.short.yellow(),
                ago(l.at).dimmed(),
                l.author.cyan()
            ),
        );
        if !l.subject.is_empty() {
            println!("           {}", l.subject.dimmed());
        }
        if !l.siblings.is_empty() {
            let n = l.siblings.len();
            let head = l.siblings.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
            let tail = if n > 3 { format!(" and {} more", n - 3) } else { String::new() };
            println!("           {}", format!("with {head}{tail}").dimmed());
        }
        println!();
    }

    // Printed before the reasons, because the reasons are about to be quoted
    // against a path the reader does not recognise.
    if !a.former_paths.is_empty() {
        field("Was", &a.former_paths.join(" ← ").dimmed().to_string());
        println!(
            "           {}\n",
            "history before the rename is included below".dimmed()
        );
    }

    match &a.prompt {
        Some(p) => {
            field("Asked", &format!("\"{}\"", wrap(&p.text, 62, "           ")).green());
            let mut meta = Vec::new();
            if let Some(s) = &a.session {
                meta.push(s.dialect.to_string());
                meta.push(format!("session {}", &s.id[..8.min(s.id.len())]));
            }
            if p.at > 0 {
                meta.push(ago(p.at));
            }
            if let Some(b) = a.session_basis {
                meta.push(b.to_string());
            }
            println!("           {}", meta.join(" · ").dimmed());
            if a.later_prompts > 0 {
                println!(
                    "           {}",
                    format!("{} more prompt(s) followed in that session", a.later_prompts).dimmed()
                );
            }
            println!();
        }
        None => {
            field("Asked", &"— no prompt found for this change".dimmed().to_string());
            println!(
                "           {}\n",
                "run `aura import` to read your agent's past sessions".dimmed()
            );
        }
    }

    match &a.intent {
        Some(r) => {
            field("Intent", &format!("\"{}\"", wrap(&r.intent, 62, "           ")));
            let mut meta = vec![r.agent_id.clone()];
            if let Some(t) = &r.intent_type {
                meta.push(t.clone());
            }
            if r.signed_block_id.is_some() {
                meta.push("signed".to_string());
            }
            if let Some(b) = a.intent_basis {
                meta.push(b.to_string());
            }
            println!("           {}\n", meta.join(" · ").dimmed());
        }
        None => {
            field("Intent", &"— nothing was logged for this change".dimmed().to_string());
            println!();
        }
    }

    if let Some(cp) = &a.checkpoint {
        if let Some(id) = cp.get("checkpoint_id").and_then(|v| v.as_str()) {
            field("Checkpoint", id);
            println!();
        }
    }
}

pub fn to_json(a: &Answer) -> serde_json::Value {
    let mut v = serde_json::json!({
        "path": a.target.path,
        "line": a.target.line,
        "uncommitted": a.uncommitted,
    });
    if let Some(l) = &a.landed {
        v["commit"] = serde_json::json!({
            "sha": l.sha,
            "short": l.short,
            "author": l.author,
            "email": l.email,
            "at": l.at,
            "subject": l.subject,
            "also_changed": l.siblings,
        });
    }
    if let Some(r) = &a.intent {
        let mut i = r.to_json();
        i["basis"] = serde_json::json!(a.intent_basis);
        v["intent"] = i;
    }
    if let Some(s) = &a.session {
        let mut sj = s.to_json();
        sj["basis"] = serde_json::json!(a.session_basis);
        v["session"] = sj;
    }
    if let Some(p) = &a.prompt {
        v["prompt"] = serde_json::json!({
            "at": p.at,
            "text": p.text,
            "later_prompts": a.later_prompts,
        });
    }
    if let Some(cp) = &a.checkpoint {
        v["checkpoint"] = cp.clone();
    }
    if !a.former_paths.is_empty() {
        v["former_paths"] = serde_json::json!(a.former_paths);
    }
    v
}

/// Command entry point. Returns a process exit code.
pub fn run(target: &str, json: bool) -> i32 {
    match answer(target) {
        Ok(a) => {
            if json {
                println!("{}", serde_json::to_string_pretty(&to_json(&a)).unwrap_or_default());
            } else {
                render(&a);
            }
            0
        }
        Err(e) => {
            if json {
                println!("{}", serde_json::json!({"error": e}));
            } else {
                eprintln!("{} {}", "✗".red(), e);
            }
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(ts: u64, file: Option<&str>, session: Option<&str>, intent: &str) -> IntentRow {
        IntentRow {
            timestamp: ts,
            agent_id: "claude".into(),
            intent: intent.into(),
            intent_type: None,
            signed_block_id: None,
            key_id: None,
            source: None,
            file: file.map(|f| f.to_string()),
            session_id: session.map(|s| s.to_string()),
            stated_at: None,
            change: None,
            tool: None,
        }
    }

    #[test]
    fn a_target_splits_into_a_path_and_a_line() {
        assert_eq!(parse_target("src/main.rs:120"), Target { path: "src/main.rs".into(), line: Some(120) });
        assert_eq!(parse_target("src/main.rs"), Target { path: "src/main.rs".into(), line: None });
        // A colon with something that isn't a line number is part of the path,
        // not a broken line number.
        assert_eq!(parse_target("src/main.rs:end"), Target { path: "src/main.rs:end".into(), line: None });
        // Line 0 does not exist; treating it as one would blame the wrong line.
        assert_eq!(parse_target("a.rs:0"), Target { path: "a.rs:0".into(), line: None });
    }

    #[test]
    fn a_row_naming_the_file_beats_a_row_that_merely_overlaps() {
        let rows = vec![
            row(100, None, None, "unrelated work"),
            row(110, Some("src/main.rs"), None, "the actual change"),
            row(120, None, None, "later, still in window"),
        ];
        let (r, basis) = pick_intent(&rows, "src/main.rs", 130, 90).unwrap();
        assert_eq!(r.intent, "the actual change");
        assert_eq!(basis, "names this file");
    }

    #[test]
    fn with_no_row_naming_the_file_the_nearest_in_window_is_used_and_said_so() {
        let rows = vec![row(100, None, None, "first"), row(120, None, None, "nearest")];
        let (r, basis) = pick_intent(&rows, "src/main.rs", 130, 90).unwrap();
        assert_eq!(r.intent, "nearest");
        assert!(basis.contains("logged while"));
    }

    #[test]
    fn a_row_logged_after_the_commit_cannot_explain_it() {
        let rows = vec![row(200, Some("src/main.rs"), None, "written afterwards")];
        assert!(pick_intent(&rows, "src/main.rs", 130, 90).is_none());
    }

    #[test]
    fn paths_are_compared_from_the_right_so_absolute_and_relative_agree() {
        assert!(paths_match("src/main.rs", "src/main.rs"));
        assert!(paths_match("/Users/x/repo/src/main.rs", "src/main.rs"));
        assert!(paths_match("./src/main.rs", "src/main.rs"));
        // A shared basename is not a shared file.
        assert!(!paths_match("other/main.rs", "src/main.rs"));
    }

    #[test]
    fn the_session_chosen_is_the_tightest_one_containing_the_moment() {
        let s = |id: &str, start: u64, end: u64| history::Session {
            dialect: "claude",
            id: id.into(),
            cwd: Some("/repo".into()),
            cwd_digest: None,
            branch: None,
            title: None,
            started_at: start,
            last_activity_at: end,
            prompts: Some(1),
            steps: Some(1),
            path: PathBuf::new(),
        };
        let all = vec![s("wide", 0, 1000), s("tight", 90, 140), s("elsewhere", 90, 140)];
        let mut all = all;
        all[2].cwd = Some("/other".into());

        let got = pick_session_by_time(all, Path::new("/repo"), 120).unwrap();
        assert_eq!(got.id, "tight", "a session that merely overlaps loses to one that fits");

        // A moment nothing was running for is an honest None.
        let none = pick_session_by_time(Vec::new(), Path::new("/repo"), 120);
        assert!(none.is_none());
    }

    #[test]
    fn a_session_in_another_repo_never_explains_this_one() {
        let s = history::Session {
            dialect: "claude",
            id: "x".into(),
            cwd: Some("/other".into()),
            cwd_digest: None,
            branch: None,
            title: None,
            started_at: 0,
            last_activity_at: 1000,
            prompts: Some(1),
            steps: Some(1),
            path: PathBuf::new(),
        };
        assert!(pick_session_by_time(vec![s], Path::new("/repo"), 500).is_none());
    }

    #[test]
    fn long_prompts_wrap_under_their_label() {
        let text = "make the retry logic back off exponentially instead of hammering the endpoint";
        let out = wrap(text, 30, "  ");
        assert!(out.lines().count() > 1);
        assert!(out.lines().skip(1).all(|l| l.starts_with("  ")));
        // Wrapping must not lose or reorder words.
        let flat: Vec<&str> = out.split_whitespace().collect();
        let orig: Vec<&str> = text.split_whitespace().collect();
        assert_eq!(flat, orig);
    }

    // ─── Renames: a file's reasons survive it changing name ────────────────
    //
    // The audit finding these pin: `src/retry.rs` became `src/backoff.rs`, and
    // asking about the new path could no longer reach anything written about
    // the old one — so the answer quietly fell through to the weakest tier and
    // reported an unrelated file's intent as this file's.

    #[test]
    fn a_reason_written_before_a_rename_is_still_this_file_s_reason() {
        let rows = vec![row(100, Some("src/retry.rs"), None, "exponential backoff")];
        let (r, basis) = pick_intent_across(
            &rows,
            &["src/backoff.rs", "src/retry.rs"],
            130,
            90,
        )
        .unwrap();
        assert_eq!(r.intent, "exponential backoff");
        assert_eq!(basis, "names this file under the path it had then");
    }

    #[test]
    fn a_former_name_beats_an_unrelated_row_that_merely_overlaps() {
        // Exactly the shape that produced the wrong answer: the row that names
        // the file (under its old path) is OLDER than an unrelated one, so the
        // "logged while this commit was being written" tier would take the
        // wrong one.
        let rows = vec![
            row(100, Some("src/retry.rs"), None, "exponential backoff"),
            row(120, Some("src/other.rs"), None, "bump the copyright header"),
        ];
        let (r, _) = pick_intent_across(
            &rows,
            &["src/backoff.rs", "src/retry.rs"],
            130,
            90,
        )
        .unwrap();
        assert_eq!(r.intent, "exponential backoff", "an older row about THIS file wins");
    }

    #[test]
    fn the_current_name_still_outranks_a_former_one() {
        let rows = vec![
            row(100, Some("src/backoff.rs"), None, "after the rename"),
            row(120, Some("src/retry.rs"), None, "before the rename"),
        ];
        let (r, basis) = pick_intent_across(
            &rows,
            &["src/backoff.rs", "src/retry.rs"],
            130,
            90,
        )
        .unwrap();
        assert_eq!(r.intent, "after the rename");
        assert_eq!(basis, "names this file");
    }

    #[test]
    fn with_no_former_name_matching_the_window_tier_still_applies() {
        let rows = vec![row(120, Some("src/elsewhere.rs"), None, "something else")];
        let (_, basis) = pick_intent_across(&rows, &["a.rs", "b.rs"], 130, 90).unwrap();
        assert!(basis.contains("logged while"), "guess must still be labelled a guess");
    }

    /// A repo with one rename in it, plus the file's current path.
    fn repo_with_a_rename() -> (tempfile::TempDir, git2::Repository) {
        let dir = tempfile::tempdir().expect("tempdir");
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            assert!(ok, "git {:?} failed", args);
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t.t"]);
        git(&["config", "user.name", "Tester"]);
        std::fs::create_dir_all(dir.path().join("src")).expect("mkdir");
        std::fs::write(dir.path().join("src/retry.rs"), "fn retry() {}\n").expect("write");
        std::fs::write(dir.path().join("src/steady.rs"), "fn steady() {}\n").expect("write");
        git(&["add", "-A"]);
        git(&["commit", "-qm", "first"]);
        git(&["mv", "src/retry.rs", "src/backoff.rs"]);
        git(&["commit", "-qm", "rename"]);
        let repo = git2::Repository::open(dir.path()).expect("open");
        (dir, repo)
    }

    #[test]
    fn known_as_reports_the_path_a_renamed_file_used_to_have() {
        let (_dir, repo) = repo_with_a_rename();
        let names = known_as(&repo, Path::new("src/backoff.rs"));
        assert_eq!(names, vec!["src/backoff.rs".to_string(), "src/retry.rs".to_string()]);
    }

    #[test]
    fn known_as_leaves_a_file_that_was_never_renamed_alone() {
        let (_dir, repo) = repo_with_a_rename();
        let names = known_as(&repo, Path::new("src/steady.rs"));
        assert_eq!(names, vec!["src/steady.rs".to_string()]);
    }

    #[test]
    fn a_pre_rename_commit_does_not_list_the_file_as_its_own_sibling() {
        let (_dir, repo) = repo_with_a_rename();
        let known = known_as(&repo, Path::new("src/backoff.rs"));
        // The rename commit: the only path in its diff is the file itself,
        // under both names.
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let facts = commit_facts(&repo, head.id(), &known).expect("facts");
        assert!(
            facts.siblings.is_empty(),
            "a file must not be listed as changing alongside itself: {:?}",
            facts.siblings
        );
    }
}
