//! What an API key has cost, since the day it was added, across every project.
//!
//! The repo-local usage ledger (`aura usage-record`) answers "what did THIS
//! project spend". It can't answer the question people actually worry about
//! when they paste a key into an app — "what is this key costing me, total?"
//! — because the spend is scattered across every checkout the key was used
//! in. So this ledger is deliberately GLOBAL: one file under `~/.aura`, one
//! row per key, and every project's turns roll into the same row.
//!
//! A row is identified by the key's FINGERPRINT — the first 12 hex of its
//! SHA-256 — never the key. That gets two things at once: the file is safe to
//! read, sync or paste into a bug report, and swapping in a new key starts a
//! new row with a new `added_at`, so "since the key was added" stays literally
//! true without anyone having to remember to reset a counter.
//!
//! Writes are read-modify-write under a process lock, then an atomic rename.
//! Two Aura windows billing the same key in the same instant can still have
//! one overwrite the other's last turn; that is a rounding error on a
//! spend meter, and the alternative (a lock file every turn contends on) buys
//! nothing worth its failure modes.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Spend on one model, inside one key's row.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpend {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub requests: u64,
}

/// Spend attributed to one checkout. Keyed by repo root so two worktrees of
/// the same project stay distinguishable; the UI shows the last path segment.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSpend {
    pub cost_usd: f64,
    pub requests: u64,
}

/// Everything one API key has spent since it was added.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySpend {
    /// Brain provider id — `gemini_native`, `anthropic_native`, …
    pub provider: String,
    /// First 12 hex of SHA-256(key). Enough to tell two keys apart, useless
    /// for reconstructing either.
    pub key_fp: String,
    /// Unix seconds when this fingerprint was first seen — the moment the key
    /// was added. This is the "since" in "since the key was added".
    pub added_at: u64,
    /// Unix seconds of the most recent billed turn.
    pub last_at: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub requests: u64,
    /// True once any turn in this row was priced off the tier fallback rather
    /// than a published rate — the total is then a `~`, not an invoice.
    pub estimated: bool,
    pub by_model: BTreeMap<String, ModelSpend>,
    pub by_project: BTreeMap<String, ProjectSpend>,
}

/// The whole file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendLedger {
    /// Bumped only if the shape changes incompatibly; readers tolerate absent.
    #[serde(default)]
    pub version: u32,
    /// Keyed `"<provider>:<fp>"`.
    #[serde(default)]
    pub keys: BTreeMap<String, KeySpend>,
}

const LEDGER_VERSION: u32 = 1;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

fn lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn ledger_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".aura").join("api-spend.json"))
}

/// First 12 hex of SHA-256 — a stable handle for a key we never store.
pub fn fingerprint(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    hex::encode(digest)[..12].to_string()
}

fn row_id(provider: &str, fp: &str) -> String {
    format!("{provider}:{fp}")
}

