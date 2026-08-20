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

/** True when a catch-all ("other") node represents a run that couldn't finish.
 *  `reject` counts: a rejected node is as terminal as a failed one, and leaving
 *  it out of this test is what used to make rejected runs disappear. */
function isFailed(task: LoopTask): boolean {
  const s = (task.status || "").toLowerCase();
  return !!task.error_message || /fail|error|cancel|reject/.test(s);
}

/** Where a catch-all ("other") node belongs, and what it is waiting for.
 *
 *  The crew parks five very different things in one bucket — failed, canceled,
 *  rejected, input-required, auth-required — and the Mission views used to
 *  render only the ones that matched a failure pattern. So a run that had
 *  stopped to ask you a question, or to ask you to sign in, was dropped from
 *  every view: the board showed nothing to answer, and the run sat stopped
 *  indefinitely because the one person who could restart it never saw it.
 *
 *  Every node gets a lane now. An unrecognised status lands in "needs you"
 *  rather than "failed": we know the machine has stopped moving it, and that a
 *  person should look — we do not know that anything went wrong, and saying so
 *  would be inventing a failure. */
function otherLane(task: LoopTask): {
  state: MissionRun["state"];
  waitingOn: string[];
} {
  const s = (task.status || "").toLowerCase();
  if (s === "input-required") return { state: "needsYou", waitingOn: ["your answer"] };
  if (s === "auth-required") return { state: "needsYou", waitingOn: ["you to sign in"] };
  if (isFailed(task)) return { state: "failed", waitingOn: [] };
  return { state: "needsYou", waitingOn: ["you to take a look"] };
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
 *  and Activity views consume. live = working; queued = the catch-alls stopped
 *  on a human + ready + blocked (with their unmet deps resolved to titles) +
 *  the ones you paused; recent = done + the catch-alls that ended badly,
 *  newest first. Every node the crew hands us lands in exactly one lane. Triggers/host stay empty
 *  here — the Automations tab owns triggers, the Control tab owns the runner. */
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

  // Every catch-all node, sorted into the lane it actually belongs in. Nothing
  // in `other` is discarded — see `otherLane`.
  const other = view.other.map((t) => ({ task: t, lane: otherLane(t) }));
  const needsYou = other.filter((o) => o.lane.state === "needsYou");
  const failed = other.filter((o) => o.lane.state === "failed");

  const queued: MissionRun[] = [
    // Stopped-on-a-human first: these are the only runs on the board that
    // cannot start themselves, so they lead the queue rather than trail it.
    ...needsYou.map((o) =>
      toRun(o.task, "needsYou", o.lane.waitingOn, project, projectName, proof),
    ),
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
    // Paused is its own lane, NOT part of the queue. It used to map to
    // "queued" with nothing to wait on, which `deriveStage` reads as ready —
    // so work you had deliberately parked was displayed in the lane labelled
    // "the crew picks these up next", and inflated its count.
    ...view.paused.map((t) =>
      toRun(t, "paused", [], project, projectName, proof),
    ),
  ];

  const recent: MissionRun[] = [
    ...view.done.map((t) => toRun(t, "done", [], project, projectName, proof)),
    ...failed.map((o) =>
      toRun(o.task, "failed", [], project, projectName, proof),
    ),
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
