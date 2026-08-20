// TaskDetailPane — Plane-style task detail, rendered in the shared
// FullscreenOverlay modal (the same chrome as the create/edit wizard and
// PR detail), so every task/PR surface reads identically: Esc owns the
// corner, the native traffic lights tuck away, and the panel floats over
// a dimmed backdrop. The breadcrumb + delete live in the overlay top bar;
// the body keeps Plane's two-column shape — a wide left column for title /
// description / activity / comments and a right rail with the metadata
// cards (state, priority, assignees, dates, planning, labels, deps,
// sub-issues, relations). Heavy lifting for each card is re-used from
// TaskDetailSidePanel — this component owns the layout and the data
// fetches. Still opened via editor.openTaskDetail (kind: "task"); the
// overlay portals out of that pane to cover the window.

import { useCallback, useEffect, useMemo, useState } from "react";
import { onExternalAnchorClick } from "../../lib/openExternal";
import { taskStatusLabel } from "../../lib/taskStatus";
import { Pencil, Plus, ArrowUpRight, SquareArrowOutUpRight } from "lucide-react";
import {
  api,
  type Cycle,
  type Module,
  type Task,
  type TaskLabel,
  type TaskState,
  type TeamMember,
  type UpdateTaskInput,
} from "../../lib/api";
import { fetchCycles, fetchModules, fetchTaskLabels, fetchTaskStates, fetchTasks } from "../../lib/tasksCache";
import { useEditorStore } from "../../lib/editorStore";
import { FullscreenOverlay } from "../FullscreenOverlay";
import { WizardStepTabs, type WizardStepMeta } from "../ui/wizard";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { TaskIdChip } from "./TaskIdChip";
import { StartInAgentButton } from "./StartInAgentButton";
import { StatePill } from "./StatePill";
import { AssigneeStack } from "../AssigneePicker";
import { PRIORITY_CHIP, StatusChip, TASK_STATE_CHIP } from "../ui/statusChip";
import { PRIORITY_LABEL } from "./TasksFilterBar";
import {
  StatusCard,
  AssignmentCard,
  PlanningCard,
  DescriptionCard,
  DependenciesCard,
  RelationsCard,
  LabelsCard,
  ActivityCard,
  CommentsCard,
} from "./TaskDetailSidePanel";
import { SubTasksPanel } from "./SubTasksPanel";
import { TaskPlan } from "./TaskPlan";
import { TaskGoals } from "../goals/TaskGoals";
import { TaskCrewActivity } from "./TaskCrewActivity";
import { relativeAgeFromIso } from "../../lib/relativeTime";
import { askConfirm } from "../ui/ask";
import { toast } from "../../lib/toast";
import { fetchTeam } from "../../lib/teamCache";

/** "Edit this task" channel name. Opening the stepped wizard is owned by
 *  TasksBoard (it holds the `editingId` overlay state); the detail pane
 *  asks via editor.requestTaskEdit, which fires this event for an
 *  already-mounted board. Exported so TasksBoard's listener and the
 *  store's dispatcher can't drift on the string. */
export const TASK_EDIT_EVENT = "aura:tasks:edit";

// Short "updated 2d ago" relative stamp for the read-mode meta line.
function relAge(iso: string): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromIso(iso);
}

// Read-mode header tabs — the same Medusa ProgressTabs strip the create/edit
// wizard and PR detail use (WizardStepTabs, variant="tabs"), so the task-detail
// header reads identically to every other FullscreenOverlay surface. The strip
// is non-sequential (both cells always jumpable) and only surfaces when the
// task actually has sub-tasks. The numeric index WizardStepTabs expects is
// mapped to/from the string tab keys via DETAIL_TAB_IDS.
const DETAIL_TABS: WizardStepMeta[] = [
  { id: "overview", label: "Overview", icon: <OverviewGlyph /> },
  { id: "subtasks", label: "Sub-tasks", icon: <SubTasksGlyph /> },
];
const DETAIL_TAB_IDS = DETAIL_TABS.map((t) => t.id) as Array<
  "overview" | "subtasks"
>;

