// Per-developer usage attribution — phase-2 backend for the Trace team
// overview.
//
// Token usage lives in `.aura/sessions/*.json` (AgentSession), which is
// per-clone local state: one clone = one seat = one developer. This module
// buckets those sessions by (month, developer, agent) and persists the
// result as `.aura/usage_by_dev.jsonl` — a TRACKED file (see
// `.aura/.gitignore`: it is not in the ignore list, exactly like
// `intent_log.jsonl`), so each teammate's clone contributes their own rows
// and git merges them into a true per-teammate per-repo token view with no
// cloud dependency.
//
// The persistence is a MERGE-PRESERVING rewrite keyed on `origin` — the
// clone identity that computed a row. A refresh replaces exactly the rows
// THIS clone wrote last time (whatever developers they attribute, since a
// stamped session can credit a teammate) and keeps every other clone's rows
// byte-for-byte, so concurrent refreshes on different clones can't clobber
// each other, nothing double-counts, and merge conflicts stay rare
// (distinct rows live on distinct lines, sorted stably).
//
// Legacy sessions written before `AgentSession.developer` existed are
// attributed to the clone's current git identity — safe under the
// one-seat-per-clone model and it makes the feature useful on day one
// instead of only for future sessions.

use crate::plugins::cost_reporter::cost_per_model;
use crate::session::{AgentSession, SessionManager};
use colored::Colorize;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// One aggregate row: a developer's usage of one agent in one month.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DevUsageRow {
    /// Calendar month, `YYYY-MM` (UTC).
    pub month: String,
    /// Developer identity — git `user.email`, lowercased. Empty string
    /// means the clone had no git identity configured at refresh time.
    pub developer: String,
    /// Display handle — the email's local part, lowercased (matches the
    /// team manifest's handle convention).
    #[serde(default)]
    pub handle: String,
    /// Which AI drove the work: "claude", "codex", "gemini", "user", …
    pub agent_id: String,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cost_usd: f64,
    #[serde(default)]
    pub sessions: u32,
    /// Unix seconds when this row was last recomputed (by its owner).
    #[serde(default)]
    pub updated_at: u64,
    /// Which clone computed this row — the refreshing clone's git
    /// `user.email`. Refresh ownership key: a clone replaces only rows it
    /// wrote itself, never another clone's. Usually equals `developer`,
    /// but a session stamped with a teammate's identity stays distinct
    /// from rows their own clone contributes. Empty on rows written
    /// before this field existed — treated as origin == developer.
    #[serde(default)]
    pub origin: String,
}

/// The local developer's identity, resolved once from git config.
#[derive(Clone, Debug, Default)]
pub struct DevIdentity {
    pub email: String,
    pub handle: String,
    pub name: String,
}

