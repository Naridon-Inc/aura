// W5 — sleep-time reflection (AURA-43): promote episodic patterns into
// semantic memory.
//
// The episodic plane records what HAPPENED (intent-log rows, pre-edit
// snapshots); the semantic store records what is TRUE. Reflection is the
// bridge: it re-reads the episodic signals Aura already writes and, when
// a durable pattern emerges, lands it as a normal memory entry through
// the SAME W2/W3 pipeline every other write uses — provenance-stamped,
// signed, reconciled (dedup → supersede-never-delete). A reflected fact
// is therefore indistinguishable in rigor from one a human stated.
//
// Deliberately DETERMINISTIC. The Letta/GAM-style "reflection agent" is
// an LLM summarizer; ours is three evidence rules a reader can audit:
//
//   1. bugfix-recurrence — one file drew ≥3 BugFix-typed intents:
//      that is a fragile spot, future sessions should know before
//      touching it. → gotcha
//   2. sustained-focus — one file changed on ≥3 distinct days: that is
//      where the project's attention actually lives, regardless of what
//      anyone wrote down. → context
//   3. churn — ≥8 pre-edit snapshots of one file inside 48h: heavy
//      rewriting in a short window, historically where regressions come
//      from. → gotcha
//
// Each promotion happens AT MOST once per new evidence: a watermark
// (`.aura/memory-reflect.json`) remembers the newest episodic timestamp
// already reflected over, and a candidate is only promoted when some of
// its evidence is newer. Re-running with no new history is a no-op; the
// W3 reconcile dedup backstops even that.
//
// The daemon's 30-minute consolidation loop shells out to
// `aura memory reflect` (one code path — the loop and a human running
// the verb can never diverge), so promotion literally happens while the
// user sleeps.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

use crate::intent_query::{self, IntentRow};
use crate::memory::{reconcile::ReconcileOp, MemoryManager};

/// Minimum BugFix-typed intents on one file to call it a fragile spot.
pub const BUGFIX_MIN: usize = 3;
/// Minimum distinct days of changes on one file to call it a focus.
pub const FOCUS_MIN_DAYS: usize = 3;
/// Minimum pre-edit snapshots of one file inside [`CHURN_WINDOW_SECS`].
pub const CHURN_MIN: usize = 8;
pub const CHURN_WINDOW_SECS: u64 = 48 * 3600;
/// How far back reflection reads by default — 30 days.
pub const DEFAULT_WINDOW_HOURS: u64 = 720;

/// Where the reflection watermark lives, relative to the repo root.
pub const WATERMARK_FILE: &str = ".aura/memory-reflect.json";

// ───────────────────────── signals ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalKind {
    /// A row from `.aura/intent_log.jsonl`.
    Intent,
    /// A pre-edit snapshot in `.aura/snapshots/`.
    Snapshot,
}

/// One episodic observation, normalised to what the rules need.
#[derive(Debug, Clone)]
pub struct Signal {
    pub ts: u64,
    pub kind: SignalKind,
    pub file: Option<String>,
    /// Canonical intent type when stated (`BugFix`, …).
    pub intent_type: Option<String>,
    /// The intent text; empty for snapshots.
    pub intent: String,
    /// True when the text is the hook restating the edit rather than a
    /// reason somebody wrote — such text must never be QUOTED as
    /// somebody's words, though the edit it records still counts as
    /// activity.
    ///
    /// This used to be `source.is_some()`, and `source` cannot answer it:
    /// `hook_auto` is the DEFAULT value of `log-intent --source`, so it
    /// rides on stated reasons too — 4,705 of the 6,019 rows in this
    /// repo's own log carry it. Every reflected memory therefore came out
    /// with its reason silently filtered off, which is most of what a
    /// remembered decision is for. `IntentRow::is_stated_reason` is the
    /// predicate that actually knows (stub text, then `stated_at`, then
    /// whether the text merely repeats the hook's own description).
    pub auto: bool,
}

