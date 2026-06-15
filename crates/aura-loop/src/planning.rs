//! Pure planning helpers shared by the desktop "plan an order" command and the
//! agent-facing `aura loop plan` surface (CLI + MCP). NO brain dependency: this
//! module only buckets the orderless pile into focused chunks (so a 900-task
//! board is covered in full, never skimmed) and applies a declarative plan —
//! dependency edges + goal/objective tags — back onto the graph, cycle-checked.
//!
//! The split lets an agent be the planner. The desktop runs each chunk through
//! Aura's own brain; an agent like Claude IS the brain — it pulls the same
//! chunked context ([`plan_context`]), reasons the real dependencies, and
//! submits the result through [`apply_plan`]. Both paths share this one module
//! so the graph they build is identical, whoever did the thinking.

use crate::{LoopGraph, LoopTask};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Default tasks per planning chunk — small enough to reason about in one pass.
pub const DEFAULT_CHUNK_SIZE: usize = 30;
/// Default cap on chunks produced per planning run. Overflow is reported as
/// `deferred` (never silently dropped) so a huge board can finish in a 2nd pass.
pub const DEFAULT_MAX_CHUNKS: usize = 28;

/// One focused planning unit: a slice of orderless tasks along a natural seam
/// (an epic's children, a sprint, or a size batch), small enough to plan in a
/// single pass. `seed_goal` is the epic/sprint name when known, so the planner
/// grounds the goal it names in real work instead of inventing one.
#[derive(Debug, Clone, Serialize)]
pub struct PlanChunk {
    pub label: String,
    pub seed_goal: Option<String>,
    pub node_ids: Vec<String>,
}

/// The full chunked planning context over a graph's orderless pile.
#[derive(Debug, Clone, Serialize)]
pub struct PlanContext {
    pub chunks: Vec<PlanChunk>,
    /// Total orderless tasks handed to the planner across all chunks.
    pub considered: usize,
    /// Chunks left unplanned because the per-run cap was hit.
    pub deferred: usize,
}

/// A single ordering edge the planner proposes: `task` cannot start until
/// `depends_on` is done.
#[derive(Debug, Clone, Deserialize)]
pub struct PlanEdge {
    pub task: String,
    pub depends_on: String,
}

/// A named goal that a set of tasks add up to. Stamps a `goal:<goal>` tag on
/// each member so the canvas can draw the goal region.
#[derive(Debug, Clone, Deserialize)]
pub struct PlanGoal {
    pub goal: String,
    pub tasks: Vec<String>,
}

/// A larger objective that a set of goals roll up to. Stamps `objective:<name>`
/// on every task under those goals so the board reads objective → goal → task.
#[derive(Debug, Clone, Deserialize)]
pub struct PlanObjective {
    pub objective: String,
    /// Goal NAMES (matching [`PlanGoal::goal`]) that roll up to this objective.
    pub goals: Vec<String>,
}

/// What [`apply_plan`] actually wrote.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ApplyReport {
    /// `depends_on` edges successfully wired.
    pub edges: usize,
    /// Edges refused (self-edge, a missing node, or a cycle) — surfaced, never
    /// silently dropped.
    pub skipped_edges: usize,
    /// Distinct tasks that ended up on at least one edge.
    pub connected: usize,
    /// Goals that stamped at least one real task.
    pub goals: usize,
    /// Objectives that stamped at least one real task.
    pub objectives: usize,
}

/// The orderless pile: live tasks with no in-graph edge either way,
/// priority-then-age sorted. This is exactly the band the canvas labels
/// "ready to start · no set order".
pub fn free_pile(all: &[LoopTask]) -> Vec<&LoopTask> {
    let ids: HashSet<&str> = all.iter().map(|t| t.id.as_str()).collect();

    // Which nodes are already on the receiving end of an in-graph edge.
    let mut depended: HashSet<&str> = HashSet::new();
    for t in all {
        for d in &t.depends_on {
            if ids.contains(d.as_str()) {
                depended.insert(d.as_str());
            }
        }
    }

    let mut free: Vec<&LoopTask> = all
        .iter()
        .filter(|t| {
            !t.is_terminal()
                && !t.depends_on.iter().any(|d| ids.contains(d.as_str()))
                && !depended.contains(t.id.as_str())
        })
        .collect();
    free.sort_by(|a, b| {
        a.priority
            .cmp(&b.priority)
            .then_with(|| a.created_at.cmp(&b.created_at))
    });
    free
}

