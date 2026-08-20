// missionData — the PURE, deterministic helpers behind Mission Control. No
// React, no I/O, and crucially no hidden `Date.now()`: every time-relative
// helper takes an explicit `now` so the labels are reproducible (the shell
// passes its poll's `Date.now()` once per render). Mission Control is the one
// pane that watches every agent + crew + automation run at once, so the plain-
// language naming lives here and the section views stay thin painters.
//
// Audience note: this is for non-engineers. Nothing here ever emits "lease",
// "node", "DAG" or a raw verdict enum — only "an agent is on it", "waiting to
// start", "Proven · 3/3 checks", "Couldn't finish".

import type { MissionRun, MissionState } from "../../../lib/api";
import { WORK_STATE } from "../../../lib/workState";
import { relativeAge } from "../../../lib/relativeTime";
import { agentName } from "../../../lib/agentNames";

// ─── Workflow stages (the Oz "Activity" spine) ─────────────────────────────
// Mission Control groups every run by the stage of work it's in — the same
// Triage → Planning → Building → Reviewing → Done shape Warp Oz uses, mapped
// honestly onto Aura's real run states. Both the Activity list and the Board
// (kanban) read these, so a row and a column never disagree about where a run
// sits. Plain-language only — a non-engineer reads "Building", not "working".

export type MissionStageId =
  | "needsYou"
  | "paused"
  | "triage"
  | "planning"
  | "building"
  | "reviewing"
  | "done"
  | "failed";

/** Display order, top-to-bottom (Activity) and left-to-right (Board).
 *
 *  Three bands, in this order:
 *
 *    1. Someone is on it — "Needs you" (it stopped and is asking), "Building"
 *       (an agent is on it right now), "Reviewing" (it finished and wants a
 *       look), "Paused" (you stopped it).
 *    2. The backlog, in the order work travels — "Ready", then "Waiting".
 *    3. The tail — "Done", "Couldn't finish".
 *
 *  Building used to sit fifth. On a page called Mission Control, the lane
 *  showing what your agents are doing this second was behind three lanes of
 *  backlog and off the right edge of the pane: you had to scroll past Paused,
 *  Ready and Waiting — none of which you can do anything about — to find out
 *  whether anything was running at all. The stages that involve a person or a
 *  live agent come first now; inventory follows. */
export const STAGE_ORDER: MissionStageId[] = [
  "needsYou",
  "building",
  "reviewing",
  "paused",
  "triage",
  "planning",
  "done",
  "failed",
];

/** The one name each stage answers to — lane header, list group, progress
 *  legend, tooltip. Two of them used to contradict their own definition:
 *  "Triage" for work with nothing in its way that an agent takes next, and
 *  "Planning" for work that is simply waiting on an earlier task — nobody is
 *  planning it, and the lane's own hint said so. "Failed" carried the same
 *  split: the lane said Failed and every card under it said "Couldn't
 *  finish". A stage is called what it is, once. */
export const STAGE_LABEL: Record<MissionStageId, string> = {
  needsYou: "Needs you",
  paused: "Paused",
  triage: "Ready",
  planning: "Waiting",
  building: "Building",
  reviewing: "Reviewing",
  done: "Done",
  failed: "Couldn't finish",
};

/** A one-line plain hint shown under an empty stage / as a tooltip. */
export const STAGE_HINT: Record<MissionStageId, string> = {
  needsYou: "Stopped until you answer. Nothing here moves on its own.",
  paused: "You stopped these. They stay put until you start them again. Run crew leaves them alone.",
  triage: "Nothing is in their way. The crew picks these up next.",
  planning: "Waiting for earlier work to finish first.",
  building: "An agent is on it right now.",
  reviewing: "Finished. Waiting for a human to look it over.",
  // Deliberately says only what is true of an EMPTY lane. This used to read
  // "Finished and proven.", which is a claim about the runs in it — and one
  // this lane cannot make, because `deriveStage` files a finish that was never
  // checked under Done too. What the lane can honestly say once it holds
  // something is computed from the runs: see `stageHint`.
  done: "Finished work lands here.",
  failed: "Open one to see why, or set it going again.",
};

/** The status accent for a stage — a glyph/left-border/count tint, never a
 *  button fill. Neutral for the resting stages; amber for live Building; the
 *  status greens/reds for the terminal ones. Arctic-blue stays for primary
 *  affordances elsewhere. */
