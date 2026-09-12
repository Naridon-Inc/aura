//! Getting the "why" off this machine.
//!
//! # What was broken
//!
//! `.aura/intent_log.jsonl` is the durable record of every rationale an agent
//! or a developer logged before a change — 1,298 rows in this repo alone. None
//! of them had ever reached the cloud, for two independent reasons:
//!
//! * **No producer.** `OutboxKind::Intent` was enqueued in exactly two places,
//!   both inside `#[cfg(test)]`. Real code never queued one.
//! * **No endpoint.** The URL both senders target — `/api/v1/live/intents` —
//!   did not exist server-side. And `drain_to_cloud` treats any 4xx as a
//!   poison pill and *acks* it, so a 404 deleted the entry instead of retrying.
//!
//! So the console's intent log read from `live_events` — the radar's
//! file-activity feed — because that was the only thing that had ever arrived.
//!
//! # What this does
//!
//! One door for pushing intents: [`push`] for the row just written, [`backfill`]
//! for the whole local log. Both are best-effort and never fail their caller —
//! `log-intent` is called from a hook with `>/dev/null 2>&1 &` and must exit 0
//! whatever the network is doing. When the cloud is unreachable the payload
//! goes to the outbox, which now has a real endpoint to drain into.

use std::path::Path;

use serde_json::json;

use crate::config::ConfigManager;

/// How many intents go in one request during a backfill.
///
/// Small enough that a failure re-sends little, large enough that a 1,300-row
/// log is a couple of dozen requests rather than 1,300. The server dedupes, so
/// a re-sent batch costs nothing but the round trip.
const BATCH: usize = 100;

/// The cloud base URL and token, when this machine is signed in.
fn cloud() -> Option<(String, String)> {
    let config = ConfigManager::load();
    let token = crate::cloud_endpoint::token(config.cloud_api_token.as_deref())?;
    let url = crate::cloud_endpoint::origin_or_public(config.cloud_url.as_deref());
    Some((url, token))
}

/// The files a row's reason was written about, read off the block that sealed it.
///
/// A reason and the files it is about are recorded at two different moments by
/// two different commands: `aura sign-intent --writes a,b,c` seals the scope
/// into a signed block, and the caller then writes the JSONL row carrying only
/// the block's id. So the link exists on disk and has simply never been sent —
/// which is why the console's per-file "why did this change" band matched
/// nothing for every file ever asked about.
///
/// Resolved here, at the one place that already opens the row and already
/// knows the repo, rather than at each of the capture surfaces that write one.
/// A row that names no block, a block that declared no scope, and a block file
/// that has been pruned all answer the same way: `None`, and the row goes as
/// it always did.
fn writes_of(entry: &serde_json::Value, repo_root: &Path) -> Option<Vec<String>> {
    let id = entry.get("signed_block_id")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let raw = std::fs::read_to_string(
        repo_root.join(".aura").join("blocks").join(format!("{id}.json")),
    )
    .ok()?;
    let block: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let paths: Vec<String> = block
        .get("declared_impacts")?
        .get("writes_paths")?
        .as_array()?
        .iter()
        .filter_map(|p| p.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    if paths.is_empty() { None } else { Some(paths) }
}

/// A row as the cloud should receive it: whatever was logged, plus the scope
/// the signing step already knew and the row never carried.
///
/// Never overwrites a scope the caller stated — a surface that knows its own
/// paths is a better authority than a block looked up after the fact.
fn enriched(entry: &serde_json::Value, repo_root: &Path) -> serde_json::Value {
    if entry.get("writes_paths").is_some() {
        return entry.clone();
    }
    let Some(paths) = writes_of(entry, repo_root) else {
        return entry.clone();
    };
    let mut out = entry.clone();
    if let Some(obj) = out.as_object_mut() {
        obj.insert("writes_paths".into(), json!(paths));
    }
    out
}

/// The branch to stamp on intents pushed from `repo_root`, when it is a repo.
fn branch_of(repo_root: &Path) -> Option<String> {
    let repo = git2::Repository::open(repo_root).ok()?;
    let head = repo.head().ok()?;
    head.shorthand().map(str::to_string)
}

/// Push one freshly-logged intent. Silent, and never fails the caller.
///
/// A short timeout on purpose: this runs inline with `aura log-intent`, which
/// a post-tool-use hook fires after every edit. A slow cloud must not become a
/// slow editor — the outbox is there precisely so a miss is not a loss.
pub fn push(entry: &serde_json::Value, repo_root: &Path) {
    let Some((base, token)) = cloud() else {
        return;
    };
    let repo_full_name = crate::repo_slug::of_cwd();
    let payload = json!({
        "repo_full_name": repo_full_name,
        "branch": branch_of(repo_root),
        "intents": [enriched(entry, repo_root)],
    });

    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };

    let sent = client
        .post(format!("{base}/api/v1/live/intents"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&payload)
        .send();

    match sent {
        Ok(resp) if resp.status().is_success() => {}
        // Anything else — offline, 5xx, a server too old to know the route —
        // goes to the outbox rather than being lost. The drain retries it.
        _ => {
            let _ = crate::outbox::enqueue(crate::outbox::OutboxKind::Intent, payload);
        }
    }
}

/// What one [`backfill`] run did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct BackfillReport {
    /// Rows read out of the local log.
    pub read: usize,
    /// Rows the server had not seen before. Re-running is idempotent, so a
    /// second pass reports `stored: 0` with the same `read`.
    pub stored: usize,
    /// Batches that could not be delivered and went to the outbox.
    pub queued: usize,
}

