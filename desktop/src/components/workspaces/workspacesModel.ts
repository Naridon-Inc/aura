// Pure model for the Workspaces center view — the "cool view" that holds the
// whole fleet of parallel copies (worktrees) so the Build sidebar can stay a
// curated few. Conductor keeps its sidebar tidy and pushes the full list into
// two center surfaces: a time-grouped list and a status board. This module is
// the deterministic data layer behind both — it never invents a datum. Every
// diff/PR/agent/time is real (or omitted).

import { humanizeCopyTitle } from "../../lib/workspaceLabel";
import type { WorktreeRef } from "../../lib/workspaceRef";
import type { CloudPlacement } from "../../lib/api";
import type { WorktreeBadge } from "../../lib/useWorktreeBadges";
import { relativeAgeFromDelta } from "../../lib/relativeTime";
import { shortDateFromSecs } from "../../lib/calendarDate";

// One agent parked on a copy — normalised across live tabs + the persisted
// per-repo roster upstream (the surface unions them). `attention` = the agent
// is waiting on the user (plain words: "needs you").
export type CopyAgent = {
  agentId: string;
  label: string;
  attention: boolean;
};

// The honest state of a copy, derived only from live signals:
//   active  — the checkout currently open in the app
//   attn    — an agent on it is waiting for the user
//   working — an agent is on it, running
//   dirty   — uncommitted changes, no agent
//   idle    — nothing happening
export type CopyStatus = "active" | "attn" | "working" | "dirty" | "idle";

// A single worktree ("parallel copy"), flattened across every open project.
export type WorkspaceCopy = {
  // path is unique per checkout → the row key + open target.
  path: string;
  root: string; // owning project root
  projectName: string;
  projectEmoji?: string;
  projectLetter: string;
  projectAccent?: string;
  branch: string; // raw branch slug ("" when detached)
  title: string; // humanised, readable ("manifest signing prep")
  isMain: boolean;
  isActive: boolean;
  committedAt: number | null; // unix seconds of HEAD commit, or null
  added: number;
  removed: number;
  changedFiles: number;
  pr?: { number: number; state: string };
  agents: CopyAgent[];
  // Set when this copy's branch is in flight on a machine that isn't this one.
  // Every other field here describes this disk, which is why the fleet views
  // could show a copy as resting while a runner was mid-turn on it — the local
  // checkout genuinely is idle, and nothing else on the row disagrees.
  cloud?: CloudPlacement;
  status: CopyStatus;
};

// The project shape the surface hands in — mirrors what App builds for the
// roster (id = root, plus display bits).
export type ProjectMeta = {
  id: string; // repo root
  name: string;
  emoji?: string;
  letter: string;
  accent?: string;
};

export type BuildCopiesInput = {
  projects: ProjectMeta[];
  worktreesByRoot: Record<string, WorktreeRef[]>;
  badgeByPath: Record<string, WorktreeBadge>;
  agentsByPath: Map<string, CopyAgent[]>;
  activePath: string;
};

// An agent running on a runner is an agent running. `submitted` is not: the
// job is queued and no machine has claimed it, so calling that lane "Agent on
// it" would promise something nobody has started. A queued copy keeps whatever
// its local state says and carries the still cloud mark, which is the honest
// picture — waiting, somewhere else.
function cloudIsRunning(cloud?: CloudPlacement): boolean {
  return !!cloud && cloud.status !== "submitted";
}

function deriveStatus(
  isActive: boolean,
  agents: CopyAgent[],
  hasDiff: boolean,
  cloud?: CloudPlacement,
): CopyStatus {
  if (agents.some((a) => a.attention)) return "attn";
  if (isActive) return "active";
  if (agents.length > 0 || cloudIsRunning(cloud)) return "working";
  if (hasDiff) return "dirty";
  return "idle";
}

