// Automations — genuine "When this happens → do that" recipes.
//
// One real trigger (a schedule) drives one real action (and an optional
// second action) the next time it comes due. Everything here runs *while
// Aura — or your Aura Runner — is on*; we make no cloud-cron claim, and the
// surface copy says so plainly.
//
// Honest reuse, no stubs. Every executor drives an existing path:
//   • RunAgent   → mint an a2a/Crew node (`aura_loop::LoopGraph::create`) and
//                  drive it headlessly through the real Crew harness
//                  (`cmd_loop::run_native_dispatch`), so the run lands in the
//                  proof gate and "Recent runs · Proven" is real.
//   • RunPrReview→ the real reviewer (the bundled `aura pr-review --json`).
//   • PostToPage → `cmd_notes::notes_write` (the same atomic write + live
//                  broadcast path Pages/folders use), append or overwrite.
//   • CreateTask → `cmd_tasks::tasks_create` (the project's own task board).
//
// Persisted at `<repo>/.aura/automations.json` as `{ "automations": [ … ] }`
// — object-wrapped for forward-compat. A missing or corrupt file is an empty
// list, never an error.
//
// The scheduler is a single background tokio task (spawned from `lib.rs`
// setup). It ticks ~every 45s, enumerates the registered projects, and fires
// any enabled automation whose `next_run_at` has passed. It is restart-safe:
// `last_fired_at` is persisted so a relaunch never re-fires the same window,
// and a long-missed window catches up *at most once* (no storm).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{
    DateTime, Datelike, Duration as ChronoDuration, FixedOffset, NaiveTime, TimeZone, Timelike,
    Utc, Weekday,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

