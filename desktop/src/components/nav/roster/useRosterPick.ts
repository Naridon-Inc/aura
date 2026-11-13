// A side-by-side pick, in progress (lib/clubGesture). While one is up every
// place row in the list is a checkbox rather than a door: the gesture that
// makes a pair is "click two rows", and a row that behaved differently
// depending on what kind of place it is would make that "click two rows,
// unless one of them is a machine".

import { isPickedPlace, toggleClubPick } from "../../../lib/clubGesture";
import { useClubPick } from "../../../lib/useClubGesture";
import type { PlaceRef } from "../../../lib/placeRef";

export type PickRow = {
  picked: boolean;
  pickTitle: string;
  toggle: () => void;
};

export type RosterPick = {
  picking: boolean;
  pickRow: (ref: PlaceRef) => PickRow;
};

export function useRosterPick(): RosterPick {
  const { picking } = useClubPick();
  /** What a place row does when it is clicked while a pick is up. Every row
   *  kind goes through this, so all three answer the gesture the same way and
   *  none of them can quietly opt out of it. */
  const pickRow = (ref: PlaceRef): PickRow => {
    const picked = picking && isPickedPlace(ref);
    return {
      picked,
      pickTitle: picked
        ? "Picked for side by side. Click to drop it"
        : "Pick this for side by side",
      toggle: () => toggleClubPick(ref),
    };
  };
  return { picking, pickRow };
}
