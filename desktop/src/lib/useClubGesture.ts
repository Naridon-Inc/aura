// The two club stores, as React reads them.
//
// Kept apart from `clubGesture` so that module stays free of React and can be
// executed by the tests rather than pinned by source — the gesture is the part
// with rules in it, and rules that only a screenshot can check are rules that
// drift. This file is the three lines of subscription those rules need to
// reach a component.
//
// Both getters hand back a value that is STABLE between changes (the gesture
// holds one `ClubPick`; the club store holds one `ClubState`), which is what
// `useSyncExternalStore` requires — a getter that rebuilds its snapshot per
// read re-renders forever.

import { useSyncExternalStore } from "react";

import { getClubPick, subscribeClubPick, type ClubPick } from "./clubGesture";
import {
  getClubState,
  subscribeClub,
  type ClubState,
} from "./workspaceClubStore";

/** The club being assembled right now, if any. */
export function useClubPick(): ClubPick {
  return useSyncExternalStore(subscribeClubPick, getClubPick, getClubPick);
}

/** Every club that exists, and which one is being viewed. */
export function useClubs(): ClubState {
  return useSyncExternalStore(subscribeClub, getClubState, getClubState);
}
