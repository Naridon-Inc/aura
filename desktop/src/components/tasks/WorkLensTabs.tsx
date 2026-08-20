// The Tasks destination's tabs.
//
// Which drawing of the work you're on — List, Board, Graph — drawn with the
// app's tab control (`ui/tabs`), the strip a surface header wears.
//
// It used to be the icon-only variant of the board's layout switch: 28px
// squares with no words, at the top-left of the surface, where every other
// place in this app puts named tabs. That is a different control to read — you
// learn it by hovering each square and waiting for a tooltip — for the one job
// the app had already standardised. Whatever a strip of bare glyphs saves in
// width, it spends on the reader.
//
// Then it was `Segment`, the toggle group, which put a bordered track inside
// the header bar: a box drawn in the middle of a bar that is already a box,
// with the two hairlines a few pixels apart. `ViewTabs` is the same three
// cells sitting ON the header's rule instead of floating inside it, which is
// what the rest of the world means by a tab.
//
// Both surfaces behind the destination render THIS, not two copies of it: the
// board (List, Board) and the crew (Graph). The strip must not move, change
// width or change vocabulary at the moment you press it, and the only way to
// guarantee that is for it to be the same element either side of the switch.

import type { JSX } from "react";

import { ViewTabs } from "../ui/tabs";
import { WORK_LENSES, type WorkLens } from "../../lib/workRoute";

export function WorkLensTabs({
  lens,
  onLens,
}: {
  lens: WorkLens;
  onLens: (next: WorkLens) => void;
}): JSX.Element {
  return (
    <ViewTabs<WorkLens>
      value={lens}
      onChange={onLens}
      ariaLabel="Tasks view"
      options={WORK_LENSES.map((opt) => {
        const Icon = opt.icon;
        return {
          value: opt.value,
          label: opt.label,
          // The glyph stays — it's the tab's mark, and `.ade-tabs` lays it
          // beside the word rather than instead of it. `hint` becomes the
          // tooltip, which is now a second way to learn the tab rather than
          // the only one.
          icon: <Icon strokeWidth={1.5} aria-hidden />,
          title: opt.hint,
        };
      })}
    />
  );
}
