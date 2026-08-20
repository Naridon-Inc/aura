// JIRA-style human-task tracker. Full-screen overlay above the work
// surface; backed by `<repoRoot>/.aura/tasks/tasks.json` via the
// `tasks_*` Tauri commands. Distinct from the A2A agent dispatcher
// in TeamTasksPanel — this is for humans tracking real work
// (features, bugs, chores).
//
// Layout: one bar of chrome (how much work is on screen, the Filters and
// Display menus, "+ New") above ONE list, grouped by whatever you picked —
// status, by default. A row clicks to the detail pane for a full edit, and its
// status tag sets the status in place, which is what dragging a card between
// kanban lanes used to be for.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Sparkles,
  Bug,
  FlaskConical,
  Ruler,
  Wrench,
  AlertTriangle,
  Bot,
  Mountain,
  Inbox,
  Plus,
  SquareArrowOutUpRight,
} from "lucide-react";
import {
  api,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type TeamMember,
  type CreateTaskInput,
  type UpdateTaskInput,
  type Sprint,
  type TaskViewFilters,
  type TaskViewGroupBy,
  type TaskViewOrderBy,
  type TaskViewOrderDir,
  type TaskViewDisplayProp,
  type TaskState,
  type TaskLabel,
  type Cycle,
  type Module,
} from "../lib/api";
import { fetchCycles, fetchModules, fetchTaskLabels, fetchTaskStates } from "../lib/tasksCache";
import { trackFeature } from "../lib/track";
import { peekCache, writeCache } from "../lib/resourceCache";
import { Button } from "./ui/button";
import { CreateTaskWizard } from "./tasks/CreateTaskWizard";
import { TaskDetailPane, TASK_EDIT_EVENT } from "./tasks/TaskDetailPane";
import { BoardEmpty, BoardFilteredEmpty } from "./board";
import {
  goToWork,
  isCrewLens,
  taskViewFor,
  type WorkLens,
} from "../lib/workRoute";
import { WorkLensTabs } from "./tasks/WorkLensTabs";
import { TasksBoardView } from "./tasks/TasksBoardView";
import { TasksListView } from "./tasks/TasksListView";
import { BulkActionToolbar } from "./tasks/BulkActionToolbar";
import {
  TasksAppliedFilters,
  TasksControls,
  DEFAULT_DISPLAY_PROPS,
} from "./tasks/TasksFilterBar";
import {
  useTaskShortcuts,
  type TaskShortcutAction,
} from "./tasks/useTaskShortcuts";
import {
  useTasksSharedFilters,
  clearTasksSharedFilters,
  railBoardTaskIds,
  setTasksSharedSidebar,
} from "../lib/tasksFilterStore";
import { useEditorStore } from "../lib/editorStore";
import { openPopout } from "../lib/popout";
import { SurfaceHeader } from "./ui/SurfaceHeader";
import { askConfirm } from "./ui/ask";
import { ShortcutsDialog } from "./dialogs/ShortcutsDialog";
import {
  loadTasksForRoots,
  rootsForScope,
  rootsKeyOf,
  useKnownProjects,
  useProjectScope,
} from "../lib/projectRoots";
import { fetchTeam } from "../lib/teamCache";

// The composite the board caches under `tasks:${roots}` so reopening
// paints instantly (resourceCache) instead of refetching every open. Keyed on
// the roots rather than one root because All projects is a different set, and
// two sets sharing a cache key means the wrong one paints on open.
/** A task, remembering the project it was read out of. The tag survives into
 *  the warm-open cache so a mutation made before the first refetch lands still
 *  goes back to the right file. */
type ScopedTask = Task & { __root?: string };

/** First occurrence wins — the scope is ordered most-recently-opened first, so
 *  the open project's spelling of a shared person or label is the one kept. */
function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
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

type TasksBundle = {
  tasks: ScopedTask[];
  members: TeamMember[];
  sprints: Sprint[];
  taskStates: TaskState[];
  taskLabels: TaskLabel[];
  cycles: Cycle[];
  modules: Module[];
};

type Props = {
  repoRoot: string;
  /** Modal-mode visibility flag. Ignored when `embedded` is true. */
  open?: boolean;
  onClose: () => void;
  /** Optional default assignee — usually the current user's git handle. */
  currentHandle?: string | null;
  /** When true, the board renders inline in a workpane tab (no
   *  inset-0 overlay, no Esc-to-close, always mounted). Used by
   *  V.1's `kind: "tasks"` workpane variant. */
  embedded?: boolean;
  /** When provided, the header shows a "pop out" control that spins this
   *  board off into a floating OS window (lib/popout.ts). Intentionally
   *  omitted inside the popout itself so it can't pop out of a popout. */
  onPopOut?: () => void;
  /** The lens the host is showing, when the host owns it — the Tasks
   *  destination does, so the choice survives a switch to Graph and back. Left
   *  off (a workpane tab, the popout) the board keeps its own. */
  lens?: WorkLens;
  onLens?: (next: WorkLens) => void;
};

type ViewMode = "board" | "list";

// Down to the two drawings that matter day-to-day: List and Board (kanban).
// Calendar / Gantt / Roadmap / Epics / Spreadsheet were removed because they
// weren't shipping signal yet, and re-adding one is cheap when there's real
// demand.
//
// Sprint went the same way, later and for a different reason: it wasn't a way
// of looking at the work, it was a dashboard about a sprint — burndown,
// capacity, velocity, at-risk, a pull-in drawer — sitting on a strip whose
// other cells all answered "how do you want this drawn?". Picking a sprint in
// the rail narrows List and Board to it, which is what a slice of the backlog
// needs; the sprint's own lifecycle moved to the rail beside the sprints
// (components/tasks/SprintRailGroup).
//
// "Cheap" is literal for the spreadsheet: it was a finished component
// taking the props this board already holds (tasks, members,
// displayProps, selectedId, onSelect, patchTask, quickCreate), left
// sitting unimported for months along with the InteractiveTable shell
// it rendered into. Both have now been deleted rather than left to
// rot — `git log --diff-filter=D -- '*/TasksSpreadsheetView.tsx'`
// names the commit that holds them whole.
//
// The header's option list is no longer declared here. This board's two
// drawings are two of the THREE lenses on the work — the third being the
// crew's Graph — and a strip that only offered this board's own would have
// left the merged destination with two different-length switches depending on
// which surface happened to be mounted. `WORK_LENSES` in lib/workRoute is the
// single list; both surfaces render it.

