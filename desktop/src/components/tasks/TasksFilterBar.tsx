// The Dashboard toolbar's menus: Filter (what is shown), Sort (in what order)
// and Display (how it is grouped and what each card says), and the
// applied-filter row that says why you are not seeing everything.
//
// Both are the library's dropdown menus with nested submenus, so a filter
// menu and a context menu are the same object. Multi-choice rows keep the
// menu open so several values can be ticked in one visit.

import { useMemo } from "react";
import { ArrowDownUp, ChevronDown, Filter as FilterIcon, SlidersHorizontal, X } from "lucide-react";

import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TASK_STATUS, TASK_STATUS_ORDER } from "../../lib/taskStatus";
import type {
  TaskPriority,
  TaskStatus,
  TaskViewDisplayProp,
  TaskViewFilters,
  TaskViewGroupBy,
  TaskViewOrderBy,
  TaskViewOrderDir,
  TeamMember,
} from "../../lib/api";

export const STATUS_LABEL: Record<TaskStatus, string> = Object.fromEntries(
  TASK_STATUS_ORDER.map((id) => [id, TASK_STATUS[id].label]),
) as Record<TaskStatus, string>;

/** Priorities in menu order: most urgent first, none last. */
export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
};

const AGENT_OPTIONS: { id: string; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "gemini", label: "Gemini" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
];

const GROUP_BY_OPTIONS: { id: TaskViewGroupBy; label: string }[] = [
  { id: "none", label: "None" },
  { id: "status", label: "Status" },
  { id: "priority", label: "Priority" },
  { id: "assignee", label: "Assignee" },
  { id: "goal", label: "Goal" },
  { id: "label", label: "Label" },
];

const ORDER_DIR_OPTIONS: { id: TaskViewOrderDir; label: string }[] = [
  { id: "asc", label: "Ascending" },
  { id: "desc", label: "Descending" },
];

const ORDER_BY_OPTIONS: { id: TaskViewOrderBy; label: string }[] = [
  { id: "updated", label: "Last updated" },
  { id: "created", label: "Created" },
  { id: "priority", label: "Priority" },
  { id: "due", label: "Due date" },
  { id: "estimate", label: "Estimate" },
  { id: "title", label: "Title" },
];

export const DISPLAY_PROP_OPTIONS: { id: TaskViewDisplayProp; label: string }[] = [
  { id: "id", label: "ID (AURA-…)" },
  { id: "assignee", label: "Assignee" },
  { id: "agent", label: "Agent" },
  { id: "priority", label: "Priority" },
  { id: "due", label: "Due date" },
  { id: "start", label: "Start date" },
  { id: "labels", label: "Labels" },
  { id: "estimate", label: "Estimate" },
  { id: "pr", label: "Linked PR" },
  { id: "updated", label: "Updated" },
];

export const DEFAULT_DISPLAY_PROPS: TaskViewDisplayProp[] = [
  "id",
  "assignee",
  "priority",
  "due",
  "labels",
];

type ListDim = "status" | "priority" | "assignee" | "agent" | "labels";

