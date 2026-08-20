// The Changes panel's collapsible group.
//
// The markup moved to places/PlaceRail as `PlaceRailGroup` when the place
// rails were rebuilt in this panel's language — it is the group people
// actually like, so the rails render the same element rather than a
// look-alike. This stays as the Changes panel's name for it, with the
// controlled open/close it has always had.

import type { ReactNode } from "react";

import { PlaceRailGroup } from "../places/PlaceRail";

type Props = {
  title: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** Trailing controls — buttons shown next to the count chip,
   *  visible only when the row is hovered. */
  actions?: ReactNode;
  /** Shown instead of rows when the count is zero, and it keeps the group
   *  on screen. Without it a zero hides the group entirely — which is the
   *  right call for "there is genuinely nothing here", and the wrong one
   *  for "we couldn't find out". */
  empty?: ReactNode;
};

export function CategorySection({
  title,
  count,
  isOpen,
  onToggle,
  children,
  actions,
  empty,
}: Props) {
  return (
    <PlaceRailGroup
      title={title}
      count={count}
      open={isOpen}
      onToggle={onToggle}
      actions={actions}
      empty={empty}
    >
      {children}
    </PlaceRailGroup>
  );
}
