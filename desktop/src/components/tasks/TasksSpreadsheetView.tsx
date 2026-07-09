// TasksSpreadsheetView — OO.2 Phase 2 (Plane parity).
//
// Dense, table-shaped layout for power users. Columns are driven by
// the active view's `display_props` so the user controls what they
// see; cell editors are inline (state / priority / assignee) so you
// rarely need to open the detail panel.
//
// "Virtualized" here is light-touch — we slice the rows by a window
// driven from `onScroll`. The task count we expect to see in a single
// repo is well under 10k; full DOM rendering up to that scale is
// fine, but the slice keeps GPU cost flat as the count climbs and
// avoids dragging in a heavy `react-virtual` dep we don't yet use.
//
// State editors use the same `tasks_update` pipe as the kanban, so
// any edit propagates back to the parent through `onPatch` (which
// also updates the local `tasks` array). No drift.

import { useEffect, useMemo, useRef, useState } from "react";
import { onExternalAnchorClick } from "../../lib/openExternal";
import { Bot, ChevronDown, GitBranch } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";
import { cn } from "../../lib/utils";
import { MENU_PANEL, MENU_ROW } from "../ui/menuSurface";
import {
  type Task,
  type TaskPriority,
  type TaskStatus,
  type TaskViewDisplayProp,
  type TeamMember,
  type UpdateTaskInput,
} from "../../lib/api";
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
} from "./TasksFilterBar";
import {
  PRIORITY_CHIP,
  StatusChip,
  TASK_STATE_CHIP,
} from "../ui/statusChip";
import { Button } from "../ui/button";
import { AssigneeStack } from "../AssigneePicker";
import {
  InteractiveTable,
  InteractiveTableRowHandle,
} from "./InteractiveTable";

// RR.2 — order must match TaskViewDisplayProp; surfaces all available
// columns in the add-col popover with a human-readable label.
const ALL_DISPLAY_PROPS: TaskViewDisplayProp[] = [
  "id",
  "assignee",
  "priority",
  "due",
  "start",
  "labels",
  "estimate",
  "agent",
  "pr",
  "updated",
];

const ROW_HEIGHT = 32;
const OVERSCAN = 8;

const AGENT_TINT: Record<string, string> = {
  claude: "rgb(217, 119, 87)",
  gemini: "rgb(96, 165, 250)",
  codex: "rgb(132, 204, 168)",
  opencode: "rgb(192, 132, 252)",
};

type ColumnId = "title" | TaskViewDisplayProp;

