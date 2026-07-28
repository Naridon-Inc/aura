// TasksFilterBar — OO.2 Phase 2 (Plane parity).
//
// Compact chrome row above the kanban: removable filter chips for
// state / priority / assignee / agent / labels / free-text search,
// plus three pickers — Group by, Order by (with asc/desc toggle), and
// Display Properties. Mirrors Plane's chip/menu grammar without
// copying its source.
//
// Empty state collapses everything into a single "+ Filter" pill so
// the bar disappears visually when no filters are active. Click a
// chip to remove that single value; click the wrench-like Display
// Properties button to pick which fields render on cards / columns.
//
// State is driven from above (TasksBoard) — this component never
// owns filter values, it just renders + emits changes. That keeps the
// Saved Views save flow trivial: just dump the current props.
//
// Display Properties + Group/Order pickers are rendered as Radix
// Popovers (UI primitives at `components/ui/popover.tsx`) so they
// portal to body and don't clip inside the workpane.

import { useMemo, useState } from "react";
import {
  ChevronDown,
  Filter as FilterIcon,
  SlidersHorizontal,
  X,
  Search,
  Plus,
  Group as GroupIcon,
  ArrowUpDown,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../../lib/utils";
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

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

// OO.3 — 5-stop priority labels. Listed in render order so the
// filter popover surfaces `urgent` first and `none` last, matching
// Plane and Linear.
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
  { id: "opencode", label: "Opencode" },
];

const GROUP_BY_OPTIONS: { id: TaskViewGroupBy; label: string }[] = [
  { id: "none", label: "None" },
  { id: "status", label: "Status" },
  { id: "priority", label: "Priority" },
  { id: "assignee", label: "Assignee" },
  { id: "label", label: "Label" },
];

const ORDER_BY_OPTIONS: { id: TaskViewOrderBy; label: string }[] = [
  { id: "updated", label: "Last updated" },
  { id: "created", label: "Created" },
  { id: "priority", label: "Priority" },
  { id: "due", label: "Due date" },
  { id: "estimate", label: "Estimate" },
  { id: "title", label: "Title" },
];

export const DISPLAY_PROP_OPTIONS: {
  id: TaskViewDisplayProp;
  label: string;
}[] = [
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

type Props = {
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
  /** All labels currently present in the workspace, deduped — used to
   *  drive the label picker. Compute in TasksBoard from the task list. */
  allLabels: string[];
  /** Compact mode hides the Group/Order pickers (used by spreadsheet
   *  view where the table columns drive ordering). */
  compact?: boolean;
};

export function TasksFilterBar({
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
  compact = false,
}: Props) {
  const hasAny = useMemo(() => filterCount(filters) > 0, [filters]);

  function patch(next: Partial<TaskViewFilters>) {
    onFilters({ ...filters, ...next });
  }

  function remove(dim: keyof TaskViewFilters, value: string) {
    const cur = (filters[dim] as string[] | undefined) ?? [];
    const out = cur.filter((v) => v !== value);
    patch({ [dim]: out.length === 0 ? undefined : (out as never) });
  }

  function clearAll() {
    onFilters({});
  }

  return (
    <div className="px-4 sm:px-6 py-2 flex items-center flex-wrap gap-2 bg-bg-content">
      {/* Search — always visible, doubles as the empty-state anchor */}
      <SearchInput
        value={filters.q ?? ""}
        onChange={(q) => patch({ q: q.trim() === "" ? undefined : q })}
      />

      {/* Filter trigger — dashed "+ Add filter" pill when empty,
       *  solid pill when at least one chip is set. */}
      <FilterPopover
        filters={filters}
        onFilters={onFilters}
        members={members}
        allLabels={allLabels}
      />

      {/* Active chips */}
      <ChipRow filters={filters} onRemove={remove} members={members} />

      {hasAny && (
        <Button
          variant="link"
          onClick={clearAll}
          className="h-auto px-1 text-[10.5px] text-text-5 hover:text-text-2 underline-offset-2"
        >
          clear
        </Button>
      )}

      <div className="flex-1" />

      {!compact && (
        <GroupOrderControls
          groupBy={groupBy}
          onGroupBy={onGroupBy}
          orderBy={orderBy}
          onOrderBy={onOrderBy}
          orderDir={orderDir}
          onOrderDir={onOrderDir}
        />
      )}

      <DisplayPropsButton
        displayProps={displayProps}
        onDisplayProps={onDisplayProps}
      />
    </div>
  );
}

function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <Search
        className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-5 pointer-events-none"
        strokeWidth={1.5}
        aria-hidden
      />
      <Input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search tasks…"
        className="h-[26px] pl-6 pr-2 text-[11.5px] w-[200px]"
      />
    </div>
  );
}