// Flatten every project's worktrees into one copy list. A project with no
// sibling worktrees still yields its main checkout (a plain repo is one copy).
export function buildCopies(input: BuildCopiesInput): WorkspaceCopy[] {
  const { projects, worktreesByRoot, badgeByPath, agentsByPath, activePath } =
    input;
  const out: WorkspaceCopy[] = [];
  for (const proj of projects) {
    const raw = worktreesByRoot[proj.id] ?? [];
    const wts: WorktreeRef[] = raw.length
      ? raw
      : [
          {
            path: proj.id,
            branch: "",
            head: "",
            is_main: true,
            locked: false,
            head_committed_at: null,
          },
        ];
    for (const w of wts) {
      const badge = badgeByPath[w.path];
      const added = badge?.added ?? 0;
      const removed = badge?.removed ?? 0;
      const agents = agentsByPath.get(w.path) ?? [];
      const isActive = w.path === activePath;
      const hasDiff = added > 0 || removed > 0;
      out.push({
        path: w.path,
        root: proj.id,
        projectName: proj.name,
        projectEmoji: proj.emoji,
        projectLetter: proj.letter,
        projectAccent: proj.accent,
        branch: w.branch,
        title: humanizeCopyTitle(w.branch, w.is_main, w.path),
        isMain: w.is_main,
        isActive,
        committedAt: w.head_committed_at ?? null,
        added,
        removed,
        changedFiles: badge?.changedFiles ?? 0,
        pr: badge?.pr,
        agents,
        cloud: badge?.cloud,
        status: deriveStatus(isActive, agents, hasDiff, badge?.cloud),
      });
    }
  }
  return out;
}

// ── recency buckets (the time-grouped "All" tab) ──────────────────────────

const DAY = 86_400;

export type TimeBucket = { key: string; label: string; copies: WorkspaceCopy[] };

// Group by HEAD commit recency, newest bucket first, and sort within a bucket
// newest-first. Copies with no known time sink to a final "No commit date"
// bucket rather than being faked into "Today".
export function bucketByTime(
  copies: WorkspaceCopy[],
  nowMs: number,
): TimeBucket[] {
  const now = Math.floor(nowMs / 1000);
  const startOfToday = now - (now % DAY);
  const order = [
    "active",
    "today",
    "yesterday",
    "week",
    "month",
    "older",
    "unknown",
  ] as const;
  const meta: Record<(typeof order)[number], string> = {
    active: "Open now",
    today: "Today",
    yesterday: "Yesterday",
    week: "Earlier this week",
    month: "This month",
    older: "Older",
    unknown: "No commit date",
  };
  const of = (c: WorkspaceCopy): (typeof order)[number] => {
    if (c.isActive) return "active";
    if (c.committedAt == null) return "unknown";
    const t = c.committedAt;
    if (t >= startOfToday) return "today";
    if (t >= startOfToday - DAY) return "yesterday";
    if (t >= startOfToday - 7 * DAY) return "week";
    if (t >= startOfToday - 30 * DAY) return "month";
    return "older";
  };
  const buckets = new Map<string, WorkspaceCopy[]>();
  for (const c of copies) {
    const k = of(c);
    const arr = buckets.get(k) ?? [];
    arr.push(c);
    buckets.set(k, arr);
  }
  const rank = (c: WorkspaceCopy) => c.committedAt ?? -1;
  return order
    .filter((k) => (buckets.get(k)?.length ?? 0) > 0)
    .map((k) => ({
      key: k,
      label: meta[k],
      copies: (buckets.get(k) ?? []).sort((a, b) => rank(b) - rank(a)),
    }));
}

// ── status columns (the "Board" tab) ──────────────────────────────────────

export type StatusColumn = {
  status: CopyStatus;
  label: string;
  hint: string;
  copies: WorkspaceCopy[];
};