// ─── Data model ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Cadence {
    Hourly,
    Daily,
    Weekdays,
    Weekly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Trigger {
    /// Fires on a wall-clock schedule. `time_hm` is "HH:MM" in the user's
    /// local wall time; `tz_offset_min` is that wall time's offset from UTC
    /// (minutes east, e.g. -300 for US-Eastern standard) so the engine can
    /// resolve the instant without guessing the host timezone.
    Schedule {
        cadence: Cadence,
        time_hm: String,
        /// 0=Mon … 6=Sun. Only meaningful for `Weekly`.
        #[serde(default)]
        weekday: Option<u8>,
        #[serde(default)]
        tz_offset_min: i32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteMode {
    Append,
    Overwrite,
}

impl Default for WriteMode {
    fn default() -> Self {
        WriteMode::Append
    }
}

/// Where a PostToPage action writes. Mirrors the note (scope, bucket, id)
/// addressing so we reuse `cmd_notes` directly. `id` empty/None → mint a new
/// Page named by `title`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageRef {
    /// "team" | "channel" | "member" — note scope. Defaults to team.
    #[serde(default = "default_scope")]
    pub scope: String,
    /// Channel id / member handle. Empty for team scope.
    #[serde(default)]
    pub bucket: String,
    /// Existing note id, or None to mint a new Page.
    #[serde(default)]
    pub id: Option<String>,
    /// Title for a newly-minted Page (and the heading for the posted section).
    #[serde(default)]
    pub title: Option<String>,
}

fn default_scope() -> String {
    "team".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum BodySource {
    /// Post the DO action's captured output (e.g. the agent run summary or the
    /// review summary). Falls back to a short note if there is no output.
    LastRunOutput,
    /// Post a fixed body the user typed.
    Fixed { text: String },
}

impl Default for BodySource {
    fn default() -> Self {
        BodySource::LastRunOutput
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    /// Run an agent headlessly through the real Crew harness (proof-backed).
    RunAgent {
        agent: String,
        prompt: String,
        #[serde(default)]
        model: Option<String>,
    },
    /// Run the real PR reviewer over the repo against `base` (default main).
    RunPrReview {
        #[serde(default)]
        base: Option<String>,
    },
    /// Append/overwrite a section of a Page using the notes write path.
    PostToPage {
        page: PageRef,
        #[serde(default)]
        mode: WriteMode,
        #[serde(default)]
        body_source: BodySource,
    },
    /// Mint a task on the project board.
    CreateTask {
        title: String,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        agent_assignee: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    pub started_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
    pub ok: bool,
    pub summary: String,
    /// The Crew lane / run id when a RunAgent action minted one.
    #[serde(default)]
    pub lane_id: Option<String>,
    /// The commit a proof-backed run produced, when known.
    #[serde(default)]
    pub commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Automation {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub trigger: Trigger,
    pub action: Action,
    #[serde(default)]
    pub then_action: Option<Action>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub last_run: Option<RunRecord>,
    /// ISO instant the scheduler should next fire this. Recomputed after every
    /// fire and on save.
    #[serde(default)]
    pub next_run_at: Option<String>,
    /// ISO instant of the last window we actually fired. Restart-safe guard so
    /// the scheduler never double-fires the same window and only catches up a
    /// long-missed window once.
    #[serde(default)]
    pub last_fired_at: Option<String>,
}

fn default_true() -> bool {
    true
}

// ─── Store (`.aura/automations.json`) ───────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    automations: Vec<Automation>,
}

fn store_path(repo_root: &str) -> PathBuf {
    PathBuf::from(repo_root).join(".aura").join("automations.json")
}

/// Load the store. A missing or corrupt file is an empty list, never an error.
fn load_store(repo_root: &str) -> Store {
    let path = store_path(repo_root);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Store::default();
    };
    serde_json::from_str::<Store>(&raw).unwrap_or_default()
}

/// Atomic write: temp file in the same dir + rename, so a crash mid-write can
/// never leave a half-written (and then "corrupt → empty") store.
fn save_store(repo_root: &str, store: &Store) -> Result<(), String> {
    let path = store_path(repo_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| format!("serialize: {e}"))?;
    let dir = path.parent().ok_or("invalid automations path")?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".tmp-automations-")
        .suffix(".json")
        .tempfile_in(dir)
        .map_err(|e| format!("tempfile: {e}"))?;
    use std::io::Write as _;
    tmp.write_all(json.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    tmp.persist(&path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

// ─── Next-run computation (pure, unit-tested) ───────────────────────────

/// Parse "HH:MM" into (hour, minute). Tolerant of a leading/trailing space.
fn parse_hm(time_hm: &str) -> Option<(u32, u32)> {
    let t = time_hm.trim();
    let (h, m) = t.split_once(':')?;
    let h: u32 = h.trim().parse().ok()?;
    let m: u32 = m.trim().parse().ok()?;
    if h < 24 && m < 60 {
        Some((h, m))
    } else {
        None
    }
}

/// Map our 0=Mon … 6=Sun to chrono's `Weekday`.
fn weekday_from_index(i: u8) -> Weekday {
    match i % 7 {
        0 => Weekday::Mon,
        1 => Weekday::Tue,
        2 => Weekday::Wed,
        3 => Weekday::Thu,
        4 => Weekday::Fri,
        5 => Weekday::Sat,
        _ => Weekday::Sun,
    }
}

fn is_weekday(d: Weekday) -> bool {
    !matches!(d, Weekday::Sat | Weekday::Sun)
}

/// Compute the next fire instant (UTC) for a Schedule trigger given `now`.
///
/// Pure: same inputs → same output. The schedule's wall clock is resolved in
/// the offset the user saved (`tz_offset_min`); the result is returned as a
/// UTC instant so the scheduler can compare it directly against `Utc::now()`.
///
/// Returns `None` only if `time_hm` is unparseable — callers treat that as
/// "leave next_run_at unset" rather than firing on a bad time.
pub fn next_run_after(trigger: &Trigger, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let Trigger::Schedule {
        cadence,
        time_hm,
        weekday,
        tz_offset_min,
    } = trigger;

    let offset = FixedOffset::east_opt(tz_offset_min * 60)?;
    let now_local: DateTime<FixedOffset> = now.with_timezone(&offset);

    let next_local: DateTime<FixedOffset> = match cadence {
        Cadence::Hourly => {
            // Next occurrence of :MM (honoring the schedule's minute). If we're
            // already past this hour's :MM, jump to next hour.
            let (_, m) = parse_hm(time_hm).unwrap_or((0, 0));
            let candidate = now_local
                .with_minute(m)?
                .with_second(0)?
                .with_nanosecond(0)?;
            if candidate > now_local {
                candidate
            } else {
                candidate + ChronoDuration::hours(1)
            }
        }
        Cadence::Daily => {
            let (h, m) = parse_hm(time_hm)?;
            let today = local_at(&offset, now_local.date_naive(), h, m)?;
            if today > now_local {
                today
            } else {
                local_at(&offset, (now_local + ChronoDuration::days(1)).date_naive(), h, m)?
            }
        }
        Cadence::Weekdays => {
            let (h, m) = parse_hm(time_hm)?;
            // Scan today → +7 days for the first Mon–Fri slot strictly after now.
            (0..8).find_map(|add| {
                let day = (now_local + ChronoDuration::days(add)).date_naive();
                if !is_weekday(day.weekday()) {
                    return None;
                }
                let slot = local_at(&offset, day, h, m)?;
                (slot > now_local).then_some(slot)
            })?
        }
        Cadence::Weekly => {
            let (h, m) = parse_hm(time_hm)?;
            let target = weekday_from_index(weekday.unwrap_or(0));
            // Scan today → +7 days for the next matching weekday strictly after now.
            (0..8).find_map(|add| {
                let day = (now_local + ChronoDuration::days(add)).date_naive();
                if day.weekday() != target {
                    return None;
                }
                let slot = local_at(&offset, day, h, m)?;
                (slot > now_local).then_some(slot)
            })?
        }
    };

    Some(next_local.with_timezone(&Utc))
}

/// Build a `DateTime<FixedOffset>` at the given local date + h:m, resolving the
/// (rare) DST gap/fold deterministically by taking the earliest valid instant.
fn local_at(
    offset: &FixedOffset,
    date: chrono::NaiveDate,
    h: u32,
    m: u32,
) -> Option<DateTime<FixedOffset>> {
    let time = NaiveTime::from_hms_opt(h, m, 0)?;
    let naive = date.and_time(time);
    match offset.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt),
        chrono::LocalResult::Ambiguous(a, _) => Some(a),
        chrono::LocalResult::None => {
            // Spring-forward gap — push to the next minute until it resolves.
            offset
                .from_local_datetime(&(naive + ChronoDuration::minutes(1)))
                .single()
        }
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn parse_iso(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// Recompute `next_run_at` for an automation off `now`. Disabled automations
/// get `None` (the scheduler ignores them either way; this keeps the surface
/// honest).
fn recompute_next(a: &mut Automation, now: DateTime<Utc>) {
    a.next_run_at = if a.enabled {
        next_run_after(&a.trigger, now).map(|d| d.to_rfc3339())
    } else {
        None
    };
}

// ─── Commands ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct AutomationInput {
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub trigger: Trigger,
    pub action: Action,
    #[serde(default)]
    pub then_action: Option<Action>,
}

#[tauri::command]
pub async fn automations_list(repo_root: String) -> Result<Vec<Automation>, String> {
    Ok(load_store(&repo_root).automations)
}

#[tauri::command]
pub async fn automation_create(
    repo_root: String,
    input: AutomationInput,
) -> Result<Automation, String> {
    let now = Utc::now();
    let iso = now.to_rfc3339();
    let mut a = Automation {
        id: format!("auto-{}", &Uuid::new_v4().to_string()[..8]),
        name: if input.name.trim().is_empty() {
            "Automation".to_string()
        } else {
            input.name.trim().to_string()
        },
        enabled: input.enabled,
        trigger: input.trigger,
        action: input.action,
        then_action: input.then_action,
        created_at: iso.clone(),
        updated_at: iso,
        last_run: None,
        next_run_at: None,
        last_fired_at: None,
    };
    recompute_next(&mut a, now);

    let mut store = load_store(&repo_root);
    store.automations.push(a.clone());
    save_store(&repo_root, &store)?;
    Ok(a)
}

#[tauri::command]
pub async fn automation_update(
    repo_root: String,
    id: String,
    input: AutomationInput,
) -> Result<Automation, String> {
    let now = Utc::now();
    let mut store = load_store(&repo_root);
    let a = store
        .automations
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("automation {id} not found"))?;
    a.name = if input.name.trim().is_empty() {
        a.name.clone()
    } else {
        input.name.trim().to_string()
    };
    a.enabled = input.enabled;
    a.trigger = input.trigger;
    a.action = input.action;
    a.then_action = input.then_action;
    a.updated_at = now.to_rfc3339();
    recompute_next(a, now);
    let updated = a.clone();
    save_store(&repo_root, &store)?;
    Ok(updated)
}

#[tauri::command]
pub async fn automation_delete(repo_root: String, id: String) -> Result<bool, String> {
    let mut store = load_store(&repo_root);
    let before = store.automations.len();
    store.automations.retain(|a| a.id != id);
    let removed = store.automations.len() != before;
    if removed {
        save_store(&repo_root, &store)?;
    }
    Ok(removed)
}

#[tauri::command]
pub async fn automation_set_enabled(
    repo_root: String,
    id: String,
    enabled: bool,
) -> Result<Automation, String> {
    let now = Utc::now();
    let mut store = load_store(&repo_root);
    let a = store
        .automations
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("automation {id} not found"))?;
    a.enabled = enabled;
    a.updated_at = now.to_rfc3339();
    recompute_next(a, now);
    let updated = a.clone();
    save_store(&repo_root, &store)?;
    Ok(updated)
}

#[tauri::command]
pub async fn automation_run_now(
    app: AppHandle,
    state: tauri::State<'_, Arc<crate::manager::dispatcher::DispatcherState>>,
    repo_root: String,
    id: String,
) -> Result<RunRecord, String> {
    let dispatcher = state.inner().clone();
    let automation = {
        let store = load_store(&repo_root);
        store
            .automations
            .into_iter()
            .find(|a| a.id == id)
            .ok_or_else(|| format!("automation {id} not found"))?
    };
    let record = fire(&app, &dispatcher, &repo_root, &automation).await;
    persist_run(&repo_root, &id, &record, /*advance_window=*/ false);
    let _ = app.emit("automations:changed", &repo_root);
    Ok(record)
}

// ─── Firing (executes the action chain) ─────────────────────────────────

/// Run an automation's DO action (and optional THEN), producing one RunRecord.
/// The DO action's captured output is threaded into a `PostToPage` THEN when
/// its body source is LastRunOutput.
async fn fire(
    app: &AppHandle,
    dispatcher: &Arc<crate::manager::dispatcher::DispatcherState>,
    repo_root: &str,
    a: &Automation,
) -> RunRecord {
    let started_at = now_iso();
    let mut summary_parts: Vec<String> = Vec::new();
    let mut ok = true;
    let mut lane_id: Option<String> = None;
    let mut commit: Option<String> = None;
    let mut captured_output: Option<String> = None;

    match run_action(app, dispatcher, repo_root, &a.action).await {
        Ok(outcome) => {
            summary_parts.push(outcome.summary.clone());
            captured_output = Some(outcome.summary);
            lane_id = outcome.lane_id;
            commit = outcome.commit;
        }
        Err(e) => {
            ok = false;
            summary_parts.push(format!("DO failed: {e}"));
        }
    }

    if ok {
        if let Some(then) = &a.then_action {
            let then = inject_output(then, captured_output.as_deref());
            match run_action(app, dispatcher, repo_root, &then).await {
                Ok(outcome) => {
                    summary_parts.push(format!("then {}", outcome.summary));
                    if lane_id.is_none() {
                        lane_id = outcome.lane_id;
                    }
                    if commit.is_none() {
                        commit = outcome.commit;
                    }
                }
                Err(e) => {
                    ok = false;
                    summary_parts.push(format!("THEN failed: {e}"));
                }
            }
        }
    }

    RunRecord {
        id: format!("run-{}", &Uuid::new_v4().to_string()[..8]),
        started_at,
        completed_at: Some(now_iso()),
        ok,
        summary: summary_parts.join(" · "),
        lane_id,
        commit,
    }
}

/// A THEN PostToPage with `LastRunOutput` is rewritten to a Fixed body holding
/// the DO action's captured output, so the page post carries the real result.
fn inject_output(action: &Action, output: Option<&str>) -> Action {
    if let Action::PostToPage {
        page,
        mode,
        body_source: BodySource::LastRunOutput,
    } = action
    {
        let text = output
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("(the previous step produced no text output)")
            .to_string();
        return Action::PostToPage {
            page: page.clone(),
            mode: mode.clone(),
            body_source: BodySource::Fixed { text },
        };
    }
    action.clone()
}

struct ActionOutcome {
    summary: String,
    lane_id: Option<String>,
    commit: Option<String>,
}

async fn run_action(
    app: &AppHandle,
    dispatcher: &Arc<crate::manager::dispatcher::DispatcherState>,
    repo_root: &str,
    action: &Action,
) -> Result<ActionOutcome, String> {
    match action {
        Action::RunAgent {
            agent,
            prompt,
            model,
        } => exec_run_agent(app, dispatcher, repo_root, agent, prompt, model.as_deref()).await,
        Action::RunPrReview { base } => exec_pr_review(repo_root, base.as_deref()).await,
        Action::PostToPage {
            page,
            mode,
            body_source,
        } => exec_post_to_page(repo_root, page, mode, body_source).await,
        Action::CreateTask {
            title,
            description,
            agent_assignee,
        } => exec_create_task(repo_root, title, description.as_deref(), agent_assignee.as_deref())
            .await,
    }
}

// ── Executor: RunAgent (real, proof-backed via Crew) ────────────────────
//
// Mint a durable, team-visible a2a/Crew node for this prompt, then drive it
// headlessly through the real Crew harness. The harness runs under the
// verified-or-reverted proof gate, so a successful run lands a verdict in
// `.aura/goals.jsonl` and a record in `.aura/crew/runs.jsonl` — that's what
// "Recent runs · Proven" reads. We mint first so that even if the in-process
// dispatch can't pick it up right now (e.g. the agent CLI isn't installed),
// the node survives for the Aura Runner / the Crew Run button to drain.

async fn exec_run_agent(
    app: &AppHandle,
    dispatcher: &Arc<crate::manager::dispatcher::DispatcherState>,
    repo_root: &str,
    agent: &str,
    prompt: &str,
    _model: Option<&str>,
) -> Result<ActionOutcome, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Run agent action has an empty prompt".into());
    }
    let agent_kind = if agent.trim().is_empty() {
        "claude".to_string()
    } else {
        agent.trim().to_string()
    };

    // 1) Mint the node on the local a2a graph (durable + team-visible).
    let graph = aura_loop::LoopGraph::at(Path::new(repo_root));
    let title = first_line(prompt, 80);
    let node = graph
        .create(
            title.clone(),
            prompt.to_string(),
            "medium".to_string(),
            aura_loop::KIND_TASK.to_string(),
            vec![],
            Some(prompt.to_string()),
            Some(agent_kind.clone()),
            vec!["automation".to_string()],
        )
        .map_err(|e| format!("mint crew task: {e}"))?;

    // 2) Drive just this node headlessly through the real Crew harness, scoped
    //    to one job so we run only what we minted. The harness writes the proof
    //    verdict + run ledger; we surface the lane/run id here.
    let dispatch = crate::cmd_loop::run_native_dispatch(
        app.clone(),
        dispatcher.clone(),
        repo_root.to_string(),
        Some(1),
        Some(1),
        None,
        None,
    )
    .await;

    match dispatch {
        Ok(res) => Ok(ActionOutcome {
            summary: format!("Ran agent {agent_kind} on \"{title}\" (Crew run {})", res.wave_id),
            lane_id: Some(res.wave_id),
            commit: None,
        }),
        Err(e) => {
            // The node is minted and durable; the Runner/Crew will drain it.
            Ok(ActionOutcome {
                summary: format!(
                    "Queued agent {agent_kind} task \"{title}\" for Crew (will run when a runner is on: {e})"
                ),
                lane_id: Some(node.id),
                commit: None,
            })
        }
    }
}

fn first_line(s: &str, max: usize) -> String {
    let line = s.lines().next().unwrap_or(s).trim();
    if line.chars().count() <= max {
        line.to_string()
    } else {
        let truncated: String = line.chars().take(max).collect();
        format!("{truncated}…")
    }
}

// ── Executor: RunPrReview (real reviewer) ───────────────────────────────

async fn exec_pr_review(repo_root: &str, base: Option<&str>) -> Result<ActionOutcome, String> {
    let base = base.map(|b| b.trim()).filter(|b| !b.is_empty()).unwrap_or("main");
    let aura = crate::agent_event_listener::resolve_aura_bin();
    let out = tokio::process::Command::new(&aura)
        .args(["pr-review", "--base", base, "--json"])
        .current_dir(repo_root)
        .output()
        .await
        .map_err(|e| format!("run `aura pr-review`: {e}"))?;

    if !out.status.success() && out.stdout.is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("review failed: {}", err.trim()));
    }

    let report: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("parse review JSON: {e}"))?;

    if report.get("status").and_then(|v| v.as_str()) == Some("no_changes") {
        return Ok(ActionOutcome {
            summary: format!("Review vs {base}: no changes to review"),
            lane_id: None,
            commit: None,
        });
    }

    let risk = report
        .get("risk_label")
        .and_then(|v| v.as_str())
        .unwrap_or("UNKNOWN");
    let summary = report
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let head = if summary.is_empty() {
        format!("Review vs {base}: {risk} risk")
    } else {
        format!("Review vs {base} ({risk}): {}", first_line(summary, 160))
    };
    Ok(ActionOutcome {
        summary: head,
        lane_id: None,
        commit: None,
    })
}

