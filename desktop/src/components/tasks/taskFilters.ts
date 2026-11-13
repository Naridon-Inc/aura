// The Dashboard's pure read-side helpers: which tasks pass the filters in
// force, in what order they are drawn, and how rows merged from several
// projects are deduped. No React here, so each can be exercised on its own.

import type {
  Task,
  TaskPriority,
  TaskViewFilters,
  TaskViewOrderBy,
  TaskViewOrderDir,
} from "../../lib/api";

/** First occurrence wins — the scope is ordered most-recently-opened first, so
 *  the open project's spelling of a shared person or label is the one kept. */
export function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// ─── Filter / order ────────────────────────────────────────────────────
//
// All filter dimensions are AND'd across dimensions, OR'd within. A task
// passes the filter when, for each non-empty dimension, at least one of
// the dimension's values matches the task. `q` is a case-insensitive
// substring match against title + description; empty/undefined dimensions
// are skipped entirely.

export function applyFilters(
  tasks: Task[],
  f: TaskViewFilters,
  currentHandle: string | null,
): Task[] {
  // Pre-resolve `@me` so we don't re-look it up per row.
  const assigneeSet = f.assignee?.map((a) =>
    a === "@me" && currentHandle ? currentHandle : a,
  );
  // `@unassigned` is a special bucket: keep only rows with no assignee
  // on either the legacy `assignee` field or the OO.3 multi `assignee_ids`.
  const matchUnassigned = assigneeSet?.includes("@unassigned");
  const realAssignees = assigneeSet?.filter((a) => a !== "@unassigned");
  const q = f.q?.trim().toLowerCase() ?? "";
  // Same day boundary the sidebar counts against, so its "Overdue N" badge and
  // the list you land on always agree.
  const today = new Date().toISOString().slice(0, 10);
  return tasks.filter((t) => {
    if (f.overdue) {
      if (t.status === "done") return false;
      if (!t.due_date || t.due_date >= today) return false;
    }
    if (f.status?.length && !f.status.includes(t.status)) return false;
    if (f.priority?.length && !f.priority.includes(t.priority)) return false;
    if (matchUnassigned) {
      if (t.assignee_ids.length > 0 || t.assignee) return false;
    } else if (realAssignees?.length) {
      const hit =
        (t.assignee && realAssignees.includes(t.assignee)) ||
        t.assignee_ids.some((a) => realAssignees.includes(a));
      if (!hit) return false;
    }
    if (
      f.agent?.length &&
      !(t.agent_assignee && f.agent.includes(t.agent_assignee))
    )
      return false;
    if (f.labels?.length) {
      const hit = t.labels.some((l) => f.labels!.includes(l));
      if (!hit) return false;
    }
    if (q) {
      const hay = `${t.title}\n${t.description ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// OO.3 — sort rank for the 5-stop ladder. Lower number sorts first
// (urgent rises to the top in asc; bottom in desc).
const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export function applyOrder(
  tasks: Task[],
  by: TaskViewOrderBy,
  dir: TaskViewOrderDir,
): Task[] {
  const mul = dir === "asc" ? 1 : -1;
  // Stable sort fallback — secondary key on created_at so the order is
  // deterministic when the primary key ties (e.g. two tasks both
  // priority=medium with no due date).
  const out = [...tasks];
  out.sort((a, b) => {
    const cmp = compareBy(a, b, by) * mul;
    if (cmp !== 0) return cmp;
    return a.created_at.localeCompare(b.created_at);
  });
  return out;
}

function compareBy(a: Task, b: Task, by: TaskViewOrderBy): number {
  switch (by) {
    case "title":
      return a.title.localeCompare(b.title);
    case "priority":
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    case "due":
      return cmpNullable(a.due_date, b.due_date);
    case "estimate":
      return cmpNullable(a.estimate ?? null, b.estimate ?? null);
    case "created":
      return a.created_at.localeCompare(b.created_at);
    case "updated":
    default:
      return a.updated_at.localeCompare(b.updated_at);
  }
}

function cmpNullable<T extends string | number>(
  a: T | null | undefined,
  b: T | null | undefined,
): number {
  // Treat null/undefined as "very large" so they sort to the end in asc
  // mode. The dir multiplier inverts for desc, which puts null first —
  // that's consistent with how Plane handles missing fields.
  const aMissing = a == null;
  const bMissing = b == null;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}
