// The two decisions that stand between a split layout and a stuck pane.
//
// A split gives every child its own flex cell. A child that renders nothing
// still gets that cell — a full-height blank column with no tab strip, no
// content, no close button and nothing for the resize handle to move. Both
// helpers below exist to make sure a pane is either drawn properly or not
// allocated space at all, never the third thing.

import type { WorkPaneRef } from "../lib/editorStore";

/** Which tab a pane should show. Null only when the pane holds no tabs at
 *  all; an `activeIndex` that outran the list clamps to the first tab rather
 *  than reporting "nothing", because a pane that reports nothing renders
 *  nothing and a pane that renders nothing cannot be closed. */
export function activeRefForLeaf(leaf: {
  tabs: WorkPaneRef[];
  activeIndex: number;
}): WorkPaneRef | null {
  if (leaf.tabs.length === 0) return null;
  return leaf.tabs[leaf.activeIndex] ?? leaf.tabs[0];
}

/** Children that actually rendered something, so weights are normalized
 *  against the panes the user can see. `0` and `""` are real children and
 *  keep their cells; only null / undefined / false rendered nothing. */
export function dropEmptyCells<T>(kids: T[]): T[] {
  return kids.filter(
    (c) => c !== null && c !== undefined && (c as unknown) !== false,
  );
}
