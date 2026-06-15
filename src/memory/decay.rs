// W4 — retention decay (Ebbinghaus × SM-2) + scheduled consolidation
// (AURA-42).
//
// Every entry carries a retention score in (0, 1] that decays with time
// and is reinforced by access:
//
//   S(n, w) = S0 · EF^(n − 1) · (1 + w)      stability, in DAYS
//   R(Δt)   = exp(−Δt_days / S)              retention
//
// where `n` is the access count (each ranked-search hit bumps it), `w` is
// the importance weight (clamped UP to `W_MIN` so a zeroed field can't
// nuke an entry), and Δt runs from `last_accessed` (fallback `added_at`).
//
// Ranking blend: an entry's RRF score is multiplied by `max(R, R_MIN)`.
// Entries whose R has fallen below `R_MIN` drop out of DEFAULT search
// results entirely — they are NEVER deleted, stay in the full section
// view, and come back under `--all` (where the `max(·, R_MIN)` floor keeps
// their blended score sane instead of zeroing it).
//
// Consolidation: the same compaction the on-demand `aura memory compact`
// MCP tool runs, but live-entry-aware (W3 superseded rows are excluded
// from the input AND preserved through the rewrite) and schedulable — the
// aura-daemon 30-minute loop and `aura memory consolidate` share
// `consolidate_mem` as the single code path. No model key → the section is
// skipped silently for that cycle, never an error, never data loss.

use crate::memory::{provenance, retrieval::RankedResult, MemoryEntry, ProjectMemory};

// ── Constants ──

/// Initial stability for a never-accessed entry, in days (`S0`).
pub const S0_DAYS: f64 = 2.0;

/// SM-2 "ease factor": the multiplier stability gains per reinforcement.
/// Semantics straight from SuperMemo-2: every successful recall multiplies
/// the inter-review interval by EF, so `EF^(n − 1)` compounds over the
/// entry's access history. SM-2 bounds the factor to [1.3, 2.5] as ratings
/// adjust it; Aura uses a fixed 2.5 today but clamps through
/// [`EF_MIN`]..[`EF_MAX`] (see [`ease_factor`]) so a future per-entry ease
/// can never leave the sane band: below 1.1 reviews stop spacing out
/// (memory churn), above 2.5 stability explodes and nothing ever decays.
pub const EASE_FACTOR: f64 = 2.5;
/// Lower clamp for the ease factor.
pub const EF_MIN: f64 = 1.1;
/// Upper clamp for the ease factor.
pub const EF_MAX: f64 = 2.5;

/// Retention floor: below this an entry leaves DEFAULT search results
/// (still in the full section view / `--all`; never deleted), and the
/// blend never multiplies by less than this.
pub const R_MIN: f64 = 0.05;
/// Importance floor: stored `importance` clamps UP to this inside the
/// stability formula.
pub const W_MIN: f32 = 0.3;

/// A section needs at least this many LIVE entries before consolidation
/// touches it (same threshold the on-demand compact always used).
pub const CONSOLIDATE_MIN_LIVE: usize = 10;
/// Consolidation compresses a section down to at most this many entries.
pub const CONSOLIDATE_MAX_OUT: usize = 5;

/// The effective ease factor: [`EASE_FACTOR`] clamped to
/// [[`EF_MIN`], [`EF_MAX`]].
pub fn ease_factor() -> f64 {
    EASE_FACTOR.clamp(EF_MIN, EF_MAX)
}

// ── Retention math ──

/// Stability `S(n, w) = S0 · EF^(n − 1) · (1 + w)` in days. `n = 0` (never
/// reinforced) gives `EF^(−1)` — a fresh, untouched fact starts LESS
/// stable than S0 and earns durability through access. `w` clamps up to
/// [`W_MIN`].
pub fn stability_days(access_count: u32, importance: f32) -> f64 {
    let w = importance.max(W_MIN) as f64;
    S0_DAYS * ease_factor().powi(access_count as i32 - 1) * (1.0 + w)
}

/// Seconds since epoch of the entry's decay anchor: `last_accessed`
/// (RFC3339) when parseable, else `added_at`.
fn decay_anchor_secs(entry: &MemoryEntry) -> u64 {
    entry
        .last_accessed
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp().max(0) as u64)
        .unwrap_or(entry.added_at)
}

