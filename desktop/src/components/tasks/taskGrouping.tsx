// How a set of tasks becomes lanes on the board and sections in the list.
//
// The Display menu offers six ways to group — None, Status, Priority,
// Assignee, Goal, Label — the page subtitle announces the choice, and a saved
// view stores it. The layouts used to ignore all of that and group by status
// regardless, so most of the options changed one word in the subtitle and
// nothing else on the screen.
//
// The choice lands here, once. That mattered when there were two layouts that
// could disagree about what a group is; it matters more now that there is one
// list and grouping is the whole of how the work rearranges — Goal in
// particular is the old Plan view, folded in as a cut rather than a page.

import type { JSX, ReactNode } from "react";
import { Target } from "lucide-react";

import type {
  Task,
  TaskLabel,
  TaskPriority,
  TaskStatus,
  TaskViewGroupBy,
  TeamMember,
} from "../../lib/api";
import { AssigneeStack } from "../AssigneePicker";
import { TASK_COLUMNS } from "./taskColumns";
import { TASK_PRIORITY_LABEL, TaskPriorityBars, TaskStateRing } from "./taskGlyphs";

/** What an empty status lane says. Plain language, and specific to the lane —
 *  a non-engineer reading an empty "In Review" should learn what would put
 *  something there, not just that it's empty. Only status groups get one,
 *  because only status groups are kept visible when empty. */
export const STATUS_EMPTY_HINT: Record<TaskStatus, string> = {
  backlog: "Nothing waiting. New work lands here first.",
  in_progress: "Nothing being worked on right now.",
  in_review: "Nothing waiting to be looked over.",
  done: "Nothing finished yet.",
};

/** Urgent first — a board grouped by priority reads top-down like a triage
 *  queue, which is the only reason to group by it. */
const PRIORITY_ORDER: TaskPriority[] = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
];

export type TaskGroup = {
  /** Stable key for React and for the list's collapse set. */
  key: string;
  label: string;
  /** One-line gloss shown as the header's tooltip. */
  hint?: string;
  glyph?: ReactNode;
  tasks: Task[];
  /** Set only when the group *is* a status — the one case where a lane knows
   *  what a card dropped onto it, or quick-added into it, should become.
   *  Everything downstream keys drag-and-drop and quick-add off this rather
   *  than off `groupBy`, so a lane can never offer a move it can't make. */
  status?: TaskStatus;
  /** Set only on status groups, which are the only ones kept visible at zero
   *  and therefore the only ones that ever need to explain themselves empty.
   *  Every other dimension returns just the groups that hold something,
   *  because an empty "assigned to Dana" lane is noise, not information. */
  emptyHint?: string;
};

