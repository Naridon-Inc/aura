//! Claude subscription usage snapshot — the 5-hour + weekly rate-limit %
//! Claude Code reports, surfaced so the desktop chat can show the same
//! peace-of-mind readout the CLI statusline already does.
//!
//! Source of truth: `~/.aura/usage/statusline.jsonl`. The Aura statusline
//! script (`aura-statusline.sh`) runs inside Claude Code, receives Claude's
//! own status payload on stdin — which carries `rate_limits.five_hour` and
//! `rate_limits.seven_day` (used %) plus `context_window` — and appends one
//! compact line per status render:
//!
//!   {"ts":1781875881,"5h":16,"7d":13,"cost":...,"ctx":16,"in":...,"out":...,
//!    "model":"Opus 4.8 (1M context)","sid":"...","peak":true}
//!
//! We read only the LAST line (a bounded tail, so the file can grow without
//! bound and this stays cheap), parse the fields we show, and stamp the
//! reading's age so the UI can hide a stale badge. Nothing is computed or
//! estimated — when Claude isn't running there's no fresh line and the badge
//! simply doesn't show. `5h`/`7d` are absent (null) when the account isn't on
//! a subscription window (e.g. a raw API key), in which case those bars hide
//! too. Real data only.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::cloud_session_sync::aura_dir;

/// How far back a reading still reflects the live 5-hour window. Past this the
/// `5h` figure is from an old window and would mislead, so the UI treats the
/// snapshot as not-fresh. Matches the 5-hour window length.
const FRESH_WINDOW_SECS: i64 = 5 * 60 * 60;

/// Bytes to read from the tail of the log when hunting the last line. A single
/// statusline record is well under 512 bytes, so 16 KiB comfortably contains
/// the final complete line even after a partial trailing write.
const TAIL_BYTES: u64 = 16 * 1024;

/// One parsed status line. Every field is optional because a statusline payload
/// may omit rate limits (no subscription window) or be an older record shape.
#[derive(Deserialize, Default)]
struct StatusLine {
    ts: Option<i64>,
    #[serde(rename = "5h")]
    five_h: Option<f64>,
    #[serde(rename = "7d")]
    seven_d: Option<f64>,
    ctx: Option<f64>,
    cost: Option<f64>,
    model: Option<String>,
}

/// The snapshot handed to the frontend. `None` from the command means "no usable
/// reading" (file missing/empty/unparseable) — the UI shows nothing.
#[derive(Serialize, Default)]
pub struct ClaudeUsageSnapshot {
    /// Percent of the rolling 5-hour limit used (0–100). `None` off-subscription.
    pub five_h_pct: Option<f64>,
    /// Percent of the weekly (7-day) limit used (0–100). `None` off-subscription.
    pub seven_d_pct: Option<f64>,
    /// Percent of the model context window used on the last turn (0–100).
    pub ctx_pct: Option<f64>,
    /// Running session cost in USD, as Claude Code reports it.
    pub cost_usd: Option<f64>,
    /// Model label from the reading (e.g. "Opus 4.8 (1M context)").
    pub model: Option<String>,
    /// Unix epoch (secs) of the reading.
    pub ts: i64,
    /// Seconds since the reading was written. The UI uses this for "as of".
    pub age_secs: i64,
    /// True while the reading is recent enough that the 5-hour figure is live.
    pub fresh: bool,
}

/// Read the last complete line of `statusline.jsonl` without slurping the whole
/// (potentially large, append-only) file. Seeks to the tail, reads a bounded
/// window, and returns the last newline-terminated record.
fn read_last_line() -> Option<String> {
    let path = aura_dir().ok()?.join("usage").join("statusline.jsonl");
    let mut file = File::open(&path).ok()?;
    let len = file.metadata().ok()?.len();
    if len == 0 {
        return None;
    }
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity(TAIL_BYTES as usize);
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    // Last non-empty line. If we started mid-line (start > 0) the first
    // fragment is partial and ignored — we only want a fully-formed last line.
    text.lines()
        .rev()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .map(|l| l.to_string())
}

/// Read the latest Claude usage reading the CLI statusline recorded. Returns
/// `Ok(None)` when there's no usable line (Claude not running / never has).
#[tauri::command]
pub async fn claude_usage_snapshot() -> Result<Option<ClaudeUsageSnapshot>, String> {
    let Some(line) = read_last_line() else {
        return Ok(None);
    };
    let Ok(rec) = serde_json::from_str::<StatusLine>(&line) else {
        return Ok(None);
    };
    let ts = rec.ts.unwrap_or(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(ts);
    let age_secs = (now - ts).max(0);
    Ok(Some(ClaudeUsageSnapshot {
        five_h_pct: rec.five_h,
        seven_d_pct: rec.seven_d,
        ctx_pct: rec.ctx,
        cost_usd: rec.cost,
        model: rec.model,
        ts,
        age_secs,
        fresh: ts > 0 && age_secs <= FRESH_WINDOW_SECS,
    }))
}
