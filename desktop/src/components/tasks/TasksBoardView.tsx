// The Tasks board (kanban) layout, and the task card both layouts share.
//
// Extracted out of TasksBoard.tsx so the board's *look* lives beside the other
// board surfaces rather than buried three thousand lines into the tracker, and
// so the sprint grid can render the exact same card without importing the
// whole tracker back.
//
// Everything visual here comes from `components/board`; this module's only job
// is to say which task field goes in which slot.

import { useMemo, type JSX, type ReactNode } from "react";
import { Bot, Clock, GitBranch, Link2, ListChecks, Users } from "lucide-react";

import {
  BoardCard,
  BoardCardHandle,
  BoardCardHeader,
  BoardCardLabels,
  BoardCardMeta,
  BoardCardMetaRow,
  BoardCardTitle,
  BoardColumn,
  BoardEmptyHint,
  BoardFrame,
  BoardQuickAdd,
} from "../board";
import type {
  Task,
  TaskLabel,
  TaskState,
  TaskStatus,
  TaskViewDisplayProp,
  TaskViewGroupBy,
  TeamMember,
} from "../../lib/api";
import { AssigneeStack } from "../AssigneePicker";
import { MentionedText } from "../Mentions";
import { TaskIdChip } from "./TaskIdChip";
import { stepProgress } from "../../lib/taskSteps";
import { TASK_COLUMNS, formatDueDate, isOverdue } from "./taskColumns";
import { groupTasks } from "./taskGrouping";
import {
  TaskPriorityBars,
  TaskStateChip,
  shouldShowStateChip,
} from "./taskGlyphs";
import { DEFAULT_DISPLAY_PROPS } from "./TasksFilterBar";

export function TasksBoardView({
  tasks,
  members,
  taskStates,
  taskLabels,
  loading,
  groupBy,
  displayProps,
  focusedId,
  multiSelectedIds,
  onSelect,
  onDragStart,
  onDropOn,
  onQuickCreate,
}: {
  tasks: Task[];
  members: TeamMember[];
  /** State catalog, so a card can render its canonical state name + colour
   *  instead of the legacy `status` enum. */
  taskStates: TaskState[];
  /** Label catalog, so chips render with the catalog colour instead of a
   *  grey-on-grey slug bubble. */
  taskLabels: TaskLabel[];
  loading: boolean;
  /** Which dimension the lanes are cut on. Only "status" lanes can be dropped
   *  into or quick-added to, because only they know what to set. */
  groupBy: TaskViewGroupBy;
  displayProps: TaskViewDisplayProp[];
  focusedId: string | null;
  /** Ids in the bulk-selection set — drives the per-card selected ring so the
   *  user can see what the bulk toolbar will target. */
  multiSelectedIds: string[];
  onSelect: (
    id: string,
    e?: { shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean },
  ) => void;
  onDragStart: (id: string) => void;
  onDropOn: (status: TaskStatus) => void;
  onQuickCreate: (title: string, status: TaskStatus) => Promise<void> | void;
}): JSX.Element {
  const selectedSet = new Set(multiSelectedIds);
  const columnIds = TASK_COLUMNS.map((c) => c.id);
  const groups = useMemo(
    () => groupTasks(tasks, groupBy, { members, taskLabels }),
    [tasks, groupBy, members, taskLabels],
  );

  // Direct sub-task count per task id — drives the sub-item chip on cards that
  // parent other tasks. A child points back via `parent_id` (or the legacy
  // `epic_id`). Computed once over the visible set rather than per card.
  const childCounts = new Map<string, number>();
  for (const t of tasks) {
    const parent = t.parent_id ?? t.epic_id;
    if (parent) childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
  }

  return (
    <BoardFrame>
      {groups.map((g) => {
        // A lane can only be dropped into, or added to, when it *is* a status:
        // that's the only case where landing a card there has an unambiguous
        // meaning. Grouped by assignee or label, a drop would have to guess
        // whether it's replacing an owner or adding one — so those lanes stay
        // inert rather than doing something surprising.
        const droppable = g.status != null;
        return (
          <BoardColumn
            key={g.key}
            title={g.label}
            titleHint={g.hint}
            count={g.tasks.length}
            loading={loading}
            collapsible
            glyph={g.glyph}
            onDropCard={droppable ? () => onDropOn(g.status!) : undefined}
            emptyHint={
              g.emptyHint ? <BoardEmptyHint>{g.emptyHint}</BoardEmptyHint> : undefined
            }
            footer={
              droppable ? (
                <BoardQuickAdd
                  columnId={g.status!}
                  columnIds={columnIds}
                  onCreate={(title) => onQuickCreate(title, g.status!)}
                />
              ) : undefined
            }
          >
            {g.tasks.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                members={members}
                taskStates={taskStates}
                taskLabels={taskLabels}
                groupBy={groupBy}
                displayProps={displayProps}
                childCount={childCounts.get(t.id) ?? 0}
                focused={t.id === focusedId}
                selected={selectedSet.has(t.id)}
                draggable={droppable}
                onClick={(e) => onSelect(t.id, e)}
                onDragStart={() => onDragStart(t.id)}
              />
            ))}
          </BoardColumn>
        );
      })}
    </BoardFrame>
  );
}