/// Resolve the local developer from git config (`user.email` /
/// `user.name`), the same source the team manifest builds handles from.
/// Falls back to empty strings — callers treat "" as unattributed rather
/// than failing the whole report.
pub fn dev_identity() -> DevIdentity {
    let cfg = git2::Repository::discover(".")
        .ok()
        .and_then(|repo| repo.config().ok());
    let email = cfg
        .as_ref()
        .and_then(|c| c.get_string("user.email").ok())
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default();
    let name = cfg
        .as_ref()
        .and_then(|c| c.get_string("user.name").ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    DevIdentity {
        handle: handle_from_email(&email),
        email,
        name,
    }
}

/// Email local-part, lowercased — mirrors the team manifest convention.
pub fn handle_from_email(email: &str) -> String {
    email.split('@').next().unwrap_or(email).to_lowercase()
}

/// `YYYY-MM` for a unix timestamp — the first 7 chars of the date string.
fn month_of(ts: u64) -> String {
    let date = crate::usage::secs_to_date(ts);
    date.chars().take(7).collect()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// The aggregate file lives in the MAIN repo's `.aura`, where it is
/// tracked by git. Falls back to a cwd-relative path when repo discovery
/// fails so the CLI never hard-errors outside a repo.
pub fn aggregate_path() -> PathBuf {
    git2::Repository::discover(".")
        .ok()
        .and_then(|r| r.workdir().map(|w| w.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".aura")
        .join("usage_by_dev.jsonl")
}

/// Bucket sessions into per-(month, developer, agent) rows. Pure — takes
/// the fallback identity explicitly so it is testable without touching git
/// or the filesystem. Sessions stamped with a `developer` keep it; legacy
/// unstamped sessions attribute to the fallback (one seat per clone).
pub fn bucket_sessions(
    sessions: &[AgentSession],
    fallback_email: &str,
    fallback_handle: &str,
    now: u64,
) -> Vec<DevUsageRow> {
    use std::collections::HashMap;
    let mut buckets: HashMap<(String, String, String), DevUsageRow> = HashMap::new();

    for s in sessions {
        let developer = s
            .developer
            .as_deref()
            .map(|d| d.trim().to_lowercase())
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| fallback_email.to_string());
        let handle = s
            .developer_handle
            .as_deref()
            .map(|h| h.trim().to_lowercase())
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| {
                if developer == fallback_email {
                    fallback_handle.to_string()
                } else {
                    handle_from_email(&developer)
                }
            });
        let month = month_of(s.started_at);
        let agent = s.agent_id.clone();

        let (input, output, cache_read) = s
            .token_usage
            .as_ref()
            .map(|u| (u.input_tokens, u.output_tokens, u.cache_read_tokens))
            .unwrap_or((0, 0, 0));
        let model = s.model_name.as_deref().unwrap_or("claude-sonnet");
        let (in_rate, out_rate) = cost_per_model(model);
        let cost = (input as f64 / 1000.0) * in_rate + (output as f64 / 1000.0) * out_rate;

        let row = buckets
            .entry((month.clone(), developer.clone(), agent.clone()))
            .or_insert_with(|| DevUsageRow {
                month,
                developer,
                handle,
                agent_id: agent,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cost_usd: 0.0,
                sessions: 0,
                updated_at: now,
                origin: fallback_email.to_string(),
            });
        row.input_tokens += input;
        row.output_tokens += output;
        row.cache_read_tokens += cache_read;
        row.cost_usd += cost;
        row.sessions += 1;
    }

    let mut rows: Vec<DevUsageRow> = buckets.into_values().collect();
    sort_rows(&mut rows);
    rows
}

/// Stable order — clean git diffs and deterministic output.
fn sort_rows(rows: &mut [DevUsageRow]) {
    rows.sort_by(|a, b| {
        a.month
            .cmp(&b.month)
            .then_with(|| a.developer.cmp(&b.developer))
            .then_with(|| a.agent_id.cmp(&b.agent_id))
            .then_with(|| a.origin.cmp(&b.origin))
    });
}

/// Effective ownership of a row for refresh replacement. Pre-`origin` rows
/// fall back to their `developer` (origin == developer was the implicit
/// assumption when they were written).
fn row_origin(r: &DevUsageRow) -> &str {
    if r.origin.is_empty() {
        &r.developer
    } else {
        &r.origin
    }
}

/// Tolerant JSONL load — skips unparseable lines instead of failing, so a
/// half-merged file still yields every good row.
pub fn load_rows(path: &Path) -> Vec<DevUsageRow> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    content
        .lines()
        .filter_map(|l| serde_json::from_str::<DevUsageRow>(l).ok())
        .collect()
}

/// Replace the rows THIS clone wrote (matched by `origin`, falling back to
/// `developer` for pre-origin rows) with freshly computed ones; keep every
/// other clone's rows verbatim. Matching on origin — not developer — is
/// what prevents double counting: `mine` can contain rows attributed to a
/// teammate (a session stamped with their identity ran in this clone), and
/// those must replace this clone's previous version of the same rows, not
/// stack next to them. `self_email` empty means we can't tell whose rows
/// are ours — in that case unattributed ("") rows are ours.
pub fn merge_rows(
    existing: Vec<DevUsageRow>,
    mine: Vec<DevUsageRow>,
    self_email: &str,
) -> Vec<DevUsageRow> {
    let mut rows: Vec<DevUsageRow> = existing
        .into_iter()
        .filter(|r| row_origin(r) != self_email)
        .collect();
    rows.extend(mine);
    sort_rows(&mut rows);
    rows
}

