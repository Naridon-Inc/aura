// M4a — sovereign substrate, slice 1 (AURA-22): core logic for the
// `aura meta` meaning-plane round-trip.
//
// The intent log (.aura/intent_log.jsonl) is mirrored onto STANDARD git
// notes under `refs/notes/aura-intent` so WHO/WHY travels with the repo
// through any git remote — GitHub included — with nothing exotic. One
// note per commit; note content is JSON Lines, one object per intent
// row: {ts, agent_id, intent, intent_type, key_id, signed_block_id}.
// Metadata only — code bytes never enter a note.
//
// Everything here is pure git2 + filesystem so the hermetic tests can
// drive it directly; shelling out to the `git` binary happens only in
// meta_refs.rs and only for transport (push/fetch of the notes ref).

use git2::{Oid, Repository, Signature};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::intent_query::IntentRow;

/// The meaning-plane ref. Plain `git push origin refs/notes/aura-intent`
/// round-trips it through any host.
pub const NOTES_REF: &str = "refs/notes/aura-intent";

/// Staging ref `aura meta pull` fetches into before union-merging, so a
/// diverged remote never clobbers local notes. Deleted after merge.
pub const INCOMING_REF: &str = "refs/notes/aura-intent-incoming";

/// One JSON line inside a note. Field order is fixed by this struct so
/// serialisation is deterministic — union-merge dedupes on the EXACT
/// line, which only works if every machine renders rows identically.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoteLine {
    pub ts: u64,
    pub agent_id: String,
    pub intent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed_block_id: Option<String>,
}

impl From<&IntentRow> for NoteLine {
    fn from(r: &IntentRow) -> Self {
        NoteLine {
            ts: r.timestamp,
            agent_id: r.agent_id.clone(),
            intent: r.intent.clone(),
            intent_type: r.intent_type.clone(),
            key_id: r.key_id.clone(),
            signed_block_id: r.signed_block_id.clone(),
        }
    }
}

/// Canonical single-line rendering of a row. Never fails in practice;
/// the fallback keeps the row visible rather than dropping it.
pub fn render_note_line(line: &NoteLine) -> String {
    serde_json::to_string(line).unwrap_or_else(|_| {
        format!(
            "{{\"ts\":{},\"agent_id\":\"?\",\"intent\":\"unserialisable row\"}}",
            line.ts
        )
    })
}

/// Parse one note line back into a NoteLine. Tolerant: accepts `ts` or
/// the intent-log's legacy `timestamp` key, and missing optional fields.
/// Returns None for blank / non-JSON / intent-less lines.
pub fn parse_note_line(line: &str) -> Option<NoteLine> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let intent = v.get("intent")?.as_str()?.to_string();
    let ts = v
        .get("ts")
        .and_then(|t| t.as_u64())
        .or_else(|| v.get("timestamp").and_then(|t| t.as_u64()))
        .unwrap_or(0);
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
    Some(NoteLine {
        ts,
        agent_id: s("agent_id").unwrap_or_else(|| "unknown".to_string()),
        intent,
        intent_type: s("intent_type"),
        key_id: s("key_id"),
        signed_block_id: s("signed_block_id"),
    })
}

/// Union of an existing note body and new lines: existing order is
/// preserved, additions append in input order, duplicates (exact line
/// match) are dropped. Returns the merged body and how many of the
/// additions were genuinely new.
pub fn union_lines(existing: Option<&str>, additions: &[String]) -> (String, usize) {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    if let Some(body) = existing {
        for raw in body.lines() {
            let l = raw.trim();
            if l.is_empty() {
                continue;
            }
            if seen.insert(l.to_string()) {
                out.push(l.to_string());
            }
        }
    }
    let mut added = 0usize;
    for raw in additions {
        let l = raw.trim();
        if l.is_empty() {
            continue;
        }
        if seen.insert(l.to_string()) {
            out.push(l.to_string());
            added += 1;
        }
    }
    let mut body = out.join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    (body, added)
}

