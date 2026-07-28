//! Orchestrator Mode dispatcher — v0.2.31 LL.1 (task #340).
//!
//! Manager-of-managers fan-out. Takes a `WavePlan` (one or more
//! `LaneSpec`s — zone + objective + optional mode + optional brain
//! override) and spawns one `Brain::chat` session per lane via
//! `tokio::spawn`. Each lane runs in its own context window with its
//! own brain pick; the parent manager only ever sees the lane's
//! `Brain::summarize` output (NOT the full transcript), preserving the
//! parent's context budget.
//!
//! Inspiration: kilo.ai Orchestrator Mode — a parent manager splits a
//! task across specialist modes, each scoped to its own ACL and isolated
//! context, then merges the summaries back into a unified change-set.
//!
//! ## Architecture
//!
//! ```text
//!   WavePlan { lanes: [LaneSpec*] }
//!         │
//!         ▼
//!   ┌─────────────────────────────────────┐
//!   │  Dispatcher::dispatch_wave           │
//!   │   ├─ zone-collision detection        │
//!   │   │   (re-uses tick::zones_overlap)  │
//!   │   ├─ spawn one tokio task per lane   │
//!   │   │   → Brain::chat (streaming)      │
//!   │   │   → collect text into transcript │
//!   │   │   → Brain::summarize on End      │
//!   │   └─ compose LaneOutcome per lane    │
//!   └─────────────────────────────────────┘
//!         │
//!         ▼
//!   WaveOutcome {
//!     lanes:    [LaneOutcome*]           // queued | running | done | conflict | cancelled | failed
//!     conflicts: [ZoneConflict*]         // pairs of lane_ids sharing zones
//!     unified_changes: [UnifiedChange*]  // patches composed across lanes
//!   }
//! ```
//!
//! ## State
//!
//! `DispatcherState` is the registry of in-flight lanes. Lanes are keyed
//! by a `lane_id` (uuid v4 minted at dispatch). The state is held by
//! Tauri as `State<DispatcherState>` so `orchestrator_cancel_lane` and
//! friends can look lanes up without holding a lock across an `await`.
//!
//! Lanes carry their own `JoinHandle` so `cancel` aborts cleanly — the
//! drop tears down the inner `BoxStream` (HTTP body, child process, …)
//! per the `Brain` trait contract.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;
use uuid::Uuid;

use super::brain::{
    manager::BrainManager,
    types::{ChatChunk, ChatMessage, ChatRequest},
    Brain,
};
use super::skill::TaskTaxonomy;

/// One specialist lane the orchestrator should fan out. The shape is
/// frontend-driven — the WaveDispatchPanel sends a `WavePlan` carrying
/// one `LaneSpec` per todo on the PlanCard.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaneSpec {
    /// Free-form objective the lane works toward — becomes the user
    /// message on the brain's first turn.
    pub objective: String,
    /// File-path zones the lane intends to touch. Drives the conflict
    /// detector (re-uses `tick::zones_overlap`) so the panel can warn
    /// the user before the lanes actually fight each other.
    #[serde(default)]
    pub zones: Vec<String>,
    /// Optional mode slug — `architect` / `code` / `debug` / a
    /// user-installed mode. The system prompt is hydrated from the
    /// mode registry at dispatch time; an unknown / missing slug falls
    /// back to the brain's default prompt.
    #[serde(default)]
    pub mode: Option<String>,
    /// Optional provider override. `None` means "use the active brain".
    /// Per-lane override lets the WaveDispatchPanel route one lane to
    /// `cli_wrapper:gemini` while another runs through
    /// `anthropic_native` for the same wave.
    #[serde(default)]
    pub brain_override: Option<String>,
    /// Optional 4-lens taxonomy for this lane's work. When present (and
    /// no `brain_override` is set and auto-route is on), `resolve_brain`
    /// consults the Agent Skill Ledger (`aura skill suggest`) to bind the
    /// historically best provider for this cell. The frontend derives it
    /// from the todo's description + file refs before dispatch; a missing
    /// taxonomy simply skips auto-route and falls back to the active brain.
    #[serde(default)]
    pub taxonomy: Option<TaskTaxonomy>,
    /// Optional label for the UI. Falls back to a truncation of
    /// `objective` when empty.
    #[serde(default)]
    pub label: Option<String>,
}

/// Seed for one lane the loop runner drives EXTERNALLY — i.e. the node is run
/// by the bundled `aura crew run` CLI (a real coding agent that edits +
/// commits), not by an in-process `Brain::chat`. The dispatcher still tracks it
/// through the SAME lane registry, so every orchestrator surface (Watch live,
/// `list_active`, the `orchestrator-wave:<id>` stream) sees an external lane
/// exactly like a brain lane — the only difference is who produces its
/// transcript. See [`DispatcherState::register_external_wave`].
#[derive(Debug, Clone)]
pub struct ExternalLaneInit {
    /// The node's title — matched back by `CrewLiveTranscript` (label first).
    pub label: String,
    /// The node's objective (title + spec) — the fallback match key, and the
    /// human brief shown on the lane.
    pub objective: String,
}

/// One wave the orchestrator should dispatch in parallel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WavePlan {
    /// Identifier owned by the caller (typically the PlanCard's plan
    /// id). Surfaced back on `WaveOutcome` so the UI can match the
    /// outcome to the panel that triggered the dispatch.
    pub wave_id: String,
    pub lanes: Vec<LaneSpec>,
}

/// Lane lifecycle states surfaced to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaneStatus {
    /// Dispatched but not yet spawned (zone-conflict held).
    Queued,
    /// `tokio::spawn` is in flight; brain streaming.
    Running,
    /// Finished cleanly; `summary` + `unified_change` populated.
    Done,
    /// Held back at dispatch because zones overlapped another in-flight
    /// lane. Listed in `WaveOutcome.conflicts` paired with the blocker.
    Conflict,
    /// Cancelled by the user via `orchestrator_cancel_lane`.
    Cancelled,
    /// Brain returned an error or panicked. `error` carries the message.
    Failed,
}

/// One zone-conflict pair the dispatcher detected at fan-out time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneConflict {
    pub lane_id: String,
    pub blocker_lane_id: String,
    /// The first overlapping zone — surfaced as the inline warning text.
    pub zone: String,
}

