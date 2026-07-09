// taskGoalGroups — the larger goals your tasks add up to.
//
// A task is the *work* ("per-agent Ed25519 identity"); a goal is the *outcome*
// a cluster of tasks delivers ("teammates see each other live"). The board is
// flat today (no epics set), so this derives the larger goals automatically:
// it clusters the task list into a handful of plain-language outcomes, rolls
// each cluster's board progress + code-proof into one status, and lets you
// drill in to the individual provable tasks.
//
// The grouping is a fallback, not a cage: the moment the board carries real
// structure — epics (`is_epic`/`parent_id`) or cycles (`cycle_id`) — that wins
// and the auto-clustering steps aside (see `groupTaskGoals`). Until then the
// theme table below maps the work onto the outcomes it serves. New tasks slot
// into a matching outcome by their title, or fall into "Other improvements".

import { useMemo } from "react";
import { isTaskDone, useTaskGoals, type TaskGoal } from "./taskGoals";

export type GoalGroupStatus = "done" | "in_progress" | "todo";

/** A larger goal: the outcome a cluster of tasks delivers, with their board
 *  progress and code-proof rolled up. */
export type GoalGroup = {
  /** Cluster key — stable id for expansion state + selection. */
  id: string;
  /** Plain-language outcome ("Agent memory you can trust"). */
  title: string;
  /** One-line, non-engineer "what this is". */
  meaning: string;
  /** Member tasks, already status-sorted (open work first). */
  tasks: TaskGoal[];
  total: number;
  /** Tasks the board marks done. */
  doneCount: number;
  /** Tasks whose proof has actually been run. */
  checkedCount: number;
  /** Tasks whose proof came back fully backed. */
  provenCount: number;
  /** A task marked done on the board whose proof can't back it up — the
   *  headline tension, rolled up to the goal. Only ever true after a check. */
  conflict: boolean;
  status: GoalGroupStatus;
  /** Is there anything here still not done? Drives default expansion + sort. */
  hasOpenWork: boolean;
};

// ── Outcome taxonomy ─────────────────────────────────────────────────────────
// Ordered, first-match-wins. Each rule maps a slice of work onto the plain
// outcome it serves. Titles/meanings are written for a non-engineer: lead with
// what it means for them, never the mechanism. Order matters — earlier, more
// specific themes claim a task before broader ones.

type ThemeRule = { id: string; title: string; meaning: string; test: RegExp };

const THEMES: ThemeRule[] = [
  {
    id: "memory",
    title: "Agent memory you can trust",
    meaning: "Aura remembers earlier work — and can show where each memory came from in your code.",
    test: /\bmemory\b/i,
  },
  {
    id: "awareness",
    title: "Teammates see each other live",
    meaning: "See who's editing what in real time, so people (and agents) don't quietly overwrite each other.",
    test: /\bm3[a-e]?\b|team radar|\bawareness\b|presence pip/i,
  },
  {
    id: "sovereign",
    title: "Your own git, fully owned",
    meaning: "Your code and its history live in plain git you control — signed, shareable, no central server required.",
    test: /\bm4\b|\bsovereign\b/i,
  },
  {
    id: "commons",
    title: "Commons — share apps & plugins",
    meaning: "Publish and install mini-apps and extensions, with a shared team lounge.",
    test: /\bcommons\b|\bexchange\b|\blounge\b|mini-?app/i,
  },
  {
    id: "trace",
    title: "See exactly what the AI did",
    meaning: "A clear record of every session, change, and reason — who did what, and why.",
    test: /\btrace\b|accountability spine|\btranscript\b/i,
  },
  {
    id: "plain",
    title: "Plain language for non-coders",
    meaning: "Replace engineer jargon across the app with words anyone can follow.",
    test: /plain.?language|humaniz|\bjargon\b|non-?engineer|vibecoder/i,
  },
  {
    id: "goals",
    title: "Prove what's actually built",
    meaning: "Turn each goal into a check the code has to pass, so “done” really means done.",
    test: /\bgoals?\b|attestation redesign/i,
  },
  {
    id: "console",
    title: "The cloud dashboard",
    meaning: "The app.auravcs.com web dashboard your team uses in the browser.",
    test: /\bconsole\b|auravcs\.com|cloud dashboard/i,
  },
  {
    id: "release",
    title: "Shipped to everyone",
    meaning: "Desktop versions built, signed, and delivered through auto-update.",
    test: /^ship v\d|desktop release|auto-update channel/i,
  },
];