fn signal_from_row(row: &IntentRow) -> Signal {
    Signal {
        ts: row.timestamp,
        kind: SignalKind::Intent,
        file: row.file.clone(),
        intent_type: row.intent_type.clone(),
        intent: row.intent.clone(),
        auto: !row.is_stated_reason(),
    }
}

// ───────────────────────── paths ─────────────────────────

/// Fold one episodic path into the repo-relative form the rules group on,
/// or `None` when it does not belong to this project.
///
/// Two signals about the same file arrive written two different ways: an
/// intent row carries whatever the hook passed to `--file`, which is
/// usually absolute, while a snapshot's path is decoded from its filename
/// and is always relative. Grouping on the raw string made those two
/// halves two separate memories — this repo's own history produced
/// `aura-cli/src/main.rs` with 93 pieces of evidence AND the same file
/// under its absolute path with 79, and six such pairs in 31 candidates.
/// Both entries are true, neither is complete, and a reader has no way to
/// tell they are one file.
///
/// The filter half matters as much: an absolute path outside the repo is
/// not this project's memory. The largest single non-`main.rs` pattern
/// here was Claude Code's own memory directory under `~/.claude`, 42
/// pieces of evidence, promoted as a fact about the project.
///
/// Pure string work on purpose — the file may since have been deleted,
/// and a pattern about a file that is gone is still worth remembering.
pub fn repo_relative(raw: &str, root: &Path) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let path = Path::new(raw);
    let rel = if path.is_absolute() {
        // Outside the repo → not ours. `strip_prefix` compares whole
        // components, so `/repo-backup/x` never passes as `/repo/x`.
        path.strip_prefix(root).ok()?
    } else {
        path
    };

    // Collapse `./` and refuse anything that climbs out with `..`.
    let mut parts: Vec<String> = Vec::new();
    for c in rel.components() {
        match c {
            std::path::Component::Normal(s) => parts.push(s.to_string_lossy().to_string()),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

// ───────────────────────── candidates ─────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    pub rule: &'static str,
    pub section: &'static str,
    pub file: String,
    pub content: String,
    pub tags: Vec<String>,
    pub evidence_count: usize,
    /// Newest evidence timestamp — what the watermark gates on.
    pub newest_ts: u64,
}

fn day_of(ts: u64) -> u64 {
    ts / 86_400
}

fn span_days(oldest: u64, newest: u64) -> u64 {
    (newest.saturating_sub(oldest) / 86_400).max(1)
}

/// The newest STATED intent text in a group — machine-written rows keep
/// the count honest but are never quoted as if a person said them.
fn latest_stated(group: &[&Signal]) -> Option<String> {
    group
        .iter()
        .filter(|s| !s.auto && !s.intent.is_empty())
        .max_by_key(|s| s.ts)
        .map(|s| s.intent.clone())
}

fn quote(text: &Option<String>) -> String {
    match text {
        Some(t) => {
            let t: String = t.chars().take(160).collect();
            format!(" — latest: \"{}\"", t)
        }
        None => String::new(),
    }
}

/// Evaluate the three reflection rules over a window of signals. Pure —
/// all IO lives in [`run`].
pub fn analyze(signals: &[Signal], now: u64) -> Vec<Candidate> {
    let mut by_file: HashMap<&str, Vec<&Signal>> = HashMap::new();
    for s in signals {
        if let Some(f) = &s.file {
            by_file.entry(f.as_str()).or_default().push(s);
        }
    }

    let mut out = Vec::new();
    let mut files: Vec<&&str> = by_file.keys().collect();
    files.sort(); // deterministic output order

    for file in files {
        let group = &by_file[*file];
        let newest = group.iter().map(|s| s.ts).max().unwrap_or(0);
        let oldest = group.iter().map(|s| s.ts).min().unwrap_or(0);

        // Rule 1 — bugfix-recurrence.
        let bugfixes: Vec<&&Signal> = group
            .iter()
            .filter(|s| {
                s.kind == SignalKind::Intent && s.intent_type.as_deref() == Some("BugFix")
            })
            .collect();
        if bugfixes.len() >= BUGFIX_MIN {
            let newest_fix = bugfixes.iter().map(|s| s.ts).max().unwrap_or(0);
            let oldest_fix = bugfixes.iter().map(|s| s.ts).min().unwrap_or(0);
            let stated: Vec<&Signal> = bugfixes.iter().map(|s| **s).collect();
            out.push(Candidate {
                rule: "bugfix-recurrence",
                section: "gotcha",
                file: file.to_string(),
                content: format!(
                    "{} is a fragile spot: {} bug-fix intents over {}d{}",
                    file,
                    bugfixes.len(),
                    span_days(oldest_fix, newest_fix),
                    quote(&latest_stated(&stated)),
                ),
                tags: vec![
                    "reflection".to_string(),
                    "bugfix-recurrence".to_string(),
                    format!("file:{}", file),
                ],
                evidence_count: bugfixes.len(),
                newest_ts: newest_fix,
            });
        }

        // Rule 2 — sustained-focus.
        let mut days: Vec<u64> = group.iter().map(|s| day_of(s.ts)).collect();
        days.sort_unstable();
        days.dedup();
        if days.len() >= FOCUS_MIN_DAYS {
            let stated: Vec<&Signal> = group.iter().copied().collect();
            out.push(Candidate {
                rule: "sustained-focus",
                section: "context",
                file: file.to_string(),
                content: format!(
                    "Sustained work on {}: {} changes across {} distinct days (span {}d){}",
                    file,
                    group.len(),
                    days.len(),
                    span_days(oldest, newest),
                    quote(&latest_stated(&stated)),
                ),
                tags: vec![
                    "reflection".to_string(),
                    "sustained-focus".to_string(),
                    format!("file:{}", file),
                ],
                evidence_count: group.len(),
                newest_ts: newest,
            });
        }

        // Rule 3 — churn: many pre-edit snapshots in a short recent window.
        let cutoff = now.saturating_sub(CHURN_WINDOW_SECS);
        let churn: Vec<&&Signal> = group
            .iter()
            .filter(|s| s.kind == SignalKind::Snapshot && s.ts >= cutoff)
            .collect();
        if churn.len() >= CHURN_MIN {
            let newest_snap = churn.iter().map(|s| s.ts).max().unwrap_or(0);
            out.push(Candidate {
                rule: "churn",
                section: "gotcha",
                file: file.to_string(),
                content: format!(
                    "{} is churning: {} pre-edit snapshots inside 48h — heavy rewriting in a short window is where regressions historically come from; review the net diff before building on it",
                    file,
                    churn.len(),
                ),
                tags: vec![
                    "reflection".to_string(),
                    "churn".to_string(),
                    format!("file:{}", file),
                ],
                evidence_count: churn.len(),
                newest_ts: newest_snap,
            });
        }
    }
    out
}

// ───────────────────────── watermark ─────────────────────────

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Watermark {
    #[serde(default)]
    pub schema_version: u32,
    /// Newest episodic timestamp already reflected over.
    #[serde(default)]
    pub last_ts: u64,
    #[serde(default)]
    pub last_run_at: u64,
    #[serde(default)]
    pub runs: u64,
    #[serde(default)]
    pub promoted_total: u64,
}

pub fn load_watermark(path: &Path) -> Watermark {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_watermark(path: &Path, wm: &Watermark) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = serde_json::to_string_pretty(wm).map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| format!("write {}: {}", path.display(), e))
}