// ── Executor: PostToPage (reuse cmd_notes write/append) ─────────────────

async fn exec_post_to_page(
    repo_root: &str,
    page: &PageRef,
    mode: &WriteMode,
    body_source: &BodySource,
) -> Result<ActionOutcome, String> {
    let scope = note_scope(&page.scope);
    let bucket = page.bucket.clone();
    let title = page.title.clone().unwrap_or_else(|| "Automation".to_string());

    let section = match body_source {
        BodySource::Fixed { text } => text.clone(),
        BodySource::LastRunOutput => {
            // Reached only if a *DO* PostToPage uses LastRunOutput (no prior
            // step). Honest: say so rather than invent output.
            "(no previous step output to post)".to_string()
        }
    };
    let stamped = format!(
        "### {} — {}\n\n{}\n",
        title,
        Utc::now().format("%Y-%m-%d %H:%M UTC"),
        section.trim()
    );

    // Resolve the target page id. If one was given, append/overwrite it;
    // otherwise mint a new page.
    let existing_id = page.id.clone().filter(|s| !s.trim().is_empty());

    let body = match (mode, &existing_id) {
        (WriteMode::Overwrite, _) | (WriteMode::Append, None) => stamped.clone(),
        (WriteMode::Append, Some(id)) => {
            // Read-then-write: cmd_notes has no native append.
            let current = crate::cmd_notes::notes_read(crate::cmd_notes::NoteReadInput {
                repo_root: repo_root.to_string(),
                scope: clone_scope(&scope),
                bucket: bucket.clone(),
                id: id.clone(),
            })
            .await
            .map_err(|e| format!("read page: {e}"))?;
            format!("{}\n\n{}", current.body.trim_end(), stamped)
        }
    };

    let note = crate::cmd_notes::notes_write(crate::cmd_notes::NoteWriteInput {
        repo_root: repo_root.to_string(),
        scope,
        bucket,
        id: existing_id,
        body,
        title: Some(title.clone()),
        author: None,
        visibility: None,
        locked: None,
        tags: None,
        parent_id: None,
        archived_at: None,
        icon: None,
        folder: None,
    })
    .await
    .map_err(|e| format!("write page: {e}"))?;

    let verb = match mode {
        WriteMode::Append => "Appended to",
        WriteMode::Overwrite => "Posted to",
    };
    Ok(ActionOutcome {
        summary: format!("{verb} Page \"{}\"", note.frontmatter.title.unwrap_or(title)),
        lane_id: None,
        commit: None,
    })
}