/// Bucket the free pile into focused chunks along the seams already in the data
/// — epic (parent) first, then sprint, then size batches — splitting an
/// oversized group into "… · part N" so even a 90-task epic gets covered.
/// Pure; `all` resolves epic titles. Returns `(chunks, deferred)`.
pub fn plan_chunks(all: &[LoopTask], chunk_size: usize, max_chunks: usize) -> (Vec<PlanChunk>, usize) {
    let chunk_size = chunk_size.max(2);
    let free = free_pile(all);
    let ids: HashSet<&str> = all.iter().map(|t| t.id.as_str()).collect();
    let title_of = |id: &str| all.iter().find(|t| t.id == id).map(|t| t.title.clone());

    // Group free tasks by their natural seam.
    let mut epic_groups: HashMap<String, Vec<String>> = HashMap::new();
    let mut epic_titles: HashMap<String, String> = HashMap::new();
    let mut sprint_groups: HashMap<String, Vec<String>> = HashMap::new();
    let mut leftover: Vec<String> = Vec::new();
    for t in &free {
        if let Some(p) = &t.parent_task_id {
            if ids.contains(p.as_str()) {
                epic_groups.entry(p.clone()).or_default().push(t.id.clone());
                epic_titles
                    .entry(p.clone())
                    .or_insert_with(|| title_of(p).unwrap_or_else(|| "Epic".into()));
                continue;
            }
        }
        let sprint = t.tags.iter().find_map(|x| {
            let s = x.as_str();
            if s.len() >= 7 && s[..7].eq_ignore_ascii_case("sprint:") {
                let name = s[7..].trim();
                if name.is_empty() {
                    None
                } else {
                    Some(name.to_string())
                }
            } else {
                None
            }
        });
        if let Some(name) = sprint {
            sprint_groups.entry(name).or_default().push(t.id.clone());
            continue;
        }
        leftover.push(t.id.clone());
    }

    let mut chunks: Vec<PlanChunk> = Vec::new();
    let push_group =
        |chunks: &mut Vec<PlanChunk>, label: String, seed: Option<String>, ids_in: Vec<String>| {
            if ids_in.len() < 2 {
                return;
            }
            if ids_in.len() <= chunk_size {
                chunks.push(PlanChunk {
                    label,
                    seed_goal: seed,
                    node_ids: ids_in,
                });
            } else {
                for (pi, sub) in ids_in.chunks(chunk_size).enumerate() {
                    if sub.len() < 2 {
                        continue;
                    }
                    chunks.push(PlanChunk {
                        label: format!("{label} · part {}", pi + 1),
                        seed_goal: seed.clone(),
                        node_ids: sub.to_vec(),
                    });
                }
            }
        };

    // Epics first (sorted for determinism), then sprints, then leftover batches.
    let mut epic_keys: Vec<String> = epic_groups.keys().cloned().collect();
    epic_keys.sort();
    for k in epic_keys {
        let title = epic_titles.get(&k).cloned().unwrap_or_else(|| "Epic".into());
        let g = epic_groups.remove(&k).unwrap_or_default();
        push_group(&mut chunks, title.clone(), Some(title), g);
    }
    let mut sprint_keys: Vec<String> = sprint_groups.keys().cloned().collect();
    sprint_keys.sort();
    for k in sprint_keys {
        let g = sprint_groups.remove(&k).unwrap_or_default();
        let label = format!("Sprint {k}");
        push_group(&mut chunks, label.clone(), Some(label), g);
    }
    for (bi, batch) in leftover.chunks(chunk_size).enumerate() {
        push_group(&mut chunks, format!("Batch {}", bi + 1), None, batch.to_vec());
    }

    let deferred = chunks.len().saturating_sub(max_chunks);
    if chunks.len() > max_chunks {
        chunks.truncate(max_chunks);
    }
    (chunks, deferred)
}

/// Build the default chunked planning context for a graph's whole orderless
/// pile — what both the desktop brain and an agent plan over.
pub fn plan_context(all: &[LoopTask]) -> PlanContext {
    let considered = free_pile(all).len();
    let (chunks, deferred) = plan_chunks(all, DEFAULT_CHUNK_SIZE, DEFAULT_MAX_CHUNKS);
    PlanContext {
        chunks,
        considered,
        deferred,
    }
}