/// A candidate is promotable only when some of its evidence is NEWER
/// than what previous runs already reflected over.
pub fn filter_new(candidates: Vec<Candidate>, last_ts: u64) -> Vec<Candidate> {
    candidates
        .into_iter()
        .filter(|c| c.newest_ts > last_ts)
        .collect()
}

// ───────────────────────── IO shell ─────────────────────────

fn collect_signals(window_hours: u64, now: u64) -> Vec<Signal> {
    let since = now.saturating_sub(window_hours * 3600);
    let mut signals: Vec<Signal> = Vec::new();
    // Reflection's whole IO is relative to the working directory, so that
    // is the repo root every path is folded against.
    let root = std::env::current_dir().unwrap_or_else(|_| Path::new(".").to_path_buf());

    for row in intent_query::read_all_rows(Path::new(".aura/intent_log.jsonl")) {
        if row.timestamp >= since {
            let mut sig = signal_from_row(&row);
            // A path outside the repo loses its file rather than the row:
            // it is still episodic activity and still moves the watermark,
            // it just has nothing this project's rules can group on.
            sig.file = sig.file.as_deref().and_then(|f| repo_relative(f, &root));
            signals.push(sig);
        }
    }

    // Pre-edit snapshots: metadata only, parsed from the filename
    // (`<path>__<ms_epoch>.json`, `__` as the directory separator) —
    // the same read episodic recall does.
    if let Ok(entries) = std::fs::read_dir(Path::new(".aura").join("snapshots")) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Some(stem) = name.strip_suffix(".json") else {
                continue;
            };
            let Some((path_part, ts_part)) = stem.rsplit_once("__") else {
                continue;
            };
            let Ok(ms) = ts_part.parse::<u64>() else {
                continue;
            };
            let ts = ms / 1000;
            if ts < since {
                continue;
            }
            signals.push(Signal {
                ts,
                kind: SignalKind::Snapshot,
                file: repo_relative(&path_part.replace("__", "/"), &root),
                intent_type: None,
                intent: String::new(),
                auto: true,
            });
        }
    }
    signals
}

