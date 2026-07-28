// Right-rail "Tasks" panel — compact peek into the same task system
// that the full workpane (TasksBoard.tsx) opens via `aura:open-tasks` /
// ⌘T. Reads `.aura/tasks/tasks.json` via the `tasks_*` Tauri commands
// so what the user sees here matches the full board byte-for-byte —
// no parallel data store.
//
// Two stripes: status counts at the top (Backlog · In Progress · In
// Review · Done) and a list of the up-to-N in-flight cards. An
// "Open full board ↗" affordance fires the same event Cmd+T does so
// the user has at least three ways to land on the workpane.
//
// Distinct from the older `TeamTasksPanel`, which was the A2A
// agent-dispatch surface (cloud-backed `aura a2a-task list`). That
// panel still exists for agent-orchestration use cases — surface it
// from a dedicated rail tile if/when needed. The sidebar Tasks tab
// is now exclusively the human-task system because the user asked
// for parity with the full board.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Task, type TaskPriority, type TaskStatus } from "../../lib/api";
import { AsciiSpinner } from "../ui/ascii-spinner";

type Props = {
  repoRoot: string;
};

type Filter = "active" | "all";

const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "in_progress",
  "in_review",
]);

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

const STATUS_ORDER: TaskStatus[] = ["backlog", "in_progress", "in_review", "done"];

// OO.3 — 5-stop priority dot for the right-rail peek list. Kept on
// the simple Tailwind classnames the rail uses (matches the existing
// `bg-red / bg-amber / bg-blue` palette). `urgent` shares red with
// `high` here since the rail is too small to differentiate; users
// who care about that distinction open the full board.
const PRIORITY_DOT: Record<TaskPriority, string> = {
  urgent: "bg-red",
  high: "bg-red",
  medium: "bg-amber",
  low: "bg-blue",
  none: "bg-bg-3",
};

const MAX_PEEK = 8;

function openFullBoard() {
  window.dispatchEvent(new Event("aura:open-tasks"));
}

