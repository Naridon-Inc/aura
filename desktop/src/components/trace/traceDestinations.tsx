// Trace · destinations — the ONE list of the places Trace goes, and the icon
// each wears.
//
// It used to be eight hand-written rows in the sidebar, each carrying its own
// label, hint and handler inline. That was fine while the rail was the only way
// in; it stopped being fine the moment Trace grew a second entrance. Two
// hand-written copies of a menu drift within a week — one gains a row, the
// other keeps a stale hint — so both surfaces read this instead.
//
// A destination is a QUESTION Trace answers, not a kind of tool: what happened
// (Overview, My sessions, Team activity), then is my work sound (Goals, Safety
// check, Impacts). The order below is that reading, and the `gap` flag marks
// where one cluster ends and the next begins — rhythm rather than a row of
// ALL-CAPS headings.
//
// The trim left five rows, plus Impacts when something is really reaching your
// work. Memory and Project timeline are gone from the product; Cost & usage
// moved under My sessions, where spend reads as a fact about those runs rather
// than a subject of its own; Project health and Code Map are no longer offered
// here. Those last two are hidden rather than deleted, and both are still
// addressed — `{ kind: "tool", tool: "doctor" }` and `{ kind: "graph" }` — so a
// saved link keeps working while nothing on screen points at them.

import {
  Gauge,
  GitFork,
  Rows3,
  ShieldCheck,
  Stethoscope,
  Target,
  Users,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

import {
  CODE_MAP_ENABLED,
  PROJECT_HEALTH_ENABLED,
  TEAM_ACTIVITY_ENABLED,
} from "../../lib/featureFlags";

/** Which destination the work surface is currently showing. `goals` and
 *  `review` never appear here — they ask Aura a question rather than opening a
 *  pane, so nothing lights up. */
export type TraceKey =
  | "overview"
  | "sessions"
  | "team"
  | "goals"
  | "intent"
  | "review"
  | "checks"
  | "impacts"
  | "rewind"
  | "attest"
  | "doctor"
  | "codemap";

/** The handlers a destination can call. Kept as a bag of callbacks (rather
 *  than one `onGo(key)`) because the asking destination needs App-level
 *  state — the busy guard that stops a second click buying a second agent
 *  turn — and the navigating ones only need the editor store. */
export type TraceHandlers = {
  onOverview: () => void;
  onSessions: () => void;
  onTeamActivity: () => void;
  onIntentAst: () => void;
  onReview: () => void;
  onChecks: () => void;
  onImpacts: () => void;
  onProve: () => void;
  onRewind: () => void;
  onAttest: () => void;
  onCodeMap: () => void;
  onDoctor: () => void;
};

export type TraceDestination = {
  key: TraceKey;
  label: string;
  /** Plain-language "what is this" — several destinations have jargon names
   *  (Attestations, Intent ↔ AST), and the audience is not engineers. */
  hint: string;
  icon: LucideIcon;
  /** Off behind a feature flag → the destination is absent, not disabled. */
  enabled: boolean;
  /** True for a destination that hands a question to Aura instead of opening
   *  a pane. It can never be the active one, and it takes a busy state. */
  asks?: boolean;
  /** Shows only when something is actually reaching your work — a dead menu
   *  entry reading 0 is worse than no entry. */
  onlyWhenImpacts?: boolean;
  /** Start of a new cluster — a gap before this one. */
  gap?: boolean;
  run: (h: TraceHandlers) => void;
};

// ── The list ─────────────────────────────────────────────────────────────────
// Each destination wears an icon from the same line set as the rest of the
// app, so the strip reads like every other view switch.

export const TRACE_DESTINATIONS: TraceDestination[] = [
  {
    key: "overview",
    label: "Overview",
    hint: "Live activity, headline numbers, and a one-line cost summary. At a glance, links to the rest.",
    icon: Gauge,
    enabled: true,
    run: (h) => h.onOverview(),
  },

  // What happened: your own runs, then the team's. Same material, two
  // scopes, which is why they sit together.
  {
    key: "sessions",
    label: "My sessions",
    hint: "Your own AI coding sessions. Open any run to see what changed and why.",
    icon: Rows3,
    enabled: true,
    gap: true,
    run: (h) => h.onSessions(),
  },
  {
    key: "team",
    label: "Team activity",
    hint: "Every AI change across your team, who made it, why, and if it touches the work you're in.",
    icon: Users,
    enabled: TEAM_ACTIVITY_ENABLED,
    run: (h) => h.onTeamActivity(),
  },

  // Two trust rungs: built right (Goals) → reviewed (Safety check). Each
  // answers a distinct question so neither reads as a synonym of the other.
  // Goals is a page — the list of what you asked for, each with its own
  // Prove — so it is a tab; only the safety check is a question to Aura.
  {
    key: "goals",
    label: "Goals",
    hint: "Pick something you asked for and confirm it's truly built. Aura traces it through the real code, end to end.",
    icon: Target,
    enabled: true,
    gap: true,
    run: (h) => h.onProve(),
  },
  {
    key: "review",
    label: "Safety check",
    hint: "A second set of eyes on your changes. Bugs, security holes, and things that don't match what you asked.",
    icon: ShieldCheck,
    enabled: true,
    asks: true,
    run: (h) => h.onReview(),
  },
  {
    key: "impacts",
    label: "Impacts on me",
    hint: "Code you depend on changed on another branch. Fix or acknowledge before it bites.",
    icon: GitFork,
    enabled: true,
    onlyWhenImpacts: true,
    run: (h) => h.onImpacts(),
  },

  // Quiet utilities — diagnostics and the structural map. Both are parked;
  // see their flags for why each is hidden rather than deleted.
  {
    key: "doctor",
    label: "Repository health",
    hint: "A quick health check of your repository. Finds anything stuck or half-set-up before it trips you, and tells you how to fix it.",
    icon: Stethoscope,
    enabled: PROJECT_HEALTH_ENABLED,
    gap: true,
    run: (h) => h.onDoctor(),
  },
  {
    key: "codemap",
    label: "Code Map",
    hint: "A map of your repository's files and how they connect. What touches what.",
    icon: Waypoints,
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
