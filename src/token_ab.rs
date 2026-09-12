//! Token A/B dashboard — measured with/without-Aura provider telemetry.
//!
//! Reads the raw JSONL produced by `scripts/token-ab.sh` (each line one
//! `claude -p --output-format json` run: the provider's own `usage` block,
//! cost and turn count — never an estimate) and reports p50/p95 input-token
//! and cost deltas by task class and repository size, plus per-arm answer
//! accuracy. Pairs with a failed run on either side are excluded and the
//! exclusion is disclosed — a truncated run's token count would understate
//! the arm that failed, so it is never averaged in silently.
//!
//! Sign convention: delta = plain − aura, so a POSITIVE delta means the
//! Aura arm consumed fewer input tokens (or less cost) than the plain arm.

use colored::Colorize;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct RawRun {
    id: String,
    arm: String,
    class: String,
    size: String,
    #[serde(default)]
    run_error: bool,
    #[serde(default)]
    expect_hit: Option<bool>,
    #[serde(default)]
    result: Option<RunResult>,
}

#[derive(Deserialize)]
struct RunResult {
    #[serde(default)]
    usage: Option<Usage>,
    #[serde(default)]
    total_cost_usd: Option<f64>,
    #[serde(default)]
    num_turns: Option<u64>,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
}

/// One question measured on both arms, both runs clean.
struct Pair {
    class: String,
    size: String,
    /// plain − aura, total input tokens (fresh + cache creation + cache
    /// read — everything the provider billed as input).
    delta_input: i64,
    /// plain − aura, USD.
    delta_cost: f64,
    /// plain − aura, agent turns.
    delta_turns: i64,
    aura_hit: bool,
    plain_hit: bool,
}

fn total_input(u: &Usage) -> u64 {
    u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
}

/// Nearest-rank percentile (q in 0..=100) over an unsorted slice.
/// n must be > 0; rank = ceil(q/100 · n), 1-based.
fn percentile(values: &[i64], q: u32) -> i64 {
    let mut v = values.to_vec();
    v.sort_unstable();
    let n = v.len();
    let rank = ((q as f64 / 100.0) * n as f64).ceil() as usize;
    v[rank.max(1) - 1]
}

fn percentile_f(values: &[f64], q: u32) -> f64 {
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    let rank = ((q as f64 / 100.0) * n as f64).ceil() as usize;
    v[rank.max(1) - 1]
}

/// Pair up raw runs by question id. Returns the clean pairs plus how many
/// questions were dropped (a run errored / truncated on either arm, or an
/// arm is missing entirely).
fn build_pairs(runs: &[RawRun]) -> (Vec<Pair>, usize) {
    let mut by_id: BTreeMap<&str, (Option<&RawRun>, Option<&RawRun>)> = BTreeMap::new();
    for r in runs {
        let slot = by_id.entry(r.id.as_str()).or_default();
        match r.arm.as_str() {
            "aura" => slot.0 = Some(r),
            "plain" => slot.1 = Some(r),
            _ => {}
        }
    }
    let mut pairs = Vec::new();
    let mut dropped = 0usize;
    for (_, (aura, plain)) in by_id {
        let (Some(a), Some(p)) = (aura, plain) else {
            dropped += 1;
            continue;
        };
        let clean = |r: &RawRun| -> Option<(u64, f64, u64)> {
            if r.run_error {
                return None;
            }
            let res = r.result.as_ref()?;
            let usage = res.usage.as_ref()?;
            Some((
                total_input(usage),
                res.total_cost_usd.unwrap_or(0.0),
                res.num_turns.unwrap_or(0),
            ))
        };
        match (clean(a), clean(p)) {
            (Some((ai, ac, at)), Some((pi, pc, pt))) => pairs.push(Pair {
                class: a.class.clone(),
                size: a.size.clone(),
                delta_input: pi as i64 - ai as i64,
                delta_cost: pc - ac,
                delta_turns: pt as i64 - at as i64,
                aura_hit: a.expect_hit.unwrap_or(false),
                plain_hit: p.expect_hit.unwrap_or(false),
            }),
            _ => dropped += 1,
        }
    }
    (pairs, dropped)
}

fn group_line(label: &str, pairs: &[&Pair]) -> String {
    let inputs: Vec<i64> = pairs.iter().map(|p| p.delta_input).collect();
    let costs: Vec<f64> = pairs.iter().map(|p| p.delta_cost).collect();
    let turns: Vec<i64> = pairs.iter().map(|p| p.delta_turns).collect();
    let ah = pairs.iter().filter(|p| p.aura_hit).count();
    let ph = pairs.iter().filter(|p| p.plain_hit).count();
    let n = pairs.len();
    format!(
        "  {label:<8} n={n:<3} Δinput p50 {:>10} p95 {:>10}   Δcost p50 {:>8} p95 {:>8}   Δturns p50 {:>4}   hits aura {ah}/{n} plain {ph}/{n}",
        fmt_tokens(percentile(&inputs, 50)),
        fmt_tokens(percentile(&inputs, 95)),
        format!("${:+.3}", percentile_f(&costs, 50)),
        format!("${:+.3}", percentile_f(&costs, 95)),
        format!("{:+}", percentile(&turns, 50)),
    )
}

fn fmt_tokens(v: i64) -> String {
    if v.abs() >= 10_000 {
        format!("{:+.1}k", v as f64 / 1000.0)
    } else {
        format!("{v:+}")
    }
}