/// One commit's attribution window: an intent row belongs to commit C
/// when its timestamp falls in (parent_commit_time, commit_time].
#[derive(Debug, Clone)]
pub struct CommitWindow {
    pub oid: Oid,
    /// Lower-cased "author name <email> committer name <email>" haystack
    /// used to prefer agent_id matches when windows overlap (merges).
    pub who: String,
    pub parent_time: i64,
    pub commit_time: i64,
}

/// Result of attributing intent rows to a set of commit windows.
pub struct Attribution {
    /// Parallel to the input windows: the note lines each commit gets,
    /// sorted oldest-first within a commit for readable notes.
    pub per_commit: Vec<Vec<NoteLine>>,
    /// Rows that fell inside some commit's window.
    pub windowed: usize,
    /// Rows outside every window — attached to the newest commit so
    /// nothing is dropped silently.
    pub unmatched: usize,
}

fn agent_matches(window: &CommitWindow, agent_id: &str) -> bool {
    let a = agent_id.trim().to_lowercase();
    if a.len() < 2 || a == "unknown" {
        return false;
    }
    window.who.contains(&a)
}

/// Attribute each row to a commit. Window rule first; when several
/// windows contain the timestamp (merge topologies), prefer a commit
/// whose author/committer matches the row's agent_id, then the commit
/// that sealed the work earliest (smallest commit_time). Rows matching
/// no window attach to the newest commit in range.
pub fn attribute_rows(windows: &[CommitWindow], rows: &[IntentRow]) -> Attribution {
    let mut per_commit: Vec<Vec<NoteLine>> = vec![Vec::new(); windows.len()];
    let mut windowed = 0usize;
    let mut unmatched = 0usize;

    // Newest commit = max commit_time; ties resolve to the earliest
    // index, which is the one closest to the walked tip.
    let newest_idx = windows
        .iter()
        .enumerate()
        .max_by(|a, b| {
            a.1.commit_time
                .cmp(&b.1.commit_time)
                .then_with(|| b.0.cmp(&a.0))
        })
        .map(|(i, _)| i);

    for row in rows {
        let ts = row.timestamp.min(i64::MAX as u64) as i64;
        let candidates: Vec<usize> = windows
            .iter()
            .enumerate()
            .filter(|(_, w)| ts > w.parent_time && ts <= w.commit_time)
            .map(|(i, _)| i)
            .collect();

        let target = if candidates.is_empty() {
            match newest_idx {
                Some(i) => {
                    unmatched += 1;
                    i
                }
                None => continue, // no commits in range at all
            }
        } else {
            windowed += 1;
            let preferred: Vec<usize> = candidates
                .iter()
                .copied()
                .filter(|&i| agent_matches(&windows[i], &row.agent_id))
                .collect();
            let pool = if preferred.is_empty() {
                &candidates
            } else {
                &preferred
            };
            pool.iter()
                .copied()
                .min_by_key(|&i| windows[i].commit_time)
                .expect("non-empty candidate pool")
        };
        per_commit[target].push(NoteLine::from(row));
    }

    for lines in per_commit.iter_mut() {
        lines.sort_by(|a, b| a.ts.cmp(&b.ts));
    }

    Attribution {
        per_commit,
        windowed,
        unmatched,
    }
}

// pub(crate): refs_sign reuses the same note-author signature fallback.
pub(crate) fn signature(repo: &Repository) -> Signature<'static> {
    repo.signature().unwrap_or_else(|_| {
        Signature::now("aura", "meta@aura.local").expect("static signature")
    })
}

pub(crate) fn note_body(repo: &Repository, notes_ref: &str, oid: Oid) -> Option<String> {
    repo.find_note(Some(notes_ref), oid)
        .ok()
        .and_then(|n| n.message().map(|m| m.to_string()))
}

