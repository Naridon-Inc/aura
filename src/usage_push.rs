//! `aura usage --push` — send this laptop's model spend to the org's meter.
//!
//! The cloud has kept a per-member spend ledger for a while
//! (`POST /api/v1/billing/usage/tokens`, read back by
//! `GET /api/v1/billing/usage/by_member`), and it had no client. So the
//! console's Cost page truthfully answered `$0.00` for a team burning real
//! money every day: the server only ever metered calls it proxied itself, and
//! nobody proxies their agent CLI through Aura.
//!
//! This is the missing half. The spend is already on disk — Claude Code writes
//! every turn's model and token counts into `~/.claude/projects/*/*.jsonl`, and
//! [`crate::plan_tracker`] has read that file format for as long as
//! `aura usage --plan` has existed. All that was missing was carrying the
//! numbers to the org.
//!
//! ## What gets sent, and what does not
//!
//! One row per (calendar day, model) — never a prompt, a path, a project name
//! or a transcript line. The whole payload is "on this day, this model cost
//! this much", which is the least a cost meter can work with.
//!
//! Today is never sent. The server's ledger is append-only and deduplicates on
//! the reporter's `external_id` (`ON CONFLICT DO NOTHING`), so a bucket that
//! can still grow would freeze at whatever it happened to be when it was first
//! pushed. A day that has ended cannot grow, which makes it the smallest bucket
//! that is safe to report.
//!
//! ## Why re-running is free
//!
//! `external_id` is `claude-code:<day>:<model>`, stable across runs and scoped
//! server-side to (org, member), so a second push of the same window collapses
//! into `duplicate` instead of double-charging. There is deliberately no local
//! watermark file to get out of sync: the client is dumb and re-sends its
//! window, and the server is the one place that decides what it already has.

use crate::plan_tracker::{self, DailyModelSpend};

/// Most buckets in one request. The server caps a push at 500 entries, and a
/// window of days across a handful of models is far below that — this is the
/// guard for someone passing an absurd `--since`, not a normal path.
const MAX_ENTRIES: usize = 500;

/// How far back a push looks by default. Long enough to heal a laptop that was
/// offline for a week, short enough that the everyday push is a few rows.
/// Buckets per request. The shared cloud client gives every call ten seconds
/// and the ingest endpoint inserts one row at a time, so the request has to be
/// sized by what the server can finish rather than by what the wire can hold.
/// Twenty is comfortably inside that budget for a round trip to the cloud.
const CHUNK_ENTRIES: usize = 20;

pub const DEFAULT_WINDOW_DAYS: u64 = 14;

/// What the server said it did with the push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushOutcome {
    pub recorded: usize,
    pub duplicate: usize,
    pub rejected: usize,
    pub developer_id: String,
}

/// Turn the day/model rollup into the wire shape the meter accepts.
///
/// Split from the request so the mapping — which is the part with rules — can
/// be tested without a server. `cost_usd` is sent explicitly rather than left
/// to the server to price, so the figure in the console matches the one
/// `aura usage --plan` prints on this machine.
pub fn entries_for(spend: &[DailyModelSpend]) -> Vec<serde_json::Value> {
    spend
        .iter()
        .filter(|d| d.input_tokens > 0 || d.output_tokens > 0)
        .take(MAX_ENTRIES)
        .map(|d| {
            serde_json::json!({
                "provider": "anthropic",
                "model": d.model,
                "tokens_in": d.input_tokens,
                "tokens_out": d.output_tokens,
                "cost_usd": (d.estimated_cost * 1_000_000.0).round() / 1_000_000.0,
                "external_id": format!("claude-code:{}:{}", d.date, d.model),
                "occurred_at": d.occurred_at,
            })
        })
        .collect()
}

