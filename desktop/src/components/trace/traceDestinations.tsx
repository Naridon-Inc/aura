// Trace · destinations — the ONE list of the places Trace goes, and the glyph
// each wears.
//
// It used to be eight hand-written rows in the sidebar, each carrying its own
// label, hint and handler inline. That was fine while the rail was the only way
// in; it stopped being fine the moment Trace grew a second entrance. Two
// hand-written copies of a menu drift within a week — one gains a row, the
// other keeps a stale hint — so both surfaces read this instead.
//
// A destination is a QUESTION Trace answers, not a kind of tool: what happened
// and what it taught Aura (Overview, My sessions, Team activity, Memory), is my
// work sound (Goals, Safety check, Impacts), travel the past (Project
// timeline), then the quiet utilities (Cost & usage, Project health, Code Map).
// The order below is that reading, and the `gap` flag marks where one cluster
// ends and the next begins — rhythm rather than a row of ALL-CAPS headings.

import type { ReactNode } from "react";

import {
  CODE_MAP_ENABLED,
  MEMORY_SURFACE_ENABLED,
  TEAM_ACTIVITY_ENABLED,
  TIMELINE_V2,
} from "../../lib/featureFlags";

/** Which destination the work surface is currently showing. `goals` and
 *  `review` never appear here — they ask Aura a question rather than opening a
 *  pane, so nothing lights up. */
export type TraceKey =
  | "overview"
  | "sessions"
  | "team"
  | "usage"
  | "goals"
  | "intent"
  | "review"
  | "checks"
  | "impacts"
  | "rewind"
  | "timeline"
  | "attest"
  | "doctor"
  | "memory"
  | "codemap";

/** The handlers a destination can call. Kept as a bag of callbacks (rather
 *  than one `onGo(key)`) because the two asking destinations need App-level
 *  state — the busy guard that stops a second click buying a second agent
 *  turn — and the navigating ones only need the editor store. */
export type TraceHandlers = {
  onOverview: () => void;
  onSessions: () => void;
  onTeamActivity: () => void;
  onCostUsage: () => void;
  onIntentAst: () => void;
  onReview: () => void;
  onChecks: () => void;
  onImpacts: () => void;
  onProve: () => void;
  onRewind: () => void;
  onTimeline: () => void;
  onAttest: () => void;
  onCodeMap: () => void;
  onMemory: () => void;
  onDoctor: () => void;
};

export type TraceDestination = {
  key: TraceKey;
  label: string;
  /** Plain-language "what is this" — several destinations have jargon names
   *  (Attestations, Intent ↔ AST), and the audience is not engineers. */
  hint: string;
  glyph: ReactNode;
  /** Off behind a feature flag → the destination is absent, not disabled. */
  enabled: boolean;
  /** True for the two that hand a question to Aura instead of opening a pane.
   *  They can never be the active destination, and they take a busy state. */
  asks?: boolean;
  /** Shows only when something is actually reaching your work — a dead menu
   *  entry reading 0 is worse than no entry. */
  onlyWhenImpacts?: boolean;
  /** Start of a new cluster — a gap before this one. */
  gap?: boolean;
  run: (h: TraceHandlers) => void;
};

// ── Glyphs ───────────────────────────────────────────────────────────────────
// Kept as bare path elements so every surface that draws them supplies its own
// <svg> chrome (size, stroke) and they can never disagree on shape.

export const GLYPH_GOAL = (
  <>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1" />
  </>
);
export const GLYPH_MEMORY = (
  <>
    <ellipse cx="12" cy="6" rx="8" ry="3" />
    <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </>
);
export const GLYPH_DOCTOR = (
  <>
    <path d="M5 3v6a5 5 0 0 0 10 0V3" />
    <path d="M5 3H3M15 3h2M10 14v3a4 4 0 0 0 8 0v-1" />
    <circle cx="18" cy="13" r="2" />
  </>
);
export const GLYPH_CODEMAP = (
  <>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="9" r="2.5" />
    <circle cx="9" cy="18" r="2.5" />
    <path d="M8 7.5 15.5 9M8 16l1.5-7" />
  </>
);
export const GLYPH_OVERVIEW = (
  <>
    <path d="M5 18a8 8 0 1 1 14 0" />
    <path d="M12 14.5 16 9" strokeLinecap="round" />
    <circle cx="12" cy="14.5" r="1.1" />
  </>
);
export const GLYPH_SESSIONS = (
  <>
    <rect x="3" y="4" width="18" height="5" rx="1.5" />
    <rect x="3" y="13" width="18" height="5" rx="1.5" />
    <path d="M7 6.5h.01M7 15.5h.01" />
  </>
);
// Team activity — two figures + a pulse line, hinting "what everyone's AI is
// doing to our project, as it happens".
export const GLYPH_TEAM_ACTIVITY = (
  <>
    <circle cx="9" cy="8" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M16 4.5a3 3 0 0 1 0 5.8M18.5 19a5.5 5.5 0 0 0-3-4.9" />
  </>
);
// Cost & usage — a banknote: a rounded bill with a coin in the middle,
// hinting "what this is costing us in tokens and dollars".
export const GLYPH_USAGE = (
  <>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M6 9.5v5M18 9.5v5" />
  </>
);
// Cross-branch impacts — a horizontal git-fork: one node on the left splitting
// rightward into two diverged branch nodes, hinting "a change on another
// branch reaches yours". Deliberately horizontal (no vertical trunk) so it
// reads unmistakably as a fork.
export const GLYPH_IMPACTS = (
  <>
    <circle cx="5" cy="12" r="2" />
    <circle cx="19" cy="6" r="2" />
    <circle cx="19" cy="18" r="2" />
    <path d="M7 12h5" />
    <path d="M12 12C14.5 12 14.5 6 17 6" />
    <path d="M12 12C14.5 12 14.5 18 17 18" />
  </>
);
// Safety check — a shield with a check, hinting "a second set of eyes
// finds bugs, security holes, and things that don't match the ask".
export const GLYPH_SAFETY = (
  <>
    <path d="M12 3 5 5.5v5.2c0 4.4 3 7.3 7 8.8 4-1.5 7-4.4 7-8.8V5.5Z" />
    <path d="m9 11.5 2 2 4-4.2" />
  </>
);
// Project timeline — a churn sparkline over a baseline with a playhead dot,
// echoing the scrubber: "scrub the project's history and watch it evolve".
export const GLYPH_TIMELINE = (
  <>
    <path d="M3 17h18" />
    <path d="M7 17v-3M11 17v-6M15 17v-2.5M19 17v-7" />
    <circle cx="11" cy="11" r="1.9" />
  </>
);

