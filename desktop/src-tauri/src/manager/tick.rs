//! Manager tick — pure scheduling logic.
//!
//! Given a `ManagerSession` plus a snapshot of in-flight task ids and
//! the agent registry, returns the set of tasks the caller should
//! dispatch right now. Honors:
//!
//!   * Dep-graph readiness: a task is ready iff every entry in
//!     `depends_on` is `Done`.
//!   * Per-kind cap (1 in flight per agent_id) and global cap (4).
//!   * Status filtering: only `Pending` tasks dispatch.
//!
//! Pure logic, no Tauri / tokio / IO — testable in isolation.

use std::collections::HashMap;

use aura_agents::{Registry, smart_pick};

use super::dispatcher::{LaneSpec, WavePlan};
use super::{ManagerSession, ManagerTaskStatus, PlanParallelism};

/// Two zones overlap if either is empty, they're exactly equal, or one
/// is a path-segment prefix of the other (so `src/lib` collides with
/// `src/lib/api.ts` but NOT `src/library/api.ts`). Trailing `**`, `*`
/// and `/` are stripped before comparing — this gives sane matching for
/// the common shapes plans declare (`app/page.tsx`, `src/components/`,
/// `aura-shell/src/components/manager/**`) without pulling globset.
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
        // Segment-aware: `src/lib` is a prefix of `src/lib/api.ts` (next
        // char is `/`) but NOT `src/library/api.ts` (next char is `r`).
        rest.starts_with('/')
    } else {
        false
    }
}

/// Return the id of the first in-flight task whose zones overlap any of
/// `cand_zones`. None when the candidate is free to dispatch.
fn first_zone_collision(
    session: &ManagerSession,
    in_flight: &HashMap<usize, String>,
    cand_zones: &[String],
) -> Option<usize> {
    if cand_zones.is_empty() {
        return None;
    }
    for t in &session.tasks {
        if !in_flight.contains_key(&t.id) {
            continue;
        }
        for cz in cand_zones {
            for tz in &t.zones {
                if zones_overlap(cz, tz) {
                    return Some(t.id);
                }
            }
        }
    }
    None
}

pub const PER_KIND_CAP: usize = 1;
pub const GLOBAL_CAP: usize = 4;

/// One scheduling decision the loop should act on this tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dispatch {
    pub task_id: usize,
    pub provider_id: String,
}

/// Output of one tick. `dispatches` is the set of tasks that should
/// fire this tick. `zone_blocks` is `task_id -> blocker_id` for tasks
/// that were skipped because their zones overlap an in-flight task —
/// the loop applies a transient `blocked_reason` so the DAG shows the
/// collision; on a subsequent tick when the blocker completes the
/// reason clears automatically.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TickOutput {
    pub dispatches: Vec<Dispatch>,
    pub zone_blocks: HashMap<usize, usize>,
}

/// Compute the dispatch set. `in_flight` is `task_id -> provider_id`
/// for tasks the runtime has already spawned but not yet observed
/// completion for; the loop tracks this externally so we don't
/// double-spawn while the previous tick's agents are still running.
pub fn compute_dispatches(
    session: &ManagerSession,
    in_flight: &HashMap<usize, String>,
    registry: &Registry,
) -> Vec<Dispatch> {
    compute_tick(session, in_flight, registry).dispatches
}