export function TasksSidebarPanel({ repoRoot }: Props) {
  const [rows, setRows] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("active");

  const fetch = useCallback(async () => {
    try {
      const r = await api.tasksList(repoRoot);
      setRows(r);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    void fetch();
    // Re-poll every 20s — light enough not to thrash, matches how the
    // rest of the right-rail panels (CommsPanel, etc.) self-refresh.
    const id = window.setInterval(() => void fetch(), 20_000);
    return () => window.clearInterval(id);
  }, [fetch]);

  // Status counts feed the top stripe; they always reflect the whole
  // board regardless of the Active/All filter so the user can see at a
  // glance what's parked in Backlog or Done without flipping filters.
  const counts = useMemo(() => {
    const out: Record<TaskStatus, number> = {
      backlog: 0,
      in_progress: 0,
      in_review: 0,
      done: 0,
    };
    for (const r of rows) out[r.status] += 1;
    return out;
  }, [rows]);

  const filtered = useMemo(() => {
    const next = filter === "active"
      ? rows.filter((r) => ACTIVE_STATUSES.has(r.status))
      : rows;
    // Newest first — matches what the user expects on a "what's
    // happening right now" peek; the full workpane handles richer
    // sorts (priority, due date, sprint).
    return [...next].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, [rows, filter]);

  const peek = filtered.slice(0, MAX_PEEK);
  const overflow = Math.max(0, filtered.length - peek.length);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line-soft">
        <span className="aura-block-label">TASKS</span>
        <div className="flex items-center gap-1">
          <FilterChip active={filter === "active"} onClick={() => setFilter("active")}>
            Active
          </FilterChip>
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
            All
          </FilterChip>
          <span className="w-px h-3 bg-line-soft mx-1" aria-hidden />
          <button
            type="button"
            className="t-xs t-ui text-text-4 hover:text-text-1 px-1"
            onClick={() => void fetch()}
            title="Refresh now"
          >
            ↻
          </button>
          <button
            type="button"
            className="t-xs t-ui text-text-4 hover:text-accent px-1.5 py-0.5 rounded hover:bg-accent-soft"
            onClick={openFullBoard}
            title="Open full Tasks board (⌘T)"
          >
            Open ↗
          </button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-px bg-line-soft border-b border-line-soft">
        {STATUS_ORDER.map((s) => (
          <div key={s} className="bg-bg-0 px-2 py-1.5 flex flex-col items-center">
            <span className="t-2xs text-text-4 uppercase tracking-wide">
              {STATUS_LABEL[s].split(" ")[0]}
            </span>
            <span className="text-text-1 t-sm font-medium tabular-nums">
              {counts[s]}
            </span>
          </div>
        ))}
      </div>

      <div className="relative flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-1.5">
        {loading && rows.length === 0 ? (
          <div className="t-xs t-ui text-text-4 px-2 py-1 flex items-center gap-1.5">
            <AsciiSpinner className="text-[10px]" />
            <span>Loading tasks…</span>
          </div>
        ) : peek.length === 0 ? (
          <EmptyState filter={filter} error={error} onOpenBoard={openFullBoard} />
        ) : (
          <>
            {peek.map((task) => (
              <TaskRow key={task.id} task={task} onOpenBoard={openFullBoard} />
            ))}
            {overflow > 0 && (
              <button
                type="button"
                onClick={openFullBoard}
                className="t-xs t-ui text-text-4 hover:text-accent px-2 py-1 text-left"
              >
                + {overflow} more — open full board
              </button>
            )}
          </>
        )}
        {error && peek.length > 0 && (
          <div className="t-2xs text-text-4 px-2 py-1 opacity-70" title={error}>
            Sync issue — showing last known state.
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({
  filter,
  error,
  onOpenBoard,
}: {
  filter: Filter;
  error: string | null;
  onOpenBoard: () => void;
}) {
  return (
    <div className="t-xs t-ui text-text-4 px-2 py-3 flex flex-col gap-2 items-start">
      <span>
        {filter === "active"
          ? "No in-flight tasks. Switch to All for backlog + done."
          : "No tasks yet."}
      </span>
      <button
        type="button"
        onClick={onOpenBoard}
        className="t-xs text-accent hover:underline"
      >
        Open full Tasks board ↗
      </button>
      {error && (
        <span className="t-2xs opacity-70" title={error}>
          (couldn't reach task store)
        </span>
      )}
    </div>
  );
}

function TaskRow({
  task,
  onOpenBoard,
}: {
  task: Task;
  onOpenBoard: () => void;
}) {
  // Clicking a row opens the full board — the sidebar peek doesn't
  // attempt to host the rich edit drawer, which would push it past
  // its intended visual budget.
  return (
    <button
      type="button"
      onClick={onOpenBoard}
      className="text-left flex items-start gap-2 px-2 py-1.5 rounded hover:bg-bg-2 transition-colors group"
      title={task.description || task.title}
    >
      <span
        className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${PRIORITY_DOT[task.priority]}`}
        aria-label={`${task.priority} priority`}
      />
      <div className="min-w-0 flex-1 flex flex-col">
        <span className="t-sm text-text-1 truncate">{task.title}</span>
        <div className="flex items-center gap-1.5 t-2xs text-text-4">
          <StatusPill status={task.status} />
          {task.assignee && <span className="truncate">@{task.assignee}</span>}
          {task.agent_assignee && (
            <span className="text-accent truncate">@{task.agent_assignee}</span>
          )}
          {task.due_date && (
            <span className="tabular-nums" title="Due">
              · {task.due_date}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function StatusPill({ status }: { status: TaskStatus }) {
  // Same colour vocabulary as the full board's kanban headers so the
  // sidebar reads as part of the same system, not a separate widget.
  const tone =
    status === "in_progress"
      ? "bg-accent-soft text-accent"
      : status === "in_review"
        ? "bg-pill-bg text-pill-fg"
        : status === "done"
          ? "bg-bg-2 text-text-4"
          : "bg-bg-2 text-text-4";
  return (
    <span className={`px-1.5 py-0.5 rounded t-2xs ${tone}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`t-xs t-ui px-1.5 py-0.5 rounded transition-colors ${
        active
          ? "bg-accent-soft text-accent"
          : "text-text-4 hover:text-text-1 hover:bg-bg-2"
      }`}
    >
      {children}
    </button>
  );
}