type Props = {
  taskId: string;
  repoRoot: string;
  /** Optional close handler — defaults to closing the workpane tab via
   *  the editor store. Passed in by tests / preview surfaces. */
  onClose?: () => void;
  /** Render in-flow (no modal portal/backdrop) — set when this pane fills a
   *  detached popout window rather than overlaying the main window. */
  embedded?: boolean;
  /** When provided, surfaces a "detach to window" action in the header that
   *  spins this task off into its own OS window. Omitted inside a popout. */
  onDetach?: () => void;
};

export function TaskDetailPane({
  taskId,
  repoRoot,
  onClose,
  embedded = false,
  onDetach,
}: Props) {
  const editor = useEditorStore();
  const [task, setTask] = useState<Task | null>(null);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [taskStates, setTaskStates] = useState<TaskState[]>([]);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [_labels, setLabels] = useState<TaskLabel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Read-mode tabs surface only when the task actually has sub-tasks:
  // "Overview" (the doc + metadata layout, which still carries the
  // sub-tasks summary inline) and "Sub-tasks" (a focused two-column
  // master/detail). Tab-free otherwise.
  const [tab, setTab] = useState<"overview" | "subtasks">("overview");
  // Which child is open in the Sub-tasks tab's detail column. Lifted here
  // so clicking a row in the Overview's inline sub-tasks table can route
  // INTO the tab (switch + select) instead of stacking a new overlay.
  const [subSel, setSubSel] = useState<string | null>(null);
  const openSubtask = useCallback((childId: string) => {
    setSubSel(childId);
    setTab("subtasks");
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [rows, team, states, cyc, mods, labs] = await Promise.all([
        fetchTasks(repoRoot),
        fetchTeam(repoRoot).catch(() => null),
        fetchTaskStates(repoRoot).catch(() => [] as TaskState[]),
        fetchCycles(repoRoot).catch(() => [] as Cycle[]),
        fetchModules(repoRoot).catch(() => [] as Module[]),
        fetchTaskLabels(repoRoot).catch(() => [] as TaskLabel[]),
      ]);
      setAllTasks(rows);
      setMembers(team?.members ?? []);
      setTaskStates(states);
      setCycles(cyc);
      setModules(mods);
      setLabels(labs);
      const t = rows.find((r) => r.id === taskId);
      setTask(t ?? null);
      if (!t) setError("Task not found");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot, taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live-refresh when the board fires its mutation broadcast (a sibling
  // edit / status change / delete should be reflected here without
  // waiting for the next user click).
  useEffect(() => {
    const onMutate = () => void refresh();
    window.addEventListener("aura:tasks:mutated", onMutate);
    return () => window.removeEventListener("aura:tasks:mutated", onMutate);
  }, [refresh]);

  const onPatch = useCallback(
    async (input: UpdateTaskInput) => {
      const next = await api.tasksUpdate(repoRoot, input);
      setTask(next);
      setAllTasks((prev) => prev.map((t) => (t.id === next.id ? next : t)));
      window.dispatchEvent(new CustomEvent("aura:tasks:mutated"));
    },
    [repoRoot],
  );

  // Tick one line of the plan off (or back on) by position. Distinct from
  // onPatch's whole-list replace: a step toggle addresses a single row so a
  // concurrent plan edit can't overwrite it (cmd_tasks.rs::tasks_step_set).
  const onStepSet = useCallback(
    async (index: number, done: boolean) => {
      const next = await api.tasksStepSet(repoRoot, taskId, index, done);
      setTask(next);
      setAllTasks((prev) => prev.map((t) => (t.id === next.id ? next : t)));
      window.dispatchEvent(new CustomEvent("aura:tasks:mutated"));
    },
    [repoRoot, taskId],
  );

  const onDelete = useCallback(async () => {
    if (!task) return;
    if (
      !(await askConfirm({
        title: `Delete "${task.title}"?`,
        body: "This can't be undone.",
        confirmLabel: "Delete",
        tone: "danger",
      }))
    ) {
      return;
    }
    // The confirm dialog just told the user this can't be undone, so the
    // call that actually does it cannot fail in silence: without this the
    // pane simply stays open and the Delete button reads as inert. Retry
    // re-runs the delete only — it does not re-ask, since they already said
    // yes to this exact task.
    const attempt = async (): Promise<void> => {
      try {
        await api.tasksDelete(repoRoot, task.id);
      } catch (e) {
        toast.danger("Couldn't delete the task", String(e), {
          actions: [{ label: "Try again", onClick: attempt }],
        });
        return;
      }
      window.dispatchEvent(new CustomEvent("aura:tasks:mutated"));
      if (onClose) onClose();
      else editor.closeTaskDetail(task.id);
    };
    await attempt();
  }, [task, repoRoot, onClose, editor]);

  const close = useCallback(() => {
    if (onClose) onClose();
    else editor.closeTaskDetail(taskId);
  }, [onClose, editor, taskId]);

  // Edit = open the stepped wizard (the only place the Details/Assign/
  // Plan tabs live). Read mode stays tab-free; tabs surface on demand.
  // requestTaskEdit handles both mount sites (board-local vs workpane
  // tab); close() dismisses this pane so the two never stack.
  const startEdit = useCallback(() => {
    editor.requestTaskEdit(taskId, repoRoot);
    close();
  }, [editor, taskId, repoRoot, close]);

  const onCreateChild = useCallback(
    async (parentId: string, title: string) => {
      const next = await api.tasksCreate(repoRoot, {
        title,
        parent_id: parentId,
        status: "backlog",
      });
      setAllTasks((prev) => [...prev, next]);
      window.dispatchEvent(new CustomEvent("aura:tasks:mutated"));
    },
    [repoRoot],
  );

  if (loading) {
    return (
      <FullscreenOverlay onClose={close} embedded={embedded}>
        <div className="flex-1 flex items-center justify-center text-text-5 text-sm">
          Loading task…
        </div>
      </FullscreenOverlay>
    );
  }
  if (error || !task) {
    return (
      <FullscreenOverlay onClose={close} embedded={embedded}>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-4 text-base">
          <div>{error ?? "Task not found"}</div>
        </div>
      </FullscreenOverlay>
    );
  }

  const currentState = task.state_id
    ? taskStates.find((s) => s.id === task.state_id) ?? null
    : null;
  const reporter = task.reporter?.trim() || null;

  // Direct children only — the read-mode tab list is one level deep (each
  // child opens its own focused detail in the right column).
  const directChildren = allTasks.filter((t) => t.parent_id === task.id);
  const hasSubtasks = directChildren.length > 0;
  const activeTab = hasSubtasks ? tab : "overview";

  return (
    <FullscreenOverlay
      onClose={close}
      embedded={embedded}
      tabs={
        hasSubtasks ? (
          <WizardStepTabs
            variant="tabs"
            steps={DETAIL_TABS.map((t) =>
              t.id === "subtasks"
                ? { ...t, label: `Sub-tasks (${directChildren.length})` }
                : t,
            )}
            index={Math.max(0, DETAIL_TAB_IDS.indexOf(activeTab))}
            onJump={(i) => setTab(DETAIL_TAB_IDS[i])}
          />
        ) : undefined
      }
      actions={
        <div className="flex items-center gap-1.5">
          <StartInAgentButton
            task={task}
            repoRoot={repoRoot}
            childTasks={directChildren}
            onStarted={close}
          />
          {onDetach && (
            <Button
              variant="subtle"
              size="xs"
              onClick={onDetach}
              title="Detach to its own window"
            >
              <SquareArrowOutUpRight strokeWidth={1.75} aria-hidden />
              Detach
            </Button>
          )}
          <Button
            variant="secondary"
            size="xs"
            onClick={startEdit}
            title="Edit task. Opens the stepped editor"
          >
            <Pencil strokeWidth={1.75} aria-hidden />
            Edit
          </Button>
          <Button
            variant="subtle"
            size="xs"
            onClick={() => void onDelete()}
            className="text-red hover:text-red"
          >
            Delete
          </Button>
        </div>
      }
    >
      {/* Body — the header tab strip (above, in the overlay top bar) drives
          this: "Overview" keeps the doc + metadata layout (with the inline
          sub-tasks summary), "Sub-tasks" swaps in a focused two-column
          master/detail. Tab-free when the task has no sub-tasks. */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {activeTab === "subtasks" ? (
          <SubTasksTab
            parent={task}
            childTasks={directChildren}
            allTasks={allTasks}
            repoRoot={repoRoot}
            members={members}
            taskStates={taskStates}
            cycles={cycles}
            modules={modules}
            onPatch={onPatch}
            onCreateChild={onCreateChild}
            selectedId={subSel}
            onSelect={setSubSel}
          />
        ) : (
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left column — `.item-main`: 28px 40px 60px padding, doc measure */}
        <div className="flex-1 min-w-0 overflow-y-auto pt-7 px-10 pb-[60px]">
          <div className="max-w-[820px] mx-auto">
            {/* Read-mode summary band — surfaces the live state, priority
                and provenance at a glance before the title, so the detail
                opens as a doc you read (not a form). Inline tweaks still
                live in the right rail; the full stepped editor is Edit. */}
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-4 mb-3">
              <TaskIdChip
                sequenceId={task.sequence_id}
                className="font-mono text-xs tracking-tight text-text-3 hover:text-text-1 hover:bg-state-hover px-1.5 py-0.5 rounded transition-colors"
              />
              <span className="w-px h-3 bg-line-soft" />
              {currentState ? (
                <StatePill state={currentState} />
              ) : (
                <StatusChip tone={TASK_STATE_CHIP[task.status].tone} dot>
                  {taskStatusLabel(task.status)}
                </StatusChip>
              )}
              <StatusChip tone={PRIORITY_CHIP[task.priority].tone} dot>
                {PRIORITY_LABEL[task.priority]}
              </StatusChip>
              <span className="w-px h-3 bg-line-soft" />
              {reporter && (
                <span>
                  Opened by <span className="text-text-3">@{reporter}</span>
                </span>
              )}
              <span>Updated {relAge(task.updated_at)}</span>
              {task.external_source && task.external_url && (
                <a
                  href={task.external_url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={onExternalAnchorClick}
                  className="text-accent hover:underline"
                >
                  {task.external_id ?? task.external_source}
                </a>
              )}
            </div>
            <TitleBlock task={task} onPatch={onPatch} />
            <div className="mt-7">
              <DescriptionCard
                task={task}
                members={members}
                onPatch={onPatch}
                variant="page"
              />
            </div>
            {task.steps && task.steps.length > 0 && (
              <>
                <div className="h-px bg-line-soft/60 my-7" aria-hidden />
                <TaskPlan task={task} onStepSet={onStepSet} />
              </>
            )}
            <div className="h-px bg-line-soft/60 my-7" aria-hidden />
            <TaskGoals repoRoot={repoRoot} task={task} />
            <div className="h-px bg-line-soft/60 my-7" aria-hidden />
            <SubTasksPanel
              task={task}
              allTasks={allTasks}
              repoRoot={repoRoot}
              onCreateChild={onCreateChild}
              onOpenChild={openSubtask}
            />
            <div className="h-px bg-line-soft/60 my-7" aria-hidden />
            <TaskCrewActivity taskId={task.id} repoRoot={repoRoot} />
            <div className="h-px bg-line-soft/60 my-7" aria-hidden />
            <ActivityCard
              task={task}
              repoRoot={repoRoot}
              onPatch={onPatch}
              variant="page"
            />
            <div className="h-px bg-line-soft/60 my-7" aria-hidden />
            <CommentsCard
              task={task}
              repoRoot={repoRoot}
              currentHandle={null}
              variant="page"
            />
          </div>
        </div>

        {/* Right rail — a calm 300px metadata column. No nested cards:
            each property is a flat section divided by a hairline, the way
            Linear lays out an issue's right side. `divide-y` on the
            section wrapper draws the rules; every child carries its own
            vertical padding via `[&>*]:py-4`. */}
        <aside
          className="w-[300px] flex-shrink-0 border-l-[0.5px] border-line-soft bg-bg-content overflow-y-auto px-5 text-sm"
          aria-label="Task metadata"
        >
          <div className="divide-y divide-line-soft/60 [&>*]:py-4 [&>*:first-child]:pt-5">
            <StatusCard
              task={task}
              taskStates={taskStates}
              onPatch={onPatch}
              variant="page"
            />
            <AssignmentCard
              task={task}
              members={members}
              onPatch={onPatch}
              variant="page"
            />
            <LabelsCard task={task} onPatch={onPatch} variant="page" />
            {(cycles.length > 0 || modules.length > 0) && (
              <PlanningCard
                task={task}
                cycles={cycles}
                modules={modules}
                onPatch={onPatch}
                variant="page"
              />
            )}
            <DependenciesCard task={task} allTasks={allTasks} variant="page" />
            <RelationsCard
              task={task}
              allTasks={allTasks}
              repoRoot={repoRoot}
              variant="page"
            />
          </div>
        </aside>
      </div>
        )}
      </div>
    </FullscreenOverlay>
  );
}

// Header tab glyphs — 14px stroke icons for the WizardStepTabs `tabs` cells,
// matching PR detail's set; colour is inherited (currentColor) so the active
// cell tints accent.
function OverviewGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="2.5" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2" y="8" width="7" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="11" y="8" width="3" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function SubTasksGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="2" width="12" height="2.6" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M5 5v3.4a1.5 1.5 0 0 0 1.5 1.5H8M5 5v6.6a1.5 1.5 0 0 0 1.5 1.5H8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <rect x="8.5" y="7.5" width="5.5" height="2.4" rx="0.8" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8.5" y="11.2" width="5.5" height="2.4" rx="0.8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

// Big inline-editable title at the top of the left column. Plane uses
// this hierarchy (h1-sized title above the description) so the detail
// pane reads like a doc, not a form.
function TitleBlock({
  task,
  onPatch,
}: {
  task: Task;
  onPatch: (input: UpdateTaskInput) => Promise<void>;
}) {
  const [title, setTitle] = useState(task.title);
  useEffect(() => {
    setTitle(task.title);
  }, [task.id, task.title]);

  const commit = () => {
    const next = title.trim();
    if (next && next !== task.title) {
      void onPatch({ id: task.id, title: next });
    } else {
      setTitle(task.title);
    }
  };

  return (
    <textarea
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setTitle(task.title);
          e.currentTarget.blur();
        }
      }}
      rows={1}
      className="w-full bg-transparent text-text-1 text-[24px] font-semibold leading-[1.25] tracking-[-0.01em] resize-none focus:outline-none focus:bg-state-hover rounded px-2 -mx-2 py-1"
      placeholder="Untitled task"
    />
  );
}

// ── Sub-tasks tab — two-column master/detail ────────────────────────────
// Left: a calm sidebar list of the task's direct children (Linear-style
// selectable cards). Right: the selected child rendered as a focused doc
// reusing the very same metadata cards as the parent's Overview, so a
// sub-task reads identically to a top-level one without leaving the parent.
function SubTasksTab({
  parent,
  childTasks,
  allTasks,
  repoRoot,
  members,
  taskStates,
  cycles,
  modules,
  onPatch,
  onCreateChild,
  selectedId: selProp,
  onSelect,
}: {
  parent: Task;
  childTasks: Task[];
  allTasks: Task[];
  repoRoot: string;
  members: TeamMember[];
  taskStates: TaskState[];
  cycles: Cycle[];
  modules: Module[];
  onPatch: (input: UpdateTaskInput) => Promise<void>;
  onCreateChild: (parentId: string, title: string) => Promise<void>;
  /** Selected child id (lifted to TaskDetailPane so the Overview table can
   *  route a click into this tab) and its setter. */
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const editor = useEditorStore();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // Selection survives re-renders but always falls back to the first child
  // when the stored id is gone (deleted / filtered out).
  const selectedId =
    selProp && childTasks.some((c) => c.id === selProp)
      ? selProp
      : childTasks[0]?.id ?? null;
  const selected = useMemo(
    () => childTasks.find((c) => c.id === selectedId) ?? null,
    [childTasks, selectedId],
  );
  const selectedState =
    selected && selected.state_id
      ? taskStates.find((s) => s.id === selected.state_id) ?? null
      : null;

  const submit = async () => {
    const t = draft.trim();
    if (!t || creating) return;
    setCreating(true);
    setCreateErr(null);
    try {
      await onCreateChild(parent.id, t);
      setDraft("");
      setAdding(false);
    } catch {
      // Surface the failure inline and KEEP the draft + input open so the
      // user can retry without retyping. The sibling Sub-tasks panels
      // (SubTasksPanel / TaskDetailSidePanel) show errors the same way;
      // this inner editor was the one create surface that swallowed them.
      setCreateErr("Couldn't add the sub-task. Check your connection and try again.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden">
      {/* Master — sidebar list of children. */}
      <aside className="w-[300px] flex-shrink-0 border-r-[0.5px] border-line-soft bg-bg-content flex flex-col">
        <div className="flex items-center h-11 px-4 border-b-[0.5px] border-line-soft flex-shrink-0">
          <span className="text-sm text-text-2 font-medium">Sub-tasks</span>
          <span className="ml-1.5 text-xs text-text-5 tabular-nums">
            {childTasks.length}
          </span>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="ml-auto w-6 h-6 grid place-items-center rounded-md text-text-4 hover:text-text-1 hover:bg-state-hover transition-colors"
            title="Add a sub-task"
            aria-label="Add a sub-task"
          >
            <Plus className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 flex flex-col gap-0.5">
          {childTasks.map((c) => (
            <SubTaskListRow
              key={c.id}
              task={c}
              members={members}
              taskStates={taskStates}
              selected={c.id === selectedId}
              onClick={() => onSelect(c.id)}
            />
          ))}
          {adding && (
            <Input
              type="text"
              value={draft}
              autoFocus
              onChange={(e) => {
                setDraft(e.target.value);
                if (createErr) setCreateErr(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setAdding(false);
                  setDraft("");
                  setCreateErr(null);
                }
              }}
              onBlur={() => {
                if (!draft.trim() && !creating) setAdding(false);
              }}
              placeholder="Sub-task title. Enter to add"
              disabled={creating}
              className="mt-0.5 w-full"
            />
          )}
          {createErr && (
            <div
              role="alert"
              className="mt-0.5 flex items-center gap-1.5 px-0.5 text-xs text-red"
            >
              <span aria-hidden>⚠</span>
              <span>{createErr}</span>
            </div>
          )}
        </div>
      </aside>

      {/* Detail — the selected child as a focused doc + a calm 300px
          metadata rail, mirroring the parent Overview so a sub-task reads
          identically AND its property fields stay narrow (the metadata
          lived full-width at the bottom before, which stretched every
          select / date / label input across the column). */}
      <div className="flex-1 min-w-0 flex overflow-hidden">
        {selected ? (
          <>
            {/* Doc column — id + summary + title + description. */}
            <div className="flex-1 min-w-0 overflow-y-auto pt-7 px-10 pb-[60px]">
              <div className="max-w-[680px] mx-auto">
                <div className="flex items-center gap-2 mb-3">
                  <TaskIdChip
                    sequenceId={selected.sequence_id}
                    className="font-mono text-xs tracking-tight text-text-3 hover:text-text-1 hover:bg-state-hover px-1.5 py-0.5 rounded transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => editor.openTaskDetail(selected.id, repoRoot)}
                    className="ml-auto inline-flex items-center gap-1 text-xs text-text-3 hover:text-text-1 px-2 py-1 rounded-md border border-line-soft hover:bg-state-hover transition-colors"
                    title="Open this sub-task as its own page"
                  >
                    <ArrowUpRight className="w-3 h-3" strokeWidth={1.75} aria-hidden />
                    Open
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-text-4 mb-3">
                  {selectedState ? (
                    <StatePill state={selectedState} />
                  ) : (
                    <StatusChip tone={TASK_STATE_CHIP[selected.status].tone} dot>
                      {taskStatusLabel(selected.status)}
                    </StatusChip>
                  )}
                  <StatusChip tone={PRIORITY_CHIP[selected.priority].tone} dot>
                    {PRIORITY_LABEL[selected.priority]}
                  </StatusChip>
                  <span className="w-px h-3 bg-line-soft" />
                  <span>Updated {relAge(selected.updated_at)}</span>
                </div>
                {/* Re-mount the editable surfaces per child so their internal
                    draft state resets when the selection changes. */}
                <TitleBlock key={`t-${selected.id}`} task={selected} onPatch={onPatch} />
                <div className="mt-7">
                  <DescriptionCard
                    key={`d-${selected.id}`}
                    task={selected}
                    members={members}
                    onPatch={onPatch}
                    variant="page"
                  />
                </div>
              </div>
            </div>

            {/* Metadata rail — narrow, same flat cards as the parent. */}
            <aside
              className="w-[300px] flex-shrink-0 border-l-[0.5px] border-line-soft bg-bg-content overflow-y-auto px-5 text-sm"
              aria-label="Sub-task metadata"
            >
              <div className="divide-y divide-line-soft/60 [&>*]:py-4 [&>*:first-child]:pt-5">
                <StatusCard
                  task={selected}
                  taskStates={taskStates}
                  onPatch={onPatch}
                  variant="page"
                />
                <AssignmentCard
                  task={selected}
                  members={members}
                  onPatch={onPatch}
                  variant="page"
                />
                <LabelsCard task={selected} onPatch={onPatch} variant="page" />
                {(cycles.length > 0 || modules.length > 0) && (
                  <PlanningCard
                    task={selected}
                    cycles={cycles}
                    modules={modules}
                    onPatch={onPatch}
                    variant="page"
                  />
                )}
                <DependenciesCard
                  task={selected}
                  allTasks={allTasks}
                  variant="page"
                />
                <RelationsCard
                  task={selected}
                  allTasks={allTasks}
                  repoRoot={repoRoot}
                  variant="page"
                />
              </div>
            </aside>
          </>
        ) : (
          <div className="flex-1 h-full flex items-center justify-center text-text-5 text-sm">
            Select a sub-task to view its details.
          </div>
        )}
      </div>
    </div>
  );
}

// One selectable child card in the Sub-tasks master list — key + state on
// top, title (clamped), priority + assignees below. Selection tints the
// whole card so the active child is unmistakable.
function SubTaskListRow({
  task,
  members,
  taskStates,
  selected,
  onClick,
}: {
  task: Task;
  members: TeamMember[];
  taskStates: TaskState[];
  selected: boolean;
  onClick: () => void;
}) {
  const state = task.state_id
    ? taskStates.find((s) => s.id === task.state_id) ?? null
    : null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "true" : undefined}
      className={`w-full text-left rounded-md px-2.5 py-2 flex flex-col gap-1.5 transition-colors ${
        selected
          ? "bg-bg-2 ring-1 ring-line-soft"
          : "hover:bg-state-hover"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-2xs text-text-4 tabular-nums">
          {task.sequence_id > 0 ? `AURA-${task.sequence_id}` : "AURA-?"}
        </span>
        <span className="ml-auto">
          {state ? (
            <StatePill state={state} dense />
          ) : (
            <StatusChip tone={TASK_STATE_CHIP[task.status].tone} dot dense>
              {/* Was `task.status.replace(/_/g, " ")` — the database column
                  with its underscores swapped for spaces, printed to whoever
                  opened the task. See lib/taskStatus. */}
              {taskStatusLabel(task.status)}
            </StatusChip>
          )}
        </span>
      </div>
      <span className="text-base text-text-1 leading-snug line-clamp-2">
        {task.title || "(untitled)"}
      </span>
      <div className="flex items-center gap-2">
        <StatusChip tone={PRIORITY_CHIP[task.priority].tone} dot dense>
          {PRIORITY_LABEL[task.priority]}
        </StatusChip>
        {task.assignee_ids.length > 0 && (
          <span className="ml-auto">
            <AssigneeStack
              handles={task.assignee_ids}
              members={members}
              dense
              maxAvatars={2}
            />
          </span>
        )}
      </div>
    </button>
  );
}
