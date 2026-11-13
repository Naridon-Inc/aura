// The list lens of the Dashboard: collapsible sections of 44px rows, each
// row leading with its status glyph (a menu that changes it) and ending with
// how long ago it last moved.

import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { Target } from "lucide-react";

import type {
  Task,
  TaskLabel,
  TaskState,
  TaskStatus,
  TaskViewDisplayProp,
  TaskViewGroupBy,
  TeamMember,
} from "../../lib/api";
import { formatAgo } from "../../lib/freshness";
import { AssigneeStack } from "../AssigneePicker";
import { MentionedText } from "../Mentions";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { TaskFact } from "../ui/tasks-board";
import { TaskHandle, TaskListGroup, TaskListItem } from "../ui/tasks-list";
import { groupTasks } from "./taskGrouping";
import { TaskPriorityBars, TaskStateChip, TaskStatusTag, shouldShowStateChip } from "./taskGlyphs";
import { DEFAULT_DISPLAY_PROPS } from "./TasksFilterBar";
import { TaskMenuItems, cardFacts } from "./taskFacts";
import { budgetGroups, rowCap } from "./rowBudget";
import { RevealFoot } from "./RevealFoot";

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
  multiSelectedIds,
  onSelect,
  onStatus,
  onAddInStatus,
}: {
  tasks: Task[];
  loading: boolean;
  members: TeamMember[];
  taskStates: TaskState[];
  taskLabels: TaskLabel[];
  groupBy: TaskViewGroupBy;
  displayProps: TaskViewDisplayProp[];
  /** Card id → the goal it belongs to, resolved by the rail off the loop
   *  graph. Empty for a project with no goals planned. */
  goalOfTask?: Record<string, string>;
  selectedId: string | null;
  multiSelectedIds: string[];
  onSelect: (id: string, e?: { shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean }) => void;
  onStatus?: (id: string, status: TaskStatus) => void;
  onAddInStatus: (status: TaskStatus) => void;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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

  // Draw a first slice and reveal more as the reader scrolls (./rowBudget).
  // A collapsed section costs nothing, so it does not spend the budget.
  const [reveals, setReveals] = useState(0);
  useEffect(() => {
    setReveals(0);
  }, [tasks, groupBy]);
  const { groups: drawn, hidden } = useMemo(
    () =>
      budgetGroups(
        groups.map((g) => (collapsed.has(g.key) ? { ...g, tasks: [], total: g.tasks.length } : g)),
        rowCap(reveals),
      ),
    [groups, collapsed, reveals],
  );
  const reveal = useCallback(() => setReveals((r) => r + 1), []);
  const selectedSet = new Set(multiSelectedIds);

  function toggle(id: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (loading && tasks.length === 0) {
    return (
      <div className="ui-tasks-list">
        <div className="ui-tasks-loading">
          <AsciiSpinner />
          Loading tasks…
        </div>
      </div>
    );
  }
  if (tasks.length === 0) {
    return (
      <div className="ui-tasks-list">
        <div className="ui-tasks-empty">
          <p>No tasks</p>
        </div>
      </div>
    );
  }
  return (
    <div className="ui-tasks-list" role="region" aria-label="Tasks">
      {drawn.map((g) => {
        // An empty review or done section says nothing a reader needs.
        if (g.total === 0 && (g.status === "in_review" || g.status === "done")) return null;
        return (
          <TaskListGroup
            key={g.key}
            label={g.label}
            hint={g.hint}
            count={g.total}
            icon={g.glyph}
            open={!collapsed.has(g.key)}
            onToggle={() => toggle(g.key)}
            onAdd={g.status ? () => onAddInStatus(g.status!) : undefined}
          >
            {g.tasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                selected={t.id === selectedId || selectedSet.has(t.id)}
                members={members}
                taskStates={taskStates}
                taskLabels={taskLabels}
                groupBy={groupBy}
                displayProps={displayProps}
                goal={goalOfTask?.[t.id] ?? null}
                childCount={childCounts.get(t.id) ?? 0}
                onOpen={(e) => onSelect(t.id, e)}
                onStatus={onStatus ? (next) => onStatus(t.id, next) : undefined}
              />
            ))}
          </TaskListGroup>
        );
      })}
      <RevealFoot hidden={hidden} onReveal={reveal} />
    </div>
  );
}

function TaskRow({
  task,
  selected,
  members,
  taskStates,
  taskLabels,
  groupBy,
  displayProps,
  goal,
  childCount,
  onOpen,
  onStatus,
}: {
  task: Task;
  selected: boolean;
  members: TeamMember[];
  taskStates: TaskState[];
  taskLabels: TaskLabel[];
  groupBy: TaskViewGroupBy;
  displayProps: TaskViewDisplayProp[];
  goal: string | null;
  childCount: number;
  onOpen: (e: { shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean }) => void;
  onStatus?: (status: TaskStatus) => void;
}): JSX.Element {
  const props = new Set<TaskViewDisplayProp>(displayProps ?? DEFAULT_DISPLAY_PROPS);
  const state = task.state_id ? (taskStates.find((s) => s.id === task.state_id) ?? null) : null;
  const updated = Date.parse(task.updated_at);
  const trailing = [
    shouldShowStateChip(state, groupBy) ? (
      <TaskStateChip key="state" state={state} status={task.status} />
    ) : null,
    goal && groupBy !== "goal" ? (
      <TaskFact key="goal" icon={<Target />} title={`Goal: ${goal}`}>
        {goal}
      </TaskFact>
    ) : null,
    ...cardFacts(task, props, taskLabels, childCount),
    props.has("pr") && task.linked_pr ? (
      <TaskFact key="pr" title={task.linked_pr.url}>
        #{task.linked_pr.number}
      </TaskFact>
    ) : null,
    props.has("assignee") && task.assignee_ids.length > 0 ? (
      <span key="assignees" title={task.assignee_ids.join(", ")}>
        <AssigneeStack handles={task.assignee_ids} members={members} dense maxAvatars={3} />
      </span>
    ) : null,
  ].filter(Boolean);

  return (
    <TaskListItem
      taskId={task.id}
      label={task.title || "(untitled)"}
      selected={selected}
      onOpen={onOpen}
      menu={<TaskMenuItems task={task} onStatus={onStatus} onOpen={onOpen} />}
      leading={
        <>
          <TaskStatusTag state={state} status={task.status} onStatus={onStatus} />
          {props.has("priority") && <TaskPriorityBars priority={task.priority} />}
          {props.has("id") && <TaskHandle>AURA-{task.sequence_id}</TaskHandle>}
        </>
      }
      title={<MentionedText text={task.title || "(untitled)"} members={members} />}
      trailing={trailing.length > 0 ? trailing : undefined}
      time={
        Number.isFinite(updated)
          ? { label: formatAgo(updated).replace(/ ago$/, ""), title: `Updated ${task.updated_at}` }
          : undefined
      }
    />
  );
}