// Quick-start templates surfaced on the empty state. Each template
// pre-fills the create dialog so a first task can ship in two clicks.
// Templates are intentionally biased toward dev work: incident, feature
// design, bug, doc/RFC, tech debt, agent dispatch.
type TaskTemplate = {
  id: string;
  label: string;
  icon: ReactNode;
  hint: string;
  preset: Partial<CreateTaskInput>;
};

const TPL_ICON = "w-4 h-4 text-text-3";

const TEMPLATES: TaskTemplate[] = [
  {
    id: "feature",
    label: "Feature",
    icon: <Sparkles className={TPL_ICON} strokeWidth={1.5} />,
    hint: "New user-facing capability",
    preset: { priority: "medium", labels: ["feature"] },
  },
  {
    id: "bug",
    label: "Bug",
    icon: <Bug className={TPL_ICON} strokeWidth={1.5} />,
    hint: "Something is broken",
    preset: { priority: "high", labels: ["bug"] },
  },
  {
    id: "spike",
    label: "Spike",
    icon: <FlaskConical className={TPL_ICON} strokeWidth={1.5} />,
    hint: "Time-boxed investigation",
    preset: { priority: "medium", labels: ["spike"], estimate: 4 },
  },
  {
    id: "rfc",
    label: "RFC / Design",
    icon: <Ruler className={TPL_ICON} strokeWidth={1.5} />,
    hint: "Write up before coding",
    preset: { priority: "medium", labels: ["rfc", "design"] },
  },
  {
    id: "tech-debt",
    label: "Tech debt",
    icon: <Wrench className={TPL_ICON} strokeWidth={1.5} />,
    hint: "Cleanup / refactor",
    preset: { priority: "low", labels: ["tech-debt"] },
  },
  {
    id: "incident",
    label: "Incident",
    icon: <AlertTriangle className={TPL_ICON} strokeWidth={1.5} />,
    hint: "Post-incident follow-up",
    preset: { priority: "high", labels: ["incident", "postmortem"] },
  },
  {
    id: "agent-claude",
    label: "Send to Claude",
    icon: <Bot className={TPL_ICON} strokeWidth={1.5} />,
    hint: "Hand off to Claude Code",
    preset: { priority: "medium", agent_assignee: "claude", labels: ["agent"] },
  },
  {
    id: "epic",
    label: "New Epic",
    icon: <Mountain className={TPL_ICON} strokeWidth={1.5} />,
    hint: "Groups related tasks together",
    preset: { priority: "medium", is_epic: true, labels: ["epic"] },
  },
];

