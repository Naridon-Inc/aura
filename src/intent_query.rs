// S2-TI / doc 16: typed intent schema.
//
// Pure helpers for reading the local intent log (.aura/intent_log.jsonl)
// and filtering by canonical intent_type + lookback window. Lives in its
// own module so the MCP handler stays thin and the parsing/filter logic
// is easy to unit-test without touching the JSON-RPC envelope.

use serde_json::{json, Value};
use std::path::Path;

/// The closed set of canonical intent types (doc 16, P3). Custom types
/// are deferred to a Cedar-policy gate; for now any value not in this
/// list is rejected at the aura_log_intent boundary.
pub const CANONICAL_INTENT_TYPES: &[&str] = &[
    "FeatureAdd",
    "BugFix",
    "Refactor",
    "Revert",
    "Performance",
    "Docs",
    "Deps",
];

pub fn is_canonical_intent_type(s: &str) -> bool {
    CANONICAL_INTENT_TYPES.iter().any(|t| *t == s)
}

/// One row from the intent log, normalised to the fields we care about
/// for querying. We keep the original `raw` so callers can surface fields
/// we don't model explicitly (e.g. rekor_url) without re-reading the file.
#[derive(Debug, Clone, PartialEq)]
pub struct IntentRow {
    pub timestamp: u64,
    pub agent_id: String,
    pub intent: String,
    pub intent_type: Option<String>,
    pub signed_block_id: Option<String>,
    pub key_id: Option<String>,
}

impl IntentRow {
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "timestamp": self.timestamp,
            "agent_id": self.agent_id,
            "intent": self.intent,
        });
        if let Some(t) = &self.intent_type {
            v["intent_type"] = json!(t);
        }
        if let Some(bid) = &self.signed_block_id {
            v["signed_block_id"] = json!(bid);
        }
        if let Some(kid) = &self.key_id {
            v["key_id"] = json!(kid);
        }
        v
    }
}

/// Parse one JSONL line into an IntentRow. Returns None for blank lines or
/// rows that don't carry the minimum {intent, timestamp} we expect — older
/// schema variants (pre-S1) sometimes wrote partial entries.
pub fn parse_intent_line(line: &str) -> Option<IntentRow> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let intent = v.get("intent")?.as_str()?.to_string();
    let timestamp = v.get("timestamp").and_then(|t| t.as_u64()).unwrap_or(0);
    let agent_id = v
        .get("agent_id")
        .and_then(|a| a.as_str())
        .unwrap_or("unknown")
        .to_string();
    let intent_type = v
        .get("intent_type")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());
    let signed_block_id = v
        .get("signed_block_id")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());
    let key_id = v
        .get("key_id")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());
    Some(IntentRow {
        timestamp,
        agent_id,
        intent,
        intent_type,
        signed_block_id,
        key_id,
    })
}

/// Read every parseable row from .aura/intent_log.jsonl (or another path).
/// Missing file returns an empty Vec so callers don't need a separate
/// "is the log present yet" branch.
pub fn read_all_rows(path: &Path) -> Vec<IntentRow> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    text.lines().filter_map(parse_intent_line).collect()
}

/// Result of a query call. Carries unbounded `total_matches` separately
/// from the `entries` slice so a caller paginating with `limit` knows
/// whether more rows exist.
#[derive(Debug, Clone)]
pub struct IntentQueryResult {
    pub since_hours: i64,
    pub intent_type: Option<String>,
    pub total_matches: usize,
    pub entries: Vec<IntentRow>,
}

impl IntentQueryResult {
    pub fn to_json(&self) -> Value {
        let entries: Vec<Value> = self.entries.iter().map(|r| r.to_json()).collect();
        let mut v = json!({
            "since_hours": self.since_hours,
            "total_matches": self.total_matches,
            "returned": self.entries.len(),
            "entries": entries,
        });
        if let Some(t) = &self.intent_type {
            v["intent_type"] = json!(t);
        }
        v
    }
}