/// Read the ledger. A missing or corrupt file reads as empty rather than
/// erroring — a spend meter must never be the reason a chat turn fails.
pub fn read_ledger() -> SpendLedger {
    let Some(path) = ledger_path() else {
        return SpendLedger::default();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return SpendLedger::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_ledger(ledger: &SpendLedger) {
    let Some(path) = ledger_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(body) = serde_json::to_string_pretty(ledger) else {
        return;
    };
    // Write beside the target and rename, so a crash mid-write leaves the
    // previous total intact instead of a truncated file that reads as $0.
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Record that a key exists, stamping `added_at` the first time we see it.
///
/// Called when a key is stored, so the row (and its "since" date) exists
/// before the first turn — a key added and not yet used should read
/// "$0.00 since today", not be missing from the list entirely.
pub fn note_key_added(provider: &str, key: &str) {
    if key.is_empty() {
        return;
    }
    let fp = fingerprint(key);
    let _guard = lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut ledger = read_ledger();
    ledger.version = LEDGER_VERSION;
    ledger
        .keys
        .entry(row_id(provider, &fp))
        .or_insert_with(|| KeySpend {
            provider: provider.to_string(),
            key_fp: fp.clone(),
            added_at: now_secs(),
            ..KeySpend::default()
        });
    write_ledger(&ledger);
}

/// Fold one billed turn into the key's row and hand back the row as it now
/// stands, so the caller can show the running total alongside this turn's cost.
///
/// `repo_root` may be empty (a chat with no project open) — the turn still
/// counts toward the key, it just isn't attributed to a checkout.
#[allow(clippy::too_many_arguments)]
pub fn record_turn(
    provider: &str,
    key: &str,
    model: &str,
    repo_root: &str,
    input_tokens: u64,
    output_tokens: u64,
    cost_usd: f64,
    estimated: bool,
) -> Option<KeySpend> {
    if key.is_empty() || (input_tokens == 0 && output_tokens == 0) {
        return None;
    }
    let fp = fingerprint(key);
    let id = row_id(provider, &fp);
    let now = now_secs();

    let _guard = lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut ledger = read_ledger();
    ledger.version = LEDGER_VERSION;
    let row = ledger.keys.entry(id).or_insert_with(|| KeySpend {
        provider: provider.to_string(),
        key_fp: fp.clone(),
        // A key that was in the keychain before this ledger existed gets its
        // first billed turn as its start date. Slightly late beats absent.
        added_at: now,
        ..KeySpend::default()
    });

    row.last_at = now;
    row.input_tokens = row.input_tokens.saturating_add(input_tokens);
    row.output_tokens = row.output_tokens.saturating_add(output_tokens);
    row.cost_usd += cost_usd;
    row.requests = row.requests.saturating_add(1);
    row.estimated |= estimated;

    let model_key = if model.is_empty() { "default" } else { model };
    let m = row.by_model.entry(model_key.to_string()).or_default();
    m.input_tokens = m.input_tokens.saturating_add(input_tokens);
    m.output_tokens = m.output_tokens.saturating_add(output_tokens);
    m.cost_usd += cost_usd;
    m.requests = m.requests.saturating_add(1);

    if !repo_root.is_empty() {
        let p = row.by_project.entry(repo_root.to_string()).or_default();
        p.cost_usd += cost_usd;
        p.requests = p.requests.saturating_add(1);
    }

    let snapshot = row.clone();
    write_ledger(&ledger);
    Some(snapshot)
}

/// Every key's spend, newest activity first. Backs the settings/usage surface.
#[tauri::command]
pub async fn brain_api_spend() -> Result<Vec<KeySpend>, String> {
    let mut rows: Vec<KeySpend> = read_ledger().keys.into_values().collect();
    rows.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fingerprint_identifies_a_key_without_containing_it() {
        let key = "AIza-not-a-real-key-0123456789";
        let fp = fingerprint(key);
        assert_eq!(fp.len(), 12);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!key.contains(&fp), "the fingerprint must not be a substring of the key");
        assert_eq!(fp, fingerprint(key), "same key, same row");
        assert_ne!(fp, fingerprint("AIza-a-different-key"), "swapping the key starts a new row");
    }

    #[test]
    fn rows_are_namespaced_by_provider() {
        // The same string used as two providers' keys is two rows, not one.
        assert_ne!(row_id("gemini_native", "abc"), row_id("openai_native", "abc"));
    }

    #[test]
    fn a_corrupt_ledger_reads_as_empty_instead_of_erroring() {
        let parsed: SpendLedger = serde_json::from_str("{ this is not json").unwrap_or_default();
        assert!(parsed.keys.is_empty());
        // …and a ledger written by an older build without `version` still loads.
        let old: SpendLedger = serde_json::from_str(r#"{"keys":{}}"#).expect("tolerates no version");
        assert_eq!(old.version, 0);
    }

    #[test]
    fn a_turn_with_no_tokens_is_not_a_request() {
        // Providers that report no usage must not inflate the request count.
        assert!(record_turn("p", "k", "m", "", 0, 0, 0.0, false).is_none());
        assert!(record_turn("p", "", "m", "", 10, 10, 0.1, false).is_none());
    }
}