/// Like `compute_dispatches` but also reports zone-collision blocks so
/// the loop can paint `blocked_reason` for the user. Pure logic.
pub fn compute_tick(
    session: &ManagerSession,
    in_flight: &HashMap<usize, String>,
    registry: &Registry,
) -> TickOutput {
    if session.tasks.is_empty() {
        return TickOutput::default();
    }

    let done: std::collections::HashSet<usize> = session
        .tasks
        .iter()
        .filter(|t| matches!(
            t.status,
            ManagerTaskStatus::Done | ManagerTaskStatus::Skipped
        ))
        .map(|t| t.id)
        .collect();

    let mut per_kind: HashMap<String, usize> = HashMap::new();
    for pid in in_flight.values() {
        *per_kind.entry(pid.clone()).or_default() += 1;
    }
    let mut global = in_flight.len();

    // Bucket D2 — `Serial` mode hard-caps concurrency at 1 even when
    // zones are disjoint. We honour `Parallel` by skipping the
    // zone-overlap check below; per-kind + global caps still apply so
    // a single Parallel plan can't fork-bomb the registry.
    let mode = session.plan_parallelism;
    let serial_blocked = matches!(mode, PlanParallelism::Serial) && global > 0;

    let mut out = vec![];
    let mut zone_blocks: HashMap<usize, usize> = HashMap::new();
    if serial_blocked {
        return TickOutput { dispatches: out, zone_blocks };
    }
    for task in &session.tasks {
        if global >= GLOBAL_CAP {
            break;
        }
        if matches!(mode, PlanParallelism::Serial) && global > 0 {
            // Already scheduled one this tick; the rest wait.
            break;
        }
        if !matches!(task.status, ManagerTaskStatus::Pending) {
            continue;
        }
        if in_flight.contains_key(&task.id) {
            continue;
        }
        if !task.depends_on.iter().all(|d| done.contains(d)) {
            continue;
        }
        if task.blocked_reason.is_some() {
            continue;
        }
        // Zone collision check (Auto only). Parallel ignores overlaps —
        // the user has signed off on concurrent worktrees racing each
        // other and accepts the merge fallout. Serial never gets here
        // because the global > 0 guard above already short-circuits.
        if matches!(mode, PlanParallelism::Auto) {
            if let Some(blocker_id) = first_zone_collision(session, in_flight, &task.zones) {
                zone_blocks.insert(task.id, blocker_id);
                continue;
            }
        }
        let pid = match resolve_provider(task, registry) {
            Some(p) => p,
            None => continue,
        };
        let count = per_kind.get(&pid).copied().unwrap_or(0);
        if count >= PER_KIND_CAP {
            continue;
        }
        out.push(Dispatch { task_id: task.id, provider_id: pid.clone() });
        *per_kind.entry(pid).or_default() += 1;
        global += 1;
    }
    TickOutput { dispatches: out, zone_blocks }
}

/// v0.2.31 LL.1 — convert a tick's dispatches into a `WavePlan` for the
/// orchestrator dispatcher. The legacy loop still owns the per-task
/// `spawn_task` path (PTY-wrapped CLIs, worktree creation, etc.); the
/// orchestrator path is opt-in for sessions whose `pending_plan` was
/// approved in `Parallel` mode. The two co-exist — `spawn_task` keeps
/// running for sessions that aren't using the orchestrator surface.
///
/// `wave_id` is owned by the caller (typically the manager session
/// id + tick counter) so reentrant ticks don't collide.
pub fn wave_plan_from_dispatches(
    session: &ManagerSession,
    dispatches: &[Dispatch],
    wave_id: String,
) -> WavePlan {
    let lanes: Vec<LaneSpec> = dispatches
        .iter()
        .filter_map(|d| {
            let task = session.task(d.task_id)?;
            Some(LaneSpec {
                objective: task.description.clone(),
                zones: task.zones.clone(),
                mode: None,
                // The provider was already resolved in `resolve_provider`
                // (which itself consults the skill ledger when auto-route
                // is on), so pin it as an explicit override here — the
                // dispatcher shouldn't re-route a decision the scheduler
                // already made.
                brain_override: Some(d.provider_id.clone()),
                taxonomy: Some(super::skill::derive_taxonomy(
                    &task.description,
                    &task.zones,
                    &[],
                )),
                label: Some(format!("Task #{}", task.id)),
            })
        })
        .collect();
    WavePlan { wave_id, lanes }
}