/// Apply a declarative plan to the graph: wire the edges (cycle-checked via
/// [`LoopGraph::add_dep`]), then stamp `goal:`/`objective:` tags. Re-stamps
/// replace any prior goal/objective tag on a touched node, so re-planning is
/// safe. Unknown ids are skipped, never fabricated. This is the single writer
/// both the agent surface and (future) any other planner go through.
pub fn apply_plan(
    graph: &LoopGraph,
    edges: &[PlanEdge],
    goals: &[PlanGoal],
    objectives: &[PlanObjective],
) -> ApplyReport {
    let mut report = ApplyReport::default();
    let mut connected: HashSet<String> = HashSet::new();
    for e in edges {
        if e.task == e.depends_on {
            report.skipped_edges += 1;
            continue;
        }
        match graph.add_dep(&e.task, &e.depends_on) {
            Ok(_) => {
                report.edges += 1;
                connected.insert(e.task.clone());
                connected.insert(e.depends_on.clone());
            }
            Err(_) => report.skipped_edges += 1,
        }
    }
    report.connected = connected.len();

    // goal:<g> — replace any prior goal tag, then stamp this one.
    for g in goals {
        let tag = format!("goal:{}", g.goal);
        let mut any = false;
        for id in &g.tasks {
            if let Some(mut node) = graph.get(id) {
                node.tags.retain(|t| !t.to_lowercase().starts_with("goal:"));
                node.tags.push(tag.clone());
                let _ = graph.save(&node);
                any = true;
            }
        }
        if any {
            report.goals += 1;
        }
    }

    // objective:<name> — resolve each named goal back to its member tasks.
    let goal_members: HashMap<&str, &Vec<String>> =
        goals.iter().map(|g| (g.goal.as_str(), &g.tasks)).collect();
    for o in objectives {
        let tag = format!("objective:{}", o.objective);
        let mut any = false;
        for gname in &o.goals {
            if let Some(members) = goal_members.get(gname.as_str()) {
                for id in members.iter() {
                    if let Some(mut node) = graph.get(id) {
                        node.tags
                            .retain(|t| !t.to_lowercase().starts_with("objective:"));
                        node.tags.push(tag.clone());
                        let _ = graph.save(&node);
                        any = true;
                    }
                }
            }
        }
        if any {
            report.objectives += 1;
        }
    }
    report
}

// ─── Reality-check: is a candidate task real, or already done? ──────────────
//
// A vibecoder asked the planner to catch tasks that aren't worth running —
// work that's already finished and wrongly sitting as a to-do, or a duplicate
// of another pending task. We do this with cheap, honest signals (name match
// against finished work, name match between two pending tasks, an empty
// placeholder) — never by guessing the code is done. Each flag is plain enough
// to show a non-engineer, and the caller decides whether to drop or keep.

/// Why a candidate task probably shouldn't be planned or run as-is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FlagKind {
    /// A finished task — here or in the completed-work evidence the caller
    /// passed (commit subjects, intent log) — has the same name. Very likely
    /// already done and wrongly left as a to-do.
    AlreadyDone,
    /// Another still-pending task is effectively the same work.
    Duplicate,
    /// Nothing to act on — a placeholder title with no body.
    Thin,
}

/// One flagged candidate, with a reason safe to show a non-engineer.
#[derive(Debug, Clone, Serialize)]
pub struct TaskFlag {
    pub id: String,
    pub title: String,
    pub kind: FlagKind,
    pub reason: String,
    /// What it collided with — a finished task's title, or the twin's title.
    pub evidence: Option<String>,
}

/// Collapse a title to a comparable key: lowercase, drop punctuation, fold
/// runs of non-alphanumerics to a single space. "AURA-89: Ship it!" and
/// "aura 89 ship it" land on the same key.
fn normalize_title(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = true; // trims leading space
    for c in s.chars() {
        if c.is_alphanumeric() {
            for lc in c.to_lowercase() {
                out.push(lc);
            }
            prev_space = false;
        } else if !prev_space {
            out.push(' ');
            prev_space = true;
        }
    }
    out.trim().to_string()
}

/// Placeholder titles that, with no body, mean "someone jotted a stub."
const PLACEHOLDER_TITLES: &[&str] = &[
    "todo", "test", "tbd", "fixme", "wip", "tmp", "temp", "placeholder", "xxx", "asdf", "untitled",
];

