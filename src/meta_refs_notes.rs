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
    /// The proof snapshot riding the parallel `refs/notes/aura-proof`
    /// plane, when this commit carries one. `None` for commits with no
    /// recorded goal verdict.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proof: Option<ProofNote>,
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
        let proof = note_body(repo, PROOF_REF, oid).and_then(|b| parse_proof_note(&b));
        entries.push(LogEntry {
            sha: oid.to_string(),
            short: oid.to_string().chars().take(7).collect(),
            summary: commit.summary().unwrap_or("").to_string(),
            rows,
            proof,
        });
    }
    Ok(entries)
}

// ─────────────────────────────────────────────────────────────────────────
// The PROOF plane — a second, parallel notes ref `refs/notes/aura-proof`.
//
// The intent plane (above) carries WHO/WHY. This one carries WHETHER IT'S
// PROVEN: per commit, the goal-ledger verdict at the time the commit was
// built. Together a vanilla GitHub/GitLab/self-hosted clone can show the
// reason for a change AND whether the code actually delivers it — verified
// offline, no server. Like the intent ref it is plain git: the only artifact
// is a standard notes ref any host round-trips.
//
// Crucial difference from intent: proof is a SNAPSHOT, newest wins. A commit
// has one current verdict, not a growing union of rows — so writes
// force-replace the note and pull resolves divergence by newest `at`, never
// by union. Binding a note to a commit via the FULL oid lets `aura meta
// verify` reject a note that's been re-pointed at the wrong commit.
// ─────────────────────────────────────────────────────────────────────────

use crate::goals::model::Verdict;
use crate::goals::store as goal_store;

/// The proof plane ref. `git push origin refs/notes/aura-proof` round-trips
/// it through any host, exactly like the intent ref.
pub const PROOF_REF: &str = "refs/notes/aura-proof";

/// Staging ref `aura meta pull` fetches proof notes into before resolving
/// them by newest-wins into PROOF_REF. Deleted after merge.
pub const INCOMING_PROOF_REF: &str = "refs/notes/aura-proof-incoming";

/// One goal's verdict inside a commit's proof snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProofGoal {
    pub id: String,
    pub text: String,
    pub verdict: String,
    pub ok: usize,
    pub total: usize,
}

/// A commit's proof snapshot: the rolled-up verdict plus the per-goal
/// breakdown that produced it. `commit` is the FULL oid so the note binds to
/// exactly one commit — a re-pointed note is detectable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProofNote {
    /// FULL commit oid this snapshot proves. Binds note → commit.
    pub commit: String,
    /// Rolled-up verdict: "verified" | "partial" | "not_wired" | "unknown".
    pub verdict: String,
    /// Sum of requirements met across the matching goals.
    pub ok: usize,
    /// Sum of total requirements across the matching goals.
    pub total: usize,
    pub goals: Vec<ProofGoal>,
    /// Newest matching run's `at` (unix millis), the snapshot's age.
    pub at: u64,
}

/// Render the snake_case verdict string the ledger and frontend share.
fn verdict_str(v: Verdict) -> &'static str {
    match v {
        Verdict::Verified => "verified",
        Verdict::Partial => "partial",
        Verdict::NotWired => "not_wired",
        Verdict::Unknown => "unknown",
    }
}

/// Roll several goal verdicts into one by precedence: all Verified →
/// "verified"; else any Verified/Partial → "partial"; else any NotWired →
/// "not_wired"; else "unknown". Matches the frontend rollup intent.
fn rollup_verdict(verdicts: &[Verdict]) -> &'static str {
    if verdicts.is_empty() {
        return "unknown";
    }
    if verdicts.iter().all(|v| *v == Verdict::Verified) {
        return "verified";
    }
    if verdicts
        .iter()
        .any(|v| *v == Verdict::Verified || *v == Verdict::Partial)
    {
        return "partial";
    }
    if verdicts.iter().any(|v| *v == Verdict::NotWired) {
        return "not_wired";
    }
    "unknown"
}