export const STAGE_TONE: Record<MissionStageId, string> = {
  // Amber is the app's "a human is needed here" tone — the same one Reviewing
  // wears. Not red: nothing has gone wrong, it is just waiting on you.
  needsYou: "var(--color-amber)",
  // Held by you, and quiet about it — nothing is wrong and nothing is pending.
  paused: "var(--color-text-5)",
  // Ready is the lane Run crew actually empties, so it takes the accent; the
  // work that is merely waiting on something else is the inert one. This pair
  // used to be the other way round, which put the emphasis on the lane you can
  // do nothing about.
  triage: "var(--color-accent)",
  planning: "var(--color-text-4)",
  building: "var(--color-amber)",
  reviewing: "var(--color-amber)",
  done: "var(--color-accent-green)",
  failed: "var(--color-red)",
};

/** Map a workflow stage onto the app's ONE state-glyph vocabulary, so a Mission
 *  lane, a Mission list group and a Tasks lane all draw the same shape for the
 *  same idea: dashed ring = not started, half-filled = in flight, solid disc =
 *  terminal, crossed = gave up. The stage's own `STAGE_TONE` colours it.
 *
 *  Lives here rather than in either view so the board and the list can never
 *  drift into drawing the same stage two different ways. */
export const STAGE_GLYPH_GROUP: Record<MissionStageId, string> = {
  // Half-filled, like Building: the work did start. It is stopped mid-flight,
  // not sitting in a backlog and not given up on.
  needsYou: "started",
  paused: "backlog",
  // Solid ring: armed and about to go. Dashed for Waiting — not even armed.
  triage: "unstarted",
  planning: "backlog",
  building: "started",
  reviewing: "started",
  done: "completed",
  failed: "cancelled",
};

/** Which run is in which stage — derived purely from the envelope the backend
 *  already hands us (state + deps + proof + PR), so there's no second source of
 *  truth. Failed wins; a run stopped on a person is Needs you; one you stopped
 *  yourself is Paused; a live run is always Building; a queued run splits on
 *  whether it's blocked (Waiting) or clear (Ready); a finished run is Done only
 *  when it's actually proven, otherwise it's Reviewing (a human should look —
 *  "did it really do it?"). */
export function deriveStage(run: MissionRun): MissionStageId {
  if (run.state === "failed") return "failed";
  if (run.state === "needsYou") return "needsYou";
  if (run.state === "paused") return "paused";
  if (run.state === "working") return "building";
  if (run.state === "queued") {
    return run.waitingOn.length > 0 ? "planning" : "triage";
  }
  // done
  const verdict = run.proof?.verdict ?? null;
  if (verdict === "verified") return "done";
  if (run.prNumber != null || verdict === "partial") return "reviewing";
  return "done";
}

export type MissionStageGroup = { stage: MissionStageId; runs: MissionRun[] };

/** Flatten the envelope into one run list (live + queued + recent), the single
 *  collection both views group over. Recent is already newest-first. */
export function allRuns(state: MissionState): MissionRun[] {
  return [...state.live, ...state.queued, ...state.recent];
}

/** Group runs into the ordered stages, dropping empty stages. Stable: within a
 *  stage, input order is preserved (so live keeps lease order, recent keeps
 *  newest-first). The Board renders every column even when empty (pass
 *  `keepEmpty`), the Activity list hides empty groups. */
export function groupByStage(
  runs: MissionRun[],
  keepEmpty = false,
): MissionStageGroup[] {
  const buckets = new Map<MissionStageId, MissionRun[]>();
  for (const id of STAGE_ORDER) buckets.set(id, []);
  for (const run of runs) buckets.get(deriveStage(run))!.push(run);
  const groups: MissionStageGroup[] = [];
  for (const id of STAGE_ORDER) {
    const rs = buckets.get(id)!;
    if (keepEmpty || rs.length > 0) groups.push({ stage: id, runs: rs });
  }
  return groups;
}

/** Every stage with how many runs are in it, in display order — the ONE
 *  partition of the work.
 *
 *  The plan sidebar used to draw its progress bar straight off the engine's own
 *  buckets (`ready / blocked / paused / done`) while the board beside it drew
 *  lanes off `deriveStage`. Two partitions of one set of tasks, eight pixels
 *  apart, in two vocabularies — and they disagreed: the legend read "24 ready"
 *  next to a lane counting 26, and "7 done" next to a Done lane of 6 (the
 *  seventh had landed without proof, so the board rightly held it back for a
 *  look). One partition now, drawn twice. */
export function stageCounts(
  runs: MissionRun[],
): Array<{ stage: MissionStageId; n: number }> {
  return groupByStage(runs, true).map((g) => ({
    stage: g.stage,
    n: g.runs.length,
  }));
}