function FilterPopover({
  filters,
  onFilters,
  members,
  allLabels,
}: {
  filters: TaskViewFilters;
  onFilters: (n: TaskViewFilters) => void;
  members: TeamMember[];
  allLabels: string[];
}) {
  const [open, setOpen] = useState(false);
  function toggle<K extends keyof TaskViewFilters>(
    dim: K,
    value: string,
  ) {
    const cur = ((filters[dim] as unknown as string[] | undefined) ?? []).slice();
    const idx = cur.indexOf(value);
    if (idx === -1) cur.push(value);
    else cur.splice(idx, 1);
    onFilters({
      ...filters,
      [dim]: cur.length === 0 ? undefined : (cur as never),
    });
  }
  const total = filterCount(filters);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 h-[26px] px-2.5 text-[11px] rounded-[4px] border-[0.5px] transition-colors",
            total > 0
              ? "bg-bg-1 border-line-soft text-text-2 border-solid hover:text-text-1"
              : "bg-transparent border-dashed border-line-soft text-text-5 hover:bg-bg-2 hover:text-text-2 hover:border-line",
          )}
          title="Filter tasks"
        >
          {total > 0 ? (
            <>
              <FilterIcon className="w-3 h-3" strokeWidth={1.5} aria-hidden />
              <span>Filter</span>
              <span className="inline-flex items-center justify-center min-w-[14px] h-[14px] px-1 rounded-[2px] bg-accent/15 text-accent text-[9.5px] font-mono">
                {total}
              </span>
            </>
          ) : (
            <>
              <Plus className="w-3 h-3" strokeWidth={1.5} aria-hidden />
              <span>Add filter</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[260px] p-0 text-text-1"
      >
        <div className="max-h-[420px] overflow-y-auto">
          <Section title="Status">
            {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
              <CheckRow
                key={s}
                label={STATUS_LABEL[s]}
                checked={(filters.status ?? []).includes(s)}
                onToggle={() => toggle("status", s)}
              />
            ))}
          </Section>
          <Section title="Priority">
            {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => (
              <CheckRow
                key={p}
                label={PRIORITY_LABEL[p]}
                checked={(filters.priority ?? []).includes(p)}
                onToggle={() => toggle("priority", p)}
              />
            ))}
          </Section>
          <Section title="Assignee">
            <CheckRow
              label="@me"
              checked={(filters.assignee ?? []).includes("@me")}
              onToggle={() => toggle("assignee", "@me")}
              mono
            />
            {members.slice(0, 30).map((m) => (
              <CheckRow
                key={m.handle || m.email}
                label={`@${m.handle || m.email}`}
                checked={(filters.assignee ?? []).includes(m.handle || m.email)}
                onToggle={() => toggle("assignee", m.handle || m.email)}
                mono
              />
            ))}
          </Section>
          <Section title="Agent">
            {AGENT_OPTIONS.map((a) => (
              <CheckRow
                key={a.id}
                label={a.label}
                checked={(filters.agent ?? []).includes(a.id)}
                onToggle={() => toggle("agent", a.id)}
              />
            ))}
          </Section>
          {allLabels.length > 0 && (
            <Section title="Labels">
              {allLabels.slice(0, 40).map((l) => (
                <CheckRow
                  key={l}
                  label={l}
                  checked={(filters.labels ?? []).includes(l)}
                  onToggle={() => toggle("labels", l)}
                  mono
                />
              ))}
            </Section>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-line-soft last:border-b-0">
      <div className="px-3 pt-2 pb-1 text-[9.5px] uppercase tracking-wider text-text-5">
        {title}
      </div>
      <div className="py-0.5">{children}</div>
    </div>
  );
}

