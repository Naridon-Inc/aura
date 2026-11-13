// The details panel's Tasks tab: the project's board as the library task list.
//
// The board's home used to be a page of its own. It lives here now, beside the
// work it describes: each row ticks done and back, opens into the task's
// detail, and "New task" — pinned under the list, where it stays while the
// list scrolls — files one. Everything else the board does — editing,
// moving between custom columns, bulk work — the detail's Edit opens, so this
// list stays the short one the library draws.
//
// It reads the same `.aura/tasks` store every other task surface reads, through
// the shared readers, and it hears their writes on `aura:tasks:mutated` so a
// change made in the detail or on a teammate's machine shows here too.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";

import {
  api,
  type CreateTaskInput,
  type Task,
  type TaskState,
  type TeamMember,
} from "../../lib/api";
import { useEffectiveHandle } from "../../lib/identityHandle";
import { usePanelActive } from "../../lib/panelActive";
import { openPopout } from "../../lib/popout";
import { fetchTasks, fetchTaskStates } from "../../lib/tasksCache";
import { fetchTeam } from "../../lib/teamCache";
import { trackFeature } from "../../lib/track";
import { TaskDetailPane } from "../tasks/TaskDetailPane";
import { TaskCreateDialog } from "../tasks/TaskCreateDialog";
import { Button } from "../ui/button";
import { ErrorNote, LoadingState } from "../ui/state";
import { TaskPanel, type TaskItem } from "../ui/tasks";
import { appliedWrite, railItems, statusWrite } from "./railTasks";

const MUTATED = "aura:tasks:mutated";
/** How often the tab asks whether a teammate's push changed the board. */
const SYNC_POLL_MS = 6000;

function broadcastMutation(): void {
  window.dispatchEvent(new CustomEvent(MUTATED));
}

export function TasksRailPanel({ repoRoot }: { repoRoot: string }) {
  const active = usePanelActive();
  const activeRef = useRef(active);
  activeRef.current = active;
  const me = useEffectiveHandle(repoRoot);

  const [tasks, setTasks] = useState<Task[]>([]);
  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks;
  const [states, setStates] = useState<TaskState[]>([]);
  const statesRef = useRef<TaskState[]>([]);
  statesRef.current = states;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [members, setMembers] = useState<TeamMember[]>([]);

  // Only the latest read lands: a slow read of the last project must not
  // overwrite the one you switched to.
  const readSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++readSeq.current;
    try {
      const [rows, catalog] = await Promise.all([
        fetchTasks(repoRoot),
        fetchTaskStates(repoRoot).catch(() => [] as TaskState[]),
      ]);
      if (seq !== readSeq.current) return;
      setTasks(rows);
      setStates(catalog);
      setError(null);
    } catch (e) {
      if (seq === readSeq.current) setError(String(e));
    } finally {
      if (seq === readSeq.current) setLoaded(true);
    }
  }, [repoRoot]);

  // A different project is a different board: start from nothing.
  useEffect(() => {
    setTasks([]);
    setLoaded(false);
    setOpenId(null);
    setCreating(false);
    void refresh();
  }, [refresh]);

  // A write from anywhere else — the detail, the full board, another tab of
  // this panel — shows here. Parked behind another tab, it only notes that the
  // list is stale and reads once the tab comes back.
  const stale = useRef(false);
  useEffect(() => {
    const onMutate = () => {
      if (activeRef.current) void refresh();
      else stale.current = true;
    };
    window.addEventListener(MUTATED, onMutate);
    return () => window.removeEventListener(MUTATED, onMutate);
  }, [refresh]);

  // A teammate's push shows within a tick while the tab is in front, and at
  // once when the window or the tab comes back. Nothing polls while parked.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;
    if (stale.current) {
      stale.current = false;
      void refresh();
    }
    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const res = await api.tasksSyncPoll(repoRoot).catch(() => ({ changed: false }));
        if (!cancelled && res.changed) await refresh();
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const id = window.setInterval(poll, SYNC_POLL_MS);
    window.addEventListener("focus", poll);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", poll);
    };
  }, [active, repoRoot, refresh]);

  // The people a new task can go to, read when the form opens.
  useEffect(() => {
    if (!creating) return;
    let cancelled = false;
    fetchTeam(repoRoot)
      .then((team) => {
        if (!cancelled) setMembers(team?.members ?? []);
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [creating, repoRoot]);

  const replace = (id: string, next: Task) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? next : t)));

  // The row moves at once and goes back if the write is refused.
  const changeStatus = useCallback(
    (id: string, next: TaskItem["status"]) => {
      const task = tasksRef.current.find((t) => t.id === id);
      if (!task) return;
      const catalog = statesRef.current;
      const input = statusWrite(id, next, catalog);
      replace(id, appliedWrite(task, input, catalog));
      api
        .tasksUpdate(repoRoot, input)
        .then((saved) => {
          replace(id, saved);
          broadcastMutation();
          trackFeature("task_move", { surface: "details_panel", status: next });
        })
        .catch((e) => {
          replace(id, task);
          setError(String(e));
        });
    },
    [repoRoot],
  );

  // A refused write throws back into the dialog, which stays open and says
  // why — the list behind it is not where the reader is looking.
  const create = async (input: CreateTaskInput) => {
    const next = await api.tasksCreate(repoRoot, input);
    setTasks((prev) => [next, ...prev]);
    setCreating(false);
    broadcastMutation();
    trackFeature("task_create", { surface: "details_panel" });
  };

  const items = useMemo(
    () => railItems(tasks, new Map(states.map((s) => [s.id, s]))),
    [tasks, states],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {error && <ErrorNote className="m-3">{error}</ErrorNote>}
        {loaded ? (
          <TaskPanel tasks={items} onStatusChange={changeStatus} onOpen={setOpenId} />
        ) : (
          <LoadingState label="Reading tasks…" className="p-3" />
        )}
      </div>
      <div className="ui-details-foot">
        <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
          <Plus />
          New task
        </Button>
      </div>

      {creating && (
        <TaskCreateDialog
          members={members}
          onCancel={() => setCreating(false)}
          onSubmit={create}
          defaultAssignee={me ?? undefined}
        />
      )}
      {openId && (
        <TaskDetailPane
          taskId={openId}
          repoRoot={repoRoot}
          onClose={() => setOpenId(null)}
          onDetach={() => openPopout({ kind: "task", root: repoRoot, taskId: openId })}
        />
      )}
    </div>
  );
}
