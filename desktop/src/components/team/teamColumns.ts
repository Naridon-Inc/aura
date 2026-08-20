// Which of Team's columns are on screen, at this width, on this mount.
//
// Team is mounted three ways and only one of them is a place:
//
//   full       the Team page — it owns the window, so it is a place, and its
//              navigation goes where every place puts it: the right-hand rail
//              `PlacePage` gives Pages and Tasks.
//   navigator  the conversation list alone, docked inside the app sidebar. A
//              column of somebody else's layout.
//   detail     the stream alone, in an editor workpane. Same.
//
// This was four booleans read off `panelW` and `mode` inline in the render,
// and getting one of them wrong is not a visual nit: at 640px a surface that
// thinks it can sit a 320px thread beside a 220px rail leaves the conversation
// 100px, which is not a conversation. So the decision is here, and the widths
// it turns on are checked rather than eyeballed.

/** Measured surface width at which the thread can sit beside the stream. */
export const THREE_COL_MIN = 1040;
/** …and below which there is only room for one column at a time. */
export const TWO_COL_MIN = 640;

export type TeamMount = "full" | "navigator" | "detail";

export type TeamColumns = {
  /** The page mount, wide enough to carry a rail: lay it out with `PlacePage`
   *  and hand the conversation list over as the rail. */
  isPlace: boolean;
  /** Draw the conversation list as a column of the row (never true when
   *  `isPlace` — there it is the rail, which is outside the row). */
  showList: boolean;
  /** Draw the conversation stream. */
  showView: boolean;
  /** Thread / pinned / members sit inline beside the stream rather than
   *  sliding over it. */
  contextInline: boolean;
  /** The narrow surface, where list and stream swap instead of sharing. */
  oneCol: boolean;
};

export function teamColumns(
  mode: TeamMount,
  /** Measured width of the whole Team surface, rail included. */
  panelW: number,
  /** Is there anything for the centre to show — an open conversation, or one
   *  of the catch-up screens? */
  hasCenter: boolean,
): TeamColumns {
  const threeCol = panelW >= THREE_COL_MIN;
  const twoCol = panelW >= TWO_COL_MIN && panelW < THREE_COL_MIN;
  const oneCol = panelW < TWO_COL_MIN;

  const navigatorOnly = mode === "navigator";
  const detailOnly = mode === "detail";

  // Below TWO_COL_MIN even the page can't carry a rail beside a stream, so it
  // drops back to the swap. Above it, the page is a place.
  const isPlace = mode === "full" && !oneCol;

  const showList =
    !isPlace &&
    (navigatorOnly ||
      (!detailOnly && (threeCol || twoCol || (oneCol && !hasCenter))));

  const showView =
    isPlace ||
    detailOnly ||
    (!navigatorOnly && (threeCol || twoCol || (oneCol && hasCenter)));

  // The place takes the three-column threshold and nothing looser: its rail is
  // outside the row, so the "no list in the row, therefore there's room" test
  // the other mounts use would always pass and always be wrong.
  const contextInline =
    !navigatorOnly && (isPlace ? threeCol : threeCol || (twoCol && !showList));

  return { isPlace, showList, showView, contextInline, oneCol };
}
