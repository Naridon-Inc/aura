// One board lane — the shell every board surface in the app renders through.
//
// Anatomy follows Plane's column, top to bottom:
//
//   ◐  In Progress   3                    ⊟  +   sticky header
//   ┌────────────────────────────────┐
//   │ card                           │            body: spaced stack
//   └────────────────────────────────┘
//   + New                                         footer: optional quick-add
//
// The lane itself has NO background, border or radius at rest — it is a header
// and a spaced stack, not a panel (see `boardTokens` for why). It becomes a
// panel for exactly one moment: while you drag a card over it.
//
// Three behaviours are baked in here rather than re-implemented per board:
//
//   • Drag-over. The lane body tints and rounds, and a 2px accent drop bar
//     with rounded end-caps marks where the card will land — so "will it go
//     here?" is answered before you let go. Only boards that pass `onDropCard`
//     get this; a board whose lane is derived from real state (you can't drag
//     a working agent into "Done") stays inert.
//   • Collapse. Plane folds a lane to a narrow strip instead of hiding it, so
//     the pipeline's shape survives while you focus on one stage. The title
//     uses real CSS vertical writing-mode, not a rotate transform, so text
//     metrics and truncation stay correct. Collapsed lanes unmount their
//     cards rather than hiding them. `collapseWhenEmpty` applies the same fold
//     automatically to a lane holding nothing, for boards whose lanes are
//     derived from state and must all render.
//   • Empty + loading. An empty lane keeps its place and says, in plain words,
//     what would land there. Loading shows the app's one block loader.

import { useState, type JSX, type ReactNode } from "react";
import { ChevronsLeftRight, ChevronsRightLeft } from "lucide-react";

import { AsciiSpinner } from "../ui/ascii-spinner";
import { BoardCount } from "./BoardFrame";
import {
  BOARD_CARD_GAP,
  BOARD_COLUMN_COLLAPSED_WIDTH,
  BOARD_COLUMN_DRAG_OVER,
  BOARD_COLUMN_HEADER,
  BOARD_COLUMN_MIN_BODY,
  BOARD_COLUMN_SHELL,
  BOARD_COLUMN_TITLE,
  BOARD_COLUMN_WIDTH,
  BOARD_DROP_CAP,
} from "./boardTokens";

/** The insertion marker: a 2px accent bar capped with a rounded square at each
 *  end. Plane's signature drop affordance — unmistakable, and far calmer than
 *  a full card-shaped ghost slot. */
function DropIndicator(): JSX.Element {
  return (
    <div className="relative h-0.5 w-full rounded-full bg-accent" aria-hidden>
      <span
        className="absolute rounded-[2px] bg-accent"
        style={{
          width: BOARD_DROP_CAP,
          height: BOARD_DROP_CAP,
          left: 0,
          top: -(BOARD_DROP_CAP - 2) / 2,
        }}
      />
      <span
        className="absolute rounded-[2px] bg-accent"
        style={{
          width: BOARD_DROP_CAP,
          height: BOARD_DROP_CAP,
          right: 0,
          top: -(BOARD_DROP_CAP - 2) / 2,
        }}
      />
    </div>
  );
}