/** A short, stable display handle for a run — the "WRP-007" of Aura. Built
 *  deterministically from the project's initials + a short slice of the run id
 *  so it's the same every render (no counter to drift). Honest: it's a handle,
 *  not a promise of a sequential ticket number.
 *
 *  Deliberately NOT lib/monogram. That builds an avatar for a person and stops
 *  at two characters; this builds a three-letter reference for a project, and
 *  the two would drift apart the moment either changed for its own reasons. A
 *  sweep that folds them together would be making the handle worse. */
export function shortRef(run: MissionRun): string {
  const initials =
    (run.projectName || "AURA")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 3)
      .toUpperCase() || "AUR";
  const tail = (run.nodeId || run.id || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-4)
    .toUpperCase()
    .padStart(4, "0");
  return `${initials}-${tail}`;
}

/** The plain harness name for a run's agent id — "Claude", "Codex", "Gemini",
 *  … Title-cased from the id; empty agent reads "Agent" (never blank). Used for
 *  the row's harness chip tooltip and the Board card. */
export function harnessLabel(agent: string | null): string {
  // One name table for the whole app — see lib/agentNames.
  return agentName(agent, { empty: "Agent", unknown: "Agent" });
}

// Mission Control's key names for the app's work-state ramp. These are STATUS
// accents (left-border / glyph), never buttons.
//
// The comment here said this palette was matched to the Crew surface. It
// wasn't: a queued run was --color-accent, which is emerald, while a queued
// node on the crew canvas was muted — so the same waiting work was bright
// green on one screen and grey on the other, and Mission Control spent two
// greens on "queued" and "landed". It reads from the one ramp now — see
// lib/workState.
export const MISSION_ACCENT = {
  working: WORK_STATE.working.color,
  queued: WORK_STATE.queued.color,
  done: WORK_STATE.done.color,
  failed: WORK_STATE.failed.color,
  idle: WORK_STATE.queued.color,
} as const;

/** The three tones a proof pill can wear, mapped to StatusChip tones. */
export type MissionProofTone = "green" | "amber" | "neutral";

/** A run's proof rolled up for the recent row: the plain label + the chip tone.
 *  Mirrors crewProof.proofLabel so "Proven · 3/3 checks" reads identically, but
 *  works off the `MissionRun.proof` shape the backend hands us (no ledger read
 *  on the frontend — the backend already joined the goal). A null proof means
 *  the run was never checked. */
export function proofPill(
  proof: MissionRun["proof"],
): { label: string; tone: MissionProofTone } {
  if (!proof) return { label: "Not checked", tone: "neutral" };
  const { verdict, ok, total } = proof;
  if (verdict === "verified") {
    return {
      label: total > 0 ? `Proven · ${ok}/${total} checks` : "Proven",
      tone: "green",
    };
  }
  if (verdict === "partial") {
    return { label: `Almost · ${ok}/${total} checks`, tone: "amber" };
  }
  if (verdict === "not_wired") {
    return { label: "Not built yet", tone: "neutral" };
  }
  return { label: "Not checked", tone: "neutral" };
}

/** The plain hint a stage group shows — under its name, and in place of cards
 *  when it is empty. Every stage but Done is one fixed sentence.
 *
 *  Done is not, because Done is the one lane whose header was making a claim
 *  about its contents that its contents could not back. `deriveStage` files a
 *  finish under Done whenever it isn't *partially* proven — including a finish
 *  nothing ever checked — and the header said "Finished and proven." over all
 *  of it. That is the single question this whole app exists to answer, printed
 *  wrong, on the page called Mission Control.
 *
 *  So it counts. All proven says so; none checked says THAT, once, so no card
 *  has to; a mixed lane says how it splits and sends you to the cards, which is
 *  exactly when the cards start drawing their proof (see `proofWorthShowing`). */
export function stageHint(
  stage: MissionStageId,
  runs: MissionRun[],
): string {
  if (stage !== "done" || runs.length === 0) return STAGE_HINT[stage];
  let proven = 0;
  let checked = 0;
  for (const run of runs) {
    const tone = proofPill(run.proof).tone;
    if (tone !== "neutral") checked += 1;
    if (tone === "green") proven += 1;
  }
  if (proven === runs.length) return "Finished and proven.";
  if (checked === 0) return "Finished. None of these were checked.";
  return `Finished · ${proven} of ${runs.length} proven. Each one says where it stands.`;
}

/** Whether a finished run's proof belongs on every card and row, or once on the
 *  group header above them.
 *
 *  The same rule the agent mark follows: something stamped identically on all
 *  twelve cards distinguishes none of them. When not one finished run was ever
 *  checked, "Not checked" twelve times is twelve copies of a fact `stageHint`
 *  states once. The moment one of them IS proven the difference between the two
 *  is the whole reason the lane exists, so every card says where it stands —
 *  including, and especially, the ones that say "Not checked". */