/// Build attribution windows for the requested range.
/// - `Some("a..b")`  → that rev range (already-noted commits included,
///   union-merge keeps it idempotent).
/// - `Some(rev)`     → everything reachable from rev.
/// - `None`          → commits on HEAD that have no aura-intent note yet.
pub fn collect_range_windows(
    repo: &Repository,
    range: Option<&str>,
) -> Result<Vec<CommitWindow>, Box<dyn std::error::Error>> {
    let mut walk = repo.revwalk()?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    match range {
        Some(r) if r.contains("..") => walk.push_range(r)?,
        Some(r) => {
            let commit = repo.revparse_single(r)?.peel_to_commit()?;
            walk.push(commit.id())?;
        }
        None => walk.push_head()?,
    }

    let skip_noted = range.is_none();
    let mut windows = Vec::new();
    for oid in walk {
        let oid = oid?;
        if skip_noted && repo.find_note(Some(NOTES_REF), oid).is_ok() {
            continue;
        }
        let commit = repo.find_commit(oid)?;
        let parent_time = commit
            .parent(0)
            .map(|p| p.time().seconds())
            .unwrap_or(0);
        let author = commit.author();
        let committer = commit.committer();
        let who = format!(
            "{} <{}> {} <{}>",
            author.name().unwrap_or(""),
            author.email().unwrap_or(""),
            committer.name().unwrap_or(""),
            committer.email().unwrap_or(""),
        )
        .to_lowercase();
        windows.push(CommitWindow {
            oid,
            who,
            parent_time,
            commit_time: commit.time().seconds(),
        });
    }
    Ok(windows)
}

/// Every exact line currently stored anywhere under `notes_ref` — the
/// global dedupe set that stops a row re-attaching to a different
/// commit on a later push (the default range only covers un-noted
/// commits, so without this an already-pushed old row would look
/// "unmatched" and pile onto the newest commit).
fn existing_note_lines(repo: &Repository, notes_ref: &str) -> HashSet<String> {
    let mut set = HashSet::new();
    if let Ok(notes) = repo.notes(Some(notes_ref)) {
        for entry in notes.flatten() {
            let (_note_oid, annotated) = entry;
            if let Some(body) = note_body(repo, notes_ref, annotated) {
                for raw in body.lines() {
                    let l = raw.trim();
                    if !l.is_empty() {
                        set.insert(l.to_string());
                    }
                }
            }
        }
    }
    set
}

/// What `aura meta push` did locally (transport is reported separately).
#[derive(Debug, Serialize)]
pub struct PushReport {
    pub commits_in_range: usize,
    pub commits_noted: usize,
    pub rows_attached: usize,
    pub rows_windowed: usize,
    pub rows_unmatched: usize,
    pub rows_already_noted: usize,
}

/// Attribute the repo's intent-log rows to the commits in `range` and
/// write/merge them as notes under refs/notes/aura-intent. Idempotent:
/// rows already present anywhere in the ref are skipped, and per-note
/// writes are a union of exact lines.
pub fn write_notes_for_range(
    repo: &Repository,
    range: Option<&str>,
) -> Result<PushReport, Box<dyn std::error::Error>> {
    let windows = collect_range_windows(repo, range)?;

    let log_path = repo
        .workdir()
        .map(|w| w.join(".aura").join("intent_log.jsonl"))
        .unwrap_or_else(|| repo.path().join("intent_log.jsonl"));
    let all_rows = crate::intent_query::read_all_rows(&log_path);

    let existing = existing_note_lines(repo, NOTES_REF);
    let mut rows_already_noted = 0usize;
    let fresh: Vec<IntentRow> = all_rows
        .into_iter()
        .filter(|r| {
            let line = render_note_line(&NoteLine::from(r));
            if existing.contains(&line) {
                rows_already_noted += 1;
                false
            } else {
                true
            }
        })
        .collect();

    let attribution = attribute_rows(&windows, &fresh);
    let sig = signature(repo);
    let mut commits_noted = 0usize;
    let mut rows_attached = 0usize;
    for (window, lines) in windows.iter().zip(attribution.per_commit.iter()) {
        if lines.is_empty() {
            continue;
        }
        let rendered: Vec<String> = lines.iter().map(render_note_line).collect();
        let current = note_body(repo, NOTES_REF, window.oid);
        let (merged, added) = union_lines(current.as_deref(), &rendered);
        if added == 0 {
            continue;
        }
        repo.note(&sig, &sig, Some(NOTES_REF), window.oid, &merged, true)?;
        commits_noted += 1;
        rows_attached += added;
    }

    Ok(PushReport {
        commits_in_range: windows.len(),
        commits_noted,
        rows_attached,
        rows_windowed: attribution.windowed,
        rows_unmatched: attribution.unmatched,
        rows_already_noted,
    })
}

