// SubTasksPanel — the rich, Jira-style Sub-tasks surface for WIDE
// contexts (the full-page task detail's main column + the edit
// wizard's dedicated Sub-tasks step). Where the compact
// <SubIssuesCard> is the right density for the 300/400px rail, this
// component is a proper table: a header with a count + add button, a
// thin progress bar, quiet column headers (Work / Priority / Status /
// Assignee) and calm single-line rows. Status is an inline dropdown
// that patches the child task on the spot; clicking a row's title
// opens that sub-task's detail.
//
// Data: mirrors <SubIssuesCard>'s fetch — `api.tasksSubtree` returns
// the root + every descendant depth-first; we drop the root and
// compute each row's depth client-side by walking `parent_id` up to
// the current task. A small `aura:tasks:mutated` listener keeps the
// surface live when a sibling edit / status change lands elsewhere.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, ListTree, Plus } from "lucide-react";
import { BoardEmpty } from "../board";
import { api, type Task, type TaskStatus, type TeamMember } from "../../lib/api";
import { fetchTeam } from "../../lib/teamCache";
import { useEditorStore } from "../../lib/editorStore";
import { AssigneeStack } from "../AssigneePicker";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../../lib/utils";
import { TASK_COLUMNS } from "./taskColumns";
import { TASK_PRIORITY_LABEL, TaskPriorityBars, TaskStateRing } from "./taskGlyphs";
import { TaskIdChip } from "./TaskIdChip";
import { percent } from "../../lib/percent";

// The status set comes from `TASK_COLUMNS` — the same four lanes the board
// draws and the same groups the list draws. This used to be a local copy
// "so the panel doesn't reach into TasksBoard's internals"; that reason is
// gone now the pipeline lives in its own module, and a local copy could only
// ever drift.
const STATUS_OPTIONS = TASK_COLUMNS;

type SubTaskRow = { task: Task; depth: number };