/// Build the proof snapshot for `full_oid` from the goal ledger at `root`.
///
/// A goal counts for this commit when it has ANY run whose non-empty
/// `commit` (a short sha prefix) is a prefix of the full oid. For each such
/// goal the NEWEST matching run supplies its verdict/ok/total/at. Returns
/// `None` when no goal matches, so commits with no recorded proof get no
/// note (don't manufacture an "unknown" snapshot for every commit).
pub fn build_proof_note(root: &std::path::Path, full_oid: &str) -> Option<ProofNote> {
    let goals = goal_store::load(root);
    let mut proof_goals: Vec<ProofGoal> = Vec::new();
    let mut verdicts: Vec<Verdict> = Vec::new();
    let mut ok_sum = 0usize;
    let mut total_sum = 0usize;
    let mut newest_at = 0u64;

    for g in &goals {
        // Newest matching run = the first run (newest-first) whose non-empty
        // commit prefixes this oid.
        let matching = g.runs.iter().find(|r| {
            r.commit
                .as_deref()
                .map(|c| !c.is_empty() && full_oid.starts_with(c))
                .unwrap_or(false)
        });
        let Some(run) = matching else {
            continue;
        };
        verdicts.push(run.verdict);
        ok_sum += run.ok;
        total_sum += run.total;
        if run.at > newest_at {
            newest_at = run.at;
        }
        proof_goals.push(ProofGoal {
            id: g.id.clone(),
            text: g.text.clone(),
            verdict: verdict_str(run.verdict).to_string(),
            ok: run.ok,
            total: run.total,
        });
    }

    if proof_goals.is_empty() {
        return None;
    }

    Some(ProofNote {
        commit: full_oid.to_string(),
        verdict: rollup_verdict(&verdicts).to_string(),
        ok: ok_sum,
        total: total_sum,
        goals: proof_goals,
        at: newest_at,
    })
}

/// Compact, deterministic single-line JSON rendering of a proof snapshot.
/// Field order is fixed by the struct so two machines render an identical
/// body for an identical snapshot (the newest-wins compare needs this).
pub fn render_proof_note(n: &ProofNote) -> String {
    serde_json::to_string(n).unwrap_or_else(|_| {
        format!(
            "{{\"commit\":\"{}\",\"verdict\":\"unknown\",\"ok\":0,\"total\":0,\"goals\":[],\"at\":{}}}",
            n.commit, n.at
        )
    })
}

/// Parse a proof-note body back into a snapshot. Tolerant of surrounding
/// whitespace; `None` for blank / non-JSON / shape-mismatched bodies.
pub fn parse_proof_note(body: &str) -> Option<ProofNote> {
    let body = body.trim();
    if body.is_empty() {
        return None;
    }
    serde_json::from_str::<ProofNote>(body).ok()
}

/// What `aura meta push` did to the PROOF plane locally.
#[derive(Debug, Serialize)]
pub struct ProofPushReport {
    pub commits_in_range: usize,
    /// Commits in range that have a proof snapshot at all.
    pub commits_proven: usize,
    /// Commits whose proof note was written/replaced (changed vs existing).
    pub commits_changed: usize,
}

/// Walk the commits in `range` and write each one's current proof snapshot
/// as a note under PROOF_REF. Proof is a SNAPSHOT, newest wins: the note is
/// force-replaced when the freshly-built body differs from the stored one —
/// NOT union-merged. For the default (`None`) range a commit is included
/// unless it already carries an UNCHANGED proof note (so a re-prove that
/// changes the verdict still lands).
pub fn write_proof_for_range(
    repo: &Repository,
    range: Option<&str>,
) -> Result<ProofPushReport, Box<dyn std::error::Error>> {
    // Reuse the intent walker for the same topology, but we must NOT skip on
    // the intent ref — proof has its own ref. For the default range, force an
    // explicit "HEAD" walk so collect_range_windows doesn't drop commits that
    // happen to lack an aura-intent note.
    let windows = match range {
        Some(_) => collect_range_windows(repo, range)?,
        None => collect_range_windows(repo, Some("HEAD"))?,
    };

    let root = repo
        .workdir()
        .map(|w| w.to_path_buf())
        .unwrap_or_else(|| repo.path().to_path_buf());

    let sig = signature(repo);
    let mut commits_proven = 0usize;
    let mut commits_changed = 0usize;

    for window in &windows {
        let full_oid = window.oid.to_string();
        let Some(note) = build_proof_note(&root, &full_oid) else {
            continue;
        };
        commits_proven += 1;
        let body = render_proof_note(&note);
        let current = note_body(repo, PROOF_REF, window.oid);
        if current.as_deref().map(str::trim) == Some(body.trim()) {
            continue; // unchanged snapshot — nothing to do
        }
        repo.note(&sig, &sig, Some(PROOF_REF), window.oid, &body, true)?;
        commits_changed += 1;
    }

    Ok(ProofPushReport {
        commits_in_range: windows.len(),
        commits_proven,
        commits_changed,
    })
}

/// What `aura meta pull` resolved on the PROOF plane after the fetch.
#[derive(Debug, Serialize)]
pub struct ProofPullReport {
    /// False when the fetch found no remote proof ref (nothing staged).
    pub incoming_present: bool,
    pub commits_seen: usize,
    pub commits_updated: usize,
}