/// One file change attributed to a specific lane. `body` is the new
/// proposed content; the unified merge step concatenates non-conflicting
/// changes and flags overlaps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedChange {
    pub lane_id: String,
    pub path: String,
    pub body: String,
}

/// Live snapshot of one lane in the orchestrator. Persistable shape
/// returned by `orchestrator_lane_status` / `orchestrator_list_active`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaneOutcome {
    pub lane_id: String,
    pub wave_id: String,
    pub spec: LaneSpec,
    pub status: LaneStatus,
    /// Provider id the lane actually ran on (resolved from
    /// `brain_override` or the active brain).
    #[serde(default)]
    pub provider_id: Option<String>,
    /// Rolling raw text the lane has streamed so far. Bounded — capped
    /// at 64 KB to keep the runtime bounded even on a runaway brain.
    #[serde(default)]
    pub transcript: String,
    /// Populated on `Done` via `Brain::summarize`. The parent manager
    /// only sees this — the full `transcript` is for the lane panel
    /// alone.
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    pub started_at: u64,
    #[serde(default)]
    pub completed_at: Option<u64>,
    /// Token accounting, populated on `Done`. `transcript_tokens` is the
    /// raw stream the lane produced; `summary_tokens` is the compressed
    /// form the parent manager actually ingests; `saved_tokens` is what
    /// summarisation kept out of the coordinator's context
    /// (transcript − summary, floored at 0). Honest ~3.5-chars/token
    /// estimates, never provider-billed counts. Zero on non-Done lanes.
    /// Additive: outcomes persisted before this deserialize them as 0.
    #[serde(default)]
    pub transcript_tokens: u32,
    #[serde(default)]
    pub summary_tokens: u32,
    #[serde(default)]
    pub saved_tokens: u32,
}

/// Wave-level token ledger — the honest "what did running this in the
/// Orchestrator cost vs. save" meter. Recomputed from the lanes on every
/// state change. Every figure is a heuristic ~3.5-chars/token estimate,
/// never a provider-billed count, so the UI renders them all with a "~".
///
/// The two sides a user actually cares about:
///   * **Saved** — `transcript_tokens − summary_tokens`: context the
///     per-lane summarisation kept out of the coordinator's window. This
///     is why fan-out doesn't drown the parent manager.
///   * **Overhead** — one specialist preamble per lane that a single
///     linear thread would never pay. This is the honest "tax" for
///     parallelism; surfacing it means we never tell a user their higher
///     usage is "in their head".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenLedger {
    /// Lanes dispatched in this wave (every lane pays the preamble).
    pub lane_count: u32,
    /// Done lanes that contributed transcript/summary figures.
    pub done_lanes: u32,
    /// Raw transcript tokens the Done lanes produced in aggregate — the
    /// work itself, roughly what a linear run would read inline.
    pub transcript_tokens: u32,
    /// Tokens of lane summaries the parent manager actually ingests.
    pub summary_tokens: u32,
    /// Context summarisation kept out of the coordinator (Σ per-lane
    /// `saved_tokens`, each floored at 0).
    pub saved_tokens: u32,
    /// Estimated coordination overhead the fan-out adds vs. linear: one
    /// specialist preamble per dispatched lane.
    pub overhead_tokens: u32,
}

/// Composed result of a fan-out. Mirrored back to the frontend on the
/// `orchestrator-wave:<wave_id>` event whenever a lane changes state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaveOutcome {
    pub wave_id: String,
    pub lanes: Vec<LaneOutcome>,
    pub conflicts: Vec<ZoneConflict>,
    /// Best-effort unified change-set. Populated as lanes complete.
    pub unified_changes: Vec<UnifiedChange>,
    /// Token ledger for the wave. Recomputed on every lane state change.
    /// Additive: outcomes persisted before this deserialize it as
    /// all-zero (`TokenLedger::default`).
    #[serde(default)]
    pub tokens: TokenLedger,
}

const TRANSCRIPT_MAX_BYTES: usize = 64 * 1024;

/// Estimated tokens of the fixed specialist-lane preamble
/// (`default_orchestrator_preamble`) that every dispatched lane is
/// prefixed with — the coordination overhead a linear run never pays.
/// The objective + zones the lane also receives vary per-lane and aren't
/// counted here; this is the fixed skeleton only. ~430 chars / 3.5 ≈ 123.
/// Update if that preamble changes materially; it feeds the wave token
/// ledger's honest "overhead" figure, so exactness isn't load-bearing
/// (the UI always renders it with a "~").
const LANE_PREAMBLE_TOKENS_EST: u32 = 123;

/// Recompute the wave's [`TokenLedger`] from its current lane snapshots.
/// Pure — no locks, no I/O — so it's unit-testable in isolation. Called
/// from `sync_wave_from_lanes` under the wave lock on every state change.
///
/// `transcript`/`summary`/`saved` sum only the `Done` lanes (a Running or
/// Failed lane has no settled figures yet); `overhead` prices every
/// dispatched lane, since each pays the preamble the moment it spawns.
fn compute_wave_ledger(lanes: &[LaneOutcome]) -> TokenLedger {
    let lane_count = lanes.len() as u32;
    let done: Vec<&LaneOutcome> = lanes
        .iter()
        .filter(|l| matches!(l.status, LaneStatus::Done))
        .collect();
    TokenLedger {
        lane_count,
        done_lanes: done.len() as u32,
        transcript_tokens: done.iter().map(|l| l.transcript_tokens).sum(),
        summary_tokens: done.iter().map(|l| l.summary_tokens).sum(),
        saved_tokens: done.iter().map(|l| l.saved_tokens).sum(),
        overhead_tokens: lane_count.saturating_mul(LANE_PREAMBLE_TOKENS_EST),
    }
}

/// Per-lane stall guard. A lane streams from a brain; if the stream opens but
/// then produces nothing for this long — a wedged cloud turn, a dropped SSE, a
/// provider that accepts the connection but never sends an `End` frame — the
/// lane would otherwise sit `Running` forever and its graph node would spin on
/// `working` until its 30-min lease expired. Reset on every chunk, so a
/// legitimately long turn that keeps streaming is never killed; only true
/// silence trips it. Generous enough to cover a slow first token.
const LANE_STALL_SECS: u64 = 180;