/** Filter and Display, as the toolbar's two quiet menu buttons. */
export function TasksControls({
  filters,
  onFilters,
  groupBy,
  onGroupBy,
  orderBy,
  onOrderBy,
  orderDir,
  onOrderDir,
  displayProps,
  onDisplayProps,
  members,
  allLabels,
}: {
  filters: TaskViewFilters;
  onFilters: (next: TaskViewFilters) => void;
  groupBy: TaskViewGroupBy;
  onGroupBy: (g: TaskViewGroupBy) => void;
  orderBy: TaskViewOrderBy;
  onOrderBy: (o: TaskViewOrderBy) => void;
  orderDir: TaskViewOrderDir;
  onOrderDir: (d: TaskViewOrderDir) => void;
  displayProps: TaskViewDisplayProp[];
  onDisplayProps: (p: TaskViewDisplayProp[]) => void;
  members: TeamMember[];
  /** Every label on the board, deduped — the label submenu's choices. */
  allLabels: string[];
}) {
  const total = filterCount(filters) - (filters.q?.trim() ? 1 : 0);
  function toggle(dim: ListDim, value: string, on: boolean) {
    const cur = ((filters[dim] as string[] | undefined) ?? []).filter((v) => v !== value);
    if (on) cur.push(value);
    onFilters({ ...filters, [dim]: cur.length === 0 ? undefined : (cur as never) });
  }
  const checked = (dim: ListDim, value: string) =>
    ((filters[dim] as string[] | undefined) ?? []).includes(value);
  const section = (
    title: string,
    dim: ListDim,
    options: { id: string; label: string }[],
  ) => (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {title}
        {options.some((o) => checked(dim, o.id)) && (
          <span className="ui-menu-shortcut">
            {options.filter((o) => checked(dim, o.id)).length}
          </span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="ui-tasks-filter-sub">
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.id}
            checked={checked(dim, o.id)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) => toggle(dim, o.id, on === true)}
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
  const people = [
    { id: "@me", label: "@me" },
    ...members.slice(0, 30).map((m) => ({ id: m.handle || m.email, label: `@${m.handle || m.email}` })),
  ];
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            data-active={total > 0}
            title="Narrow the board down to the work you want to see"
          >
            <FilterIcon />
            Filter
            {total > 0 && <span className="ui-tasks-filter-count">{total}</span>}
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {section(
            "Status",
            "status",
            TASK_STATUS_ORDER.map((s) => ({ id: s, label: STATUS_LABEL[s] })),
          )}
          {section(
            "Priority",
            "priority",
            (Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => ({ id: p, label: PRIORITY_LABEL[p] })),
          )}
          {section("Assignee", "assignee", people)}
          {section("Agent", "agent", AGENT_OPTIONS)}
          {allLabels.length > 0 &&
            section(
              "Labels",
              "labels",
              allLabels.slice(0, 40).map((l) => ({ id: l, label: l })),
            )}
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={filters.overdue === true}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) => onFilters({ ...filters, overdue: on === true ? true : undefined })}
          >
            Overdue
          </DropdownMenuCheckboxItem>
          {total > 0 && (
            <DropdownMenuItem onSelect={() => onFilters(filters.q ? { q: filters.q } : {})}>
              Clear filters
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" aria-label="Sort tasks">
            <ArrowDownUp />
            {ORDER_BY_OPTIONS.find((o) => o.id === orderBy)?.label}
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {ORDER_BY_OPTIONS.map((o) => (
            <DropdownMenuItem key={o.id} onSelect={() => onOrderBy(o.id)}>
              {o.label}
              {orderBy === o.id && <span className="ui-menu-shortcut">✓</span>}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {ORDER_DIR_OPTIONS.map((o) => (
            <DropdownMenuItem key={o.id} onSelect={() => onOrderDir(o.id)}>
              {o.label}
              {orderDir === o.id && <span className="ui-menu-shortcut">✓</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost">
            <SlidersHorizontal />
            Display
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              Group by
              <span className="ui-menu-shortcut">
                {GROUP_BY_OPTIONS.find((o) => o.id === groupBy)?.label}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {GROUP_BY_OPTIONS.map((o) => (
                <DropdownMenuItem key={o.id} onSelect={() => onGroupBy(o.id)}>
                  {o.label}
                  {groupBy === o.id && <span className="ui-menu-shortcut">✓</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Show on cards</DropdownMenuLabel>
          {DISPLAY_PROP_OPTIONS.map((o) => (
            <DropdownMenuCheckboxItem
              key={o.id}
              checked={displayProps.includes(o.id)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(on) => {
                const set = new Set(displayProps);
                if (on === true) set.add(o.id);
                else set.delete(o.id);
                onDisplayProps(DISPLAY_PROP_OPTIONS.map((p) => p.id).filter((id) => set.has(id)));
              }}
            >
              {o.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** One chip per filter in force, then Clear all. Nothing when nothing is
 *  filtered: the row exists to say why you aren't seeing everything. */
export function TasksAppliedFilters({
  filters,
  onFilters,
  members,
}: {
  filters: TaskViewFilters;
  onFilters: (next: TaskViewFilters) => void;
  members: TeamMember[];
}) {
  const chips = useMemo(() => appliedChips(filters, members), [filters, members]);
  if (chips.length === 0) return null;
  function remove(dim: keyof TaskViewFilters, value: string) {
    if (dim === "overdue" || dim === "q") {
      onFilters({ ...filters, [dim]: undefined });
      return;
    }
    const out = ((filters[dim] as string[] | undefined) ?? []).filter((v) => v !== value);
    onFilters({ ...filters, [dim]: out.length === 0 ? undefined : (out as never) });
  }
  return (
    <div className="ui-tasks-applied" aria-label="Filters in force">
      {chips.map((c) => (
        <span key={`${c.dim}:${c.value}`} className="ui-tasks-applied-chip">
          {c.keyLabel}: <strong>{c.valLabel}</strong>
          <button
            type="button"
            onClick={() => remove(c.dim, c.value)}
            aria-label={`Remove ${c.keyLabel}: ${c.valLabel}`}
            title={`Remove ${c.keyLabel}: ${c.valLabel}`}
          >
            <X size={12} aria-hidden />
          </button>
        </span>
      ))}
      <Button size="xs" variant="ghost" onClick={() => onFilters({})}>
        Clear all
      </Button>
    </div>
  );
}

function appliedChips(filters: TaskViewFilters, members: TeamMember[]) {
  const out: { dim: keyof TaskViewFilters; value: string; keyLabel: string; valLabel: string }[] = [];
  for (const s of filters.status ?? [])
    out.push({ dim: "status", value: s, keyLabel: "Status", valLabel: STATUS_LABEL[s] });
  for (const p of filters.priority ?? [])
    out.push({ dim: "priority", value: p, keyLabel: "Priority", valLabel: PRIORITY_LABEL[p] });
  for (const a of filters.assignee ?? []) {
    const m = members.find((x) => (x.handle || x.email) === a);
    out.push({
      dim: "assignee",
      value: a,
      keyLabel: "Assignee",
      valLabel: a === "@me" ? "@me" : `@${m?.handle ?? a}`,
    });
  }
  for (const ag of filters.agent ?? [])
    out.push({ dim: "agent", value: ag, keyLabel: "Agent", valLabel: ag });
  for (const l of filters.labels ?? [])
    out.push({ dim: "labels", value: l, keyLabel: "Label", valLabel: l });
  if (filters.overdue) out.push({ dim: "overdue", value: "1", keyLabel: "Due", valLabel: "Overdue" });
  if (filters.q?.trim()) out.push({ dim: "q", value: filters.q, keyLabel: "Search", valLabel: filters.q });
  return out;
}

export function filterCount(f: TaskViewFilters): number {
  let n = 0;
  if (f.status?.length) n += f.status.length;
  if (f.priority?.length) n += f.priority.length;
  if (f.assignee?.length) n += f.assignee.length;
  if (f.agent?.length) n += f.agent.length;
  if (f.labels?.length) n += f.labels.length;
  if (f.q && f.q.trim()) n += 1;
  if (f.overdue) n += 1;
  return n;
}