/// Run the actual filter + sort + cap. Pulled out of the MCP handler so
/// the unit tests can hit it directly without spinning up a fake jsonl
/// fixture every time.
pub fn query_rows(
    rows: Vec<IntentRow>,
    intent_type: Option<&str>,
    since_hours: i64,
    limit: usize,
    now_unix_secs: u64,
) -> IntentQueryResult {
    // since_hours <= 0 disables the cutoff (doc 16: '0 returns the
    // entire log'). i64 here so a caller can pass negative values
    // without underflow on the multiplication.
    let cutoff: u64 = if since_hours <= 0 {
        0
    } else {
        let window_secs = (since_hours as u64).saturating_mul(3600);
        now_unix_secs.saturating_sub(window_secs)
    };

    // Pair each surviving row with its original on-disk index so we can
    // break timestamp ties deterministically: same-second entries (rapid
    // back-to-back log_intent calls land in the same `as_secs()` bucket)
    // resolve to "latest line in the file wins", which matches the
    // intuitive "newest" semantics callers expect.
    let mut indexed: Vec<(usize, IntentRow)> = rows
        .into_iter()
        .enumerate()
        .filter(|(_, r)| {
            // Window: rows with timestamp == 0 are legacy entries with no
            // recorded ts — keep them only when the cutoff is also 0
            // (otherwise they'd silently dominate every windowed query).
            if cutoff > 0 && r.timestamp < cutoff {
                return false;
            }
            if let Some(t) = intent_type {
                if r.intent_type.as_deref() != Some(t) {
                    return false;
                }
            }
            true
        })
        .collect();

    // Primary: timestamp desc. Secondary: line index desc (newest-on-disk
    // wins on a tie).
    indexed.sort_by(|a, b| b.1.timestamp.cmp(&a.1.timestamp).then_with(|| b.0.cmp(&a.0)));
    let mut filtered: Vec<IntentRow> = indexed.into_iter().map(|(_, r)| r).collect();

    let total_matches = filtered.len();
    if filtered.len() > limit {
        filtered.truncate(limit);
    }

    IntentQueryResult {
        since_hours,
        intent_type: intent_type.map(|s| s.to_string()),
        total_matches,
        entries: filtered,
    }
}

/// Structured form of the typed-intent summary, separated from the
/// prose renderer so MCP and CLI --json callers can consume the same
/// numbers a human sees in the prose form. Always reflects the same
/// bucketing/sorting rules — the prose is built from this struct.
#[derive(Debug, Clone)]
pub struct TypedIntentSummary {
    pub since_hours: i64,
    pub typed_total: usize,
    pub untyped: usize,
    /// Bucketed by intent_type, count desc / name asc. Each bucket
    /// carries up to `sample_per_type` newest-first sample intents
    /// (truncated to 80 chars to keep the payload terse).
    pub buckets: Vec<TypedIntentBucket>,
}

#[derive(Debug, Clone)]
pub struct TypedIntentBucket {
    pub intent_type: String,
    pub count: usize,
    pub samples: Vec<String>,
}

impl TypedIntentSummary {
    pub fn to_json(&self) -> Value {
        let buckets: Vec<Value> = self
            .buckets
            .iter()
            .map(|b| {
                json!({
                    "intent_type": b.intent_type,
                    "count": b.count,
                    "samples": b.samples,
                })
            })
            .collect();
        json!({
            "since_hours": self.since_hours,
            "typed_total": self.typed_total,
            "untyped": self.untyped,
            "type_count": self.buckets.len(),
            "buckets": buckets,
        })
    }
}