function CheckRow({
  label,
  checked,
  onToggle,
  mono = false,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "w-full text-left px-3 py-1 text-[11.5px] flex items-center gap-2 hover:bg-bg-2 transition-colors",
        mono && "font-mono",
        checked ? "text-text-1" : "text-text-3",
      )}
    >
      <span
        className={cn(
          "inline-flex w-3 h-3 rounded-sm border items-center justify-center",
          checked
            ? "bg-accent border-accent text-[color:var(--color-accent-foreground)]"
            : "bg-bg-content border-line-soft",
        )}
      >
        {checked && (
          <svg viewBox="0 0 12 12" className="w-2.5 h-2.5" aria-hidden>
            <path
              d="M2.5 6.5 L5 9 L9.5 3.5"
              stroke="currentColor"
              strokeWidth="1.6"
              fill="none"
            />
          </svg>
        )}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function ChipRow({
  filters,
  onRemove,
  members,
}: {
  filters: TaskViewFilters;
  onRemove: (dim: keyof TaskViewFilters, value: string) => void;
  members: TeamMember[];
}) {
  // Mockup spec: `<chip><k>Status:</k> <v>Done</v> <x/></chip>`
  // — key is sentence-cased + tertiary tone, value is bold + primary.
  const DIM_LABEL: Record<keyof TaskViewFilters, string> = {
    status: "Status",
    priority: "Priority",
    assignee: "Assignee",
    agent: "Agent",
    labels: "Label",
    q: "Search",
  };
  const chips: {
    dim: keyof TaskViewFilters;
    value: string;
    keyLabel: string;
    valLabel: string;
  }[] = [];
  for (const s of filters.status ?? [])
    chips.push({ dim: "status", value: s, keyLabel: DIM_LABEL.status, valLabel: STATUS_LABEL[s] });
  for (const p of filters.priority ?? [])
    chips.push({ dim: "priority", value: p, keyLabel: DIM_LABEL.priority, valLabel: PRIORITY_LABEL[p] });
  for (const a of filters.assignee ?? []) {
    const m = members.find((x) => (x.handle || x.email) === a);
    chips.push({
      dim: "assignee",
      value: a,
      keyLabel: DIM_LABEL.assignee,
      valLabel: a === "@me" ? "@me" : `@${m?.handle ?? a}`,
    });
  }
  for (const ag of filters.agent ?? [])
    chips.push({ dim: "agent", value: ag, keyLabel: DIM_LABEL.agent, valLabel: ag });
  for (const l of filters.labels ?? [])
    chips.push({ dim: "labels", value: l, keyLabel: DIM_LABEL.labels, valLabel: l });
  if (chips.length === 0) return null;
  return (
    <>
      {chips.map((c) => (
        <span
          key={`${c.dim}:${c.value}`}
          className="group inline-flex items-center gap-1.5 h-[22px] pl-2 pr-1.5 text-[11px] rounded-[4px] bg-bg-1 border-[0.5px] border-line-soft text-text-3"
        >
          <span className="text-text-5">{c.keyLabel}:</span>
          <span className="font-medium text-text-1">{c.valLabel}</span>
          <button
            type="button"
            onClick={() => onRemove(c.dim, c.value)}
            title={`Remove ${c.keyLabel}: ${c.valLabel}`}
            className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-text-5 hover:text-red hover:bg-bg-2 transition-colors"
          >
            <X className="w-2.5 h-2.5" strokeWidth={1.75} aria-hidden />
          </button>
        </span>
      ))}
    </>
  );
}

