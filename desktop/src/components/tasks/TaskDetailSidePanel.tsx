// TaskDetailSidePanel — JJ.8.
//
// PR-review-style side-panel for a single human task. Replaces the
// older monolithic <TaskDetailDrawer> form-stack. The visual grammar
// mirrors `components/pr/PrRightRail.tsx`: a fixed-width column on
// the right of the work area, rendered as a stack of `rounded-lg`
// cards, each with a small header (title, count, optional right-side
// action) and a body that can collapse.
//
// Cards (top → bottom):
//   • Header     — task title (inline rename), id, close button
//   • Status     — status select, priority select, due/start dates
//   • Assignment — human assignee (AssigneePicker), agent assignee chip
//   • Description — markdown-ish body with inline mentions
//   • Dependencies — blockedBy list (resolves task ids → titles)
//   • Labels     — comma-edited chips
//   • Activity   — created/updated, reporter, linked PR, bead id
//   • Comments   — live composer + threaded replies, backed by the
//                  `tasks_comments_*` Tauri surface (list/create/update/
//                  delete). See CommentsCard below.
//
// State: this panel does NOT own task state. It reads the live `Task`
// off props and pushes every edit through `onPatch` (the parent's
// `tasksUpdate` wrapper that also mutates `tasks` in TasksBoard). That
// keeps it the single source of truth and avoids the drift that
// duplicate local state would invite.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { onExternalAnchorClick } from "../../lib/openExternal";
import { Bot, ChevronDown } from "lucide-react";
import { TaskActionBar } from "./TaskActionBar";
import { StartInAgentButton } from "./StartInAgentButton";
import {
  api,
  type Cycle,
  type Module,
  type Task,
  type TaskActivity,
  type TaskComment,
  type TaskPriority,
  type TaskRelation,
  type TaskRelationKind,
  type TaskState,
  type TaskStatus,
  type TeamMember,
  type UpdateTaskInput,
} from "../../lib/api";
import { AssigneePicker } from "../AssigneePicker";
import { TiptapEditor } from "../notes/TiptapEditor";
import { TaskIdChip } from "../TasksBoard";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import {
  PRIORITY_CHIP,
  StatusChip,
  TASK_STATE_CHIP,
} from "../ui/statusChip";
import { StatePillPicker } from "./StatePill";
import { TaskMarkdown } from "./TaskMarkdown";
import { DatePicker } from "../ui/datePicker";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../../lib/utils";

// Mirror the four canonical kanban statuses + their human labels.
// Kept in-file so the panel doesn't depend on TasksBoard's internals.
const STATUS_OPTIONS: { id: TaskStatus; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "in_progress", label: "In Progress" },
  { id: "in_review", label: "In Review" },
  { id: "done", label: "Done" },
];