/// Atomic rewrite: temp file in the same directory, then rename.
pub fn persist_rows(path: &Path, rows: &[DevUsageRow]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    for row in rows {
        let line = serde_json::to_string(row)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        writeln!(tmp, "{}", line)?;
    }
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

/// Recompute my rows from local sessions and fold them into the shared
/// aggregate file. Returns the full merged row set (all developers).
/// No-ops to an empty Vec outside a repo with a `.aura` dir — `aura usage`
/// must never scaffold `.aura` into an arbitrary cwd.
pub fn refresh() -> Vec<DevUsageRow> {
    let path = aggregate_path();
    let aura_dir = path.parent().map(Path::to_path_buf);
    match aura_dir {
        Some(d) if d.is_dir() => {}
        _ => return Vec::new(),
    }

    let identity = dev_identity();
    let sessions = SessionManager::list_sessions();
    let mine = bucket_sessions(&sessions, &identity.email, &identity.handle, now_secs());
    let merged = merge_rows(load_rows(&path), mine, &identity.email);
    if let Err(e) = persist_rows(&path, &merged) {
        eprintln!("aura usage: could not persist usage_by_dev.jsonl: {}", e);
    }
    merged
}

/// Filter rows to months >= the month containing `cutoff_ts` (string
/// compare works on YYYY-MM). `None` = all months.
pub fn rows_in_window(rows: &[DevUsageRow], cutoff_ts: Option<u64>) -> Vec<&DevUsageRow> {
    match cutoff_ts {
        None => rows.iter().collect(),
        Some(ts) => {
            let cutoff_month = month_of(ts);
            rows.iter().filter(|r| r.month >= cutoff_month).collect()
        }
    }
}

/// JSON for `aura usage --json` (and through it the desktop app's
/// `auraUsageReport`). One entry per (month, developer, agent) row.
pub fn rows_to_json(rows: &[&DevUsageRow]) -> serde_json::Value {
    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "month": r.month,
                "developer": r.developer,
                "handle": r.handle,
                "agent_id": r.agent_id,
                "input_tokens": r.input_tokens,
                "output_tokens": r.output_tokens,
                "cache_read_tokens": r.cache_read_tokens,
                "cost_usd": (r.cost_usd * 10000.0).round() / 10000.0,
                "sessions": r.sessions,
                "updated_at": r.updated_at,
            })
        })
        .collect();
    serde_json::Value::Array(items)
}