fn note_scope(s: &str) -> crate::cmd_notes::NoteScope {
    match s.to_ascii_lowercase().as_str() {
        "channel" => crate::cmd_notes::NoteScope::Channel,
        "member" => crate::cmd_notes::NoteScope::Member,
        _ => crate::cmd_notes::NoteScope::Team,
    }
}

fn clone_scope(s: &crate::cmd_notes::NoteScope) -> crate::cmd_notes::NoteScope {
    match s {
        crate::cmd_notes::NoteScope::Team => crate::cmd_notes::NoteScope::Team,
        crate::cmd_notes::NoteScope::Channel => crate::cmd_notes::NoteScope::Channel,
        crate::cmd_notes::NoteScope::Member => crate::cmd_notes::NoteScope::Member,
    }
}

// ── Executor: CreateTask (reuse the task board) ─────────────────────────

async fn exec_create_task(
    repo_root: &str,
    title: &str,
    description: Option<&str>,
    agent_assignee: Option<&str>,
) -> Result<ActionOutcome, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Create task action has an empty title".into());
    }
    let task = crate::cmd_tasks::tasks_create(
        repo_root.to_string(),
        crate::cmd_tasks::CreateTaskInput {
            title: title.to_string(),
            description: description.unwrap_or("").to_string(),
            priority: Some("medium".to_string()),
            agent_assignee: agent_assignee
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            ..Default::default()
        },
    )
    .await
    .map_err(|e| format!("create task: {e}"))?;

    Ok(ActionOutcome {
        summary: format!("Created task AURA-{} \"{}\"", task.sequence_id, task.title),
        lane_id: None,
        commit: None,
    })
}