export function proofWorthShowing(runs: MissionRun[]): boolean {
  return runs.some(
    (run) =>
      deriveStage(run) === "done" && proofPill(run.proof).tone !== "neutral",
  );
}

/** Where a run came from, in plain language: "Crew · wave 2", an automation's
 *  name, or "Manual". `sourceDetail` is the backend's already-human label (the
 *  wave / automation name); we only prefix the kind for crew/automation. */
export function sourceLabel(run: MissionRun): string {
  const detail = (run.sourceDetail ?? "").trim();
  switch (run.source) {
    case "crew":
      return detail ? `Crew · ${detail}` : "Crew";
    case "automation":
      return detail || "Automation";
    default:
      return "Manual";
  }
}

/** Compact elapsed for a live run — "12s", "4m", "1h 2m". `now` and `startedAt`
 *  are millis; a missing/future start collapses to "just now" so the row never
 *  shows a negative or NaN duration. Caps the minutes part so "1h 2m" reads
 *  cleanly rather than "1h 62m". */
export function elapsedLabel(
  startedAtMs: number | null,
  now: number,
): string {
  if (!startedAtMs || startedAtMs <= 0) return "";
  const diff = now - startedAtMs;
  if (diff < 1000) return "just now";
  const totalSec = Math.floor(diff / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** How long a finished run took, end − start — same compact format, for the
 *  recent rows ("ran 4m"). Empty when either bound is missing. */
export function durationLabel(
  startedAtMs: number | null,
  endedAtMs: number | null,
): string {
  if (!startedAtMs || !endedAtMs || endedAtMs <= startedAtMs) return "";
  return elapsedLabel(startedAtMs, endedAtMs);
}

/** Plain-language "in 3h" / "in 12m" / "due now" for a future timestamp (millis).
 *  Used by queued scheduled triggers off `nextRunMs`. A past/now value reads
 *  "due now"; a missing one is empty. */
export function untilLabel(atMs: number | null, now: number): string {
  if (!atMs || atMs <= 0) return "";
  const diff = atMs - now;
  if (diff <= 0) return "due now";
  const totalMin = Math.floor(diff / 60000);
  if (totalMin < 1) return "in under a minute";
  if (totalMin < 60) return `in ${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  if (h < 24) {
    const m = totalMin % 60;
    return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
  }
  const d = Math.floor(h / 24);
  return `in ${d}d`;
}

/** "how long ago" for a finished run's end time (millis) — newest-first feeds
 *  read "2m ago". Takes `now` so it stays pure, which the shared ladder
 *  supports. Empty for a missing/zero timestamp. */
export function endedAgoLabel(endedAtMs: number | null, now: number): string {
  // One ladder for the whole app — see lib/relativeTime. This was a hand copy
  // of crewShared.relativeTime and its own comment said so — and it copied the
  // 45-to-60-second hole along with the rungs, then stopped at weeks, so a run
  // from last year read "63w ago".
  return relativeAge(endedAtMs ?? 0, { now });
}

/** Short commit for display — 7 chars, the copy-friendly prefix. Empty for a
 *  missing sha. */
export function shortCommit(sha: string | null): string {
  if (!sha) return "";
  return sha.slice(0, 7);
}

/** The one-line summary under the header: "2 agents live · 1 queued · Runner
 *  online". Pluralises, drops a zero clause, and folds the host into the same
 *  line so the header carries the whole state at a glance. */
export function summaryLine(args: {
  liveCount: number;
  queuedCount: number;
  hostConfigured: boolean;
  hostOnline: boolean;
}): string {
  const { liveCount, queuedCount, hostConfigured, hostOnline } = args;
  const parts: string[] = [];
  parts.push(
    liveCount === 1 ? "1 agent live" : `${liveCount} agents live`,
  );
  parts.push(`${queuedCount} queued`);
  if (hostConfigured) {
    parts.push(hostOnline ? "Runner online" : "Runner offline");
  } else {
    parts.push("Runner · ");
  }
  return parts.join(" · ");
}

/** Plain "waiting on: A, B" line for a queued crew item — joins the upstream
 *  titles the backend already resolved (never ids). Empty when nothing's
 *  pending (a scheduled item shows its cadence instead). */
export function waitingOnLabel(waitingOn: string[]): string {
  const titles = waitingOn.map((t) => t.trim()).filter(Boolean);
  if (titles.length === 0) return "";
  if (titles.length === 1) return `waiting on: ${titles[0]}`;
  if (titles.length === 2) {
    return `waiting on: ${titles[0]} and ${titles[1]}`;
  }
  return `waiting on: ${titles[0]} and ${titles.length - 1} more`;
}
