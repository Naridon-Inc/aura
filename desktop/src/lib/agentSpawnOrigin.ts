// Where was the user standing when this agent was asked for?
//
// Starting a coding agent is an await: `agent_pty_open` spawns the CLI and
// answers a second or more later. Every caller then hands the new tab to the
// editor store, and the store filed it under whichever project was on screen
// WHEN THE AWAIT ENDED. Switch projects while Claude is starting and the tab
// lands in the project you switched to — a Claude running in the Aura repo
// sitting in Mixrank's tab strip, with nothing on it saying so.
//
// So the spawn itself records where it began, keyed by the session id the
// backend hands back, and the store asks before it places the tab. The store
// owns what "the place on screen" means (a repo root, a remote place, a club),
// so it binds the reader; this module only remembers the answer.
//
// Free of React and Tauri on purpose, so the rule can be run under bun.

/** An origin older than this is not the answer to "where did this launch
 *  start" any more — it is a reattach whose tab never came through here, and
 *  acting on it would move a tab the user opened somewhere on purpose. A real
 *  spawn resolves in seconds; this is generous for a slow machine. */
export const SPAWN_ORIGIN_TTL_MS = 2 * 60 * 1000;

/** Spawns whose tab never arrives (a reattach, a caller that bailed) are
 *  never taken. Past this many the oldest are dropped. */
export const SPAWN_ORIGIN_LIMIT = 64;

type Origin = { place: string; at: number };

const origins = new Map<string, Origin>();
let readPlace: () => string | null = () => null;
let now: () => number = () => Date.now();

/** The store tells this module how to read the place on screen. Unbound (a
 *  popout, a test), nothing is recorded and every tab opens where it always
 *  did. */
export function bindSpawnPlaceReader(fn: () => string | null) {
  readPlace = fn;
}

/** The place on screen right now, read at the START of a spawn. */
export function placeAtSpawnStart(): string | null {
  try {
    return readPlace();
  } catch {
    return null;
  }
}

/** Remember that `sessionId`'s spawn began in `place`. A null place (nothing
 *  open yet) records nothing. */
export function recordSpawnOrigin(sessionId: string, place: string | null) {
  if (!sessionId || !place) return;
  origins.delete(sessionId);
  origins.set(sessionId, { place, at: now() });
  while (origins.size > SPAWN_ORIGIN_LIMIT) {
    const oldest = origins.keys().next().value;
    if (oldest === undefined) break;
    origins.delete(oldest);
  }
}

/** Where `sessionId`'s spawn began — once. Taking it forgets it, so a later,
 *  deliberate open of the same session is never steered by an old launch. */
export function takeSpawnOrigin(sessionId: string): string | null {
  const hit = origins.get(sessionId);
  if (!hit) return null;
  origins.delete(sessionId);
  return now() - hit.at <= SPAWN_ORIGIN_TTL_MS ? hit.place : null;
}

/** Test seam: swap the clock and drop everything remembered. */
export function resetSpawnOriginsForTest(clock?: () => number) {
  origins.clear();
  now = clock ?? (() => Date.now());
  readPlace = () => null;
}
