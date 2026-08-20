// Where the window is right now, when "right now" isn't this laptop.
//
// Entering a machine changes where everything you do runs, and until now the
// sidebar said nothing about it: the work area became the box's, and the rail
// beside it still showed only local checkouts with nothing lit. "Am I on my
// laptop or on the runner?" is the one question a remote workspace must never
// leave open, and the answer belongs in the same place you'd look to switch —
// the sidebar.
//
// It used to hold ONE machine, because entering one used to cost you every
// other place the window had open. It no longer does (see lib/remotePlaces), so
// this holds the same shape that does: an ordered set of the places you are in,
// with one of them focused. The sidebar lights the focused one as "you are
// here" and the rest as "also open" — the honest drawing of a window that can
// be in several places at once.
//
// Two authorities, deliberately:
//   • App owns MEMBERSHIP and FOCUS — it is the thing that knows which places
//     the window is holding and which one is in front. See `syncMachines`.
//   • The workspace owns RESOLUTION — a request may name no machine at all (one
//     opened from a cloud conversation names a thread) and may name a machine
//     the book no longer holds, so only the mounted workspace knows what a
//     request actually turned into. See `resolveMachine`.
// A re-sync never clobbers a resolution, and a sync never invents one.
//
// Same shape as pagesActiveTitle: a private subscriber set behind
// useSyncExternalStore. No context provider, because the two ends are App's
// content region and the sidebar, which have no common ancestor worth adding
// one to.

import { useSyncExternalStore } from "react";

/** What the window is standing in. Both halves can be set: you enter a machine
 *  *through* a piece of cloud work as often as you enter it directly, and the
 *  row you clicked is the row that should light. */
export type ActiveMachine = {
  /** `user@host` of the box, once resolved. */
  machineId: string | null;
  /** The cloud conversation you arrived through, if you came that way. */
  threadKey: string | null;
};

/** One place in the set, under the window's own key for it (`remotePlaceKey`).
 *  The key is what a sync and a resolution agree on, so the same place can be
 *  re-published carrying a machine it didn't have a moment ago.
 *
 *  `repoRoot` is the checkout on THIS laptop the place belongs to — the board,
 *  the transcript and the intent log stay here whichever machine holds the
 *  code. It is carried because the window can be in several places at once, so
 *  "which machine does work on this project run on?" is a question with a
 *  per-project answer (`machineIdForRoot`), not a single window-wide one. */
export type MachinePresence = ActiveMachine & {
  key: string;
  repoRoot: string | null;
};

/** Not on a machine — this laptop, and whatever it has open. */
export const NO_MACHINE: ActiveMachine = { machineId: null, threadKey: null };

/** A member as `syncMachines` takes it: a key, plus whatever the request that
 *  opened it happened to name. */
export type MachineMember = { key: string; repoRoot?: string | null } & Partial<
  ActiveMachine
>;

let entered: readonly MachinePresence[] = [];
let focusedKey: string | null = null;
let focused: ActiveMachine = NO_MACHINE;
const subs = new Set<() => void>();

/** An empty string is not a machine. The workspace publishes whatever it
 *  resolved, and a request can carry a blank — which must not light a row. */
