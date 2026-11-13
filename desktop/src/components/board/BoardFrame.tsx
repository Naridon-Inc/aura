// The board frame + the small atoms every board header shares.
//
// `BoardFrame` is the horizontally-scrolling lane strip. Keeping it here (as
// opposed to letting each surface roll its own scroller) is what guarantees
// the lanes line up at the same inset and scroll the same way everywhere. It
// is the library task board: its scroll, its padding, its gap between lanes.

import type { JSX, ReactNode } from "react";

import { TaskBoard } from "../ui/tasks-board";
import "../ui/board-lane.css";

/**
 * The lane strip: scrolls sideways, never vertically (each lane owns its own
 * vertical scroll so the headers stay put while you read a long lane).
 * `label` names the board for a screen reader.
 */
export function BoardFrame({
  label = "Board",
  children,
}: {
  label?: string;
  children: ReactNode;
}): JSX.Element {
  return <TaskBoard label={label}>{children}</TaskBoard>;
}

/**
 * The count beside a lane name. Plain muted number in tabular figures so a
 * lane going 9 → 10 doesn't shift the header. Deliberately not a filled chip:
 * on a board the count is orientation, not something you act on.
 */
export function BoardCount({ n }: { n: number }): JSX.Element {
  return <span className="ui-board-lane-count">{n}</span>;
}

/**
 * A lane's empty state: one plain-language line saying what would land here,
 * never a fake ghost card — the task board column's own empty line.
 *
 * We keep a sentence rather than an empty lane because this app's boards are
 * read by non-engineers, for whom an empty lane with no explanation is a dead
 * end rather than a clean slate — the caller passes a real sentence ("Queued
 * and ready — an agent will pick these up next."), never a status enum.
 */
export function BoardEmptyHint({ children }: { children: ReactNode }): JSX.Element {
  return <p className="ui-tasks-column-empty">{children}</p>;
}