const COLUMN_ORDER: { status: CopyStatus; label: string; hint: string }[] = [
  { status: "attn", label: "Needs you", hint: "An agent is waiting on input" },
  // Not "running here" any more: the lane now also holds copies whose work is
  // on a runner, and the cloud mark on the card says which is which.
  {
    status: "working",
    label: "Agent on it",
    hint: "An agent is running on it. On this Mac or on a machine",
  },
  { status: "active", label: "Open now", hint: "The copy you're in" },
  { status: "dirty", label: "Unsaved changes", hint: "Edited, not committed" },
  { status: "idle", label: "Resting", hint: "Nothing in flight" },
];

export function groupByStatus(copies: WorkspaceCopy[]): StatusColumn[] {
  return COLUMN_ORDER.map((col) => ({
    ...col,
    copies: copies
      .filter((c) => c.status === col.status)
      .sort((a, b) => (b.committedAt ?? -1) - (a.committedAt ?? -1)),
  })).filter((col) => col.copies.length > 0);
}

// ── formatting helpers ────────────────────────────────────────────────────

// "just now" / "3h ago" / "2d ago" / "Apr 12" — plain, no clock jargon.
//
// Past a month it stops counting and names the day. "5w ago" is a distance you
// have to do arithmetic on; "Apr 12" is the thing you were actually asking.
export function relTime(committedAt: number | null, nowMs: number): string {
  if (committedAt == null) return "";
  const secs = Math.max(0, Math.floor(nowMs / 1000) - committedAt);
  if (secs >= 30 * 86400) return calendarDay(committedAt);
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromDelta(secs);
}

// The same instant as `relTime`, with the "ago" left off: "now" / "3h" / "2d".
// A time-grouped list already says *when* in its section header, so the row
// only has to say how far into that bucket it sits — and at the right edge of a
// dense row, "4w" reads at a glance where "4w ago" has to be parsed.
export function relTimeShort(committedAt: number | null, nowMs: number): string {
  if (committedAt == null) return "";
  const secs = Math.max(0, Math.floor(nowMs / 1000) - committedAt);
  if (secs >= 30 * 86400) return calendarDay(committedAt);
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromDelta(secs, { style: "compact" });
}

// The far end of both ladders — see lib/calendarDate.
function calendarDay(unixSecs: number): string {
  return shortDateFromSecs(unixSecs);
}

// PR state → its ink. merged = landed (the accent, the one PR state you can
// still navigate to), closed = went nowhere (red), open = live (mint). Shared
// so the boxed pill on the board and the bare number in the list can never
// drift into disagreeing about what a colour means.
export function prTint(state: string): string {
  switch (state.toLowerCase()) {
    case "merged":
      return "var(--color-accent)";
    case "closed":
      return "var(--color-red)";
    default:
      return "var(--color-accent-green)";
  }
}

// Status → the calm swatch + plain label used on chips.
// Every tint here named a token no theme defines (`--color-warning`,
// `--color-success`) or paired a real one with a stale hex, so the chips were
// painted by their fallbacks — a blue/amber/green trio from outside the
// palette. On the pack's own slots: amber for the two states that involve
// waiting, the accent for the copy you are actually standing in, and the text
// ramp for the rest. The two amber states are one family on purpose — both
// mean "in flight" — but "needs you" is the full-strength value and "agent on
// it" is pulled back toward the surface, because only one of them is asking
// you to do something.
export function statusMeta(status: CopyStatus): {
  label: string;
  tint: string;
} {
  switch (status) {
    case "attn":
      return { label: "Needs you", tint: "var(--color-amber)" };
    case "working":
      return {
        label: "Agent on it",
        tint: "color-mix(in srgb, var(--color-amber) 62%, var(--color-text-3))",
      };
    case "active":
      return { label: "Open now", tint: "var(--color-accent)" };
    case "dirty":
      return { label: "Unsaved", tint: "var(--color-text-3)" };
    case "idle":
    default:
      return { label: "Resting", tint: "var(--color-text-4)" };
  }
}