function GroupOrderControls({
  groupBy,
  onGroupBy,
  orderBy,
  onOrderBy,
  orderDir,
  onOrderDir,
}: {
  groupBy: TaskViewGroupBy;
  onGroupBy: (g: TaskViewGroupBy) => void;
  orderBy: TaskViewOrderBy;
  onOrderBy: (o: TaskViewOrderBy) => void;
  orderDir: TaskViewOrderDir;
  onOrderDir: (d: TaskViewOrderDir) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <MiniSelect
        label="Group"
        icon={<GroupIcon className="w-3 h-3" strokeWidth={1.5} aria-hidden />}
        value={groupBy}
        options={GROUP_BY_OPTIONS}
        onChange={(v) => onGroupBy(v as TaskViewGroupBy)}
      />
      <MiniSelect
        label="Order"
        icon={<ArrowUpDown className="w-3 h-3" strokeWidth={1.5} aria-hidden />}
        value={orderBy}
        options={ORDER_BY_OPTIONS}
        onChange={(v) => onOrderBy(v as TaskViewOrderBy)}
      />
      <button
        type="button"
        onClick={() => onOrderDir(orderDir === "asc" ? "desc" : "asc")}
        title={orderDir === "asc" ? "Ascending — click for descending" : "Descending — click for ascending"}
        className="inline-flex items-center justify-center w-[26px] h-[26px] text-[11px] font-mono rounded-[3px] bg-bg-2 border-[0.5px] border-line-soft text-text-3 hover:text-text-1 hover:border-line transition-colors"
      >
        {orderDir === "asc" ? "↑" : "↓"}
      </button>
    </div>
  );
}

function MiniSelect({
  label,
  icon,
  value,
  options,
  onChange,
}: {
  label: string;
  /** Small leading glyph that says what the picker controls (group vs
   *  order), replacing the old uppercase text prefix. `title` still
   *  carries the words for hover/a11y. */
  icon?: React.ReactNode;
  value: string;
  options: { id: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 h-[26px] px-2 text-[11px] rounded-[3px] bg-bg-2 border-[0.5px] border-line-soft text-text-3 hover:text-text-1 hover:border-line transition-colors [&_svg]:text-text-5"
          title={`${label} by`}
          aria-label={`${label} by`}
        >
          {icon}
          <span>{current?.label ?? value}</span>
          <ChevronDown className="w-2.5 h-2.5" strokeWidth={1.5} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        className="w-[180px] p-1 text-text-1"
      >
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => {
              onChange(o.id);
              setOpen(false);
            }}
            className={cn(
              "w-full text-left px-2 py-1 text-[11.5px] rounded hover:bg-bg-2",
              o.id === value ? "text-text-1" : "text-text-3",
            )}
          >
            {o.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function DisplayPropsButton({
  displayProps,
  onDisplayProps,
}: {
  displayProps: TaskViewDisplayProp[];
  onDisplayProps: (p: TaskViewDisplayProp[]) => void;
}) {
  const [open, setOpen] = useState(false);
  function toggle(p: TaskViewDisplayProp) {
    const set = new Set(displayProps);
    if (set.has(p)) set.delete(p);
    else set.add(p);
    onDisplayProps(DISPLAY_PROP_OPTIONS.map((o) => o.id).filter((id) => set.has(id)));
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Display properties"
          className="inline-flex items-center gap-1 h-[26px] px-2 text-[11px] rounded-[3px] bg-bg-2 border-[0.5px] border-line-soft text-text-3 hover:text-text-1 hover:border-line transition-colors"
        >
          <SlidersHorizontal className="w-3 h-3" strokeWidth={1.5} aria-hidden />
          <span>Display</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        className="w-[200px] p-1 text-text-1"
      >
        <div className="px-2 pt-1 pb-1 text-[9.5px] uppercase tracking-wider text-text-5">
          Show on cards
        </div>
        {DISPLAY_PROP_OPTIONS.map((o) => (
          <CheckRow
            key={o.id}
            label={o.label}
            checked={displayProps.includes(o.id)}
            onToggle={() => toggle(o.id)}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

// ─── helpers ───────────────────────────────────────────────────────────

export function filterCount(f: TaskViewFilters): number {
  let n = 0;
  if (f.status?.length) n += f.status.length;
  if (f.priority?.length) n += f.priority.length;
  if (f.assignee?.length) n += f.assignee.length;
  if (f.agent?.length) n += f.agent.length;
  if (f.labels?.length) n += f.labels.length;
  if (f.q && f.q.trim()) n += 1;
  return n;
}
