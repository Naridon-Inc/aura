// The second sidebar — one shape, for every place that needs one.
//
// The app already had a rail people liked: the right-hand Changes / Checks
// panel. Collapsible groups with a count on the header, groups that hide
// themselves when they hold nothing, actions that appear on hover instead of
// sitting there all day, rows inset from the edge so a selected row reads as a
// pill rather than a full-bleed stripe. It works because every group is the
// same object and the rail never says anything twice.
//
// The place rails were none of that. Tasks opened with its own name printed at
// 16px — beside a rail row saying Tasks and a tab saying Tasks — then a
// full-width "New task" button 200px from the board's own New task button,
// then five always-open sections whose rows wore raw palette dots
// (amber-400, rose-400, violet-400) that meant nothing you could look up.
//
// So the shape lives here and the places render it. Same argument as
// ui/SurfaceHeader: not a convention to remember, the same element.
//
// The one thing added rather than copied is the scope picker. Everything a
// place rail lists — tasks, sprints, workstreams, documents, people — belongs
// to a project, and until now the rails simply showed whatever the app
// happened to have open with no way to say "the other one". Choosing the
// project is part of using the rail, so it sits at the top of it.

import { useState, type ReactNode } from "react";

import { Select, type SelectOption } from "../ui/select";
import { ALL_PROJECTS, projectNameFromRoot } from "../../lib/projectRoots";
import { humanizeWorkspaceName } from "../../lib/workspaceLabel";
import { cn } from "../../lib/utils";

/** The rail itself: a scope picker (optional), then a scrolling stack of
 *  groups. No title — the destination you clicked is lit in the app rail and
 *  the page you're on is the answer to "where am I". */
export function PlaceRail({
  scope,
  scroll = true,
  children,
}: {
  /** The project picker, when this place is scoped to a project. */
  scope?: ReactNode;
  /** Off when the child scrolls itself — a rail whose body is a drag-and-drop
   *  tree keeps its own scroller, and nesting one inside another gives you two
   *  bars and a tree that can't be dragged past its own edge. */
  scroll?: boolean;
  children: ReactNode;
}) {
  return (
    <aside className="relative flex h-full w-full min-w-0 flex-col">
      {scope && <PlaceRailScopeRow>{scope}</PlaceRailScopeRow>}
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          scroll && "overflow-y-auto overflow-x-hidden",
        )}
      >
        {children}
      </div>
    </aside>
  );
}

/** The band the scope picker sits in. Exported because Team's rail keeps its
 *  own <aside> (it carries the resizable sizing and the Slack-era class names)
 *  and so renders the row itself — copying the four utility classes across
 *  would have made the rule under one rail drift from the other the first time
 *  either changed. */
export function PlaceRailScopeRow({ children }: { children: ReactNode }) {
  return (
    <div className="shrink-0 border-b border-line-soft px-2 py-2">
      {children}
    </div>
  );
}

/** Which project this place is looking at.
 *
 *  `all` is offered only by surfaces that genuinely read every root — a rail
 *  that counts eight projects over a body drawing one is worse than a rail
 *  with no picker, so the caller opts in rather than getting it for free. */
export function PlaceRailScope({
  value,
  onChange,
  projects,
  all,
  disabled,
}: {
  /** A repo root, or ALL_PROJECTS. */
  value: string;
  onChange: (next: string) => void;
  projects: Array<{ root: string; label?: string }>;
  /** Offer "All projects". Only pass this when the surface reads them all. */
  all?: boolean;
  disabled?: boolean;
}) {
  const options: SelectOption[] = [
    ...(all
      ? [
          {
            value: ALL_PROJECTS,
            label: `All projects · ${projects.length}`,
          },
        ]
      : []),
    ...projects.map((p) => ({
      value: p.root,
      // The same name the app rail and the workspace switcher use, so one
      // project isn't called two things one column apart.
      label: p.label?.trim() || humanizeWorkspaceName(p.root, projectNameFromRoot(p.root)),
    })),
  ];

  return (
    <Select
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Pick a project"
      disabled={disabled || options.length === 0}
      aria-label="Project"
      className="h-7 text-xs"
    />
  );
}

