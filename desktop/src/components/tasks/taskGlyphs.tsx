// Task-side adapters onto the shared board glyph vocabulary.
//
// The board design system speaks in generic terms — a state *group* and a
// priority *level* — because Mission Control's stages and the Workspaces
// board's copy statuses aren't task statuses. These two helpers translate the
// task domain into that vocabulary, and are the only place that mapping
// exists. The board view, the list view and the sprint grid all go through
// them, so a status can never draw one shape in one view and another shape in
// the next.

import type { JSX } from "react";

import { BoardCardPriority, StateGlyph } from "../board";
import { StatePill } from "./StatePill";
import { TASK_STATUS_LABEL } from "./taskColumns";
import { TASK_STATUS_ORDER } from "../../lib/taskStatus";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import type {
  TaskPriority,
  TaskState,
  TaskStatus,
  TaskViewGroupBy,
} from "../../lib/api";

/** Which shape a legacy `status` gets, and what colour it carries.
 *
 *  The shape is the signal, so only the one genuinely live state ("In
 *  Progress") spends a colour; the rest sit on the neutral ramp instead of
 *  each owning a hue. That colour is amber — work in flight — matching
 *  CrewCanvas's working dot and the Automations run dot. Deliberately not the
 *  accent: on a board the accent belongs to the card you have *selected*, and
 *  a ring that borrowed it made every running task look picked. */
const STATUS_GLYPH: Record<TaskStatus, { group: string; color: string }> = {
  backlog: { group: "backlog", color: "var(--color-text-4)" },
  in_progress: { group: "started", color: "var(--color-amber)" },
  in_review: { group: "started", color: "var(--color-text-3)" },
  done: { group: "completed", color: "var(--color-text-3)" },
};

/** The 12px status ring shown in board column headers, list group headers and
 *  on cards without a custom state. */
export function TaskStateRing({
  statusId,
  size = 12,
}: {
  statusId: TaskStatus;
  size?: number;
}): JSX.Element {
  const g = STATUS_GLYPH[statusId] ?? STATUS_GLYPH.backlog;
  return <StateGlyph group={g.group} color={g.color} size={size} />;
}

/** Whether a card or row should wear its status at all.
 *
 *  Grouped by status, the lane header — which is sticky in both layouts — says
 *  it already, so a chip repeating it is the same fact twice within a few
 *  pixels. Grouped any other way there is no header saying it, and the status
 *  is the most useful thing a card can tell you. A state the user renamed
 *  always shows, because no header carries that name. */
export function shouldShowStateChip(
  state: TaskState | null | undefined,
  groupBy: TaskViewGroupBy,
): boolean {
  if (state && !state.is_default) return true;
  return groupBy !== "status";
}

/** The status chip a card or a list row wears.
 *
 *  There are two state vocabularies in here and they don't line up. Lanes,
 *  group headers, counts, the rail and the filter menu all speak the canonical
 *  four — Backlog / In progress / In review / Done (lib/taskStatus). The state
 *  catalog seeds five — Backlog / Todo / In progress / Done / Cancelled — and
 *  the mirror between them is lossy in both directions: `unstarted` ("Todo")
 *  maps down to the Backlog lane, `in_review` has no state of its own so it
 *  resolves up to "In progress", and `cancelled` lands in Done. Rendering the
 *  catalog name meant a card in the Backlog lane said "Todo", a card in the In
 *  review lane said "In progress", and a Done card said "Cancelled" — each one
 *  contradicting the header a few pixels above it. On this repo that was 40 of
 *  141 cards.
 *
 *  So a *seeded* state has nothing to add over the status and defers to it. A
 *  state the user actually created or renamed does have something to say, and
 *  keeps its own name and colour. */
export function TaskStateChip({
  state,
  status,
  dense = false,
}: {
  state: TaskState | null | undefined;
  status: TaskStatus;
  dense?: boolean;
}): JSX.Element {
  if (state && !state.is_default) {
    return <StatePill state={state} dense={dense} />;
  }
  const label = TASK_STATUS_LABEL[status] ?? TASK_STATUS_LABEL.backlog;
  const pad = dense ? "pl-[5px] pr-[7px] py-px" : "pl-[7px] pr-[9px] py-[2px]";
  return (
    <span
      className={`inline-flex items-center gap-[5px] ${pad} text-xs rounded-full border-[0.5px] border-line-soft bg-bg-2 text-text-2 whitespace-nowrap font-medium`}
      title={label}
    >
      <TaskStateRing statusId={status} size={dense ? 9 : 11} />
      <span className="truncate max-w-[120px]">{label}</span>
    </span>
  );
}

/** The status tag on a list row: the same chip, and a way to change it.
 *
 *  This is where the kanban's one irreplaceable verb went. Lanes could say the
 *  status and let you drag a card into another one; a list can say it on every
 *  row, which the lanes could not, but until now it could only say it. So the
 *  tag opens the four statuses and sets the one you pick — the whole of "move
 *  this card to In progress", without a drawing whose only job was to hold the
 *  lanes you dragged between.
 *
 *  Only the canonical four. A state the user created has a name of its own and
 *  is set from the task's detail, where the full catalog lives; offering half
 *  the catalog here would make the menu's silence about the rest look like the
 *  rest don't exist. */
export function TaskStatusTag({
  state,
  status,
  onStatus,
  dense = false,
}: {
  state: TaskState | null | undefined;
  status: TaskStatus;
  /** Omit for a read-only row — then this is exactly `TaskStateChip`. */
  onStatus?: (next: TaskStatus) => void;
  dense?: boolean;
}): JSX.Element {
  const chip = <TaskStateChip state={state} status={status} dense={dense} />;
  if (!onStatus) return chip;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // The row underneath opens the task. Without this, picking a status
          // would also open the thing whose status you just set.
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          title="Change status"
          aria-label={`Status: ${TASK_STATUS_LABEL[status]}. Change it`}
          className="rounded-full focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {chip}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {TASK_STATUS_ORDER.map((id) => (
          <DropdownMenuItem
            key={id}
            disabled={id === status}
            onSelect={() => onStatus(id)}
          >
            <TaskStateRing statusId={id} size={10} />
            {TASK_STATUS_LABEL[id]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Priority as a 0–4 level for the shared three-bar signal. */
const PRIORITY_LEVEL: Record<TaskPriority, 0 | 1 | 2 | 3 | 4> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};

/** Plain name for a priority — exported because the sub-task table has a
 *  column literally headed "Priority" and needs the word beside the bars. */
export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export function TaskPriorityBars({
  priority,
}: {
  priority: TaskPriority;
}): JSX.Element {
  return (
    <BoardCardPriority
      level={PRIORITY_LEVEL[priority] ?? 0}
      label={TASK_PRIORITY_LABEL[priority] ?? "None"}
    />
  );
}
