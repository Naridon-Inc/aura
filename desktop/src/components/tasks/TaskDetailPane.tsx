// A task's detail. One reading column — subject, status line, objective,
// description, plan, goals, sub-tasks, run order, agents, activity and
// comments — beside a narrow column of properties that edit in place.
// "Edit task" opens the create/edit dialog, which the board owns.
//
// It floats over the window in the shared overlay, or fills a popout window
// when `embedded`. Opened via editor.openTaskDetail (kind: "task").

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, MoreHorizontal, SquareArrowOutUpRight } from "lucide-react";

import {
  api,
  type Cycle,
  type Module,
  type Task,
  type TaskState,
  type TeamMember,
  type UpdateTaskInput,
} from "../../lib/api";
import { useEditorStore } from "../../lib/editorStore";
import { onExternalAnchorClick } from "../../lib/openExternal";
import { relativeAgeFromIso } from "../../lib/relativeTime";
import { fetchCycles, fetchModules, fetchTaskStates, fetchTasks } from "../../lib/tasksCache";
import { fetchTeam } from "../../lib/teamCache";
import { toast } from "../../lib/toast";
import { FullscreenOverlay } from "../FullscreenOverlay";
import { TaskGoals } from "../goals/TaskGoals";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { askConfirm } from "../ui/ask";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  TaskDetailHeader,
  TaskDetailLayout,
  TaskDetailMeta,
  TaskDetailSection,
} from "../ui/tasks-detail";
import { TaskViewTabs } from "../ui/tasks-toolbar";
import { StartInAgentButton } from "./StartInAgentButton";
import { SubTasksPanel } from "./SubTasksPanel";
import { TaskActivityTimeline } from "./TaskActivityTimeline";
import { TaskCrewActivity } from "./TaskCrewActivity";
import { TaskObjective, TaskRunOrder, TaskTitleField } from "./TaskDetailBlocks";
import { TaskDetailProperties } from "./TaskDetailProperties";
import { TaskIdChip } from "./TaskIdChip";
import { CommentsCard } from "./TaskCommentsCard";
import { DescriptionCard } from "./TaskDescriptionCard";
import { TaskPlan } from "./TaskPlan";
import { TaskSubtasksTab } from "./TaskSubtasksTab";
import { TASK_PRIORITY_LABEL, TaskStateChip } from "./taskGlyphs";

/** "Edit this task" channel name. The edit dialog is owned by TasksBoard
 *  (it holds the `editingId` state); the detail asks via
 *  editor.requestTaskEdit, which fires this event for an already-mounted
 *  board. Exported so the listener and the dispatcher can't drift. */
export const TASK_EDIT_EVENT = "aura:tasks:edit";

type Tab = "overview" | "subtasks";

type Props = {
  taskId: string;
  repoRoot: string;
  /** Optional close handler — defaults to closing the workpane tab via
   *  the editor store. */
  onClose?: () => void;
  /** Render in-flow (no modal portal/backdrop) — set when this pane fills a
   *  detached popout window rather than overlaying the main window. */
  embedded?: boolean;
  /** When provided, offers "Detach" — this task in its own OS window.
   *  Omitted inside a popout. */
  onDetach?: () => void;
};

