//! Canonical agent-skill ranker — the single source of truth for
//! "which provider is historically best for this taxonomy cell".
//!
//! The cloud `GET /api/v2/skill/stats?category=&language=&layer=` returns
//! one rollup row per provider for a taxonomy cell. This module turns
//! those rows into a ranking so every caller shares one formula. The
//! formula used to live only in aura-shell `manager::skill::rank_providers`;
//! that copy now shells out to `aura skill suggest`, which calls this
//! module — so there is exactly one ranker in the system, and Replay Lab
//! (Wave 3) can score runs against the same scale.
//!
//! `score = avg_grade * pr_pass_rate / (1 + cost_usd)`.
//!
//! Quality and reliability dominate; cost is a soft modifier that only
//! becomes significant once a provider averages more than ~$0.50/task.
//! (An earlier log-based cost term was too aggressive at cents-level
//! costs — a 3.2-grade provider at $0.01 outranked a 4.5-grade provider
//! at $0.05 by 3x, which is not the behaviour we want.) A provider needs
//! at least [`MIN_SAMPLES`] graded outcomes in the cell before it can be
//! suggested — below that the average is too noisy to route on. Ties on
//! score break toward the larger sample count (more evidence wins).

use serde::{Deserialize, Serialize};

/// Minimum graded outcomes a provider needs in a taxonomy cell before
/// the ranker will suggest it. Mirrors the historical threshold from the
/// shell ranker so routing behaviour is unchanged by this extraction.
pub const MIN_SAMPLES: u32 = 10;

/// Neutral grade used when a cell has rows but none were brain-graded —
/// 3 of 5 is "average", neither rewarding nor punishing the provider.
const DEFAULT_GRADE: f64 = 3.0;
/// Assume PR-review pass when there is no PR signal yet, so a provider
/// with outcomes but no reviews isn't zeroed out before it has a chance.
const DEFAULT_PR_PASS: f64 = 1.0;

/// One per-provider rollup row as returned by `GET /skill/stats`.
///
/// `q` / `pr_pass_rate` are optional because the cloud omits them when a
/// cell has no graded / no PR-reviewed outcomes (it serializes those
/// fields with `skip_serializing_if = "Option::is_none"`). `c` is
/// optional + defaulted so an un-costed provider isn't penalised.
#[derive(Debug, Clone, Deserialize)]
pub struct StatsRow {
    pub provider_id: String,
    /// Sample count for this taxonomy cell + provider.
    pub n: u32,
    /// Average brain_quality_grade (1..=5), or `None` when no row graded.
    #[serde(default)]
    pub q: Option<f64>,
    /// Average cost_usd in dollars.
    #[serde(default)]
    pub c: Option<f64>,
    /// pr_review_pass rate over rows where the signal is present.
    #[serde(default)]
    pub pr_pass_rate: Option<f64>,
}

/// A ranked provider: the formula [`RankedProvider::score`] plus the
/// evidence behind it.
#[derive(Debug, Clone, Serialize)]
pub struct RankedProvider {
    pub provider_id: String,
    pub score: f64,
    pub sample_count: u32,
}

/// Score one row with the canonical formula. Defaults match the shell's
/// historical behaviour: ungraded → neutral 3.0, no PR signal → 1.0
/// (assume pass), no cost → 0.0.
pub fn score_row(row: &StatsRow) -> f64 {
    let q = row.q.unwrap_or(DEFAULT_GRADE);
    let pr = row.pr_pass_rate.unwrap_or(DEFAULT_PR_PASS);
    let cost = row.c.unwrap_or(0.0).max(0.0);
    q * pr / (1.0 + cost)
}

/// Rank every row that clears [`MIN_SAMPLES`], best first. Ties on score
/// break toward the larger sample count. Rows below threshold are
/// dropped — they carry too little evidence to route on.
pub fn rank(rows: &[StatsRow]) -> Vec<RankedProvider> {
    let mut ranked: Vec<RankedProvider> = rows
        .iter()
        .filter(|r| r.n >= MIN_SAMPLES)
        .map(|r| RankedProvider {
            provider_id: r.provider_id.clone(),
            score: score_row(r),
            sample_count: r.n,
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.sample_count.cmp(&a.sample_count))
    });
    ranked
}