/// Scan the live tasks for ones not worth dispatching as-is. `done_titles` is
/// extra completed-work evidence the caller gathers (recent commit subjects,
/// intent-log entries) so "already done" catches work finished OUTSIDE the
/// graph too. Pure and deterministic — input order decides which of a pair is
/// the "original" and which the duplicate.
pub fn review_tasks(all: &[LoopTask], done_titles: &[String]) -> Vec<TaskFlag> {
    // Finished work: terminal nodes in the graph + the caller's evidence.
    let mut done_keys: HashSet<String> = all
        .iter()
        .filter(|t| t.is_terminal())
        .map(|t| normalize_title(&t.title))
        .filter(|k| !k.is_empty())
        .collect();
    for d in done_titles {
        let k = normalize_title(d);
        if !k.is_empty() {
            done_keys.insert(k);
        }
    }

    let mut flags: Vec<TaskFlag> = Vec::new();
    // First pending task seen per key → anything later with that key is a dup.
    let mut seen: HashMap<String, String> = HashMap::new();

    for t in all.iter().filter(|t| !t.is_terminal()) {
        let key = normalize_title(&t.title);
        let body_empty = t.input.trim().is_empty()
            && t.acceptance_criteria
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true);

        // Thin: a placeholder-ish title with no body. Conservative so real
        // short-titled imports aren't nagged.
        let placeholder = PLACEHOLDER_TITLES.contains(&key.as_str()) || key.len() < 4;
        if body_empty && placeholder {
            flags.push(TaskFlag {
                id: t.id.clone(),
                title: t.title.clone(),
                kind: FlagKind::Thin,
                reason: "Looks like an empty placeholder — a stub title with no description or acceptance.".into(),
                evidence: None,
            });
            continue;
        }

        if key.is_empty() {
            continue;
        }

        // Already done: a finished task carries the same name.
        if done_keys.contains(&key) {
            flags.push(TaskFlag {
                id: t.id.clone(),
                title: t.title.clone(),
                kind: FlagKind::AlreadyDone,
                reason: "A finished task has the same name — this is probably already done and just left on the list.".into(),
                evidence: Some(t.title.clone()),
            });
            continue;
        }

        // Duplicate: an earlier pending task is the same work.
        if let Some(orig) = seen.get(&key) {
            flags.push(TaskFlag {
                id: t.id.clone(),
                title: t.title.clone(),
                kind: FlagKind::Duplicate,
                reason: "Another task still on the list is the same work — keep one.".into(),
                evidence: Some(orig.clone()),
            });
            continue;
        }
        seen.insert(key, t.title.clone());
    }

    flags
}

// ─── Attach new work to an existing flow (don't always start a new island) ──
//
// When you add tasks and hit Plan, sometimes they belong to a goal that's
// already on the board — they should hang off its current last steps, not
// become a disconnected new flow. The write path already supports this (an
// edge into any existing node + adding the task to that goal). This read
// helper just offers the targets: every existing goal and its tail tasks.

/// An existing goal you can attach new tasks to, with the tail steps new work
/// usually depends on.
#[derive(Debug, Clone, Serialize)]
pub struct AttachTarget {
    /// The existing goal name (the `goal:<name>` tag value).
    pub goal: String,
    /// How many tasks already sit under it.
    pub size: usize,
    /// Its tail tasks — members nothing else in the goal depends on yet. New
    /// work usually runs after these.
    pub tail_ids: Vec<String>,
}

fn goal_tag(t: &LoopTask) -> Option<String> {
    t.tags.iter().find_map(|x| {
        let s = x.as_str();
        if s.len() >= 5 && s[..5].eq_ignore_ascii_case("goal:") {
            let name = s[5..].trim();
            (!name.is_empty()).then(|| name.to_string())
        } else {
            None
        }
    })
}

/// Every existing goal on the board and the tail steps to attach new work
/// after — sorted by name for stable display. Empty when nothing's tagged yet.
pub fn attach_targets(all: &[LoopTask]) -> Vec<AttachTarget> {
    // goal name → member ids.
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for t in all {
        if let Some(g) = goal_tag(t) {
            groups.entry(g).or_default().push(t.id.clone());
        }
    }

    let mut out: Vec<AttachTarget> = groups
        .into_iter()
        .map(|(goal, members)| {
            let member_set: HashSet<&str> = members.iter().map(|s| s.as_str()).collect();
            // A member is "depended on" if another member lists it in depends_on.
            let mut depended: HashSet<&str> = HashSet::new();
            for id in &members {
                if let Some(node) = all.iter().find(|t| &t.id == id) {
                    for d in &node.depends_on {
                        if member_set.contains(d.as_str()) {
                            depended.insert(d.as_str());
                        }
                    }
                }
            }
            let tail_ids: Vec<String> = members
                .iter()
                .filter(|id| !depended.contains(id.as_str()))
                .cloned()
                .collect();
            AttachTarget {
                goal,
                size: members.len(),
                tail_ids,
            }
        })
        .collect();
    out.sort_by(|a, b| a.goal.cmp(&b.goal));
    out
}