/// Two zones overlap iff either is empty, they're equal, or one is a
/// path-segment prefix of the other (so `src/lib` collides with
/// `src/lib/api.ts` but NOT `src/library/api.ts`). Mirrors
/// `tick::zones_overlap` — kept private to the dispatcher to avoid
/// adding a public export to `tick.rs` solely for one cross-module call.
fn zones_overlap(a: &str, b: &str) -> bool {
    let a = a.trim().trim_end_matches("**").trim_end_matches('*');
    let b = b.trim().trim_end_matches("**").trim_end_matches('*');
    let a = a.trim_end_matches('/');
    let b = b.trim_end_matches('/');
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    let (shorter, longer) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    if let Some(rest) = longer.strip_prefix(shorter) {
        rest.starts_with('/')
    } else {
        false
    }
}

/// Internal per-lane bookkeeping. Held inside `DispatcherState` under a
/// `Mutex` so the cancel path can flip status without racing the
/// streaming task.
struct LaneEntry {
    outcome: LaneOutcome,
    /// `None` for lanes that ended up in `Conflict` and never spawned.
    handle: Option<JoinHandle<()>>,
}

/// Tauri-managed state for the orchestrator. One per app, holds every
/// lane the dispatcher has produced so the cancel + status commands can
/// find them by id.
#[derive(Default)]
pub struct DispatcherState {
    inner: Mutex<HashMap<String, LaneEntry>>,
    waves: Mutex<HashMap<String, WaveOutcome>>,
    /// Cancel signals for EXTERNAL (CLI-driven) waves, keyed by wave id. An
    /// external lane has no in-process `JoinHandle` to abort, so cancelling it
    /// (via `cancel_lane`) notifies the run's reader task here, which kills the
    /// `aura crew run` child process. Empty for ordinary brain waves.
    external_cancels: Mutex<HashMap<String, Arc<tokio::sync::Notify>>>,
}

impl DispatcherState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot every lane currently tracked. Includes terminal lanes
    /// until the next dispatch evicts them (we keep them so the panel
    /// can render a completed wave).
    pub fn list_active(&self) -> Vec<LaneOutcome> {
        let g = self.inner.lock().unwrap();
        let mut out: Vec<LaneOutcome> = g.values().map(|e| e.outcome.clone()).collect();
        out.sort_by_key(|l| l.started_at);
        out
    }

    /// Lookup one lane outcome by id.
    pub fn lane_status(&self, lane_id: &str) -> Option<LaneOutcome> {
        self.inner
            .lock()
            .unwrap()
            .get(lane_id)
            .map(|e| e.outcome.clone())
    }

    /// Cancel one lane by id. Aborts the join handle (which drops the
    /// inner BoxStream — per the trait contract that tears down the
    /// HTTP body or child process the brain held). Flips lane state to
    /// `Cancelled`. No-op when the lane is already terminal.
    ///
    /// For an EXTERNAL lane (a CLI-driven `aura crew run` node, which has no
    /// in-process handle), flipping the status isn't enough to stop the real
    /// agent — so we also fire the wave's cancel `Notify`, which wakes the run's
    /// reader task to kill the child process. Brain lanes never register a
    /// cancel, so the notify lookup is a harmless no-op for them.
    pub fn cancel_lane(&self, lane_id: &str) -> bool {
        let wave_id;
        {
            let mut g = self.inner.lock().unwrap();
            let Some(entry) = g.get_mut(lane_id) else {
                return false;
            };
            if matches!(
                entry.outcome.status,
                LaneStatus::Done | LaneStatus::Failed | LaneStatus::Cancelled
            ) {
                return false;
            }
            if let Some(handle) = entry.handle.take() {
                handle.abort();
            }
            entry.outcome.status = LaneStatus::Cancelled;
            entry.outcome.completed_at = Some(now_secs());
            wave_id = entry.outcome.wave_id.clone();
        }
        // Stop the external child, if this lane belongs to a CLI-driven wave.
        if let Some(notify) = self.external_cancels.lock().unwrap().get(&wave_id) {
            notify.notify_waiters();
        }
        true
    }

    /// Register an EXTERNAL wave — one `Queued` lane per init — and return the
    /// minted lane ids (in order) plus the wave's cancel `Notify`. The loop
    /// runner mints these up-front so the canvas can find a node's lane the
    /// instant the bundled CLI starts working it; the reader task then flips
    /// each lane Running → Done/Failed as the CLI reports progress. The returned
    /// `Notify` is the reader's stop signal (fired by `cancel_lane`).
    pub fn register_external_wave(
        &self,
        wave_id: &str,
        lanes: Vec<ExternalLaneInit>,
    ) -> (Vec<String>, Arc<tokio::sync::Notify>) {
        let mut ids = Vec::with_capacity(lanes.len());
        let mut outcomes = Vec::with_capacity(lanes.len());
        {
            let mut g = self.inner.lock().unwrap();
            for init in lanes {
                let lane_id = Uuid::new_v4().to_string();
                let outcome = LaneOutcome {
                    lane_id: lane_id.clone(),
                    wave_id: wave_id.to_string(),
                    spec: LaneSpec {
                        objective: init.objective,
                        zones: vec![],
                        mode: None,
                        brain_override: None,
                        taxonomy: None,
                        label: Some(init.label),
                    },
                    status: LaneStatus::Queued,
                    provider_id: None,
                    transcript: String::new(),
                    summary: None,
                    error: None,
                    started_at: now_secs(),
                    completed_at: None,
                    transcript_tokens: 0,
                    summary_tokens: 0,
                    saved_tokens: 0,
                };
                g.insert(
                    lane_id.clone(),
                    LaneEntry {
                        outcome: outcome.clone(),
                        handle: None,
                    },
                );
                ids.push(lane_id);
                outcomes.push(outcome);
            }
        }
        self.waves.lock().unwrap().insert(
            wave_id.to_string(),
            WaveOutcome {
                wave_id: wave_id.to_string(),
                lanes: outcomes,
                conflicts: vec![],
                unified_changes: vec![],
                tokens: TokenLedger::default(),
            },
        );
        let notify = Arc::new(tokio::sync::Notify::new());
        self.external_cancels
            .lock()
            .unwrap()
            .insert(wave_id.to_string(), notify.clone());
        (ids, notify)
    }

    /// Mark an external lane Running (the CLI started its node) and stamp the
    /// agent that's running it. No-op once the lane is terminal/cancelled.
    pub fn external_lane_running(&self, lane_id: &str, provider_id: &str) {
        let mut g = self.inner.lock().unwrap();
        if let Some(entry) = g.get_mut(lane_id) {
            if matches!(
                entry.outcome.status,
                LaneStatus::Done | LaneStatus::Failed | LaneStatus::Cancelled
            ) {
                return;
            }
            entry.outcome.status = LaneStatus::Running;
            entry.outcome.provider_id = Some(provider_id.to_string());
        }
    }

    /// Forget an external wave's cancel signal once the run is over, so the map
    /// doesn't grow across runs. The lane outcomes themselves stay until the
    /// next dispatch evicts them (so the panel can still render the finished run).
    pub fn drop_external_wave(&self, wave_id: &str) {
        self.external_cancels.lock().unwrap().remove(wave_id);
    }

    /// Snapshot a wave by id. Returns `None` if the wave was never
    /// dispatched (or was evicted).
    pub fn wave_outcome(&self, wave_id: &str) -> Option<WaveOutcome> {
        self.waves.lock().unwrap().get(wave_id).cloned()
    }
}

