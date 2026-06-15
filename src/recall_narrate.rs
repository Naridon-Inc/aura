//! Local Block-range narration (Bet 1 step 4 / S2-NB).
//!
//! Reads `.aura/blocks/*.json` and produces a deterministic prose
//! summary of recent block activity for agent handover. No LLM is
//! involved — same inputs → byte-identical output, every time. That
//! determinism is what makes the output safe to embed inside
//! `aura_handover` XML payloads (S2-NH): the receiving agent reads
//! the same English the sender saw.
//!
//! Pure helpers (parse a single block, fold a slice into a report)
//! are exposed `pub(crate)` so the CLI dispatch (`main::run_recall`)
//! and the MCP wrapper (`mcp::tool_handover`) share one
//! implementation. Tested in `main.rs`'s `recall_tests` module
//! against constructed JSON; the disk reader is tested via tempdir.

use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BlockSummary {
    pub id: String,
    pub kind: String,            // wire string, e.g. "command", "message"
    pub state: String,           // wire string, e.g. "completed", "failed"
    pub intent_summary: String,  // empty if missing
    pub actor: String,           // AgentRef.id; "?" if missing
    pub anchor: String,          // pretty form: "function:foo", "file:src/x.rs", "none"
    pub created_at: String,      // ISO-8601 string from envelope; "" if missing
    pub created_at_ms: Option<i64>,
    pub has_signature: bool,
    pub intent_type: Option<String>, // canonical typed-intent tag (S2-TIN)
}

#[derive(Debug)]
pub(crate) struct BlockNarration {
    pub matched: usize,
    pub since_hours: i64,
    pub cutoff_ms: Option<i64>,
    pub by_kind: Vec<(String, usize)>,
    pub by_state: Vec<(String, usize)>,
    pub by_actor: Vec<(String, usize)>,
    pub by_anchor: Vec<(String, usize)>,
    pub by_intent_type: Vec<(String, usize)>, // S2-TIN: typed-intent histogram
    pub untyped: usize,                       // S2-TIN: blocks without intent_type
    pub signed: usize,
    pub failed: Vec<BlockSummary>,
    pub listed: Vec<BlockSummary>,
}

impl BlockNarration {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "matched": self.matched,
            "since_hours": self.since_hours,
            "signed": self.signed,
            "by_kind": self.by_kind.iter().map(|(k, n)| serde_json::json!({"name": k, "count": n})).collect::<Vec<_>>(),
            "by_state": self.by_state.iter().map(|(k, n)| serde_json::json!({"name": k, "count": n})).collect::<Vec<_>>(),
            "by_actor": self.by_actor.iter().map(|(k, n)| serde_json::json!({"name": k, "count": n})).collect::<Vec<_>>(),
            "by_anchor": self.by_anchor.iter().map(|(k, n)| serde_json::json!({"name": k, "count": n})).collect::<Vec<_>>(),
            "by_intent_type": self.by_intent_type.iter().map(|(k, n)| serde_json::json!({"name": k, "count": n})).collect::<Vec<_>>(),
            "untyped": self.untyped,
            "failed": self.failed.iter().map(block_summary_to_json).collect::<Vec<_>>(),
            "listed": self.listed.iter().map(block_summary_to_json).collect::<Vec<_>>(),
        })
    }

    pub fn to_prose(&self) -> String {
        let mut out = String::new();
        if self.matched == 0 {
            out.push_str(&format!(
                "Block window summary (last {}h): no blocks matched.\n",
                self.since_hours
            ));
            return out;
        }
        let actor_count = self.by_actor.len();
        out.push_str(&format!(
            "Block window summary (last {}h): {} block{} across {} actor{}, {} signed.\n",
            self.since_hours,
            self.matched,
            if self.matched == 1 { "" } else { "s" },
            actor_count,
            if actor_count == 1 { "" } else { "s" },
            self.signed,
        ));
        if !self.by_kind.is_empty() {
            out.push_str("  Kinds: ");
            out.push_str(&fmt_count_pairs(&self.by_kind));
            out.push('\n');
        }
        if !self.by_state.is_empty() {
            out.push_str("  States: ");
            out.push_str(&fmt_count_pairs(&self.by_state));
            out.push('\n');
        }
        if !self.by_actor.is_empty() {
            out.push_str("  Top actors: ");
            out.push_str(&fmt_count_pairs(&self.by_actor));
            out.push('\n');
        }
        if !self.by_anchor.is_empty() {
            out.push_str("  Top anchors: ");
            out.push_str(&fmt_count_pairs(&self.by_anchor));
            out.push('\n');
        }
        if !self.by_intent_type.is_empty() || self.untyped > 0 {
            // S2-TIN: typed-intent histogram. We always print this line if
            // anything was matched, so an audit trail without typed entries
            // is still legible ("Intent types: 0 typed; N untyped").
            let typed_total: usize =
                self.by_intent_type.iter().map(|(_, n)| n).sum();
            out.push_str("  Intent types: ");
            if self.by_intent_type.is_empty() {
                out.push_str(&format!("0 typed; {} untyped\n", self.untyped));
            } else {
                out.push_str(&fmt_count_pairs(&self.by_intent_type));
                out.push_str(&format!(
                    " ({} typed; {} untyped)\n",
                    typed_total, self.untyped
                ));
            }
        }
        if !self.failed.is_empty() {
            out.push_str(&format!("  Failed ({}):\n", self.failed.len()));
            for s in &self.failed {
                out.push_str(&format!(
                    "    - [{}/{}] {} (actor={}, anchor={}, at={})\n",
                    s.kind,
                    s.state,
                    if s.intent_summary.is_empty() {
                        "(no intent)".to_string()
                    } else {
                        truncate(&s.intent_summary, 80)
                    },
                    truncate(&s.actor, 40),
                    truncate(&s.anchor, 30),
                    s.created_at,
                ));
            }
        }
        if !self.listed.is_empty() {
            out.push_str(&format!(
                "  Recent intents (newest first, top {}):\n",
                self.listed.len()
            ));
            for (i, s) in self.listed.iter().enumerate() {
                out.push_str(&format!(
                    "    {}. [{}/{}] {} (actor={}, anchor={}, at={})\n",
                    i + 1,
                    s.kind,
                    s.state,
                    if s.intent_summary.is_empty() {
                        "(no intent)".to_string()
                    } else {
                        truncate(&s.intent_summary, 80)
                    },
                    truncate(&s.actor, 40),
                    truncate(&s.anchor, 30),
                    s.created_at,
                ));
            }
        }
        out
    }
}

