// Carrying a tab, a terminal or a whole pane to somewhere else in the work
// area: a tab to another pane's tab strip, a terminal (an editor-area tab or
// a row of the terminal panel's list) onto one of the panel's groups or the
// panel's empty space, a pane to another place in the split.
//
// These used to be HTML5 drags. The desktop app's web view never delivers an
// HTML5 `dragover` or `drop` (see `components/ui/use-pointer-drag.ts`), so
// every one of them picked up and never landed. They are pointer drags now,
// and the pickers-up and the places they land live in different components,
// so they meet through the shared scopes below. What a drop does is decided
// here, once, for every source.

/** The scope every work-area tab and terminal-panel row is carried in. */
export const TAB_DRAG_SCOPE = "work-tab";

/** The scope a whole pane is carried in, to another place in the split. */
export const PANE_DRAG_SCOPE = "work-pane";

/** What is being carried in `TAB_DRAG_SCOPE`. */
export interface TabDrag {
  /** Where an editor-area tab sits, when it is one. */
  from?: { paneId: string; index: number };
  /** The terminal it is, when it is one. */
  termId?: string;
}

/** The names the places a tab can land on are marked with. Each kind has its
 *  own prefix, so a pane and a terminal group never share a name. */
export const tabDropKey = {
  pane: (paneId: string) => `pane:${paneId}`,
  group: (groupId: string) => `group:${groupId}`,
  panel: "panel",
} as const;

export type TabDropAction =
  /** Move an editor-area tab to another pane's strip. */
  | { kind: "move"; srcPaneId: string; srcIndex: number; dstPaneId: string }
  /** Tile a terminal into one of the panel's groups. */
  | { kind: "merge"; termId: string; groupId: string }
  /** Bring a terminal into the panel as its own group. */
  | { kind: "demote"; termId: string };

/** What dropping `item` on the place named `key` does, or undefined when that
 *  place does not take it: a pane's strip takes tabs from other panes, the
 *  panel and its groups take terminals. */
export function tabDropAction(item: TabDrag | undefined, key: string | undefined): TabDropAction | undefined {
  if (!item || key === undefined) return undefined;
  if (key === tabDropKey.panel) return item.termId ? { kind: "demote", termId: item.termId } : undefined;
  const sep = key.indexOf(":");
  if (sep <= 0 || sep === key.length - 1) return undefined;
  const kind = key.slice(0, sep);
  const id = key.slice(sep + 1);
  if (kind === "pane") {
    if (!item.from || item.from.paneId === id) return undefined;
    return { kind: "move", srcPaneId: item.from.paneId, srcIndex: item.from.index, dstPaneId: id };
  }
  if (kind === "group") return item.termId ? { kind: "merge", termId: item.termId, groupId: id } : undefined;
  return undefined;
}

/** Where a pane carried from `from` lands when dropped on the pane named
 *  `key`, or undefined when it stays put. */
export function paneDropIndex(from: number | undefined, key: string | undefined): number | undefined {
  if (from === undefined || key === undefined || !/^\d+$/.test(key)) return undefined;
  const to = Number(key);
  return to === from ? undefined : to;
}
