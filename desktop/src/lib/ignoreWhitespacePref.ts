// ignoreWhitespacePref — one shared, persisted toggle for whether diffs hide
// whitespace-only changes. Mirrors diffViewPref: stored so it survives
// reloads, and broadcast so every open diff pane flips together the moment one
// toggle is clicked. When ON, Monaco's `ignoreTrimWhitespace` is set true so a
// re-indent or trailing-space churn stops showing as a real change — exactly
// the noise reviewers want gone when reading a large diff.

import { sharedFlagPref } from "./sharedFlagPref";

const pref = sharedFlagPref("aura.git.ignoreWhitespace", "aura:ignore-whitespace-changed");

/** Read the current preference. Defaults to `false` (show whitespace changes)
 *  when unset or unreadable. */
export const getIgnoreWhitespace = pref.get;
/** Persist the preference and notify every open diff pane. */
export const setIgnoreWhitespace = pref.set;
/** Subscribe to preference changes. Returns an unsubscribe. */
export const subscribeIgnoreWhitespace = pref.subscribe;