/// Compose a per-lane `ChatRequest` from the lane spec. The mode hint
/// is loaded (best-effort) from the mode registry — failures fall back
/// to the brain's default prompt so a missing / malformed mode YAML
/// never blocks dispatch.
fn build_request(spec: &LaneSpec) -> ChatRequest {
    let system_prompt = spec
        .mode
        .as_deref()
        .and_then(load_mode_system_prompt)
        .or_else(|| Some(default_orchestrator_preamble(spec).to_string()));

    ChatRequest {
        messages: vec![ChatMessage {
            role: "user".into(),
            content: serde_json::Value::String(spec.objective.clone()),
        }],
        cwd: String::new(),
        system: system_prompt,
        tools: vec![],
        max_tokens: None,
        temperature: None,
        effort: None,
        fast: false,
        model: None,
        long_context: false,
        approval: None,
    }
}

/// Best-effort load of a mode's system prompt from the mode registry.
/// Mirrors how the existing composer surfaces mode picks — the lookup
/// is read-only and silently returns `None` on miss so the dispatcher
/// stays agnostic to the registry's failure modes.
fn load_mode_system_prompt(slug: &str) -> Option<String> {
    let descs = super::modes::registry::descriptors().ok()?;
    let mode = descs.into_iter().find(|d| d.mode.id == slug)?;
    let prompt = mode.mode.system_prompt.trim();
    if prompt.is_empty() {
        None
    } else {
        Some(prompt.to_string())
    }
}

fn default_orchestrator_preamble(spec: &LaneSpec) -> String {
    let zones = if spec.zones.is_empty() {
        "<unscoped>".to_string()
    } else {
        spec.zones.join(", ")
    };
    format!(
        "You are a specialist lane in an Aura Orchestrator wave. Execute the objective below and nothing else. Edit ONLY these zones: {zones} — leave every file outside them untouched, and don't broaden the task. Do the work fully; if you hit a blocker you can't resolve, report it honestly rather than claiming success. When you finish, output a short final summary line so the parent manager can compose changes across lanes."
    )
}

/// Resolve the brain to use for a lane. Returns `(provider_id, brain)`.
///
/// Resolution order:
/// 1. **Manual `brain_override`** — always wins when present + valid. A
///    typo'd override falls through rather than killing the lane.
/// 2. **Auto-route** — when no override is set, auto-route is on
///    (`BrainSettings::auto_route`), and the lane carries a `taxonomy`,
///    consult the Agent Skill Ledger (`aura skill suggest`) for the
///    historically best provider in that cell. A below-threshold cell
///    (no suggestion) or an unbuildable suggested provider falls through.
/// 3. **Active brain** — the configured default from `BrainManager`.
fn resolve_brain(
    spec: &LaneSpec,
    mgr: &BrainManager,
) -> Result<(String, Arc<dyn Brain>), String> {
    if let Some(override_id) = spec.brain_override.as_deref().filter(|s| !s.is_empty()) {
        match super::brain::registry::build(override_id) {
            Ok(brain) => return Ok((override_id.to_string(), brain)),
            Err(e) => {
                // Fall back rather than failing the lane — an override
                // typo shouldn't kill the wave. We surface the chosen
                // provider on the outcome so the user can see what ran.
                eprintln!(
                    "[orchestrator] brain_override `{override_id}` failed: {e}; falling back"
                );
            }
        }
    }

    // Auto-route: let the skill ledger pick when the user hasn't pinned a
    // provider. Prefer an explicit taxonomy on the spec; otherwise derive
    // one from the lane's objective + zones (the same signals the in-app
    // advisory badges classify on), so the orchestrator UI surface gets
    // auto-routing without the frontend reimplementing the classifier.
    if mgr.settings().auto_route {
        let taxonomy = spec.taxonomy.clone().unwrap_or_else(|| {
            super::skill::derive_taxonomy(&spec.objective, &spec.zones, &[])
        });
        if let Some(suggestion) = super::skill::suggest_provider(&taxonomy) {
            match super::brain::registry::build(&suggestion.provider_id) {
                Ok(brain) => return Ok((suggestion.provider_id, brain)),
                Err(e) => {
                    eprintln!(
                        "[orchestrator] auto-route to `{}` failed: {e}; falling back to active brain",
                        suggestion.provider_id
                    );
                }
            }
        }
    }

    let brain = mgr.active().map_err(|e| e.to_string())?;
    Ok((brain.provider_id().to_string(), brain))
}