export function TaskDetailPane({ taskId, repoRoot, onClose, embedded = false, onDetach }: Props) {
  const editor = useEditorStore();
  // The task being read. Starts as the one asked for; following a
  // "Blocked by" / "Blocks" row reads that task here instead of stacking
  // another overlay.
  const [viewId, setViewId] = useState(taskId);
  useEffect(() => setViewId(taskId), [taskId]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [taskStates, setTaskStates] = useState<TaskState[]>([]);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  // The child open in the Sub-tasks tab. Lifted so a row in the overview's
  // sub-task table can route into the tab instead of stacking an overlay.
  const [subSel, setSubSel] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [rows, team, states, cyc, mods] = await Promise.all([
        fetchTasks(repoRoot),
        fetchTeam(repoRoot).catch(() => null),
        fetchTaskStates(repoRoot).catch(() => [] as TaskState[]),
        fetchCycles(repoRoot).catch(() => [] as Cycle[]),
        fetchModules(repoRoot).catch(() => [] as Module[]),
      ]);
      setAllTasks(rows);
      setMembers(team?.members ?? []);
      setTaskStates(states);
      setCycles(cyc);
      setModules(mods);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A change made elsewhere — the board, another detail — shows here
  // without waiting for a click.
  useEffect(() => {
    const onMutate = () => void refresh();
    window.addEventListener("aura:tasks:mutated", onMutate);
    return () => window.removeEventListener("aura:tasks:mutated", onMutate);
  }, [refresh]);

  const task = allTasks.find((t) => t.id === viewId) ?? null;

  const onPatch = useCallback(
    async (input: UpdateTaskInput) => {
      const next = await api.tasksUpdate(repoRoot, input);
      setAllTasks((prev) => prev.map((t) => (t.id === next.id ? next : t)));
      window.dispatchEvent(new CustomEvent("aura:tasks:mutated"));
    },
    [repoRoot],
  );

  // Tick one step of a plan by position — on whichever task is being read,
  // the parent or a sub-task. A single-row write, so a concurrent plan edit
  // can't overwrite it.
  const setStep = useCallback(
    async (id: string, index: number, done: boolean) => {
      const next = await api.tasksStepSet(repoRoot, id, index, done);
      setAllTasks((prev) => prev.map((t) => (t.id === next.id ? next : t)));
      window.dispatchEvent(new CustomEvent("aura:tasks:mutated"));
    },
    [repoRoot],
  );

  const onCreateChild = useCallback(
    async (parentId: string, title: string) => {
      const next = await api.tasksCreate(repoRoot, { title, parent_id: parentId, status: "backlog" });
      setAllTasks((prev) => [...prev, next]);
      window.dispatchEvent(new CustomEvent("aura:tasks:mutated"));
    },
    [repoRoot],
  );

  const close = useCallback(() => {
    if (onClose) onClose();
    else editor.closeTaskDetail(taskId);
  }, [onClose, editor, taskId]);

  const onDelete = useCallback(async () => {
    if (!task) return;
    const ok = await askConfirm({
      title: `Delete "${task.title}"?`,
      body: "This can't be undone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    // The sheet just said this can't be undone, so the delete can't fail in
    // silence. Try again re-runs only the delete — they already said yes.
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
      if (task.id === taskId) close();
      else setViewId(taskId);
    };
    await attempt();
  }, [task, repoRoot, taskId, close]);

  // The board owns the edit dialog; it opens on this request and brings
  // this detail back when it closes.
  const startEdit = useCallback(() => {
    if (!task) return;
    editor.requestTaskEdit(task.id, repoRoot);
    close();
  }, [editor, task, repoRoot, close]);

  if (loading || error || !task) {
    return (
      <FullscreenOverlay onClose={close} embedded={embedded}>
        <div className="ui-tasks-detail-empty" role={loading ? "status" : "alert"}>
          {loading ? (
            <>
              <AsciiSpinner />
              Loading task…
            </>
          ) : (
            <>
              {error ?? "This task isn't on the board any more."}
              {error && (
                <Button variant="outline" size="xs" onClick={() => void refresh()}>
                  Try again
                </Button>
              )}
            </>
          )}
        </div>
      </FullscreenOverlay>
    );
  }

  const state = task.state_id ? taskStates.find((s) => s.id === task.state_id) ?? null : null;
  const reporter = task.reporter?.trim() || null;
  const owners = task.assignee_ids.map(
    (h) => members.find((m) => m.handle === h)?.name || h,
  );
  const children = allTasks.filter((t) => t.parent_id === task.id);
  const activeTab: Tab = children.length > 0 ? tab : "overview";
  const openTask = (id: string) => {
    setTab("overview");
    setViewId(id);
  };
  const openSubtask = (id: string) => {
    setSubSel(id);
    setTab("subtasks");
  };

  const properties = (
    <TaskDetailProperties
      task={task}
      allTasks={allTasks}
      repoRoot={repoRoot}
      members={members}
      taskStates={taskStates}
      cycles={cycles}
      modules={modules}
      onPatch={onPatch}
      onOpenTask={openTask}
    />
  );

  return (
    <FullscreenOverlay
      onClose={close}
      embedded={embedded}
      tabs={
        children.length > 0 ? (
          <TaskViewTabs<Tab>
            label="Task detail"
            value={activeTab}
            onChange={setTab}
            options={[
              { value: "overview", label: "Overview" },
              { value: "subtasks", label: `Sub-tasks ${children.length}` },
            ]}
          />
        ) : undefined
      }
      actions={
        <div className="ui-tasks-detail-actions">
          {viewId !== taskId && (
            <Button variant="ghost" size="xs" onClick={() => openTask(taskId)}>
              <ArrowLeft aria-hidden />
              Back
            </Button>
          )}
          <StartInAgentButton
            task={task}
            repoRoot={repoRoot}
            childTasks={children}
            onStarted={close}
          />
          {onDetach && (
            <Button variant="ghost" size="xs" onClick={onDetach} title="Open in its own window">
              <SquareArrowOutUpRight aria-hidden />
              Detach
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="iconXs" aria-label="More actions" title="More actions">
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onSelect={() => void onDelete()}>
                Delete task
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      {activeTab === "subtasks" ? (
        <TaskSubtasksTab
          parent={task}
          childTasks={children}
          allTasks={allTasks}
          repoRoot={repoRoot}
          members={members}
          taskStates={taskStates}
          cycles={cycles}
          modules={modules}
          onPatch={onPatch}
          onCreateChild={onCreateChild}
          onStepSet={setStep}
          onOpenTask={openTask}
          selectedId={subSel}
          onSelect={setSubSel}
        />
      ) : (
        <TaskDetailLayout
          asideLabel="Task properties"
          aside={properties}
          main={
            <>
              <TaskDetailHeader
                action={
                  <Button size="xs" variant="ghost" onClick={startEdit}>
                    Edit task
                  </Button>
                }
              >
                <TaskTitleField task={task} onPatch={onPatch} />
              </TaskDetailHeader>
              <TaskDetailMeta
                parts={[
                  task.sequence_id > 0 && (
                    <TaskIdChip sequenceId={task.sequence_id} className="ui-tasks-detail-handle" />
                  ),
                  <TaskStateChip state={state} status={task.status} />,
                  owners.length > 0 ? owners.join(", ") : "Unassigned",
                  `${TASK_PRIORITY_LABEL[task.priority]} priority`,
                  reporter && `Opened by @${reporter}`,
                  `Updated ${relativeAgeFromIso(task.updated_at)}`,
                  task.external_source && task.external_url && (
                    <a href={task.external_url} target="_blank" rel="noreferrer" onClick={onExternalAnchorClick}>
                      {task.external_id ?? task.external_source}
                    </a>
                  ),
                ]}
              />
              <TaskObjective task={task} />
              <DescriptionCard task={task} members={members} onPatch={onPatch} />
              <TaskPlan task={task} onStepSet={(i, done) => setStep(task.id, i, done)} />
              <TaskDetailSection>
                <TaskGoals repoRoot={repoRoot} task={task} />
              </TaskDetailSection>
              <SubTasksPanel
                task={task}
                allTasks={allTasks}
                repoRoot={repoRoot}
                onCreateChild={onCreateChild}
                onOpenChild={openSubtask}
              />
              <TaskRunOrder task={task} allTasks={allTasks} onOpen={openTask} />
              <TaskCrewActivity taskId={task.id} repoRoot={repoRoot} onOpenTask={openTask} />
              <TaskActivityTimeline task={task} repoRoot={repoRoot} onPatch={onPatch} />
              <CommentsCard task={task} repoRoot={repoRoot} currentHandle={null} />
            </>
          }
        />
      )}
    </FullscreenOverlay>
  );
}