fn render(pairs: &[Pair], dropped: usize, total_questions: usize) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "{}\n",
        "TOKEN A/B — measured provider telemetry (plain − aura; positive = Aura arm used less)"
            .bold()
    ));
    out.push_str(&format!(
        "  {} clean pairs of {} questions; {} question(s) excluded (a run errored, was truncated, or an arm is missing — its tokens would understate the failing arm).\n",
        pairs.len(),
        total_questions,
        dropped
    ));
    if pairs.is_empty() {
        out.push_str("  No clean pairs — nothing to report.\n");
        return out;
    }
    let mut section = |title: &str, key: &dyn Fn(&Pair) -> &str| {
        out.push_str(&format!("\n{}\n", title.bold()));
        let mut groups: BTreeMap<&str, Vec<&Pair>> = BTreeMap::new();
        for p in pairs {
            groups.entry(key(p)).or_default().push(p);
        }
        for (label, members) in groups {
            out.push_str(&group_line(label, &members));
            out.push('\n');
        }
    };
    section("BY TASK CLASS", &|p: &Pair| p.class.as_str());
    section("BY REPO SIZE", &|p: &Pair| p.size.as_str());
    let all: Vec<&Pair> = pairs.iter().collect();
    out.push_str(&format!("\n{}\n", "OVERALL".bold()));
    out.push_str(&group_line("all", &all));
    out.push('\n');
    out.push_str(
        "\n  Every number above is the provider's own measured usage/cost from the recorded runs — nothing is estimated.\n",
    );
    out
}

/// Entry point for `aura token-ab --data <raw.jsonl>`.
pub fn run(data_path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let text = std::fs::read_to_string(data_path)?;
    let mut runs = Vec::new();
    let mut unparsed = 0usize;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<RawRun>(line) {
            Ok(r) => runs.push(r),
            Err(_) => unparsed += 1,
        }
    }
    let total_questions = {
        let mut ids: Vec<&str> = runs.iter().map(|r| r.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        ids.len()
    };
    let (pairs, dropped) = build_pairs(&runs);
    print!("{}", render(&pairs, dropped, total_questions));
    if unparsed > 0 {
        eprintln!("warning: {unparsed} line(s) did not parse and were ignored");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_json(id: &str, arm: &str, err: bool, input: u64, cost: f64, hit: bool) -> String {
        format!(
            r#"{{"schema":1,"id":"{id}","arm":"{arm}","class":"locate","size":"small","crate":"c","model":"m","run_error":{err},"exit_code":0,"expect":["x"],"expect_hit":{hit},"result":{{"usage":{{"input_tokens":{input},"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":10}},"total_cost_usd":{cost},"num_turns":5,"is_error":{err}}}}}"#
        )
    }

    fn parse(lines: &[String]) -> Vec<RawRun> {
        lines
            .iter()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn nearest_rank_percentile() {
        // n=1: every percentile is the single value.
        assert_eq!(percentile(&[7], 50), 7);
        assert_eq!(percentile(&[7], 95), 7);
        // n=4 sorted [1,2,3,4]: p50 rank=ceil(2)=2 → 2; p95 rank=ceil(3.8)=4 → 4.
        assert_eq!(percentile(&[4, 1, 3, 2], 50), 2);
        assert_eq!(percentile(&[4, 1, 3, 2], 95), 4);
        // p100 stays in bounds.
        assert_eq!(percentile(&[4, 1, 3, 2], 100), 4);
    }

    #[test]
    fn pairing_signs_and_hits() {
        let lines = vec![
            run_json("q1", "aura", false, 1_000, 0.01, true),
            run_json("q1", "plain", false, 5_000, 0.05, false),
        ];
        let (pairs, dropped) = build_pairs(&parse(&lines));
        assert_eq!(dropped, 0);
        assert_eq!(pairs.len(), 1);
        // plain − aura: positive means Aura used less.
        assert_eq!(pairs[0].delta_input, 4_000);
        assert!((pairs[0].delta_cost - 0.04).abs() < 1e-9);
        assert!(pairs[0].aura_hit);
        assert!(!pairs[0].plain_hit);
    }

    #[test]
    fn errored_and_incomplete_pairs_are_dropped_not_averaged() {
        let lines = vec![
            // q1: aura errored (e.g. max-turns truncation) — the pair must
            // not enter the stats even though its usage parsed.
            run_json("q1", "aura", true, 1_000_000, 0.25, false),
            run_json("q1", "plain", false, 5_000, 0.05, true),
            // q2: clean pair.
            run_json("q2", "aura", false, 2_000, 0.02, true),
            run_json("q2", "plain", false, 3_000, 0.03, true),
            // q3: plain arm missing entirely.
            run_json("q3", "aura", false, 2_000, 0.02, true),
        ];
        let (pairs, dropped) = build_pairs(&parse(&lines));
        assert_eq!(pairs.len(), 1);
        assert_eq!(dropped, 2);
        assert_eq!(pairs[0].delta_input, 1_000);
    }

    #[test]
    fn report_is_labeled_measured_never_estimated() {
        let lines = vec![
            run_json("q1", "aura", false, 1_000, 0.01, true),
            run_json("q1", "plain", false, 5_000, 0.05, true),
        ];
        let (pairs, dropped) = build_pairs(&parse(&lines));
        let report = render(&pairs, dropped, 1);
        assert!(report.contains("measured"));
        // The only place "estimated" may appear is the explicit disclaimer
        // that nothing is — no value is ever presented as an estimate.
        assert!(report.contains("nothing is estimated"));
        assert_eq!(report.to_lowercase().matches("estimat").count(), 1);
        // Exclusions are disclosed even when zero.
        assert!(report.contains("0 question(s) excluded"));
    }
}