// ── The list ─────────────────────────────────────────────────────────────────

export const TRACE_DESTINATIONS: TraceDestination[] = [
  {
    key: "overview",
    label: "Overview",
    hint: "Live activity, headline numbers, and a one-line cost summary. At a glance, links to the rest.",
    glyph: GLYPH_OVERVIEW,
    enabled: true,
    run: (h) => h.onOverview(),
  },

  // What happened — and what it taught Aura. Your runs and the team's are the
  // raw activity; Memory is its durable distillation.
  {
    key: "sessions",
    label: "My sessions",
    hint: "Your own AI coding sessions. Open any run to see what changed and why.",
    glyph: GLYPH_SESSIONS,
    enabled: true,
    gap: true,
    run: (h) => h.onSessions(),
  },
  {
    key: "team",
    label: "Team activity",
    hint: "Every AI change across your team, who made it, why, and if it touches the work you're in.",
    glyph: GLYPH_TEAM_ACTIVITY,
    enabled: TEAM_ACTIVITY_ENABLED,
    run: (h) => h.onTeamActivity(),
  },
  {
    key: "memory",
    label: "Memory",
    hint: "What Aura remembers about this project. The decisions, conventions, and gotchas it carries into every session. Search it, see where each fact came from, and forget anything that's wrong.",
    glyph: GLYPH_MEMORY,
    enabled: MEMORY_SURFACE_ENABLED,
    run: (h) => h.onMemory(),
  },

  // Two trust rungs: built right (Goals) → reviewed (Safety check). Each
  // answers a distinct question so neither reads as a synonym of the other.
  {
    key: "goals",
    label: "Goals",
    hint: "Pick something you asked for and confirm it's truly built. Aura traces it through the real code, end to end.",
    glyph: GLYPH_GOAL,
    enabled: true,
    asks: true,
    gap: true,
    run: (h) => h.onProve(),
  },
  {
    key: "review",
    label: "Safety check",
    hint: "A second set of eyes on your changes. Bugs, security holes, and things that don't match what you asked.",
    glyph: GLYPH_SAFETY,
    enabled: true,
    asks: true,
    run: (h) => h.onReview(),
  },
  {
    key: "impacts",
    label: "Impacts on me",
    hint: "Code you depend on changed on another branch. Fix or acknowledge before it bites.",
    glyph: GLYPH_IMPACTS,
    enabled: true,
    onlyWhenImpacts: true,
    run: (h) => h.onImpacts(),
  },

  // The past, in one home.
  {
    key: "timeline",
    label: "Project timeline",
    hint: "Relive how the project came to be. Scrub a bottom timeline through every moment, with the reason and the code behind it.",
    glyph: GLYPH_TIMELINE,
    enabled: TIMELINE_V2,
    gap: true,
    run: (h) => h.onTimeline(),
  },

  // Quiet utilities — money, diagnostics, and the structural map.
  {
    key: "usage",
    label: "Cost & usage",
    hint: "Token spend and per-developer cost. This month and all time, the one home for usage.",
    glyph: GLYPH_USAGE,
    enabled: true,
    gap: true,
    run: (h) => h.onCostUsage(),
  },
  {
    key: "doctor",
    label: "Project health",
    hint: "A quick health check of your project. Finds anything stuck or half-set-up before it trips you, and tells you how to fix it.",
    glyph: GLYPH_DOCTOR,
    enabled: true,
    run: (h) => h.onDoctor(),
  },
  {
    key: "codemap",
    label: "Code Map",
    hint: "A map of your project's files and how they connect. What touches what.",
    glyph: GLYPH_CODEMAP,
    enabled: CODE_MAP_ENABLED,
    run: (h) => h.onCodeMap(),
  },
];

/** The destinations actually on screen right now — flags applied, and the
 *  impacts entry only when something is really reaching your work. */
export function visibleTraceDestinations(
  impactsCount: number,
): TraceDestination[] {
  return TRACE_DESTINATIONS.filter(
    (d) => d.enabled && (!d.onlyWhenImpacts || impactsCount > 0),
  );
}