/// What `aura meta pull` merged after the transport fetch.
#[derive(Debug, Serialize)]
pub struct PullReport {
    /// False when the fetch found no remote ref (nothing staged).
    pub incoming_present: bool,
    pub commits_seen: usize,
    pub commits_updated: usize,
    pub lines_added: usize,
}

/// Union-merge refs/notes/aura-intent-incoming into the local
/// refs/notes/aura-intent (cat_sort_uniq semantics, implemented as
/// exact-line union per commit), then delete the staging ref.
pub fn merge_incoming_notes(
    repo: &Repository,
) -> Result<PullReport, Box<dyn std::error::Error>> {
    let incoming: Vec<Oid> = match repo.notes(Some(INCOMING_REF)) {
        Ok(notes) => notes.flatten().map(|(_, annotated)| annotated).collect(),
        Err(_) => {
            return Ok(PullReport {
                incoming_present: false,
                commits_seen: 0,
                commits_updated: 0,
                lines_added: 0,
            });
        }
    };

    let sig = signature(repo);
    let mut commits_updated = 0usize;
    let mut lines_added = 0usize;
    for annotated in &incoming {
        let Some(theirs) = note_body(repo, INCOMING_REF, *annotated) else {
            continue;
        };
        let their_lines: Vec<String> = theirs
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        let mine = note_body(repo, NOTES_REF, *annotated);
        let (merged, added) = union_lines(mine.as_deref(), &their_lines);
        if added == 0 {
            continue;
        }
        repo.note(&sig, &sig, Some(NOTES_REF), *annotated, &merged, true)?;
        commits_updated += 1;
        lines_added += added;
    }

    if let Ok(mut staging) = repo.find_reference(INCOMING_REF) {
        staging.delete()?;
    }

    Ok(PullReport {
        incoming_present: true,
        commits_seen: incoming.len(),
        commits_updated,
        lines_added,
    })
}

/// One noted commit as surfaced by `aura meta log`.
#[derive(Debug, Serialize)]
pub struct LogEntry {
    pub sha: String,
    pub short: String,
    pub summary: String,
    pub rows: Vec<NoteLine>,
}

/// Walk HEAD newest-first and collect up to `limit` commits that carry
/// an aura-intent note. Rows render oldest-first within a commit.
pub fn collect_log(
    repo: &Repository,
    limit: usize,
) -> Result<Vec<LogEntry>, Box<dyn std::error::Error>> {
    let mut walk = repo.revwalk()?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    walk.push_head()?;

    let mut entries = Vec::new();
    for oid in walk {
        if entries.len() >= limit {
            break;
        }
        let oid = oid?;
        let Some(body) = note_body(repo, NOTES_REF, oid) else {
            continue;
        };
        let mut rows: Vec<NoteLine> = body.lines().filter_map(parse_note_line).collect();
        if rows.is_empty() {
            continue;
        }
        rows.sort_by(|a, b| a.ts.cmp(&b.ts));
        let commit = repo.find_commit(oid)?;
        entries.push(LogEntry {
            sha: oid.to_string(),
            short: oid.to_string().chars().take(7).collect(),
            summary: commit.summary().unwrap_or("").to_string(),
            rows,
        });
    }
    Ok(entries)
}
