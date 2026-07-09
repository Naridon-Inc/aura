// Pure model for the Workspaces center view — the "cool view" that holds the
// whole fleet of parallel copies (worktrees) so the Build sidebar can stay a
// curated few. Conductor keeps its sidebar tidy and pushes the full list into
// two center surfaces: a time-grouped list and a status board. This module is
// the deterministic data layer behind both — it never invents a datum. Every
// diff/PR/agent/time is real (or omitted).

import { isMachineLeaf } from "../../lib/workspaceLabel";
import type { WorktreeRef } from "../WorkspaceRail";
import type { WorktreeBadge } from "../../lib/useWorktreeBadges";

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

// "feat/s1-manifest-signing-prep" → "manifest signing prep". Mirrors the
// roster's humaniser so a copy reads the same in the sidebar and the view.
// A machine worktree branch carries no human meaning — call it a parallel copy.
export function humanizeCopyTitle(branch: string, isMain: boolean): string {
  if (isMain && !branch) return "main copy";
  const seg = branch.split("/").pop() ?? branch;
  if (!seg) return isMain ? "main copy" : "detached copy";
  if (isMachineLeaf(seg)) return "parallel copy";
  const cleaned = seg
    .replace(/^(feat|fix|chore|refactor|docs|test|perf)[-_/]?/i, "")
    .replace(/^\d+[-_]/, "")
    .replace(/[-_]/g, " ")
    .trim();
  return cleaned || seg;
}

function deriveStatus(
  isActive: boolean,
  agents: CopyAgent[],
  hasDiff: boolean,
): CopyStatus {
  if (agents.some((a) => a.attention)) return "attn";
  if (isActive) return "active";
  if (agents.length > 0) return "working";
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
        title: humanizeCopyTitle(w.branch, w.is_main),
        isMain: w.is_main,
        isActive,
        committedAt: w.head_committed_at ?? null,
        added,
        removed,
        changedFiles: badge?.changedFiles ?? 0,
        pr: badge?.pr,
        agents,
        status: deriveStatus(isActive, agents, hasDiff),
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
  { status: "working", label: "Agent on it", hint: "An agent is running here" },
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
export function relTime(committedAt: number | null, nowMs: number): string {
  if (committedAt == null) return "";
  const secs = Math.max(0, Math.floor(nowMs / 1000) - committedAt);
  if (secs < 90) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (days < 30) return `${weeks}w ago`;
  const d = new Date(committedAt * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// 207 → "207", 1432 → "1.4k". Keeps diff pills from overrunning a row.
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}

// Status → the calm swatch + plain label used on chips.
export function statusMeta(status: CopyStatus): {
  label: string;
  tint: string;
} {
  switch (status) {
    case "attn":
      return { label: "Needs you", tint: "var(--color-warning, #f59e0b)" };
    case "working":
      return { label: "Agent on it", tint: "var(--color-accent, #3b82f6)" };
    case "active":
      return { label: "Open now", tint: "var(--color-success, #22c55e)" };
    case "dirty":
      return { label: "Unsaved", tint: "var(--color-text-3)" };
    case "idle":
    default:
      return { label: "Resting", tint: "var(--color-text-4)" };
  }
}