pub(crate) fn block_summary_to_json(s: &BlockSummary) -> Value {
    let mut row = serde_json::json!({
        "id": s.id,
        "kind": s.kind,
        "state": s.state,
        "intent_summary": s.intent_summary,
        "actor": s.actor,
        "anchor": s.anchor,
        "created_at": s.created_at,
        "has_signature": s.has_signature,
    });
    // S2-TIN: surface intent_type only when present so untyped envelopes
    // don't grow the row with explicit nulls.
    if let Some(t) = &s.intent_type {
        row.as_object_mut()
            .expect("json! object")
            .insert("intent_type".to_string(), serde_json::json!(t));
    }
    row
}

pub(crate) fn fmt_count_pairs(pairs: &[(String, usize)]) -> String {
    pairs
        .iter()
        .map(|(k, n)| format!("{} ({})", k, n))
        .collect::<Vec<_>>()
        .join(", ")
}

pub(crate) fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

pub(crate) fn current_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn read_blocks_dir(dir: &Path) -> Result<Vec<Value>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("read {}: {}", dir.display(), e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            out.push(v);
        }
    }
    Ok(out)
}

pub(crate) fn parse_block_summary(v: &Value) -> Option<BlockSummary> {
    let id = v.get("id").and_then(|x| x.as_str())?.to_string();
    // BlockKind is serialized as either a snake_case string or a tagged
    // {"kind": "..."} pair depending on how the envelope was written.
    // Probe both shapes; if neither hits, the row is malformed and we skip it.
    let kind = v
        .get("kind")
        .and_then(|k| {
            k.as_str().map(|s| s.to_string()).or_else(|| {
                k.get("kind").and_then(|s| s.as_str()).map(|s| s.to_string())
            })
        })
        .unwrap_or_else(|| "?".to_string());
    let state = v
        .get("state")
        .and_then(|s| s.as_str())
        .unwrap_or("?")
        .to_string();
    let intent_summary = v
        .pointer("/intent/summary")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let actor = v
        .pointer("/provenance/actor/id")
        .and_then(|x| x.as_str())
        .or_else(|| v.pointer("/provenance/actor").and_then(|x| x.as_str()))
        .unwrap_or("?")
        .to_string();
    // AnchorRef serializes as {"kind": "function|file|...", "id": "..."}.
    let anchor_kind = v
        .pointer("/anchor/kind")
        .and_then(|x| x.as_str())
        .unwrap_or("none");
    let anchor_id = v
        .pointer("/anchor/id")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let anchor = match (anchor_kind, anchor_id.is_empty()) {
        ("none", _) | (_, true) => "none".to_string(),
        (k, false) => format!("{}:{}", k, anchor_id),
    };
    let created_at = v
        .get("created_at")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let created_at_ms = parse_iso8601_to_ms(&created_at);
    let has_signature = v.pointer("/provenance/signature/sig_b64").is_some();
    // S2-TIN: typed intent stamped by S2-TIB lives at payload.body.intent_type.
    // Tolerate either string or absent — anything else (number, object, etc.)
    // we treat as missing rather than panicking.
    let intent_type = v
        .pointer("/payload/body/intent_type")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Some(BlockSummary {
        id,
        kind,
        state,
        intent_summary,
        actor,
        anchor,
        created_at,
        created_at_ms,
        has_signature,
        intent_type,
    })
}