/// The single best provider for a cell, or `None` when no provider has
/// enough evidence yet.
pub fn best(rows: &[StatsRow]) -> Option<RankedProvider> {
    rank(rows).into_iter().next()
}

/// Extract the `StatsRow` list from a `GET /skill/stats` response body.
///
/// The cloud handler returns `{ "rows": [ … ] }`, but we also accept a
/// bare `[ … ]` array so the parser is robust to handler-shape drift and
/// to callers that pre-unwrap. Rows that don't deserialize (missing
/// `provider_id`/`n`) are skipped rather than failing the whole call.
pub fn parse_stats_rows(body: &serde_json::Value) -> Vec<StatsRow> {
    let arr = body
        .get("rows")
        .and_then(|v| v.as_array())
        .or_else(|| body.as_array());
    match arr {
        Some(items) => items
            .iter()
            .filter_map(|item| serde_json::from_value::<StatsRow>(item.clone()).ok())
            .collect(),
        None => Vec::new(),
    }
}

// -- Local-ledger health (UU-W1 doctor) ----------------------------------

/// Presentation-free health facts for the local Agent Skill Ledger
/// (`~/.aura/agent_skills.json`, written by the shell's `manager::skill`).
/// Both `aura doctor` (CLI) and the MCP `aura_doctor` tool compute this via
/// [`ledger_health`] and format it themselves, so the two surfaces never
/// drift on what "healthy" means.
#[derive(Debug, Clone, PartialEq)]
pub struct LedgerHealth {
    /// Total outcome rows recorded locally (drained or not).
    pub recorded: usize,
    /// Rows recorded locally but not yet confirmed by the cloud.
    pub dirty: usize,
    /// `(cell_label, sample_count)` for every taxonomy cell below
    /// [`MIN_SAMPLES`], sorted by sample count descending. Cell labels are
    /// `coarse/lang/layer`, with `-` for an absent fine dimension.
    pub immature_cells: Vec<(String, usize)>,
    /// Distinct taxonomy cells observed locally.
    pub total_cells: usize,
}