/// Retention `R(Δt) = exp(−Δt_days / S)` at `now_secs` (unix). Future
/// anchors (clock skew) saturate at Δt = 0 → R = 1.0.
pub fn retention(entry: &MemoryEntry, now_secs: u64) -> f64 {
    let anchor = decay_anchor_secs(entry);
    let dt_days = now_secs.saturating_sub(anchor) as f64 / 86_400.0;
    (-dt_days / stability_days(entry.access_count, entry.importance)).exp()
}

// ── Ranking blend ──

/// Blend retention into RRF-ranked results: each result's `score` becomes
/// `rrf × max(R, R_MIN)` and the list is re-sorted. In default mode
/// (`include_all = false`) results with `R < R_MIN` are dropped entirely.
/// Returns `(result, retention)` pairs, best blended score first; results
/// whose id isn't an entry (defensive) keep their score with R = 1.0.
pub fn blend_results(
    ranked: Vec<RankedResult>,
    mem: &ProjectMemory,
    now_secs: u64,
    include_all: bool,
) -> Vec<(RankedResult, f64)> {
    let by_id: std::collections::HashMap<&str, &MemoryEntry> = mem
        .conventions
        .iter()
        .chain(&mem.gotchas)
        .chain(&mem.context)
        .chain(&mem.active_work)
        .map(|e| (e.id.as_str(), e))
        .collect();

    let mut blended: Vec<(RankedResult, f64)> = ranked
        .into_iter()
        .filter_map(|mut r| {
            let ret = by_id.get(r.id.as_str()).map(|e| retention(e, now_secs)).unwrap_or(1.0);
            if !include_all && ret < R_MIN {
                return None; // aged out of default recall — never deleted
            }
            r.score *= ret.max(R_MIN);
            Some((r, ret))
        })
        .collect();
    blended.sort_by(|a, b| {
        b.0.score
            .partial_cmp(&a.0.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.id.cmp(&b.0.id))
    });
    blended
}

// ── Reinforcement ──

/// Bump `access_count` + `last_accessed` for every entry in `ids` — called
/// once per search with the ids that were actually returned. The caller
/// persists (ONE write per search, batched with any embedding backfill);
/// the return value says whether anything changed.
pub fn reinforce(mem: &mut ProjectMemory, ids: &[String], now_secs: u64) -> usize {
    if ids.is_empty() {
        return 0;
    }
    let stamp = chrono::DateTime::from_timestamp(now_secs as i64, 0)
        .map(|d| d.to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let mut bumped = 0;
    let sections: [&mut Vec<MemoryEntry>; 4] = [
        &mut mem.conventions,
        &mut mem.gotchas,
        &mut mem.context,
        &mut mem.active_work,
    ];
    for entries in sections {
        for e in entries.iter_mut() {
            if ids.iter().any(|id| id == &e.id) {
                e.access_count = e.access_count.saturating_add(1);
                e.last_accessed = Some(stamp.clone());
                bumped += 1;
            }
        }
    }
    bumped
}

// ── Consolidation ──

/// Why a section was left untouched this cycle.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub enum SkipReason {
    /// Fewer than [`CONSOLIDATE_MIN_LIVE`] live entries.
    BelowThreshold(usize),
    /// No AI provider reachable (typically: no API key) — silent skip,
    /// retried next cycle.
    ModelUnavailable(String),
    /// The model answered but not with a usable JSON array — the section
    /// is left exactly as it was (consolidation never loses data).
    BadReply(String),
}

/// Outcome of one section in a consolidation pass.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SectionConsolidation {
    pub section: &'static str,
    /// Live entries before the pass.
    pub live_before: usize,
    /// Entries removed by compaction (0 when skipped).
    pub compacted: usize,
    /// Set when the section was not compacted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<SkipReason>,
}

/// Canonical name for a consolidatable section (the three compactable
/// ones — active_work is auto-pruned by age instead). None = unknown.
pub fn canonical_section(section: &str) -> Option<&'static str> {
    match section {
        "convention" | "conventions" => Some("conventions"),
        "gotcha" | "gotchas" => Some("gotchas"),
        "context" => Some("context"),
        _ => None,
    }
}

/// The compaction prompt — same contract the on-demand compact always
/// used: N entries in, at most [`CONSOLIDATE_MAX_OUT`] dense one-sentence
/// entries out, strict JSON array of strings.
pub fn consolidation_prompt(section: &str, contents: &[String]) -> String {
    let combined = contents
        .iter()
        .map(|c| format!("- {}", c))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Compress these {} '{}' entries into at most {} dense entries. \
         Each entry should be one clear sentence. Return ONLY a JSON array of strings, nothing else.\n\n{}",
        contents.len(),
        section,
        CONSOLIDATE_MAX_OUT,
        combined
    )
}