// OO.3 — 5-stop priority dropdown. Listed in render order so the
// keyboard arrow keys traverse urgent → none.
const PRIORITY_OPTIONS: { id: TaskPriority; label: string }[] = [
  { id: "urgent", label: "Urgent" },
  { id: "high", label: "High" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
  { id: "none", label: "None" },
];

const AGENT_TINT: Record<string, string> = {
  claude: "rgb(217, 119, 87)",
  gemini: "rgb(96, 165, 250)",
  codex: "rgb(132, 204, 168)",
  opencode: "rgb(192, 132, 252)",
};

type Props = {
  task: Task;
  /** All tasks in the workspace — needed to resolve dependency ids
   *  ("task_abc123") into human-readable titles. */
  allTasks: Task[];
  members: TeamMember[];
  /** OO.3 — per-repo state catalog (backlog/unstarted/started/
   *  completed/cancelled + custom). Empty array is treated as
   *  "catalog not loaded yet" and the panel falls back to the legacy
   *  status select so editing never blocks on a slow catalog load. */
  taskStates: TaskState[];
  /** OO.4 — per-repo cycle catalog. Empty array hides the picker so
   *  the card never offers a meaningless empty select. */
  cycles?: Cycle[];
  /** OO.4 — per-repo module catalog. Same empty-array convention. */
  modules?: Module[];
  /** Repo root forwarded for the bead-mint button (only Tauri command
   *  the panel needs to invoke directly; everything else routes
   *  through `onPatch`). */
  repoRoot: string;
  /** OO.5 — current git handle. Attached to comment writes so the
   *  thread renders the right avatar / name. `null` falls through to
   *  the backend's `"system"` fallback. */
  currentHandle?: string | null;
  onClose: () => void;
  /** Push a partial update to the store; resolves once the backend
   *  has acked + the parent has refreshed its local copy of `task`. */
  onPatch: (input: UpdateTaskInput) => Promise<void>;
  onDelete: () => void;
  /** OO.5 — create a child task under the current row. Optional so
   *  embedded/test renders that don't wire create can still show the
   *  panel; when omitted the sub-issues card hides the "+ Add child"
   *  affordance but still renders the existing tree. */
  onCreateChild?: (parentId: string, title: string) => Promise<void>;
};

export function TaskDetailSidePanel({
  task,
  allTasks,
  members,
  taskStates,
  cycles = [],
  modules = [],
  repoRoot,
  currentHandle,
  onClose,
  onPatch,
  onDelete,
  onCreateChild,
}: Props) {
  return (
    <aside
      className="w-[400px] flex-shrink-0 border-l border-line-soft bg-bg-1 flex flex-col h-full"
      aria-label="Task detail"
    >
      <PanelHeader
        task={task}
        childTasks={allTasks.filter((t) => t.parent_id === task.id)}
        repoRoot={repoRoot}
        onClose={onClose}
        onDelete={onDelete}
        onPatch={onPatch}
      />
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-6 space-y-2.5">
        <StatusCard task={task} taskStates={taskStates} onPatch={onPatch} />
        <AssignmentCard task={task} members={members} onPatch={onPatch} />
        {(cycles.length > 0 || modules.length > 0) && (
          <PlanningCard
            task={task}
            cycles={cycles}
            modules={modules}
            onPatch={onPatch}
          />
        )}
        <DescriptionCard task={task} members={members} onPatch={onPatch} />
        <DependenciesCard task={task} allTasks={allTasks} />
        <SubIssuesCard
          task={task}
          allTasks={allTasks}
          repoRoot={repoRoot}
          onCreateChild={onCreateChild}
        />
        <RelationsCard
          task={task}
          allTasks={allTasks}
          repoRoot={repoRoot}
        />
        <LabelsCard task={task} onPatch={onPatch} />
        <ActivityCard task={task} repoRoot={repoRoot} onPatch={onPatch} />
        <CommentsCard
          task={task}
          repoRoot={repoRoot}
          currentHandle={currentHandle ?? null}
          members={members}
        />
      </div>
    </aside>
  );
}

// ── Planning card — OO.4 Cycle + Module pickers ────────────────────
//
// Plane-style "Planning" sidebar block. Renders two `<select>`s for
// the per-repo cycle + module catalogs. Empty option clears the
// pointer; the backend treats "" as null so the same wire shape
// covers both set + clear.

export function PlanningCard({
  task,
  cycles,
  modules,
  onPatch,
  variant = "rail",
}: {
  task: Task;
  cycles: Cycle[];
  modules: Module[];
  onPatch: (input: UpdateTaskInput) => Promise<void>;
  variant?: CardVariant;
}) {
  return (
    <Card title="Planning" variant={variant}>
      <div className="space-y-2.5">
        {cycles.length > 0 && (
          <Row label="Cycle" variant={variant}>
            <Select
              value={task.cycle_id ?? ""}
              onChange={(v) => onPatch({ id: task.id, cycle_id: v })}
              options={cycles.map((c) => ({
                value: c.id,
                label: `${c.name}${c.status === "active" ? " · active" : ""}`,
              }))}
              placeholder="— No cycle —"
              className="flex-1"
              aria-label="Change cycle"
            />
          </Row>
        )}
        {modules.length > 0 && (
          <Row label="Module" variant={variant}>
            <Select
              value={task.module_id ?? ""}
              onChange={(v) => onPatch({ id: task.id, module_id: v })}
              options={modules.map((m) => ({
                value: m.id,
                label: `${m.name}${m.status === "in_progress" ? " · in progress" : ""}`,
              }))}
              placeholder="— No module —"
              className="flex-1"
              aria-label="Change module"
            />
          </Row>
        )}
      </div>
    </Card>
  );
}

// ── Header ─────────────────────────────────────────────────────────

function PanelHeader({
  task,
  childTasks,
  repoRoot,
  onClose,
  onDelete,
  onPatch,
}: {
  task: Task;
  childTasks: Task[];
  repoRoot: string;
  onClose: () => void;
  onDelete: () => void;
  onPatch: (input: UpdateTaskInput) => Promise<void>;
}) {
  // Local edit buffer for the inline rename. Reset whenever the
  // upstream task changes (e.g. switching from one row to another).
  const [title, setTitle] = useState(task.title);
  useEffect(() => {
    setTitle(task.title);
  }, [task.id, task.title]);

  const commitTitle = () => {
    const next = title.trim();
    if (next && next !== task.title) {
      void onPatch({ id: task.id, title: next });
    } else {
      setTitle(task.title);
    }
  };

  return (
    <div className="border-b border-line-soft bg-bg-1/80 backdrop-blur-sm">
      {/* Top bar — id chip (left) + quiet 28px action cluster (right),
          comfortable px-4 h-12 to match the new card language. */}
      <div className="flex items-center gap-2 px-4 h-12">
        <TaskIdChip
          sequenceId={task.sequence_id}
          className="font-mono text-[11px] tracking-tight text-text-3 hover:text-text-1 bg-bg-2 hover:bg-bg-3 px-1.5 py-0.5 rounded transition-colors"
        />
        <div className="flex-1" />
        <TaskActionBar
          copyText={
            task.sequence_id > 0 ? `AURA-${task.sequence_id}` : task.id
          }
          onClose={onClose}
          onDelete={onDelete}
        />
      </div>
      {/* Inline-editable title — Medusa-leaning 15px/600. */}
      <div className="px-4 pb-3.5 pt-0.5">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setTitle(task.title);
              e.currentTarget.blur();
            }
          }}
          className="w-full bg-transparent text-text-1 text-[15px] font-semibold leading-[1.3] tracking-tight focus:outline-none focus:bg-bg-2/60 rounded px-1 -mx-1 py-0.5"
          placeholder="Untitled task"
        />
      </div>
      {/* Primary call-to-action — peek a task, then start it in an agent. */}
      <div className="px-4 pb-3">
        <StartInAgentButton
          task={task}
          repoRoot={repoRoot}
          childTasks={childTasks}
          onStarted={onClose}
          size="sm"
        />
      </div>
    </div>
  );
}

// ── Cards ──────────────────────────────────────────────────────────

export function StatusCard({
  task,
  taskStates,
  onPatch,
  variant = "rail",
}: {
  task: Task;
  taskStates: TaskState[];
  onPatch: (input: UpdateTaskInput) => Promise<void>;
  variant?: CardVariant;
}) {
  // OO.3 — prefer the canonical state catalog when one is loaded.
  // The legacy status select stays as a fallback so a slow catalog
  // load (or a hand-edited repo missing task_states.json) never
  // strands the user with no way to change state. Backend mirrors
  // state_id → legacy status on every write, so the two paths stay
  // in lockstep.
  const useCatalog = taskStates.length > 0;
  return (
    <Card title="Status" variant={variant}>
      <div className="space-y-2.5">
        <Row label="State" variant={variant}>
          {useCatalog ? (
            <StatePillPicker
              states={taskStates}
              value={task.state_id ?? null}
              onChange={(stateId) => onPatch({ id: task.id, state_id: stateId })}
            />
          ) : (
            <div className="flex items-center gap-2">
              <StatusChip tone={TASK_STATE_CHIP[task.status].tone} dot>
                {labelFor(STATUS_OPTIONS, task.status)}
              </StatusChip>
              <Select
                value={task.status}
                onChange={(v) => onPatch({ id: task.id, status: v as TaskStatus })}
                options={STATUS_OPTIONS.map((s) => ({
                  value: s.id,
                  label: s.label,
                }))}
                className="flex-1"
                aria-label="Change status"
              />
            </div>
          )}
        </Row>
        <Row label="Priority" variant={variant}>
          <PriorityPicker
            value={task.priority}
            onChange={(p) => onPatch({ id: task.id, priority: p })}
          />
        </Row>
        <div className="grid grid-cols-2 gap-2">
          <Row label="Start" variant={variant}>
            <DatePicker
              value={task.start_date ?? ""}
              onChange={(v) => onPatch({ id: task.id, start_date: v })}
              placeholder="—"
            />
          </Row>
          <Row label="Due" variant={variant}>
            <DatePicker
              value={task.due_date ?? ""}
              onChange={(v) => onPatch({ id: task.id, due_date: v })}
              placeholder="—"
            />
          </Row>
        </div>
      </div>
    </Card>
  );
}

