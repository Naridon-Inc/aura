// The lens strip Workspaces wears in its surface header: which drawing of the
// fleet am I reading — the time-grouped list, the status board, or the live
// control plane.
//
// It sits in its own file for the same reason Tasks' `WorkLensTabs` does. The
// strip is the one part of a surface you have to be able to look at on its own
// — a control whose whole job is to meet the header's rule cannot be judged
// from a unit test or from a screenshot of whatever page happened to be open —
// so the chrome harness renders this file directly. Left inline in
// `WorkspacesSurface` the harness would have had to draw a copy of it, and a
// copy is exactly the drift the shared strip exists to end.

import type { JSX } from "react";
import { Activity, KanbanSquare, List, type LucideIcon } from "lucide-react";

import { ViewTabs } from "../ui/tabs";

/** Which lens the fleet is being read through. */
export type Lens = "all" | "board" | "live";

/** The glyphs are Tasks' glyphs, deliberately. A list of things grouped by
 *  time and a set of status lanes are the same two drawings there and here, so
 *  they wear the same two marks — a reader who has learned the strip on one
 *  surface has learned it on the other. `Activity` is the odd one out because
 *  Live is the odd one out: it is the only lens that asks the backend who is
 *  standing in each copy right now, so it gets the pulse rather than a layout
 *  glyph. The `hint` becomes the cell's tooltip, a second way to learn a tab
 *  rather than the only one. */
export const FLEET_LENSES: {
  value: Lens;
  label: string;
  icon: LucideIcon;
  hint: string;
}[] = [
  {
    value: "all",
    label: "All",
    icon: List,
    hint: "Every copy, grouped by when it was last touched",
  },
  {
    value: "board",
    label: "Board",
    icon: KanbanSquare,
    hint: "Every copy as lanes you can scan across, by status",
  },
  {
    value: "live",
    label: "Live",
    icon: Activity,
    hint: "Who is standing in each copy right now, and what they've taken hold of",
  },
];

export function FleetLensTabs({
  lens,
  onLens,
}: {
  lens: Lens;
  onLens: (next: Lens) => void;
}): JSX.Element {
  return (
    <ViewTabs<Lens>
      ariaLabel="Fleet lens"
      value={lens}
      onChange={onLens}
      options={FLEET_LENSES.map(({ value, label, icon: Icon, hint }) => ({
        value,
        label,
        icon: <Icon strokeWidth={1.5} aria-hidden />,
        title: hint,
      }))}
    />
  );
}