pub(crate) fn collect_block_summaries(blocks: &[Value]) -> Vec<BlockSummary> {
    blocks.iter().filter_map(parse_block_summary).collect()
}

// Best-effort ISO-8601 → unix ms. Strict enough for the recency filter:
// requires `YYYY-MM-DDTHH:MM:SS` plus an optional fractional second and a
// trailing `Z`. Returns None on any parse miss; the caller treats that as
// "skip the recency filter for this row" rather than dropping it entirely.
pub(crate) fn parse_iso8601_to_ms(s: &str) -> Option<i64> {
    if s.is_empty() {
        return None;
    }
    let stripped = s.strip_suffix('Z').unwrap_or(s);
    use time::format_description::well_known::Iso8601;
    use time::PrimitiveDateTime;
    if let Ok(dt) = PrimitiveDateTime::parse(stripped, &Iso8601::DEFAULT) {
        let ts = dt.assume_utc().unix_timestamp_nanos();
        return Some((ts / 1_000_000) as i64);
    }
    None
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_block_narration(
    summaries: &[BlockSummary],
    now_ms: i64,
    since_hours: i64,
    kind_filter: &[String],
    actor_filter: Option<&str>,
    list_limit: usize,
) -> BlockNarration {
    build_block_narration_typed(
        summaries,
        now_ms,
        since_hours,
        kind_filter,
        actor_filter,
        None,
        list_limit,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_block_narration_typed(
    summaries: &[BlockSummary],
    now_ms: i64,
    since_hours: i64,
    kind_filter: &[String],
    actor_filter: Option<&str>,
    intent_type_filter: Option<&str>,
    list_limit: usize,
) -> BlockNarration {
    let cutoff_ms = if since_hours > 0 {
        Some(now_ms - since_hours.saturating_mul(3_600_000))
    } else {
        None
    };
    let kind_filter_lower: Vec<String> =
        kind_filter.iter().map(|k| k.to_lowercase()).collect();
    let actor_needle = actor_filter.map(|s| s.to_lowercase());

    let mut matched: Vec<&BlockSummary> = Vec::new();
    for s in summaries {
        // Recency: if the row has no parseable timestamp we keep it (so
        // legacy/malformed envelopes don't silently disappear), but if
        // it parses we enforce the window.
        if let (Some(cutoff), Some(ts)) = (cutoff_ms, s.created_at_ms) {
            if ts < cutoff {
                continue;
            }
        }
        if !kind_filter_lower.is_empty()
            && !kind_filter_lower.contains(&s.kind.to_lowercase())
        {
            continue;
        }
        if let Some(needle) = &actor_needle {
            if !s.actor.to_lowercase().contains(needle) {
                continue;
            }
        }
        // S2-TINF: typed-intent filter. Case-sensitive equality against
        // the canonical type tag (Refactor / BugFix / ...). Untyped
        // blocks are dropped when the filter is set.
        if let Some(needle_type) = intent_type_filter {
            match &s.intent_type {
                Some(t) if t == needle_type => {}
                _ => continue,
            }
        }
        matched.push(s);
    }

    let by_kind = top_count_pairs(matched.iter().map(|s| s.kind.clone()), 8);
    let by_state = top_count_pairs(matched.iter().map(|s| s.state.clone()), 8);
    let by_actor = top_count_pairs(matched.iter().map(|s| s.actor.clone()), 5);
    let by_anchor = top_count_pairs(matched.iter().map(|s| s.anchor.clone()), 5);
    // S2-TIN: typed-intent histogram. Untyped envelopes (legacy / non-typed
    // log events) are counted separately so the narration can show both
    // "what was tagged" and "how much wasn't".
    let by_intent_type = top_count_pairs(
        matched.iter().filter_map(|s| s.intent_type.clone()),
        7,
    );
    let untyped = matched.iter().filter(|s| s.intent_type.is_none()).count();
    let signed = matched.iter().filter(|s| s.has_signature).count();
    let failed: Vec<BlockSummary> = matched
        .iter()
        .filter(|s| s.state == "failed" || s.state == "denied" || s.state == "rolled_back")
        .map(|s| (*s).clone())
        .collect();

    // Newest-first listing, capped at list_limit. Rows missing a parseable
    // timestamp sort last (None < Some(x) → reversed becomes last).
    let mut sorted: Vec<&BlockSummary> = matched.clone();
    sorted.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    let listed: Vec<BlockSummary> = sorted.into_iter().take(list_limit).cloned().collect();

    BlockNarration {
        matched: matched.len(),
        since_hours,
        cutoff_ms,
        by_kind,
        by_state,
        by_actor,
        by_anchor,
        by_intent_type,
        untyped,
        signed,
        failed,
        listed,
    }
}

pub(crate) fn top_count_pairs(
    it: impl Iterator<Item = String>,
    top_n: usize,
) -> Vec<(String, usize)> {
    use std::collections::BTreeMap;
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for k in it {
        *counts.entry(k).or_insert(0) += 1;
    }
    let mut pairs: Vec<(String, usize)> = counts.into_iter().collect();
    // Sort by count desc, then key asc — stable, deterministic ordering.
    pairs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    pairs.truncate(top_n);
    pairs
}

/// One-shot helper: read .aura/blocks/, build a 24-hour narration, and
/// return its prose form. Used by `aura_handover` to embed a
/// block-window summary in the XML payload (S2-NH). Returns None when
/// either the directory is missing or no blocks fall in the window —
/// the caller skips the section in that case so the handover XML
/// stays terse.
pub(crate) fn narrate_recent_blocks_prose(
    blocks_dir: &Path,
    since_hours: i64,
    list_limit: usize,
) -> Option<String> {
    let blocks = read_blocks_dir(blocks_dir).ok()?;
    if blocks.is_empty() {
        return None;
    }
    let summaries = collect_block_summaries(&blocks);
    let report = build_block_narration(
        &summaries,
        current_unix_ms(),
        since_hours,
        &[],
        None,
        list_limit,
    );
    if report.matched == 0 {
        return None;
    }
    Some(report.to_prose())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_block(dir: &Path, id: &str, created_at: &str) {
        write_block_typed(dir, id, created_at, None);
    }

    fn write_block_typed(
        dir: &Path,
        id: &str,
        created_at: &str,
        intent_type: Option<&str>,
    ) {
        let mut payload = json!({"body": {"intent": format!("intent {}", id)}});
        if let Some(t) = intent_type {
            payload["body"]["intent_type"] = json!(t);
        }
        let v = json!({
            "id": id,
            "kind": "command",
            "state": "completed",
            "intent": {"summary": format!("intent {}", id)},
            "anchor": {"kind": "function", "id": "f1"},
            "payload": payload,
            "provenance": {"actor": {"id": "did:a", "kind": "agent"}, "origin_host": "h"},
            "created_at": created_at
        });
        std::fs::write(
            dir.join(format!("{}.json", id)),
            serde_json::to_string(&v).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn narrate_recent_blocks_prose_returns_none_when_dir_missing() {
        let nope = Path::new("/tmp/aura_recall_narrate_missing_xyz_pid_only");
        let _ = std::fs::remove_dir_all(nope);
        assert!(narrate_recent_blocks_prose(nope, 24, 5).is_none());
    }

    #[test]
    fn narrate_recent_blocks_prose_returns_none_when_window_empty() {
        let tmp = std::env::temp_dir()
            .join(format!("aura_nrbp_window_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // 1900-era timestamp — no realistic since_hours covers it.
        write_block(&tmp, "old", "1990-01-01T00:00:00Z");
        let prose = narrate_recent_blocks_prose(&tmp, 1, 5);
        assert!(prose.is_none(), "prose was: {:?}", prose);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn narrate_aggregates_typed_intents_and_counts_untyped() {
        // S2-TIN: build a tiny corpus with two typed envelopes (Refactor x2)
        // and one untyped, and confirm the breakdown surfaces both buckets
        // and the explicit "(2 typed; 1 untyped)" tail.
        let tmp = std::env::temp_dir()
            .join(format!("aura_nrbp_typed_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        write_block_typed(&tmp, "r1", "2026-04-27T10:00:00Z", Some("Refactor"));
        write_block_typed(&tmp, "r2", "2026-04-27T10:01:00Z", Some("Refactor"));
        write_block_typed(&tmp, "u1", "2026-04-27T10:02:00Z", None);
        let big_window = 24 * 365 * 50;
        let blocks = read_blocks_dir(&tmp).unwrap();
        let summaries = collect_block_summaries(&blocks);
        let report = build_block_narration(
            &summaries,
            current_unix_ms(),
            big_window,
            &[],
            None,
            10,
        );
        assert_eq!(report.matched, 3);
        assert_eq!(report.untyped, 1);
        assert_eq!(report.by_intent_type, vec![("Refactor".to_string(), 2)]);
        let prose = report.to_prose();
        assert!(
            prose.contains("Intent types: Refactor (2) (2 typed; 1 untyped)"),
            "prose missing typed line:\n{}",
            prose
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn narrate_intent_types_section_omits_when_no_blocks_have_payload() {
        // Pre-S2-TIB envelopes have no payload.body — confirm we don't emit
        // a confusing "0 typed; 0 untyped" line in that case (untyped > 0
        // condition guards us, but we still want the assertion locked in).
        let tmp = std::env::temp_dir()
            .join(format!("aura_nrbp_legacy_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // Legacy shape: no payload field at all.
        let v = json!({
            "id": "legacy1",
            "kind": "command",
            "state": "completed",
            "intent": {"summary": "legacy"},
            "anchor": {"kind": "none", "id": ""},
            "provenance": {"actor": {"id": "did:a", "kind": "agent"}, "origin_host": "h"},
            "created_at": "2026-04-27T10:00:00Z",
        });
        std::fs::write(tmp.join("legacy1.json"), serde_json::to_string(&v).unwrap())
            .unwrap();
        let big_window = 24 * 365 * 50;
        let prose = narrate_recent_blocks_prose(&tmp, big_window, 5)
            .expect("expected Some for legacy block");
        // by_intent_type empty, but untyped == 1 → line still printed with
        // the explicit "0 typed; 1 untyped" form.
        assert!(
            prose.contains("Intent types: 0 typed; 1 untyped"),
            "prose:\n{}",
            prose
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn narrate_typed_filter_drops_other_buckets_and_untyped() {
        // S2-TINF: --type Refactor should narrow matched to ONLY the
        // Refactor block; the BugFix block and the untyped block both
        // get dropped.
        let tmp = std::env::temp_dir()
            .join(format!("aura_nrbp_tinf_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        write_block_typed(&tmp, "r1", "2026-04-27T10:00:00Z", Some("Refactor"));
        write_block_typed(&tmp, "b1", "2026-04-27T10:01:00Z", Some("BugFix"));
        write_block_typed(&tmp, "u1", "2026-04-27T10:02:00Z", None);
        let blocks = read_blocks_dir(&tmp).unwrap();
        let summaries = collect_block_summaries(&blocks);
        let big_window = 24 * 365 * 50;
        let report = build_block_narration_typed(
            &summaries,
            current_unix_ms(),
            big_window,
            &[],
            None,
            Some("Refactor"),
            10,
        );
        assert_eq!(report.matched, 1);
        assert_eq!(report.untyped, 0);
        assert_eq!(report.by_intent_type, vec![("Refactor".to_string(), 1)]);
        assert_eq!(report.listed.len(), 1);
        assert_eq!(report.listed[0].id, "r1");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn narrate_recent_blocks_prose_returns_some_when_inside_window() {
        let tmp = std::env::temp_dir()
            .join(format!("aura_nrbp_inside_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // Use a wide window (50 years) so any current-decade test run
        // catches the 2026-dated synthetic block.
        write_block(&tmp, "recent", "2026-04-27T10:00:00Z");
        let big_window = 24 * 365 * 50;
        let prose = narrate_recent_blocks_prose(&tmp, big_window, 5)
            .expect("expected Some when one block falls in the window");
        assert!(prose.contains("Block window summary"));
        assert!(prose.contains("intent recent"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