/// One consolidation pass over an in-memory store — THE shared code path
/// for `aura memory consolidate`, the on-demand `compact_section`, and the
/// aura-daemon 30-minute loop (which shells out to the CLI verb).
///
/// Per section with ≥ [`CONSOLIDATE_MIN_LIVE`] live entries: ask the model
/// to compress them, replace the LIVE entries with the compacted set, and
/// keep every superseded (W3) row untouched — audit trail survives
/// consolidation. Any model failure skips the section, changing nothing.
/// Returns one report per (selected) section; the caller persists when any
/// `compacted > 0` and stamps `ProjectMemory::consolidated_at`.
pub fn consolidate_mem(
    mem: &mut ProjectMemory,
    only: Option<&str>,
    ai: &dyn Fn(&str) -> Result<String, String>,
    now: u64,
) -> Vec<SectionConsolidation> {
    let mut reports = Vec::new();

    // Split borrows: iterate section-by-section without holding `mem`.
    for name in ["conventions", "gotchas", "context"] {
        if let Some(want) = only {
            if want != name {
                continue;
            }
        }
        let entries: &mut Vec<MemoryEntry> = match name {
            "conventions" => &mut mem.conventions,
            "gotchas" => &mut mem.gotchas,
            _ => &mut mem.context,
        };

        let live_before = entries.iter().filter(|e| e.is_live()).count();
        if live_before < CONSOLIDATE_MIN_LIVE {
            reports.push(SectionConsolidation {
                section: name,
                live_before,
                compacted: 0,
                skipped: Some(SkipReason::BelowThreshold(live_before)),
            });
            continue;
        }

        // W3-aware input: live entries only.
        let live_contents: Vec<String> = entries
            .iter()
            .filter(|e| e.is_live())
            .map(|e| e.content.clone())
            .collect();
        let prompt = consolidation_prompt(name, &live_contents);

        let reply = match ai(&prompt) {
            Ok(r) => r,
            Err(e) => {
                reports.push(SectionConsolidation {
                    section: name,
                    live_before,
                    compacted: 0,
                    skipped: Some(SkipReason::ModelUnavailable(e)),
                });
                continue;
            }
        };

        let json_str = reply
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();
        let mut compressed: Vec<String> = match serde_json::from_str(json_str) {
            Ok(v) => v,
            Err(e) => {
                reports.push(SectionConsolidation {
                    section: name,
                    live_before,
                    compacted: 0,
                    skipped: Some(SkipReason::BadReply(format!(
                        "Failed to parse AI response: {}",
                        e
                    ))),
                });
                continue;
            }
        };
        compressed.truncate(CONSOLIDATE_MAX_OUT);
        // An empty array would silently erase the section's live knowledge
        // — refuse it. Consolidation compresses, it never deletes.
        if compressed.is_empty() {
            reports.push(SectionConsolidation {
                section: name,
                live_before,
                compacted: 0,
                skipped: Some(SkipReason::BadReply(
                    "model returned an empty array — section left untouched".to_string(),
                )),
            });
            continue;
        }

        // Replace LIVE entries with the compacted set; superseded audit
        // rows stay exactly where they were. Compacted entries are derived
        // from many originals, so they carry the commit + write-time stamp
        // only — binding them to one intent row (or one symbol) would
        // fabricate provenance.
        entries.retain(|e| !e.is_live());
        let stamp = provenance::capture();
        for content in &compressed {
            entries.push(MemoryEntry {
                id: format!("mem-{}", &uuid::Uuid::new_v4().to_string()[..8]),
                content: crate::memory::MemoryManager::truncate(content),
                tags: vec!["compacted".to_string()],
                added_by: "aura-compactor".to_string(),
                added_at: now,
                source_commit: stamp.source_commit.clone(),
                valid_from: stamp.valid_from.clone(),
                ..Default::default()
            });
        }

        reports.push(SectionConsolidation {
            section: name,
            live_before,
            compacted: live_before - compressed.len(),
            skipped: None,
        });
    }
    reports
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::retrieval;

    const DAY: u64 = 86_400;
    const NOW: u64 = 1_760_000_000;

    fn entry(id: &str, added_at: u64) -> MemoryEntry {
        MemoryEntry {
            id: id.to_string(),
            content: format!("content for {}", id),
            added_by: "test".to_string(),
            added_at,
            ..Default::default()
        }
    }

    #[test]
    fn fresh_entry_retention_is_one() {
        // n = 0, just written, never accessed: Δt = 0 → R = e^0 = 1.
        let e = entry("mem-fresh", NOW);
        let r = retention(&e, NOW);
        assert!((r - 1.0).abs() < 1e-9, "fresh retention should be ~1.0, got {}", r);
        // A future anchor (clock skew) must not blow up.
        assert!((retention(&e, NOW - 100) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn old_unaccessed_entry_falls_below_floor() {
        // n = 0, w = 0.3 → S = 2.0 · 2.5⁻¹ · 1.3 = 1.04 days.
        // R < 0.05 needs Δt > S·ln(20) ≈ 3.12 days; 10 days is well past.
        let e = entry("mem-old", NOW - 10 * DAY);
        let r = retention(&e, NOW);
        assert!(r < R_MIN, "10-day-old unaccessed entry should decay below R_MIN, got {}", r);
    }

    #[test]
    fn reinforcement_raises_stability_and_retention() {
        assert!(stability_days(1, 0.3) > stability_days(0, 0.3));
        assert!(stability_days(5, 0.3) > stability_days(1, 0.3));
        // Hand-check: n=0 → S0·EF⁻¹·1.3 = 2·0.4·1.3 = 1.04;
        //             n=1 → S0·EF⁰·1.3 = 2.6;  n=2 → 6.5.
        // (1e-6 tolerance: importance is f32, so 0.3 widens to ~0.30000001.)
        assert!((stability_days(0, 0.3) - 1.04).abs() < 1e-6);
        assert!((stability_days(1, 0.3) - 2.6).abs() < 1e-6);
        assert!((stability_days(2, 0.3) - 6.5).abs() < 1e-6);

        // Same age, more reinforcement → higher retention.
        let stale = entry("mem-a", NOW - 3 * DAY);
        let mut reinforced = entry("mem-b", NOW - 3 * DAY);
        reinforced.access_count = 4;
        assert!(retention(&reinforced, NOW) > retention(&stale, NOW));
    }

    #[test]
    fn importance_clamps_up_to_w_min() {
        // Stored 0.0 (legacy zeroed field) behaves exactly like W_MIN.
        assert_eq!(stability_days(0, 0.0), stability_days(0, W_MIN));
        // Above the floor it acts as given.
        assert!(stability_days(0, 0.9) > stability_days(0, W_MIN));
    }

    #[test]
    fn ease_factor_is_clamped() {
        let ef = ease_factor();
        assert!((EF_MIN..=EF_MAX).contains(&ef));
        assert_eq!(ef, 2.5);
    }

    #[test]
    fn last_accessed_moves_the_decay_anchor() {
        // Added long ago but accessed just now → fresh again.
        let mut e = entry("mem-x", NOW - 30 * DAY);
        e.last_accessed = Some(
            chrono::DateTime::from_timestamp(NOW as i64, 0).unwrap().to_rfc3339(),
        );
        assert!((retention(&e, NOW) - 1.0).abs() < 1e-9);
        // Garbage last_accessed falls back to added_at.
        e.last_accessed = Some("not-a-timestamp".to_string());
        assert!(retention(&e, NOW) < R_MIN);
    }

    #[test]
    fn blend_flips_order_for_stale_vs_fresh_pair() {
        // Stale entry has the HIGHER RRF score but only ~0.146 retention
        // (2 days, n=0, w=0.3 → S=1.04 → e^(−2/1.04)); fresh entry's lower
        // RRF wins after the blend.
        let mut mem = ProjectMemory::default();
        mem.context.push(entry("mem-stale", NOW - 2 * DAY));
        mem.context.push(entry("mem-fresh", NOW));

        let ranked = vec![
            RankedResult {
                section: "context",
                id: "mem-stale".into(),
                content: "s".into(),
                tags: vec![],
                added_at: NOW - 2 * DAY,
                score: 0.04,
                legs: vec!["lexical"],
            },
            RankedResult {
                section: "context",
                id: "mem-fresh".into(),
                content: "f".into(),
                tags: vec![],
                added_at: NOW,
                score: 0.03,
                legs: vec!["lexical"],
            },
        ];
        let blended = blend_results(ranked, &mem, NOW, false);
        assert_eq!(blended.len(), 2);
        assert_eq!(blended[0].0.id, "mem-fresh", "fresh entry must outrank stale after blend");
        assert_eq!(blended[1].0.id, "mem-stale");
        // score = rrf × max(R, R_MIN)
        assert!((blended[0].0.score - 0.03).abs() < 1e-9);
        let r_stale = blended[1].1;
        assert!((blended[1].0.score - 0.04 * r_stale.max(R_MIN)).abs() < 1e-12);
    }

    #[test]
    fn decayed_entries_drop_from_default_but_survive_in_all() {
        let mut mem = ProjectMemory::default();
        mem.context.push(entry("mem-dead", NOW - 10 * DAY)); // R << R_MIN
        mem.context.push(entry("mem-live", NOW));

        let ranked = || {
            vec![
                RankedResult {
                    section: "context",
                    id: "mem-dead".into(),
                    content: "d".into(),
                    tags: vec![],
                    added_at: NOW - 10 * DAY,
                    score: 0.05,
                    legs: vec!["lexical"],
                },
                RankedResult {
                    section: "context",
                    id: "mem-live".into(),
                    content: "l".into(),
                    tags: vec![],
                    added_at: NOW,
                    score: 0.02,
                    legs: vec!["lexical"],
                },
            ]
        };

        let default_mode = blend_results(ranked(), &mem, NOW, false);
        assert_eq!(default_mode.len(), 1, "decayed-out entry must leave default results");
        assert_eq!(default_mode[0].0.id, "mem-live");

        let all_mode = blend_results(ranked(), &mem, NOW, true);
        assert_eq!(all_mode.len(), 2, "--all keeps decayed entries");
        // Floor applies: dead entry's score is rrf × R_MIN, not rrf × ~0.
        let dead = all_mode.iter().find(|(r, _)| r.id == "mem-dead").unwrap();
        assert!((dead.0.score - 0.05 * R_MIN).abs() < 1e-12);
    }

    #[test]
    fn reinforce_bumps_count_and_anchor_for_returned_ids_only() {
        let mut mem = ProjectMemory::default();
        mem.context.push(entry("mem-hit", NOW - DAY));
        mem.gotchas.push(entry("mem-hit2", NOW - DAY));
        mem.context.push(entry("mem-miss", NOW - DAY));

        let n = reinforce(&mut mem, &["mem-hit".into(), "mem-hit2".into()], NOW);
        assert_eq!(n, 2);
        let hit = mem.context.iter().find(|e| e.id == "mem-hit").unwrap();
        assert_eq!(hit.access_count, 1);
        assert!(hit.last_accessed.is_some());
        let hit2 = mem.gotchas.iter().find(|e| e.id == "mem-hit2").unwrap();
        assert_eq!(hit2.access_count, 1);
        let miss = mem.context.iter().find(|e| e.id == "mem-miss").unwrap();
        assert_eq!(miss.access_count, 0);
        assert!(miss.last_accessed.is_none());

        assert_eq!(reinforce(&mut mem, &[], NOW), 0);
    }

    // ── Consolidation ──

    fn fake_ai(out: &'static [&'static str]) -> impl Fn(&str) -> Result<String, String> {
        move |_p: &str| Ok(serde_json::to_string(out).unwrap())
    }

    #[test]
    fn consolidate_respects_live_threshold() {
        let mut mem = ProjectMemory::default();
        for i in 0..9 {
            mem.context.push(entry(&format!("mem-{}", i), NOW));
        }
        let reports = consolidate_mem(&mut mem, Some("context"), &fake_ai(&["a"]), NOW);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].skipped, Some(SkipReason::BelowThreshold(9)));
        assert_eq!(mem.context.len(), 9, "below threshold — untouched");

        mem.context.push(entry("mem-9", NOW));
        let reports =
            consolidate_mem(&mut mem, Some("context"), &fake_ai(&["a", "b", "c"]), NOW);
        assert_eq!(reports[0].skipped, None);
        assert_eq!(reports[0].live_before, 10);
        assert_eq!(reports[0].compacted, 7);
        assert_eq!(mem.context.len(), 3);
        assert!(mem.context.iter().all(|e| e.added_by == "aura-compactor"));
    }

    #[test]
    fn consolidation_excludes_and_preserves_superseded_rows() {
        let mut mem = ProjectMemory::default();
        // 8 live + 4 superseded: live count is below threshold → skip,
        // even though the raw section holds 12 rows.
        for i in 0..8 {
            mem.context.push(entry(&format!("mem-l{}", i), NOW));
        }
        for i in 0..4 {
            let mut e = entry(&format!("mem-s{}", i), NOW);
            e.valid_to = Some("2026-06-11T00:00:00+00:00".to_string());
            mem.context.push(e);
        }
        let reports = consolidate_mem(&mut mem, Some("context"), &fake_ai(&["x"]), NOW);
        assert_eq!(reports[0].skipped, Some(SkipReason::BelowThreshold(8)));
        assert_eq!(mem.context.len(), 12);

        // Add 2 more live → 10 live + 4 superseded. Compaction replaces
        // the live ones and the audit rows survive verbatim.
        mem.context.push(entry("mem-l8", NOW));
        mem.context.push(entry("mem-l9", NOW));
        let reports = consolidate_mem(&mut mem, Some("context"), &fake_ai(&["x", "y"]), NOW);
        assert_eq!(reports[0].skipped, None);
        assert_eq!(reports[0].compacted, 8);
        assert_eq!(mem.context.len(), 2 + 4);
        let superseded: Vec<&MemoryEntry> =
            mem.context.iter().filter(|e| !e.is_live()).collect();
        assert_eq!(superseded.len(), 4, "superseded audit rows must survive consolidation");
        assert!(superseded.iter().all(|e| e.id.starts_with("mem-s")));
    }

    #[test]
    fn consolidate_keyless_skips_silently_without_touching_entries() {
        let mut mem = ProjectMemory::default();
        for i in 0..12 {
            mem.gotchas.push(entry(&format!("mem-{}", i), NOW));
        }
        let no_ai = |_p: &str| -> Result<String, String> { Err("No API key found".into()) };
        let reports = consolidate_mem(&mut mem, None, &no_ai, NOW);
        // All three sections reported; gotchas skipped for the model, the
        // empty ones for the threshold.
        assert_eq!(reports.len(), 3);
        let gotchas = reports.iter().find(|r| r.section == "gotchas").unwrap();
        assert!(matches!(gotchas.skipped, Some(SkipReason::ModelUnavailable(_))));
        assert_eq!(mem.gotchas.len(), 12, "keyless cycle must change nothing");
    }

    #[test]
    fn consolidate_rejects_empty_or_garbage_replies() {
        let mut mem = ProjectMemory::default();
        for i in 0..10 {
            mem.context.push(entry(&format!("mem-{}", i), NOW));
        }
        let empty = |_p: &str| -> Result<String, String> { Ok("[]".into()) };
        let reports = consolidate_mem(&mut mem, Some("context"), &empty, NOW);
        assert!(matches!(reports[0].skipped, Some(SkipReason::BadReply(_))));
        assert_eq!(mem.context.len(), 10);

        let garbage = |_p: &str| -> Result<String, String> { Ok("here you go!".into()) };
        let reports = consolidate_mem(&mut mem, Some("context"), &garbage, NOW);
        assert!(matches!(reports[0].skipped, Some(SkipReason::BadReply(_))));
        assert_eq!(mem.context.len(), 10);
    }

    #[test]
    fn canonical_section_maps_aliases() {
        assert_eq!(canonical_section("convention"), Some("conventions"));
        assert_eq!(canonical_section("gotchas"), Some("gotchas"));
        assert_eq!(canonical_section("context"), Some("context"));
        assert_eq!(canonical_section("active_work"), None);
        assert_eq!(canonical_section("nope"), None);
    }

    #[test]
    fn legacy_json_defaults_decay_fields() {
        let legacy = r#"{"id":"mem-old","content":"c","tags":[],"added_by":"x","added_at":5}"#;
        let e: MemoryEntry = serde_json::from_str(legacy).unwrap();
        assert_eq!(e.access_count, 0);
        assert!((e.importance - 0.3).abs() < 1e-6);
        assert!(e.last_accessed.is_none());
        // And the decay math treats it sanely (anchor = added_at).
        assert!(retention(&e, 5) > 0.99);
    }

    #[test]
    fn superseded_w3_rows_never_reach_consolidation_input_via_default_ranking() {
        // Belt-and-braces: the ranked search feeding recall is live-only,
        // and consolidate_mem's input filter is live-only — a superseded
        // row can't sneak into either.
        let mut mem = ProjectMemory::default();
        let mut closed = entry("mem-closed", NOW);
        closed.content = "shared vocabulary token".into();
        closed.valid_to = Some("2026-06-11T00:00:00+00:00".into());
        mem.context.push(closed);
        let results = retrieval::ranked_search(&mem, "vocabulary", None);
        assert!(results.is_empty());
    }
}
