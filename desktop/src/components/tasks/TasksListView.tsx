// The Tasks list — THE drawing of the work, now that the kanban, the plan and
// the four-cell strip that chose between them are gone.
//
// It absorbed what each of them carried rather than just outliving them:
//
//   From the kanban, the verb. Its lanes said the status and let you drag a
//   card to change it. A row says its status on a tag — always, even under a
//   heading that says the same thing, because a row you can act on has to state
//   what it is — and that tag opens and sets.
//
//   From the plan, the goal. The plan drew goals with their tasks underneath;
//   a row wears the goal it belongs to as a tag, the rail narrows to one, and
//   Display's group-by cuts the list by goal. Same content, no second page.
//
// The file stays thin: the group header, the row and every chip come from
// `components/board`, and the only thing said here is which task field goes in
// which slot.

import { useMemo, useState, type JSX, type ReactNode } from "react";
import { Bot, Clock, GitBranch, Inbox, Link2, ListChecks, Target, Users } from "lucide-react";

import {
  BoardCardLabels,
  BoardCardMeta,
  BoardEmpty,
  BoardListGroup,
  BoardListRow,
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
import { AsciiSpinner } from "../ui/ascii-spinner";
import { TaskIdChip } from "./TaskIdChip";
import { stepProgress } from "../../lib/taskSteps";
import { formatDueDate, isOverdue } from "./taskColumns";
import { groupTasks } from "./taskGrouping";
import { TaskPriorityBars, TaskStatusTag } from "./taskGlyphs";
import { DEFAULT_DISPLAY_PROPS } from "./TasksFilterBar";

export function TasksListView({
  tasks,
  loading,
  members,
  taskStates,
  taskLabels,
  groupBy,
  displayProps,
  goalOfTask,
  selectedId,
  onSelect,
  onStatus,
  onAddInStatus,
}: {
  tasks: Task[];
  loading: boolean;
  members: TeamMember[];
  taskStates: TaskState[];
  taskLabels: TaskLabel[];
  /** Which dimension the sections are cut on — the same choice the board
   *  honours, from the same Display menu. */
  groupBy: TaskViewGroupBy;
  /** Which properties a row shows. The list used to ignore this entirely, so
   *  the Display menu's property toggles worked on the board and silently did
   *  nothing here. */
  displayProps: TaskViewDisplayProp[];
  /** Card id → the goal it belongs to, resolved by the rail off the loop graph
   *  (lib/tasksFilterStore). Empty for a project with no goals planned, which
   *  is a list with no goal tags rather than a missing one. */
  goalOfTask?: Record<string, string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Set a task's status straight from its tag — what dragging a card between
   *  kanban lanes used to do. */
  onStatus?: (id: string, status: TaskStatus) => void;
  onAddInStatus: (status: TaskStatus) => void;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Direct sub-task count per task id — the same derivation the board view
  // does, so the sub-item chip appears on the same tasks in both layouts.
  const childCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const t of tasks) {
      const parent = t.parent_id ?? t.epic_id;
      if (parent) out.set(parent, (out.get(parent) ?? 0) + 1);
    }
    return out;
  }, [tasks]);

  const groups = useMemo(
    () => groupTasks(tasks, groupBy, { members, taskLabels, goalOfTask }),
    [tasks, groupBy, members, taskLabels, goalOfTask],
  );

  function toggle(id: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-bg-content px-4 sm:px-6">
      {loading && tasks.length === 0 && (
        <div className="flex items-center gap-2 py-6 text-sm text-text-4">
          <AsciiSpinner />
          Loading…
        </div>
      )}
      {/* The board's own empty hero handles a genuinely empty repo, so by the
          time this renders the list is empty for a reason the list itself
          can't know. One quiet line, no competing call to action. */}
      {!loading && tasks.length === 0 && (
        <BoardEmpty
          icon={Inbox}
          title="Nothing to show here"
          body="Tasks you and your agents add will appear in this list, grouped by where they've got to."
          size="sm"
        />
      )}
      {tasks.length > 0 &&
        groups.map((g) => {
          // Empty "In Review" and "Done" groups are hidden to keep the surface
          // on active work; Backlog and In Progress stay even when empty so the
          // canonical pipeline is always visible at the top of the view. The
          // board keeps all four lanes instead — a lane carries the shape of
          // the process, whereas a heading with nothing under it is pure scroll
          // cost. Non-status groupings never arrive empty at all.
          if (
            g.tasks.length === 0 &&
            (g.status === "in_review" || g.status === "done")
          ) {
            return null;
          }
          return (
            <BoardListGroup
              key={g.key}
              title={g.label}
              titleHint={g.hint}
              count={g.tasks.length}
              glyph={g.glyph}
              expanded={!collapsed.has(g.key)}
              onToggle={() => toggle(g.key)}
              // Same rule as the board's quick-add: only a status group knows
              // what a new task created inside it should be.
              onAdd={g.status ? () => onAddInStatus(g.status!) : undefined}
            >
              {g.tasks.map((t) => (
                <TaskListRow
                  key={t.id}
                  task={t}
                  selected={t.id === selectedId}
                  members={members}
                  taskStates={taskStates}
                  taskLabels={taskLabels}
                  groupBy={groupBy}
                  displayProps={displayProps}
                  goal={goalOfTask?.[t.id] ?? null}
                  childCount={childCounts.get(t.id) ?? 0}
                  onSelect={() => onSelect(t.id)}
                  onStatus={
                    onStatus ? (next) => onStatus(t.id, next) : undefined
                  }
                />
              ))}
            </BoardListGroup>
          );
        })}
    </div>
  );
}

