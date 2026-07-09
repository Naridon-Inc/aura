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

// ─── Workflow stages (the Oz "Activity" spine) ─────────────────────────────
// Mission Control groups every run by the stage of work it's in — the same
// Triage → Planning → Building → Reviewing → Done shape Warp Oz uses, mapped
// honestly onto Aura's real run states. Both the Activity list and the Board
// (kanban) read these, so a row and a column never disagree about where a run
// sits. Plain-language only — a non-engineer reads "Building", not "working".

export type MissionStageId =
  | "triage"
  | "planning"
  | "building"
  | "reviewing"
  | "done"
  | "failed";

/** Display order, top-to-bottom (Activity) and left-to-right (Board). */
export const STAGE_ORDER: MissionStageId[] = [
  "triage",
  "planning",
  "building",
  "reviewing",
  "done",
  "failed",
];

export const STAGE_LABEL: Record<MissionStageId, string> = {
  triage: "Triage",
  planning: "Planning",
  building: "Building",
  reviewing: "Reviewing",
  done: "Done",
  failed: "Failed",
};

/** A one-line plain hint shown under an empty stage / as a tooltip. */
export const STAGE_HINT: Record<MissionStageId, string> = {
  triage: "Queued and ready — an agent will pick these up next.",
  planning: "Waiting on earlier work to finish first.",
  building: "An agent is on it right now.",
  reviewing: "Finished — waiting for a human to look it over.",
  done: "Finished and proven.",
  failed: "Couldn't finish. Open it to see why, or try again.",
};

/** The status accent for a stage — a glyph/left-border/count tint, never a
 *  button fill. Neutral for the resting stages; amber for live Building; the
 *  status greens/reds for the terminal ones. Arctic-blue stays for primary
 *  affordances elsewhere. */
export const STAGE_TONE: Record<MissionStageId, string> = {
  triage: "var(--color-text-4)",
  planning: "var(--color-accent)",
  building: "#d99a2b",
  reviewing: "#d98a4f",
  done: "#3fa66a",
  failed: "#d66a6a",
};

/** Which run is in which stage — derived purely from the envelope the backend
 *  already hands us (state + deps + proof + PR), so there's no second source of
 *  truth. Failed wins; a live run is always Building; a queued run splits on
 *  whether it's blocked (Planning) or ready (Triage); a finished run is Done
 *  only when it's actually proven, otherwise it's Reviewing (a human should
 *  look — "did it really do it?"). */
export function deriveStage(run: MissionRun): MissionStageId {
  if (run.state === "failed") return "failed";
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

/** A short, stable display handle for a run — the "WRP-007" of Aura. Built
 *  deterministically from the project's initials + a short slice of the run id
 *  so it's the same every render (no counter to drift). Honest: it's a handle,
 *  not a promise of a sequential ticket number. */
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
  const a = (agent ?? "").trim();
  if (!a) return "Agent";
  const known: Record<string, string> = {
    claude: "Claude",
    "aura-manager": "Aura",
    aura: "Aura",
    codex: "Codex",
    gemini: "Gemini",
    cursor: "Cursor",
    kimi: "Kimi",
    qwen: "Qwen",
  };
  const key = a.toLowerCase();
  if (known[key]) return known[key];
  return a.charAt(0).toUpperCase() + a.slice(1);
}

// One accent palette, matched to the Crew surface (crewShared.CREW_ACCENT) so
// Mission Control reads as the same family. Arctic-blue is reserved for primary
// affordances in the views — these are STATUS accents (left-border / glyph),
// never buttons. Amber = an agent is working; green = landed; red = failed.
export const MISSION_ACCENT = {
  working: "#d99a2b",
  queued: "var(--color-accent)",
  done: "#3fa66a",
  failed: "#d66a6a",
  idle: "var(--color-text-5)",
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
 *  read "2m ago". Mirrors crewShared.relativeTime but takes `now` so it stays
 *  pure. Empty for a missing/zero timestamp. */
export function endedAgoLabel(endedAtMs: number | null, now: number): string {
  if (!endedAtMs || endedAtMs <= 0) return "";
  const diff = now - endedAtMs;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  return `${w}w ago`;
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
    parts.push("Runner —");
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