// Compact priority control — a chip-shaped trigger (current priority dot +
// label + chevron) opening a small popover list. Replaces the redundant
// chip-plus-full-width-<select> pairing that stretched across wide columns.
function PriorityPicker({
  value,
  onChange,
}: {
  value: TaskPriority;
  onChange: (priority: TaskPriority) => void;
}) {
  const [open, setOpen] = useState(false);
  const spec = PRIORITY_CHIP[value];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex" aria-label="Change priority">
          <StatusChip
            tone={spec.tone}
            dot
            icon={
              <ChevronDown
                className="w-2.5 h-2.5 order-last"
                strokeWidth={1.5}
                aria-hidden
              />
            }
          >
            {labelFor(PRIORITY_OPTIONS, value)}
          </StatusChip>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[150px] p-1"
      >
        {PRIORITY_OPTIONS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              if (p.id !== value) onChange(p.id);
              setOpen(false);
            }}
            className={cn(
              "w-full flex items-center justify-between gap-2 text-left px-2 py-1 text-[11.5px] rounded hover:bg-bg-2",
              p.id === value ? "text-text-1" : "text-text-3",
            )}
          >
            <StatusChip tone={PRIORITY_CHIP[p.id].tone} dot dense>
              {p.label}
            </StatusChip>
            {p.id === value && (
              <span className="text-accent text-[10px] shrink-0" aria-hidden>
                ✓
              </span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function AssignmentCard({
  task,
  members,
  onPatch,
  variant = "rail",
}: {
  task: Task;
  members: TeamMember[];
  onPatch: (input: UpdateTaskInput) => Promise<void>;
  variant?: CardVariant;
}) {
  return (
    <Card title="Assignment" variant={variant}>
      <div className="space-y-2.5">
        <Row label="Humans" variant={variant}>
          {/* OO.3 — multi-assignee picker. Sends `assignee_ids`; the
           *  backend mirrors the singular `assignee` from the first
           *  entry so older readers keep working. */}
          <AssigneePicker
            values={task.assignee_ids}
            onChangeMulti={(handles) =>
              onPatch({ id: task.id, assignee_ids: handles })
            }
            members={members}
          />
        </Row>
        <Row label="Agent" variant={variant}>
          {task.agent_assignee ? (
            <div className="flex items-center gap-2">
              <span
                className="inline-flex items-center px-1.5 h-5 rounded uppercase tracking-wider text-[10px] font-medium"
                style={{
                  background: `${AGENT_TINT[task.agent_assignee] ?? "rgb(160,160,160)"}25`,
                  color: AGENT_TINT[task.agent_assignee] ?? "rgb(200,200,200)",
                }}
                title={`Agent: ${task.agent_assignee}`}
              >
                <Bot className="w-3 h-3 mr-0.5" strokeWidth={1.5} aria-hidden />
                {task.agent_assignee}
              </span>
              <Button
                type="button"
                variant="subtle"
                size="xs"
                onClick={() => onPatch({ id: task.id, agent_assignee: "" })}
              >
                Clear
              </Button>
            </div>
          ) : (
            <span className="text-[11.5px] text-text-5 italic">None</span>
          )}
        </Row>
        {task.reporter && (
          <Row label="Reporter" variant={variant}>
            <span className="text-[12px] text-text-2 font-mono">
              @{task.reporter}
            </span>
          </Row>
        )}
      </div>
    </Card>
  );
}

export function DescriptionCard({
  task,
  members,
  onPatch,
  variant = "rail",
}: {
  task: Task;
  members: TeamMember[];
  onPatch: (input: UpdateTaskInput) => Promise<void>;
  variant?: CardVariant;
}) {
  // Two-mode body: a read-only rendered view (with @mention chips)
  // toggles into an editable textarea on click — matches the
  // Plane.so/Linear pattern and stays out of the way until needed.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.description);
  useEffect(() => {
    setDraft(task.description);
    setEditing(false);
  }, [task.id, task.description]);

  const dirty = draft.trim() !== task.description.trim();
  const save = async () => {
    if (dirty) {
      await onPatch({ id: task.id, description: draft });
    }
    setEditing(false);
  };
  const cancel = () => {
    setDraft(task.description);
    setEditing(false);
  };

  return (
    <Card
      title="Description"
      variant={variant}
      right={
        editing ? (
          <div className="flex items-center gap-1.5">
            <Button type="button" variant="subtle" size="xs" onClick={cancel}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="accentSoft"
              size="xs"
              onClick={save}
              disabled={!dirty}
            >
              Save
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="subtle"
            size="xs"
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        )
      }
    >
      {editing ? (
        <div className="min-h-[180px]">
          <TiptapEditor
            value={draft}
            onChange={setDraft}
            placeholder="Describe the work, paste a spec, drop @mentions…"
            dense
            autoFocus
          />
        </div>
      ) : task.description.trim() ? (
        <div className="cursor-text" onClick={() => setEditing(true)}>
          <TaskMarkdown source={task.description} members={members} />
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setEditing(true)}
          className="px-0 italic font-normal text-[11.5px] text-text-5 hover:text-text-3 hover:bg-transparent"
        >
          No description — click to add one.
        </Button>
      )}
    </Card>
  );
}

export function DependenciesCard({
  task,
  allTasks,
  variant = "rail",
}: {
  task: Task;
  allTasks: Task[];
  variant?: CardVariant;
}) {
  const blockedBy = task.dependencies ?? [];
  const blocks = useMemo(
    () => allTasks.filter((t) => (t.dependencies ?? []).includes(task.id)),
    [allTasks, task.id],
  );
  if (blockedBy.length === 0 && blocks.length === 0) {
    return (
      <Card title="Dependencies" count={0} variant={variant}>
        <div className="text-[11.5px] text-text-5 italic">
          No upstream or downstream tasks.
        </div>
      </Card>
    );
  }
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  return (
    <Card
      title="Dependencies"
      count={blockedBy.length + blocks.length}
      variant={variant}
    >
      <div className="space-y-2.5">
        {blockedBy.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-5 mb-1">
              Blocked by
            </div>
            <div className="space-y-1">
              {blockedBy.map((id) => {
                const upstream = byId.get(id);
                return (
                  <div
                    key={id}
                    className="flex items-center gap-2 text-[12px] text-text-2"
                  >
                    <span className="w-3 h-3 rounded-sm bg-amber-500/20 text-amber-300 text-[9px] flex items-center justify-center font-bold">
                      ⇠
                    </span>
                    <span className="truncate" title={upstream?.title ?? id}>
                      {upstream?.title ?? <span className="font-mono text-text-5">{id}</span>}
                    </span>
                    {upstream && (
                      <StatusChip
                        tone={TASK_STATE_CHIP[upstream.status].tone}
                        dot
                        dense
                        className="ml-auto"
                      >
                        {labelFor(STATUS_OPTIONS, upstream.status)}
                      </StatusChip>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {blocks.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-5 mb-1">
              Blocks
            </div>
            <div className="space-y-1">
              {blocks.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-2 text-[12px] text-text-2"
                >
                  <span className="w-3 h-3 rounded-sm bg-sky-500/20 text-sky-300 text-[9px] flex items-center justify-center font-bold">
                    ⇢
                  </span>
                  <span className="truncate" title={t.title}>
                    {t.title}
                  </span>
                  <StatusChip
                    tone={TASK_STATE_CHIP[t.status].tone}
                    dot
                    dense
                    className="ml-auto"
                  >
                    {labelFor(STATUS_OPTIONS, t.status)}
                  </StatusChip>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

export function LabelsCard({
  task,
  onPatch,
  variant = "rail",
}: {
  task: Task;
  onPatch: (input: UpdateTaskInput) => Promise<void>;
  variant?: CardVariant;
}) {
  // Single editable input — comma-separated. Matches the existing
  // drawer's contract so user muscle memory carries over.
  const [draft, setDraft] = useState(task.labels.join(", "));
  useEffect(() => {
    setDraft(task.labels.join(", "));
  }, [task.id, task.labels]);
  const commit = () => {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const same =
      parsed.length === task.labels.length &&
      parsed.every((l, i) => l === task.labels[i]);
    if (!same) void onPatch({ id: task.id, labels: parsed });
  };
  return (
    <Card title="Labels" count={task.labels.length} variant={variant}>
      <div className="space-y-2">
        {task.labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {task.labels.map((l) => (
              <span
                key={l}
                className="bg-bg-2 text-text-2 text-[10.5px] px-1.5 py-0.5 rounded"
              >
                {l}
              </span>
            ))}
          </div>
        )}
        <Input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder="bug, frontend, p0"
          className="w-full"
        />
      </div>
    </Card>
  );
}

// ── Sub-issues card (OO.5) ─────────────────────────────────────────
//
// Renders direct + transitive descendants of the current task using
// `tasks_subtree`. Inline "+ Add child" composer mints a fresh task
// with `parent_id` pre-filled. The tree is computed client-side from
// the subtree result so deeply nested branches collapse into a single
// indented list without an extra round trip.

// A long subtree (some tasks have 70+) used to dump every row and blow
// the rail height. Cap the preview; the rest is one click away.
const SUB_ISSUE_PREVIEW = 7;

export function SubIssuesCard({
  task,
  allTasks,
  repoRoot,
  onCreateChild,
  variant = "rail",
}: {
  task: Task;
  allTasks: Task[];
  repoRoot: string;
  onCreateChild?: (parentId: string, title: string) => Promise<void>;
  variant?: CardVariant;
}) {
  const [subtree, setSubtree] = useState<Task[]>([]);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const rows = await api.tasksSubtree(repoRoot, task.id);
      // Drop the root — it's the current task; the card lists its
      // descendants only.
      setSubtree(rows.filter((r) => r.id !== task.id));
    } catch (e) {
      setError(String(e));
    }
  }, [repoRoot, task.id]);

  useEffect(() => {
    void refresh();
    // Re-fetch when the parent's allTasks changes — that's a proxy
    // for "the workspace was mutated and the subtree might be stale".
  }, [refresh, allTasks]);

  // Build a parent → children map so we can render a real tree (the
  // subtree is depth-first but flat). The depth is computed by walking
  // up parent_id pointers until we hit `task.id`.
  const tree = useMemo(() => {
    const depthOf = (node: Task): number => {
      let d = 0;
      let cur: Task | undefined = node;
      const byId = new Map(allTasks.map((t) => [t.id, t]));
      while (cur && cur.parent_id && cur.parent_id !== task.id) {
        cur = byId.get(cur.parent_id);
        d += 1;
        if (d > 12) break; // pathological guard
      }
      return d;
    };
    return subtree.map((t) => ({ task: t, depth: depthOf(t) }));
  }, [subtree, allTasks, task.id]);

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

  return (
    <Card title="Sub-issues" count={subtree.length} variant={variant}>
      <div className="space-y-2">
        {subtree.length === 0 && (
          <div className="text-[11.5px] text-text-5 italic">
            No sub-issues. Children created here inherit this task as
            their parent.
          </div>
        )}
        {tree.length > 0 && (
          <div className="-mx-1.5">
            {(expanded ? tree : tree.slice(0, SUB_ISSUE_PREVIEW)).map(
              ({ task: child, depth }) => (
                <div
                  key={child.id}
                  className="group flex items-center gap-2 h-7 rounded-md px-1.5 hover:bg-bg-2/70"
                  style={{ paddingLeft: `${6 + depth * 14}px` }}
                  title={`AURA-${child.sequence_id} · ${child.title}`}
                >
                  <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-text-5 tabular-nums">
                    {child.sequence_id}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-[12px] text-text-2 group-hover:text-text-1">
                    {child.title}
                  </span>
                  <StatusChip
                    tone={TASK_STATE_CHIP[child.status].tone}
                    dot
                    dense
                    className="shrink-0"
                  >
                    {labelFor(STATUS_OPTIONS, child.status)}
                  </StatusChip>
                </div>
              ),
            )}
            {tree.length > SUB_ISSUE_PREVIEW && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-1 ml-1.5 text-[11px] text-text-4 hover:text-text-2"
              >
                {expanded
                  ? "Show less"
                  : `Show all ${tree.length} sub-issues`}
              </button>
            )}
          </div>
        )}
        {onCreateChild && (
          <div className="flex items-center gap-2 pt-1.5 border-t border-line-soft/60">
            <Input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitChild();
                }
              }}
              placeholder="+ Add sub-issue title"
              disabled={creating}
              className="flex-1"
            />
            <Button
              type="button"
              variant="subtle"
              size="xs"
              onClick={() => void submitChild()}
              disabled={creating || draft.trim().length === 0}
            >
              {creating ? "Adding…" : "Add"}
            </Button>
          </div>
        )}
        {error && (
          <div className="text-[10.5px] text-rose-400 leading-snug">
            {error}
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Relations card (OO.5) ──────────────────────────────────────────
//
// Lists every `TaskRelation` row that touches the current task.
// Symmetric mirrors are persisted by the backend so each relation
// row already knows which side the current task sits on — we just
// group by (kind, direction) for the UI.

const RELATION_KINDS: { id: TaskRelationKind; label: string }[] = [
  { id: "blocked_by", label: "Blocked by" },
  { id: "blocks", label: "Blocks" },
  { id: "duplicates", label: "Duplicates" },
  { id: "relates_to", label: "Relates to" },
];

export function RelationsCard({
  task,
  allTasks,
  repoRoot,
  variant = "rail",
}: {
  task: Task;
  allTasks: Task[];
  repoRoot: string;
  variant?: CardVariant;
}) {
  const [relations, setRelations] = useState<TaskRelation[]>([]);
  const [adding, setAdding] = useState(false);
  const [draftKind, setDraftKind] = useState<TaskRelationKind>("blocked_by");
  const [draftTarget, setDraftTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await api.tasksRelationsForTask(repoRoot, task.id);
      setRelations(rows);
    } catch (e) {
      setError(String(e));
    }
  }, [repoRoot, task.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Group rows where the current task is the source — that's the
  // "outgoing" view. We dedupe with mirrors by always reading from
  // the source-side row (the mirror has the same logical content with
  // swapped endpoints).
  const outgoing = relations.filter((r) => r.source_id === task.id);
  const byId = new Map(allTasks.map((t) => [t.id, t]));

  const addRelation = async () => {
    const target = draftTarget.trim();
    if (!target || target === task.id) return;
    setBusy(true);
    setError(null);
    try {
      await api.tasksRelationsCreate(repoRoot, task.id, target, draftKind);
      setDraftTarget("");
      setAdding(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeRelation = async (relationId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.tasksRelationsDelete(repoRoot, relationId);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Pre-compute candidate target tasks (everything but `task` itself
  // and anything already linked at the chosen kind).
  const candidateTargets = useMemo(() => {
    const alreadyLinked = new Set(
      outgoing
        .filter((r) => r.kind === draftKind)
        .map((r) => r.target_id),
    );
    return allTasks.filter(
      (t) => t.id !== task.id && !alreadyLinked.has(t.id),
    );
  }, [allTasks, outgoing, draftKind, task.id]);

  // Group outgoing by kind for the render. The mirror rows show up
  // as their own kind on the source side (e.g. "blocks" on B for
  // A blocked_by B) so listing the outgoing slice covers both sides
  // without surfacing duplicates.
  const byKind = new Map<TaskRelationKind, TaskRelation[]>();
  for (const k of RELATION_KINDS) byKind.set(k.id, []);
  for (const r of outgoing) {
    const k = (r.kind as TaskRelationKind) ?? null;
    if (k && byKind.has(k)) byKind.get(k)!.push(r);
  }

  return (
    <Card
      title="Relations"
      count={outgoing.length}
      variant={variant}
      right={
        !adding ? (
          <Button
            type="button"
            variant="subtle"
            size="xs"
            onClick={() => setAdding(true)}
          >
            + Add
          </Button>
        ) : null
      }
    >
      <div className="space-y-2">
        {outgoing.length === 0 && !adding && (
          <div className="text-[11.5px] text-text-5 italic">
            No relations. Link this task to others to track
            dependencies, duplicates, or related work.
          </div>
        )}
        {RELATION_KINDS.map((k) => {
          const rows = byKind.get(k.id) ?? [];
          if (rows.length === 0) return null;
          return (
            <div key={k.id}>
              <div className="text-[10px] uppercase tracking-wider text-text-5 mb-1">
                {k.label}
              </div>
              <div className="space-y-1">
                {rows.map((r) => {
                  const target = byId.get(r.target_id);
                  return (
                    <div
                      key={r.id}
                      className="flex items-center gap-2 text-[12px] text-text-2"
                    >
                      <span className="text-text-5 font-mono text-[10.5px]">
                        {target ? `AURA-${target.sequence_id}` : "?"}
                      </span>
                      <span
                        className="truncate"
                        title={target?.title ?? r.target_id}
                      >
                        {target?.title ?? (
                          <span className="font-mono text-text-5">
                            {r.target_id}
                          </span>
                        )}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void removeRelation(r.id)}
                        disabled={busy}
                        title="Remove relation"
                        className="ml-auto text-text-5 hover:text-rose-400"
                      >
                        ×
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {adding && (
          <div className="pt-1.5 border-t border-line-soft/60 space-y-2">
            <div className="flex items-center gap-2">
              <Select
                value={draftKind}
                onChange={(v) => setDraftKind(v as TaskRelationKind)}
                options={RELATION_KINDS.map((k) => ({
                  value: k.id,
                  label: k.label,
                }))}
                aria-label="Relation kind"
              />
              <Select
                value={draftTarget}
                onChange={(v) => setDraftTarget(v)}
                options={candidateTargets.map((t) => ({
                  value: t.id,
                  label: `AURA-${t.sequence_id} · ${t.title}`,
                }))}
                placeholder="— Pick a task —"
                className="flex-1"
                aria-label="Relation target"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="accentSoft"
                size="xs"
                onClick={() => void addRelation()}
                disabled={busy || !draftTarget}
              >
                {busy ? "Linking…" : "Link"}
              </Button>
              <Button
                type="button"
                variant="subtle"
                size="xs"
                onClick={() => {
                  setAdding(false);
                  setDraftTarget("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {error && (
          <div className="text-[10.5px] text-rose-400 leading-snug">
            {error}
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Activity card (OO.5) ───────────────────────────────────────────
//
// Renders the per-task activity timeline (`tasks_activity_list`).
// Falls back to the synthesized created/updated rows when the
// backend log is empty so a fresh repo still shows something useful.

export function ActivityCard({
  task,
  repoRoot,
  onPatch,
  variant = "rail",
}: {
  task: Task;
  repoRoot: string;
  onPatch: (input: UpdateTaskInput) => Promise<void>;
  variant?: CardVariant;
}) {
  const [events, setEvents] = useState<TaskActivity[]>([]);
  const [minting, setMinting] = useState(false);
  const [mintMsg, setMintMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await api.tasksActivityList(repoRoot, task.id, 25);
      setEvents(rows);
    } catch {
      // Activity is non-essential — surface a silent empty list
      // rather than blocking the rest of the panel.
      setEvents([]);
    }
  }, [repoRoot, task.id]);

  useEffect(() => {
    setMintMsg(null);
    void refresh();
  }, [refresh]);

  const mintBead = async () => {
    if (minting) return;
    setMinting(true);
    setMintMsg(null);
    try {
      const content = [task.title, task.description].filter(Boolean).join("\n\n");
      const beadId = await api.tasksMintBead(repoRoot, task.id, content);
      await onPatch({ id: task.id, bead_id: beadId });
      setMintMsg(`Proof saved · ${beadId}`);
    } catch (e) {
      setMintMsg(String(e));
    } finally {
      setMinting(false);
    }
  };

  return (
    <Card title="Activity" count={events.length} variant={variant}>
      <div className="space-y-1.5">
        {events.length === 0 ? (
          <>
            <ActivityRow
              label="Created"
              value={formatTimestamp(task.created_at)}
            />
            <ActivityRow
              label="Updated"
              value={formatTimestamp(task.updated_at)}
            />
          </>
        ) : (
          events.map((ev) => (
            <div
              key={ev.id}
              className="flex items-baseline gap-2 text-[11.5px]"
            >
              <span className="text-text-5 w-20 flex-shrink-0">
                {formatTimestamp(ev.created_at)}
              </span>
              <span className="text-text-2 leading-snug">
                <span className="font-medium text-text-1">
                  {ev.actor_handle}
                </span>{" "}
                {summariseActivity(ev)}
              </span>
            </div>
          ))
        )}
        {task.linked_pr && (
          <ActivityRow
            label="Linked PR"
            value={
              <a
                href={task.linked_pr.url}
                target="_blank"
                rel="noreferrer"
                onClick={onExternalAnchorClick}
                className="text-accent hover:underline font-mono"
              >
                {task.linked_pr.repo}#{task.linked_pr.number}
              </a>
            }
          />
        )}
        {task.bead_id && (
          <ActivityRow
            label="Proof"
            value={
              <span className="text-text-2 font-mono break-all">
                {task.bead_id}
              </span>
            }
          />
        )}
        {!task.bead_id && (
          <div className="pt-2 mt-1 border-t border-line-soft/60 flex items-center gap-2">
            <Button
              type="button"
              variant="subtle"
              size="xs"
              disabled={minting || task.status !== "done"}
              onClick={mintBead}
              title={
                task.status === "done"
                  ? "Turn this finished task into a portable proof an AI teammate can verify and pick up."
                  : "Available once the task is marked Done."
              }
            >
              {minting ? "Saving…" : "Mark as proof"}
            </Button>
            {mintMsg && (
              <span
                className={`text-[10.5px] leading-snug ${
                  mintMsg.startsWith("Proof")
                    ? "text-emerald-400"
                    : "text-rose-400"
                }`}
              >
                {mintMsg}
              </span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function ActivityRow({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3 text-[11.5px]">
      <span className="text-text-5 w-16 flex-shrink-0">{label}</span>
      <span className="text-text-2">{value}</span>
    </div>
  );
}

// Human-friendly verb for one activity row. Falls back to the raw
// kind for future events so the timeline always renders something.
function summariseActivity(ev: TaskActivity): string {
  const payload = ev.payload ?? {};
  switch (ev.kind) {
    case "created":
      return "created this task";
    case "updated":
      return (payload as { deleted?: boolean }).deleted
        ? "deleted this task"
        : "updated this task";
    case "state_changed": {
      const from = (payload as { from?: string }).from;
      const to = (payload as { to?: string }).to;
      return from && to
        ? `changed state from ${from} → ${to}`
        : "changed state";
    }
    case "assigned": {
      const added = (payload as { added?: string[] }).added ?? [];
      return added.length > 0
        ? `assigned ${added.join(", ")}`
        : "assigned this task";
    }
    case "unassigned": {
      const removed = (payload as { removed?: string[] }).removed ?? [];
      return removed.length > 0
        ? `removed ${removed.join(", ")}`
        : "unassigned this task";
    }
    case "labeled": {
      const added = (payload as { added?: string[] }).added ?? [];
      return added.length > 0
        ? `added label${added.length > 1 ? "s" : ""} ${added.join(", ")}`
        : "added a label";
    }
    case "unlabeled": {
      const removed = (payload as { removed?: string[] }).removed ?? [];
      return removed.length > 0
        ? `removed label${removed.length > 1 ? "s" : ""} ${removed.join(", ")}`
        : "removed a label";
    }
    case "linked": {
      const target = (payload as { target_id?: string }).target_id;
      const kind = (payload as { kind?: string }).kind;
      return `linked ${target ?? ""} (${kind ?? "relation"})`;
    }
    case "unlinked": {
      const target = (payload as { target_id?: string }).target_id;
      return `unlinked ${target ?? "a relation"}`;
    }
    case "commented":
      return "commented";
    default:
      return ev.kind;
  }
}

// ── Comments card (OO.5) ───────────────────────────────────────────
//
// Threaded discussion attached to a single task. The composer always
// targets a root; replies render under their parent root. Editing +
// deleting flow through `tasks_comments_update` / `tasks_comments_delete`.

export function CommentsCard({
  task,
  repoRoot,
  currentHandle,
  members = [],
  variant = "rail",
}: {
  task: Task;
  repoRoot: string;
  currentHandle: string | null;
  members?: TeamMember[];
  variant?: CardVariant;
}) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");

  const refresh = useCallback(async () => {
    try {
      const rows = await api.tasksCommentsList(repoRoot, task.id);
      setComments(rows);
    } catch (e) {
      setError(String(e));
    }
  }, [repoRoot, task.id]);

  useEffect(() => {
    void refresh();
    setDraft("");
    setReplyTo(null);
    setEditingId(null);
  }, [refresh]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.tasksCommentsCreate(repoRoot, task.id, body, {
        parentCommentId: replyTo,
        authorHandle: currentHandle ?? undefined,
      });
      setDraft("");
      setReplyTo(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (c: TaskComment) => {
    setEditingId(c.id);
    setEditingDraft(c.body);
  };

  const commitEdit = async () => {
    if (!editingId) return;
    const body = editingDraft.trim();
    if (!body) {
      setEditingId(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.tasksCommentsUpdate(repoRoot, editingId, body);
      setEditingId(null);
      setEditingDraft("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteComment = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.tasksCommentsDelete(repoRoot, id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Group by root: a root is a comment with no parent; replies are
  // every comment whose `parent_comment_id` matches.
  const roots = comments.filter((c) => !c.parent_comment_id);
  const repliesByRoot = new Map<string, TaskComment[]>();
  for (const c of comments) {
    if (c.parent_comment_id) {
      const arr = repliesByRoot.get(c.parent_comment_id) ?? [];
      arr.push(c);
      repliesByRoot.set(c.parent_comment_id, arr);
    }
  }

  return (
    <Card title="Comments" count={comments.length} variant={variant}>
      <div className="space-y-3">
        {roots.length === 0 && (
          <div className="text-[11.5px] text-text-5 italic">
            No comments yet. Start the conversation below.
          </div>
        )}
        {roots.map((root) => (
          <div key={root.id} className="space-y-1.5">
            <CommentRow
              comment={root}
              members={members}
              busy={busy}
              isEditing={editingId === root.id}
              editingDraft={editingDraft}
              currentHandle={currentHandle}
              onStartEdit={() => startEdit(root)}
              onChangeDraft={setEditingDraft}
              onCommitEdit={() => void commitEdit()}
              onCancelEdit={() => setEditingId(null)}
              onDelete={() => void deleteComment(root.id)}
              onReply={() => setReplyTo(root.id)}
            />
            {(repliesByRoot.get(root.id) ?? []).map((reply) => (
              <div key={reply.id} className="pl-4 border-l border-line-soft/50">
                <CommentRow
                  comment={reply}
                  members={members}
                  busy={busy}
                  isEditing={editingId === reply.id}
                  editingDraft={editingDraft}
                  currentHandle={currentHandle}
                  onStartEdit={() => startEdit(reply)}
                  onChangeDraft={setEditingDraft}
                  onCommitEdit={() => void commitEdit()}
                  onCancelEdit={() => setEditingId(null)}
                  onDelete={() => void deleteComment(reply.id)}
                  onReply={null}
                />
              </div>
            ))}
          </div>
        ))}
        <div className="space-y-1.5 pt-2 border-t border-line-soft/60">
          {replyTo && (
            <div className="flex items-center justify-between text-[10.5px] text-text-5">
              <span>
                Replying to{" "}
                <span className="font-mono text-text-3">
                  {replyTo.slice(0, 8)}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setReplyTo(null)}
                className="px-1 text-[10.5px] text-text-4 hover:text-text-1"
              >
                Cancel reply
              </Button>
            </div>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              replyTo ? "Write a reply…" : "Add a comment…"
            }
            disabled={busy}
            rows={2}
            className="w-full bg-bg-content border border-line-soft rounded px-2 py-1 text-[12px] text-text-1 focus:outline-none focus:border-line disabled:opacity-50 resize-y min-h-[3rem]"
          />
          <div className="flex items-center justify-between">
            <span className="text-[10.5px] text-text-5">
              {currentHandle ? `As ${currentHandle}` : "System comment"}
            </span>
            <Button
              type="button"
              variant="accentSoft"
              size="xs"
              onClick={() => void submit()}
              disabled={busy || draft.trim().length === 0}
            >
              {busy ? "Sending…" : replyTo ? "Reply" : "Comment"}
            </Button>
          </div>
          {error && (
            <div className="text-[10.5px] text-rose-400 leading-snug">
              {error}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function CommentRow({
  comment,
  members,
  busy,
  isEditing,
  editingDraft,
  currentHandle,
  onStartEdit,
  onChangeDraft,
  onCommitEdit,
  onCancelEdit,
  onDelete,
  onReply,
}: {
  comment: TaskComment;
  members: TeamMember[];
  busy: boolean;
  isEditing: boolean;
  editingDraft: string;
  currentHandle: string | null;
  onStartEdit: () => void;
  onChangeDraft: (s: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onReply: (() => void) | null;
}) {
  const edited = comment.updated_at !== comment.created_at;
  const isOwner =
    currentHandle != null && currentHandle === comment.author_handle;
  return (
    <div className="bg-bg-content rounded border border-line-soft/60 px-2.5 py-2 space-y-1.5">
      <div className="flex items-baseline gap-2 text-[10.5px]">
        <span className="font-medium text-text-1">{comment.author_handle}</span>
        <span className="text-text-5">
          {formatTimestamp(comment.created_at)}
          {edited && <span className="italic"> · edited</span>}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {onReply && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onReply}
              className="px-1 text-[10.5px] text-text-5 hover:text-text-2"
            >
              Reply
            </Button>
          )}
          {isOwner && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onStartEdit}
                disabled={busy}
                className="px-1 text-[10.5px] text-text-5 hover:text-text-2"
              >
                Edit
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onDelete}
                disabled={busy}
                className="px-1 text-[10.5px] text-text-5 hover:text-rose-400"
              >
                Delete
              </Button>
            </>
          )}
        </div>
      </div>
      {isEditing ? (
        <div className="space-y-1.5">
          <textarea
            value={editingDraft}
            onChange={(e) => onChangeDraft(e.target.value)}
            rows={2}
            className="w-full bg-bg-1 border border-line-soft rounded px-2 py-1 text-[12px] text-text-1 focus:outline-none focus:border-line resize-y min-h-[3rem]"
          />
          <div className="flex items-center gap-2 justify-end">
            <Button
              type="button"
              variant="subtle"
              size="xs"
              onClick={onCancelEdit}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="accentSoft"
              size="xs"
              onClick={onCommitEdit}
              disabled={busy || editingDraft.trim().length === 0}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <TaskMarkdown source={comment.body} members={members} />
      )}
    </div>
  );
}

// ── Building blocks ────────────────────────────────────────────────

// Two looks share one card recipe. The default `"rail"` is byte-for-byte
// the original chrome used by the 400px sidebar (TaskDetailSidePanel) and
// the slide-in peek (TaskPeekOverlay) — flat bordered cards on bg-content.
// `"page"` is the calm, flat look the full-page TaskDetailPane opts into:
// NO box at all — just a quiet uppercase section label over its content,
// the way Linear/Notion lay out an issue. The caller owns separation
// (hairline dividers + breathing room) so the surface reads as one calm
// column instead of boxes-stacked-in-boxes. Omitting the prop keeps the
// rail/peek surfaces untouched.
export type CardVariant = "rail" | "page";

// Medusa-inspired card chrome (rail variant only). The signature is a
// layered box-shadow "border" — a crisp 1px ring drawn in --color-line-soft
// plus a subtle drop shadow — so the surface reads as gently raised against
// the slightly darker bg-1 aside, rather than a flat hairline border. Paired
// with bg-bg-content + rounded-[8px] (Medusa radius-lg, a touch larger than
// our default 4px lg). Defined once so every rail card stays consistent.
const RAIL_CARD_SHADOW =
  "0 0 0 1px var(--color-line-soft), 0 1px 2px 0 rgba(0, 0, 0, 0.40)";

function Card({
  title,
  count,
  right,
  children,
  variant = "rail",
}: {
  title: string;
  count?: number;
  right?: ReactNode;
  children: ReactNode;
  variant?: CardVariant;
}) {
  if (variant === "page") {
    return (
      <section>
        <header className="flex items-center gap-2 mb-2.5">
          <span className="text-[10.5px] uppercase tracking-[0.09em] text-text-4 font-semibold">
            {title}
          </span>
          {typeof count === "number" && (
            <span className="text-[10.5px] text-text-5 tabular-nums">{count}</span>
          )}
          <div className="ml-auto">{right}</div>
        </header>
        <div className="text-[12.5px]">{children}</div>
      </section>
    );
  }
  return (
    <section
      className="rounded-[8px] bg-bg-content overflow-hidden"
      style={{ boxShadow: RAIL_CARD_SHADOW }}
    >
      <header className="flex items-center gap-2 px-3.5 h-9 border-b border-line-soft/60">
        <span className="text-[12px] font-medium text-text-1">{title}</span>
        {typeof count === "number" && (
          <span className="text-[11px] text-text-4 tabular-nums">{count}</span>
        )}
        <div className="ml-auto">{right}</div>
      </header>
      <div className="px-3.5 py-3">{children}</div>
    </section>
  );
}

// Plane `.prop` row — grid 80px / 1fr, gap 10px, 12px font. Key in
// tertiary text, value in primary. Mirrors peek-side properties pattern
// (mockup line 1151-1168). Falls back to flex-col stack when the
// available width is too tight; we don't ship a media query so the
// caller can wrap if needed. The `"page"` variant nudges the type scale
// up to match the roomier full-page cards (label 11px, value 12.5px).
function Row({
  label,
  children,
  variant = "rail",
}: {
  label: string;
  children: ReactNode;
  variant?: CardVariant;
}) {
  const page = variant === "page";
  return (
    <div
      className={
        page
          ? "grid items-start gap-2.5 py-2 text-[12.5px]"
          : "grid items-start gap-2.5 py-2 text-[12.5px]"
      }
      style={{ gridTemplateColumns: "80px 1fr" }}
    >
      <span
        className={
          page
            ? "text-[11px] text-text-4 pt-1 inline-flex items-center gap-1.5"
            : "text-[11.5px] text-text-4 leading-snug pt-1 inline-flex items-center gap-1.5"
        }
      >
        {label}
      </span>
      <div className="text-text-1 min-w-0">{children}</div>
    </div>
  );
}

// ── Pure helpers ───────────────────────────────────────────────────

function labelFor<T extends { id: string; label: string }>(
  options: T[],
  id: string,
): string {
  return options.find((o) => o.id === id)?.label ?? id;
}

function formatTimestamp(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