/** A collapsible group — the Changes panel's, exactly.
 *
 *  Hides itself when it holds nothing, UNLESS it carries an `empty` line. An
 *  Untracked group with no untracked files is rail you're paying for and can't
 *  use; a Workstreams group with no workstreams is where you make the first
 *  one, and hiding it would take the only door with it. Actions alone don't
 *  keep a group up — there is nothing to stage in an empty Untracked. */
export function PlaceRailGroup({
  title,
  count,
  defaultOpen = true,
  open,
  onToggle,
  actions,
  empty,
  children,
}: {
  title: string;
  count: number;
  defaultOpen?: boolean;
  /** Controlled open state. Leave off and the group keeps its own. */
  open?: boolean;
  onToggle?: () => void;
  /** Trailing controls, revealed on hover — the one thing this group makes. */
  actions?: ReactNode;
  /** What to show when it's empty. Keeps the group on screen. Usually a
   *  sentence; a node when the empty state is also the way out of it. */
  empty?: ReactNode;
  children?: ReactNode;
}) {
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const isOpen = open ?? ownOpen;
  const toggle = onToggle ?? (() => setOwnOpen((v) => !v));

  if (count === 0 && !empty) return null;

  return (
    <div className="min-w-0 overflow-hidden border-b border-line-soft last:border-b-0">
      <div className="group flex min-w-0 items-center transition-colors hover:bg-state-hover">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={isOpen}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            className={cn(
              "shrink-0 text-text-3 transition-transform duration-150",
              isOpen && "rotate-90",
            )}
            aria-hidden
          >
            <path
              d="M6 4l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="section-label truncate">
            {title}
          </span>
          {count > 0 && (
            <span className="shrink-0 text-xs font-medium tabular-nums text-text-3">
              {count}
            </span>
          )}
        </button>
        {actions && (
          <div className="flex shrink-0 items-center gap-0.5 pr-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {actions}
          </div>
        )}
      </div>
      {isOpen && (
        <div className="min-w-0 overflow-hidden px-1 pb-1.5">
          {children}
          {count === 0 && empty && (
            <div className="text-xs leading-relaxed text-text-5">{empty}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** One clickable row. `ade-row` is the app's shared row spec — the same
 *  padding, hover and selected wash the main rail's rows use — so a row in the
 *  second sidebar and a row in the first are the same object. */
export function PlaceRailRow({
  label,
  count,
  glyph,
  active,
  onClick,
  title,
  actions,
}: {
  label: string;
  /** Omitted (or zero) prints no chip: a row with nothing in it says so by
   *  being quiet, not by wearing a 0. */
  count?: number;
  glyph?: ReactNode;
  active: boolean;
  onClick: () => void;
  title?: string;
  /** What this ROW makes, revealed on hover — the same bargain
   *  `PlaceRailGroup` strikes for what a GROUP makes. A sprint is the case
   *  this exists for: it can be made current and it can be completed, and
   *  those are acts on one sprint rather than on the group of them.
   *
   *  Rendered as a sibling of the row, not inside it: the row is a `<button>`
   *  and a button inside a button is markup no browser agrees on. */
  actions?: ReactNode;
}) {
  const row = (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      className={cn("group ade-row", active && "active")}
    >
      {glyph}
      <span className="nm">{label}</span>
      {count !== undefined && count > 0 && (
        <span
          className={cn(
            "inline-flex h-[16px] min-w-[18px] items-center justify-center rounded-[3px] px-1 text-2xs tabular-nums transition-colors",
            active
              ? "bg-state-selected text-text-2"
              : "text-text-4 group-hover:bg-state-hover",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );

  // Rows without actions render exactly what they always did — one element,
  // no wrapper — so nothing about Pages' or Team's rails moves by a pixel.
  if (!actions) return row;

  return (
    <div className="group/row relative flex min-w-0 items-center">
      {row}
      <div className="absolute right-1.5 flex items-center gap-0.5 rounded-[4px] opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
        {actions}
      </div>
    </div>
  );
}