#[derive(Debug, Serialize)]
pub struct ReflectReport {
    pub window_hours: u64,
    pub signals: usize,
    pub patterns_found: usize,
    pub promoted: usize,
    pub noop: usize,
    pub dry_run: bool,
    pub candidates: Vec<Candidate>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// One reflection pass over the current repo. `apply=false` reports the
/// candidates without writing anything (and without moving the
/// watermark).
pub fn run(window_hours: Option<u64>, apply: bool, json: bool) -> Result<(), String> {
    let window_hours = window_hours.unwrap_or(DEFAULT_WINDOW_HOURS);
    let now = now_secs();
    let signals = collect_signals(window_hours, now);
    let newest_signal_ts = signals.iter().map(|s| s.ts).max().unwrap_or(0);

    let wm_path = Path::new(WATERMARK_FILE).to_path_buf();
    let mut wm = load_watermark(&wm_path);

    let all = analyze(&signals, now);
    let candidates = filter_new(all, wm.last_ts);

    let mut promoted = 0usize;
    let mut noop = 0usize;
    if apply {
        for c in &candidates {
            let outcome = MemoryManager::add_entry_reconciled(
                c.section,
                &c.content,
                c.tags.clone(),
                "reflection",
                None,
            );
            match outcome.op {
                ReconcileOp::Added | ReconcileOp::Updated => promoted += 1,
                ReconcileOp::Noop | ReconcileOp::Deleted => noop += 1,
            }
        }
        wm.schema_version = 1;
        wm.last_ts = wm.last_ts.max(newest_signal_ts);
        wm.last_run_at = now;
        wm.runs += 1;
        wm.promoted_total += promoted as u64;
        save_watermark(&wm_path, &wm)?;
    }

    let report = ReflectReport {
        window_hours,
        signals: signals.len(),
        patterns_found: candidates.len(),
        promoted,
        noop,
        dry_run: !apply,
        candidates,
    };

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
        );
        return Ok(());
    }

    use colored::Colorize;
    println!(
        "{} {} episodic signals in the last {}h → {} pattern(s){}",
        "memory reflect".bold(),
        report.signals,
        report.window_hours,
        report.patterns_found,
        if report.dry_run { " (dry run)" } else { "" }
    );
    for c in &report.candidates {
        println!(
            "  {} [{}] {} · {} evidence",
            "→".cyan(),
            c.rule,
            c.file.bold(),
            c.evidence_count
        );
    }
    if apply {
        println!(
            "  {} {} promoted, {} already known",
            "✓".green(),
            promoted,
            noop
        );
    } else if report.patterns_found > 0 {
        println!("  {} re-run without --dry-run to promote", "·".dimmed());
    } else {
        println!("  {} nothing new since the last reflection", "·".dimmed());
    }
    Ok(())
}

