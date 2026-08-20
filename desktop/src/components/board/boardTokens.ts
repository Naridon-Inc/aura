// Board design tokens — the ONE place the app's work-board geometry lives.
//
// Every surface that renders work items (Tasks, Mission Control / Crew,
// Workspaces) reads these instead of hand-rolling its own
// widths and radii. Before this module each board had drifted to its own
// numbers — 280px vs 248px columns, `rounded-[8px]` vs `rounded-lg`,
// `bg-bg-2/50` vs `bg-bg-1` — so the same object looked like a different kind
// of thing depending on which tab you were standing in.
//
// The visual language is Plane's board. Three of its decisions drive
// everything below, and all three are inversions of the usual Trello lineage:
//
//   1. A COLUMN IS NOT A CONTAINER. No fill, no border, no radius at rest —
//      just a header and a spaced vertical stack. A tint and a radius appear
//      only while you drag over it, which is the one moment the lane really is
//      a target. This is what keeps a board of wide columns feeling open.
//   2. THE CARD IS LIGHTER THAN THE BOARD. Cards sit on `bg-content` over a
//      board painted `bg-1`, which is a step darker in every one of our
//      themes. Cards read as objects lying on a surface, rather than the
//      column reading as a box holding them.
//   3. COLOUR IS FOR PROGRESS, NOT IDENTITY. Backlog and Todo deliberately
//      share a hue and are told apart by glyph geometry alone. Saturation on
//      the board is limited to the state glyph, label dots and the drop
//      indicator.
//
// Numbers live here as plain values (not Tailwind classes) wherever a caller
// needs them for an inline style or a measurement — Tailwind can't express
// "the drop indicator's end-cap is 6px square".

/** Column width — and therefore card width, since a card fills its lane.
 *
 *  Plane runs a genuinely wide 350px lane. We run 320: still wide enough that
 *  a two-line title plus a full chip row never re-flows, but narrow enough that
 *  one more lane fits on screen before the board has to scroll. The lanes are
 *  the unit of scanning here, so seeing more of the pipeline at once beats
 *  giving any single card extra room it doesn't use. */
export const BOARD_COLUMN_WIDTH = 320;

/** Width of a collapsed lane. Plane drops the width constraint entirely and
 *  shrinks to a narrow strip rather than hiding the lane, so the pipeline's
 *  shape survives while you focus on one stage. */
export const BOARD_COLUMN_COLLAPSED_WIDTH = 44;

/** Gap between lanes, and the inset the board frame puts around them. */
export const BOARD_COLUMN_GAP = 16;
export const BOARD_FRAME_PADDING_X = 20;
export const BOARD_FRAME_PADDING_Y = 8;


/** Minimum body height for a lane, so an empty one still reads as a lane. */
export const BOARD_COLUMN_MIN_BODY = 120;

/** Gap between cards in a lane. */
export const BOARD_CARD_GAP = 8;

/** The drop indicator's end-cap — a 6px rounded square at each end of the
 *  2px accent bar. A small signature detail most kanbans skip, and it makes
 *  the insertion point unmistakable. */
export const BOARD_DROP_CAP = 6;

// ── Shared class fragments ────────────────────────────────────────────────
//
// Exported as strings (rather than baked into the components) so a surface
// with a genuinely different container — the sprint grid, which lays lanes out
// in a wrapping grid instead of a horizontal scroller — can still wear the
// exact same skin.

/** The lane shell. Deliberately bare: no background, no border, no radius.
 *  See decision (1) above. */
export const BOARD_COLUMN_SHELL = "flex flex-col";

/** The lane's drag-over state — the one moment a column reads as a panel. */
export const BOARD_COLUMN_DRAG_OVER = "rounded-[4px] bg-bg-2/60";

/** The lane header row. Sticky, painted with the board background so cards
 *  scroll cleanly underneath it. */
export const BOARD_COLUMN_HEADER =
  "sticky top-0 z-10 flex h-8 items-center gap-2 bg-bg-1 px-1";

/** Lane title type. Sentence case, no tracking, no uppercase — Plane's board
 *  carries hierarchy through position and colour, never through type tricks.
 *  Same size and weight as a card title on purpose.
 *
 *  13px, which is the app's body size. It was 14. One step is not much on its
 *  own, but the lane header, the card title and the page heading were each a
 *  step up, and a surface where every tier is a step above the rest of the app
 *  reads as a different, larger app. */
export const BOARD_COLUMN_TITLE =
  "inline-flex min-w-0 items-center gap-2 text-base font-medium text-text-1";

/** The card shell: 10px padding, 8px radius, a full 1px border (twice the
 *  weight of the hairline elsewhere, so the card boundary always wins) and a
 *  6px internal rhythm — Plane's own gap between a card title and its metadata
 *  row, which we had rounded up to 8.
 *
 *  Padding is 10 rather than Plane's 12 because our title runs to two lines
 *  where theirs runs to one (see BOARD_CARD_TITLE): at 12px all round a
 *  two-line card stood ~100px tall and five of them filled a lane. */
export const BOARD_CARD_SHELL =
  "flex flex-col gap-1.5 rounded-[8px] border bg-bg-content p-2.5 text-left transition-[border-color,box-shadow]";

/** Card title. 13px/500/1.4 — the app's body size, and the same size as a list
 *  row title.
 *
 *  Plane sets a card title one step above a row title (14 vs 13) on the
 *  reasoning that a card has room and a row is scanned thirty at a time. We
 *  don't take that step, because we spend the room differently: our titles are
 *  sentences rather than noun phrases, so they run to two lines where Plane's
 *  run to one. A two-line title at 14px is a taller block than a one-line
 *  title at 14px was ever meant to be, and stacked five to a lane it was the
 *  single loudest thing on the board. */
export const BOARD_CARD_TITLE =
  "line-clamp-2 text-base font-medium leading-[1.4] text-text-1";

/** The shared chip: 20px tall, 6px radius, 6px of horizontal padding, 11px
 *  text, a 4px icon gap — and a subtle tinted FILL with no border at all.
 *
 *  The no-border part is the load-bearing bit. Plane runs every chip family
 *  (property pills, count chips, label pills) as a bare tint at one height and
 *  one radius, which is what makes a card footer read as a single continuous
 *  band rather than a row of unrelated outlined badges. */
export const BOARD_CHIP =
  "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-[6px] bg-bg-2 px-1.5 text-xs leading-none";

/** The footer row that holds the chips: 8px between chips, sitting 8px below
 *  the title on the card's own rhythm. Wraps; the assignee slot is pushed to
 *  the right edge by the caller with `ml-auto`. */
export const BOARD_CARD_META_ROW =
  "flex flex-wrap items-center gap-2 text-text-3";