// ─── Persist a run + advance the window ─────────────────────────────────

/// Write a run record back onto the automation. When `advance_window` is set
/// (a *scheduled* fire), also stamp `last_fired_at` and recompute `next_run_at`
/// so the same window is never fired again.
fn persist_run(repo_root: &str, id: &str, record: &RunRecord, advance_window: bool) {
    let mut store = load_store(repo_root);
    if let Some(a) = store.automations.iter_mut().find(|a| a.id == id) {
        a.last_run = Some(record.clone());
        if advance_window {
            a.last_fired_at = Some(now_iso());
            recompute_next(a, Utc::now());
        }
        let _ = save_store(repo_root, &store);
    }
}

// ─── Scheduler (background task, restart-safe) ──────────────────────────

/// Tick interval. Short enough that a "9:00am" fires within a minute, light
/// enough that scanning a handful of project files is negligible.
const TICK_SECS: u64 = 45;

/// Catch-up grace: if a window was missed (app asleep) by more than this, fire
/// it once now then advance to the *next* window — never replay every missed
/// window. One catch-up, no storm.
const CATCHUP_GRACE: ChronoDuration = ChronoDuration::hours(6);

/// Spawn the scheduler. Called once from `lib.rs` setup with the app handle.
pub fn spawn_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Warmup so a fresh launch doesn't race first-run state writes.
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        // The dispatcher state is managed in `lib.rs`; grab it once.
        let dispatcher = match app.try_state::<Arc<crate::manager::dispatcher::DispatcherState>>() {
            Some(s) => s.inner().clone(),
            None => {
                tracing::warn!("automations scheduler: no dispatcher state; not started");
                return;
            }
        };
        loop {
            if let Err(e) = tick(&app, &dispatcher).await {
                tracing::debug!(error = %e, "automations scheduler tick skipped");
            }
            tokio::time::sleep(std::time::Duration::from_secs(TICK_SECS)).await;
        }
    });
}