export function TaskCard({
  task,
  members,
  taskStates,
  taskLabels,
  groupBy = "none",
  displayProps,
  childCount = 0,
  focused = false,
  selected = false,
  draggable = true,
  onClick,
  onDragStart,
}: {
  task: Task;
  members: TeamMember[];
  /** Direct sub-task count — renders a sub-item chip when > 0. */
  childCount?: number;
  taskStates?: TaskState[];
  taskLabels?: TaskLabel[];
  /** What the surrounding lanes are cut on — decides whether this card's
   *  status is news or a repeat of the header above it. Defaults to "none"
   *  (show it) for callers whose lanes aren't statuses at all, like the sprint
   *  grid's weeks. */
  groupBy?: TaskViewGroupBy;
  /** Display-prop set from the active view. When undefined, falls back to the
   *  default set so callers that don't plumb it (the sprint grid) keep
   *  working. */
  displayProps?: TaskViewDisplayProp[];
  focused?: boolean;
  selected?: boolean;
  /** Off for the sprint grid, whose lanes aren't status and so can't be
   *  dragged between. */
  draggable?: boolean;
  onClick: (e: { shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean }) => void;
  onDragStart?: () => void;
}): JSX.Element {
  const props = useMemo(
    () => new Set<TaskViewDisplayProp>(displayProps ?? DEFAULT_DISPLAY_PROPS),
    [displayProps],
  );

  // Resolved custom state — falls back to the status ring when the catalog
  // isn't plumbed or the task has no custom state.
  const state =
    taskStates && task.state_id
      ? (taskStates.find((s) => s.id === task.state_id) ?? null)
      : null;

  const overdue =
    props.has("due") && task.due_date != null && isOverdue(task.due_date);

  // Footer chips, in Plane's DOM order: state, priority, dates, then the
  // counts, then labels last. Each one drops out entirely when its display
  // prop is off or its value is absent — never an empty box.
  const chips: ReactNode[] = [];
  if (shouldShowStateChip(state, groupBy)) {
    chips.push(
      <span key="state">
        <TaskStateChip state={state} status={task.status} dense />
      </span>,
    );
  }
  // Was unconditional while every other chip here honoured its display prop,
  // so switching "Priority" off in the Display menu did nothing to the bars.
  if (props.has("priority")) {
    chips.push(<TaskPriorityBars key="priority" priority={task.priority} />);
  }
  if (props.has("due") && task.due_date) {
    chips.push(
      <BoardCardMeta
        key="due"
        icon={Clock}
        tone={overdue ? "alert" : undefined}
        title={`Due ${task.due_date}`}
      >
        {formatDueDate(task.due_date)}
      </BoardCardMeta>,
    );
  }
  if (props.has("estimate") && task.estimate != null) {
    chips.push(
      <BoardCardMeta key="est" title="Estimate">
        {task.estimate} pts
      </BoardCardMeta>,
    );
  }
  if (props.has("agent") && task.agent_assignee) {
    chips.push(
      <BoardCardMeta key="agent" icon={Bot} title={`Agent: ${task.agent_assignee}`}>
        {task.agent_assignee}
      </BoardCardMeta>,
    );
  }
  if (props.has("pr") && task.linked_pr) {
    chips.push(
      <BoardCardMeta key="pr" icon={Link2} mono title={task.linked_pr.url}>
        #{task.linked_pr.number}
      </BoardCardMeta>,
    );
  }
  if (childCount > 0) {
    chips.push(
      <BoardCardMeta
        key="children"
        icon={GitBranch}
        title={`${childCount} sub-task${childCount === 1 ? "" : "s"}`}
      >
        {childCount}
      </BoardCardMeta>,
    );
  }
  // The crew this task belongs to — so a crew-filed row wears its home on the
  // card, not just in the graph. Hidden for the default (no crew set).
  if (task.crew_id) {
    chips.push(
      <BoardCardMeta key="crew" icon={Users} title={`Crew: ${task.crew_id}`}>
        {task.crew_id}
      </BoardCardMeta>,
    );
  }
  // Plan progress — "3 of 7". Shown whenever the task carries a plan, and
  // nothing at all when it doesn't: a task with no steps has no progress to
  // report, and "0 of 0" would be a lie. Ungated like the sub-task count
  // because it only appears when there's something true to say.
  const plan = stepProgress(task);
  if (plan) {
    chips.push(
      <BoardCardMeta
        key="plan"
        icon={ListChecks}
        title={`Plan: ${plan.done} of ${plan.total} steps done`}
      >
        {plan.done} of {plan.total}
      </BoardCardMeta>,
    );
  }
  if (props.has("labels") && task.labels.length > 0) {
    chips.push(
      <BoardCardLabels
        key="labels"
        labels={task.labels.map((l) => {
          const entry = taskLabels?.find((cl) => cl.name === l || cl.id === l);
          return { key: l, name: entry?.name ?? l, color: entry?.color };
        })}
      />,
    );
  }

  // Assignees are the one unboxed meta — bare avatars, pushed to the right
  // edge, so the footer band has a single focal point.
  let assignees: ReactNode = null;
  if (props.has("assignee") && task.assignee_ids.length > 0) {
    assignees = (
      <span className="ml-auto flex-shrink-0" title={task.assignee_ids.join(", ")}>
        <AssigneeStack
          handles={task.assignee_ids}
          members={members}
          dense
          maxAvatars={3}
        />
      </span>
    );
  } else if (props.has("assignee") && task.assignee) {
    assignees = (
      <span
        className="ml-auto text-xs tabular-nums text-text-3"
        title={`Assigned to ${task.assignee}`}
      >
        @{task.assignee}
      </span>
    );
  }

  return (
    <BoardCard
      selected={selected}
      focused={focused}
      draggable={draggable}
      dataAttrs={{ "data-task-id": task.id }}
      title={task.title}
      onOpen={onClick}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", task.id);
        onDragStart?.();
      }}
    >
      {props.has("id") && (
        <BoardCardHeader>
          <BoardCardHandle>
            <TaskIdChip sequenceId={task.sequence_id} />
          </BoardCardHandle>
        </BoardCardHeader>
      )}

      <BoardCardTitle>
        <MentionedText text={task.title || "(untitled)"} members={members} />
      </BoardCardTitle>

      <BoardCardMetaRow>
        {chips}
        {assignees}
      </BoardCardMetaRow>
    </BoardCard>
  );
}