export function TasksBoard({
  repoRoot,
  open: openProp,
  onClose,
  currentHandle,
  embedded = false,
  lens,
  onLens,
  onPopOut,
}: Props) {
  // Embedded mode is always "open" — the workpane chrome controls visibility.
  const open = embedded ? true : openProp ?? false;

  // ── Which projects this board is showing ────────────────────────────
  //
  // The rail's project picker writes one shared scope and this reads it, so
  // the counts in the rail and the cards on the board are the same claim
  // about the same set. Under "All projects" every known root is read and
  // each task remembers where it came from, which is what lets a change made
  // here go back to the file it came out of rather than to whichever project
  // happens to be open.
  const scope = useProjectScope();
  const projects = useKnownProjects(repoRoot);
  const roots = useMemo(
    () => rootsForScope(scope, repoRoot, projects),
    [scope, repoRoot, projects],
  );
  const rootsKey = rootsKeyOf(roots);
  const multiRoot = roots.length > 1;
  /** Where a new task lands, and whose per-project catalogs (sprints,
   *  workstreams, saved views) the board shows. Under All projects that is
   *  the project the app has open — a new task has to be filed somewhere. */
  const primaryRoot = roots.length === 1 ? roots[0]! : repoRoot;
  /** id → the project a task was read out of. A ref, not state: it changes
   *  in lockstep with `tasks` and nothing renders from it directly. */
  const taskRootRef = useRef<Map<string, string>>(new Map());
  const rootOf = useCallback(
    (id: string) => taskRootRef.current.get(id) ?? primaryRoot,
    [primaryRoot],
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  // OO.3 — per-repo state + label catalogs. Loaded alongside tasks so
  // we can render Plane-style state pills and label chips off the
  // canonical catalogs instead of synthesising them from raw strings.
  const [taskStates, setTaskStates] = useState<TaskState[]>([]);
  const [taskLabels, setTaskLabels] = useState<TaskLabel[]>([]);
  // The Cycle + Module catalogs are NOT held here. They were, back when
  // this board handed them to a detail surface it owned; every surface that
  // shows a cycle or module picker now loads its own (TaskDetailPane and the
  // TasksSidebar rail both call `tasksCyclesList` directly), so a third copy
  // on the board was a fetch nobody read and a staleness window nobody could
  // see. The load below still writes them into the cached bundle — that
  // shape is the board's warm-open snapshot, not a live read.
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(() => {
    try {
      const raw = localStorage.getItem("aura.tasksBoard.view") as ViewMode | null;
      // Also the migration off the retired Sprint drawing: a stored "sprint"
      // is no longer a view, so it falls back rather than rendering nothing.
      const valid: ViewMode[] = ["board", "list"];
      return raw && valid.includes(raw) ? raw : "list";
    } catch {
      return "list";
    }
  });
  // The lens the header strip shows, and what picking one does.
  //
  // The Tasks destination owns it — so switching to Graph and back returns you
  // to the drawing you were on — and hands it down. Anywhere else (a workpane
  // tab, the popout) the board owns its own, and the crew's lens is a
  // navigation to the destination rather than a dead cell.
  const activeLens: WorkLens = lens ?? view;
  const chooseLens = (next: WorkLens) => {
    if (onLens) {
      onLens(next);
      return;
    }
    if (isCrewLens(next)) {
      goToWork(next);
      return;
    }
    setView(taskViewFor(next));
  };
  // What the body draws. It has to come from the lens on screen, not from
  // `view`: when the host owns the lens — the Tasks destination does — picking
  // a cell calls `onLens` and never touches `view`, so a body reading `view`
  // would go on drawing the lens you just left. The header would say List over
  // a screen of lanes.
  const drawing = taskViewFor(activeLens);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** OO.5 — multi-selection set used by the BulkActionToolbar. Backed
   *  by a plain Array (not Set) so React diffs cleanly across renders.
   *  Mutually exclusive with `selectedId` in spirit (the bulk toolbar
   *  takes over when ≥ 1 task is multi-selected) but we leave both
   *  states alive so a single-click on a card while a bulk selection
   *  exists can still open the detail panel without nuking the bulk
   *  scope. Cleared by the toolbar's "×" button or after a successful
   *  bulk op. */
  const [multiSelectedIds, setMultiSelectedIds] = useState<string[]>([]);
  /** Last-focused card. Drives single-key shortcuts, and is set on every
   *  click — including the shift-click that opens a workpane tab instead
   *  of the detail overlay. */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  /** The card currently being dragged between kanban lanes. Only the Board
   *  drawing sets it; the list moves a task by picking its status tag. */
  const [dragId, setDragId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** When set, the task with this id is open in the full-screen edit
   *  wizard (the same FullscreenOverlay shell as create). Reached only
   *  via the detail pane's Edit button or the a/p/s/l field shortcuts —
   *  the tabs surface on demand, not on a plain card click. */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** When set, the task with this id is open in the read-mode detail
   *  pane (markdown doc + metadata, no wizard tabs). Default card click
   *  and Enter open this; Edit inside it promotes to `editingId`. */
  const [detailId, setDetailId] = useState<string | null>(null);
  /** Template preset for the open create modal — populated when a user
   *  picks a template card from the empty state. Cleared on submit/cancel. */
  const [createInitial, setCreateInitial] = useState<Partial<CreateTaskInput> | null>(null);

  // ─── OO.2 Phase 2 — filter / group / order / display state ──────────
  //
  // Source of truth lives here. Saved views write these props out to
  // `.aura/tasks/views.json`; the *selected* view id is persisted to
  // localStorage so a refresh lands on the same slice. Filters that
  // are not part of a saved view stay in this state only — they
  // survive a tab switch but not a process restart, matching Plane.
  const [filters, setFilters] = useState<TaskViewFilters>({});

  /**
   * What the filter bar calls when *you* change a filter — as opposed to the
   * rail change mirrored down by the effect below.
   *
   * The rail and the bar are two views of one filter, and the sync between
   * them ran one way only: the rail wrote the shared store, the board copied
   * it into local state, and nothing ever went back. So clicking "Active" in
   * the rail and then "Clear all" in the bar left the board unfiltered while
   * the rail carried on highlighting Active — the row asserting a scope the
   * screen behind it was no longer in. Removing a single chip desynced the
   * same way. Pushing the three dimensions the rail owns back into the store
   * makes the rail re-derive its own highlight from what is actually applied.
   */
  const handleFilters = useCallback((next: TaskViewFilters) => {
    setFilters(next);
    setTasksSharedSidebar({
      status: next.status,
      assignee: next.assignee,
      overdue: next.overdue,
    });
  }, []);
  const [groupBy, setGroupBy] = useState<TaskViewGroupBy>("status");
  const [orderBy, setOrderBy] = useState<TaskViewOrderBy>("updated");
  const [orderDir, setOrderDir] = useState<TaskViewOrderDir>("desc");
  const [displayProps, setDisplayProps] = useState<TaskViewDisplayProp[]>(
    DEFAULT_DISPLAY_PROPS,
  );
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // OO.4 — Sidebar cycle/module selection. `null` means "no filter";
  // any other value restricts `visibleTasks` to rows whose
  // `cycle_id` / `module_id` matches. The two selectors are
  // independent — picking a cycle does NOT clear a module pick — so
  // the user can drill from "this module" → "this cycle within it".
  const [selectedCycleId, setSelectedCycleId] = useState<string | null>(null);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  // OO.6 — pull bucket selection from the app-level <TasksSidebar>
  // rail (mounted in the Layout's sidebar slot when this board is the
  // active workpane). The sidebar writes into `tasksFilterStore`;
  // here we mirror its picks into the board's local state so the
  // existing filter pipeline keeps working without a refactor.
  const sharedSidebar = useTasksSharedFilters();
  useEffect(() => {
    setFilters((prev) => ({
      ...prev,
      status: sharedSidebar.sidebar.status,
      assignee: sharedSidebar.sidebar.assignee,
      overdue: sharedSidebar.sidebar.overdue,
    }));
  }, [
    sharedSidebar.sidebar.status,
    sharedSidebar.sidebar.assignee,
    sharedSidebar.sidebar.overdue,
  ]);
  useEffect(() => {
    setSelectedCycleId(sharedSidebar.cycleId);
  }, [sharedSidebar.cycleId]);
  useEffect(() => {
    setSelectedModuleId(sharedSidebar.moduleId);
  }, [sharedSidebar.moduleId]);
  // The cards behind the rail's goal / crew pick, when one is made. `null` is
  // "no loop narrowing", which is not the same as an empty set: a goal whose
  // work was authored straight into the graph has no cards behind it, and
  // showing none of them is the honest answer to picking it.
  const railIds = useMemo(
    () => railBoardTaskIds(sharedSidebar),
    [sharedSidebar],
  );
  // Clearing the shared store used to happen here, on unmount. That was right
  // when leaving the board meant leaving Tasks; it is wrong now that the board
  // is one of four lenses inside one place, because switching to Plan would
  // silently drop the sprint you were reading. The place owns it — see
  // tasks/TasksPlace.

  // OO.6 — bridge the app-level sidebar's "+ New task" button to the
  // board's create modal. The sidebar fires this CustomEvent so we
  // don't have to plumb a ref through the Layout.
  useEffect(() => {
    const onNew = () => {
      setCreateInitial(null);
      setCreating(true);
    };
    window.addEventListener("aura:tasks:new", onNew);
    return () => window.removeEventListener("aura:tasks:new", onNew);
  }, []);

  // OO.6 — broadcast every task-list change so the app-level
  // <TasksSidebar> can refresh its bucket counts without waiting
  // for its 30s poll. Skips the initial mount (no mutation yet).
  const tasksLengthRef = useRef<number | null>(null);
  useEffect(() => {
    if (tasksLengthRef.current === null) {
      tasksLengthRef.current = tasks.length;
      return;
    }
    tasksLengthRef.current = tasks.length;
    window.dispatchEvent(new CustomEvent("aura:tasks:mutated"));
  }, [tasks]);

  useEffect(() => {
    try {
      localStorage.setItem("aura.tasksBoard.view", view);
    } catch {
      /* quota — ignore */
    }
  }, [view]);

  const refresh = useCallback(async () => {
    if (roots.length === 0) return;
    const key = `tasks:${rootsKey}`;
    // Cold load (nothing cached) → show the skeleton. Warm revalidate
    // keeps the seeded cards on screen while the refetch runs.
    if (!peekCache<TasksBundle>(key)) setLoading(true);
    setError(null);
    try {
      // People, states and labels merge across the scope: a task assigned to
      // someone who only appears on another project's team would otherwise
      // render as an unresolved handle, and its label as a grey chip. Sprints
      // and workstreams do NOT merge — they are per-project catalogs where two
      // projects can each have a "Sprint 3", and a merged list would offer you
      // a sprint that can't hold the task you'd drag into it. The rail says as
      // much where it lists them.
      const [rows, teams, sprintRows, stateSets, labelSets, cycleRows, moduleRows] =
        await Promise.all([
          loadTasksForRoots(roots),
          Promise.all(roots.map((r) => fetchTeam(r).catch(() => null))),
          multiRoot
            ? Promise.resolve([] as Sprint[])
            : api.sprintsList(primaryRoot).catch(() => [] as Sprint[]),
          Promise.all(
            roots.map((r) => fetchTaskStates(r).catch(() => [] as TaskState[])),
          ),
          Promise.all(
            roots.map((r) => fetchTaskLabels(r).catch(() => [] as TaskLabel[])),
          ),
          multiRoot
            ? Promise.resolve([] as Cycle[])
            : fetchCycles(primaryRoot).catch(() => [] as Cycle[]),
          multiRoot
            ? Promise.resolve([] as Module[])
            : fetchModules(primaryRoot).catch(() => [] as Module[]),
        ]);
      const memberRows = dedupeBy(
        teams.flatMap((t) => t?.members ?? []),
        (m) => m.handle,
      );
      const stateRows = dedupeBy(stateSets.flat(), (x) => x.id);
      const labelRows = dedupeBy(labelSets.flat(), (x) => x.id);
      const nextRoots = new Map<string, string>();
      for (const r of rows) nextRoots.set(r.id, r.__root);
      taskRootRef.current = nextRoots;
      writeCache<TasksBundle>(key, {
        tasks: rows,
        members: memberRows,
        sprints: sprintRows,
        taskStates: stateRows,
        taskLabels: labelRows,
        cycles: cycleRows,
        modules: moduleRows,
      });
      setTasks(rows);
      setMembers(memberRows);
      setSprints(sprintRows);
      setTaskStates(stateRows);
      setTaskLabels(labelRows);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
    // `rootsKey` stands in for `roots`: a fresh array identity every render
    // would rebuild this callback — and restart the poll below — constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, multiRoot, primaryRoot]);

  useEffect(() => {
    if (!open || roots.length === 0) return;
    // Warm open: paint the last load instantly from cache, then
    // revalidate in the background so the board never flashes empty
    // (or shows a skeleton) when reopened within a session.
    const cached = peekCache<TasksBundle>(`tasks:${rootsKey}`);
    if (cached) {
      const warm = new Map<string, string>();
      for (const t of cached.tasks) if (t.__root) warm.set(t.id, t.__root);
      taskRootRef.current = warm;
      setTasks(cached.tasks);
      setMembers(cached.members);
      setSprints(cached.sprints);
      setTaskStates(cached.taskStates);
      setTaskLabels(cached.taskLabels);
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refresh, rootsKey]);

  // #218 — live-sync. Poll the chat rail for task mutations teammates
  // published and refetch when something landed. Invisible plumbing: no
  // UI, and the backend short-circuits to `changed:false` for solo
  // repos so the poll costs nothing there. `inFlight` collapses overlap
  // if a refetch outlasts the interval; failures (offline / no cloud)
  // fall through to the next tick.
  useEffect(() => {
    if (!open || roots.length === 0) return;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        // Every project in scope, not just the open one — under All projects
        // a teammate's push to any of them changes what's on screen.
        const res = await Promise.all(
          roots.map((r) =>
            api.tasksSyncPoll(r).catch(() => ({ changed: false })),
          ),
        );
        if (!cancelled && res.some((r) => r.changed)) await refresh();
      } catch {
        /* offline or no cloud configured — next tick retries */
      } finally {
        inFlight = false;
      }
    };
    const id = window.setInterval(poll, 6000);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    void poll(); // converge fast on open instead of waiting a full tick
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rootsKey, refresh]);

  // Esc closes; only when no inner modal is open. Skipped in embedded
  // mode — the workpane chrome owns close semantics there.
  useEffect(() => {
    if (!open || embedded) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (creating) {
          setCreating(false);
          return;
        }
        // The edit wizard (FullscreenOverlay) owns Esc while it's up —
        // don't let the board-level handler close the board underneath it.
        if (editingId) {
          return;
        }
        if (selectedId) {
          setSelectedId(null);
          return;
        }
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, embedded, creating, selectedId, editingId, onClose]);

  const editingTask = useMemo(
    () => (editingId ? tasks.find((t) => t.id === editingId) ?? null : null),
    [editingId, tasks],
  );

  /** Deduped labels across all tasks — drives the label filter
   *  popover. Capped at 200 to keep popover render snappy on big
   *  repos; the user can always type a label name in via the search
   *  box (Phase 3 will expand this). */
  const allLabels = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) for (const l of t.labels) set.add(l);
    return Array.from(set).sort((a, b) => a.localeCompare(b)).slice(0, 200);
  }, [tasks]);

  /** Apply filters → sort → return. Epics are intentionally excluded
   *  from non-epic views so the kanban doesn't double-count container
   *  cards. Archived rows (Phase 3) are filtered out everywhere.
   *  OO.4 — sidebar cycle/module selectors apply as an extra filter
   *  stripe AFTER the saved-view filter set so the sidebar pick
   *  scopes within whatever the user already filtered to. */
  const visibleTasks = useMemo(
    () => {
      let scope = applyFilters(tasks, filters, currentHandle ?? null).filter(
        (t) => !t.archived_at,
      );
      if (selectedCycleId) {
        scope = scope.filter((t) => t.cycle_id === selectedCycleId);
      }
      if (selectedModuleId) {
        scope = scope.filter((t) => t.module_id === selectedModuleId);
      }
      // The rail's goal / crew pick, said in cards. Crew work is a PROJECTION
      // of this board — every node carries the id of the card it came from — so
      // picking a goal in the rail narrows the board to the cards that goal is
      // made of, exactly the way picking a sprint does. Without this the rail
      // lit a row and this drawing carried on showing everything.
      if (railIds) {
        scope = scope.filter((t) => railIds.has(t.id));
      }
      return applyOrder(scope, orderBy, orderDir);
    },
    [
      tasks,
      filters,
      orderBy,
      orderDir,
      currentHandle,
      selectedCycleId,
      selectedModuleId,
      railIds,
    ],
  );

  // ── Shortcut handler ──────────────────────────────────────────────
  //
  // Dispatches single-key shortcuts to the right side-effect. Pickers
  // (a/p/s/l) open the side panel — the panel exposes those editors;
  // forcing a click to them would mean reimplementing the pickers
  // here, which Phase 3 might do as a Plane-style "command bar"
  // floating menu.

  const handleShortcut = useCallback(
    (action: TaskShortcutAction) => {
      if (action === "help") {
        setShortcutsOpen(true);
        return;
      }
      if (action === "close") {
        // Innermost thing first: the overlay, then the wizard, then the
        // side panel, then the focus ring.
        if (detailId) setDetailId(null);
        else if (editingId) setEditingId(null);
        else if (selectedId) setSelectedId(null);
        else if (focusedId) setFocusedId(null);
        return;
      }
      if (!focusedId) return;
      if (action === "open") {
        // Enter opens the read-mode detail pane for the focused row;
        // Edit inside it promotes to the stepped wizard.
        setDetailId(focusedId);
        return;
      }
      if (action === "delete") {
        // The hot-key asks the same question the detail panel asks, in the
        // same sheet. Kept out of the handler's own control flow so the
        // keydown stays synchronous.
        const t = tasks.find((x) => x.id === focusedId);
        if (!t) return;
        void (async () => {
          const ok = await askConfirm({
            title: `Delete "${t.title || "(untitled)"}"?`,
            body: "This can't be undone.",
            confirmLabel: "Delete",
            tone: "danger",
          });
          if (ok) void deleteTask(focusedId);
        })();
        return;
      }
      if (action === "copy_id") {
        // Hook already wrote to clipboard; nothing else to do.
        return;
      }
      // a / p / s / l — open the edit wizard so the user can pick.
      // Storing a hint so the wizard could deep-link to the matching
      // step/popover is a later polish; for now we just open.
      setEditingId(focusedId);
    },
    // `deleteTask` is referenced by closure but stable across renders
    // — listing the deps it really depends on.
    [focusedId, selectedId, editingId, detailId, tasks],
  );

  const focusedSeq =
    focusedId
      ? tasks.find((t) => t.id === focusedId)?.sequence_id ?? 0
      : 0;

  useTaskShortcuts({
    taskId: focusedId,
    sequenceId: focusedSeq,
    onShortcut: handleShortcut,
    disabled: creating || editingId != null || detailId != null || !open,
  });

  // When a card is clicked, also focus it so single-key shortcuts
  // target the right row.
  const editor = useEditorStore();

  // Promote a task into the stepped editor when the read-mode detail
  // pane asks (its Edit button → editor.requestTaskEdit). The detail can
  // be board-local or its own workpane tab, so two paths converge here:
  //   • event — an already-mounted board reacts instantly;
  //   • pending — a board that mounts fresh (the detail was a full tab)
  //     consumes the stashed id.
  // The event handler clears the pending id so a later remount can't
  // replay a stale edit.
  useEffect(() => {
    const promote = (id: string) => {
      setSelectedId(null);
      setDetailId(null);
      setEditingId(id);
    };
    const onEdit = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (!id) return;
      editor.consumePendingTaskEdit(repoRoot); // clear, ignore result
      promote(id);
    };
    window.addEventListener(TASK_EDIT_EVENT, onEdit);
    const pending = editor.consumePendingTaskEdit(repoRoot);
    if (pending) promote(pending);
    return () => window.removeEventListener(TASK_EDIT_EVENT, onEdit);
  }, [editor, repoRoot]);

  const handleSelect = useCallback(
    (id: string, opts?: { newTab?: boolean; multi?: boolean }) => {
      // OO.5 — Cmd/Ctrl+click toggles the card into the bulk
      // selection set. The detail panel does NOT open in that mode so
      // the user can build the selection up without flickering the
      // right rail.
      if (opts?.multi) {
        setMultiSelectedIds((prev) => {
          if (prev.includes(id)) return prev.filter((x) => x !== id);
          // A bulk edit is one call against one project's task file, so a
          // selection that spans two projects is one this board can't carry
          // out. Rather than let it build up and fail at the toolbar, adding
          // a task from a different project starts a new selection there.
          const root = rootOf(id);
          const kept = prev.filter((x) => rootOf(x) === root);
          return [...kept, id];
        });
        setFocusedId(id);
        return;
      }
      setFocusedId(id);
      if (opts?.newTab) {
        // Shift-click promotes to a persistent workpane tab so the
        // user can keep multiple task details open while working.
        setSelectedId(null);
        setEditingId(null);
        editor.openTaskDetail(id, rootOf(id));
      } else {
        // Default click opens the task in the overlay every other detail in
        // this app opens in — the same FullscreenOverlay chrome as create and
        // edit, so reading a task, editing it and making one are one surface
        // in three states rather than three different-shaped surfaces.
        //
        // It briefly opened a side slide-over instead. A panel that takes the
        // right third and pushes the board under it is neither of the two
        // things a slide-over is for: it is not small enough to leave the
        // board usable, and not whole enough to hold a task's description, its
        // sub-tasks and its activity without scrolling all three in a column
        // narrower than the card you clicked.
        //
        // Shift-click still promotes to a persistent workpane tab.
        setSelectedId(null);
        setEditingId(null);
        setDetailId(id);
      }
    },
    [editor, rootOf],
  );

  // OO.5 — drop ids from the multi-selection set whenever the
  // underlying task list changes. Without this, a card the user
  // selected then deleted elsewhere lingers in `multiSelectedIds`
  // and the toolbar tries to bulk-op a ghost id.
  useEffect(() => {
    const valid = new Set(tasks.map((t) => t.id));
    setMultiSelectedIds((prev) => prev.filter((id) => valid.has(id)));
  }, [tasks]);

  // OO.5 — sub-issue create surface for the detail panel's "+ Add
  // child" button. Mirrors quickCreate but pre-fills `parent_id`.
  const createChildTask = useCallback(
    async (parentId: string, title: string) => {
      const t = title.trim();
      if (!t) return;
      // A child belongs to its parent's project, not to whichever one is open.
      const root = rootOf(parentId);
      const next = await api.tasksCreate(root, {
        title: t,
        parent_id: parentId,
      });
      taskRootRef.current.set(next.id, root);
      setTasks((prev) => [...prev, { ...next, __root: root }]);
    },
    [rootOf],
  );

  async function patchTask(input: UpdateTaskInput) {
    try {
      const root = rootOf(input.id);
      const next = await api.tasksUpdate(root, input);
      setTasks((prev) =>
        prev.map((t) => (t.id === next.id ? { ...next, __root: root } : t)),
      );
      // A cycle/module membership change used to bump a board-local refresh
      // key here so the member-count chips stayed accurate. Both catalogs now
      // live in the surfaces that show them, and `setTasks` above lands a new
      // array — which fires the `aura:tasks:mutated` broadcast those surfaces
      // already listen on. Two mechanisms for one refresh; this is the one
      // that reaches every reader.
      //
      // For labels: writing a label name the catalog hasn't got
      // mints it server-side (update_task auto-imports), so without this the
      // picker keeps showing the catalog as it was — a task wearing a label
      // the list right underneath still says doesn't exist, and no way to
      // toggle it back off.
      if ("labels" in input || "label_ids" in input) {
        api
          .taskLabelsList(root)
          .then(setTaskLabels)
          .catch(() => {
            /* the chip already renders from the task's own names */
          });
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function createTask(input: CreateTaskInput) {
    try {
      // New work is filed in the open project — under All projects there is no
      // other answer, and it is the one whose sprints and workstreams the
      // create wizard was offering.
      const next = await api.tasksCreate(primaryRoot, input);
      taskRootRef.current.set(next.id, primaryRoot);
      setTasks((prev) => [...prev, { ...next, __root: primaryRoot }]);
      setCreating(false);
      setSelectedId(next.id);
      trackFeature("task_create");
    } catch (e) {
      setError(String(e));
    }
  }

  /** Quick-add path used by the column footer row in the kanban. No
   *  modal, no template — just title + the column's status preset.
   *  Doesn't auto-open the detail panel so the user keeps adding rows
   *  without losing flow. */
  async function quickCreate(title: string, status: TaskStatus) {
    const t = title.trim();
    if (!t) return;
    try {
      const next = await api.tasksCreate(primaryRoot, { title: t, status });
      taskRootRef.current.set(next.id, primaryRoot);
      setTasks((prev) => [...prev, { ...next, __root: primaryRoot }]);
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteTask(id: string) {
    try {
      await api.tasksDelete(rootOf(id), id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch (e) {
      setError(String(e));
    }
  }

  /** Move one task to another status. This is what dragging a card between
   *  kanban lanes did; it is now the row's own status tag, so the verb outlived
   *  the drawing. Same optimistic-then-revert shape the drag had — the row
   *  moves the moment you pick, and snaps back if the write fails, so the list
   *  never shows a change that didn't persist. */
  async function setStatus(id: string, targetStatus: TaskStatus) {
    const t = tasks.find((x) => x.id === id);
    if (!t || t.status === targetStatus) return;
    const prevStatus = t.status;
    setTasks((prev) =>
      prev.map((x) => (x.id === id ? { ...x, status: targetStatus } : x)),
    );
    try {
      const root = rootOf(id);
      const next = await api.tasksUpdate(root, { id, status: targetStatus });
      setTasks((prev) =>
        prev.map((x) => (x.id === next.id ? { ...next, __root: root } : x)),
      );
    } catch (e) {
      // Inlined rather than routed via patchTask so we know the move failed
      // and can put the row back where it was.
      setTasks((prev) =>
        prev.map((x) => (x.id === id ? { ...x, status: prevStatus } : x)),
      );
      setError(String(e));
    }
  }

  /** A card dropped into a lane. The same move as picking a row's status tag in
   *  the list, so it routes through the same writer rather than keeping a
   *  second copy of the optimistic-then-revert dance. */
  async function handleDrop(targetStatus: TaskStatus) {
    if (!dragId) return;
    const id = dragId;
    setDragId(null);
    await setStatus(id, targetStatus);
  }

  if (!open) return null;

  const rootClass = embedded
    ? "h-full w-full bg-bg-content flex flex-col"
    : "absolute inset-0 z-40 bg-bg-content flex flex-col";

  return (
    <div className={rootClass}>
      {/* One bar, and no title: the rail row you clicked is lit and says Tasks,
          the workpane tab says Tasks, and the popout window's own title bar
          says Tasks. This used to print it a fourth time at 20px — the largest
          type in the app outside a dialog, spent on the one thing you already
          knew — over a second line that named the repo the rail was already
          showing and announced a grouping you could read off the headings.

          What the bar does carry is the strip: which drawing of the work you
          are on. Three cells, not the five this once had — Plan was the list
          grouped by goal, which Display now does, and Sprint was a dashboard
          about a sprint rather than a way of looking at the work. What's left
          are three genuinely different pictures, and beside them the one fact
          none of the rest of the screen states: how much of the work is on
          screen. */}
      <SurfaceHeader
        tabs={
          <>
            <WorkLensTabs lens={activeLens} onLens={chooseLens} />
            {/* How much of the work is on screen — the one thing the old page
                head said that nothing else on screen says.

                Don't assert a count we haven't got yet: on a cold open this
                read "0 items" over a body that was still loading, the only
                number on the page and wrong for as long as the fetch took. And
                when something narrows the board, count what's on it — this read
                "141 tasks" over five cards. The chips above say which filters
                are on, but picking a sprint or a workstream in the rail scopes
                the board with no chip at all, so this is the only place that
                narrowing can show. */}
            {/* Yields the row before the lens strip does. Flex shares a
                shortfall in proportion to size, so the strip — ten times this
                span's width — was giving up ten times as much: drag the place
                rail wide and the tabs collapsed to one cell while this held on
                and printed "1…", a truncated 1149 that reads as the number 1.
                Where you can go outranks how much is there, and a count that
                can't be read in full is better not drawn. */}
            <span className="min-w-0 shrink-[100] truncate text-xs text-text-5">
              {loading && tasks.length === 0
                ? "Counting…"
                : visibleTasks.length !== tasks.length
                  ? `${visibleTasks.length} of ${tasks.length} tasks`
                  : `${tasks.length} task${tasks.length === 1 ? "" : "s"}`}
            </span>
          </>
        }
        actions={
          <>
            <TasksControls
              filters={filters}
              onFilters={handleFilters}
              groupBy={groupBy}
              onGroupBy={setGroupBy}
              orderBy={orderBy}
              onOrderBy={setOrderBy}
              orderDir={orderDir}
              onOrderDir={setOrderDir}
              displayProps={displayProps}
              onDisplayProps={setDisplayProps}
              members={members}
              allLabels={allLabels}
            />
            {/* Spin this board off into its own window. The workpane has always
                passed this and the board accepted it and drew nothing, so a
                tasks tab could never be detached — even though the window it
                would open already knows how to render one, and the task detail
                inside this very board offers exactly this button. */}
            {onPopOut ? (
              <Button
                variant="subtle"
                size="icon-sm"
                onClick={onPopOut}
                title="Detach to its own window"
                aria-label="Detach to its own window"
              >
                <SquareArrowOutUpRight size={13} strokeWidth={1.75} aria-hidden />
              </Button>
            ) : null}
            <Button
              variant="accentSoft"
              size="sm"
              onClick={() => setCreating(true)}
              title="New task (n)"
            >
              <Plus className="w-3 h-3" strokeWidth={2} aria-hidden />
              New task
            </Button>
          </>
        }
      />

      {/* Error / loading */}
      {error && (
        <div className="px-4 py-2 text-sm text-red bg-red/10 border-b border-line-soft">
          {error}
        </div>
      )}

      {/* No saved-views bar. A second row of pills under the lens strip — "All
          tasks", whatever you'd named, "+ New view" — was a switcher over a
          switcher: two rows deep before the work, each answering a different
          question, neither of them the one you came to the page with. What a
          saved view held is still all here and still one click away: the rail
          narrows by goal, sprint, module and person, Filters narrows by
          anything else, and both survive a reload. */}

      {/* Why you aren't seeing everything — absent when you are. */}
      <TasksAppliedFilters
        filters={filters}
        onFilters={handleFilters}
        members={members}
      />

      {/* Body */}
      <div className="flex-1 min-h-0 flex relative">
        {/* OO.6 — the in-board 220px filter rail has been replaced by
         *  the app-level <TasksSidebar> rail that mounts in the
         *  Layout's sidebar slot (same takeover pattern PR Inbox
         *  uses). Selections from that sidebar arrive here through
         *  `tasksFilterStore` and are merged into `filters` /
         *  `selectedCycleId` / `selectedModuleId` via the effect
         *  near the top of this component. */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {!loading && tasks.length === 0 ? (
            <TasksEmptyHero
              onBlank={() => {
                setCreateInitial(null);
                setCreating(true);
              }}
              onPickTemplate={(tpl) => {
                setCreateInitial(tpl.preset);
                setCreating(true);
              }}
            />
          ) : !loading && visibleTasks.length === 0 ? (
            /* There IS work here — the current filters are hiding all of it.
               Deliberately NOT the "add your first item" state: showing that
               to someone who has thirty items and one stray filter makes them
               think they lost their work. */
            <div className="flex h-full w-full items-center justify-center">
              <BoardFilteredEmpty
                noun="tasks"
                onClear={() => {
                  setFilters({});
                  setSelectedCycleId(null);
                  setSelectedModuleId(null);
                  // Every narrowing, including the ones the rail owns —
                  // clearing "the filters" while a goal stayed lit would leave
                  // the same empty board under a button that said it fixed it.
                  clearTasksSharedFilters();
                }}
              />
            </div>
          ) : drawing === "board" ? (
            <TasksBoardView
              tasks={visibleTasks}
              members={members}
              taskStates={taskStates}
              taskLabels={taskLabels}
              loading={loading}
              groupBy={groupBy}
              displayProps={displayProps}
              focusedId={editingId ?? focusedId}
              multiSelectedIds={multiSelectedIds}
              onSelect={(id, e) =>
                handleSelect(id, {
                  newTab: e?.shiftKey,
                  multi: e?.metaKey || e?.ctrlKey,
                })
              }
              onDragStart={(id) => setDragId(id)}
              onDropOn={handleDrop}
              onQuickCreate={quickCreate}
            />
          ) : (
            <TasksListView
              tasks={visibleTasks}
              loading={loading}
              members={members}
              taskStates={taskStates}
              taskLabels={taskLabels}
              groupBy={groupBy}
              displayProps={displayProps}
              // Which goal each row belongs to, resolved by the rail off the
              // loop graph. This is the Plan view, folded into the list: the
              // plan's whole content was "these tasks, under that goal".
              goalOfTask={sharedSidebar.goalOfTask}
              selectedId={editingId ?? focusedId}
              onSelect={(id) => handleSelect(id)}
              onStatus={setStatus}
              onAddInStatus={(status) => {
                setCreateInitial({ status });
                setCreating(true);
              }}
            />
          )}
        </div>
        {/* OO.5 — bulk action bar. Anchored to the board container so
            it floats above whichever view is active. */}
        <BulkActionToolbar
          repoRoot={
            multiSelectedIds.length > 0 ? rootOf(multiSelectedIds[0]!) : primaryRoot
          }
          selectedIds={multiSelectedIds}
          taskStates={taskStates}
          taskLabels={taskLabels}
          members={members}
          onCleared={() => setMultiSelectedIds([])}
          onChanged={async () => {
            // Re-fetch the task list so state/label/assignee/archive/delete
            // mutations made by the bulk endpoints are reflected without
            // forcing the user to switch views.
            await refresh();
          }}
        />
      </div>

      {/* `?` opens the app's one cheat-sheet, the same one ⌘/ opens. The
          board used to pop a sheet of its own here, listing ten card keys
          that the ⌘/ sheet had never heard of — so the app had two answers
          to "what can I press", and the one bound to "Show all shortcuts"
          was missing a third of them. The card keys are a scoped group in
          lib/shortcuts.ts now. */}
      <ShortcutsDialog
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />

      {creating && (
        <CreateTaskWizard
          members={members}
          tasks={tasks}
          sprints={sprints}
          onCancel={() => {
            setCreating(false);
            setCreateInitial(null);
          }}
          onSubmit={async (input) => {
            await createTask(input);
            setCreateInitial(null);
          }}
          defaultAssignee={currentHandle ?? undefined}
          initial={createInitial ?? undefined}
        />
      )}

      {/* Edit task — the same full-screen wizard shell as create, in
          edit mode. Default card click opens it; submit routes through
          patchTask (api.tasksUpdate). The Activity step hosts the
          relational/discussion cards that don't fit the create model. */}
      {editingTask && (
        <CreateTaskWizard
          mode="edit"
          editing={editingTask}
          members={members}
          tasks={tasks}
          sprints={sprints}
          repoRoot={rootOf(editingTask.id)}
          currentHandle={currentHandle}
          onCancel={() => setEditingId(null)}
          onSubmit={createTask}
          onSubmitEdit={async (input) => {
            await patchTask(input);
            setEditingId(null);
          }}
          onPatch={patchTask}
          onCreateChild={createChildTask}
        />
      )}

      {/* Read-mode detail — the default card click / Enter target. Renders
          the markdown doc + metadata with no wizard tabs; its Edit button
          fires TASK_EDIT_EVENT, which promotes to the wizard above. */}
      {detailId && (
        <TaskDetailPane
          taskId={detailId}
          repoRoot={rootOf(detailId)}
          onClose={() => setDetailId(null)}
          onDetach={() =>
            openPopout({ kind: "task", root: rootOf(detailId), taskId: detailId })
          }
        />
      )}
    </div>
  );
}

// ─── Empty-state hero ──────────────────────────────────────────────────
//
// Shown only when the board has zero tasks in any column. Beats the
// blank-canvas problem: every first-time visitor sees a clear "Create
// task" CTA plus a row of template cards that pre-fill priority/labels/
// agent assignee so the second task takes ten seconds.

/**
 * The board's own empty state.
 *
 * This used to be a full marketing page: a hero, eight bordered template
 * cards, and three "feature bullet" panels explaining epics, agents and
 * sprints. All of it landed on someone who had asked for their work and been
 * shown none — the moment they are least interested in a tour.
 *
 * It's now the shared empty state plus one quiet line of templates: still the
 * fastest way to a well-formed first item, with none of the furniture. The
 * templates are plain text buttons, not cards, so the eye goes to the one
 * primary action first and finds them only if it wants a shortcut.
 */
function TasksEmptyHero({
  onBlank,
  onPickTemplate,
}: {
  onBlank: () => void;
  onPickTemplate: (tpl: TaskTemplate) => void;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto">
      <div className="w-full">
        <BoardEmpty
          icon={Inbox}
          title="No tasks yet"
          body="This is the shared board. Everything you and your agents are working on lives here, in one place."
          action={{ label: "New task", onClick: onBlank, icon: Plus }}
          footnote={
            <span className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1">
              <span className="text-text-5">Or start from</span>
              {TEMPLATES.map((t, i) => (
                <span key={t.id} className="inline-flex items-center gap-1">
                  {i > 0 && <span className="text-text-5/50">·</span>}
                  <button
                    type="button"
                    onClick={() => onPickTemplate(t)}
                    title={t.hint}
                    className="rounded-[3px] px-0.5 text-text-3 underline-offset-2 transition-colors hover:text-accent hover:underline"
                  >
                    {t.label}
                  </button>
                </span>
              ))}
            </span>
          }
        />
      </div>
    </div>
  );
}


// ─── Board ─────────────────────────────────────────────────────────────

// ─── List ──────────────────────────────────────────────────────────────

// Plane-style row. Single-line: priority dot · #id · state pill · title
// · label chips · assignees · due · updated. Mirrors the InboxPane Row
// shape so visual rhythm is consistent between Tasks list + PR Inbox.
// ─── Phase 2 filter / order helpers ────────────────────────────────────
//
// All filter dimensions are AND'd across dimensions, OR'd within. A task
// passes the filter when, for each non-empty dimension, at least one of
// the dimension's values matches the task. `q` is a case-insensitive
// substring match against title + description; empty/undefined dimensions
// are skipped entirely.

function applyFilters(
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

function applyOrder(
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