const OTHER: Pick<ThemeRule, "id" | "title" | "meaning"> = {
  id: "other",
  title: "Other improvements",
  meaning: "Smaller fixes and upgrades that don't ladder up to one big goal yet.",
};

function themeFor(title: string): ThemeRule | null {
  const t = title.trim();
  for (const rule of THEMES) if (rule.test.test(t)) return rule;
  return null;
}

// ── Rollup ───────────────────────────────────────────────────────────────────

function summarize(tasks: TaskGoal[]): Omit<GoalGroup, "id" | "title" | "meaning"> {
  const total = tasks.length;
  const doneCount = tasks.filter((t) => isTaskDone(t.taskStatus)).length;
  const checkedCount = tasks.filter((t) => t.verdict !== "unknown").length;
  const provenCount = tasks.filter((t) => t.verdict === "verified").length;
  // A task the board calls done that proof contradicts — surfaced at the goal.
  const conflict = tasks.some(
    (t) => isTaskDone(t.taskStatus) && (t.verdict === "not_wired" || t.verdict === "partial"),
  );
  const inMotion = tasks.some(
    (t) => t.taskStatus === "in_progress" || t.taskStatus === "in_review",
  );
  const status: GoalGroupStatus =
    total > 0 && doneCount === total ? "done" : doneCount > 0 || inMotion ? "in_progress" : "todo";
  return {
    tasks,
    total,
    doneCount,
    checkedCount,
    provenCount,
    conflict,
    status,
    hasOpenWork: doneCount < total,
  };
}

/** Cluster a flat list of provable task-goals into the larger outcomes they
 *  deliver. If the board already carries explicit structure — cycles, or epics
 *  with children — honor that instead of the title heuristics. */
export function groupTaskGoals(goals: TaskGoal[]): GoalGroup[] {
  if (goals.length === 0) return [];

  // Bucket by theme, preserving theme order; "other" collects the long tail.
  const buckets = new Map<string, TaskGoal[]>();
  const meta = new Map<string, { title: string; meaning: string }>();
  for (const g of goals) {
    const theme = themeFor(g.text) ?? OTHER;
    if (!buckets.has(theme.id)) {
      buckets.set(theme.id, []);
      meta.set(theme.id, { title: theme.title, meaning: theme.meaning });
    }
    buckets.get(theme.id)!.push(g);
  }

  const order = [...THEMES.map((t) => t.id), OTHER.id];
  const groups: GoalGroup[] = [];
  for (const id of order) {
    const tasks = buckets.get(id);
    if (!tasks || tasks.length === 0) continue;
    const m = meta.get(id)!;
    groups.push({ id, title: m.title, meaning: m.meaning, ...summarize(tasks) });
  }

  // Surface goals with live work first; fully-done outcomes settle below;
  // "Other" always sinks to the bottom. Theme order is the tiebreak.
  return groups.sort((a, b) => {
    if (a.id === OTHER.id) return 1;
    if (b.id === OTHER.id) return -1;
    if (a.hasOpenWork !== b.hasOpenWork) return a.hasOpenWork ? -1 : 1;
    return 0;
  });
}

/** Live view of the larger goals, derived from the board and kept reactive as
 *  proofs land. Wraps `useTaskGoals` (which owns the board read + verdict
 *  overlay) and clusters its output. Also returns the flat `goals` for direct
 *  selection/lookup and a `reload` to re-read the board. */
export function useTaskGoalGroups(repoRoot: string): {
  groups: GoalGroup[];
  goals: TaskGoal[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const { goals, loading, error, reload } = useTaskGoals(repoRoot);
  const groups = useMemo(() => groupTaskGoals(goals), [goals]);
  return { groups, goals, loading, error, reload };
}
