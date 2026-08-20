// The Tasks surface's two chrome pieces: the controls that live in the page
// header, and the applied-filter row that appears under it.
//
// This used to be one permanently-visible bar carrying a search box, a filter
// pill, every active chip, a Group picker, an Order picker, a direction toggle
// and a Display button — nine controls competing for attention above a board
// that hadn't been read yet. Plane's answer, which this now follows, is a
// quiet header with exactly two menus:
//
//   TasksControls        Search · Filters · Display — three controls, and two
//                        of them are menus. "Display" holds everything about
//                        how the work is arranged (group by, order by,
//                        direction, which properties show on a card), because
//                        those are all one question: how do I want to see it.
//   TasksAppliedFilters  The chips for whatever is currently filtered, plus
//                        Clear all. Renders NOTHING when no filter is set, so
//                        at rest the board starts directly under the header.
//
// Both are driven from above (TasksBoard) — neither owns filter state, they
// just render and emit.
//
// Menus are Radix Popovers (`components/ui/popover.tsx`) so they portal to
// body and don't clip inside the workpane.

import { useMemo, useState } from "react";
import {
  Check,
  Filter as FilterIcon,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";
import { Button } from "../ui/button";
import { TASK_STATUS, TASK_STATUS_ORDER } from "../../lib/taskStatus";
import { Input } from "../ui/input";
import { MENU_LABEL } from "../ui/menuSurface";
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

// One vocabulary for the whole app — see lib/taskStatus.
export const STATUS_LABEL: Record<TaskStatus, string> = Object.fromEntries(
  TASK_STATUS_ORDER.map((id) => [id, TASK_STATUS[id].label]),
) as Record<TaskStatus, string>;

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
  // Where the Plan view went: goals with their work under them, as a cut of
  // this list rather than a second page drawing the same records.
  { id: "goal", label: "Goal" },
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

/** Both header menus wear one trigger: bare at rest (the header is the
 *  surface), tinting only on hover. Two identical buttons read as a pair of
 *  menus; two differently-styled ones read as two unrelated controls.
 *
 *  The label goes to full strength while the menu is OPEN, not only on hover —
 *  otherwise the moment you move the pointer into the panel, the button that
 *  spawned it fades back to secondary and the panel looks unparented. */
const MENU_TRIGGER =
  "inline-flex h-[26px] items-center gap-1.5 rounded-[4px] px-2 text-sm text-text-3 transition-colors " +
  "hover:bg-state-hover hover:text-text-1 data-[state=open]:bg-state-hover data-[state=open]:text-text-1";

/** One option row for both pickers. Deliberately denser than the app's command
 *  menus (`MENU_ROW`, 36px): those are short lists of things to DO, this is a
 *  scrolling list of forty labels to tick, and Plane runs its filter options at
 *  a padding-driven ~26px for exactly that reason. Everything else — the 6px
 *  panel padding, the inset rounded hover pill, the transparent `state-hover`
 *  wash — is the app's shared menu recipe, so a filter menu and a context menu
 *  read as the same object at two densities rather than two designs. */
const OPTION_ROW =
  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-state-hover";

export const DEFAULT_DISPLAY_PROPS: TaskViewDisplayProp[] = [
  "id",
  "assignee",
  "priority",
  "due",
  "labels",
];

/**
 * The header controls: Search · Filters · Display.
 *
 * Sits inline in the Tasks page header beside the layout switch, so the whole
 * surface is one header row and then the work — no chrome band in between.
 */
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
  /** All labels currently present in the workspace, deduped — used to
   *  drive the label picker. Compute in TasksBoard from the task list. */
  allLabels: string[];
}) {
  return (
    <div className="flex items-center gap-1.5">
      <SearchControl
        value={filters.q ?? ""}
        onChange={(q) =>
          onFilters({ ...filters, q: q.trim() === "" ? undefined : q })
        }
      />
      <FilterPopover
        filters={filters}
        onFilters={onFilters}
        members={members}
        allLabels={allLabels}
      />
      <DisplayPopover
        groupBy={groupBy}
        onGroupBy={onGroupBy}
        orderBy={orderBy}
        onOrderBy={onOrderBy}
        orderDir={orderDir}
        onOrderDir={onOrderDir}
        displayProps={displayProps}
        onDisplayProps={onDisplayProps}
      />
    </div>
  );
}