// ───────────────────────── tests ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = 86_400;
    const NOW: u64 = 1_757_000_000;

    fn intent(ts: u64, file: &str, itype: Option<&str>, text: &str, auto: bool) -> Signal {
        Signal {
            ts,
            kind: SignalKind::Intent,
            file: Some(file.to_string()),
            intent_type: itype.map(|s| s.to_string()),
            intent: text.to_string(),
            auto,
        }
    }

    fn snapshot(ts: u64, file: &str) -> Signal {
        Signal {
            ts,
            kind: SignalKind::Snapshot,
            file: Some(file.to_string()),
            intent_type: None,
            intent: String::new(),
            auto: true,
        }
    }

    #[test]
    fn three_bugfixes_on_one_file_become_a_gotcha() {
        let sigs = vec![
            intent(NOW - 5 * DAY, "src/auth.rs", Some("BugFix"), "fix token refresh", false),
            intent(NOW - 3 * DAY, "src/auth.rs", Some("BugFix"), "fix expiry check", false),
            intent(NOW - DAY, "src/auth.rs", Some("BugFix"), "fix clock skew", false),
        ];
        let out = analyze(&sigs, NOW);
        let c = out
            .iter()
            .find(|c| c.rule == "bugfix-recurrence")
            .expect("recurrence detected");
        assert_eq!(c.section, "gotcha");
        assert!(c.content.contains("3 bug-fix intents"));
        assert!(c.content.contains("fix clock skew"), "quotes the LATEST stated fix");
        assert_eq!(c.newest_ts, NOW - DAY);
    }

    #[test]
    fn two_bugfixes_stay_quiet() {
        let sigs = vec![
            intent(NOW - 2 * DAY, "src/auth.rs", Some("BugFix"), "fix a", false),
            intent(NOW - DAY, "src/auth.rs", Some("BugFix"), "fix b", false),
        ];
        assert!(analyze(&sigs, NOW)
            .iter()
            .all(|c| c.rule != "bugfix-recurrence"));
    }

    #[test]
    fn work_across_three_days_becomes_focus_context() {
        let sigs = vec![
            intent(NOW - 4 * DAY, "src/engine.rs", None, "rework parser", false),
            intent(NOW - 2 * DAY, "src/engine.rs", None, "wire caching", false),
            intent(NOW, "src/engine.rs", None, "tighten types", false),
        ];
        let out = analyze(&sigs, NOW);
        let c = out
            .iter()
            .find(|c| c.rule == "sustained-focus")
            .expect("focus detected");
        assert_eq!(c.section, "context");
        assert!(c.content.contains("3 distinct days"));
    }

    #[test]
    fn same_day_activity_is_not_sustained_focus() {
        let sigs = vec![
            intent(NOW - 3600, "src/engine.rs", None, "a", false),
            intent(NOW - 1800, "src/engine.rs", None, "b", false),
            intent(NOW, "src/engine.rs", None, "c", false),
        ];
        assert!(analyze(&sigs, NOW)
            .iter()
            .all(|c| c.rule != "sustained-focus"));
    }

    #[test]
    fn snapshot_burst_flags_churn_but_old_snapshots_do_not() {
        let mut sigs: Vec<Signal> = (0..CHURN_MIN)
            .map(|i| snapshot(NOW - (i as u64) * 3600, "src/hot.rs"))
            .collect();
        let c = analyze(&sigs, NOW);
        assert!(c.iter().any(|c| c.rule == "churn"), "burst inside 48h flags");

        // The same count spread outside the 48h window is history, not churn.
        sigs = (0..CHURN_MIN)
            .map(|i| snapshot(NOW - CHURN_WINDOW_SECS - 1 - (i as u64) * 3600, "src/hot.rs"))
            .collect();
        assert!(analyze(&sigs, NOW).iter().all(|c| c.rule != "churn"));
    }

    #[test]
    fn machine_written_rows_count_as_activity_but_are_never_quoted() {
        let sigs = vec![
            intent(NOW - 4 * DAY, "src/x.rs", None, "rework the loader", false),
            intent(NOW - 2 * DAY, "src/x.rs", None, "Automatic pre-Edit snapshot", true),
            intent(NOW, "src/x.rs", None, "Automatic pre-Edit snapshot", true),
        ];
        let out = analyze(&sigs, NOW);
        let c = out
            .iter()
            .find(|c| c.rule == "sustained-focus")
            .expect("auto rows still count as activity");
        assert!(
            c.content.contains("rework the loader"),
            "the quoted words are the STATED ones: {}",
            c.content
        );
        assert!(!c.content.contains("Automatic pre-Edit"));
    }

    #[test]
    fn one_file_written_two_ways_is_one_memory() {
        // Intent rows carry the path the hook passed, usually absolute;
        // snapshot paths are decoded from a filename and are always
        // relative. Grouped raw, this history produced two memories about
        // main.rs with different evidence counts, both true, neither whole.
        let root = Path::new("/repo");
        let a = repo_relative("/repo/src/main.rs", root);
        let b = repo_relative("src/main.rs", root);
        let c = repo_relative("./src/main.rs", root);
        assert_eq!(a, Some("src/main.rs".to_string()));
        assert_eq!(a, b);
        assert_eq!(b, c);
    }

    #[test]
    fn a_file_outside_the_repo_is_not_this_projects_memory() {
        let root = Path::new("/repo");
        // The real one: Claude Code's own memory directory, which drew more
        // evidence here than any file in the project bar main.rs.
        assert_eq!(repo_relative("/Users/x/.claude/projects/p/memory/MEMORY.md", root), None);
        // A sibling directory whose name merely starts the same way.
        assert_eq!(repo_relative("/repo-backup/src/main.rs", root), None);
        // Climbing out is refused rather than silently folded.
        assert_eq!(repo_relative("../other/src/main.rs", root), None);
        assert_eq!(repo_relative("   ", root), None);
    }

    #[test]
    fn a_hook_row_about_a_tool_call_counts_but_is_never_quoted() {
        // `source` cannot separate these: `hook_auto` is the default value
        // of `--source`, so it rides on stated reasons too. Deciding on it
        // filtered the reason off every reflected memory in the repo.
        use crate::intent_query::IntentRow;
        let mechanical = IntentRow {
            timestamp: NOW,
            agent_id: "Claude".into(),
            intent: "Claude Edit on src/x.rs".into(),
            intent_type: None,
            signed_block_id: None,
            key_id: None,
            source: Some("hook_auto".into()),
            file: Some("src/x.rs".into()),
            session_id: None,
            stated_at: None,
            change: None,
            tool: Some("Edit".into()),
        };
        let stated = IntentRow {
            intent: "rework the loader so a partial read cannot look like an empty file".into(),
            tool: None,
            ..mechanical.clone()
        };
        assert!(signal_from_row(&mechanical).auto, "the hook's own sentence");
        assert!(!signal_from_row(&stated).auto, "somebody's words");
    }

    #[test]
    fn watermark_blocks_already_reflected_evidence() {
        let sigs = vec![
            intent(NOW - 5 * DAY, "src/auth.rs", Some("BugFix"), "a", false),
            intent(NOW - 4 * DAY, "src/auth.rs", Some("BugFix"), "b", false),
            intent(NOW - 3 * DAY, "src/auth.rs", Some("BugFix"), "c", false),
        ];
        let all = analyze(&sigs, NOW);
        // Both rules fire on this history: recurrence AND 3-day focus.
        assert_eq!(all.len(), 2);
        // Everything already reflected → nothing to promote.
        assert!(filter_new(all, NOW - 2 * DAY).is_empty());
        // New evidence since the watermark → promotable again.
        let all = analyze(&sigs, NOW);
        assert_eq!(filter_new(all, NOW - 4 * DAY).len(), 2);
    }
}