/// Compute the structured typed-intent summary for the given log path.
/// Returns None on the same conditions as narrate_typed_intents_prose:
/// missing/empty log, or zero typed rows in the window. Both renderers
/// share this builder so JSON and prose can never disagree.
pub fn build_typed_intent_summary(
    path: &Path,
    since_hours: i64,
    sample_per_type: usize,
) -> Option<TypedIntentSummary> {
    use std::collections::BTreeMap;

    let now_unix_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let rows = read_all_rows(path);
    if rows.is_empty() {
        return None;
    }
    let q = query_rows(rows, None, since_hours, usize::MAX, now_unix_secs);
    if q.entries.is_empty() {
        return None;
    }

    let mut by_type: BTreeMap<String, Vec<&IntentRow>> = BTreeMap::new();
    let mut typed_total: usize = 0;
    for row in &q.entries {
        if let Some(t) = &row.intent_type {
            by_type.entry(t.clone()).or_default().push(row);
            typed_total += 1;
        }
    }
    if typed_total == 0 {
        return None;
    }

    let mut by_type_vec: Vec<(String, Vec<&IntentRow>)> = by_type.into_iter().collect();
    by_type_vec.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));

    let untyped = q.entries.len().saturating_sub(typed_total);
    let buckets: Vec<TypedIntentBucket> = by_type_vec
        .into_iter()
        .map(|(t, rows)| {
            let n = rows.len().min(sample_per_type);
            let samples: Vec<String> = if sample_per_type == 0 {
                Vec::new()
            } else {
                rows[..n]
                    .iter()
                    .map(|r| {
                        let mut s = r.intent.clone();
                        if s.len() > 80 {
                            s.truncate(77);
                            s.push_str("...");
                        }
                        s
                    })
                    .collect()
            };
            TypedIntentBucket {
                intent_type: t,
                count: rows.len(),
                samples,
            }
        })
        .collect();

    Some(TypedIntentSummary {
        since_hours,
        typed_total,
        untyped,
        buckets,
    })
}