/// `aura usage --by-dev` table — per-developer totals with an agent
/// breakdown, scoped to the given window.
pub fn print_by_dev(rows: &[&DevUsageRow]) {
    if rows.is_empty() {
        println!(
            "  {} No per-developer usage yet — rows appear after agent sessions run in this repo.",
            "ℹ".dimmed()
        );
        return;
    }

    // Group by developer for the headline, keep agent split underneath.
    use std::collections::BTreeMap;
    let mut by_dev: BTreeMap<&str, (u64, f64, u32, Vec<&&DevUsageRow>)> = BTreeMap::new();
    for r in rows {
        let entry = by_dev
            .entry(if r.developer.is_empty() {
                "(unattributed)"
            } else {
                &r.developer
            })
            .or_insert((0, 0.0, 0, Vec::new()));
        entry.0 += r.input_tokens + r.output_tokens;
        entry.1 += r.cost_usd;
        entry.2 += r.sessions;
        entry.3.push(r);
    }

    println!("\n  {} {}", "👥".bold(), "By Developer".bold());
    let max_cost = by_dev.values().map(|v| v.1).fold(0.0f64, f64::max);
    for (dev, (tokens, cost, sessions, dev_rows)) in &by_dev {
        let handle = dev_rows
            .first()
            .map(|r| r.handle.as_str())
            .filter(|h| !h.is_empty())
            .unwrap_or(dev);
        let bar = {
            let width = 12usize;
            if max_cost <= 0.0 {
                " ".repeat(width)
            } else {
                let filled = ((cost / max_cost) * width as f64).min(width as f64) as usize;
                format!(
                    "{}{}",
                    "█".repeat(filled).cyan(),
                    "░".repeat(width - filled).dimmed()
                )
            }
        };
        println!(
            "    {:<18} {}  ${:.4}  ({} session{}, {}k tok)",
            handle.cyan(),
            bar,
            cost,
            sessions,
            if *sessions == 1 { "" } else { "s" },
            tokens / 1000,
        );
        // Agent split, newest month first within the developer. Rows from
        // different origin clones for the same (agent, month) collapse into
        // one display line — origin is a merge key, not a user concept.
        let mut split: BTreeMap<(&str, &str), (u64, u64, f64)> = BTreeMap::new();
        for r in dev_rows {
            let e = split
                .entry((r.agent_id.as_str(), r.month.as_str()))
                .or_insert((0, 0, 0.0));
            e.0 += r.input_tokens;
            e.1 += r.output_tokens;
            e.2 += r.cost_usd;
        }
        let mut lines: Vec<_> = split.into_iter().collect();
        lines.sort_by(|a, b| b.0 .1.cmp(a.0 .1).then(a.0 .0.cmp(b.0 .0)));
        for ((agent, month), (input, output, cost)) in lines {
            println!(
                "      {} {:<10} {:<8} ${:.4}  ({}k in / {}k out)",
                "↳".dimmed(),
                agent.dimmed(),
                month.dimmed(),
                cost,
                input / 1000,
                output / 1000,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{SessionPhase, TokenUsage};

    fn session(
        agent: &str,
        started_at: u64,
        developer: Option<&str>,
        input: u64,
        output: u64,
    ) -> AgentSession {
        AgentSession {
            session_id: format!("test-{}-{}", agent, started_at),
            agent_id: agent.to_string(),
            phase: SessionPhase::Ended,
            started_at,
            last_activity: started_at,
            files_touched: Vec::new(),
            checkpoint_count: 0,
            base_commit: None,
            worktree: None,
            token_usage: Some(TokenUsage {
                input_tokens: input,
                output_tokens: output,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                api_call_count: 1,
            }),
            summary: None,
            model_name: Some("claude-sonnet".to_string()),
            branch: None,
            first_prompt: None,
            subagents: Vec::new(),
            pid: None,
            project: None,
            developer: developer.map(|d| d.to_string()),
            developer_handle: None,
        }
    }

    // 2026-06-10 ≈ 1781049600; month_of must say 2026-06.
    const JUN_2026: u64 = 1_781_049_600;
    // 2026-05-15 ≈ 1778803200.
    const MAY_2026: u64 = 1_778_803_200;

    #[test]
    fn buckets_by_month_dev_agent() {
        let sessions = vec![
            session("claude", JUN_2026, Some("a@x.com"), 1000, 500),
            session("claude", JUN_2026 + 100, Some("a@x.com"), 2000, 1000),
            session("codex", JUN_2026, Some("a@x.com"), 100, 50),
            session("claude", MAY_2026, Some("a@x.com"), 10, 5),
        ];
        let rows = bucket_sessions(&sessions, "fallback@x.com", "fallback", 1);
        assert_eq!(rows.len(), 3);
        // Sorted: 2026-05 first, then 2026-06 claude, 2026-06 codex.
        assert_eq!(rows[0].month, "2026-05");
        assert_eq!(rows[1].agent_id, "claude");
        assert_eq!(rows[1].input_tokens, 3000);
        assert_eq!(rows[1].output_tokens, 1500);
        assert_eq!(rows[1].sessions, 2);
        assert_eq!(rows[2].agent_id, "codex");
    }

    #[test]
    fn legacy_sessions_attribute_to_fallback_identity() {
        let sessions = vec![session("claude", JUN_2026, None, 100, 100)];
        let rows = bucket_sessions(&sessions, "me@team.dev", "me", 1);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].developer, "me@team.dev");
        assert_eq!(rows[0].handle, "me");
    }

    #[test]
    fn merge_replaces_only_my_rows() {
        let theirs = DevUsageRow {
            month: "2026-06".into(),
            developer: "peer@team.dev".into(),
            handle: "peer".into(),
            agent_id: "claude".into(),
            input_tokens: 999,
            output_tokens: 999,
            cache_read_tokens: 0,
            cost_usd: 1.0,
            sessions: 9,
            updated_at: 5,
            origin: "peer@team.dev".into(),
        };
        let my_old = DevUsageRow {
            developer: "me@team.dev".into(),
            handle: "me".into(),
            origin: "me@team.dev".into(),
            input_tokens: 1,
            ..theirs.clone()
        };
        let my_new = DevUsageRow {
            input_tokens: 42,
            ..my_old.clone()
        };
        let merged = merge_rows(
            vec![theirs.clone(), my_old],
            vec![my_new.clone()],
            "me@team.dev",
        );
        assert_eq!(merged.len(), 2);
        // Peer row untouched, my row replaced.
        assert!(merged.contains(&theirs));
        assert!(merged.contains(&my_new));
        assert!(!merged.iter().any(|r| r.input_tokens == 1));
    }

    /// Regression: a local session stamped with a TEAMMATE's identity makes
    /// `mine` contain a row whose developer != self. Refreshing twice must
    /// not stack that row next to its previous version (double counting) —
    /// origin-keyed replacement swaps it in place. A row the teammate's own
    /// clone contributed (origin == them) survives both refreshes.
    #[test]
    fn refresh_twice_does_not_duplicate_foreign_attributed_rows() {
        let sessions = vec![
            session("claude", JUN_2026, None, 1000, 500), // legacy → me
            session("codex", JUN_2026, Some("grace@team.dev"), 5000, 1500),
        ];
        let from_their_clone = DevUsageRow {
            month: "2026-06".into(),
            developer: "grace@team.dev".into(),
            handle: "grace".into(),
            agent_id: "claude".into(),
            input_tokens: 777,
            output_tokens: 333,
            cache_read_tokens: 0,
            cost_usd: 0.5,
            sessions: 3,
            updated_at: 9,
            origin: "grace@team.dev".into(),
        };

        let mine = bucket_sessions(&sessions, "me@team.dev", "me", 1);
        assert!(mine.iter().all(|r| r.origin == "me@team.dev"));

        let first = merge_rows(vec![from_their_clone.clone()], mine.clone(), "me@team.dev");
        let second = merge_rows(first.clone(), mine, "me@team.dev");
        assert_eq!(first, second, "refresh must be idempotent");
        // grace appears exactly twice: her own clone's row + my clone's
        // stamped-session row. Never a third copy.
        let grace_rows = second
            .iter()
            .filter(|r| r.developer == "grace@team.dev")
            .count();
        assert_eq!(grace_rows, 2);
        assert!(second.contains(&from_their_clone));
    }

    #[test]
    fn persist_load_roundtrip_and_tolerates_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage_by_dev.jsonl");
        let rows = bucket_sessions(
            &[session("claude", JUN_2026, Some("a@x.com"), 500, 250)],
            "",
            "",
            7,
        );
        persist_rows(&path, &rows).unwrap();

        // Inject a corrupt line (e.g. a sloppy merge artifact).
        let mut content = std::fs::read_to_string(&path).unwrap();
        content.push_str("<<<<<<< not json\n");
        std::fs::write(&path, content).unwrap();

        let loaded = load_rows(&path);
        assert_eq!(loaded, rows);
    }

    #[test]
    fn window_filters_by_month_string() {
        let rows = bucket_sessions(
            &[
                session("claude", MAY_2026, Some("a@x.com"), 1, 1),
                session("claude", JUN_2026, Some("a@x.com"), 1, 1),
            ],
            "",
            "",
            1,
        );
        assert_eq!(rows.len(), 2);
        let all = rows_in_window(&rows, None);
        assert_eq!(all.len(), 2);
        let june_only = rows_in_window(&rows, Some(JUN_2026));
        assert_eq!(june_only.len(), 1);
        assert_eq!(june_only[0].month, "2026-06");
    }
}