/// Spawn the streaming task for a single lane. The closure consumes the
/// brain's `BoxStream`, accumulates text into the lane's transcript,
/// and on `End` calls `Brain::summarize` to compose the parent-facing
/// summary. State updates flip the lane outcome through Running → Done
/// (or Failed); each transition emits an `orchestrator-wave:<wave>`
/// event so the panel re-renders without polling.
fn spawn_lane(
    app: AppHandle,
    state: Arc<DispatcherState>,
    wave_id: String,
    lane_id: String,
    brain: Arc<dyn Brain>,
    request: ChatRequest,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let stream = match brain.chat(request).await {
            Ok(s) => s,
            Err(e) => {
                mark_lane_failed(&state, &lane_id, e.to_string());
                emit_wave(&app, &state, &wave_id);
                return;
            }
        };

        let mut stream = stream;
        let mut buffer = String::new();
        let mut errored: Option<String> = None;
        loop {
            // Bound the wait on each chunk. A stalled stream (no chunk for
            // LANE_STALL_SECS) is resolved rather than awaited forever: if the
            // lane already produced text, treat the silence as a turn whose
            // `End` frame was lost and summarise what we have; if it produced
            // nothing at all, fail loudly so the node is released, not spun.
            let next = tokio::time::timeout(
                std::time::Duration::from_secs(LANE_STALL_SECS),
                stream.next(),
            )
            .await;
            let item = match next {
                Ok(Some(item)) => item,
                Ok(None) => break, // stream ended — no more chunks
                Err(_elapsed) => {
                    if buffer.trim().is_empty() {
                        errored = Some(format!(
                            "the agent stalled — no output for {LANE_STALL_SECS}s"
                        ));
                    }
                    break;
                }
            };
            match item {
                Ok(ChatChunk::Text { text, .. }) => {
                    push_transcript(&state, &lane_id, &text);
                    if buffer.len() + text.len() <= TRANSCRIPT_MAX_BYTES {
                        buffer.push_str(&text);
                    }
                    emit_wave(&app, &state, &wave_id);
                }
                Ok(ChatChunk::ToolUse { name, .. }) => {
                    // Surface tool use as a transcript marker so the
                    // panel shows something happened even without text.
                    let marker = format!("\n[tool_use: {name}]\n");
                    push_transcript(&state, &lane_id, &marker);
                    if buffer.len() + marker.len() <= TRANSCRIPT_MAX_BYTES {
                        buffer.push_str(&marker);
                    }
                    emit_wave(&app, &state, &wave_id);
                }
                Ok(ChatChunk::ToolResult { .. }) => {
                    // Server-side tool-loop result chunk — only the native
                    // chat command emits these; lane streams never do. No-op.
                }
                Ok(ChatChunk::Reasoning { .. }) | Ok(ChatChunk::Usage { .. }) => {
                    // Extended-thinking deltas and token-usage chunks are
                    // chat-surface cosmetics (a disclosure block + a meter).
                    // A dispatched lane is a transcript, not a chat bubble —
                    // there's nothing to render them into, so ignore them.
                }
                Ok(ChatChunk::End { .. }) => break,
                Ok(ChatChunk::Error { message }) => {
                    errored = Some(message);
                    break;
                }
                Err(e) => {
                    errored = Some(e.to_string());
                    break;
                }
            }
        }

        if let Some(err) = errored {
            mark_lane_failed(&state, &lane_id, err);
            emit_wave(&app, &state, &wave_id);
            return;
        }

        // Summarise via the trait. The default impl is a deterministic
        // trim; native brains override with a real summarisation pass.
        // Failures fall back to the trim so a flaky summariser never
        // blocks the merge.
        let summary = match brain.summarize(&buffer).await {
            Ok(s) => s,
            Err(_) => {
                let collapsed: String = buffer.split_whitespace().collect::<Vec<_>>().join(" ");
                if collapsed.chars().count() <= 500 {
                    collapsed
                } else {
                    let start = collapsed
                        .char_indices()
                        .nth_back(499)
                        .map(|(i, _)| i)
                        .unwrap_or(0);
                    format!("…{}", &collapsed[start..])
                }
            }
        };

        mark_lane_done(&state, &lane_id, summary);
        emit_wave(&app, &state, &wave_id);
    })
}

/// Update the lane's transcript buffer atomically with an upper byte
/// bound. Mutation goes through `DispatcherState` so the cancel path can
/// see the latest text on `lane_status`.
fn push_transcript(state: &DispatcherState, lane_id: &str, text: &str) {
    let mut g = state.inner.lock().unwrap();
    if let Some(entry) = g.get_mut(lane_id) {
        let cap = TRANSCRIPT_MAX_BYTES;
        if entry.outcome.transcript.len() + text.len() <= cap {
            entry.outcome.transcript.push_str(text);
        } else if entry.outcome.transcript.len() < cap {
            let remaining = cap - entry.outcome.transcript.len();
            let take = text.chars().take(remaining).collect::<String>();
            entry.outcome.transcript.push_str(&take);
        }
    }
}

fn mark_lane_done(state: &DispatcherState, lane_id: &str, summary: String) {
    let mut g = state.inner.lock().unwrap();
    if let Some(entry) = g.get_mut(lane_id) {
        // Don't override a cancellation that landed mid-flight.
        if matches!(entry.outcome.status, LaneStatus::Cancelled) {
            return;
        }
        // Token accounting: the raw transcript is what this lane produced;
        // the summary is all the parent manager actually reads. The gap is
        // context the summarisation kept out of the coordinator's window.
        // Estimated off the bounded stored transcript so brain lanes and
        // external CLI lanes are measured the same way.
        let transcript_tokens = super::tokens::estimate_str_tokens(&entry.outcome.transcript);
        let summary_tokens = super::tokens::estimate_str_tokens(&summary);
        entry.outcome.transcript_tokens = transcript_tokens;
        entry.outcome.summary_tokens = summary_tokens;
        entry.outcome.saved_tokens = transcript_tokens.saturating_sub(summary_tokens);
        entry.outcome.status = LaneStatus::Done;
        entry.outcome.summary = Some(summary);
        entry.outcome.completed_at = Some(now_secs());
        entry.handle = None;
    }
    sync_wave_from_lanes(state, lane_id);
}

fn mark_lane_failed(state: &DispatcherState, lane_id: &str, error: String) {
    let mut g = state.inner.lock().unwrap();
    if let Some(entry) = g.get_mut(lane_id) {
        if matches!(entry.outcome.status, LaneStatus::Cancelled) {
            return;
        }
        entry.outcome.status = LaneStatus::Failed;
        entry.outcome.error = Some(error);
        entry.outcome.completed_at = Some(now_secs());
        entry.handle = None;
    }
    sync_wave_from_lanes(state, lane_id);
}

