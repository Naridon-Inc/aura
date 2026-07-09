// JIRA-style human-task tracker. Full-screen overlay above the work
// surface; backed by `<repoRoot>/.aura/tasks/tasks.json` via the
// `tasks_*` Tauri commands. Distinct from the A2A agent dispatcher
// in TeamTasksPanel — this is for humans tracking real work
// (features, bugs, chores).
//
// Layout: header (title + view toggle + "+ New") above a four-column
// kanban (Backlog / In Progress / In Review / Done). Cards click to a
// right-side detail drawer for full edit. Drag-and-drop between
// columns flips status (HTML5 drag, no extra dep).

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
  Clock,
  Timer,
  Target,
  Check,
  Plus,
  Keyboard,
  PictureInPicture2,
  List as ListIcon,
  KanbanSquare,
  GitBranch,
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
  type SprintInput,
  type TaskView,
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
import { trackFeature } from "../lib/track";
import { peekCache, writeCache } from "../lib/resourceCache";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { StatusChip } from "./ui/statusChip";
import { BoardColumnSkeleton } from "./ui/skeleton";
import { MentionedText } from "./Mentions";
import { AssigneeStack } from "./AssigneePicker";
import { CreateTaskWizard } from "./tasks/CreateTaskWizard";
import { CreateSprintWizard } from "./tasks/CreateSprintWizard";
import { CloseSprintPanel, CARRY_TO_BACKLOG } from "./tasks/CloseSprintPanel";
import { TaskDetailPane, TASK_EDIT_EVENT } from "./tasks/TaskDetailPane";
import { StatePill } from "./tasks/StatePill";
import { BulkActionToolbar } from "./tasks/BulkActionToolbar";
import {
  TasksFilterBar,
  DEFAULT_DISPLAY_PROPS,
} from "./tasks/TasksFilterBar";
import {
  TasksToolbarPill,
  TasksToolbarButton,
  TasksToolbarSep,
} from "./tasks/TasksToolbarPill";
import {
  TasksViewsBar,
  slugifyViewName,
} from "./tasks/TasksViewsBar";
import { TaskPeekOverlay } from "./tasks/TaskPeekOverlay";
import {
  useTaskShortcuts,
  TASK_SHORTCUTS,
  type TaskShortcutAction,
} from "./tasks/useTaskShortcuts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  useTasksSharedFilters,
  clearTasksSharedFilters,
} from "../lib/tasksFilterStore";
import { useEditorStore } from "../lib/editorStore";
import { openPopout } from "../lib/popout";

// The composite the board caches under `tasks:${repoRoot}` so reopening
// paints instantly (resourceCache) instead of refetching every open.
type TasksBundle = {
  tasks: Task[];
  members: TeamMember[];
  sprints: Sprint[];
  savedViews: TaskView[];
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
};

type ViewMode =
  | "board"
  | "list"
  | "sprint";

// Trimmed down to the three views that matter day-to-day: List, Board
// (kanban), and Sprint. Calendar / Gantt / Roadmap / Epics / Spread
// sheet were removed because they weren't shipping signal yet — the
// kanban + sprint surfaces already cover the planning loop, and
// re-adding the extras is cheap when there's real demand.
const VIEW_MODES: {
  id: ViewMode;
  label: string;
  Icon: typeof ListIcon;
}[] = [
  { id: "list", label: "List", Icon: ListIcon },
  { id: "board", label: "Board", Icon: KanbanSquare },
  { id: "sprint", label: "Sprint", Icon: Timer },
];