function clean(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function samePair(a: ActiveMachine, b: ActiveMachine): boolean {
  return a.machineId === b.machineId && a.threadKey === b.threadKey;
}

/** One spelling of a project root, so `/a/b` and `/a/b/` are one project. */
function sameRootText(value: string | null | undefined): string | null {
  const v = value?.trim().replace(/\/+$/, "");
  return v ? v : null;
}

/** Commit a new set + focus, and wake subscribers — but only when something
 *  actually moved. Identity matters as much as equality here: the roster reads
 *  through `useSyncExternalStore`, and a fresh object per publish would
 *  re-render it on every minute tick for a value that did not change. */
function settle(
  nextEntered: readonly MachinePresence[],
  nextFocusedKey: string | null,
  membershipMoved: boolean,
): void {
  const member = nextFocusedKey
    ? (nextEntered.find((m) => m.key === nextFocusedKey) ?? null)
    : null;
  const pair: ActiveMachine = member
    ? { machineId: member.machineId, threadKey: member.threadKey }
    : NO_MACHINE;
  const pairMoved = !samePair(pair, focused);
  if (!membershipMoved && !pairMoved && focusedKey === nextFocusedKey) return;
  entered = nextEntered;
  focusedKey = nextFocusedKey;
  // Only when it really moved: a reader that watches where you are standing
  // must not re-render because some OTHER place joined or left the set.
  if (pairMoved) focused = pair;
  for (const fn of subs) fn();
}

/** Publish the places the window is holding, and which one it is looking at.
 *
 *  Idempotent, and never destructive of what a mounted workspace resolved: a
 *  member already in the set keeps its resolved pair, because App only ever
 *  knows what was *asked* for. New members arrive with whatever the request
 *  named — which is the whole answer for a box entered by id, and nothing at
 *  all for one entered through a conversation. */
export function syncMachines(
  members: readonly MachineMember[],
  nextFocusedKey: string | null,
): void {
  const next: MachinePresence[] = [];
  for (const m of members) {
    const key = m.key.trim();
    if (!key) continue;
    const held = entered.find((e) => e.key === key);
    const repoRoot = sameRootText(m.repoRoot);
    if (held) {
      // A held member keeps everything the workspace resolved for it. The one
      // thing a re-sync may still teach it is the project — a place entered
      // through a conversation names no repo until App learns which board the
      // thread belongs to — so that is folded in, and only then.
      next.push(
        held.repoRoot || !repoRoot ? held : { ...held, repoRoot },
      );
      continue;
    }
    next.push({
      key,
      machineId: clean(m.machineId),
      threadKey: clean(m.threadKey),
      repoRoot,
    });
  }
  const focus = next.some((m) => m.key === nextFocusedKey)
    ? nextFocusedKey
    : null;
  const moved =
    next.length !== entered.length || next.some((m, i) => m !== entered[i]);
  settle(moved ? next : entered, focus, moved);
}

/** "That request turned out to be this box." Published by the workspace once it
 *  has read the machine book. A key that isn't a member is ignored — a
 *  workspace unmounting as the user leaves must not put the place back. */
export function resolveMachine(
  key: string,
  machineId: string | null,
  threadKey: string | null = null,
  repoRoot: string | null = null,
): void {
  const at = entered.findIndex((m) => m.key === key.trim());
  if (at < 0) return;
  const held = entered[at]!;
  const pair: ActiveMachine = {
    machineId: clean(machineId),
    threadKey: clean(threadKey),
  };
  // A workspace that hasn't worked out its project yet must not erase the one
  // the request already named — a resolution adds, it never forgets.
  const root = sameRootText(repoRoot) ?? held.repoRoot;
  if (samePair(held, pair) && root === held.repoRoot) return;
  const next = entered.slice();
  next[at] = { key: held.key, repoRoot: root, ...pair };
  settle(next, focusedKey, true);
}

/** Watch for the window changing machines. Returns the unsubscribe. */
export function subscribeActiveMachine(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** Where this window is looking, read once. `NO_MACHINE` means here — either
 *  you are in no box at all, or you are holding some and standing in front of
 *  something else. */
export function getActiveMachine(): ActiveMachine {
  return focused;
}

/** Every machine the window is holding, focused or not, least- to
 *  most-recently focused. */
export function getEnteredMachines(): readonly MachinePresence[] {
  return entered;
}

/**
 * The machine work on `root` should run on, right now — `null` for this laptop.
 *
 * This is what every door that starts something (a chat, an agent, a terminal,
 * a workspace) asks before it opens. Without it those doors said nothing about
 * where they ran, which meant they all ran here: you could be standing in a box
 * with its files on screen, press ⌘N, and get a conversation about your laptop
 * that looked identical to one about the machine. A window that can be in
 * several places at once has to answer this per place, not once.
 *
 * The answer is the place you are LOOKING at, not merely one you are holding.
 * A box you left covering a page is still open and one click away, but you are
 * not standing in it, so starting something while reading Trace starts it here
 * — which is the only reading that matches what is in front of you.
 *
 * The root has to agree, because one window holds several projects: standing in
 * a box that holds project A says nothing about where work on project B should
 * run. A place that hasn't named a project yet (entered from the fleet, or from
 * a conversation whose repo isn't resolved) is taken at its word — you are in
 * it, and it is the only place you are in.
 */
export function machineIdForRoot(root: string | null | undefined): string | null {
  const want = sameRootText(root);
  if (!want) return null;
  const place = focusedKey
    ? (entered.find((m) => m.key === focusedKey) ?? null)
    : null;
  if (!place?.machineId) return null;
  if (place.repoRoot && place.repoRoot !== want) return null;
  return place.machineId;
}

/** Where this window is. `{ machineId: null, threadKey: null }` means here. */
export function useActiveMachine(): ActiveMachine {
  return useSyncExternalStore(
    subscribeActiveMachine,
    getActiveMachine,
    getActiveMachine,
  );
}

/** Every machine the window is holding. The sidebar draws the focused one as
 *  "you are here" and the others as still open. */
export function useEnteredMachines(): readonly MachinePresence[] {
  return useSyncExternalStore(
    subscribeActiveMachine,
    getEnteredMachines,
    getEnteredMachines,
  );
}

/** Drop everything — window teardown, and tests putting the module singleton
 *  back where they found it. */
export function clearMachines(): void {
  syncMachines([], null);
}
