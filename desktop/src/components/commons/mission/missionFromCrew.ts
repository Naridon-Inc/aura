// missionFromCrew — the one adapter that lets the Mission views (the status-
// grouped Activity list + the Kanban Board) render the crew's REAL work queue.
// Crew already loads the unified `ready_view` (+ the proof ledger); rather than
// run a second data layer, we map that one source into the MissionState shape
// the Mission kit speaks. Pure + deterministic: no I/O, no Date.now() — the
// caller passes the proof map it already loaded.
//
// This is what makes "one unified command center" honest: the Board, the
// Activity feed, the Queue graph and the Control panel are all the SAME engine
// numbers, just drawn four ways. Nothing here invents a run.

import type {
  LoopTask,
  MissionRun,
  MissionState,
  ReadyViewDto,
} from "../../../lib/api";
import {
  proofForCommit,
  bestProof,
  type CrewProof,
} from "../crew/crewProof";

/** Timestamps on a LoopTask are unix; older rows are in seconds, newer in
 *  millis. Normalise to millis so the Mission time helpers read right. */
function toMs(n: number | null | undefined): number | null {
  if (!n || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : n;
}

/** A crew node's proof, rolled to the Mission shape (or null if uncommitted /
 *  never checked). Joins by commit through the ledger map the surface loaded. */
function proofFor(
  task: LoopTask,
  proof: Map<string, CrewProof[]>,
): MissionRun["proof"] {
  const best = bestProof(proofForCommit(proof, task.commit_sha));
  if (!best) return null;
  return { verdict: best.verdict, ok: best.ok, total: best.total };
}

/** True when a catch-all ("other") node represents a run that couldn't finish,
 *  vs one that simply completed by another path. */
function isFailed(task: LoopTask): boolean {
  const s = (task.status || "").toLowerCase();
  return !!task.error_message || /fail|error|cancel/.test(s);
}

/** Map one crew node → one Mission run. `state` is decided by the caller (which
 *  lane the node sits in); `waitingOn` is the already-resolved upstream titles
 *  (empty for everything but a blocked node). */
function toRun(
  task: LoopTask,
  state: MissionRun["state"],
  waitingOn: string[],
  project: string,
  projectName: string,
  proof: Map<string, CrewProof[]>,
): MissionRun {
  const started = toMs(task.updated_at) ?? toMs(task.created_at);
  return {
    id: task.id,
    project,
    projectName,
    title: task.title,
    agent: task.agent_kind ?? task.assignee ?? null,
    source: "crew",
    sourceDetail: null,
    state,
    startedAtMs: state === "working" ? started : toMs(task.created_at),
    endedAtMs: state === "done" || state === "failed" ? started : null,
    commit: task.commit_sha ?? null,
    prNumber: null,
    proof: proofFor(task, proof),
    waitingOn,
    steerable: state === "working",
    error: task.error_message ?? null,
    nodeId: task.id,
  };
}

/** Turn the unified ready-view + proof ledger into the MissionState the Board
 *  and Activity views consume. live = working; queued = ready + blocked (with
 *  their unmet deps resolved to titles) + paused; recent = done + the failed
 *  catch-alls, newest first. Triggers/host stay empty here — the Automations
 *  tab owns triggers, and the Control tab owns the runner. */
export function readyViewToMission(
  view: ReadyViewDto,
  proof: Map<string, CrewProof[]>,
  project: string,
  projectName: string,
): MissionState {
  // id → title across every lane, so a blocked node's "waiting on" ids become
  // the human titles the Mission row shows (never raw ids).
  const titleById = new Map<string, string>();
  const note = (t: LoopTask) => titleById.set(t.id, t.title);
  view.working.forEach(note);
  view.ready.forEach(note);
  view.blocked.forEach((b) => note(b.task));
  view.paused.forEach(note);
  view.done.forEach(note);
  view.other.forEach(note);

  const live = view.working.map((t) =>
    toRun(t, "working", [], project, projectName, proof),
  );

  const queued: MissionRun[] = [
    ...view.ready.map((t) =>
      toRun(t, "queued", [], project, projectName, proof),
    ),
    ...view.blocked.map((b) =>
      toRun(
        b.task,
        "queued",
        b.unmet.map((id) => titleById.get(id) ?? id),
        project,
        projectName,
        proof,
      ),
    ),
    ...view.paused.map((t) =>
      toRun(t, "queued", [], project, projectName, proof),
    ),
  ];

  const failed = view.other.filter(isFailed);
  const recent: MissionRun[] = [
    ...view.done.map((t) => toRun(t, "done", [], project, projectName, proof)),
    ...failed.map((t) => toRun(t, "failed", [], project, projectName, proof)),
  ].sort((a, b) => (b.endedAtMs ?? 0) - (a.endedAtMs ?? 0));

  return {
    live,
    queued,
    recent,
    triggers: [],
    host: { configured: false, online: false, label: "" },
    projects: [{ root: project, name: projectName }],
    capped: false,
  };
}

/** Fold several per-project MissionStates into one all-projects board — the
 *  Conductor-style "every workspace across every project" view. Each run already
 *  carries its own `project`/`projectName` (set in `toRun`), so the merged board
 *  can label a card with where it lives; here we only concatenate the lanes and
 *  union the project list. `recent` is re-sorted newest-first across projects so
 *  the merged Done/Failed feed reads in one honest order (a project boundary
 *  never reorders time). Triggers/host stay empty — the aggregate is a glance,
 *  not a place you run from; you drill into a project for that. Pure. */
export function mergeMissions(states: MissionState[]): MissionState {
  const live: MissionRun[] = [];
  const queued: MissionRun[] = [];
  const recent: MissionRun[] = [];
  const projects: MissionState["projects"] = [];
  const seenProject = new Set<string>();
  for (const s of states) {
    live.push(...s.live);
    queued.push(...s.queued);
    recent.push(...s.recent);
    for (const p of s.projects) {
      if (seenProject.has(p.root)) continue;
      seenProject.add(p.root);
      projects.push(p);
    }
  }
  recent.sort((a, b) => (b.endedAtMs ?? 0) - (a.endedAtMs ?? 0));
  return {
    live,
    queued,
    recent,
    triggers: [],
    host: { configured: false, online: false, label: "" },
    projects,
    capped: false,
  };
}