type Props = {
  tasks: Task[];
  members: TeamMember[];
  displayProps: TaskViewDisplayProp[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPatch: (input: UpdateTaskInput) => Promise<void> | void;
  /** RR.2 — inline quick-create from the bottom add-row pill. When
   *  omitted, the pill is hidden. Accepts the typed title; status
   *  defaults to backlog on the backend. */
  onCreate?: (title: string) => Promise<void> | void;
  /** RR.2 — column add/remove. When provided the right-edge add-col
   *  pill is rendered; click opens a popover of the columns not
   *  currently shown. */
  onDisplayPropsChange?: (next: TaskViewDisplayProp[]) => void;
};

export function TasksSpreadsheetView({
  tasks,
  members,
  displayProps,
  selectedId,
  onSelect,
  onPatch,
  onCreate,
  onDisplayPropsChange,
}: Props) {
  // Title is always first; remaining columns follow display-prop order.
  // We dedupe in case `id` accidentally appears in displayProps twice.
  const columns: ColumnId[] = useMemo(() => {
    const seen = new Set<ColumnId>(["title"]);
    const out: ColumnId[] = ["title"];
    for (const p of displayProps) {
      if (!seen.has(p)) {
        out.push(p);
        seen.add(p);
      }
    }
    return out;
  }, [displayProps]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  // Compute the visible slice. The header row is sticky outside the
  // virtual area, so the math operates on the body's scroll offset only.
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const count = viewportH > 0 ? Math.ceil(viewportH / ROW_HEIGHT) + OVERSCAN * 2 : tasks.length;
  const end = Math.min(tasks.length, start + count);
  const slice = tasks.slice(start, end);
  const padTop = start * ROW_HEIGHT;
  const padBottom = Math.max(0, (tasks.length - end) * ROW_HEIGHT);

  // Track viewport on mount + resize so the slice math works.
  function bindContainer(el: HTMLDivElement | null) {
    containerRef.current = el;
    if (el) setViewportH(el.clientHeight);
  }

  // RR.2 — inline add-row state. When `adding` is true a blank row
  // renders at the bottom with the title input focused; commit on
  // Enter, dismiss on Esc / blur-empty. Hoisting this into the
  // component (rather than rendering an extra portal row) keeps the
  // create flow in the same scroll context as the rest of the table.
  const [adding, setAdding] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addColOpen, setAddColOpen] = useState(false);
  const addInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (adding) addInputRef.current?.focus();
  }, [adding]);

  const availableProps = useMemo(
    () => ALL_DISPLAY_PROPS.filter((p) => !displayProps.includes(p)),
    [displayProps],
  );

  // Direct sub-task count per task id — drives the light branch-count
  // chip in the title cell. Computed once over the full list (cheap;
  // O(n)) rather than per-row so the table stays flat. A task counts a
  // child when its `parent_id` (or legacy `epic_id`) points back here.
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tasks) {
      const parent = t.parent_id ?? t.epic_id;
      if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
    }
    return counts;
  }, [tasks]);

  async function commitAdd() {
    const t = addTitle.trim();
    if (!t || !onCreate) {
      setAdding(false);
      setAddTitle("");
      return;
    }
    await onCreate(t);
    setAddTitle("");
    // Keep adding mode on for rapid sequential creates — Plane's
    // pattern. User dismisses with Esc.
  }

  // Total column count, including the leading handle cell. Pad rows
  // need to span the same width so the virtual scroll math doesn't
  // visually collapse cells.
  const totalCols = columns.length + 1;

  const empty = tasks.length === 0;

  return (
    <div
      ref={bindContainer}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      className="relative h-full w-full overflow-auto"
    >
      <InteractiveTable
        onAddRow={onCreate ? () => setAdding(true) : undefined}
        onAddColumn={
          onDisplayPropsChange && availableProps.length > 0
            ? () => setAddColOpen((v) => !v)
            : undefined
        }
      >
        {empty && !adding ? (
          <div className="py-6 text-[12px] text-text-5 italic">
            No tasks match the current filters.
          </div>
        ) : (
          <table className="w-full text-[13px] border-collapse">
            <thead className="text-[11px] uppercase tracking-[0.04em] text-text-5 sticky top-0 bg-bg-1 z-10 border-b-[0.5px] border-line-soft">
              <tr>
                <th
                  aria-hidden
                  className="w-[24px] px-1 py-2 font-medium"
                />
                {columns.map((c) => (
                  <th
                    key={c}
                    className={cn(
                      "group/th text-left px-3 py-2 font-medium whitespace-nowrap",
                      columnWidth(c),
                    )}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span>{columnLabel(c)}</span>
                      {onDisplayPropsChange && c !== "title" && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() =>
                            onDisplayPropsChange(
                              displayProps.filter((p) => p !== c),
                            )
                          }
                          aria-label={`Remove ${columnLabel(c)} column`}
                          className="h-4 w-4 text-text-5 hover:text-text-3 text-[11px] leading-none opacity-0 group-hover/th:opacity-100"
                        >
                          ×
                        </Button>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {padTop > 0 && (
                <tr aria-hidden style={{ height: padTop }}>
                  <td colSpan={totalCols} />
                </tr>
              )}
              {slice.map((t) => (
                <SpreadsheetRow
                  key={t.id}
                  task={t}
                  columns={columns}
                  members={members}
                  childCount={childCounts.get(t.id) ?? 0}
                  selected={t.id === selectedId}
                  onSelect={() => onSelect(t.id)}
                  onPatch={onPatch}
                />
              ))}
              {padBottom > 0 && (
                <tr aria-hidden style={{ height: padBottom }}>
                  <td colSpan={totalCols} />
                </tr>
              )}
              {adding && onCreate && (
                <tr
                  style={{ height: ROW_HEIGHT }}
                  className="border-t-[0.5px] border-line-soft bg-bg-1"
                >
                  <td className="w-[24px] px-1" />
                  <td
                    colSpan={columns.length}
                    className="px-3 py-[7px]"
                  >
                    <input
                      ref={addInputRef}
                      type="text"
                      value={addTitle}
                      placeholder="New task title — Enter to add, Esc to cancel"
                      onChange={(e) => setAddTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void commitAdd();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setAdding(false);
                          setAddTitle("");
                        }
                      }}
                      onBlur={() => {
                        if (!addTitle.trim()) setAdding(false);
                      }}
                      className="w-full bg-transparent text-[12px] text-text-1 placeholder:text-text-5 border-none focus:outline-none"
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </InteractiveTable>
      {onDisplayPropsChange && addColOpen && (
        <AddColumnPopover
          available={availableProps}
          onPick={(p) => {
            onDisplayPropsChange([...displayProps, p]);
            setAddColOpen(false);
          }}
          onClose={() => setAddColOpen(false)}
        />
      )}
    </div>
  );
}

function AddColumnPopover({
  available,
  onPick,
  onClose,
}: {
  available: TaskViewDisplayProp[];
  onPick: (p: TaskViewDisplayProp) => void;
  onClose: () => void;
}) {
  // Absolute-positioned simple list. We use a Popover trigger model
  // for the cell editors but the add-col anchor lives in the
  // InteractiveTable chrome (outside this component), so we render a
  // small dismissible card anchored to the top-right of the
  // container instead. Click outside dismisses via the backdrop.
  return (
    <>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default"
      />
      <div
        role="menu"
        className={cn(MENU_PANEL, "absolute right-6 top-10 w-[160px]")}
      >
        {available.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className={MENU_ROW}
          >
            {columnLabel(p)}
          </button>
        ))}
      </div>
    </>
  );
}

function SpreadsheetRow({
  task,
  columns,
  members,
  childCount,
  selected,
  onSelect,
  onPatch,
}: {
  task: Task;
  columns: ColumnId[];
  members: TeamMember[];
  /** Direct sub-task count — renders a light branch chip in the title cell. */
  childCount: number;
  selected: boolean;
  onSelect: () => void;
  onPatch: (input: UpdateTaskInput) => Promise<void> | void;
}) {
  return (
    <tr
      style={{ height: ROW_HEIGHT }}
      onClick={onSelect}
      data-task-id={task.id}
      className={cn(
        "group border-t-[0.5px] border-line-soft cursor-pointer transition-colors",
        selected ? "bg-bg-2" : "hover:bg-bg-1",
      )}
    >
      <td
        className="w-[24px] px-1 align-middle"
        onClick={(e) => e.stopPropagation()}
      >
        <InteractiveTableRowHandle />
      </td>
      {columns.map((c) => (
        <td
          key={c}
          className="px-3 py-[7px] align-middle truncate"
        >
          {renderCell(c, task, members, onPatch, childCount)}
        </td>
      ))}
    </tr>
  );
}

function renderCell(
  col: ColumnId,
  task: Task,
  members: TeamMember[],
  onPatch: (input: UpdateTaskInput) => Promise<void> | void,
  childCount = 0,
): React.ReactNode {
  switch (col) {
    case "title":
      return (
        <div className="flex items-center gap-2 min-w-0">
          {task.sequence_id > 0 && (
            <span className="font-mono text-[10px] text-text-5 tabular-nums shrink-0">
              AURA-{task.sequence_id}
            </span>
          )}
          <span className="text-text-1 truncate">
            {task.title || "(untitled)"}
          </span>
          {childCount > 0 && (
            <span
              className="inline-flex items-center gap-0.5 shrink-0 text-[10px] tabular-nums text-text-4 px-1 rounded bg-bg-2 border-[0.5px] border-line-soft"
              title={`${childCount} sub-task${childCount === 1 ? "" : "s"}`}
            >
              <GitBranch className="w-2.5 h-2.5" strokeWidth={1.75} aria-hidden />
              {childCount}
            </span>
          )}
        </div>
      );
    case "id":
      return task.sequence_id > 0 ? (
        <span className="font-mono text-[10px] text-text-5 tabular-nums">
          AURA-{task.sequence_id}
        </span>
      ) : (
        <span className="text-text-5">—</span>
      );
    case "assignee":
      // OO.3 — route through assignee_ids. The cell renders an
      // avatar stack when multi-assigned; clicking it opens the
      // multi-select picker (toggle semantics, stays open across
      // clicks). Patches send the whole list back through
      // assignee_ids.
      return (
        <AssigneeCell
          values={task.assignee_ids}
          members={members}
          onChange={(handles) =>
            void onPatch({ id: task.id, assignee_ids: handles })
          }
        />
      );
    case "priority":
      return (
        <PriorityCell
          value={task.priority}
          onChange={(v) => void onPatch({ id: task.id, priority: v })}
        />
      );
    case "due":
      return (
        <DateCell
          value={task.due_date ?? ""}
          onChange={(v) => void onPatch({ id: task.id, due_date: v })}
        />
      );
    case "start":
      return (
        <DateCell
          value={task.start_date ?? ""}
          onChange={(v) => void onPatch({ id: task.id, start_date: v })}
        />
      );
    case "labels":
      return task.labels.length > 0 ? (
        <div className="flex gap-1 flex-wrap">
          {task.labels.slice(0, 3).map((l) => (
            <span
              key={l}
              className="text-[9.5px] uppercase tracking-wider text-text-4 px-1 rounded bg-bg-2 border border-line-soft"
            >
              {l}
            </span>
          ))}
          {task.labels.length > 3 && (
            <span className="text-[9.5px] text-text-5">
              +{task.labels.length - 3}
            </span>
          )}
        </div>
      ) : (
        <span className="text-text-5">—</span>
      );
    case "estimate":
      return task.estimate != null ? (
        <span className="text-text-3 tabular-nums">{task.estimate}h</span>
      ) : (
        <span className="text-text-5">—</span>
      );
    case "agent":
      return task.agent_assignee ? (
        <span
          className="inline-flex items-center gap-1 text-[10px] px-1 rounded uppercase tracking-wider"
          style={{
            background: `${AGENT_TINT[task.agent_assignee] ?? "rgb(160,160,160)"}25`,
            color: AGENT_TINT[task.agent_assignee] ?? "rgb(200,200,200)",
          }}
        >
          <Bot className="w-3 h-3" strokeWidth={1.5} aria-hidden />
          {task.agent_assignee}
        </span>
      ) : (
        <span className="text-text-5">—</span>
      );
    case "pr":
      return task.linked_pr ? (
        <a
          href={task.linked_pr.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.stopPropagation();
            onExternalAnchorClick(e);
          }}
          className="font-mono text-text-3 hover:text-text-1"
        >
          #{task.linked_pr.number}
        </a>
      ) : (
        <span className="text-text-5">—</span>
      );
    case "updated":
      return (
        <span className="text-text-5 font-mono text-[10.5px]">
          {formatDate(task.updated_at)}
        </span>
      );
  }
  return null;
}

// ─── inline editors ────────────────────────────────────────────────────

function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <StatusChip tone={TASK_STATE_CHIP[status].tone} dot dense>
      {STATUS_LABEL[status]}
    </StatusChip>
  );
}