export function BoardColumn({
  title,
  titleHint,
  count,
  glyph,
  actions,
  footer,
  emptyHint,
  loading = false,
  collapsible = false,
  collapseWhenEmpty = false,
  onDropCard,
  children,
}: {
  title: string;
  /** Plain-language gloss of what this lane means, surfaced as the header's
   *  tooltip. Cheaper than a "?" affordance and it never takes up a slot. */
  titleHint?: string;
  /** Shown in the header and preserved when the lane is collapsed. */
  count: number;
  /** The status glyph fronting the name — pass `StateGlyph` (the app's one
   *  shape vocabulary for state) so a lane and a card agree about what a given
   *  status looks like. */
  glyph?: ReactNode;
  /** Per-lane affordances pinned to the right of the header (e.g. "Retry all"
   *  on a failed lane). */
  actions?: ReactNode;
  /** Pinned below the card stack — the quick-add row on boards that have one. */
  footer?: ReactNode;
  /** Plain-language sentence shown when the lane holds nothing. */
  emptyHint?: ReactNode;
  loading?: boolean;
  collapsible?: boolean;
  /** Fold a lane holding nothing down to the narrow strip instead of leaving a
   *  full-width column of empty. For boards whose lanes are derived from real
   *  state and therefore always all render (a pipeline that hides its empty
   *  stages stops being a pipeline) — the shape survives, but three empty
   *  stages no longer push the live ones off the right edge. Opening one by
   *  hand keeps it open, and a lane that gains a card unfolds itself. */
  collapseWhenEmpty?: boolean;
  /** Makes the lane a drop target. Omit on boards whose lanes are derived from
   *  real state and therefore can't be dragged into. */
  onDropCard?: () => void;
  children?: ReactNode;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  // Set when the reader opens an auto-folded empty lane, so it stays open while
  // they read its hint.
  const [emptyOpened, setEmptyOpened] = useState(false);
  // Tracked as a counter, not a boolean: dragging across a child card fires
  // dragleave on the parent, so a naive boolean flickers the highlight off
  // mid-drag. Enter/leave pairs balance to zero only when the pointer truly
  // leaves the lane.
  const [dragDepth, setDragDepth] = useState(0);
  const dragOver = dragDepth > 0;
  // A count of nothing is a claim, and mid-fetch we haven't got one. The body
  // already says "Loading…" here, so the header printing "Backlog 0" over a
  // spinner contradicted the only other thing in the lane.
  const countPending = loading && count === 0;
  const folded =
    collapsed ||
    (collapseWhenEmpty && count === 0 && !loading && !emptyOpened);

  if (folded) {
    return (
      <div
        className={`${BOARD_COLUMN_SHELL} flex-shrink-0 items-center gap-2 rounded-[4px] bg-bg-2/40 py-2`}
        style={{ width: BOARD_COLUMN_COLLAPSED_WIDTH }}
      >
        {glyph}
        {!countPending && <BoardCount n={count} />}
        {/* Real vertical text flow rather than a rotate transform, so
            truncation and text metrics stay correct. */}
        <span
          className="min-h-0 flex-1 overflow-hidden text-ellipsis text-base font-medium text-text-2"
          style={{ writingMode: "vertical-lr" }}
        >
          {title}
        </span>
        <button
          type="button"
          onClick={() => {
            setCollapsed(false);
            setEmptyOpened(true);
          }}
          title={`Expand ${title}`}
          aria-label={`Expand ${title}`}
          className="inline-flex h-5 w-5 items-center justify-center rounded-[4px] text-text-4 transition-colors hover:bg-state-hover hover:text-text-1"
        >
          <ChevronsLeftRight className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`${BOARD_COLUMN_SHELL} flex-shrink-0`}
      style={{ width: BOARD_COLUMN_WIDTH }}
      onDragEnter={onDropCard ? () => setDragDepth((d) => d + 1) : undefined}
      onDragLeave={
        onDropCard ? () => setDragDepth((d) => Math.max(0, d - 1)) : undefined
      }
      onDragOver={
        onDropCard
          ? (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
          : undefined
      }
      onDrop={
        onDropCard
          ? (e) => {
              e.preventDefault();
              setDragDepth(0);
              onDropCard();
            }
          : undefined
      }
    >
      <div className={BOARD_COLUMN_HEADER}>
        <span className={BOARD_COLUMN_TITLE} title={titleHint}>
          {glyph}
          <span className="truncate">{title}</span>
        </span>
        {!countPending && <BoardCount n={count} />}
        <span className="ml-auto inline-flex flex-shrink-0 items-center gap-1">
          {actions}
          {collapsible && (
            <button
              type="button"
              onClick={() => {
                setCollapsed(true);
                setEmptyOpened(false);
              }}
              title={`Collapse ${title}`}
              aria-label={`Collapse ${title}`}
              className="inline-flex h-5 w-5 items-center justify-center rounded-[4px] text-text-4 transition-colors hover:bg-state-hover hover:text-text-1"
            >
              <ChevronsRightLeft className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
            </button>
          )}
        </span>
      </div>

      <div
        className={`flex-1 overflow-y-auto px-1 py-1 transition-colors ${
          dragOver ? BOARD_COLUMN_DRAG_OVER : ""
        }`}
        style={{ minHeight: BOARD_COLUMN_MIN_BODY }}
      >
        <div className="flex flex-col" style={{ gap: BOARD_CARD_GAP }}>
          {loading && count === 0 ? (
            <div className="flex items-center gap-1.5 px-1 py-3 text-sm text-text-4">
              <AsciiSpinner className="text-2xs" />
              <span>Loading…</span>
            </div>
          ) : (
            children
          )}
          {!loading && count === 0 && !dragOver && emptyHint}
          {dragOver && <DropIndicator />}
        </div>
      </div>

      {footer}
    </div>
  );
}