const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "in_progress", label: "In Progress" },
  { id: "in_review", label: "In Review" },
  { id: "done", label: "Done" },
];

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
  onPopOut,
}: Props) {
  // Embedded mode is always "open" — the workpane chrome controls visibility.
  const open = embedded ? true : openProp ?? false;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  // OO.3 — per-repo state + label catalogs. Loaded alongside tasks so
  // we can render Plane-style state pills and label chips off the
  // canonical catalogs instead of synthesising them from raw strings.
  const [taskStates, setTaskStates] = useState<TaskState[]>([]);
  const [taskLabels, setTaskLabels] = useState<TaskLabel[]>([]);
  // OO.4 — per-repo Cycle + Module catalogs. Mirror of taskStates/
  // taskLabels: loaded alongside tasks so the detail panel and the
  // sidebar surfaces can read off the same in-memory copy. The
  // sidebar panels also re-fetch on demand via `sidebarRefreshKey`
  // to pick up assign/unassign side effects elsewhere.
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(() => {
    try {
      // One-shot migration: list view became the Plane-style default in
      // this build. Without this nudge, every existing user keeps their
      // cached "board" preference and never sees the new UX. Bumping a
      // separate `viewMigration` key lets us flip the default exactly
      // once — anyone who actively re-picks Board after the migration
      // keeps Board on the next launch.
      const migrated = localStorage.getItem("aura.tasksBoard.viewMigration");
      if (migrated !== "list-default-v1") {
        localStorage.setItem("aura.tasksBoard.viewMigration", "list-default-v1");
        localStorage.setItem("aura.tasksBoard.view", "list");
        return "list";
      }
      const raw = localStorage.getItem("aura.tasksBoard.view") as ViewMode | null;
      const valid: ViewMode[] = ["board", "list", "sprint"];
      return raw && valid.includes(raw) ? raw : "list";
    } catch {
      return "list";
    }
  });
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
  /** When non-null, the task is rendered in the peek overlay (Shift+
   *  click) instead of the right side-panel. Mutually exclusive with
   *  `selectedId` — peek + side-panel never overlap. */
  const [peekId, setPeekId] = useState<string | null>(null);
  /** Last-focused card. Drives single-key shortcuts. Refresh on click
   *  even when we don't open the side panel (e.g. Shift+click peek). */
  const [focusedId, setFocusedId] = useState<string | null>(null);
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
  const [dragId, setDragId] = useState<string | null>(null);

  // ─── OO.2 Phase 2 — filter / group / order / display state ──────────
  //
  // Source of truth lives here. Saved views write these props out to
  // `.aura/tasks/views.json`; the *selected* view id is persisted to
  // localStorage so a refresh lands on the same slice. Filters that
  // are not part of a saved view stay in this state only — they
  // survive a tab switch but not a process restart, matching Plane.
  const [filters, setFilters] = useState<TaskViewFilters>({});
  const [groupBy, setGroupBy] = useState<TaskViewGroupBy>("status");
  const [orderBy, setOrderBy] = useState<TaskViewOrderBy>("updated");
  const [orderDir, setOrderDir] = useState<TaskViewOrderDir>("desc");
  const [displayProps, setDisplayProps] = useState<TaskViewDisplayProp[]>(
    DEFAULT_DISPLAY_PROPS,
  );
  const [savedViews, setSavedViews] = useState<TaskView[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(() => {
    try {
      return localStorage.getItem("aura.tasksBoard.activeView");
    } catch {
      return null;
    }
  });
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // OO.4 — Sidebar cycle/module selection. `null` means "no filter";
  // any other value restricts `visibleTasks` to rows whose
  // `cycle_id` / `module_id` matches. The two selectors are
  // independent — picking a cycle does NOT clear a module pick — so
  // the user can drill from "this module" → "this cycle within it".
  const [selectedCycleId, setSelectedCycleId] = useState<string | null>(null);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  /** Bumped to force `CycleSidebarPanel` / `ModuleSidebarPanel` to
   *  re-fetch after assign/unassign operations elsewhere (detail
   *  panel pickers) so member counts stay accurate. */
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);

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
    }));
  }, [sharedSidebar.sidebar.status, sharedSidebar.sidebar.assignee]);
  useEffect(() => {
    setSelectedCycleId(sharedSidebar.cycleId);
  }, [sharedSidebar.cycleId]);
  useEffect(() => {
    setSelectedModuleId(sharedSidebar.moduleId);
  }, [sharedSidebar.moduleId]);
  // When the board unmounts (user switches off the Tasks tab) clear
  // the shared store so reopening lands on a clean rail rather than
  // restoring an old bucket pick the user no longer expects.
  useEffect(() => {
    return () => clearTasksSharedFilters();
  }, []);

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

  useEffect(() => {
    try {
      if (activeViewId === null)
        localStorage.removeItem("aura.tasksBoard.activeView");
      else localStorage.setItem("aura.tasksBoard.activeView", activeViewId);
    } catch {
      /* quota — ignore */
    }
  }, [activeViewId]);

  const refresh = useCallback(async () => {
    if (!repoRoot) return;
    const key = `tasks:${repoRoot}`;
    // Cold load (nothing cached) → show the skeleton. Warm revalidate
    // keeps the seeded cards on screen while the refetch runs.
    if (!peekCache<TasksBundle>(key)) setLoading(true);
    setError(null);
    try {
      const [rows, team, sprintRows, views, stateRows, labelRows, cycleRows, moduleRows] = await Promise.all([
        api.tasksList(repoRoot),
        api.teamLoad(repoRoot).catch(() => null),
        api.sprintsList(repoRoot).catch(() => [] as Sprint[]),
        api.taskViewsList(repoRoot).catch(() => [] as TaskView[]),
        api.taskStatesList(repoRoot).catch(() => [] as TaskState[]),
        api.taskLabelsList(repoRoot).catch(() => [] as TaskLabel[]),
        api.tasksCyclesList(repoRoot).catch(() => [] as Cycle[]),
        api.tasksModulesList(repoRoot).catch(() => [] as Module[]),
      ]);
      const memberRows = team?.members ?? [];
      writeCache<TasksBundle>(key, {
        tasks: rows,
        members: memberRows,
        sprints: sprintRows,
        savedViews: views,
        taskStates: stateRows,
        taskLabels: labelRows,
        cycles: cycleRows,
        modules: moduleRows,
      });
      setTasks(rows);
      setMembers(memberRows);
      setSprints(sprintRows);
      setSavedViews(views);
      setTaskStates(stateRows);
      setTaskLabels(labelRows);
      setCycles(cycleRows);
      setModules(moduleRows);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    if (!open || !repoRoot) return;
    // Warm open: paint the last load instantly from cache, then
    // revalidate in the background so the board never flashes empty
    // (or shows a skeleton) when reopened within a session.
    const cached = peekCache<TasksBundle>(`tasks:${repoRoot}`);
    if (cached) {
      setTasks(cached.tasks);
      setMembers(cached.members);
      setSprints(cached.sprints);
      setSavedViews(cached.savedViews);
      setTaskStates(cached.taskStates);
      setTaskLabels(cached.taskLabels);
      setCycles(cached.cycles);
      setModules(cached.modules);
    }
    refresh();
  }, [open, refresh, repoRoot]);

  // OO.4 — re-fetch the cycle/module catalogs whenever a sidebar
  // panel mutates them (create/delete) or the detail panel changes
  // a task's cycle_id/module_id. We don't refresh the whole board —
  // tasks have already been updated in-place — just the catalog
  // snapshots that drive the detail-panel pickers.
  useEffect(() => {
    if (!open || sidebarRefreshKey === 0) return;
    (async () => {
      try {
        const [cycleRows, moduleRows] = await Promise.all([
          api.tasksCyclesList(repoRoot).catch(() => [] as Cycle[]),
          api.tasksModulesList(repoRoot).catch(() => [] as Module[]),
        ]);
        setCycles(cycleRows);
        setModules(moduleRows);
      } catch {
        /* sidebar surfaces show their own error state */
      }
    })();
  }, [open, repoRoot, sidebarRefreshKey]);

  // #218 — live-sync. Poll the chat rail for task mutations teammates
  // published and refetch when something landed. Invisible plumbing: no
  // UI, and the backend short-circuits to `changed:false` for solo
  // repos so the poll costs nothing there. `inFlight` collapses overlap
  // if a refetch outlasts the interval; failures (offline / no cloud)
  // fall through to the next tick.
  useEffect(() => {
    if (!open || !repoRoot) return;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const res = await api.tasksSyncPoll(repoRoot);
        if (!cancelled && res.changed) await refresh();
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
  }, [open, repoRoot, refresh]);

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

  const peeked = useMemo(
    () => (peekId ? tasks.find((t) => t.id === peekId) ?? null : null),
    [peekId, tasks],
  );
  const editingTask = useMemo(
    () => (editingId ? tasks.find((t) => t.id === editingId) ?? null : null),
    [editingId, tasks],
  );

  // Apply the active view definition once the saved-views list has
  // loaded OR whenever the user clicks a different pill. We DON'T
  // overwrite filters on every render — only when activeViewId
  // actually changes — so the user can tweak filters off a baseline
  // without losing them on rerender.
  useEffect(() => {
    if (activeViewId === null) return;
    const v = savedViews.find((x) => x.id === activeViewId);
    if (!v) return;
    setFilters(v.filters ?? {});
    setGroupBy(v.group_by);
    setOrderBy(v.order_by);
    setOrderDir(v.order_dir);
    setDisplayProps(
      v.display_props && v.display_props.length > 0
        ? v.display_props
        : DEFAULT_DISPLAY_PROPS,
    );
    if (v.layout === "board" || v.layout === "list" || v.layout === "sprint") {
      setView(v.layout);
    }
  }, [activeViewId, savedViews]);

  /** Active view as it lives in the saved list — null when the user
   *  is on "All issues" or a view was deleted out from under them. */
  const activeView = useMemo(
    () => savedViews.find((v) => v.id === activeViewId) ?? null,
    [savedViews, activeViewId],
  );

  /** Dirty bit — true when the active view's persisted shape differs
   *  from the live filter / group / order / displayProps state. */
  const activeViewDirty = useMemo(() => {
    if (!activeView) return false;
    return (
      JSON.stringify(activeView.filters ?? {}) !== JSON.stringify(filters) ||
      activeView.group_by !== groupBy ||
      activeView.order_by !== orderBy ||
      activeView.order_dir !== orderDir ||
      activeView.layout !== view ||
      JSON.stringify(activeView.display_props ?? []) !==
        JSON.stringify(displayProps)
    );
  }, [activeView, filters, groupBy, orderBy, orderDir, view, displayProps]);

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
    ],
  );

  // ── Views CRUD ─────────────────────────────────────────────────────

  async function createView(name: string) {
    const id = uniqueSlug(slugifyViewName(name), savedViews);
    try {
      const next = await api.taskViewsUpsert(repoRoot, {
        id,
        name,
        layout: view,
        filters,
        group_by: groupBy,
        order_by: orderBy,
        order_dir: orderDir,
        display_props: displayProps,
      });
      setSavedViews((prev) => [...prev, next]);
      setActiveViewId(next.id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveActiveView() {
    if (!activeView) return;
    try {
      const next = await api.taskViewsUpsert(repoRoot, {
        id: activeView.id,
        name: activeView.name,
        layout: view,
        filters,
        group_by: groupBy,
        order_by: orderBy,
        order_dir: orderDir,
        display_props: displayProps,
      });
      setSavedViews((prev) => prev.map((v) => (v.id === next.id ? next : v)));
    } catch (e) {
      setError(String(e));
    }
  }

  async function renameView(id: string, name: string) {
    try {
      const next = await api.taskViewsRename(repoRoot, id, name);
      setSavedViews((prev) => prev.map((v) => (v.id === id ? next : v)));
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteView(id: string) {
    try {
      await api.taskViewsDelete(repoRoot, id);
      setSavedViews((prev) => prev.filter((v) => v.id !== id));
      if (activeViewId === id) setActiveViewId(null);
    } catch (e) {
      setError(String(e));
    }
  }

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
        if (peekId) setPeekId(null);
        else if (detailId) setDetailId(null);
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
        // Confirm via window.confirm — the destructive flow inside the
        // detail panel already has a richer confirm; for a hot-key we
        // mirror Plane's terser confirm-then-delete pattern.
        const t = tasks.find((x) => x.id === focusedId);
        if (!t) return;
        const ok = window.confirm(
          `Delete "${t.title || "(untitled)"}"? This cannot be undone.`,
        );
        if (ok) void deleteTask(focusedId);
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
    [focusedId, peekId, selectedId, editingId, detailId, tasks],
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
      setPeekId(null);
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
    (id: string, opts?: { peek?: boolean; multi?: boolean }) => {
      // OO.5 — Cmd/Ctrl+click toggles the card into the bulk
      // selection set. The detail panel does NOT open in that mode so
      // the user can build the selection up without flickering the
      // right rail.
      if (opts?.multi) {
        setMultiSelectedIds((prev) =>
          prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
        setFocusedId(id);
        return;
      }
      setFocusedId(id);
      if (opts?.peek) {
        // Shift-click promotes to a persistent workpane tab so the
        // user can keep multiple task details open while working.
        setPeekId(null);
        setSelectedId(null);
        setEditingId(null);
        editor.openTaskDetail(id, repoRoot);
      } else {
        // Default click opens the read-mode detail pane (markdown doc +
        // metadata, no wizard tabs) — the user reads first and only sees
        // the stepped editor after pressing Edit. The peek slide-over
        // (TaskPeekOverlay) is still reachable via the keyboard shortcuts.
        setPeekId(null);
        setSelectedId(null);
        setEditingId(null);
        setDetailId(id);
      }
    },
    [editor, repoRoot],
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
      const next = await api.tasksCreate(repoRoot, {
        title: t,
        parent_id: parentId,
      });
      setTasks((prev) => [...prev, next]);
    },
    [repoRoot],
  );

  async function patchTask(input: UpdateTaskInput) {
    try {
      const next = await api.tasksUpdate(repoRoot, input);
      setTasks((prev) => prev.map((t) => (t.id === next.id ? next : t)));
      // OO.4 — When the detail panel changes cycle or module
      // membership the sidebar panels need to re-fetch so the
      // member-count chips stay accurate. Bumping the refresh key
      // is cheaper than re-mounting the whole board.
      if ("cycle_id" in input || "module_id" in input) {
        setSidebarRefreshKey((k) => k + 1);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function createTask(input: CreateTaskInput) {
    try {
      const next = await api.tasksCreate(repoRoot, input);
      setTasks((prev) => [...prev, next]);
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
      const next = await api.tasksCreate(repoRoot, { title: t, status });
      setTasks((prev) => [...prev, next]);
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteTask(id: string) {
    try {
      await api.tasksDelete(repoRoot, id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDrop(targetStatus: TaskStatus) {
    if (!dragId) return;
    const id = dragId;
    setDragId(null);
    const t = tasks.find((x) => x.id === id);
    if (!t || t.status === targetStatus) return;
    const prevStatus = t.status;
    // Optimistically move the card so the drag feels instant…
    setTasks((prev) =>
      prev.map((x) => (x.id === id ? { ...x, status: targetStatus } : x)),
    );
    try {
      const next = await api.tasksUpdate(repoRoot, { id, status: targetStatus });
      setTasks((prev) => prev.map((x) => (x.id === next.id ? next : x)));
    } catch (e) {
      // …but if the save fails, snap the card back to where it started so
      // the board never shows a move that didn't actually persist. (Inlined
      // rather than via patchTask so we know the move failed and can revert.)
      setTasks((prev) =>
        prev.map((x) => (x.id === id ? { ...x, status: prevStatus } : x)),
      );
      setError(String(e));
    }
  }

  if (!open) return null;

  const rootClass = embedded
    ? "h-full w-full bg-bg-content flex flex-col"
    : "absolute inset-0 z-40 bg-bg-content flex flex-col";

  return (
    <div className={rootClass}>
      {/* Page-head — mirrors docs/plane-app-examples.html `.page-head`:
       *    h2 title (20px / 600) + `.sub` 12px tertiary  ─ left
       *    viewbar (icon buttons) + filter icon + Display + + Add  ─ right
       *  No close X (workpane tab strip owns close), no sticky pill chrome
       *  — Plane's viewbar is a raw inline-flex strip in the header row. */}
      <div className="px-4 sm:px-6 pt-4 pb-3 border-b-[0.5px] border-line-soft flex items-start justify-between gap-3 flex-shrink-0 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-text-1 leading-tight">
            Work items
          </h2>
          <div className="text-[12px] text-text-5 mt-0.5 truncate">
            {tasks.length} item{tasks.length === 1 ? "" : "s"}
            {groupBy !== "none" && ` · grouped by ${groupBy}`}
            <span className="px-1.5 text-text-5/60">·</span>
            <span className="font-mono">{shortRepo(repoRoot)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <TasksToolbarPill>
            {VIEW_MODES.map((m) => (
              <TasksToolbarButton
                key={m.id}
                onClick={() => setView(m.id)}
                active={view === m.id}
                title={`${m.label} view`}
                ariaLabel={`${m.label} view`}
              >
                <m.Icon strokeWidth={1.5} aria-hidden />
              </TasksToolbarButton>
            ))}
          </TasksToolbarPill>
          <TasksToolbarSep />
          {onPopOut && (
            <TasksToolbarButton
              onClick={onPopOut}
              title="Pop out into a floating window"
              ariaLabel="Pop out tasks into a floating window"
            >
              <PictureInPicture2 strokeWidth={1.5} aria-hidden />
            </TasksToolbarButton>
          )}
          <TasksToolbarButton
            onClick={() => setShortcutsOpen(true)}
            title="Keyboard shortcuts (?)"
            ariaLabel="Keyboard shortcuts"
          >
            <Keyboard strokeWidth={1.5} aria-hidden />
          </TasksToolbarButton>
          <Button
            variant="accentSoft"
            size="sm"
            onClick={() => setCreating(true)}
            title="New work item (n)"
          >
            <Plus className="w-3 h-3" strokeWidth={2} aria-hidden />
            Add work item
          </Button>
        </div>
      </div>

      {/* Error / loading */}
      {error && (
        <div className="px-4 py-2 text-[11.5px] text-red-400 bg-red-500/10 border-b border-line-soft">
          {error}
        </div>
      )}

      {/* Saved Views pill row */}
      <TasksViewsBar
        views={savedViews}
        activeId={activeViewId}
        onSelect={(id) => setActiveViewId(id)}
        onCreate={createView}
        onRename={renameView}
        onDelete={deleteView}
        dirty={activeViewDirty}
        onSaveActive={saveActiveView}
      />

      {/* Filter bar (state/priority/assignee/agent/labels + group/order/display) */}
      <TasksFilterBar
        filters={filters}
        onFilters={setFilters}
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
        compact={false}
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
          {!loading &&
          tasks.length === 0 && (view === "board" || view === "list") ? (
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
          ) : view === "board" ? (
            <BoardView
              tasks={visibleTasks}
              members={members}
              taskStates={taskStates}
              taskLabels={taskLabels}
              loading={loading}
              displayProps={displayProps}
              focusedId={focusedId}
              multiSelectedIds={multiSelectedIds}
              onSelect={(id, e) =>
                handleSelect(id, {
                  peek: e?.shiftKey ?? false,
                  // Cmd on macOS / Ctrl elsewhere toggles bulk selection.
                  multi: (e?.metaKey ?? false) || (e?.ctrlKey ?? false),
                })
              }
              onDragStart={(id) => setDragId(id)}
              onDropOn={handleDrop}
              onQuickCreate={quickCreate}
            />
          ) : view === "sprint" ? (
            <SprintView
              repoRoot={repoRoot}
              tasks={tasks}
              sprints={sprints}
              members={members}
              loading={loading}
              onSelect={(id) => handleSelect(id)}
              onSprintsChanged={(next) => setSprints(next)}
              onTaskPatched={(t) =>
                setTasks((prev) => prev.map((x) => (x.id === t.id ? t : x)))
              }
              onCreate={(sprintId) => {
                setCreateInitial({ cycle_id: sprintId });
                setCreating(true);
              }}
            />
          ) : (
            <ListView
              tasks={visibleTasks}
              loading={loading}
              members={members}
              taskStates={taskStates}
              taskLabels={taskLabels}
              selectedId={editingId ?? focusedId}
              onSelect={(id) => handleSelect(id)}
              onAddInStatus={(status) => {
                setCreateInitial({ status });
                setCreating(true);
              }}
            />
          )}
        </div>
        {/* Default click now opens the Plane-style peek slide-over
            (TaskPeekOverlay), so the legacy 400px right rail is gone
            from the board surface. The Plane mockup uses peek + side
            properties grid together — see TaskPeekOverlay. */}
        {/* OO.5 — bulk action bar. Anchored to the board container so
            it floats above whichever view is active. */}
        <BulkActionToolbar
          repoRoot={repoRoot}
          selectedIds={multiSelectedIds}
          taskStates={taskStates}
          taskLabels={taskLabels}
          members={members}
          onCleared={() => setMultiSelectedIds([])}
          onChanged={async () => {
            // Re-fetch the task list so state/label/assignee/archive/delete
            // mutations made by the bulk endpoints are reflected without
            // forcing the user to switch views.
            const next = await api.tasksList(repoRoot);
            setTasks(next);
          }}
        />
        {peeked && (
          <TaskPeekOverlay
            task={peeked}
            allTasks={tasks}
            members={members}
            taskStates={taskStates}
            taskLabels={taskLabels}
            cycles={cycles}
            modules={modules}
            repoRoot={repoRoot}
            currentHandle={currentHandle}
            onClose={() => setPeekId(null)}
            onExpand={() => {
              // Mockup `expandToPage()` — close the peek and promote to
              // the full detail page (our workpane tab equivalent of the
              // mockup's `#item/<id>` route).
              setPeekId(null);
              setSelectedId(null);
              editor.openTaskDetail(peeked.id, repoRoot);
            }}
            onNavigate={(id) => setPeekId(id)}
            onPatch={patchTask}
            onDelete={() => {
              void deleteTask(peeked.id);
              setPeekId(null);
            }}
            onCreateChild={createChildTask}
          />
        )}
      </div>

      {/* Shortcuts modal (`?` to open) */}
      <ShortcutsModal
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
          repoRoot={repoRoot}
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
          repoRoot={repoRoot}
          onClose={() => setDetailId(null)}
          onDetach={() =>
            openPopout({ kind: "task", root: repoRoot, taskId: detailId })
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

function TasksEmptyHero({
  onBlank,
  onPickTemplate,
}: {
  onBlank: () => void;
  onPickTemplate: (tpl: TaskTemplate) => void;
}) {
  return (
    <div className="h-full w-full overflow-y-auto flex items-start justify-center">
      <div className="w-full max-w-3xl p-10">
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 text-text-4" aria-hidden>
            <Inbox className="w-10 h-10" strokeWidth={1.25} />
          </div>
          <div className="text-text-1 text-[18px] font-medium">
            No tasks yet
          </div>
          <div className="mt-1.5 text-text-4 text-[12.5px] max-w-md leading-snug">
            Track features, bugs, epics, AI work, and goal-linked work in
            one place. You and your AI agents share the same board.
          </div>
          <Button
            variant="accentSoft"
            size="default"
            onClick={onBlank}
            className="mt-5"
          >
            + Create blank task
          </Button>
        </div>

        <div className="mt-10">
          <div className="text-[10.5px] uppercase tracking-wider text-text-5 mb-2 pl-1">
            Or start from a template
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onPickTemplate(t)}
                className="group text-left rounded-md border border-line-soft bg-bg-2 hover:border-line hover:bg-bg-chrome p-3 transition-colors"
              >
                <div className="mb-1.5">{t.icon}</div>
                <div className="text-[12px] text-text-1 font-medium">
                  {t.label}
                </div>
                <div className="mt-0.5 text-[10.5px] text-text-4 leading-snug">
                  {t.hint}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-2 text-[10.5px] text-text-4">
          <FeatureBullet
            title="Epics + goals"
            body="Group related tasks under an epic, and link them to a goal so your roadmap stays on track."
          />
          <FeatureBullet
            title="Humans + agents"
            body="Assign a teammate, an AI (Claude / Gemini / Codex), or both — and turn any finished task into a portable proof an agent can verify."
          />
          <FeatureBullet
            title="Estimates + sprints"
            body="Add hours/points, pin to a sprint, set due dates. The roadmap view rolls everything up."
          />
        </div>
      </div>
    </div>
  );
}

function FeatureBullet({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-md border border-line-soft bg-bg-1 px-3 py-2.5">
      <div className="text-text-2 text-[11px] font-medium mb-0.5">{title}</div>
      <div className="leading-snug">{body}</div>
    </div>
  );
}


// ─── Board ─────────────────────────────────────────────────────────────

function BoardView({
  tasks,
  members,
  taskStates,
  taskLabels,
  loading,
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
  /** OO.3 — state catalog so card chips render the canonical state
   *  name + color instead of the legacy `status` enum. */
  taskStates: TaskState[];
  /** OO.3 — label catalog so card chips render label colors instead
   *  of the legacy slug-only string array. */
  taskLabels: TaskLabel[];
  loading: boolean;
  displayProps: TaskViewDisplayProp[];
  focusedId: string | null;
  /** OO.5 — ids in the bulk-selection set. Drives the per-card
   *  selected ring so the user can see what the BulkActionToolbar
   *  will target. */
  multiSelectedIds: string[];
  onSelect: (
    id: string,
    e?: { shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean },
  ) => void;
  onDragStart: (id: string) => void;
  onDropOn: (status: TaskStatus) => void;
  onQuickCreate: (title: string, status: TaskStatus) => Promise<void> | void;
}) {
  const selectedSet = new Set(multiSelectedIds);
  // Direct sub-task count per task id — drives the light branch chip on
  // cards that parent other tasks. A child points back via `parent_id`
  // (or the legacy `epic_id`). Computed once over the visible set.
  const childCounts = new Map<string, number>();
  for (const t of tasks) {
    const parent = t.parent_id ?? t.epic_id;
    if (parent) childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
  }
  return (
    <div className="h-full w-full overflow-x-auto overflow-y-hidden">
      <div className="h-full min-w-full flex gap-2 p-3">
        {COLUMNS.map((col, colIndex) => {
          const colTasks = tasks.filter((t) => t.status === col.id);
          return (
            <div
              key={col.id}
              className="w-[280px] flex-shrink-0 flex flex-col rounded-[8px] bg-bg-2/50 border-[0.5px] border-line-soft"
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e) => {
                e.preventDefault();
                onDropOn(col.id);
              }}
            >
              <div className="px-3 py-2.5 flex items-center gap-2 border-b-[0.5px] border-line-soft">
                <span className="inline-flex items-center gap-1.5 font-medium text-[13px] text-text-1">
                  <StateRing statusId={col.id} />
                  {col.label}
                </span>
                <span className="ml-auto text-[11px] text-text-3 tabular-nums">
                  {colTasks.length}
                </span>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {loading && colTasks.length === 0 && (
                  <BoardColumnSkeleton count={colIndex === 0 ? 3 : 2} />
                )}
                {colTasks.map((t) => (
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
                    onClick={(e) =>
                      onSelect(t.id, {
                        shiftKey: e.shiftKey,
                        metaKey: e.metaKey,
                        ctrlKey: e.ctrlKey,
                      })
                    }
                    onDragStart={() => onDragStart(t.id)}
                  />
                ))}
              </div>
              <ColumnQuickAdd
                status={col.id}
                onCreate={(title) => onQuickCreate(title, col.id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Subtle `+ New issue` footer baked into every kanban column. Click
 * expands to an inline input; Enter commits with the column's status
 * baked in; Esc cancels.
 *
 * Tab moves to the next column's input — implemented by setting a
 * stable `data-quick-add-status` so we can `querySelector` the next
 * focusable input without lifting state out. Wraps from the last
 * column back to the first.
 */
function ColumnQuickAdd({
  status,
  onCreate,
}: {
  status: TaskStatus;
  onCreate: (title: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  async function commit() {
    const t = title.trim();
    if (!t) return;
    setBusy(true);
    try {
      await onCreate(t);
      setTitle("");
      // Keep the input open so the user can keep adding cards in
      // rapid succession. Mirrors Plane's UX.
    } finally {
      setBusy(false);
    }
  }

  function focusSibling(dir: 1 | -1) {
    const ids: TaskStatus[] = ["backlog", "in_progress", "in_review", "done"];
    const idx = ids.indexOf(status);
    const nextIdx = (idx + dir + ids.length) % ids.length;
    const next = ids[nextIdx];
    const el = document.querySelector<HTMLInputElement>(
      `input[data-quick-add-status="${next}"]`,
    );
    if (el) {
      // The sibling input might be collapsed; click to expand first.
      const wrapper = el.closest("[data-quick-add-root]");
      const btn = wrapper?.querySelector<HTMLButtonElement>(
        "button[data-quick-add-trigger]",
      );
      btn?.click();
      // Defer focus so the input has time to mount/expand.
      setTimeout(() => {
        const fresh = document.querySelector<HTMLInputElement>(
          `input[data-quick-add-status="${next}"]`,
        );
        fresh?.focus();
      }, 0);
    }
  }

  return (
    <div className="border-t border-line-soft p-1.5" data-quick-add-root>
      {!open ? (
        <button
          type="button"
          data-quick-add-trigger
          onClick={() => setOpen(true)}
          className="w-full text-left text-[11px] text-text-5 hover:text-text-2 hover:bg-bg-content px-2 py-1 rounded transition-colors flex items-center gap-1"
        >
          <Plus className="w-3 h-3" strokeWidth={1.5} aria-hidden />
          New issue
        </button>
      ) : (
        <div className="flex gap-1">
          <Input
            autoFocus
            type="text"
            value={title}
            data-quick-add-status={status}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
                setTitle("");
              } else if (e.key === "Tab") {
                e.preventDefault();
                focusSibling(e.shiftKey ? -1 : 1);
              }
            }}
            onBlur={() => {
              if (!title.trim()) setOpen(false);
            }}
            placeholder="Title — Enter to add"
            className="flex-1 min-w-0"
          />
        </div>
      )}
    </div>
  );
}

function TaskCard({
  task,
  members,
  taskStates,
  taskLabels,
  displayProps,
  childCount = 0,
  focused = false,
  selected = false,
  onClick,
  onDragStart,
}: {
  task: Task;
  members: TeamMember[];
  /** Direct sub-task count — renders a light branch chip in the card
   *  footer when > 0. Defaults to 0 (chip hidden) for callers that
   *  don't yet compute it. */
  childCount?: number;
  /** OO.3 — optional state catalog so the card can render a Plane-
   *  style state pill alongside the priority dot. Undefined in
   *  callers that don't yet plumb it (sprint columns); the pill
   *  silently drops out in that case. */
  taskStates?: TaskState[];
  /** OO.3 — optional label catalog so chips render with the catalog
   *  color instead of the legacy grey-on-grey slug bubble. */
  taskLabels?: TaskLabel[];
  /** Display-prop set from the active view. When undefined, fall back
   *  to the default set so callers that don't yet plumb the prop
   *  (sprint columns, epics view) keep working. */
  displayProps?: TaskViewDisplayProp[];
  focused?: boolean;
  /** OO.5 — card is in the bulk-action selection set. Draws an
   *  accent border + ring so the user can scan the picked rows. */
  selected?: boolean;
  onClick: (e: {
    shiftKey: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
  }) => void;
  onDragStart: () => void;
}) {
  // `props` set — falls back to the default when the caller passes
  // nothing. Using a Set is O(1) per check inside the JSX below.
  const props = useMemo(
    () => new Set<TaskViewDisplayProp>(displayProps ?? DEFAULT_DISPLAY_PROPS),
    [displayProps],
  );
  const showId = props.has("id");
  const showAssignee = props.has("assignee");
  const showAgent = props.has("agent");
  const showDue = props.has("due");
  const showLabels = props.has("labels");
  const showEstimate = props.has("estimate");
  const showPr = props.has("pr");

  // Resolved custom state (Plane-style pill) — falls back to the
  // status ring when the catalog isn't plumbed or the task has no
  // custom state.
  const state =
    taskStates && task.state_id
      ? (taskStates.find((s) => s.id === task.state_id) ?? null)
      : null;

  // Footer meta items, gated by their displayProps, rendered through a
  // single quiet chip so every item shares one size/colour/icon scale.
  const overdue = showDue && task.due_date != null && isOverdue(task.due_date);
  const metaItems: ReactNode[] = [];
  if (showDue && task.due_date) {
    metaItems.push(
      <CardMeta
        key="due"
        icon={Clock}
        muted={overdue ? "rose" : undefined}
        title={`Due ${task.due_date}`}
      >
        {formatDueDate(task.due_date)}
      </CardMeta>,
    );
  }
  if (showEstimate && task.estimate != null) {
    metaItems.push(
      <CardMeta key="est" title="Estimate">
        {task.estimate} pts
      </CardMeta>,
    );
  }
  if (showAgent && task.agent_assignee) {
    metaItems.push(
      <CardMeta key="agent" icon={Bot} title={`Agent: ${task.agent_assignee}`}>
        {task.agent_assignee}
      </CardMeta>,
    );
  }
  if (showPr && task.linked_pr) {
    metaItems.push(
      <CardMeta key="pr" mono title={task.linked_pr.url}>
        #{task.linked_pr.number}
      </CardMeta>,
    );
  }
  if (childCount > 0) {
    metaItems.push(
      <CardMeta
        key="children"
        icon={GitBranch}
        title={`${childCount} sub-task${childCount === 1 ? "" : "s"}`}
      >
        {childCount}
      </CardMeta>,
    );
  }
  if (task.bead_id) {
    metaItems.push(
      <CardMeta key="bead" mono title={`Linked A2A bead ${task.bead_id}`}>
        bead
      </CardMeta>,
    );
  }

  // Assignee slot — sits on the right of the footer via `ml-auto`. Pre-
  // computed so an empty footer (no meta, no assignee) drops out cleanly.
  let assigneeSlot: ReactNode = null;
  if (showAssignee && task.assignee_ids.length > 0) {
    assigneeSlot = (
      <span className="ml-auto flex-shrink-0" title={task.assignee_ids.join(", ")}>
        <AssigneeStack
          handles={task.assignee_ids}
          members={members}
          dense
          maxAvatars={3}
        />
      </span>
    );
  } else if (showAssignee && task.assignee) {
    assigneeSlot = (
      <span
        className="ml-auto text-[10.5px] text-text-3 tabular-nums"
        title={`Assigned to ${task.assignee}`}
      >
        @{task.assignee}
      </span>
    );
  }

  const hasFooter = metaItems.length > 0 || assigneeSlot != null;

  return (
    <div
      role="button"
      tabIndex={0}
      data-task-id={task.id}
      // macOS WKWebView suppresses the synthetic `click` on `draggable=true`
      // elements (it begins drag-tracking on mousedown and never dispatches the
      // click), which left task cards intermittently un-openable. Open on
      // mousedown (left button only); a real drag still fires onDragStart. The
      // selection modifiers are read off the same event, present on mousedown.
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        onClick({
          shiftKey: e.shiftKey,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
        });
      }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", task.id);
        onDragStart();
      }}
      className={`flex flex-col gap-1.5 rounded-[6px] bg-bg-content border px-2.5 py-2 text-left cursor-pointer transition-all ${
        selected
          ? "border-accent ring-2 ring-accent/60 bg-accent/[0.04]"
          : focused
          ? "border-accent ring-1 ring-accent/40"
          : "border-line-soft hover:border-line"
      }`}
      style={{ boxShadow: "var(--shadow-raised-100)" }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "var(--shadow-raised-200)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "var(--shadow-raised-100)";
      }}
    >
      {/* Header — priority signal · id (quiet) · state (right) */}
      <div className="flex items-center gap-1.5">
        <PrioritySignal priority={task.priority} />
        {showId && <TaskIdChip sequenceId={task.sequence_id} />}
        <span className="ml-auto flex items-center" title={state?.name}>
          {state ? <StatePill state={state} dense /> : <StateRing statusId={task.status} />}
        </span>
      </div>

      {/* Title — 13px, two-line clamp */}
      <div className="text-[13px] text-text-1 leading-snug line-clamp-2">
        <MentionedText text={task.title || "(untitled)"} members={members} />
      </div>

      {/* Labels — one unified quiet chip style, capped + overflow */}
      {showLabels && task.labels.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {task.labels.slice(0, 3).map((l) => {
            const catalogEntry = taskLabels?.find(
              (cl) => cl.name === l || cl.id === l,
            );
            const color = catalogEntry?.color;
            const name = catalogEntry?.name ?? l;
            return (
              <span
                key={l}
                className="inline-flex items-center gap-1 text-[10.5px] text-text-3 px-[6px] py-px rounded-[4px] bg-bg-1"
                title={name}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: color ?? "var(--color-text-4)" }}
                  aria-hidden
                />
                <span className="truncate max-w-[104px]">{name}</span>
              </span>
            );
          })}
          {task.labels.length > 3 && (
            <span
              className="text-[10.5px] text-text-4 tabular-nums px-[2px]"
              title={task.labels.slice(3).join(", ")}
            >
              +{task.labels.length - 3}
            </span>
          )}
        </div>
      )}

      {/* Footer — one muted meta cluster + avatars (right) */}
      {hasFooter && (
        <div className="flex items-center gap-x-2.5 gap-y-1 flex-wrap text-text-3">
          {metaItems}
          {assigneeSlot}
        </div>
      )}
    </div>
  );
}

// ─── Card meta chip ────────────────────────────────────────────────────
//
// One quiet style shared by every footer item (due / estimate / agent /
// PR / sub-tasks / bead) so the card reads as a single muted row rather
// than a grab-bag of competing chrome. No backgrounds, no per-item
// colour: same 10.5px text, same w-3 icon, tabular-nums throughout. The
// only colour the footer ever carries is an overdue due-date (rose).
function CardMeta({
  icon: Icon,
  children,
  title,
  mono = false,
  muted,
}: {
  icon?: typeof Clock;
  children: ReactNode;
  title?: string;
  mono?: boolean;
  muted?: "rose";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10.5px] tabular-nums whitespace-nowrap ${
        muted === "rose" ? "text-rose-400" : "text-text-3"
      } ${mono ? "font-mono" : ""}`}
      title={title}
    >
      {Icon && <Icon className="w-3 h-3 flex-shrink-0" strokeWidth={1.5} aria-hidden />}
      {children}
    </span>
  );
}

// ─── Task identifier chip ──────────────────────────────────────────────
//
// Plane.so-style monospace handle ("AURA-42") rendered top-left on each
// card and reused in the detail panel. Click-to-copy with a transient
// "copied" tooltip — stopPropagation so the click doesn't also open the
// detail drawer (and the inner span is keyboard-reachable). Falls back
// silently when sequence_id is 0 (legacy rows that haven't been healed
// yet — see `backfill_sequence_ids` on the Rust side).
export function TaskIdChip({
  sequenceId,
  className,
}: {
  sequenceId: number;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!sequenceId || sequenceId <= 0) return null;
  const label = `AURA-${sequenceId}`;
  const copy = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    try {
      void navigator.clipboard.writeText(label);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard rejected (rare in Tauri webview) — leave UI quiet.
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "Copied" : `Copy ${label}`}
      aria-label={copied ? "Copied" : `Copy ${label}`}
      className={
        className ??
        "font-mono text-[10px] tracking-tight text-text-5 hover:text-text-2 hover:bg-bg-2 px-1 py-0 rounded leading-4 transition-colors"
      }
    >
      {copied ? "copied" : label}
    </button>
  );
}

// ─── List ──────────────────────────────────────────────────────────────

function ListView({
  tasks,
  loading,
  members,
  taskStates,
  taskLabels,
  selectedId,
  onSelect,
  onAddInStatus,
}: {
  tasks: Task[];
  loading: boolean;
  members: TeamMember[];
  taskStates: TaskState[];
  taskLabels: TaskLabel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddInStatus: (status: TaskStatus) => void;
}) {
  // Plane-style list: tasks grouped by status into collapsible sections
  // (mirrors the PR Inbox triage pattern in InboxPane.tsx — chevron
  // toggle + sticky group headers + dense row with id/title/labels/
  // assignees/due/updated). Order matches COLUMNS so the visual flow
  // reads top-to-bottom Backlog → Done.
  const [collapsed, setCollapsed] = useState<Set<TaskStatus>>(new Set());

  const grouped = useMemo(() => {
    const out: Record<TaskStatus, Task[]> = {
      backlog: [],
      in_progress: [],
      in_review: [],
      done: [],
    };
    for (const t of tasks) {
      const bucket = (out[t.status] ?? out.backlog)!;
      bucket.push(t);
    }
    return out;
  }, [tasks]);

  function toggle(id: TaskStatus) {
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
        <div className="py-6 text-[12px] text-text-5">Loading…</div>
      )}
      {!loading && tasks.length === 0 && (
        <div className="py-6 text-[12px] text-text-5 italic">
          No tasks yet. Click <span className="text-text-3">+ Add work item</span> to
          create the first one.
        </div>
      )}
      {tasks.length > 0 &&
        COLUMNS.map((col) => {
          const rows = grouped[col.id] ?? [];
          // Hide empty groups for "in_review" + "done" to keep the
          // surface focused on active work. Backlog + In Progress stay
          // even when empty so the user always sees the canonical
          // pipeline top-of-view.
          if (rows.length === 0 && (col.id === "in_review" || col.id === "done")) {
            return null;
          }
          const expanded = !collapsed.has(col.id);
          return (
            <ListSection
              key={col.id}
              statusId={col.id}
              label={col.label}
              count={rows.length}
              expanded={expanded}
              onToggle={() => toggle(col.id)}
              rows={rows}
              members={members}
              taskStates={taskStates}
              taskLabels={taskLabels}
              selectedId={selectedId}
              onSelect={onSelect}
              onAdd={() => onAddInStatus(col.id)}
            />
          );
        })}
    </div>
  );
}

// Plane `.group-head` + `.issue-list` per docs/plane-app-examples.html.
// Row: chev + state ring + title + count + spacer + "+ Add" ghost button.
// List body: continuous 0.5px hairline rows. Footer: "+ Add work item"
// inline pill (only rendered when expanded).
function ListSection({
  statusId,
  label,
  count,
  expanded,
  onToggle,
  rows,
  members,
  taskStates,
  taskLabels,
  selectedId,
  onSelect,
  onAdd,
}: {
  statusId: TaskStatus;
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  rows: Task[];
  members: TeamMember[];
  taskStates: TaskState[];
  taskLabels: TaskLabel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="pb-1">
      <div className="sticky top-0 z-10 flex items-center gap-2.5 px-1 pt-[10px] pb-2 bg-bg-content/95 backdrop-blur">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-2.5 flex-1 min-w-0 hover:opacity-80 transition-opacity"
          title={expanded ? "Collapse" : "Expand"}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 10 10"
            className={`text-text-5 transition-transform flex-shrink-0 ${
              expanded ? "" : "-rotate-90"
            }`}
            aria-hidden
          >
            <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" />
          </svg>
          <StateRing statusId={statusId} />
          <span className="text-[13px] text-text-1 font-medium">{label}</span>
          <span className="text-[12px] text-text-5 tabular-nums">{count}</span>
        </button>
        <button
          type="button"
          onClick={onAdd}
          title={`Add work item to ${label}`}
          className="inline-flex items-center justify-center w-5 h-5 rounded-[4px] text-text-5 hover:text-text-1 hover:bg-bg-2 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
        </button>
      </div>
      {expanded && rows.length > 0 && (
        <div>
          {rows.map((t) => (
            <ListRow
              key={t.id}
              task={t}
              selected={t.id === selectedId}
              members={members}
              taskStates={taskStates}
              taskLabels={taskLabels}
              onSelect={() => onSelect(t.id)}
            />
          ))}
        </div>
      )}
      {expanded && (
        <button
          type="button"
          onClick={onAdd}
          className="w-full text-left flex items-center gap-2 px-1 py-2 text-[12px] text-text-5 hover:text-text-2 border-t-[0.5px] border-line-soft transition-colors"
        >
          <Plus className="w-3 h-3" strokeWidth={1.5} aria-hidden />
          <span>Add work item</span>
        </button>
      )}
    </div>
  );
}

// Plane `.signal` — 3-bar priority icon. 1:1 with the mockup spec:
// bars are 2.5px wide, heights 4/8/12px, gap 1.5px, aligned flex-end in a
// 14px box. Every bar is `currentColor` (the priority token); lit bars are
// full-opacity, unlit fade to 0.25. Urgent is a filled red chip with all
// three bars white. See docs/plane-app-examples.html `.signal`.
const PRIORITY_TOKEN: Record<TaskPriority, string> = {
  urgent: "var(--color-pri-urgent)",
  high: "var(--color-pri-high)",
  medium: "var(--color-pri-medium)",
  low: "var(--color-pri-low)",
  none: "var(--color-pri-none)",
};

function PrioritySignal({ priority }: { priority: TaskPriority }) {
  const bars = (color: string, urgent = false) => (
    <>
      <i
        className="block w-[2.5px] h-[4px] rounded-[1px]"
        style={{ background: color, opacity: urgent || priority !== "none" ? 1 : 0.25 }}
      />
      <i
        className="block w-[2.5px] h-[8px] rounded-[1px]"
        style={{
          background: color,
          opacity:
            urgent || priority === "high" || priority === "medium" ? 1 : 0.25,
        }}
      />
      <i
        className="block w-[2.5px] h-[12px] rounded-[1px]"
        style={{ background: color, opacity: urgent || priority === "high" ? 1 : 0.25 }}
      />
    </>
  );

  if (priority === "urgent") {
    return (
      <span
        className="inline-flex items-end gap-[1.5px] h-4 px-1 py-px rounded-[4px] flex-shrink-0"
        style={{ background: PRIORITY_TOKEN.urgent }}
        title="Priority: Urgent"
        aria-label="Urgent priority"
      >
        {bars("#fff", true)}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-end gap-[1.5px] h-[14px] flex-shrink-0"
      style={{ color: PRIORITY_TOKEN[priority] }}
      title={`Priority: ${priority}`}
      aria-label={`${priority} priority`}
    >
      {bars(PRIORITY_TOKEN[priority])}
    </span>
  );
}

// Plane `.state-pill .ring-i` — 11px circle with stroke style keyed to
// status. Dashed for backlog/cancelled, conic for in_progress/in_review,
// solid disc for done.
function StateRing({ statusId }: { statusId: TaskStatus }) {
  const cls = (() => {
    switch (statusId) {
      case "backlog":
        return "border-dashed border-[1.5px] border-text-4";
      case "in_progress":
        return "border-[1.5px] border-amber-400 bg-[conic-gradient(theme(colors.amber.400)_50%,transparent_50%)]";
      case "in_review":
        return "border-[1.5px] border-sky-400 bg-[conic-gradient(theme(colors.sky.400)_75%,transparent_75%)]";
      case "done":
        return "border-[1.5px] border-emerald-500 bg-emerald-500";
      default:
        return "border-[1.5px] border-text-4";
    }
  })();
  return (
    <span
      className={`w-[12px] h-[12px] rounded-full box-border flex-shrink-0 ${cls}`}
      aria-hidden
    />
  );
}

// Plane-style row. Single-line: priority dot · #id · state pill · title
// · label chips · assignees · due · updated. Mirrors the InboxPane Row
// shape so visual rhythm is consistent between Tasks list + PR Inbox.
function ListRow({
  task,
  selected,
  members,
  taskStates,
  taskLabels,
  onSelect,
}: {
  task: Task;
  selected: boolean;
  members: TeamMember[];
  taskStates: TaskState[];
  taskLabels: TaskLabel[];
  onSelect: () => void;
}) {
  const state =
    taskStates && task.state_id
      ? (taskStates.find((s) => s.id === task.state_id) ?? null)
      : null;

  // Labels — keep the chip count modest in dense rows. Slice early so
  // wide rows never explode horizontally past the assignees + due.
  const labelChips = task.labels.slice(0, 3).map((l) => {
    const catalog = taskLabels.find((cl) => cl.name === l || cl.id === l);
    return { key: l, name: catalog?.name ?? l, color: catalog?.color };
  });

  return (
    <button
      type="button"
      onClick={onSelect}
      data-task-id={task.id}
      className={`w-full text-left flex items-center gap-3 px-1 py-[9px] border-t-[0.5px] border-line-soft text-[13px] hover:bg-bg-2 transition-colors ${
        selected ? "bg-bg-2" : ""
      }`}
    >
      <PrioritySignal priority={task.priority} />
      <StateRing statusId={task.status} />
      <span
        className="text-[11px] text-text-5 font-mono flex-shrink-0 w-20 tabular-nums"
        style={{ letterSpacing: "0.02em" }}
        title={state ? `State: ${state.name}` : undefined}
      >
        AURA-{task.sequence_id}
      </span>
      <span className="flex-1 min-w-0 text-text-1 truncate">
        <MentionedText text={task.title || "(untitled)"} members={members} />
      </span>
      <span className="flex items-center gap-1.5 flex-shrink-0">
        {labelChips.length > 0 &&
          labelChips.map((l) => (
            <span
              key={l.key}
              className="inline-flex items-center gap-1 text-[10px] px-[7px] py-px rounded-full bg-bg-1 border-[0.5px] border-line-soft whitespace-nowrap"
              style={{ color: l.color ?? "var(--color-text-3)" }}
              title={l.name}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: l.color ?? "currentColor" }}
                aria-hidden
              />
              <span className="truncate max-w-[80px]">{l.name}</span>
            </span>
          ))}
        {task.due_date && (
          <span
            className={`flex-shrink-0 text-[11px] tabular-nums px-1 ${
              isOverdue(task.due_date) ? "text-rose-400" : "text-text-3"
            }`}
            title={`Due ${task.due_date}`}
          >
            {formatDueDate(task.due_date)}
          </span>
        )}
        {task.assignee_ids.length > 0 && (
          <span className="flex-shrink-0" title={task.assignee_ids.join(", ")}>
            <AssigneeStack
              handles={task.assignee_ids}
              members={members}
              dense
              maxAvatars={3}
            />
          </span>
        )}
      </span>
    </button>
  );
}

// ─── Sprint view ───────────────────────────────────────────────────────
//
// Slices tasks down to the currently-active sprint and renders three
// columns (Todo / Doing / Done) plus a count-based burndown. Sprints
// are the unified Cycle store (`.aura/tasks/task_cycles.json`), surfaced
// here through the legacy `Sprint`-shaped shim; membership rides
// `Task.cycle_id`. If none exists, the user can spin up a default
// 2-week sprint with one click.
//
// Burndown uses estimate points when every task in the sprint has an
// `estimate`; otherwise it falls back to task count so a fresh repo
// still shows a real chart instead of an empty box.

function SprintView({
  repoRoot,
  tasks,
  sprints,
  members,
  loading,
  onSelect,
  onSprintsChanged,
  onTaskPatched,
  onCreate,
}: {
  repoRoot: string;
  tasks: Task[];
  sprints: Sprint[];
  members: TeamMember[];
  loading: boolean;
  onSelect: (id: string) => void;
  onSprintsChanged: (next: Sprint[]) => void;
  onTaskPatched: (t: Task) => void;
  onCreate: (sprintId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** When true, the full-screen CreateSprintWizard is open. */
  const [creatingSprint, setCreatingSprint] = useState(false);
  /** When true, the full-screen CloseSprintPanel (complete-sprint) is open. */
  const [closingSprint, setClosingSprint] = useState(false);

  // Pick the active sprint by default, or the one the user clicked.
  // Falls back to the most recently-updated sprint if no active flag.
  const effective = useMemo(() => {
    if (selectedId) {
      const found = sprints.find((s) => s.id === selectedId);
      if (found) return found;
    }
    return sprints.find((s) => s.active) ?? sprints[0] ?? null;
  }, [sprints, selectedId]);

  const sprintTasks = useMemo(() => {
    if (!effective) return [] as Task[];
    // Membership rides the unified Cycle pointer post-BEAD-I. `effective`
    // is the legacy-shaped projection of a cycle, so `effective.id` is
    // the cycle id stored on `Task.cycle_id`.
    return tasks.filter((t) => t.cycle_id === effective.id && !t.is_epic);
  }, [tasks, effective]);

  // Backlog candidates the planner can pull into a sprint — unbound,
  // non-epic tasks. Hoisted so both the empty-state and the active-sprint
  // render can hand it to the create wizard's Scope step.
  const backlogCandidates = useMemo(
    () => tasks.filter((t) => !t.is_epic && (t.cycle_id == null || t.cycle_id === "")),
    [tasks],
  );

  // Burndown — if every task has an estimate, sum estimates; else count.
  const usePoints =
    sprintTasks.length > 0 && sprintTasks.every((t) => typeof t.estimate === "number" && t.estimate! > 0);
  const totalWork = usePoints
    ? sprintTasks.reduce((n, t) => n + (t.estimate ?? 0), 0)
    : sprintTasks.length;
  const doneWork = usePoints
    ? sprintTasks
        .filter((t) => t.status === "done")
        .reduce((n, t) => n + (t.estimate ?? 0), 0)
    : sprintTasks.filter((t) => t.status === "done").length;
  const remainingWork = totalWork - doneWork;

  const burndown = useMemo(() => {
    if (!effective || sprintTasks.length === 0) return [] as { date: string; remaining: number }[];
    return buildBurndownSeries(effective, sprintTasks, usePoints);
  }, [effective, sprintTasks, usePoints]);

  // Per-assignee capacity rollup. Tasks with multiple assignees are
  // attributed to each of them (full count, not split) — matches how
  // teams reason about "what's on my plate" rather than fractional load.
  // Unassigned tasks roll into a synthetic "unassigned" bucket so they
  // stay visible (a sprint with 8 unassigned tasks is a planning smell).
  const capacity = useMemo(() => {
    if (!effective || sprintTasks.length === 0) return [];
    const buckets = new Map<
      string,
      { handle: string; total: number; done: number }
    >();
    for (const t of sprintTasks) {
      const ids = t.assignee_ids && t.assignee_ids.length > 0
        ? t.assignee_ids
        : t.assignee
        ? [t.assignee]
        : ["unassigned"];
      const weight = usePoints ? t.estimate ?? 0 : 1;
      const isDone = t.status === "done";
      for (const handle of ids) {
        const cur = buckets.get(handle) ?? { handle, total: 0, done: 0 };
        cur.total += weight;
        if (isDone) cur.done += weight;
        buckets.set(handle, cur);
      }
    }
    return Array.from(buckets.values()).sort((a, b) => b.total - a.total);
  }, [sprintTasks, usePoints, effective]);

  // Scope creep — tasks created after the sprint started. Heuristic but
  // catches the common "we kept dragging stuff in mid-sprint" pattern.
  const scopeCreep = useMemo(() => {
    if (!effective) return [] as Task[];
    const startUnix = Date.parse(`${effective.start}T00:00:00Z`);
    if (Number.isNaN(startUnix)) return [];
    return sprintTasks.filter((t) => {
      const created = Date.parse(t.created_at);
      return Number.isFinite(created) && created > startUnix;
    });
  }, [effective, sprintTasks]);

  // At-risk — unfinished tasks that have had no movement in N days.
  // Reuses the AuraWatch nudge vocabulary (a quiet amber dot), not a new
  // alarm. We don't have per-status-change timestamps, so `updated_at` is
  // the staleness proxy the design doc (§4) explicitly allows. Done tasks
  // are never at-risk; a sprint that hasn't started yet (day index < 1)
  // suppresses the signal so a freshly-planned board isn't all amber.
  const atRiskIds = useMemo(() => {
    const out = new Set<string>();
    if (!effective || sprintDayIndex(effective) < 1) return out;
    const now = Date.now();
    for (const t of sprintTasks) {
      if (t.status === "done") continue;
      const moved = Date.parse(t.updated_at);
      if (!Number.isFinite(moved)) continue;
      if (now - moved > STALE_TASK_MS) out.add(t.id);
    }
    return out;
  }, [effective, sprintTasks]);

  // Past sprints with their final delivered work — used to render a
  // "velocity" trend sparkline. A sprint that was deliberately closed has
  // its throughput frozen on the cycle (`s.velocity`, phase 4); prefer
  // that stable figure so moving done tasks afterwards can't drift the
  // trend. Sprints that ended without a formal Close fall back to deriving
  // delivered work from their still-attached done tasks. Quietly drops the
  // currently-selected sprint so the trend reads "sprints before this one".
  const velocity = useMemo(() => {
    if (!effective) return [] as { id: string; name: string; delivered: number; usePoints: boolean }[];
    return sprints
      .filter(
        (s) =>
          s.id !== effective.id &&
          (s.velocity != null || s.end < ymd(new Date())),
      )
      .map((s) => {
        if (s.velocity != null) {
          // Frozen at Close — we can't know after the fact whether it was
          // points or counts, but the number is the source of truth.
          return { id: s.id, name: s.name, delivered: s.velocity, usePoints: false };
        }
        const ts = tasks.filter((t) => t.cycle_id === s.id && !t.is_epic);
        const useP =
          ts.length > 0 && ts.every((t) => typeof t.estimate === "number" && t.estimate! > 0);
        const delivered = useP
          ? ts.filter((t) => t.status === "done").reduce((n, t) => n + (t.estimate ?? 0), 0)
          : ts.filter((t) => t.status === "done").length;
        return { id: s.id, name: s.name, delivered, usePoints: useP };
      })
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(-6);
  }, [sprints, tasks, effective]);

  // Real sprint-create — wired to the wizard's onSubmit. Persists via
  // `api.sprintsCreate` ({ id, name, start, end, goal, active }); when the
  // new sprint is flagged active we clear the flag on every other sprint
  // locally so the switcher reflects the single-active invariant the
  // backend enforces. `scopeTaskIds` are the backlog tasks the planner
  // chose to pull in — each is assigned to the new cycle (mirroring both
  // sides) and patched into local state optimistically.
  async function submitSprint(input: SprintInput, scopeTaskIds: string[]) {
    setBusy(true);
    setErr(null);
    try {
      const next = await api.sprintsCreate(repoRoot, input);
      for (const taskId of scopeTaskIds) {
        try {
          await api.tasksCycleAssign(repoRoot, next.id, taskId);
          const t = tasks.find((x) => x.id === taskId);
          if (t) onTaskPatched({ ...t, cycle_id: next.id });
        } catch (e) {
          setErr(String(e));
        }
      }
      const others = sprints.filter((s) => s.id !== next.id);
      onSprintsChanged([
        ...(next.active ? others.map((s) => ({ ...s, active: false })) : others),
        next,
      ]);
      setSelectedId(next.id);
      setCreatingSprint(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function setActive(id: string) {
    const target = sprints.find((s) => s.id === id);
    if (!target) return;
    setBusy(true);
    setErr(null);
    try {
      const updated = await api.sprintsUpdate(repoRoot, {
        id: target.id,
        name: target.name,
        start: target.start,
        end: target.end,
        goal: target.goal,
        active: true,
      });
      const next = sprints.map((s) =>
        s.id === updated.id ? updated : { ...s, active: false },
      );
      onSprintsChanged(next);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function detachTask(taskId: string) {
    if (!effective) return;
    const current = tasks.find((t) => t.id === taskId);
    try {
      // Use the dedicated unassign so the cycle's `task_ids` mirror stays
      // in sync (a bare `tasksUpdate` clears the pointer but defers the
      // catalog mirror). Patch local state optimistically.
      await api.tasksCycleUnassign(repoRoot, effective.id, taskId);
      if (current) onTaskPatched({ ...current, cycle_id: null });
    } catch (e) {
      setErr(String(e));
    }
  }

  // Close the sprint (doc 23 §3d). Moves every unfinished item to the
  // chosen destination (a planned sprint, or back to the backlog when
  // `target === CARRY_TO_BACKLOG`), freezes the delivered figure as the
  // cycle's `velocity`, and flips status to completed. Done items keep
  // their `cycle_id`, so the historical sprint still reads its delivered
  // scope. The velocity we record is `doneWork` — already points-or-count
  // depending on whether the sprint was estimated.
  async function closeSprint(target: string) {
    if (!effective) return;
    setBusy(true);
    setErr(null);
    try {
      const carried = sprintTasks.filter((t) => t.status !== "done");
      for (const t of carried) {
        if (target === CARRY_TO_BACKLOG) {
          await api.tasksCycleUnassign(repoRoot, effective.id, t.id);
          onTaskPatched({ ...t, cycle_id: null });
        } else {
          await api.tasksCycleAssign(repoRoot, target, t.id);
          onTaskPatched({ ...t, cycle_id: target });
        }
      }
      await api.tasksCycleClose(repoRoot, effective.id, doneWork);
      // Reflect the close locally: this sprint is no longer active and now
      // carries its frozen velocity; the others are untouched.
      onSprintsChanged(
        sprints.map((s) =>
          s.id === effective.id
            ? { ...s, active: false, velocity: doneWork }
            : s,
        ),
      );
      setClosingSprint(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading && sprints.length === 0) {
    return <div className="p-6 text-[12px] text-text-5">Loading sprints…</div>;
  }

  if (sprints.length === 0) {
    return (
      <div className="h-full w-full overflow-y-auto flex items-start justify-center">
        <div className="w-full max-w-xl p-10 text-center">
          <div className="mb-3 flex justify-center text-text-4" aria-hidden>
            <Timer className="w-10 h-10" strokeWidth={1.25} />
          </div>
          <div className="text-text-1 text-[18px] font-medium">No sprints yet</div>
          <div className="mt-1.5 text-text-4 text-[12.5px] max-w-md mx-auto leading-snug">
            Sprints are 1–2 week iterations stored at{" "}
            <code className="font-mono text-[11.5px] text-text-3">
              .aura/tasks/task_cycles.json
            </code>
            . Spin up a default fortnight to start.
          </div>
          <Button
            variant="accentSoft"
            size="default"
            onClick={() => setCreatingSprint(true)}
            disabled={busy}
            className="mt-5"
          >
            Start a 2-week sprint
          </Button>
          {err && <div className="mt-3 text-[11.5px] text-rose-400">{err}</div>}
        </div>
        {creatingSprint && (
          <CreateSprintWizard
            onCancel={() => setCreatingSprint(false)}
            onSubmit={submitSprint}
            backlog={backlogCandidates}
          />
        )}
      </div>
    );
  }

  if (!effective) return null;

  const candidates = backlogCandidates;

  const todoTasks = sprintTasks.filter((t) => t.status === "backlog");
  const doingTasks = sprintTasks.filter(
    (t) => t.status === "in_progress" || t.status === "in_review",
  );
  const doneTasks = sprintTasks.filter((t) => t.status === "done");

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="px-4 py-3 border-b border-line-soft flex items-center flex-wrap gap-2">
        <Select
          value={effective.id}
          onChange={(v) => setSelectedId(v)}
          options={sprints.map((s) => ({
            value: s.id,
            label: `${s.name}${s.active ? "  ★" : ""}`,
          }))}
          aria-label="Select sprint"
        />
        <span className="text-[11px] text-text-4 font-mono">
          {effective.start} → {effective.end}
        </span>
        <span className="text-[11px] text-text-5">
          day {sprintDayIndex(effective)} / {sprintLengthDays(effective)}
        </span>
        {sprintTasks.length > 0 && (
          <span
            className="text-[11px] text-text-4 tabular-nums px-1.5 py-0.5 rounded bg-bg-2 border border-line-soft"
            title="Scope delivered so far"
          >
            {doneWork} / {totalWork} {usePoints ? "pts" : "tasks"} done
          </span>
        )}
        {!effective.active && effective.velocity == null && (
          <Button
            type="button"
            variant="subtle"
            size="xs"
            disabled={busy}
            onClick={() => setActive(effective.id)}
          >
            Make active
          </Button>
        )}
        {effective.velocity != null ? (
          <StatusChip tone="green" dense icon={<Check className="w-2.5 h-2.5" />}>
            Completed · {effective.velocity} velocity
          </StatusChip>
        ) : (
          <Button
            type="button"
            variant="subtle"
            size="xs"
            disabled={busy}
            onClick={() => setClosingSprint(true)}
          >
            Complete sprint
          </Button>
        )}
        <div className="flex-1" />
        <Button
          variant="subtle"
          size="xs"
          onClick={() => setCreatingSprint(true)}
        >
          + New sprint
        </Button>
        <Button
          variant="accentSoft"
          size="xs"
          onClick={() => onCreate(effective.id)}
        >
          + Task in sprint
        </Button>
      </div>

      {effective.goal && (
        <div className="px-4 py-2 text-[12px] text-text-3 border-b border-line-soft bg-bg-1 flex items-center gap-1.5">
          <Target className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
          <span>{effective.goal}</span>
        </div>
      )}

      {err && (
        <div className="px-4 py-2 text-[11.5px] text-rose-400 bg-rose-500/10 border-b border-line-soft">
          {err}
        </div>
      )}

      {/* Burndown — compact SVG sparkline, ideal vs actual */}
      <div className="px-4 py-3 border-b border-line-soft">
        <div className="flex items-baseline gap-3 mb-2">
          <span className="text-[11px] uppercase tracking-wider text-text-5">
            Burndown
          </span>
          <span className="text-[11px] text-text-3 tabular-nums">
            {remainingWork} / {totalWork} {usePoints ? "pts" : "tasks"} remaining
          </span>
          {scopeCreep.length > 0 && (
            <StatusChip
              tone="amber"
              dense
              icon={<AlertTriangle className="w-2.5 h-2.5" />}
              title={
                scopeCreep
                  .slice(0, 8)
                  .map((t) => `· ${t.title}`)
                  .join("\n") +
                (scopeCreep.length > 8 ? `\n+ ${scopeCreep.length - 8} more` : "")
              }
            >
              +{scopeCreep.length} added mid-sprint
            </StatusChip>
          )}
          <div className="flex-1" />
          {velocity.length > 0 && (
            <VelocitySparkline data={velocity} />
          )}
        </div>
        {sprintTasks.length === 0 ? (
          <div className="text-[11.5px] text-text-5 italic">
            No tasks pinned to this sprint yet.
          </div>
        ) : (
          <Burndown series={burndown} total={totalWork} usePoints={usePoints} />
        )}
      </div>

      {/* Capacity — per-assignee load. Renders only when the sprint has
         tasks so an empty new sprint doesn't show a blank box. */}
      {capacity.length > 0 && (
        <div className="px-4 py-3 border-b border-line-soft">
          <div className="flex items-baseline gap-3 mb-2">
            <span className="text-[11px] uppercase tracking-wider text-text-5">
              Capacity
            </span>
            <span className="text-[10.5px] text-text-5">
              {capacity.length} assignee{capacity.length === 1 ? "" : "s"}
            </span>
          </div>
          <CapacityBars
            rows={capacity}
            members={members}
            usePoints={usePoints}
          />
        </div>
      )}

      {/* Three lightweight columns. Reuses TaskCard so cards look the
         same as the Board view. */}
      <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <SprintColumn
          label="Todo"
          tasks={todoTasks}
          members={members}
          atRisk={atRiskIds}
          onSelect={onSelect}
          onDetach={detachTask}
        />
        <SprintColumn
          label="In flight"
          tasks={doingTasks}
          members={members}
          atRisk={atRiskIds}
          onSelect={onSelect}
          onDetach={detachTask}
        />
        <SprintColumn
          label="Done"
          tasks={doneTasks}
          members={members}
          atRisk={atRiskIds}
          onSelect={onSelect}
          onDetach={detachTask}
        />
      </div>

      {/* Drawer of un-pinned tasks the user can pull in. */}
      {candidates.length > 0 && (
        <div className="px-4 pb-6">
          <div className="text-[11px] uppercase tracking-wider text-text-5 mb-2">
            Pull into sprint
          </div>
          <div className="flex flex-wrap gap-1.5">
            {candidates.slice(0, 30).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={async () => {
                  try {
                    // Dedicated assign keeps `cycle.task_ids` in sync;
                    // patch local state optimistically on the cycle pointer.
                    await api.tasksCycleAssign(repoRoot, effective.id, t.id);
                    onTaskPatched({ ...t, cycle_id: effective.id });
                  } catch (e) {
                    setErr(String(e));
                  }
                }}
                title={t.title}
                className="text-[10.5px] px-2 py-0.5 rounded-full bg-bg-2 border border-line-soft text-text-3 hover:text-text-1 hover:bg-bg-chrome max-w-[240px] truncate"
              >
                + {t.title || "(untitled)"}
              </button>
            ))}
            {candidates.length > 30 && (
              <span className="text-[10.5px] text-text-5 self-center">
                + {candidates.length - 30} more in backlog…
              </span>
            )}
          </div>
        </div>
      )}

      {creatingSprint && (
        <CreateSprintWizard
          onCancel={() => setCreatingSprint(false)}
          onSubmit={submitSprint}
          backlog={backlogCandidates}
        />
      )}

      {closingSprint && (
        <CloseSprintPanel
          sprint={effective}
          doneCount={doneTasks.length}
          donePoints={doneWork}
          totalCount={sprintTasks.length}
          totalPoints={totalWork}
          usePoints={usePoints}
          carriedCount={sprintTasks.length - doneTasks.length}
          carryTargets={sprints.filter(
            (s) => s.id !== effective.id && s.velocity == null,
          )}
          onCancel={() => setClosingSprint(false)}
          onConfirm={closeSprint}
        />
      )}
    </div>
  );
}

function CapacityBars({
  rows,
  members,
  usePoints,
}: {
  rows: { handle: string; total: number; done: number }[];
  members: TeamMember[];
  usePoints: boolean;
}) {
  // Peak across all rows so every bar is normalised to the same scale —
  // makes "Alice has 8x what Bob has" visually obvious.
  const peak = Math.max(1, ...rows.map((r) => r.total));
  const byHandle = useMemo(
    () => new Map(members.map((m) => [m.handle, m])),
    [members],
  );
  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const member = byHandle.get(r.handle);
        const label =
          r.handle === "unassigned"
            ? "Unassigned"
            : member?.name || `@${r.handle}`;
        const donePct = r.total === 0 ? 0 : (r.done / r.total) * 100;
        const widthPct = (r.total / peak) * 100;
        return (
          <div key={r.handle} className="flex items-center gap-2 text-[11px]">
            <span
              className={`w-24 truncate ${
                r.handle === "unassigned" ? "text-text-5 italic" : "text-text-2"
              }`}
              title={label}
            >
              {label}
            </span>
            <div className="flex-1 h-2 bg-bg-2 rounded overflow-hidden relative">
              <div
                className="h-2 bg-accent/40"
                style={{ width: `${widthPct}%` }}
              />
              <div
                className="absolute inset-y-0 left-0 h-2 bg-emerald-400/60"
                style={{ width: `${(widthPct * donePct) / 100}%` }}
              />
            </div>
            <span className="w-20 text-right text-text-4 tabular-nums">
              {r.done}/{r.total} {usePoints ? "pts" : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function VelocitySparkline({
  data,
}: {
  data: { id: string; name: string; delivered: number; usePoints: boolean }[];
}) {
  const peak = Math.max(1, ...data.map((d) => d.delivered));
  return (
    <div
      className="flex items-end gap-0.5 h-6"
      title={
        "Velocity (last sprints): " +
        data.map((d) => `${d.name}=${d.delivered}`).join(" · ")
      }
    >
      {data.map((d) => (
        <div
          key={d.id}
          className="w-1.5 bg-accent/60 rounded-t"
          style={{ height: `${(d.delivered / peak) * 100}%` }}
        />
      ))}
      <span className="ml-1 text-[10px] text-text-5 self-center">
        velocity
      </span>
    </div>
  );
}

function SprintColumn({
  label,
  tasks,
  members,
  atRisk,
  onSelect,
  onDetach,
}: {
  label: string;
  tasks: Task[];
  members: TeamMember[];
  /** Task ids flagged stale by the at-risk heuristic — rendered with a
   *  quiet amber dot. Empty set ⇒ no dots (e.g. the Done column). */
  atRisk: Set<string>;
  onSelect: (id: string) => void;
  onDetach: (id: string) => void;
}) {
  const riskCount = tasks.reduce((n, t) => n + (atRisk.has(t.id) ? 1 : 0), 0);
  return (
    <div className="rounded-md bg-bg-2 border border-line-soft min-h-[200px] flex flex-col">
      <div className="px-3 py-2 border-b border-line-soft flex items-center gap-2">
        <span className="text-[11.5px] font-medium text-text-2">{label}</span>
        <span className="text-[10.5px] text-text-5 font-mono">{tasks.length}</span>
        {riskCount > 0 && (
          <span
            className="ml-auto flex items-center gap-1 text-[10px] text-amber-400/80"
            title={`${riskCount} task${riskCount === 1 ? "" : "s"} with no movement in ${STALE_TASK_MS / 86_400_000} days`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400/80" aria-hidden />
            {riskCount} stalled
          </span>
        )}
      </div>
      <div className="flex-1 p-2 space-y-2">
        {tasks.length === 0 && (
          <div className="text-[11px] text-text-5 px-1 italic">Empty</div>
        )}
        {tasks.map((t) => (
          <div key={t.id} className="relative group">
            {atRisk.has(t.id) && (
              <span
                className="absolute -top-1 -left-1 z-10 w-2 h-2 rounded-full bg-amber-400/80 ring-2 ring-bg-2"
                title="No movement in a while — at risk of slipping the sprint"
                aria-label="At risk"
              />
            )}
            <TaskCard
              task={t}
              members={members}
              onClick={() => onSelect(t.id)}
              onDragStart={() => {
                /* sprint columns don't drive status drag-and-drop */
              }}
              displayProps={DEFAULT_DISPLAY_PROPS}
            />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDetach(t.id);
              }}
              title="Remove from sprint"
              className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-[10px] text-text-5 hover:text-text-1 px-1 rounded bg-bg-2 border border-line-soft"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Burndown({
  series,
  total,
  usePoints,
}: {
  series: { date: string; remaining: number }[];
  total: number;
  usePoints: boolean;
}) {
  // Inline SVG sparkline: ideal line (linear total→0) + actual stepped line.
  const W = 480;
  const H = 80;
  const PAD_X = 28;
  const PAD_Y = 10;
  const n = series.length;
  if (n < 2 || total === 0) {
    return (
      <div className="text-[11px] text-text-5 italic">
        Series needs ≥2 days and a non-zero total.
      </div>
    );
  }
  const xAt = (i: number) => PAD_X + (i * (W - PAD_X * 2)) / (n - 1);
  const yAt = (v: number) =>
    PAD_Y + ((total - v) / total) * (H - PAD_Y * 2);

  const idealPath = `M ${xAt(0)} ${yAt(total)} L ${xAt(n - 1)} ${yAt(0)}`;
  const actualPath = series
    .map((s, i) => `${i === 0 ? "M" : "L"} ${xAt(i)} ${yAt(s.remaining)}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      role="img"
      aria-label="Sprint burndown"
    >
      {/* axis */}
      <line
        x1={PAD_X}
        y1={H - PAD_Y}
        x2={W - PAD_X}
        y2={H - PAD_Y}
        stroke="currentColor"
        strokeOpacity="0.15"
      />
      <line
        x1={PAD_X}
        y1={PAD_Y}
        x2={PAD_X}
        y2={H - PAD_Y}
        stroke="currentColor"
        strokeOpacity="0.15"
      />
      <text
        x={4}
        y={PAD_Y + 4}
        fontSize="9"
        fill="currentColor"
        fillOpacity="0.5"
      >
        {total}
      </text>
      <text
        x={4}
        y={H - PAD_Y + 4}
        fontSize="9"
        fill="currentColor"
        fillOpacity="0.5"
      >
        0
      </text>
      {/* ideal */}
      <path d={idealPath} stroke="currentColor" strokeOpacity="0.25" strokeDasharray="3 3" fill="none" />
      {/* actual */}
      <path d={actualPath} stroke="rgb(96,165,250)" strokeWidth="1.5" fill="none" />
      {/* today marker */}
      {(() => {
        const today = ymd(new Date());
        const idx = series.findIndex((s) => s.date === today);
        if (idx < 0) return null;
        return (
          <circle
            cx={xAt(idx)}
            cy={yAt(series[idx].remaining)}
            r="3"
            fill="rgb(96,165,250)"
          />
        );
      })()}
      <title>{`Burndown — ${usePoints ? "story points" : "task count"}`}</title>
    </svg>
  );
}


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
  return tasks.filter((t) => {
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

/** Ensure the slug we pass to `task_views_upsert` doesn't collide with
 *  an existing view's id — when it would, append `-2`, `-3`, etc. */
function uniqueSlug(slug: string, views: TaskView[]): string {
  if (!views.some((v) => v.id === slug)) return slug;
  let n = 2;
  while (views.some((v) => v.id === `${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

// ─── Shortcuts modal ───────────────────────────────────────────────────

function ShortcutsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[440px] bg-bg-chrome border-line-soft text-text-1">
        <DialogHeader>
          <DialogTitle className="text-[14px]">Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="text-[12px] text-text-3 mb-2">
          Available when a task card is focused (click one to focus it).
        </div>
        <ul className="space-y-1">
          {TASK_SHORTCUTS.map((s) => (
            <li
              key={s.keys}
              className="flex items-center justify-between text-[12px]"
            >
              <span className="text-text-2">{s.label}</span>
              <kbd className="font-mono text-[10.5px] bg-bg-2 border border-line-soft px-1.5 py-0.5 rounded text-text-1">
                {s.keys}
              </kbd>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

// ─── helpers ───────────────────────────────────────────────────────────

function shortRepo(p: string): string {
  if (!p) return "";
  const segs = p.split("/").filter(Boolean);
  return segs.length <= 2 ? p : `…/${segs.slice(-2).join("/")}`;
}

function isOverdue(due: string): boolean {
  // Compare YYYY-MM-DD lexically against today's local date — cheaper
  // than parsing, immune to timezone edge cases at midnight.
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  return due < `${y}-${m}-${d}`;
}

function formatDueDate(due: string): string {
  // YYYY-MM-DD → "May 23" or "today" / "tomorrow" for the next two days.
  const d = new Date(due + "T00:00:00");
  if (isNaN(d.getTime())) return due;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffMs = d.getTime() - today.getTime();
  const diffDays = Math.round(diffMs / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays === -1) return "yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ─── date math (sprint + gantt) ────────────────────────────────────────

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(yyyymmdd: string, n: number): string {
  const d = new Date(yyyymmdd + "T00:00:00");
  d.setDate(d.getDate() + n);
  return ymd(d);
}

function daysBetweenInclusive(a: string, b: string): number {
  // a and b are YYYY-MM-DD; returns the inclusive day count (a==b → 1).
  const da = new Date(a + "T00:00:00").getTime();
  const db = new Date(b + "T00:00:00").getTime();
  if (isNaN(da) || isNaN(db) || db < da) return 1;
  return Math.round((db - da) / 86_400_000) + 1;
}

/** Staleness threshold for the at-risk amber dot: a sprint task with no
 *  `updated_at` movement in this window reads as drifting. Three days is
 *  the AuraWatch nudge cadence — long enough to ignore a quiet weekend,
 *  short enough to flag a stalled card inside a 1–2 week sprint. */
const STALE_TASK_MS = 3 * 86_400_000;

function sprintLengthDays(s: Sprint): number {
  return daysBetweenInclusive(s.start, s.end);
}

function sprintDayIndex(s: Sprint): number {
  const today = ymd(new Date());
  if (today < s.start) return 0;
  if (today > s.end) return sprintLengthDays(s);
  return daysBetweenInclusive(s.start, today);
}

/**
 * Build the burndown series day-over-day across the sprint range.
 * Remaining work on day D = total - work done by end of D (work is
 * "done" if status === done AND updated_at <= end-of-D). Falls back to
 * raw counts when `usePoints` is false. Days past today are blank in
 * the chart by sharing the last-known-remaining value (no future
 * extrapolation).
 */
function buildBurndownSeries(
  sprint: Sprint,
  tasks: Task[],
  usePoints: boolean,
): { date: string; remaining: number }[] {
  const totalUnits = usePoints
    ? tasks.reduce((n, t) => n + (t.estimate ?? 0), 0)
    : tasks.length;
  if (totalUnits === 0) return [];
  const today = ymd(new Date());
  const series: { date: string; remaining: number }[] = [];
  const lengthDays = sprintLengthDays(sprint);
  let lastRemaining = totalUnits;
  for (let i = 0; i < lengthDays; i++) {
    const day = addDays(sprint.start, i);
    if (day > today) {
      series.push({ date: day, remaining: lastRemaining });
      continue;
    }
    const cutoff = day + "T23:59:59";
    const doneUnits = tasks.reduce((n, t) => {
      if (t.status !== "done") return n;
      if (!t.updated_at || t.updated_at > cutoff) return n;
      return n + (usePoints ? t.estimate ?? 0 : 1);
    }, 0);
    lastRemaining = totalUnits - doneUnits;
    series.push({ date: day, remaining: lastRemaining });
  }
  return series;
}