function PriorityCell({
  value,
  onChange,
}: {
  value: TaskPriority;
  onChange: (v: TaskPriority) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex"
          aria-label="Change priority"
        >
          <StatusChip
            tone={PRIORITY_CHIP[value].tone}
            dot
            dense
            icon={
              <ChevronDown
                className="w-2.5 h-2.5 order-last"
                strokeWidth={1.5}
                aria-hidden
              />
            }
          >
            {PRIORITY_LABEL[value]}
          </StatusChip>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[140px] p-1"
        onClick={(e) => e.stopPropagation()}
      >
        {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              onChange(p);
              setOpen(false);
            }}
            className={cn(
              "w-full text-left px-2 py-1.5 text-[13px] rounded-md hover:bg-bg-2 hover:text-text-1",
              p === value ? "text-text-1" : "text-text-2",
            )}
          >
            {PRIORITY_LABEL[p]}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// OO.3 — multi-assignee cell. Trigger renders an avatar stack
// (overlapping circles, "+N" overflow) when more than one handle is
// set; collapses to "@handle" when only one; "—" when empty. The
// popover toggles membership (Plane semantics) so the user can pick
// multiple without reopening.
function AssigneeCell({
  values,
  members,
  onChange,
}: {
  values: string[];
  members: TeamMember[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedSet = useMemo(() => new Set(values), [values]);
  const resolved = useMemo(
    () =>
      values.map(
        (h) =>
          members.find((m) => m.handle === h) ??
          ({ handle: h, name: h, commits: 0, last_seen: 0 } as TeamMember),
      ),
    [values, members],
  );
  function toggle(handle: string) {
    if (selectedSet.has(handle)) {
      onChange(values.filter((v) => v !== handle));
    } else {
      onChange([...values, handle]);
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="text-[11px] text-text-3 hover:text-text-1 truncate max-w-[160px] inline-flex items-center gap-1.5"
        >
          {resolved.length === 0 ? (
            <span className="text-text-5">—</span>
          ) : resolved.length === 1 ? (
            <>@{resolved[0]!.handle}</>
          ) : (
            <>
              <AssigneeStack
                handles={values}
                members={members}
                dense
                maxAvatars={2}
              />
              <span className="text-[10px] text-text-5">
                {resolved.length} people
              </span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[220px] p-1 max-h-[280px] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => onChange([])}
          className="w-full text-left px-2 py-1.5 text-[13px] rounded-md text-text-2 hover:bg-bg-2 hover:text-text-1"
        >
          — clear all —
        </button>
        {members.map((m) => {
          const h = m.handle || m.email;
          const isSelected = selectedSet.has(h);
          return (
            <button
              key={h}
              type="button"
              onClick={() => toggle(h)}
              className={cn(
                "w-full text-left px-2 py-1.5 text-[13px] rounded-md hover:bg-bg-2 hover:text-text-1 font-mono truncate flex items-center justify-between",
                isSelected ? "text-text-1" : "text-text-2",
              )}
            >
              <span className="truncate">@{h}</span>
              {isSelected && (
                <span className="text-accent text-[10px]" aria-hidden>
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function DateCell({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      type="date"
      value={value || ""}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      className="bg-transparent text-[11px] text-text-3 hover:text-text-1 border-none focus:outline-none w-[120px]"
    />
  );
}

export function SpreadsheetStatusBadge({ status }: { status: TaskStatus }) {
  return <StatusBadge status={status} />;
}

// ─── helpers ───────────────────────────────────────────────────────────

function columnLabel(c: ColumnId): string {
  switch (c) {
    case "title":
      return "Title";
    case "id":
      return "ID";
    case "assignee":
      return "Assignee";
    case "agent":
      return "Agent";
    case "priority":
      return "Priority";
    case "due":
      return "Due";
    case "start":
      return "Start";
    case "labels":
      return "Labels";
    case "estimate":
      return "Estimate";
    case "pr":
      return "PR";
    case "updated":
      return "Updated";
  }
}

function columnWidth(c: ColumnId): string {
  switch (c) {
    case "title":
      return "min-w-[280px]";
    case "labels":
      return "min-w-[160px]";
    case "id":
      return "w-[90px]";
    case "priority":
      return "w-[110px]";
    case "estimate":
      return "w-[80px]";
    case "pr":
      return "w-[80px]";
    default:
      return "min-w-[120px]";
  }
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
