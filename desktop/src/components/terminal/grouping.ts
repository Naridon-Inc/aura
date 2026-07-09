// Side-list view-model. VS Code shows split terminals as one row with
// indented sub-panes; a solo terminal is a single row. Each store
// `TerminalGroup` already owns its own split tree, so a side-list row
// maps 1:1 to a group — this helper just resolves the group's leaf order
// into the concrete `TerminalTab`s the row renders. Pure + exported so
// it can be unit-tested without the store.

import type { TerminalGroup, TerminalTab } from "../../lib/editorStore";
import { treeLeafNodes } from "../../lib/editorStore";

export type PanelGroupView = {
  groupId: string;
  /** Panes in split-tree leaf order. 1 ⇒ solo row; >1 ⇒ split group. */
  panes: TerminalTab[];
  /** The group's focused pane (a termId present in `panes`). */
  activeTermId: string;
  isSplit: boolean;
};

/** Resolve each terminal group into its ordered list of panes for the
 *  side-list. Drops refs whose tab is missing (defensive) and skips
 *  groups that resolve fully empty. */
export function panelGroupViews(
  groups: TerminalGroup[],
  terminals: TerminalTab[],
): PanelGroupView[] {
  const byId = new Map(terminals.map((t) => [t.termId, t]));
  const views: PanelGroupView[] = [];
  for (const g of groups) {
    const panes = treeLeafNodes(g.layout)
      .flatMap((l) => l.tabs)
      .flatMap((r) => (r.kind === "terminal" ? [byId.get(r.id)] : []))
      .filter((t): t is TerminalTab => t != null);
    if (panes.length === 0) continue;
    views.push({
      groupId: g.groupId,
      panes,
      activeTermId: g.activeTermId,
      isSplit: panes.length > 1,
    });
  }
  return views;
}
