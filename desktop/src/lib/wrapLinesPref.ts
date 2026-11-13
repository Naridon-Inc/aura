// wrapLinesPref — whether the side-by-side diff wraps long lines instead of
// scrolling them sideways. Shared and persisted like the whitespace toggle:
// flip it in one diff pane and every open one follows. The inline diff always
// wraps, so only the side-by-side view reads it.

import { sharedFlagPref } from "./sharedFlagPref";

const pref = sharedFlagPref("aura.git.wrapLines", "aura:wrap-lines-changed");

export const getWrapLines = pref.get;
export const setWrapLines = pref.set;
export const subscribeWrapLines = pref.subscribe;