/// Pick the provider to dispatch a task on. Resolution order:
///
/// 1. **Explicit `agent_id`** — a user/brain pin on the task always wins
///    (when that provider is actually in the registry this session).
/// 2. **Skill-ledger suggestion** — when auto-route is on, derive the
///    task's taxonomy and ask `aura skill suggest` for the historically
///    best provider in that cell; adopt it only if it's installed
///    (`registry.get`). This is what unifies the scheduler with the same
///    ledger the in-app advisory badges and `aura skill suggest` use.
/// 3. **`smart_pick`** — heuristic classification fallback when the cell
///    has too little evidence (n<10) or the cloud is unreachable.
///
/// Returns `None` only when nothing in the registry is available.
fn resolve_provider(task: &super::ManagerTask, registry: &Registry) -> Option<String> {
    if let Some(id) = &task.agent_id {
        if registry.get(id).is_some() {
            return Some(id.clone());
        }
    }

    // Skill-ledger auto-route: let historical outcomes pick the provider
    // when the user hasn't pinned one. Guarded on the registry so a
    // suggestion for an uninstalled provider degrades to `smart_pick`
    // rather than failing the dispatch.
    if super::brain::settings::load().auto_route {
        let taxonomy = super::skill::derive_taxonomy(&task.description, &task.zones, &[]);
        if let Some(suggestion) = super::skill::suggest_provider(&taxonomy) {
            if registry.get(&suggestion.provider_id).is_some() {
                return Some(suggestion.provider_id);
            }
        }
    }

    // Smart-pick across the available providers using the task's
    // description as the classification text. None when nothing in the
    // registry is available.
    smart_pick(registry, &task.description, "claude").map(|p| p.id().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::{ManagerSession, ManagerTask, ManagerTaskStatus};

    fn task(id: usize, deps: Vec<usize>, agent: Option<&str>, status: ManagerTaskStatus) -> ManagerTask {
        ManagerTask {
            id,
            description: format!("t{id}"),
            agent_id: agent.map(|s| s.to_string()),
            depends_on: deps,
            status,
            project_root: "/tmp".into(),
            zones: vec![],
            blocked_reason: None,
            output: String::new(),
            summary: None,
            started_at: None,
            completed_at: None,
            stream_channel: None,
            worktree_path: None,
            a2a_task_id: None,
            pre_dispatch_snapshot_ids: Vec::new(),
            recent_output: Vec::new(),
            line_count: 0,
            pending_skill: None,
        }
    }

    #[test]
    fn ready_only_when_deps_done() {
        let session = ManagerSession::new(
            "s".into(),
            "o".into(),
            vec![],
            vec![
                task(1, vec![], Some("claude"), ManagerTaskStatus::Pending),
                task(2, vec![1], Some("gemini"), ManagerTaskStatus::Pending),
            ],
        );
        let reg = Registry::with_defaults();
        let dispatches = compute_dispatches(&session, &HashMap::new(), &reg);
        assert_eq!(dispatches.len(), 1);
        assert_eq!(dispatches[0].task_id, 1);
    }

    #[test]
    fn per_kind_cap_respected() {
        let session = ManagerSession::new(
            "s".into(),
            "o".into(),
            vec![],
            vec![
                task(1, vec![], Some("claude"), ManagerTaskStatus::Pending),
                task(2, vec![], Some("claude"), ManagerTaskStatus::Pending),
            ],
        );
        let reg = Registry::with_defaults();
        let dispatches = compute_dispatches(&session, &HashMap::new(), &reg);
        // Both target claude; only one fires per tick.
        assert_eq!(dispatches.len(), 1);
        assert_eq!(dispatches[0].provider_id, "claude");
    }

    #[test]
    fn global_cap_respected() {
        let mut tasks = vec![];
        for i in 1..=6 {
            // Distinct providers so per-kind cap doesn't gate this test.
            let agent = ["claude", "gemini", "codex", "cursor", "kimi", "claude"][i - 1];
            tasks.push(task(i, vec![], Some(agent), ManagerTaskStatus::Pending));
        }
        let session = ManagerSession::new("s".into(), "o".into(), vec![], tasks);
        let reg = Registry::with_defaults();
        let dispatches = compute_dispatches(&session, &HashMap::new(), &reg);
        assert!(dispatches.len() <= GLOBAL_CAP);
    }

    #[test]
    fn blocked_reason_skips_dispatch() {
        let mut t = task(1, vec![], Some("claude"), ManagerTaskStatus::Pending);
        t.blocked_reason = Some("zone collision".into());
        let session = ManagerSession::new("s".into(), "o".into(), vec![], vec![t]);
        let reg = Registry::with_defaults();
        let dispatches = compute_dispatches(&session, &HashMap::new(), &reg);
        assert!(dispatches.is_empty());
    }

    #[test]
    fn in_flight_blocks_dispatch() {
        let session = ManagerSession::new(
            "s".into(),
            "o".into(),
            vec![],
            vec![task(1, vec![], Some("claude"), ManagerTaskStatus::Pending)],
        );
        let reg = Registry::with_defaults();
        let mut in_flight = HashMap::new();
        in_flight.insert(1, "claude".into());
        let dispatches = compute_dispatches(&session, &in_flight, &reg);
        assert!(dispatches.is_empty());
    }

    #[test]
    fn zone_collision_serialises_dispatch() {
        let mut t1 = task(1, vec![], Some("claude"), ManagerTaskStatus::Running);
        t1.zones = vec!["app/page.tsx".into()];
        let mut t2 = task(2, vec![], Some("gemini"), ManagerTaskStatus::Pending);
        t2.zones = vec!["app/page.tsx".into()];
        let session = ManagerSession::new("s".into(), "o".into(), vec![], vec![t1, t2]);
        let reg = Registry::with_defaults();
        let mut in_flight = HashMap::new();
        in_flight.insert(1, "claude".into());
        let out = compute_tick(&session, &in_flight, &reg);
        // Task #2 must NOT dispatch: zones overlap with the in-flight #1.
        assert!(out.dispatches.is_empty());
        assert_eq!(out.zone_blocks.get(&2), Some(&1));
    }

    #[test]
    fn disjoint_zones_dispatch_in_parallel() {
        let mut t1 = task(1, vec![], Some("claude"), ManagerTaskStatus::Running);
        t1.zones = vec!["src/foo.ts".into()];
        let mut t2 = task(2, vec![], Some("gemini"), ManagerTaskStatus::Pending);
        t2.zones = vec!["src/bar.ts".into()];
        let session = ManagerSession::new("s".into(), "o".into(), vec![], vec![t1, t2]);
        let reg = Registry::with_defaults();
        let mut in_flight = HashMap::new();
        in_flight.insert(1, "claude".into());
        let out = compute_tick(&session, &in_flight, &reg);
        assert_eq!(out.dispatches.len(), 1);
        assert_eq!(out.dispatches[0].task_id, 2);
        assert!(out.zone_blocks.is_empty());
    }

    #[test]
    fn parallel_mode_ignores_zone_overlap() {
        let mut t1 = task(1, vec![], Some("claude"), ManagerTaskStatus::Running);
        t1.zones = vec!["app/page.tsx".into()];
        let mut t2 = task(2, vec![], Some("gemini"), ManagerTaskStatus::Pending);
        t2.zones = vec!["app/page.tsx".into()];
        let mut session = ManagerSession::new("s".into(), "o".into(), vec![], vec![t1, t2]);
        session.plan_parallelism = PlanParallelism::Parallel;
        let reg = Registry::with_defaults();
        let mut in_flight = HashMap::new();
        in_flight.insert(1, "claude".into());
        let out = compute_tick(&session, &in_flight, &reg);
        // Parallel: even though zones overlap with the in-flight #1,
        // task #2 dispatches because the user opted in to concurrent
        // worktrees racing.
        assert_eq!(out.dispatches.len(), 1);
        assert_eq!(out.dispatches[0].task_id, 2);
        assert!(out.zone_blocks.is_empty());
    }

    #[test]
    fn serial_mode_blocks_when_anything_in_flight() {
        let mut t1 = task(1, vec![], Some("claude"), ManagerTaskStatus::Running);
        t1.zones = vec!["src/foo.ts".into()];
        let mut t2 = task(2, vec![], Some("gemini"), ManagerTaskStatus::Pending);
        t2.zones = vec!["src/bar.ts".into()];
        let mut session = ManagerSession::new("s".into(), "o".into(), vec![], vec![t1, t2]);
        session.plan_parallelism = PlanParallelism::Serial;
        let reg = Registry::with_defaults();
        let mut in_flight = HashMap::new();
        in_flight.insert(1, "claude".into());
        let out = compute_tick(&session, &in_flight, &reg);
        // Serial: zones are disjoint, but the running #1 still blocks
        // #2 because Serial means strict one-at-a-time.
        assert!(out.dispatches.is_empty());
    }

    #[test]
    fn serial_mode_dispatches_one_when_idle() {
        let t1 = task(1, vec![], Some("claude"), ManagerTaskStatus::Pending);
        let t2 = task(2, vec![], Some("gemini"), ManagerTaskStatus::Pending);
        let mut session = ManagerSession::new("s".into(), "o".into(), vec![], vec![t1, t2]);
        session.plan_parallelism = PlanParallelism::Serial;
        let reg = Registry::with_defaults();
        let out = compute_tick(&session, &HashMap::new(), &reg);
        // Both pending, nothing in flight: Serial fires exactly one.
        assert_eq!(out.dispatches.len(), 1);
        assert_eq!(out.dispatches[0].task_id, 1);
    }

    #[test]
    fn zones_overlap_segment_aware() {
        // Exact match
        assert!(zones_overlap("app/page.tsx", "app/page.tsx"));
        // Prefix at segment boundary
        assert!(zones_overlap("src/lib", "src/lib/api.ts"));
        assert!(zones_overlap("src/lib/", "src/lib/api.ts"));
        // NOT a segment-prefix
        assert!(!zones_overlap("src/lib", "src/library/api.ts"));
        // Empty zones never collide
        assert!(!zones_overlap("", "anything"));
        // Wildcard suffix stripped
        assert!(zones_overlap("aura-shell/src/**", "aura-shell/src/components/foo.ts"));
    }
}