/// Parse the raw `agent_skills.json` body into [`LedgerHealth`]. Returns
/// `None` when the body is unparseable or carries neither an `outcomes`
/// nor a `dirty` key — i.e. it isn't a ledger — so callers can print a
/// distinct "no ledger yet" line. Untyped parse keeps this decoupled from
/// the shell's struct definitions.
pub fn ledger_health(raw: &str) -> Option<LedgerHealth> {
    let store: serde_json::Value = serde_json::from_str(raw).ok()?;
    if store.get("outcomes").is_none() && store.get("dirty").is_none() {
        return None;
    }
    let outcomes = store
        .get("outcomes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let dirty = store
        .get("dirty")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    let mut cells: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for o in &outcomes {
        let tax = o.get("taxonomy");
        let coarse = tax
            .and_then(|t| t.get("coarse_category"))
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        let lang = tax
            .and_then(|t| t.get("fine_language"))
            .and_then(|v| v.as_str())
            .unwrap_or("-");
        let layer = tax
            .and_then(|t| t.get("fine_layer"))
            .and_then(|v| v.as_str())
            .unwrap_or("-");
        *cells.entry(format!("{coarse}/{lang}/{layer}")).or_default() += 1;
    }
    let total_cells = cells.len();
    let mut immature_cells: Vec<(String, usize)> = cells
        .into_iter()
        .filter(|(_, n)| (*n as u32) < MIN_SAMPLES)
        .collect();
    immature_cells.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));

    Some(LedgerHealth {
        recorded: outcomes.len(),
        dirty,
        immature_cells,
        total_cells,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(provider: &str, n: u32, q: Option<f64>, c: Option<f64>, pr: Option<f64>) -> StatsRow {
        StatsRow {
            provider_id: provider.to_string(),
            n,
            q,
            c,
            pr_pass_rate: pr,
        }
    }

    #[test]
    fn below_threshold_is_dropped() {
        let rows = vec![row("a", 9, Some(5.0), Some(0.0), Some(1.0))];
        assert!(best(&rows).is_none());
        assert!(rank(&rows).is_empty());
    }

    #[test]
    fn quality_beats_marginally_cheaper() {
        // 4.5-grade @ $0.05 should outrank 3.2-grade @ $0.01.
        let rows = vec![
            row("cheap", 20, Some(3.2), Some(0.01), Some(1.0)),
            row("good", 20, Some(4.5), Some(0.05), Some(1.0)),
        ];
        assert_eq!(best(&rows).unwrap().provider_id, "good");
    }

    #[test]
    fn pr_pass_rate_modulates_score() {
        // Same grade/cost, but the flaky one passes review half the time.
        let rows = vec![
            row("solid", 15, Some(4.0), Some(0.0), Some(1.0)),
            row("flaky", 15, Some(4.0), Some(0.0), Some(0.5)),
        ];
        let ranked = rank(&rows);
        assert_eq!(ranked[0].provider_id, "solid");
        assert!((ranked[0].score - 4.0).abs() < 1e-9);
        assert!((ranked[1].score - 2.0).abs() < 1e-9);
    }

    #[test]
    fn ties_break_toward_more_samples() {
        let rows = vec![
            row("less", 12, Some(4.0), Some(0.0), Some(1.0)),
            row("more", 40, Some(4.0), Some(0.0), Some(1.0)),
        ];
        assert_eq!(best(&rows).unwrap().provider_id, "more");
    }

    #[test]
    fn missing_optionals_use_neutral_defaults() {
        // No grade, no pr, no cost → score == DEFAULT_GRADE.
        let rows = vec![row("bare", 10, None, None, None)];
        let b = best(&rows).unwrap();
        assert!((b.score - DEFAULT_GRADE).abs() < 1e-9);
    }

    #[test]
    fn ledger_health_none_for_non_ledger() {
        assert!(ledger_health("not json").is_none());
        assert!(ledger_health("{}").is_none());
        assert!(ledger_health("{\"other\":1}").is_none());
    }

    #[test]
    fn ledger_health_counts_dirty_and_immature_cells() {
        let raw = r#"{
            "outcomes": [
                {"taxonomy":{"coarse_category":"backend","fine_language":"rust","fine_layer":"api"}},
                {"taxonomy":{"coarse_category":"backend","fine_language":"rust","fine_layer":"api"}},
                {"taxonomy":{"coarse_category":"frontend","fine_language":"typescript","fine_layer":"ui"}}
            ],
            "dirty": [0, 2]
        }"#;
        let h = ledger_health(raw).unwrap();
        assert_eq!(h.recorded, 3);
        assert_eq!(h.dirty, 2);
        assert_eq!(h.total_cells, 2);
        // Both cells are below the 10-sample threshold; the 2-sample cell
        // sorts ahead of the 1-sample cell.
        assert_eq!(h.immature_cells.len(), 2);
        assert_eq!(h.immature_cells[0], ("backend/rust/api".to_string(), 2));
        assert_eq!(h.immature_cells[1], ("frontend/typescript/ui".to_string(), 1));
    }

    #[test]
    fn ledger_health_empty_present_file_is_some() {
        let h = ledger_health(r#"{"outcomes":[],"dirty":[]}"#).unwrap();
        assert_eq!(h.recorded, 0);
        assert_eq!(h.dirty, 0);
        assert_eq!(h.total_cells, 0);
        assert!(h.immature_cells.is_empty());
    }

    #[test]
    fn ledger_health_mature_cell_excluded() {
        // 10 outcomes in one cell → at threshold → not immature.
        let mut outcomes = String::new();
        for i in 0..10 {
            if i > 0 {
                outcomes.push(',');
            }
            outcomes.push_str(
                r#"{"taxonomy":{"coarse_category":"backend","fine_language":"rust","fine_layer":"api"}}"#,
            );
        }
        let raw = format!("{{\"outcomes\":[{outcomes}],\"dirty\":[]}}");
        let h = ledger_health(&raw).unwrap();
        assert_eq!(h.total_cells, 1);
        assert!(h.immature_cells.is_empty());
    }

    #[test]
    fn parse_handles_rows_wrapper_and_bare_array() {
        let wrapped = serde_json::json!({
            "rows": [{ "provider_id": "x", "n": 11, "q": 4.0, "c": 0.0, "pr_pass_rate": 1.0 }]
        });
        let bare = serde_json::json!([
            { "provider_id": "x", "n": 11, "c": 0.0 }
        ]);
        assert_eq!(parse_stats_rows(&wrapped).len(), 1);
        assert_eq!(parse_stats_rows(&bare).len(), 1);
        assert!(parse_stats_rows(&serde_json::json!({})).is_empty());
    }
}
