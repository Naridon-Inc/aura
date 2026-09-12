// The list of projects the sidebar draws — which projects Aura remembers you
// opened, oldest→newest.
//
// This used to be four copies of the same three lines spread through App.tsx,
// each with its own cap arithmetic (`slice(-8)`, `slice(-7)`, and a loader that
// trimmed on boot). The consequence was that a project could leave the roster
// without anyone deciding it should: the list was capped at eight, so opening a
// ninth silently evicted the oldest, and archiving a project you wanted to keep
// out of the way did not free its slot — an archived project still spent one of
// the eight. On a machine with six visible projects and two archived ones the
// list was permanently full, and the next thing that mentioned a repo pushed
// the oldest out for good. Some of those mentions come from the background — an
// agent worktree launching promotes its parent repo — which is why the losses
// looked like they happened while nobody was touching the app.
//
// So: one store, one cap, one rule about what may be forgotten.
//
//  - The cap is generous (`RECENTS_MAX`). It exists to bound the JSON, not to
//    keep the rail readable — the roster does that itself, with pinning, an
//    archived disclosure and per-project folding.
//  - Eviction only ever takes the oldest project you have neither pinned nor
//    archived. Both of those are you saying "keep this"; forgetting one is the
//    bug. If every entry is protected the list is allowed to run over the cap
//    rather than drop one.
//  - A failed write says so. `localStorage` failures used to be swallowed at
//    each call site, so a quota-full device kept a correct list in memory and
//    an out-of-date one on disk, and the rail quietly reverted at next launch.

import { isManagedWorktreeRoot } from "./hudProjects";
import {
  isWorkspaceArchived,
  isWorkspacePinned,
} from "./workspaceCustomization";

export const RECENTS_KEY = "aura.recents";

/** How many project roots we keep. High enough that no one reaches it by
 *  working normally — the roster is the thing that decides what's readable —
 *  and low enough that the stored JSON stays a few kilobytes. */
export const RECENTS_MAX = 40;

/** Projects the user has asked to keep: pinned to the top, or archived out of
 *  the way. Injectable so this module can be tested without standing up the
 *  customisation store. */
export type KeepPredicate = (root: string) => boolean;

const keptByDefault: KeepPredicate = (root) =>
  isWorkspacePinned(root) || isWorkspaceArchived(root);

/** Write the list, and complain in the console if the device refuses it.
 *  Returns whether it landed, so a caller that cares can tell. */
export function persistRecents(list: string[]): boolean {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
    return true;
  } catch (err) {
    // Not fatal — the in-memory list is still right for this session — but it
    // means the roster will come back short next launch, and that used to look
    // like projects vanishing on their own.
    console.warn("[recents] could not save the project list:", err);
    return false;
  }
}

/** Trim to the cap by dropping the oldest projects the user has not asked to
 *  keep. `protect` is never evicted regardless (the root that was just opened —
 *  dropping the thing you just asked for is how the old `slice(0, 8)` bug
 *  behaved). */
function capRecents(
  list: string[],
  isKept: KeepPredicate,
  protect?: string,
): string[] {
  if (list.length <= RECENTS_MAX) return list;
  const out = [...list];
  // Front is oldest, so scan forward for the first thing we're allowed to lose.
  while (out.length > RECENTS_MAX) {
    const victim = out.findIndex((r) => r !== protect && !isKept(r));
    if (victim === -1) break; // everything left is spoken for — keep them all
    out.splice(victim, 1);
  }
  return out;
}

/** The stored list, cleaned. Managed agent worktrees are filtered out for good
 *  (they belong under their parent in the roster, never as tiles of their own),
 *  and anything the cleaning changed is written straight back so the next boot
 *  starts from the repaired list. */
export function readRecents(isKept: KeepPredicate = keptByDefault): string[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(RECENTS_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const cleaned = parsed.filter(
    (s): s is string =>
      typeof s === "string" && s.length > 0 && !isManagedWorktreeRoot(s),
  );
  const capped = capRecents(cleaned, isKept);
  if (capped.length !== parsed.length) persistRecents(capped);
  return capped;
}

/** Remember a project root. Append-on-first-seen and order-preserving:
 *  re-opening a project you already have must not shuffle the rail, because
 *  tiles that move while you are reaching for one are worse than tiles in an
 *  imperfect order.
 *
 *  `front` puts the root at the head instead — used by the bundled sample,
 *  which leads the list rather than joining the end of it.
 *
 *  Returns `prev` unchanged when there is nothing to do, so a `setState` with
 *  this as its updater is a no-op re-render rather than a new array. */
export function rememberRecent(
  prev: string[],
  root: string,
  opts: { front?: boolean; isKept?: KeepPredicate } = {},
): string[] {
  if (!root || isManagedWorktreeRoot(root)) return prev;
  if (prev.includes(root)) return prev;
  const isKept = opts.isKept ?? keptByDefault;
  const grown = opts.front ? [root, ...prev] : [...prev, root];
  return capRecents(grown, isKept, root);
}

/** Forget a project root — the roster's Close, which takes the tile away and
 *  leaves the checkout on disk. */
export function forgetRecent(prev: string[], root: string): string[] {
  if (!prev.includes(root)) return prev;
  return prev.filter((r) => r !== root);
}

/** The most recently opened project, or null if this device has never opened
 *  one. Reads storage directly: the one caller needs it before React state
 *  exists. */
export function lastRecent(): string | null {
  const list = readRecents();
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]) return list[i];
  }
  return null;
}
