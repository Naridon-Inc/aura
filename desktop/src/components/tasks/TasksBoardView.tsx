// The board lens of the Dashboard: the dashboard's columns and cards, one
// column per group and one card per task.
//
// Only status columns accept a drop or a quick add, because only they know
// what landing a card there should set. Grouped by owner or label, a drop
// would have to guess whether it replaces an owner or adds one.

import { useCallback, useEffect, useMemo, useState, type JSX } from "react";

import type {
  Task,
  TaskLabel,
  TaskState,
  TaskStatus,
  TaskViewDisplayProp,
  TaskViewGroupBy,
  TeamMember,
} from "../../lib/api";
import { TASK_STATUS_ORDER } from "../../lib/taskStatus";
import { formatAgo } from "../../lib/freshness";
import { openExternal } from "../../lib/openExternal";
import { AssigneeStack } from "../AssigneePicker";
import { MentionedText } from "../Mentions";
import {
  TaskBoard,
  TaskBoardCard,
  TaskBoardColumn,
  TaskCardContent,
  TaskQuickAdd,
  type TaskOpenModifiers,
} from "../ui/tasks-board";
import { TaskMenuItems, cardFacts, taskSummary } from "./taskFacts";
import { groupTasks } from "./taskGrouping";
import { TaskPriorityBars, TaskStatusTag } from "./taskGlyphs";
import { DEFAULT_DISPLAY_PROPS } from "./TasksFilterBar";
import { budgetGroups, rowCap, FIRST_PAINT_CARDS, REVEAL_STEP_CARDS } from "./rowBudget";
import { RevealFoot } from "./RevealFoot";

export function TasksBoardView({
  tasks,
  members,
  taskStates,
  taskLabels,
  groupBy,
  displayProps,
  focusedId,
  multiSelectedIds,
  onSelect,
  onDropOn,
  onStatus,
  onQuickCreate,
}: {
  tasks: Task[];
  members: TeamMember[];
  taskStates: TaskState[];
  taskLabels: TaskLabel[];
  groupBy: TaskViewGroupBy;
  displayProps: TaskViewDisplayProp[];
  focusedId: string | null;
  /** The bulk-selection set, so a card shows it is part of what the bulk
   *  toolbar will act on. */
  multiSelectedIds: string[];
  onSelect: (id: string, e?: TaskOpenModifiers) => void;
  /** A card carried into a status column. */
  onDropOn: (id: string, status: TaskStatus) => void;
  /** Move a card from its menu or with Alt+Left / Alt+Right. */
  onStatus: (id: string, status: TaskStatus) => void;
  onQuickCreate: (title: string, status: TaskStatus) => Promise<void> | void;
}): JSX.Element {
  const selectedSet = new Set(multiSelectedIds);
  const groups = useMemo(
    () => groupTasks(tasks, groupBy, { members, taskLabels }),
    [tasks, groupBy, members, taskLabels],
  );
  const childCounts = useMemo(() => countChildren(tasks), [tasks]);

  // A column draws a first slice of its cards and reveals more as the reader
  // scrolls (see ./rowBudget), so a board of hundreds paints at once. The
  // budget is per column because columns scroll independently.
  const [reveals, setReveals] = useState(0);
  useEffect(() => {
    setReveals(0);
  }, [tasks, groupBy]);
  const reveal = useCallback(() => setReveals((r) => r + 1), []);
  const cap = rowCap(reveals, FIRST_PAINT_CARDS, REVEAL_STEP_CARDS);

  return (
    <TaskBoard label="Dashboard">
      {groups.map((g) => {
        const status = g.status ?? null;
        const { groups: lanes, hidden } = budgetGroups([g], cap);
        const drawn = lanes[0] ?? { ...g, total: g.tasks.length, tasks: [] };
        return (
          <TaskBoardColumn
            key={g.key}
            label={g.label}
            hint={g.hint}
            count={drawn.total}
            icon={g.glyph}
            onDrop={status ? (id) => onDropOn(id, status) : undefined}
            empty={g.emptyHint}
            footer={
              status ? (
                <TaskQuickAdd onCreate={(title) => onQuickCreate(title, status)} />
              ) : undefined
            }
          >
            {drawn.tasks.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                members={members}
                taskStates={taskStates}
                taskLabels={taskLabels}
                displayProps={displayProps}
                childCount={childCounts.get(t.id) ?? 0}
                focused={t.id === focusedId}
                selected={selectedSet.has(t.id)}
                movable={status != null}
                onOpen={(e) => onSelect(t.id, e)}
                onStatus={(next) => onStatus(t.id, next)}
              />
            ))}
            <RevealFoot hidden={hidden} onReveal={reveal} />
          </TaskBoardColumn>
        );
      })}
    </TaskBoard>
  );
}

function countChildren(tasks: Task[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tasks) {
    const parent = t.parent_id ?? t.epic_id;
    if (parent) out.set(parent, (out.get(parent) ?? 0) + 1);
  }
  return out;
}

function TaskCard({
  task,
  members,
  taskStates,
  taskLabels,
  displayProps,
  childCount,
  focused,
  selected,
  movable,
  onOpen,
  onStatus,
}: {
  task: Task;
  members: TeamMember[];
  taskStates: TaskState[];
  taskLabels: TaskLabel[];
  displayProps: TaskViewDisplayProp[];
  childCount: number;
  focused: boolean;
  selected: boolean;
  /** Status columns only: drag, Alt+arrow and "Move to". */
  movable: boolean;
  onOpen: (e: TaskOpenModifiers) => void;
  onStatus: (next: TaskStatus) => void;
}): JSX.Element {
  const props = new Set<TaskViewDisplayProp>(displayProps ?? DEFAULT_DISPLAY_PROPS);
  const state = task.state_id ? (taskStates.find((s) => s.id === task.state_id) ?? null) : null;
  const index = TASK_STATUS_ORDER.indexOf(task.status);
  const facts = cardFacts(task, props, taskLabels, childCount);
  const assignees =
    props.has("assignee") && task.assignee_ids.length > 0 ? (
      <span title={task.assignee_ids.join(", ")}>
        <AssigneeStack handles={task.assignee_ids} members={members} dense maxAvatars={3} />
      </span>
    ) : null;
  const updated = Date.parse(task.updated_at);

  return (
    <TaskBoardCard
      label={task.title || "(untitled)"}
      taskId={task.id}
      selected={selected}
      focused={focused}
      draggable={movable}
      onOpen={onOpen}
      onMove={
        movable
          ? (dir) => {
              const next = TASK_STATUS_ORDER[index + dir];
              if (next) onStatus(next);
            }
          : undefined
      }
      menu={<TaskMenuItems task={task} onStatus={onStatus} onOpen={onOpen} />}
    >
      <TaskCardContent
        handle={props.has("id") ? `AURA-${task.sequence_id}` : undefined}
        meta={props.has("priority") ? <TaskPriorityBars priority={task.priority} /> : undefined}
        stage={<TaskStatusTag state={state} status={task.status} onStatus={onStatus} />}
        title={<MentionedText text={task.title || "(untitled)"} members={members} />}
        summary={taskSummary(task.description ?? "")}
        footer={
          <>
            {assignees}
            {facts}
          </>
        }
        pr={
          props.has("pr") && task.linked_pr
            ? {
                number: task.linked_pr.number,
                url: task.linked_pr.url,
                onOpen: () => void openExternal(task.linked_pr?.url),
              }
            : undefined
        }
        time={
          Number.isFinite(updated)
            ? { label: formatAgo(updated), title: `Updated ${task.updated_at}` }
            : undefined
        }
      />
    </TaskBoardCard>
  );
}