/**
 * The applied-filter row: one chip per active value, then Clear all.
 *
 * Returns null when nothing is filtered — the row exists to tell you why you
 * aren't seeing everything, so with nothing filtered it has nothing to say.
 */
export function TasksAppliedFilters({
  filters,
  onFilters,
  members,
}: {
  filters: TaskViewFilters;
  onFilters: (next: TaskViewFilters) => void;
  members: TeamMember[];
}) {
  const hasAny = useMemo(() => filterCount(filters) > 0, [filters]);
  if (!hasAny) return null;

  function remove(dim: keyof TaskViewFilters, value: string) {
    // `overdue` is a flag, not a list — clearing it means dropping it.
    if (dim === "overdue") {
      onFilters({ ...filters, overdue: undefined });
      return;
    }
    const cur = (filters[dim] as string[] | undefined) ?? [];
    const out = cur.filter((v) => v !== value);
    onFilters({
      ...filters,
      [dim]: out.length === 0 ? undefined : (out as never),
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b-[0.5px] border-line-soft bg-bg-content px-4 py-2 sm:px-6">
      <ChipRow filters={filters} onRemove={remove} members={members} />
      <Button
        variant="link"
        onClick={() => onFilters({})}
        className="h-auto px-1 text-xs text-text-5 underline-offset-2 hover:text-text-2"
      >
        Clear all
      </Button>
    </div>
  );
}

/**
 * Search as an icon that opens into a field, rather than a 200px box parked in
 * the header forever. It stays open while there's a query in it, so a filtered
 * board always shows you what it's filtered by.
 */
function SearchControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const showing = open || value.trim() !== "";

  if (!showing) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Search tasks"
        aria-label="Search tasks"
        className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[4px] text-text-5 transition-colors hover:bg-state-hover hover:text-text-1"
      >
        <Search className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
      </button>
    );
  }

  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-2 top-1/2 w-3 h-3 -translate-y-1/2 text-text-5"
        strokeWidth={1.5}
        aria-hidden
      />
      <Input
        type="text"
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onChange("");
            setOpen(false);
          }
        }}
        placeholder="Search tasks…"
        aria-label="Search tasks"
        className="h-[26px] w-[180px] pl-6 pr-2 text-sm"
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
          className={cn(MENU_TRIGGER, total > 0 && "text-text-1")}
          title="Narrow the board down to the work you want to see"
        >
          <FilterIcon className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
          <span>Filters</span>
          {total > 0 && (
            <span className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[2px] bg-accent/15 px-1 font-mono text-2xs text-accent">
              {total}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[260px] p-0 text-text-1"
      >
        <div className="max-h-[420px] overflow-y-auto p-1.5">
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

/**
 * A titled block of options.
 *
 * The wrapper deliberately un-does the panel's 6px padding and re-applies it
 * (`-mx-1.5 px-1.5`), so the rule between sections bleeds to the panel edge
 * while the rows inside stay inset — the same full-width-rule / inset-row
 * relationship `MENU_SEP` gives the app's dropdowns.
 */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="-mx-1.5 border-t border-line-soft px-1.5 py-1 first:border-t-0">
      <div className={MENU_LABEL}>{title}</div>
      {children}
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
        OPTION_ROW,
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
    overdue: "Due",
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
  // The sidebar's Overdue row sets this. Without a chip you'd land on a short
  // list with no visible reason for it and no way back but a page reload.
  if (filters.overdue)
    chips.push({
      dim: "overdue",
      value: "1",
      keyLabel: DIM_LABEL.overdue,
      valLabel: "Overdue",
    });
  if (chips.length === 0) return null;
  return (
    <>
      {chips.map((c) => (
        <span
          key={`${c.dim}:${c.value}`}
          className="group inline-flex items-center gap-1.5 h-[22px] pl-2 pr-1.5 text-xs rounded-[4px] bg-bg-1 border-[0.5px] border-line-soft text-text-3"
        >
          <span className="text-text-5">{c.keyLabel}:</span>
          <span className="font-medium text-text-1">{c.valLabel}</span>
          <button
            type="button"
            onClick={() => onRemove(c.dim, c.value)}
            title={`Remove ${c.keyLabel}: ${c.valLabel}`}
            className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-text-5 transition-colors hover:bg-red/10 hover:text-red"
          >
            <X className="w-2.5 h-2.5" strokeWidth={1.75} aria-hidden />
          </button>
        </span>
      ))}
    </>
  );
}

/**
 * "Display" — everything about how the work is arranged, in one menu.
 *
 * Group by, order by, direction and which properties show on a card used to be
 * four separate controls sitting on the bar. They're one question ("how do I
 * want to see this?") and they're now one menu, which is both Plane's shape
 * and three fewer things in the header.
 */
function DisplayPopover({
  groupBy,
  onGroupBy,
  orderBy,
  onOrderBy,
  orderDir,
  onOrderDir,
  displayProps,
  onDisplayProps,
}: {
  groupBy: TaskViewGroupBy;
  onGroupBy: (g: TaskViewGroupBy) => void;
  orderBy: TaskViewOrderBy;
  onOrderBy: (o: TaskViewOrderBy) => void;
  orderDir: TaskViewOrderDir;
  onOrderDir: (d: TaskViewOrderDir) => void;
  displayProps: TaskViewDisplayProp[];
  onDisplayProps: (p: TaskViewDisplayProp[]) => void;
}) {
  const [open, setOpen] = useState(false);

  function toggleProp(p: TaskViewDisplayProp) {
    const set = new Set(displayProps);
    if (set.has(p)) set.delete(p);
    else set.add(p);
    onDisplayProps(
      DISPLAY_PROP_OPTIONS.map((o) => o.id).filter((id) => set.has(id)),
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Change how the work is grouped, ordered and shown"
          className={MENU_TRIGGER}
        >
          <SlidersHorizontal
            className="h-3.5 w-3.5"
            strokeWidth={1.5}
            aria-hidden
          />
          <span>Display</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        className="w-[240px] p-0 text-text-1"
      >
        <div className="max-h-[440px] overflow-y-auto p-1.5">
          <Section title="Group by">
            {GROUP_BY_OPTIONS.map((o) => (
              <PickRow
                key={o.id}
                label={o.label}
                selected={o.id === groupBy}
                onSelect={() => onGroupBy(o.id)}
              />
            ))}
          </Section>
          <Section title="Order by">
            {ORDER_BY_OPTIONS.map((o) => (
              <PickRow
                key={o.id}
                label={o.label}
                selected={o.id === orderBy}
                onSelect={() => onOrderBy(o.id)}
              />
            ))}
            <div className="flex items-center gap-1 px-2 pb-1 pt-1.5">
              {(["asc", "desc"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => onOrderDir(d)}
                  className={cn(
                    "flex-1 rounded-[4px] border-[0.5px] px-2 py-1 text-xs transition-colors",
                    orderDir === d
                      ? "border-accent/40 bg-accent/10 text-accent"
                      : "border-line-soft text-text-3 hover:text-text-1",
                  )}
                >
                  {d === "asc" ? "First → last" : "Last → first"}
                </button>
              ))}
            </div>
          </Section>
          <Section title="Show on cards">
            {DISPLAY_PROP_OPTIONS.map((o) => (
              <CheckRow
                key={o.id}
                label={o.label}
                checked={displayProps.includes(o.id)}
                onToggle={() => toggleProp(o.id)}
              />
            ))}
          </Section>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A single-choice row (group by / order by), as against `CheckRow`'s
 *  many-choice box. The tick is 14px and sits RIGHT, with no selected
 *  background and no bolder weight — Plane communicates single selection by
 *  the tick alone, and it keeps these labels flush left with the checkbox rows
 *  above them. The tick is the one accent-coloured thing in a menu, which is
 *  this app's rule for indicators. */
function PickRow({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(OPTION_ROW, selected ? "text-text-1" : "text-text-3")}
    >
      <span className="flex-1 truncate">{label}</span>
      {selected && (
        <Check
          className="h-3.5 w-3.5 flex-shrink-0 text-accent"
          strokeWidth={2}
          aria-hidden
        />
      )}
    </button>
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
  if (f.overdue) n += 1;
  return n;
}