/// Read the local transcripts, roll them up, and hand the result to the org's
/// meter. Returns what the server recorded so the caller can print it.
pub fn push(window_days: u64) -> Result<(PushOutcome, usize), String> {
    let (cloud_url, token) = crate::recall_cloud_creds()?;
    let spend = plan_tracker::daily_model_spend(window_days.saturating_mul(86_400));
    let entries = entries_for(&spend);
    if entries.is_empty() {
        return Ok((
            PushOutcome {
                recorded: 0,
                duplicate: 0,
                rejected: 0,
                developer_id: String::new(),
            },
            0,
        ));
    }

    let url = format!(
        "{}/api/v1/billing/usage/tokens",
        cloud_url.trim_end_matches('/')
    );
    let client = crate::cloud_http_client();

    // Sent in chunks because the shared cloud client times out at ten seconds
    // and the server writes one row per entry: a laptop with a couple of months
    // of history sends enough buckets to run past that and fail the whole push,
    // which is what a 30-day window did before this. Chunking bounds the
    // request time by the chunk rather than by how much history exists.
    //
    // A chunk that fails does not throw away the chunks before it — those rows
    // are already in the ledger, and `external_id` makes re-sending them free —
    // so the honest thing is to report what landed and name what did not,
    // rather than to claim the whole push failed.
    let mut total = PushOutcome {
        recorded: 0,
        duplicate: 0,
        rejected: 0,
        developer_id: String::new(),
    };
    let mut sent = 0usize;

    for chunk in entries.chunks(CHUNK_ENTRIES) {
        let body = serde_json::json!({ "entries": chunk });
        let resp = match crate::recall_post(&client, &url, &token, &body) {
            Ok(r) => r,
            Err(e) if sent > 0 => {
                return Err(format!(
                    "{} — {} of {} rows were reported before this and are already saved; \
                     re-run to send the rest",
                    e,
                    sent,
                    entries.len()
                ))
            }
            Err(e) => return Err(e),
        };
        total.recorded += resp.get("recorded").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        total.duplicate += resp.get("duplicate").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        total.rejected += resp.get("rejected").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        if total.developer_id.is_empty() {
            total.developer_id = resp
                .get("developer_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
        }
        sent += chunk.len();
    }

    Ok((total, sent))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(date: &str, model: &str, input: u64, output: u64, cost: f64) -> DailyModelSpend {
        DailyModelSpend {
            date: date.to_string(),
            model: model.to_string(),
            messages: 1,
            input_tokens: input,
            output_tokens: output,
            occurred_at: 1_700_000_000,
            estimated_cost: cost,
        }
    }

    /// A long history has to arrive in pieces the server can finish inside the
    /// client's timeout, so the chunk size is part of the contract rather than
    /// an implementation detail — a request built from more buckets than this
    /// is the failure `--push-days 30` used to hit.
    #[test]
    fn a_long_window_is_split_into_requests_the_server_can_finish() {
        let spend: Vec<DailyModelSpend> = (1..=45)
            .map(|d| day(&format!("2026-07-{:02}", d % 28 + 1), &format!("m{d}"), 1, 1, 0.1))
            .collect();
        let entries = entries_for(&spend);
        assert_eq!(entries.len(), 45);
        let chunks: Vec<_> = entries.chunks(CHUNK_ENTRIES).collect();
        assert_eq!(chunks.len(), 3, "45 buckets is three requests, not one");
        assert!(chunks.iter().all(|c| c.len() <= CHUNK_ENTRIES));
        // Nothing is dropped on the way into the chunks.
        assert_eq!(chunks.iter().map(|c| c.len()).sum::<usize>(), entries.len());
    }

    /// The id is what makes a re-push free, so it has to be derived from the
    /// bucket and nothing else — no clock, no counter, no run id.
    #[test]
    fn the_external_id_is_stable_for_a_bucket() {
        let a = entries_for(&[day("2026-08-19", "opus-5", 10, 20, 1.5)]);
        let b = entries_for(&[day("2026-08-19", "opus-5", 10, 20, 1.5)]);
        assert_eq!(a[0]["external_id"], b[0]["external_id"]);
        assert_eq!(a[0]["external_id"], "claude-code:2026-08-19:opus-5");
    }

    /// Two models on one day are two rows. Collapsing them would lose the "on
    /// which model" half of the answer the meter exists to give.
    #[test]
    fn a_day_with_two_models_is_two_entries() {
        let out = entries_for(&[
            day("2026-08-19", "opus-5", 10, 20, 1.5),
            day("2026-08-19", "sonnet-5", 5, 5, 0.1),
        ]);
        assert_eq!(out.len(), 2);
        assert_ne!(out[0]["external_id"], out[1]["external_id"]);
    }

    /// A bucket with no tokens would be rejected by the server anyway; sending
    /// it just spends a row of the request cap.
    #[test]
    fn empty_buckets_are_not_sent() {
        assert!(entries_for(&[day("2026-08-19", "opus-5", 0, 0, 0.0)]).is_empty());
    }

    /// The push carries usage, not content. If a field ever appears here that
    /// names a project, a path or a prompt, this is the test that should stop
    /// it — the meter has never needed one to add up a bill.
    #[test]
    fn the_payload_carries_no_content() {
        let out = entries_for(&[day("2026-08-19", "opus-5", 10, 20, 1.5)]);
        let obj = out[0].as_object().expect("an entry is an object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "cost_usd",
                "external_id",
                "model",
                "occurred_at",
                "provider",
                "tokens_in",
                "tokens_out"
            ]
        );
    }
}