/// One-shot wrapper that reads the intent log, groups recent typed
/// entries by intent_type, and renders a deterministic prose summary
/// suitable for embedding in handover XML or any other agent-facing
/// payload. Returns None when the log is missing/empty OR when no rows
/// in the window carry an intent_type — both cases mean "nothing useful
/// to say" and the caller should suppress the section entirely rather
/// than emit an empty header.
///
/// The prose is intentionally one paragraph + N bullet lines so it
/// CDATA-embeds cleanly. Counts sort by descending count then by
/// canonical-name ascending for tie-breaks (deterministic across runs).
pub fn narrate_typed_intents_prose(
    path: &Path,
    since_hours: i64,
    sample_per_type: usize,
) -> Option<String> {
    let summary = build_typed_intent_summary(path, since_hours, sample_per_type)?;
    let mut out = String::new();
    out.push_str(&format!(
        "Typed intent summary (last {}h): {} typed across {} type(s); {} untyped.\n",
        summary.since_hours,
        summary.typed_total,
        summary.buckets.len(),
        summary.untyped,
    ));
    for bucket in &summary.buckets {
        out.push_str(&format!("  - {} ×{}", bucket.intent_type, bucket.count));
        if !bucket.samples.is_empty() {
            out.push_str(&format!(
                " — latest: \"{}\"",
                bucket.samples.join("\" / \"")
            ));
        }
        out.push('\n');
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(ts: u64, t: Option<&str>, intent: &str) -> IntentRow {
        IntentRow {
            timestamp: ts,
            agent_id: "test".into(),
            intent: intent.into(),
            intent_type: t.map(|s| s.into()),
            signed_block_id: None,
            key_id: None,
        }
    }

    #[test]
    fn canonical_set_is_closed() {
        for t in CANONICAL_INTENT_TYPES {
            assert!(is_canonical_intent_type(t));
        }
        assert!(!is_canonical_intent_type("BugFx"));
        assert!(!is_canonical_intent_type("bugfix"));
        assert!(!is_canonical_intent_type(""));
    }

    #[test]
    fn parse_extracts_intent_type_when_present() {
        let line = r#"{"agent_id":"a","intent":"x","timestamp":100,"intent_type":"BugFix"}"#;
        let r = parse_intent_line(line).unwrap();
        assert_eq!(r.intent_type.as_deref(), Some("BugFix"));
        assert_eq!(r.timestamp, 100);
    }

    #[test]
    fn parse_handles_legacy_no_type_row() {
        let line = r#"{"agent_id":"a","intent":"x","timestamp":100}"#;
        let r = parse_intent_line(line).unwrap();
        assert_eq!(r.intent_type, None);
    }

    #[test]
    fn parse_skips_blank_and_invalid_lines() {
        assert!(parse_intent_line("").is_none());
        assert!(parse_intent_line("   ").is_none());
        assert!(parse_intent_line("not json").is_none());
        // Missing required intent field
        assert!(parse_intent_line(r#"{"agent_id":"a","timestamp":1}"#).is_none());
    }

    #[test]
    fn query_filters_by_type() {
        let rows = vec![
            row(100, Some("BugFix"), "a"),
            row(101, Some("Refactor"), "b"),
            row(102, Some("BugFix"), "c"),
            row(103, None, "d"),
        ];
        let r = query_rows(rows, Some("BugFix"), 0, 100, 200);
        assert_eq!(r.total_matches, 2);
        assert_eq!(r.entries.len(), 2);
        // Sorted newest-first
        assert_eq!(r.entries[0].timestamp, 102);
        assert_eq!(r.entries[1].timestamp, 100);
    }

    #[test]
    fn query_window_drops_old_rows() {
        let now: u64 = 1_000_000;
        let rows = vec![
            row(now - 3600, None, "1h ago"),       // in window
            row(now - 7200, None, "2h ago"),       // in window
            row(now - 7200 - 1, None, "just out"), // out — > 2h ago
            row(now - 86400, None, "1d ago"),      // out
        ];
        let r = query_rows(rows, None, 2, 100, now);
        assert_eq!(r.total_matches, 2);
        assert_eq!(r.entries[0].intent, "1h ago");
        assert_eq!(r.entries[1].intent, "2h ago");
    }

    #[test]
    fn query_zero_window_disables_cutoff() {
        let rows = vec![
            row(1, None, "ancient"),
            row(0, None, "no-ts legacy"),
            row(9_000, None, "recent"),
        ];
        let r = query_rows(rows, None, 0, 100, 10_000);
        assert_eq!(r.total_matches, 3);
        // Newest-first ordering still applies.
        assert_eq!(r.entries[0].intent, "recent");
    }

    #[test]
    fn query_limit_caps_returned_but_total_unbounded() {
        let rows = (0..10).map(|i| row(100 + i, Some("Docs"), "x")).collect();
        let r = query_rows(rows, Some("Docs"), 0, 3, 200);
        assert_eq!(r.total_matches, 10);
        assert_eq!(r.entries.len(), 3);
        // Newest 3
        assert_eq!(r.entries[0].timestamp, 109);
        assert_eq!(r.entries[2].timestamp, 107);
    }

    #[test]
    fn query_window_keeps_legacy_zero_ts_only_when_cutoff_disabled() {
        // ts=0 row is legacy — should be filtered when a real window is
        // active so it doesn't pollute every "last N hours" query.
        let rows = vec![row(0, Some("BugFix"), "legacy"), row(9_500, Some("BugFix"), "fresh")];
        let r = query_rows(rows.clone(), Some("BugFix"), 1, 100, 10_000);
        assert_eq!(r.total_matches, 1);
        assert_eq!(r.entries[0].intent, "fresh");

        // With cutoff disabled (since_hours=0) the legacy row comes back.
        let r = query_rows(rows, Some("BugFix"), 0, 100, 10_000);
        assert_eq!(r.total_matches, 2);
    }

    #[test]
    fn read_all_rows_returns_empty_for_missing_file() {
        let p = Path::new("/nonexistent/path/intent_log.jsonl");
        assert!(read_all_rows(p).is_empty());
    }

    #[test]
    fn read_all_rows_parses_real_jsonl() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("intent_log.jsonl");
        let body = concat!(
            r#"{"agent_id":"a","intent":"one","timestamp":100,"intent_type":"BugFix"}"#,
            "\n",
            "\n", // blank line tolerated
            r#"{"agent_id":"b","intent":"two","timestamp":200}"#,
            "\n",
        );
        std::fs::write(&path, body).unwrap();
        let rows = read_all_rows(&path);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].intent_type.as_deref(), Some("BugFix"));
        assert_eq!(rows[1].intent_type, None);
    }

    #[test]
    fn narrate_typed_returns_none_for_missing_file() {
        let p = Path::new("/nonexistent/intent_log.jsonl");
        assert!(narrate_typed_intents_prose(p, 24, 1).is_none());
    }

    #[test]
    fn narrate_typed_returns_none_when_no_typed_rows() {
        // File exists, has rows, but none carry intent_type — caller
        // should suppress the section entirely rather than render
        // "0 typed across 0 type(s)".
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("intent_log.jsonl");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let body = format!(
            r#"{{"agent_id":"a","intent":"untyped","timestamp":{}}}"#,
            now,
        );
        std::fs::write(&path, body).unwrap();
        assert!(narrate_typed_intents_prose(&path, 24, 1).is_none());
    }

    #[test]
    fn narrate_typed_groups_and_orders_by_count_then_name() {
        // 3 BugFix, 1 Refactor, 2 untyped. Expect BugFix first
        // (higher count), then Refactor.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("intent_log.jsonl");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let lines = vec![
            format!(r#"{{"agent_id":"a","intent":"fix1","timestamp":{},"intent_type":"BugFix"}}"#, now - 10),
            format!(r#"{{"agent_id":"a","intent":"fix2","timestamp":{},"intent_type":"BugFix"}}"#, now - 20),
            format!(r#"{{"agent_id":"a","intent":"fix3 newest","timestamp":{},"intent_type":"BugFix"}}"#, now),
            format!(r#"{{"agent_id":"a","intent":"ref1","timestamp":{},"intent_type":"Refactor"}}"#, now - 5),
            format!(r#"{{"agent_id":"a","intent":"untyped1","timestamp":{}}}"#, now - 30),
            format!(r#"{{"agent_id":"a","intent":"untyped2","timestamp":{}}}"#, now - 40),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();

        let prose = narrate_typed_intents_prose(&path, 24, 1).expect("expected typed prose");
        // Header line accuracy
        assert!(prose.contains("4 typed across 2 type(s); 2 untyped"), "header: {}", prose);
        // BugFix appears before Refactor (by count)
        let bug_idx = prose.find("BugFix").expect("BugFix in prose");
        let ref_idx = prose.find("Refactor").expect("Refactor in prose");
        assert!(bug_idx < ref_idx, "BugFix must appear before Refactor:\n{}", prose);
        // Counts present
        assert!(prose.contains("BugFix ×3"));
        assert!(prose.contains("Refactor ×1"));
        // Sample is the newest BugFix intent
        assert!(prose.contains("fix3 newest"), "sample missing: {}", prose);
    }

    #[test]
    fn narrate_typed_window_filter_drops_old_typed_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("intent_log.jsonl");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        // One typed row 2 days ago — outside a 24h window — and zero
        // typed rows in the window.
        let body = format!(
            r#"{{"agent_id":"a","intent":"old","timestamp":{},"intent_type":"BugFix"}}"#,
            now.saturating_sub(2 * 86400),
        );
        std::fs::write(&path, body).unwrap();
        assert!(narrate_typed_intents_prose(&path, 24, 1).is_none());
    }

    #[test]
    fn query_rows_breaks_timestamp_ties_by_newest_on_disk() {
        // Rapid log_intent calls land in the same `as_secs()` bucket,
        // so the tiebreaker has to resolve to "later in file wins" or
        // the "newest sample" surfaced by build_typed_intent_summary
        // would be the OLDEST same-second entry — exactly the bug
        // S2-TIS hit in e2e.
        let rows = vec![
            row(100, Some("BugFix"), "first written"),
            row(100, Some("BugFix"), "second written"),
            row(100, Some("BugFix"), "third written"),
        ];
        let q = query_rows(rows, Some("BugFix"), 0, 10, 200);
        assert_eq!(q.entries.len(), 3);
        assert_eq!(q.entries[0].intent, "third written");
        assert_eq!(q.entries[1].intent, "second written");
        assert_eq!(q.entries[2].intent, "first written");
    }

    #[test]
    fn build_typed_intent_summary_carries_buckets_and_counts() {
        // S2-TIS: structured summary must mirror the prose form's
        // bucketing and ordering. Same fixture as the prose test so the
        // two renderers stay in lockstep.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("intent_log.jsonl");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let lines = vec![
            format!(r#"{{"agent_id":"a","intent":"fix1","timestamp":{},"intent_type":"BugFix"}}"#, now - 10),
            format!(r#"{{"agent_id":"a","intent":"fix2","timestamp":{},"intent_type":"BugFix"}}"#, now - 20),
            format!(r#"{{"agent_id":"a","intent":"fix3 newest","timestamp":{},"intent_type":"BugFix"}}"#, now),
            format!(r#"{{"agent_id":"a","intent":"ref1","timestamp":{},"intent_type":"Refactor"}}"#, now - 5),
            format!(r#"{{"agent_id":"a","intent":"untyped1","timestamp":{}}}"#, now - 30),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();
        let summary = build_typed_intent_summary(&path, 24, 2).expect("Some");
        assert_eq!(summary.typed_total, 4);
        assert_eq!(summary.untyped, 1);
        assert_eq!(summary.buckets.len(), 2);
        assert_eq!(summary.buckets[0].intent_type, "BugFix");
        assert_eq!(summary.buckets[0].count, 3);
        assert_eq!(summary.buckets[0].samples.len(), 2);
        assert_eq!(summary.buckets[0].samples[0], "fix3 newest");
        assert_eq!(summary.buckets[1].intent_type, "Refactor");
        assert_eq!(summary.buckets[1].count, 1);
        // JSON envelope shape
        let v = summary.to_json();
        assert_eq!(v["typed_total"], 4);
        assert_eq!(v["untyped"], 1);
        assert_eq!(v["type_count"], 2);
        assert_eq!(v["buckets"][0]["intent_type"], "BugFix");
        assert_eq!(v["buckets"][0]["count"], 3);
        assert_eq!(v["buckets"][0]["samples"][0], "fix3 newest");
    }

    #[test]
    fn build_typed_intent_summary_returns_none_when_only_untyped() {
        // Same suppression contract as the prose form: no typed rows in
        // the window → None so callers can skip the section entirely.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("intent_log.jsonl");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let body = format!(
            r#"{{"agent_id":"a","intent":"untyped only","timestamp":{}}}"#,
            now,
        );
        std::fs::write(&path, body).unwrap();
        assert!(build_typed_intent_summary(&path, 24, 1).is_none());
    }

    #[test]
    fn intent_query_result_to_json_shape() {
        let r = IntentQueryResult {
            since_hours: 24,
            intent_type: Some("BugFix".into()),
            total_matches: 1,
            entries: vec![row(100, Some("BugFix"), "fix")],
        };
        let v = r.to_json();
        assert_eq!(v["since_hours"], 24);
        assert_eq!(v["total_matches"], 1);
        assert_eq!(v["returned"], 1);
        assert_eq!(v["intent_type"], "BugFix");
        assert_eq!(v["entries"][0]["intent_type"], "BugFix");
    }
}