/// Refresh the WaveOutcome snapshot from the live lane entries after a
/// state change. Called inside the lock-holding paths so the snapshot
/// the frontend reads back via `orchestrator-wave:<wave>` is always
/// consistent with the lane registry.
fn sync_wave_from_lanes(state: &DispatcherState, lane_id: &str) {
    let lane_outcome = match state.inner.lock().unwrap().get(lane_id) {
        Some(e) => e.outcome.clone(),
        None => return,
    };
    let wave_id = lane_outcome.wave_id.clone();
    let mut waves = state.waves.lock().unwrap();
    let wave = match waves.get_mut(&wave_id) {
        Some(w) => w,
        None => return,
    };
    if let Some(slot) = wave.lanes.iter_mut().find(|l| l.lane_id == lane_id) {
        *slot = lane_outcome.clone();
    }
    // Refresh the token ledger from the updated lane set so the frontend
    // meter tracks live as lanes settle.
    wave.tokens = compute_wave_ledger(&wave.lanes);
    // Append unified change extracted from the summary. The lane brain
    // is expected to emit a `### CHANGE path/to/file` fenced block when
    // it touches a file; the dispatcher harvests those at compose-time.
    // Best-effort — non-structured lanes still produce a usable summary
    // and the panel falls back to text-only display.
    if matches!(lane_outcome.status, LaneStatus::Done) {
        if let Some(summary) = &lane_outcome.summary {
            for ch in extract_changes(&lane_outcome.lane_id, summary) {
                if !wave
                    .unified_changes
                    .iter()
                    .any(|c| c.lane_id == ch.lane_id && c.path == ch.path)
                {
                    wave.unified_changes.push(ch);
                }
            }
        }
    }
}

/// Parse `### CHANGE <path>` followed by a ```` ``` ```` fenced block
/// out of a lane summary into `UnifiedChange` rows. Tolerant of
/// freeform prose — only the well-formed markers harvest, everything
/// else is left as plain summary text. Kept tiny on purpose: lanes that
/// want to contribute concrete changes follow the marker convention,
/// everyone else just emits prose.
fn extract_changes(lane_id: &str, summary: &str) -> Vec<UnifiedChange> {
    let mut out = vec![];
    let mut lines = summary.lines().peekable();
    while let Some(line) = lines.next() {
        let path = match line.strip_prefix("### CHANGE ") {
            Some(p) => p.trim().to_string(),
            None => continue,
        };
        // Walk until we find a fenced block.
        let mut body = String::new();
        let mut in_fence = false;
        while let Some(l) = lines.next() {
            if l.trim_start().starts_with("```") {
                if in_fence {
                    break;
                }
                in_fence = true;
                continue;
            }
            if in_fence {
                body.push_str(l);
                body.push('\n');
            }
        }
        if !path.is_empty() {
            out.push(UnifiedChange {
                lane_id: lane_id.to_string(),
                path,
                body,
            });
        }
    }
    out
}

fn emit_wave(app: &AppHandle, state: &DispatcherState, wave_id: &str) {
    let snapshot = match state.waves.lock().unwrap().get(wave_id).cloned() {
        Some(s) => s,
        None => return,
    };
    let event = format!("orchestrator-wave:{wave_id}");
    let _ = app.emit(&event, &snapshot);
}

/// Emit the wave that owns `lane_id`, after an external update changed it.
fn emit_lane_wave(app: &AppHandle, state: &DispatcherState, lane_id: &str) {
    let wave_id = state
        .inner
        .lock()
        .unwrap()
        .get(lane_id)
        .map(|e| e.outcome.wave_id.clone());
    if let Some(w) = wave_id {
        emit_wave(app, state, &w);
    }
}

// ── External (CLI-driven) lane drivers ──────────────────────────────────────
//
// The loop runner shells the bundled `aura crew run` CLI (a real coding agent
// that edits + commits) and re-broadcasts its progress through these, so an
// external lane streams to `CrewLiveTranscript` exactly like a brain lane. Each
// keeps the wave-registry snapshot consistent with the live lane entry and then
// emits `orchestrator-wave:<id>` so the frontend re-renders without polling.

/// The CLI started working this lane's node — flip it Running, stamp the agent,
/// and broadcast.
pub fn external_lane_started(app: &AppHandle, state: &DispatcherState, lane_id: &str, agent: &str) {
    state.external_lane_running(lane_id, agent);
    sync_wave_from_lanes(state, lane_id);
    emit_lane_wave(app, state, lane_id);
}

/// Append a chunk of the agent's live output to this lane's transcript and
/// broadcast.
pub fn external_lane_push(app: &AppHandle, state: &DispatcherState, lane_id: &str, text: &str) {
    push_transcript(state, lane_id, text);
    sync_wave_from_lanes(state, lane_id);
    emit_lane_wave(app, state, lane_id);
}

/// The CLI finished this lane's node cleanly — record the summary and broadcast.
pub fn external_lane_done(app: &AppHandle, state: &DispatcherState, lane_id: &str, summary: String) {
    mark_lane_done(state, lane_id, summary);
    emit_lane_wave(app, state, lane_id);
}

