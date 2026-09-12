// Walk every open tab across every pane, in strip order, wrapping at the ends.
//
// ⌘⌥← / ⌘⌥→ used to do nothing. Each pane's strip knows its own tabs and
// which one is up, but nothing knew the order across panes — so cycling
// stopped at a pane edge, or didn't exist. This is the arithmetic on its own:
// the store hands in what each pane holds, the keymap hands in a direction,
// and it answers with the pane and index to raise. No DOM, no store, so it is
// testable, and `lib/tabNav.ts` is the only glue.

/** One pane's strip: how many tabs it holds and which is up. */
export type PaneTabs = { paneId: string; count: number; activeIndex: number };

/** A place in the strip order — which pane, which slot in it. */
export type TabSlot = { paneId: string; index: number };

/** Every tab across every pane, in strip order. */
export function flattenSlots(panes: PaneTabs[]): TabSlot[] {
  const out: TabSlot[] = [];
  for (const p of panes) {
    for (let i = 0; i < p.count; i++) out.push({ paneId: p.paneId, index: i });
  }
  return out;
}

/** Where `current` sits in the flat order, or -1. */
export function slotPosition(slots: TabSlot[], current: TabSlot | null): number {
  if (!current) return -1;
  return slots.findIndex(
    (s) => s.paneId === current.paneId && s.index === current.index,
  );
}

/** The slot one step from `current` in `delta`'s direction, wrapping. With
 *  no current slot the walk starts from the first pane's raised tab. Null
 *  when there is nowhere else to go (one tab, or none). */
export function cycleSlot(
  panes: PaneTabs[],
  current: TabSlot | null,
  delta: 1 | -1,
): TabSlot | null {
  const slots = flattenSlots(panes);
  if (slots.length < 2) return null;
  let pos = slotPosition(slots, current);
  if (pos < 0) {
    const first = panes.find((p) => p.count > 0);
    pos = first
      ? slotPosition(slots, { paneId: first.paneId, index: first.activeIndex })
      : 0;
    if (pos < 0) pos = 0;
  }
  const next = (pos + delta + slots.length) % slots.length;
  return slots[next] ?? null;
}