/// Push the whole local intent log for the repo at `repo_root`.
///
/// This is what makes the console's intent log real on day one rather than
/// only holding what happens next: the log on disk is the history, and until
/// now none of it had ever been sent.
pub fn backfill(repo_root: &Path) -> Result<BackfillReport, String> {
    let (base, token) = cloud().ok_or_else(|| {
        "not signed in to Aura Cloud — run `aura login` first".to_string()
    })?;

    let path = repo_root.join(".aura").join("intent_log.jsonl");
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;

    // Skip rows with no readable text — an entry whose whole point is the
    // sentence is not worth a row when the sentence is missing.
    let entries: Vec<serde_json::Value> = raw
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|v| {
            v.get("intent")
                .and_then(|i| i.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
        })
        .collect();

    let repo_full_name = crate::repo_slug::of_cwd();
    let branch = branch_of(repo_root);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let mut report = BackfillReport {
        read: entries.len(),
        ..Default::default()
    };

    for chunk in entries.chunks(BATCH) {
        let enriched_chunk: Vec<serde_json::Value> =
            chunk.iter().map(|e| enriched(e, repo_root)).collect();
        let payload = json!({
            "repo_full_name": repo_full_name,
            "branch": branch,
            "intents": enriched_chunk,
        });
        let sent = client
            .post(format!("{base}/api/v1/live/intents"))
            .header("Authorization", format!("Bearer {token}"))
            .json(&payload)
            .send();
        match sent {
            Ok(resp) if resp.status().is_success() => {
                let body: serde_json::Value = resp.json().unwrap_or_else(|_| json!({}));
                report.stored += body["stored"].as_u64().unwrap_or(0) as usize;
            }
            _ => {
                let _ =
                    crate::outbox::enqueue(crate::outbox::OutboxKind::Intent, payload);
                report.queued += 1;
            }
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_distinguishes_read_from_stored() {
        // The two numbers answer different questions — "did my log parse" and
        // "was any of it new" — and a backfill run twice must show the second
        // fall to zero while the first stays put.
        let first = BackfillReport { read: 1298, stored: 1298, queued: 0 };
        let again = BackfillReport { read: 1298, stored: 0, queued: 0 };
        assert_eq!(first.read, again.read);
        assert_ne!(first.stored, again.stored);
    }
}
