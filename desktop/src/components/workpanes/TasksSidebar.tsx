// TasksSidebar — the wide left-rail companion to the TasksBoard
// workpane. Mounts in the app's second-rail slot when Tasks is the
// active workpane (same slot the PR Inbox uses) so it gets the full
// breathing room that the previous in-board 220px aside denied it.
//
// Visual language follows InboxSidebar (FilterItem rows: dot + label
// + count) but the content matches Plane.so's secondary nav: a header
// row, a prominent "+ New task" CTA, then sections for Your work /
// Status / Cycles / Modules.
//
// State is driven through `tasksFilterStore` (module-level shared
// store) so the TasksBoard picks up sidebar selections without needing
// React context or prop drilling.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Settings } from "lucide-react";
import {
  api,
  type Task,
  type TaskStatus,
  type Cycle,
  type Module,
} from "../../lib/api";
import {
  setTasksSharedSidebar,
  setTasksSharedCycleId,
  setTasksSharedModuleId,
  useTasksSharedFilters,
} from "../../lib/tasksFilterStore";
import { Button } from "../ui/button";

type Props = {
  repoRoot: string;
  /** Resolved git handle for the current user. Used for the "My tasks"
   *  bucket and `@me` resolution in the shared filter. */
  currentHandle?: string;
  /** Optional close handler — wired the same way InboxSidebar does it,
   *  so the user can collapse the rail back to the regular code
   *  sidebar. */
  onClose?: () => void;
  /** Fired whenever the user picks a filter / cycle / module or hits New
   *  task. The host opens/focuses the TasksBoard center pane so the
   *  selection has a visible effect even when another tab (e.g. Standup)
   *  is in front. Without this the sidebar mutates the filter store but
   *  the board never surfaces. */
  onActivate?: () => void;
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

const STATUS_ORDER: TaskStatus[] = [
  "backlog",
  "in_progress",
  "in_review",
  "done",
];

const STATUS_DOT: Record<TaskStatus, string> = {
  backlog: "bg-text-5",
  in_progress: "bg-amber-400",
  in_review: "bg-sky-400",
  done: "bg-emerald-500",
};

export function TasksSidebar({
  repoRoot,
  currentHandle,
  onClose,
  onActivate,
}: Props) {
  const shared = useTasksSharedFilters();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [t, c, m] = await Promise.all([
        api.tasksList(repoRoot).catch(() => [] as Task[]),
        api.tasksCyclesList(repoRoot).catch(() => [] as Cycle[]),
        api.tasksModulesList(repoRoot).catch(() => [] as Module[]),
      ]);
      setTasks(t);
      setCycles(c);
      setModules(m);
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    void refresh();
    // Re-poll modestly — the board itself drives its own fetches when
    // the user mutates tasks; this polls to pick up sibling edits from
    // CLI / agent runs / other clients.
    const id = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Listen for the broadcast the board fires after a successful task
  // create / patch / delete so the counts stay live without polling.
  useEffect(() => {
    const onMutate = () => void refresh();
    window.addEventListener("aura:tasks:mutated", onMutate);
    return () => window.removeEventListener("aura:tasks:mutated", onMutate);
  }, [refresh]);

  const counts = useMemo(() => {
    const out = {
      all: 0,
      mine: 0,
      unassigned: 0,
      active: 0,
      overdue: 0,
      backlog: 0,
      in_progress: 0,
      in_review: 0,
      done: 0,
    };
    const today = new Date().toISOString().slice(0, 10);
    for (const t of tasks) {
      out.all += 1;
      if (t.status === "backlog") out.backlog += 1;
      else if (t.status === "in_progress") {
        out.in_progress += 1;
        out.active += 1;
      } else if (t.status === "in_review") {
        out.in_review += 1;
        out.active += 1;
      } else if (t.status === "done") out.done += 1;
      if (
        currentHandle &&
        (t.assignee === currentHandle ||
          t.assignee_ids.includes(currentHandle))
      ) {
        out.mine += 1;
      }
      if (t.assignee_ids.length === 0 && !t.assignee) out.unassigned += 1;
      if (t.status !== "done" && t.due_date && t.due_date < today) {
        out.overdue += 1;
      }
    }
    return out;
  }, [tasks, currentHandle]);

  const f = shared.sidebar;
  const activeBucket = ((): string => {
    if (!f.status && !f.assignee) return "all";
    if (f.assignee?.includes("@me") && !f.status) return "mine";
    if (f.assignee?.includes("@unassigned") && !f.status) return "unassigned";
    if (
      f.status?.length === 2 &&
      f.status.includes("in_progress") &&
      f.status.includes("in_review")
    )
      return "active";
    if (f.status?.length === 1 && !f.assignee) return f.status[0]!;
    return "";
  })();

  function bucket(next: Partial<typeof shared.sidebar>) {
    onActivate?.();
    setTasksSharedSidebar({ ...next });
  }

  function fireNewTask() {
    // Same channel the TasksBoard's New Task button listens on. Lets
    // the sidebar's CTA pop the modal without needing direct access
    // to the board's component instance.
    onActivate?.();
    window.dispatchEvent(new CustomEvent("aura:tasks:new"));
  }

  return (
    <aside className="h-full w-full flex flex-col">
      {/* Header — 6px gutter so the New-task CTA's left edge lines up with
          the row pills below, and the title (px-2 inside) lands at the
          shared 14px content inset. */}
      <div className="px-1.5 pt-2.5 pb-3 border-b-[0.5px] border-line-soft">
        <div className="flex items-center gap-1 px-2">
          <h3 className="flex-1 text-text-1 text-[12.5px] font-semibold tracking-tight">
            Tasks
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => void refresh()}
            title="Refresh"
            aria-label="Refresh"
            className="text-text-4 hover:text-text-1"
            disabled={loading}
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
              strokeWidth={1.5}
              aria-hidden
            />
          </Button>
          {onClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              title="Close"
              aria-label="Close"
              className="text-text-4 hover:text-text-1"
            >
              ✕
            </Button>
          )}
        </div>
        <div className="mt-2.5 flex items-center gap-1.5">
          <Button
            variant="accentSoft"
            size="default"
            onClick={fireNewTask}
            className="flex-1 justify-start"
          >
            <Plus strokeWidth={2} aria-hidden />
            <span className="flex-1 text-left">New task</span>
            <span className="text-[10.5px] font-mono opacity-70">⌘N</span>
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => window.dispatchEvent(new CustomEvent("aura:open-settings"))}
            title="Task settings"
            aria-label="Task settings"
          >
            <Settings strokeWidth={1.6} aria-hidden />
          </Button>
        </div>
      </div>

      {/* Scroll body — 6px gutter so section headers + row content sit at
          14px and every active pill insets from the rail edge (no full-bleed
          highlight). */}
      <div className="flex-1 overflow-y-auto px-1.5 pb-4">
        {/* Your work */}
        <Section title="Your work">
          <FilterItem
            label="All tasks"
            count={counts.all}
            dot={null}
            active={activeBucket === "all"}
            onClick={() => bucket({})}
          />
          {currentHandle && (
            <FilterItem
              label="My tasks"
              count={counts.mine}
              dot="bg-accent-violet"
              active={activeBucket === "mine"}
              onClick={() => bucket({ assignee: ["@me"] })}
            />
          )}
          <FilterItem
            label="Assigned to me"
            count={counts.mine}
            dot="bg-sky-400"
            active={activeBucket === "mine-explicit"}
            // Same predicate as "My tasks" for now — the board treats
            // "@me" as the canonical self-bucket. Kept here as a Plane-
            // parity surface; future split (own vs delegated) lands as
            // a separate bucket id.
            onClick={() => bucket({ assignee: ["@me"] })}
          />
          <FilterItem
            label="Unassigned"
            count={counts.unassigned}
            dot="bg-text-4"
            active={activeBucket === "unassigned"}
            onClick={() => bucket({ assignee: ["@unassigned"] })}
          />
          <FilterItem
            label="Active"
            count={counts.active}
            dot="bg-amber-400"
            active={activeBucket === "active"}
            onClick={() => bucket({ status: ["in_progress", "in_review"] })}
          />
          <FilterItem
            label="Overdue"
            count={counts.overdue}
            dot="bg-rose-400"
            active={false}
            onClick={() => {
              // Overdue isn't expressible as a single TaskViewFilters
              // slice (it needs a due_date < today predicate). We
              // store it in `q` as a marker the board can intercept —
              // for now, route to Active and let the user sort by due.
              bucket({ status: ["in_progress", "in_review"] });
            }}
          />
        </Section>

        {/* Status */}
        <Section title="Status">
          {STATUS_ORDER.map((s) => (
            <FilterItem
              key={s}
              label={STATUS_LABEL[s]}
              count={counts[s]}
              dot={STATUS_DOT[s]}
              active={activeBucket === s}
              onClick={() => bucket({ status: [s] })}
            />
          ))}
        </Section>

        {/* Cycles */}
        <Section
          title="Cycles"
          empty={cycles.length === 0 ? "No cycles yet" : null}
        >
          {cycles.map((c) => (
            <FilterItem
              key={c.id}
              label={c.name}
              count={0}
              dot={c.status === "active" ? "bg-amber-400" : "bg-text-5"}
              active={shared.cycleId === c.id}
              onClick={() => {
                onActivate?.();
                setTasksSharedCycleId(shared.cycleId === c.id ? null : c.id);
              }}
            />
          ))}
        </Section>

        {/* Modules */}
        <Section
          title="Modules"
          empty={modules.length === 0 ? "No modules yet" : null}
        >
          {modules.map((m) => (
            <FilterItem
              key={m.id}
              label={m.name}
              count={0}
              dot="bg-violet-400"
              active={shared.moduleId === m.id}
              onClick={() => {
                onActivate?.();
                setTasksSharedModuleId(shared.moduleId === m.id ? null : m.id);
              }}
            />
          ))}
        </Section>
      </div>
    </aside>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="pt-1">
      {/* Shared ADE section header (matches Trace) so every section in the
          sidebar reads identically — same size, color, padding. */}
      <div className="ade-sec-h">{title}</div>
      <div className="flex flex-col gap-px">
        {children}
        {empty && (
          <div className="px-2 py-1 text-[11px] text-text-5 italic">
            {empty}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterItem({
  label,
  count,
  dot,
  active,
  onClick,
}: {
  label: string;
  count: number;
  dot: string | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // Shared ADE row (matches Trace tools) — one padding/hover/active spec
      // for every clickable sidebar row across sections.
      className={`group ade-row${active ? " active" : ""}`}
    >
      {dot !== null && (
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`}
          aria-hidden
        />
      )}
      <span className="nm">{label}</span>
      {count > 0 && (
        <span
          className={`inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 rounded-[3px] text-[10px] tabular-nums transition-colors ${
            active
              ? "bg-bg-3 text-text-2"
              : "bg-bg-0 text-text-4 group-hover:bg-bg-3"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