export function groupTasks(
  tasks: Task[],
  groupBy: TaskViewGroupBy,
  ctx: {
    members: TeamMember[];
    taskLabels: TaskLabel[];
    /** Card id → goal name, off the loop graph. Only "goal" reads it; absent
     *  for callers that don't group that way, and empty for a project the crew
     *  has never planned over. */
    goalOfTask?: Record<string, string>;
  },
): TaskGroup[] {
  if (groupBy === "status") {
    return TASK_COLUMNS.map((col) => ({
      key: col.id,
      label: col.label,
      glyph: <TaskStateRing statusId={col.id} />,
      tasks: tasks.filter((t) => t.status === col.id),
      status: col.id,
      emptyHint: STATUS_EMPTY_HINT[col.id],
    }));
  }

  if (groupBy === "priority") {
    return PRIORITY_ORDER.map((p) => ({
      key: p,
      label: TASK_PRIORITY_LABEL[p],
      glyph: <TaskPriorityBars priority={p} />,
      tasks: tasks.filter((t) => t.priority === p),
    })).filter((g) => g.tasks.length > 0);
  }

  if (groupBy === "assignee") {
    // A task with two owners lands in both their groups, so the sum of the
    // group counts can exceed the task count. That's Plane's behaviour and the
    // honest one: hiding a task from one of its owners to keep the arithmetic
    // tidy is the worse trade.
    const byHandle = new Map<string, Task[]>();
    const unassigned: Task[] = [];
    for (const t of tasks) {
      const owners = t.assignee_ids.length
        ? t.assignee_ids
        : t.assignee
          ? [t.assignee]
          : [];
      if (owners.length === 0) {
        unassigned.push(t);
        continue;
      }
      for (const h of owners) {
        const bucket = byHandle.get(h);
        if (bucket) bucket.push(t);
        else byHandle.set(h, [t]);
      }
    }
    const groups: TaskGroup[] = Array.from(byHandle.entries())
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([handle, list]) => {
        const member = ctx.members.find(
          (m) => m.handle === handle || m.email === handle,
        );
        return {
          key: `assignee:${handle}`,
          label: member?.name ?? handle,
          hint: member ? `@${member.handle}` : undefined,
          glyph: (
            <AssigneeStack
              handles={[handle]}
              members={ctx.members}
              dense
              maxAvatars={1}
            />
          ),
          tasks: list,
        };
      });
    // Always last: it's the pile nobody has picked up, not a person.
    if (unassigned.length > 0) {
      groups.push({
        key: "assignee:none",
        label: "Unassigned",
        hint: "Nobody has picked these up yet",
        tasks: unassigned,
      });
    }
    return groups;
  }

  if (groupBy === "goal") {
    // The Plan view, as a grouping. It drew each goal with its work beneath
    // it; this is the same two levels, in the list, so the rest of the row —
    // status you can set, priority, assignee, the filters — comes along
    // instead of being left behind on the other page.
    //
    // A task belongs to at most one goal here (the index keeps the first goal
    // that claims a card), so unlike assignee and label the counts sum.
    const byGoal = new Map<string, Task[]>();
    const none: Task[] = [];
    for (const t of tasks) {
      const goal = ctx.goalOfTask?.[t.id];
      if (!goal) {
        none.push(t);
        continue;
      }
      const bucket = byGoal.get(goal);
      if (bucket) bucket.push(t);
      else byGoal.set(goal, [t]);
    }
    const groups: TaskGroup[] = Array.from(byGoal.entries())
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([goal, list]) => ({
        key: `goal:${goal}`,
        label: goal,
        hint: "What this work is for",
        glyph: <Target className="h-3 w-3 text-text-4" strokeWidth={1.5} aria-hidden />,
        tasks: list,
      }));
    // Last, and named for what it is: work nobody has tied to an outcome yet.
    if (none.length > 0) {
      groups.push({
        key: "goal:none",
        label: "No goal",
        hint: "Not part of anything the crew is working towards yet",
        tasks: none,
      });
    }
    return groups;
  }

  if (groupBy === "label") {
    // Same multi-membership rule as assignee — a task carrying two labels
    // appears under both.
    const byLabel = new Map<string, { label: string; color?: string; tasks: Task[] }>();
    const none: Task[] = [];
    for (const t of tasks) {
      const keys = t.label_ids.length ? t.label_ids : t.labels;
      if (keys.length === 0) {
        none.push(t);
        continue;
      }
      for (const k of keys) {
        const entry = ctx.taskLabels.find((l) => l.id === k || l.name === k);
        const key = entry?.id ?? k;
        const bucket = byLabel.get(key);
        if (bucket) bucket.tasks.push(t);
        else
          byLabel.set(key, {
            label: entry?.name ?? k,
            color: entry?.color,
            tasks: [t],
          });
      }
    }
    const groups: TaskGroup[] = Array.from(byLabel.entries())
      .sort(
        (a, b) =>
          b[1].tasks.length - a[1].tasks.length ||
          a[1].label.localeCompare(b[1].label),
      )
      .map(([key, v]) => ({
        key: `label:${key}`,
        label: v.label,
        glyph: v.color ? <LabelDot color={v.color} /> : undefined,
        tasks: v.tasks,
      }));
    if (none.length > 0) {
      groups.push({
        key: "label:none",
        label: "No label",
        tasks: none,
      });
    }
    return groups;
  }

  // "None" — one group holding everything. It still gets a header, because a
  // count you can see beats a count you have to infer, and the list's collapse
  // affordance stays where it was.
  return [{ key: "all", label: "All tasks", tasks }];
}

function LabelDot({ color }: { color: string }): JSX.Element {
  return (
    <span
      className="h-2 w-2 flex-shrink-0 rounded-full"
      style={{ background: color }}
      aria-hidden
    />
  );
}