/// Resolve `refs/notes/aura-proof-incoming` into the local
/// `refs/notes/aura-proof` by NEWEST-`at`-WINS per commit (proof is a
/// snapshot, not a union): parse both sides, keep whichever has the larger
/// `at`; write the incoming one only when it is strictly newer. Then delete
/// the staging ref.
pub fn merge_incoming_proof(
    repo: &Repository,
) -> Result<ProofPullReport, Box<dyn std::error::Error>> {
    let incoming: Vec<Oid> = match repo.notes(Some(INCOMING_PROOF_REF)) {
        Ok(notes) => notes.flatten().map(|(_, annotated)| annotated).collect(),
        Err(_) => {
            return Ok(ProofPullReport {
                incoming_present: false,
                commits_seen: 0,
                commits_updated: 0,
            });
        }
    };

    let sig = signature(repo);
    let mut commits_updated = 0usize;
    for annotated in &incoming {
        let Some(their_body) = note_body(repo, INCOMING_PROOF_REF, *annotated) else {
            continue;
        };
        let Some(theirs) = parse_proof_note(&their_body) else {
            continue;
        };
        let mine = note_body(repo, PROOF_REF, *annotated).and_then(|b| parse_proof_note(&b));
        let keep_incoming = match &mine {
            Some(m) => theirs.at > m.at,
            None => true,
        };
        if !keep_incoming {
            continue;
        }
        let body = render_proof_note(&theirs);
        repo.note(&sig, &sig, Some(PROOF_REF), *annotated, &body, true)?;
        commits_updated += 1;
    }

    if let Ok(mut staging) = repo.find_reference(INCOMING_PROOF_REF) {
        staging.delete()?;
    }

    Ok(ProofPullReport {
        incoming_present: true,
        commits_seen: incoming.len(),
        commits_updated,
    })
}

// ─────────────────────────────────────────────────────────────────────────
// `aura meta verify` — offline, server-free audit of the two planes.
// ─────────────────────────────────────────────────────────────────────────

/// One commit's verification result.
#[derive(Debug, Serialize)]
pub struct VerifyPerCommit {
    pub sha: String,
    pub short: String,
    pub summary: String,
    /// Does this commit carry an aura-intent note?
    pub has_intent: bool,
    /// The parsed proof snapshot, when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proof: Option<ProofNote>,
    /// Proof present AND its `commit` field equals this commit's full oid.
    pub binding_ok: bool,
}

/// The whole-range verdict `aura meta verify` reports.
#[derive(Debug, Serialize)]
pub struct VerifyReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<String>,
    pub commits: usize,
    pub intent_covered: usize,
    pub proven: usize,
    /// One line per binding problem found.
    pub issues: Vec<String>,
    /// True when no commit's proof note is mis-bound to its oid.
    pub ok: bool,
    pub per_commit: Vec<VerifyPerCommit>,
}

/// Max commits a default (HEAD) verify walk inspects, so a huge history
/// can't run unbounded.
const VERIFY_CAP: usize = 200;

/// Walk the commits in `range` (default = HEAD, capped at VERIFY_CAP) and
/// check, per commit: whether it carries intent, whether it carries a proof
/// snapshot, and whether that snapshot binds back to the right oid. A proof
/// note whose `commit` field doesn't match the commit it's attached to is an
/// issue (it's been re-pointed or tampered) and makes the report `ok=false`.
pub fn verify_range(
    repo: &Repository,
    range: Option<&str>,
) -> Result<VerifyReport, Box<dyn std::error::Error>> {
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

    let mut per_commit: Vec<VerifyPerCommit> = Vec::new();
    let mut intent_covered = 0usize;
    let mut proven = 0usize;
    let mut issues: Vec<String> = Vec::new();

    for oid in walk {
        if per_commit.len() >= VERIFY_CAP {
            break;
        }
        let oid = oid?;
        let full = oid.to_string();
        let short: String = full.chars().take(7).collect();
        let commit = repo.find_commit(oid)?;
        let summary = commit.summary().unwrap_or("").to_string();

        let has_intent = note_body(repo, NOTES_REF, oid).is_some();
        if has_intent {
            intent_covered += 1;
        }

        let proof = note_body(repo, PROOF_REF, oid).and_then(|b| parse_proof_note(&b));
        let binding_ok = match &proof {
            Some(p) => {
                proven += 1;
                if p.commit == full {
                    true
                } else {
                    issues.push(format!(
                        "{}: proof note binds to {} but is attached to {}",
                        short, p.commit, full
                    ));
                    false
                }
            }
            None => false,
        };

        per_commit.push(VerifyPerCommit {
            sha: full,
            short,
            summary,
            has_intent,
            proof,
            binding_ok,
        });
    }

    let ok = issues.is_empty();
    Ok(VerifyReport {
        range: range.map(|s| s.to_string()),
        commits: per_commit.len(),
        intent_covered,
        proven,
        issues,
        ok,
        per_commit,
    })
}