export function TaskListRow({
  task,
  selected,
  members,
  taskStates,
  taskLabels,
  groupBy = "none",
  displayProps,
  goal = null,
  childCount = 0,
  onSelect,
  onStatus,
}: {
  task: Task;
  selected: boolean;
  members: TeamMember[];
  taskStates: TaskState[];
  taskLabels: TaskLabel[];
  /** What the surrounding sections are cut on. Kept because the goal tag reads
   *  it: under "group by goal" the heading already says which goal, and a tag
   *  repeating it is noise. The STATUS tag no longer consults it — see below. */
  groupBy?: TaskViewGroupBy;
  /** Which properties to show. Falls back to the default set for callers that
   *  don't plumb it. */
  displayProps?: TaskViewDisplayProp[];
  /** The goal this task belongs to, if the crew has one planned over it. */
  goal?: string | null;
  /** Direct sub-task count — same chip the board card shows, so a task looks
   *  the same in both layouts. */
  childCount?: number;
  onSelect: () => void;
  /** Set the status from the tag. Omitted where the row is read-only. */
  onStatus?: (status: TaskStatus) => void;
}): JSX.Element {
  const props = useMemo(
    () => new Set<TaskViewDisplayProp>(displayProps ?? DEFAULT_DISPLAY_PROPS),
    [displayProps],
  );

  const state = task.state_id
    ? (taskStates.find((s) => s.id === task.state_id) ?? null)
    : null;

  // One chip grammar, in one order, so a due date reads the same everywhere.
  const chips: ReactNode[] = [];
  // The status tag, ALWAYS. It used to hide itself under a status grouping,
  // on the argument that the sticky heading a few pixels up already said it —
  // which is true of a heading you can see and false the moment you have
  // scrolled a hundred rows into "Backlog", and false in principle now that
  // the tag is also the control that changes the status. A row you can act on
  // has to state what it is.
  chips.push(
    <TaskStatusTag
      key="state"
      state={state}
      status={task.status}
      onStatus={onStatus}
      dense
    />,
  );
  // Which goal the crew has this under — the Plan view, said on the row. Not
  // when the list is already cut by goal: then the heading says it, and unlike
  // the status this tag isn't a control, so a repeat is only a repeat.
  if (goal && groupBy !== "goal") {
    chips.push(
      <BoardCardMeta key="goal" icon={Target} title={`Goal: ${goal}`}>
        {goal}
      </BoardCardMeta>,
    );
  }
  if (props.has("due") && task.due_date) {
    chips.push(
      <BoardCardMeta
        key="due"
        icon={Clock}
        tone={isOverdue(task.due_date) ? "alert" : undefined}
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
  // row. Hidden for the default (no crew set).
  if (task.crew_id) {
    chips.push(
      <BoardCardMeta key="crew" icon={Users} title={`Crew: ${task.crew_id}`}>
        {task.crew_id}
      </BoardCardMeta>,
    );
  }
  // Plan progress — "3 of 7". Only when the task carries a plan; a task with
  // no steps has no progress to report and "0 of 0" would be a lie.
  const planProgress = stepProgress(task);
  if (planProgress) {
    chips.push(
      <BoardCardMeta
        key="plan"
        icon={ListChecks}
        title={`Plan: ${planProgress.done} of ${planProgress.total} steps done`}
      >
        {planProgress.done} of {planProgress.total}
      </BoardCardMeta>,
    );
  }
  if (props.has("labels") && task.labels.length > 0) {
    chips.push(
      <BoardCardLabels
        key="labels"
        labels={task.labels.map((l) => {
          const entry = taskLabels.find((cl) => cl.name === l || cl.id === l);
          return { key: l, name: entry?.name ?? l, color: entry?.color };
        })}
      />,
    );
  }
  if (props.has("assignee") && task.assignee_ids.length > 0) {
    chips.push(
      <span key="assignees" title={task.assignee_ids.join(", ")}>
        <AssigneeStack
          handles={task.assignee_ids}
          members={members}
          dense
          maxAvatars={3}
        />
      </span>,
    );
  }

  return (
    <BoardListRow
      selected={selected}
      onSelect={onSelect}
      dataAttrs={{ "data-task-id": task.id }}
      tooltip={task.title}
      leading={
        <>
          {props.has("priority") && <TaskPriorityBars priority={task.priority} />}
          {/* No status ring here. A row used to lead with one, then wear a
              chip carrying the same ring and the word, all under a sticky
              header already saying it — the same fact three times across one
              row. The row states its status once, as the chip, and only when
              the header isn't already saying it. */}
          {props.has("id") && (
            <span className="w-20 flex-shrink-0">
              <TaskIdChip sequenceId={task.sequence_id} />
            </span>
          )}
        </>
      }
      title={<MentionedText text={task.title || "(untitled)"} members={members} />}
      trailing={chips}
    />
  );
}