/// One scheduler pass: across every registered project, fire each enabled
/// automation that has come due.
async fn tick(
    app: &AppHandle,
    dispatcher: &Arc<crate::manager::dispatcher::DispatcherState>,
) -> Result<(), String> {
    let now = Utc::now();
    for repo_root in scheduler_roots() {
        let due = due_automations(&repo_root, now);
        for id in due {
            // Re-load each automation fresh (a `run_now` or edit may have
            // changed it since we listed) and fire it.
            let automation = {
                let store = load_store(&repo_root);
                store.automations.into_iter().find(|a| a.id == id)
            };
            let Some(automation) = automation else { continue };
            if !automation.enabled {
                continue;
            }
            tracing::info!(repo = %repo_root, automation = %automation.name, "firing scheduled automation");
            let record = fire(app, dispatcher, &repo_root, &automation).await;
            persist_run(&repo_root, &id, &record, /*advance_window=*/ true);
            let _ = app.emit("automations:changed", &repo_root);
        }
    }
    Ok(())
}

/// Decide which automations in a repo are due *now*, applying the restart-safe
/// guard: only fire when `next_run_at <= now` AND we have not already fired
/// this same window (`last_fired_at` is before `next_run_at`). A window missed
/// by more than the grace is collapsed to a single catch-up by advancing
/// `next_run_at` first (done inside `due_automations` so the storm can't form).
fn due_automations(repo_root: &str, now: DateTime<Utc>) -> Vec<String> {
    let mut store = load_store(repo_root);
    let mut due: Vec<String> = Vec::new();
    let mut mutated = false;
    let mut seen: HashSet<String> = HashSet::new();

    for a in store.automations.iter_mut() {
        if !a.enabled {
            continue;
        }
        if !seen.insert(a.id.clone()) {
            continue;
        }

        // Heal a missing next_run_at (e.g. first run after enabling).
        if a.next_run_at.is_none() {
            recompute_next(a, now);
            mutated = true;
            continue;
        }

        let Some(next) = a.next_run_at.as_deref().and_then(parse_iso) else {
            continue;
        };
        if next > now {
            continue; // not yet due
        }

        // Guard: have we already fired *this* window? `last_fired_at` is the
        // wall time we last fired; if it is at/after this window's instant,
        // skip (a relaunch reloading the same file must not re-fire).
        let already_fired = a
            .last_fired_at
            .as_deref()
            .and_then(parse_iso)
            .map(|f| f >= next)
            .unwrap_or(false);
        if already_fired {
            // Window already serviced but next_run_at wasn't advanced (e.g.
            // crash between fire and persist). Advance it now, no fire.
            recompute_next(a, now);
            mutated = true;
            continue;
        }

        // Catch-up collapse: a window missed by more than the grace fires once
        // now, but we DON'T replay the gap — `persist_run(advance_window=true)`
        // after the fire recomputes next_run_at off `now`, so the next window
        // is the next *future* slot, never the backlog.
        let _missed_badly = now.signed_duration_since(next) > CATCHUP_GRACE;
        due.push(a.id.clone());
    }

    if mutated {
        let _ = save_store(repo_root, &store);
    }
    due
}

