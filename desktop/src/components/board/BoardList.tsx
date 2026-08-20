// The list layout — the other half of the shared work-board design system.
//
// Plane gives you the same work in two shapes and lets you flip between them:
// a board of lanes, or a grouped list. Both group by the SAME thing and speak
// the same visual language, so flipping the layout never feels like landing in
// a different product. These are the list's two primitives:
//
//   BoardListGroup — the sticky group header: chevron · glyph · name · count,
//                    with an optional action pinned right, then its rows.
//   BoardListRow   — one dense, single-line row. Leading slot (priority,
//                    glyph, handle), the title as the flexible middle, then
//                    property chips right-aligned.
//
// A row reuses the card's chip grammar (`BoardCardMeta`, `BoardCardLabel`), so
// a due date looks identical whether you're reading it on a lane or in a list.

import type { JSX, ReactNode } from "react";
import { ChevronDown, Plus } from "lucide-react";

export function BoardListGroup({
  title,
  titleHint,
  count,
  glyph,
  expanded,
  onToggle,
  action,
  onAdd,
  addLabel = "New task",
  children,
}: {
  title: string;
  /** A plain one-line explanation of what this group means, shown on hover —
   *  the same affordance `BoardColumn` carries, so a group explains itself
   *  identically in both layouts. */
  titleHint?: string;
  count: number;
  /** The status glyph — same `StateGlyph` the board's column header uses. */
  glyph?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  /** Pinned to the right of the header (e.g. "Retry all"). */
  action?: ReactNode;
  /** Adds a "+" in the header and an inline add row at the foot of the group,
   *  both creating into THIS group's status. Omit to hide both. */
  onAdd?: () => void;
  addLabel?: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="pb-1">
      {/* Sticky so the group you're reading always names itself, even when the
          list is scrolled deep into a long status. */}
      <div className="sticky top-0 z-10 flex items-center gap-2.5 bg-bg-content/95 px-1 pb-2 pt-[10px] backdrop-blur">
        <button
          type="button"
          onClick={onToggle}
          title={expanded ? "Collapse" : "Expand"}
          className="flex min-w-0 flex-1 items-center gap-2.5 transition-opacity hover:opacity-80"
        >
          <ChevronDown
            className={`h-3 w-3 flex-shrink-0 text-text-5 transition-transform ${
              expanded ? "" : "-rotate-90"
            }`}
            strokeWidth={1.75}
            aria-hidden
          />
          {glyph}
          {/* Same size and weight as a board lane title and a card title —
              flipping layout must not feel like changing products. That is
              13px, the app's body size; see BOARD_COLUMN_TITLE. */}
          <span
            className="truncate text-base font-medium text-text-1"
            title={titleHint}
          >
            {title}
          </span>
          <span className="text-sm font-medium tabular-nums text-text-3">
            {count}
          </span>
        </button>
        {action}
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            title={`${addLabel} in ${title}`}
            className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[4px] text-text-5 transition-colors hover:bg-state-hover hover:text-text-1"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
          </button>
        )}
      </div>

      {expanded && children}

      {expanded && onAdd && (
        <button
          type="button"
          onClick={onAdd}
          className="flex w-full items-center gap-2 border-t-[0.5px] border-line-soft px-1 py-2 text-left text-sm text-text-5 transition-colors hover:text-text-2"
        >
          <Plus className="h-3 w-3" strokeWidth={1.5} aria-hidden />
          <span>{addLabel}</span>
        </button>
      )}
    </div>
  );
}

/**
 * One list row. Deliberately a single line: the list layout's job is density —
 * you come here to scan thirty items, and a row that wraps destroys that. The
 * title truncates; everything that would push it out lives in `trailing`,
 * which shrinks to nothing before the title does.
 *
 * Plane's row metrics exactly: 44px minimum height, 12px of vertical padding,
 * 13px title at weight 500, 8px between clusters. Plane sets a card title one
 * step above this; we don't (see BOARD_CARD_TITLE), so a title is 13px whether
 * you are looking at it in a lane or in a row.
 */
export function BoardListRow({
  onSelect,
  selected = false,
  leading,
  title,
  trailing,
  hoverActions,
  tooltip,
  dataAttrs,
}: {
  onSelect: () => void;
  selected?: boolean;
  /** Priority bars, state glyph, mono handle — whatever identifies the row. */
  leading?: ReactNode;
  title: ReactNode;
  /** Property chips, right-aligned: labels, due, assignees. */
  trailing?: ReactNode;
  /** Revealed on row hover — destructive or secondary affordances that
   *  shouldn't compete with the row's content at rest. */
  hoverActions?: ReactNode;
  tooltip?: string;
  dataAttrs?: Record<string, string>;
}): JSX.Element {
  return (
    <div
      className={`group flex min-h-11 w-full items-center gap-2 border-t-[0.5px] border-line-soft px-1 py-3 text-base transition-colors ${
        selected ? "bg-state-selected" : "hover:bg-state-hover"
      }`}
      {...dataAttrs}
    >
      <button
        type="button"
        onClick={onSelect}
        title={tooltip}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {leading}
        <span className="min-w-0 flex-1 truncate font-medium text-text-1">
          {title}
        </span>
      </button>
      {trailing && (
        <span className="flex flex-shrink-0 items-center gap-2">{trailing}</span>
      )}
      {hoverActions && (
        <span className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {hoverActions}
        </span>
      )}
    </div>
  );
}
