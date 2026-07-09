// taskGoals — Goals = your tasks, and whether the code proves them done.
//
// A goal isn't a scraped chat line; it's a thing you put on the board and told
// the AI to build. So the Goals surface reads the real task board (the same
// `.aura/tasks/` the app shows everywhere) and, for each task, overlays a plain
// verdict from `aura prove`: is the code that delivers this task actually there?
//
// The board is the source of truth for the *list* (live, this-project, curated —
// no transcript noise, no cross-project leak). The verdict is persisted per task
// in goalStore (keyed by the task, linked via linkTask), so a checked goal keeps
// its status across reopens and updates reactively the moment a check lands.

import { useEffect, useMemo, useState } from "react";
import { api, type Task, type TaskStatus } from "./api";
import { goalsForTask, rollup, useGoals, type GoalVerdict } from "./goalStore";

/** A board task projected as a provable goal. `text` (the task title) is what we
 *  prove against the code; `verdict` is the last known proof result. */
export type TaskGoal = {
  /** Task id — also the stable selection/verdict key. */
  id: string;
  /** The goal statement we prove: the task's title. */
  text: string;
  description: string;
  taskId: string;
  taskSeq: number;
  /** The board's own status (what it's *marked* as) — distinct from the
   *  proof verdict (whether the code actually delivers it). */
  taskStatus: TaskStatus;
  agent?: string | null;
  updatedAt: string;
  verdict: GoalVerdict;
  ok: number;
  total: number;
  at: number | null;
};

// Open work first, completed last — "are the things I'm working on really there
// yet?" is the live question; auditing done tasks is the on-demand one.
const STATUS_RANK: Record<TaskStatus, number> = {
  in_progress: 0,
  in_review: 1,
  backlog: 2,
  done: 3,
};

export function isTaskDone(status: TaskStatus): boolean {
  return status === "done";
}

/** Plain-language label for a board status — the user's words, no jargon. */
export function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "in_progress":
      return "in progress";
    case "in_review":
      return "in review";
    case "backlog":
      return "to do";
    case "done":
      return "marked done";
    default:
      return String(status);
  }
}

/** Live list of the board's tasks projected as provable goals, with each task's
 *  last proof verdict overlaid. Re-reads the board on mount (and on `reload`);
 *  verdicts update reactively as checks land via the goal store. */
export function useTaskGoals(repoRoot: string): {
  goals: TaskGoal[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Reactive — a recorded run rewrites the store, which re-renders the verdicts.
  const goalRecords = useGoals(repoRoot);

  useEffect(() => {
    if (!repoRoot) {
      setTasks([]);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    api
      .tasksList(repoRoot)
      .then((t) => {
        if (!alive) return;
        setTasks(Array.isArray(t) ? t : []);
        setError(null);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, nonce]);

  const goals = useMemo<TaskGoal[]>(() => {
    // `goalRecords` is referenced so the memo recomputes when verdicts change;
    // the per-task lookup itself reads the fresh store snapshot.
    void goalRecords;
    return tasks
      .filter((t) => !t.is_epic && !t.archived_at && (t.title ?? "").trim().length > 0)
      .map((t) => {
        const linked = goalsForTask(repoRoot, t.id);
        const r = linked.length > 0 ? rollup(linked[0]) : null;
        return {
          id: t.id,
          text: t.title.trim(),
          description: t.description ?? "",
          taskId: t.id,
          taskSeq: t.sequence_id,
          taskStatus: t.status,
          agent: t.agent_assignee ?? null,
          updatedAt: t.updated_at,
          verdict: r?.verdict ?? "unknown",
          ok: r?.ok ?? 0,
          total: r?.total ?? 0,
          at: r?.at ?? null,
        } satisfies TaskGoal;
      })
      .sort((a, b) => {
        const ra = STATUS_RANK[a.taskStatus] ?? 9;
        const rb = STATUS_RANK[b.taskStatus] ?? 9;
        if (ra !== rb) return ra - rb;
        return (b.updatedAt || "").localeCompare(a.updatedAt || "");
      });
  }, [tasks, goalRecords, repoRoot]);

  return { goals, loading, error, reload: () => setNonce((n) => n + 1) };
}