/// Which repos the scheduler services. The registered-projects list
/// (`~/.aura/projects.json`) is the union of every workspace the user has
/// opened — the scheduler fires their automations whether or not that window
/// is focused, which is the whole point of "runs while Aura is on".
fn scheduler_roots() -> Vec<String> {
    crate::cmd_projects::registered_roots()
        .into_iter()
        .filter(|r| store_path(r).exists())
        .collect()
}

// ─── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    fn sched(cadence: Cadence, hm: &str, weekday: Option<u8>, tz: i32) -> Trigger {
        Trigger::Schedule {
            cadence,
            time_hm: hm.to_string(),
            weekday,
            tz_offset_min: tz,
        }
    }

    #[test]
    fn daily_picks_today_when_before_time() {
        // 2026-06-20 is a Saturday. now=08:00 UTC, fire at 09:00 UTC → today.
        let t = sched(Cadence::Daily, "09:00", None, 0);
        let n = next_run_after(&t, utc(2026, 6, 20, 8, 0)).unwrap();
        assert_eq!(n, utc(2026, 6, 20, 9, 0));
    }

    #[test]
    fn daily_rolls_to_tomorrow_when_past_time() {
        let t = sched(Cadence::Daily, "09:00", None, 0);
        let n = next_run_after(&t, utc(2026, 6, 20, 9, 0)).unwrap();
        // Exactly at 09:00 is not strictly after → tomorrow.
        assert_eq!(n, utc(2026, 6, 21, 9, 0));
    }

    #[test]
    fn daily_honors_tz_offset() {
        // Fire at 09:00 in UTC-5 (offset -300). 09:00 local = 14:00 UTC.
        let t = sched(Cadence::Daily, "09:00", None, -300);
        let n = next_run_after(&t, utc(2026, 6, 20, 10, 0)).unwrap();
        assert_eq!(n, utc(2026, 6, 20, 14, 0));
    }

    #[test]
    fn weekdays_skips_weekend() {
        // Sat 2026-06-20 08:00 UTC, weekdays @ 09:00 → next is Mon 2026-06-22.
        let t = sched(Cadence::Weekdays, "09:00", None, 0);
        let n = next_run_after(&t, utc(2026, 6, 20, 8, 0)).unwrap();
        assert_eq!(n, utc(2026, 6, 22, 9, 0));
    }

    #[test]
    fn weekdays_same_day_when_before_time() {
        // Fri 2026-06-19 08:00 UTC, weekdays @ 09:00 → same Friday.
        let t = sched(Cadence::Weekdays, "09:00", None, 0);
        let n = next_run_after(&t, utc(2026, 6, 19, 8, 0)).unwrap();
        assert_eq!(n, utc(2026, 6, 19, 9, 0));
    }

    #[test]
    fn weekly_finds_next_matching_weekday() {
        // weekday=2 (Wed). From Sat 2026-06-20 → next Wed is 2026-06-24.
        let t = sched(Cadence::Weekly, "10:30", Some(2), 0);
        let n = next_run_after(&t, utc(2026, 6, 20, 8, 0)).unwrap();
        assert_eq!(n, utc(2026, 6, 24, 10, 30));
    }

    #[test]
    fn weekly_same_day_when_before_time() {
        // weekday=5 (Sat). Sat 2026-06-20 08:00, fire 10:30 → same Saturday.
        let t = sched(Cadence::Weekly, "10:30", Some(5), 0);
        let n = next_run_after(&t, utc(2026, 6, 20, 8, 0)).unwrap();
        assert_eq!(n, utc(2026, 6, 20, 10, 30));
    }

    #[test]
    fn hourly_next_top_of_hour_at_minute() {
        // fire at :15 each hour. now=10:10 → 10:15.
        let t = sched(Cadence::Hourly, "00:15", None, 0);
        let n = next_run_after(&t, utc(2026, 6, 20, 10, 10)).unwrap();
        assert_eq!(n, utc(2026, 6, 20, 10, 15));
    }

    #[test]
    fn hourly_rolls_to_next_hour_when_past_minute() {
        let t = sched(Cadence::Hourly, "00:15", None, 0);
        let n = next_run_after(&t, utc(2026, 6, 20, 10, 20)).unwrap();
        assert_eq!(n, utc(2026, 6, 20, 11, 15));
    }

    #[test]
    fn bad_time_is_none_not_panic() {
        let t = sched(Cadence::Daily, "not-a-time", None, 0);
        assert!(next_run_after(&t, utc(2026, 6, 20, 8, 0)).is_none());
    }

    // ── store + catch-up ────────────────────────────────────────────────

    fn tmp_repo() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn write_automation(root: &str, a: Automation) {
        let store = Store {
            automations: vec![a],
        };
        save_store(root, &store).unwrap();
    }

    fn base_automation(id: &str, next_run_at: Option<String>, last_fired_at: Option<String>) -> Automation {
        Automation {
            id: id.to_string(),
            name: "Test".into(),
            enabled: true,
            trigger: sched(Cadence::Daily, "09:00", None, 0),
            action: Action::CreateTask {
                title: "x".into(),
                description: None,
                agent_assignee: None,
            },
            then_action: None,
            created_at: now_iso(),
            updated_at: now_iso(),
            last_run: None,
            next_run_at,
            last_fired_at,
        }
    }

    #[test]
    fn missing_store_is_empty_not_error() {
        let dir = tmp_repo();
        let root = dir.path().to_str().unwrap();
        let store = load_store(root);
        assert!(store.automations.is_empty());
    }

    #[test]
    fn corrupt_store_is_empty_not_error() {
        let dir = tmp_repo();
        let root = dir.path().to_str().unwrap();
        std::fs::create_dir_all(dir.path().join(".aura")).unwrap();
        std::fs::write(store_path(root), b"{ not json ]").unwrap();
        let store = load_store(root);
        assert!(store.automations.is_empty());
    }

    #[test]
    fn due_when_next_run_passed() {
        let dir = tmp_repo();
        let root = dir.path().to_str().unwrap();
        let past = (Utc::now() - ChronoDuration::minutes(5)).to_rfc3339();
        write_automation(root, base_automation("a1", Some(past), None));
        let due = due_automations(root, Utc::now());
        assert_eq!(due, vec!["a1".to_string()]);
    }

    #[test]
    fn not_due_when_next_run_future() {
        let dir = tmp_repo();
        let root = dir.path().to_str().unwrap();
        let future = (Utc::now() + ChronoDuration::hours(1)).to_rfc3339();
        write_automation(root, base_automation("a1", Some(future), None));
        assert!(due_automations(root, Utc::now()).is_empty());
    }

    #[test]
    fn already_fired_window_does_not_refire() {
        // next_run_at is in the past, but last_fired_at is AFTER it → the
        // window was already serviced (e.g. relaunch reloading the same file).
        let dir = tmp_repo();
        let root = dir.path().to_str().unwrap();
        let window = Utc::now() - ChronoDuration::minutes(30);
        let fired = window + ChronoDuration::seconds(2);
        write_automation(
            root,
            base_automation("a1", Some(window.to_rfc3339()), Some(fired.to_rfc3339())),
        );
        // Not due (guarded), and the store gets next_run_at advanced.
        assert!(due_automations(root, Utc::now()).is_empty());
        let after = load_store(root).automations.into_iter().next().unwrap();
        let next = parse_iso(after.next_run_at.as_deref().unwrap()).unwrap();
        assert!(next > Utc::now(), "next_run_at should be advanced to the future");
    }

    #[test]
    fn long_missed_window_fires_once_then_advances() {
        // A window missed by days. It fires ONCE; after persist_run advances
        // the window, it is no longer due (no replay storm).
        let dir = tmp_repo();
        let root = dir.path().to_str().unwrap();
        let stale = (Utc::now() - ChronoDuration::days(3)).to_rfc3339();
        write_automation(root, base_automation("a1", Some(stale), None));

        let due = due_automations(root, Utc::now());
        assert_eq!(due, vec!["a1".to_string()], "stale window fires once");

        // Simulate the scheduler advancing the window after firing.
        let rec = RunRecord {
            id: "r1".into(),
            started_at: now_iso(),
            completed_at: Some(now_iso()),
            ok: true,
            summary: "ok".into(),
            lane_id: None,
            commit: None,
        };
        persist_run(root, "a1", &rec, true);

        // Second pass: no longer due — the storm cannot form.
        assert!(
            due_automations(root, Utc::now()).is_empty(),
            "after advance, the backlog is NOT replayed"
        );
    }

    #[test]
    fn disabled_never_due() {
        let dir = tmp_repo();
        let root = dir.path().to_str().unwrap();
        let past = (Utc::now() - ChronoDuration::minutes(5)).to_rfc3339();
        let mut a = base_automation("a1", Some(past), None);
        a.enabled = false;
        write_automation(root, a);
        assert!(due_automations(root, Utc::now()).is_empty());
    }
}