export function SubTasksPanel({
  task,
  allTasks,
  repoRoot,
  onCreateChild,
  onOpenChild,
  readOnly = false,
  embedded = false,
}: {
  task: Task;
  allTasks: Task[];
  repoRoot: string;
  onCreateChild?: (parentId: string, title: string) => Promise<void>;
  /** When set, a row click routes into the host's own sub-task surface
   *  (the detail pane's Sub-tasks tab) instead of stacking a fresh
   *  full-screen detail overlay. Falls back to opening a new overlay. */
  onOpenChild?: (childId: string) => void;
  readOnly?: boolean;
  /** Rendered inside a context that already labels it (the wizard's
   *  "Sub-tasks" step heading, or the detail pane's "Sub-tasks" tab).
   *  Drops the panel's own "Sub-tasks" header + collapse toggle so the
   *  title isn't written twice — the Add affordance rides the progress
   *  row instead, and the table is always expanded. */
  embedded?: boolean;
}) {
  const editor = useEditorStore();
  const [subtree, setSubtree] = useState<Task[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await api.tasksSubtree(repoRoot, task.id);
      // Drop the root — it's the current task; the panel lists its
      // descendants only.
      setSubtree(rows.filter((r) => r.id !== task.id));
    } catch (e) {
      setError(String(e));
    }
  }, [repoRoot, task.id]);

  // Resolve handles → names/colours for the assignee avatars. Members
  // are non-essential; an empty list just renders raw-handle initials.
  useEffect(() => {
    let alive = true;
    fetchTeam(repoRoot)
      .then((team) => {
        if (alive) setMembers(team?.members ?? []);
      })
      .catch(() => {
        if (alive) setMembers([]);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh, allTasks]);

  // The board broadcasts `aura:tasks:mutated` after every write; refetch
  // so an inline status change here (or a sibling edit elsewhere) keeps
  // the table — and its progress bar — honest.
  useEffect(() => {
    const onMutate = () => void refresh();
    window.addEventListener("aura:tasks:mutated", onMutate);
    return () => window.removeEventListener("aura:tasks:mutated", onMutate);
  }, [refresh]);

  // Build {task, depth} rows. The subtree is flat depth-first; depth is
  // recovered by walking `parent_id` pointers up to `task.id`.
  const rows = useMemo<SubTaskRow[]>(() => {
    const byId = new Map(allTasks.map((t) => [t.id, t]));
    const depthOf = (node: Task): number => {
      let d = 0;
      let cur: Task | undefined = node;
      while (cur && cur.parent_id && cur.parent_id !== task.id) {
        cur = byId.get(cur.parent_id);
        d += 1;
        if (d > 12) break; // pathological guard
      }
      return d;
    };
    return subtree.map((t) => ({ task: t, depth: depthOf(t) }));
  }, [subtree, allTasks, task.id]);

  const total = rows.length;
  const doneCount = rows.filter((r) => r.task.status === "done").length;
  const pct = percent(doneCount, total);

  const canCreate = !readOnly && typeof onCreateChild === "function";

  const submitChild = async () => {
    const next = draft.trim();
    if (!next || creating || !onCreateChild) return;
    setCreating(true);
    setError(null);
    try {
      await onCreateChild(task.id, next);
      setDraft("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const changeStatus = useCallback(
    async (childId: string, status: TaskStatus) => {
      setError(null);
      try {
        await api.tasksUpdate(repoRoot, { id: childId, status });
        // Let every other task surface know so they re-read; our own
        // listener picks this up and refreshes the table too.
        window.dispatchEvent(new CustomEvent("aura:tasks:mutated"));
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [repoRoot, refresh],
  );

  const openChild = useCallback(
    (childId: string) => {
      // Prefer routing into a host's own sub-tasks surface (the detail
      // pane's Sub-tasks tab) over stacking a fresh full-screen overlay.
      if (onOpenChild) onOpenChild(childId);
      else editor.openTaskDetail(childId, repoRoot);
    },
    [editor, repoRoot, onOpenChild],
  );

  const expanded = embedded || !collapsed;

  const addButton = canCreate ? (
    <Button
      variant="outline"
      size="xs"
      onClick={() => setAdding(true)}
      className="gap-1 text-xs text-text-3 hover:text-text-1 shrink-0"
      title="Add a sub-task"
    >
      <Plus className="w-3 h-3" strokeWidth={2} aria-hidden />
      Add
    </Button>
  ) : null;

  return (
    <section aria-label="Sub-tasks">
      {/* Header — chevron + title + count on the left; add button on the
          right (hidden when read-only or no create handler). Suppressed in
          `embedded` mode: a tab/step heading already names the surface, so
          the Add button rides the progress row instead. */}
      {!embedded && (
      <header className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="inline-flex items-center gap-1.5 text-text-2 hover:text-text-1 transition-colors"
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronRight className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
          )}
          <span className="text-base font-semibold tracking-tight">
            Sub-tasks
          </span>
          {total > 0 && (
            <span className="text-xs text-text-5 tabular-nums">{total}</span>
          )}
        </button>
        <div className="ml-auto flex items-center gap-1.5">{addButton}</div>
      </header>
      )}

      {/* Progress bar — % of sub-tasks done. Only meaningful with rows. In
          embedded mode the Add button rides the end of this row (the header
          that normally carries it is hidden). */}
      {total > 0 && (
        <div className={cn("flex items-center gap-3", embedded ? "" : "mt-2.5")}>
          <div className="h-1.5 flex-1 rounded-full bg-bg-3 overflow-hidden">
            <div
              className="h-full rounded-full bg-accent-green transition-[width] duration-300"
              style={{ width: `${pct}%` }}
              aria-hidden
            />
          </div>
          <span className="text-xs text-text-4 tabular-nums shrink-0">
            {pct}% Done
          </span>
          {embedded && addButton}
        </div>
      )}

      {expanded && (
        <div className="mt-3">
          {total === 0 ? (
            <div className="py-1">
              <BoardEmpty
                icon={ListTree}
                title="No sub-tasks yet"
                body="Break this into smaller pieces when it's too big to finish in one go. Each piece can be handed to a different person or agent."
                size="sm"
                action={
                  canCreate && !adding
                    ? {
                        label: "Add sub-task",
                        onClick: () => setAdding(true),
                        icon: Plus,
                      }
                    : undefined
                }
              />
            </div>
          ) : (
            <div className="rounded-lg border border-line-soft overflow-hidden">
              {/* Quiet column-header row. */}
              <div className="section-label flex items-center h-7 px-3 bg-bg-2/40 border-b border-line-soft">
                <span className="flex-1 min-w-0">Work</span>
                <span className="w-[110px] shrink-0">Priority</span>
                <span className="w-[120px] shrink-0">Status</span>
                <span className="w-[52px] shrink-0 text-right">Assignee</span>
              </div>
              <div>
                {rows.map(({ task: child, depth }) => (
                  <SubTaskTableRow
                    key={child.id}
                    child={child}
                    depth={depth}
                    members={members}
                    readOnly={readOnly}
                    onOpen={() => openChild(child.id)}
                    onChangeStatus={(s) => void changeStatus(child.id, s)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Inline add-sub-task composer. */}
          {canCreate && adding && (
            <div className="mt-2 flex items-center gap-2">
              <Input
                type="text"
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitChild();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setAdding(false);
                    setDraft("");
                  }
                }}
                onBlur={() => {
                  if (!draft.trim() && !creating) setAdding(false);
                }}
                placeholder="Sub-task title. Enter to add, Esc to cancel"
                disabled={creating}
                className="flex-1 text-sm"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void submitChild()}
                disabled={creating || draft.trim().length === 0}
                className="text-sm text-text-2 hover:text-text-1"
              >
                {creating ? "Adding…" : "Add"}
              </Button>
            </div>
          )}

          {error && (
            <div className="mt-2 text-xs text-red leading-snug">
              {error}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// One table row. Calm, single-line, hover-highlighted; the title is a
// button that opens the sub-task. Status is an inline dropdown (a
// static chip when read-only). Nested rows indent by depth with a faint
// tree guide so the table still reads as a clean grid.
function SubTaskTableRow({
  child,
  depth,
  members,
  readOnly,
  onOpen,
  onChangeStatus,
}: {
  child: Task;
  depth: number;
  members: TeamMember[];
  readOnly: boolean;
  onOpen: () => void;
  onChangeStatus: (status: TaskStatus) => void;
}) {
  return (
    <div className="group flex items-center h-9 px-3 hover:bg-state-hover border-b border-line-soft/50 last:border-b-0 transition-colors">
      {/* Work — key chip + title (opens on click). */}
      <div
        className="flex-1 min-w-0 flex items-center gap-2"
        style={{ paddingLeft: depth > 0 ? depth * 16 : 0 }}
      >
        {depth > 0 && (
          <span
            className="text-text-5/60 select-none shrink-0 text-xs leading-none"
            aria-hidden
          >
            └
          </span>
        )}
        <span className="shrink-0">
          <TaskIdChip sequenceId={child.sequence_id} />
        </span>
        <button
          type="button"
          onClick={onOpen}
          title={child.title}
          className="flex-1 min-w-0 truncate text-left text-base text-text-1 hover:text-accent transition-colors"
        >
          {child.title || "(untitled)"}
        </button>
      </div>
      {/* Priority — the shared bar signal plus the word, because this column
          is literally headed "Priority". Deliberately NOT a coloured chip: on
          this board colour means progress, not rank. */}
      <div className="w-[110px] shrink-0">
        <span className="inline-flex items-center gap-1.5 text-xs text-text-3">
          <TaskPriorityBars priority={child.priority} />
          {TASK_PRIORITY_LABEL[child.priority] ?? child.priority}
        </span>
      </div>
      {/* Status — inline dropdown (or the static glyph + name when read-only,
          the same pair a board lane header and a list group header wear). */}
      <div className="w-[120px] shrink-0">
        {readOnly ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-text-3">
            <TaskStateRing statusId={child.status} />
            {labelFor(STATUS_OPTIONS, child.status)}
          </span>
        ) : (
          <StatusDropdown value={child.status} onChange={onChangeStatus} />
        )}
      </div>
      {/* Assignee — avatar stack (humans). */}
      <div className="w-[52px] shrink-0 flex justify-end">
        {child.assignee_ids.length > 0 ? (
          <AssigneeStack
            handles={child.assignee_ids}
            members={members}
            dense
            maxAvatars={2}
          />
        ) : (
          <span className="text-xs text-text-5">·</span>
        )}
      </div>
    </div>
  );
}

// Inline status control: the shared glyph + name as the trigger, a popover of
// the same four statuses to change it. Every option wears the same state ring
// the board's lanes and the list's groups wear, so picking a status here and
// reading one there are visibly the same act.
function StatusDropdown({
  value,
  onChange,
}: {
  value: TaskStatus;
  onChange: (status: TaskStatus) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-[4px] px-1 py-0.5 text-xs text-text-3 transition-colors hover:bg-state-hover hover:text-text-1"
          aria-label="Change sub-task status"
        >
          <TaskStateRing statusId={value} />
          {labelFor(STATUS_OPTIONS, value)}
          <ChevronDown className="h-2.5 w-2.5" strokeWidth={1.5} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[150px] p-1"
      >
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              if (s.id !== value) onChange(s.id);
              setOpen(false);
            }}
            className={cn(
              "w-full flex items-center justify-between gap-2 text-left px-2 py-1 text-sm rounded hover:bg-state-hover",
              s.id === value ? "text-text-1" : "text-text-3",
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              <TaskStateRing statusId={s.id} />
              {s.label}
            </span>
            {s.id === value && (
              <span className="text-accent text-2xs shrink-0" aria-hidden>
                ✓
              </span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function labelFor<T extends { id: string; label: string }>(
  options: T[],
  id: string,
): string {
  return options.find((o) => o.id === id)?.label ?? id;
}
