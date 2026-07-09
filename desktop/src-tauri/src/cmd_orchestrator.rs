//! Orchestrator Mode Tauri surface — v0.2.31 LL.1 (task #340).
//!
//! Thin command wrappers around `manager::dispatcher`. The frontend
//! `WaveDispatchPanel` calls into this surface to fan a wave plan out
//! across parallel brains; per-lane streaming events are emitted on
//! `orchestrator-wave:<wave_id>` channels by the dispatcher itself, so
//! these commands stay pure request/response.
//!
//! State: `DispatcherState` is managed once at startup
//! (`lib.rs::run`); each command grabs it via `tauri::State` so
//! lane lookup is O(1) without holding a lock across an `await`.

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::manager::dispatcher::{
    self, DispatcherState, LaneOutcome, WaveOutcome, WavePlan,
};

/// Fan a wave plan out across parallel brains. Returns the initial
/// `WaveOutcome` snapshot — every lane is either `Queued`/`Running`
/// (spawned) or `Conflict` (held back because zones overlap a sibling
/// lane). Live progress arrives on `orchestrator-wave:<wave_id>` as
/// lanes stream text / complete / fail.
#[tauri::command]
pub async fn orchestrator_dispatch_wave(
    app: AppHandle,
    state: State<'_, Arc<DispatcherState>>,
    plan: WavePlan,
) -> Result<WaveOutcome, String> {
    if plan.lanes.is_empty() {
        return Err("wave plan has no lanes".into());
    }
    if plan.wave_id.trim().is_empty() {
        return Err("wave plan missing wave_id".into());
    }
    // Dispatcher is sync — spawn each lane internally via tokio::spawn —
    // so no .await here. Return the seed snapshot immediately; the
    // frontend subscribes to the wave event for live updates.
    let outcome = dispatcher::dispatch_wave(app, state.inner().clone(), plan);
    Ok(outcome)
}

/// Snapshot one lane by id. Used by the panel when it mounts onto a
/// pre-existing wave (e.g. user reopened the tab) so it doesn't need to
/// replay the event stream from the beginning.
#[tauri::command]
pub async fn orchestrator_lane_status(
    state: State<'_, Arc<DispatcherState>>,
    lane_id: String,
) -> Result<Option<LaneOutcome>, String> {
    Ok(state.lane_status(&lane_id))
}

/// Cancel one lane by id. Aborts the spawned task (which drops the
/// brain's stream — per trait contract that frees the HTTP body / child
/// process / etc.) and flips the lane state to `Cancelled`. Returns
/// `true` if the cancel landed; `false` if the lane was unknown or
/// already terminal.
#[tauri::command]
pub async fn orchestrator_cancel_lane(
    state: State<'_, Arc<DispatcherState>>,
    lane_id: String,
) -> Result<bool, String> {
    Ok(state.cancel_lane(&lane_id))
}

/// List every lane currently tracked by the dispatcher. Includes
/// terminal lanes until the next dispatch evicts them — the panel uses
/// this to render a completed wave when it remounts.
#[tauri::command]
pub async fn orchestrator_list_active(
    state: State<'_, Arc<DispatcherState>>,
) -> Result<Vec<LaneOutcome>, String> {
    Ok(state.list_active())
}

/// Snapshot one wave by id. Returns `None` if the dispatcher has never
/// seen the wave (or it was evicted).
#[tauri::command]
pub async fn orchestrator_wave_status(
    state: State<'_, Arc<DispatcherState>>,
    wave_id: String,
) -> Result<Option<WaveOutcome>, String> {
    Ok(state.wave_outcome(&wave_id))
}