/// The CLI failed this lane's node — record the reason and broadcast.
pub fn external_lane_failed(app: &AppHandle, state: &DispatcherState, lane_id: &str, error: String) {
    mark_lane_failed(state, lane_id, error);
    emit_lane_wave(app, state, lane_id);
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Dispatch a wave. Returns the `WaveOutcome` populated with one
/// `LaneOutcome` per lane (Queued or Conflict at this point — running
/// lanes flip to Running inside their tokio task). Subscribe to
/// `orchestrator-wave:<wave_id>` for live updates as lanes progress.
///
/// This is the only public entry into the dispatcher from Tauri-land —
/// `orchestrator_dispatch_wave` in `cmd_orchestrator.rs` wraps it and
/// the in-process scheduler in `tick.rs` calls it after `compute_tick`.
pub fn dispatch_wave(
    app: AppHandle,
    state: Arc<DispatcherState>,
    plan: WavePlan,
) -> WaveOutcome {
    let mgr = BrainManager::from_disk();
    let mut outcomes: Vec<LaneOutcome> = Vec::with_capacity(plan.lanes.len());
    let mut conflicts: Vec<ZoneConflict> = vec![];
    // Cache of lane_id → zones for the conflict detector.
    let mut lane_zones: Vec<(String, Vec<String>)> = Vec::with_capacity(plan.lanes.len());

    // Phase 1: mint a LaneOutcome for every spec and detect conflicts
    // up-front. A conflict-held lane goes straight to Conflict and is
    // NOT spawned — the user can cancel sibling lanes or retry later.
    for spec in &plan.lanes {
        let lane_id = Uuid::new_v4().to_string();
        let mut status = LaneStatus::Queued;
        let mut blocker_id: Option<String> = None;
        let mut blocker_zone: Option<String> = None;
        for (other_id, other_zones) in &lane_zones {
            for z in &spec.zones {
                for oz in other_zones {
                    if zones_overlap(z, oz) {
                        status = LaneStatus::Conflict;
                        blocker_id = Some(other_id.clone());
                        blocker_zone = Some(z.clone());
                        break;
                    }
                }
                if blocker_id.is_some() {
                    break;
                }
            }
            if blocker_id.is_some() {
                break;
            }
        }
        if let (Some(b), Some(z)) = (blocker_id, blocker_zone) {
            conflicts.push(ZoneConflict {
                lane_id: lane_id.clone(),
                blocker_lane_id: b,
                zone: z,
            });
        }
        let outcome = LaneOutcome {
            lane_id: lane_id.clone(),
            wave_id: plan.wave_id.clone(),
            spec: spec.clone(),
            status,
            provider_id: None,
            transcript: String::new(),
            summary: None,
            error: None,
            started_at: now_secs(),
            completed_at: None,
            transcript_tokens: 0,
            summary_tokens: 0,
            saved_tokens: 0,
        };
        outcomes.push(outcome);
        lane_zones.push((lane_id, spec.zones.clone()));
    }

    // Pre-seed the wave registry so streaming tasks can write back
    // through `sync_wave_from_lanes` as they progress.
    state.waves.lock().unwrap().insert(
        plan.wave_id.clone(),
        WaveOutcome {
            wave_id: plan.wave_id.clone(),
            lanes: outcomes.clone(),
            conflicts: conflicts.clone(),
            unified_changes: vec![],
            tokens: TokenLedger::default(),
        },
    );

    // Phase 2: spawn the non-conflict lanes.
    for (idx, spec) in plan.lanes.iter().enumerate() {
        let outcome = &outcomes[idx];
        if matches!(outcome.status, LaneStatus::Conflict) {
            state.inner.lock().unwrap().insert(
                outcome.lane_id.clone(),
                LaneEntry {
                    outcome: outcome.clone(),
                    handle: None,
                },
            );
            continue;
        }
        let (provider_id, brain) = match resolve_brain(spec, &mgr) {
            Ok(t) => t,
            Err(e) => {
                let mut failed = outcome.clone();
                failed.status = LaneStatus::Failed;
                failed.error = Some(format!("brain resolution: {e}"));
                failed.completed_at = Some(now_secs());
                state.inner.lock().unwrap().insert(
                    failed.lane_id.clone(),
                    LaneEntry {
                        outcome: failed.clone(),
                        handle: None,
                    },
                );
                continue;
            }
        };
        let mut running = outcome.clone();
        running.status = LaneStatus::Running;
        running.provider_id = Some(provider_id.clone());
        state.inner.lock().unwrap().insert(
            running.lane_id.clone(),
            LaneEntry {
                outcome: running.clone(),
                handle: None,
            },
        );
        let request = build_request(spec);
        let handle = spawn_lane(
            app.clone(),
            state.clone(),
            plan.wave_id.clone(),
            running.lane_id.clone(),
            brain,
            request,
        );
        if let Some(entry) = state.inner.lock().unwrap().get_mut(&running.lane_id) {
            entry.handle = Some(handle);
        }
    }

    // Phase 3: re-snapshot the wave from the now-populated lane
    // registry so the caller's returned `WaveOutcome` carries the
    // post-spawn statuses (Running instead of Queued).
    let final_lanes: Vec<LaneOutcome> = outcomes
        .iter()
        .filter_map(|o| state.inner.lock().unwrap().get(&o.lane_id).map(|e| e.outcome.clone()))
        .collect();
    let wave = WaveOutcome {
        wave_id: plan.wave_id.clone(),
        lanes: final_lanes.clone(),
        conflicts: conflicts.clone(),
        unified_changes: vec![],
        tokens: TokenLedger::default(),
    };
    state
        .waves
        .lock()
        .unwrap()
        .insert(plan.wave_id.clone(), wave.clone());
    emit_wave(&app, &state, &plan.wave_id);
    wave
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zones_overlap_segment_aware() {
        assert!(zones_overlap("app/page.tsx", "app/page.tsx"));
        assert!(zones_overlap("src/lib", "src/lib/api.ts"));
        assert!(!zones_overlap("src/lib", "src/library/api.ts"));
        assert!(!zones_overlap("", "anything"));
        assert!(zones_overlap("aura-shell/src/**", "aura-shell/src/components/foo.ts"));
    }

    #[test]
    fn conflict_detector_marks_overlapping_lanes() {
        // Build a wave with two lanes touching the same file and one
        // disjoint lane. Phase 1 should mark the second as Conflict
        // pointing at the first's lane_id; the third stays Queued.
        let plan = WavePlan {
            wave_id: "w1".into(),
            lanes: vec![
                LaneSpec {
                    objective: "lane A".into(),
                    zones: vec!["app/page.tsx".into()],
                    mode: None,
                    brain_override: None,
                    taxonomy: None,
                    label: None,
                },
                LaneSpec {
                    objective: "lane B".into(),
                    zones: vec!["app/page.tsx".into()],
                    mode: None,
                    brain_override: None,
                    taxonomy: None,
                    label: None,
                },
                LaneSpec {
                    objective: "lane C".into(),
                    zones: vec!["src/foo.ts".into()],
                    mode: None,
                    brain_override: None,
                    taxonomy: None,
                    label: None,
                },
            ],
        };
        // Replicate phase 1 inline (no app handle needed for the pure
        // conflict-detection logic).
        let mut outcomes: Vec<LaneOutcome> = vec![];
        let mut conflicts: Vec<ZoneConflict> = vec![];
        let mut lane_zones: Vec<(String, Vec<String>)> = vec![];
        for spec in &plan.lanes {
            let lane_id = Uuid::new_v4().to_string();
            let mut status = LaneStatus::Queued;
            let mut blocker_id: Option<String> = None;
            let mut blocker_zone: Option<String> = None;
            for (other_id, other_zones) in &lane_zones {
                for z in &spec.zones {
                    for oz in other_zones {
                        if zones_overlap(z, oz) {
                            status = LaneStatus::Conflict;
                            blocker_id = Some(other_id.clone());
                            blocker_zone = Some(z.clone());
                            break;
                        }
                    }
                    if blocker_id.is_some() {
                        break;
                    }
                }
                if blocker_id.is_some() {
                    break;
                }
            }
            if let (Some(b), Some(z)) = (blocker_id.clone(), blocker_zone.clone()) {
                conflicts.push(ZoneConflict {
                    lane_id: lane_id.clone(),
                    blocker_lane_id: b,
                    zone: z,
                });
            }
            outcomes.push(LaneOutcome {
                lane_id: lane_id.clone(),
                wave_id: plan.wave_id.clone(),
                spec: spec.clone(),
                status,
                provider_id: None,
                transcript: String::new(),
                summary: None,
                error: None,
                started_at: 0,
                completed_at: None,
                transcript_tokens: 0,
                summary_tokens: 0,
                saved_tokens: 0,
            });
            lane_zones.push((lane_id, spec.zones.clone()));
        }
        assert_eq!(outcomes.len(), 3);
        assert!(matches!(outcomes[0].status, LaneStatus::Queued));
        assert!(matches!(outcomes[1].status, LaneStatus::Conflict));
        assert!(matches!(outcomes[2].status, LaneStatus::Queued));
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].lane_id, outcomes[1].lane_id);
        assert_eq!(conflicts[0].blocker_lane_id, outcomes[0].lane_id);
        assert_eq!(conflicts[0].zone, "app/page.tsx");
    }

    #[test]
    fn extract_changes_parses_marker_blocks() {
        let summary = "
prose first
### CHANGE src/foo.ts
```
const x = 1;
```
between
### CHANGE src/bar.ts
```
const y = 2;
```
trailing
";
        let out = extract_changes("lane-1", summary);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].path, "src/foo.ts");
        assert!(out[0].body.contains("const x = 1;"));
        assert_eq!(out[1].path, "src/bar.ts");
        assert!(out[1].body.contains("const y = 2;"));
        assert_eq!(out[0].lane_id, "lane-1");
    }

    #[test]
    fn cancel_lane_marks_terminal() {
        let state = DispatcherState::new();
        let lane = LaneOutcome {
            lane_id: "l1".into(),
            wave_id: "w1".into(),
            spec: LaneSpec {
                objective: "x".into(),
                zones: vec![],
                mode: None,
                brain_override: None,
                taxonomy: None,
                label: None,
            },
            status: LaneStatus::Running,
            provider_id: None,
            transcript: String::new(),
            summary: None,
            error: None,
            started_at: 0,
            completed_at: None,
            transcript_tokens: 0,
            summary_tokens: 0,
            saved_tokens: 0,
        };
        state.inner.lock().unwrap().insert(
            "l1".into(),
            LaneEntry {
                outcome: lane,
                handle: None,
            },
        );
        assert!(state.cancel_lane("l1"));
        let after = state.lane_status("l1").unwrap();
        assert!(matches!(after.status, LaneStatus::Cancelled));
        // Second cancel is a no-op (already terminal).
        assert!(!state.cancel_lane("l1"));
    }

    #[test]
    fn default_preamble_includes_zones() {
        let spec = LaneSpec {
            objective: "do it".into(),
            zones: vec!["src/a.ts".into(), "src/b.ts".into()],
            mode: None,
            brain_override: None,
            taxonomy: None,
            label: None,
        };
        let p = default_orchestrator_preamble(&spec);
        assert!(p.contains("src/a.ts"));
        assert!(p.contains("src/b.ts"));
    }

    fn lane_with_tokens(status: LaneStatus, transcript: u32, summary: u32) -> LaneOutcome {
        LaneOutcome {
            lane_id: Uuid::new_v4().to_string(),
            wave_id: "w".into(),
            spec: LaneSpec {
                objective: "x".into(),
                zones: vec![],
                mode: None,
                brain_override: None,
                taxonomy: None,
                label: None,
            },
            status,
            provider_id: None,
            transcript: String::new(),
            summary: None,
            error: None,
            started_at: 0,
            completed_at: None,
            transcript_tokens: transcript,
            summary_tokens: summary,
            saved_tokens: transcript.saturating_sub(summary),
        }
    }

    #[test]
    fn wave_ledger_sums_done_lanes_and_prices_overhead() {
        let lanes = vec![
            lane_with_tokens(LaneStatus::Done, 1000, 120),
            lane_with_tokens(LaneStatus::Done, 500, 80),
            // A still-running lane contributes overhead but no settled
            // transcript/summary figures yet.
            lane_with_tokens(LaneStatus::Running, 0, 0),
        ];
        let led = compute_wave_ledger(&lanes);
        assert_eq!(led.lane_count, 3, "every dispatched lane counts");
        assert_eq!(led.done_lanes, 2);
        assert_eq!(led.transcript_tokens, 1500);
        assert_eq!(led.summary_tokens, 200);
        assert_eq!(led.saved_tokens, 1300, "Σ(transcript − summary) over Done lanes");
        assert_eq!(led.overhead_tokens, 3 * LANE_PREAMBLE_TOKENS_EST);
    }

    #[test]
    fn wave_ledger_empty_is_zero() {
        let led = compute_wave_ledger(&[]);
        assert_eq!(led.lane_count, 0);
        assert_eq!(led.saved_tokens, 0);
        assert_eq!(led.overhead_tokens, 0);
    }
}
