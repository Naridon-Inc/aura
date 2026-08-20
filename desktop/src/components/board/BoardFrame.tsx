// The board frame + the small atoms every board header shares.
//
// `BoardFrame` is the horizontally-scrolling lane strip. Keeping it here (as
// opposed to letting each surface roll its own scroller) is what guarantees
// the lanes line up at the same inset and scroll the same way everywhere.
//
// The frame paints `bg-1` — a step DARKER than the `bg-content` its cards sit
// on, in every theme. That inversion is the single most recognisable thing
// about Plane's board: cards read as objects lying on a surface, not as
// contents of a box.

import type { JSX, ReactNode } from "react";

import {
  BOARD_COLUMN_GAP,
  BOARD_FRAME_PADDING_X,
  BOARD_FRAME_PADDING_Y,
} from "./boardTokens";

/**
 * The lane strip: scrolls sideways, never vertically (each lane owns its own
 * vertical scroll so the sticky headers stay put while you read a long lane).
 */
export function BoardFrame({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="h-full w-full overflow-x-auto overflow-y-hidden bg-bg-1">
      <div
        className="flex h-full min-w-full items-stretch"
        style={{
          gap: BOARD_COLUMN_GAP,
          paddingLeft: BOARD_FRAME_PADDING_X,
          paddingRight: BOARD_FRAME_PADDING_X,
          paddingTop: BOARD_FRAME_PADDING_Y,
          paddingBottom: BOARD_FRAME_PADDING_Y,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The count beside a lane name. Plain muted number in tabular figures so a
 * lane going 9 → 10 doesn't shift the header. Deliberately not a filled chip:
 * on a board the count is orientation, not something you act on.
 */
export function BoardCount({ n }: { n: number }): JSX.Element {
  return <span className="text-sm font-medium tabular-nums text-text-3">{n}</span>;
}

/**
 * A lane's empty state: one plain-language line saying what would land here,
 * never a fake ghost card.
 *
 * Plane shows nothing at all in an empty lane. We keep a sentence because this
 * app's boards are read by non-engineers, for whom an empty lane with no
 * explanation is a dead end rather than a clean slate — the caller passes a
 * real sentence ("Queued and ready — an agent will pick these up next."),
 * never a status enum.
 */
export function BoardEmptyHint({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="px-1 py-3 text-sm leading-snug text-text-5">{children}</p>
  );
}
