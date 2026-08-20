// The shell holds MANY places at once, not one.
//
// `editorStore` used to keep a single module-level `state`. Opening a second
// project therefore cost you the first one: the switch wiped live state to
// defaults and rebuilt it from the on-disk snapshot. A snapshot is a summary —
// tab identities and paths — so everything that isn't summarisable came back
// wrong or not at all: unsaved buffers, diff baselines, which pane had focus,
// agent tabs stamped cold because "off disk" is the only thing a restore can
// assume. Switching back cost you the second project the same way.
//
// This is the registry that makes a switch a FOCUS. One live `S` per place,
// keyed by whatever the caller calls a place (a repo root, a worktree path, the
// club view's own key). `park` keeps the focused place's slot current, `focus`
// hands the whole thing back untouched, and `forget` is the ONLY wipe — that is
// closing a place, which is a thing the user asked for.
//
// Generic on purpose. It holds `State` for the editor, knows nothing about it,
// and can be tested without dragging React, Tauri and xterm in behind it.

/** Default ceiling on live places. Generous — a place costs its open buffers
 *  and tab metadata, and someone juggling a dozen checkouts is exactly who this
 *  registry is for. Past the cap the least-recently-focused unpinned place is
 *  dropped; it still has its on-disk snapshot, so re-entering it behaves the
 *  way every switch used to. */
export const DEFAULT_LIVE_PLACE_LIMIT = 12;

export type PlaceRegistryOptions<S> = {
  /** Max live places to hold. Defaults to `DEFAULT_LIVE_PLACE_LIMIT`. */
  limit?: number;
  /** "This place holds something a snapshot cannot rebuild" — unsaved edits,
   *  typically. Pinned places are never evicted, even over the cap: dropping
   *  one would destroy work silently, which is worse than holding memory. */
  pinned?: (state: S) => boolean;
};

export type PlaceRegistry<S> = {
  /** Make `place`'s slot hold `state`, and mark it most-recently-used.
   *  Returns the places evicted to stay under the cap (usually none) so the
   *  caller can say so out loud rather than losing them quietly. */
  park(place: string, state: S): string[];
  /** The live state for `place`, marking it most-recently-used. Null when this
   *  place has never been opened this session (or was closed) — the caller
   *  rehydrates from its snapshot, exactly as before. */
  focus(place: string): S | null;
  /** Read without touching recency. For assertions and diagnostics. */
  peek(place: string): S | null;
  /** Is this place already loaded? A true here is the difference between a
   *  focus and a reload. */
  has(place: string): boolean;
  /** Drop `place`'s live state. Closing, not switching. Returns whether
   *  anything was held. */
  forget(place: string): boolean;
  /** Every live place, least- to most-recently-focused. */
  places(): string[];
  size(): number;
  /** Drop everything (window teardown, tests). */
  clear(): void;
};

/** Build a live-state registry keyed by place. */
export function createPlaceRegistry<S>(
  opts: PlaceRegistryOptions<S> = {},
): PlaceRegistry<S> {
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIVE_PLACE_LIMIT);
  const isPinned = opts.pinned;
  // Insertion order IS the recency order: every park/focus deletes the key
  // before re-setting it, so the map reads oldest→newest end to end.
  const held = new Map<string, S>();

  function touch(place: string, state: S) {
    held.delete(place);
    held.set(place, state);
  }

  function evictToLimit(): string[] {
    if (held.size <= limit) return [];
    const evicted: string[] = [];
    for (const [place, state] of held) {
      if (held.size - evicted.length <= limit) break;
      // Never the place we just parked (it is the newest, so the loop reaches
      // it last anyway) and never one holding unsaved work.
      if (isPinned?.(state)) continue;
      evicted.push(place);
    }
    for (const place of evicted) held.delete(place);
    return evicted;
  }

  return {
    park(place, state) {
      touch(place, state);
      return evictToLimit();
    },
    focus(place) {
      if (!held.has(place)) return null;
      const state = held.get(place) as S;
      touch(place, state);
      return state;
    },
    peek(place) {
      return held.has(place) ? (held.get(place) as S) : null;
    },
    has(place) {
      return held.has(place);
    },
    forget(place) {
      return held.delete(place);
    },
    places() {
      return [...held.keys()];
    },
    size() {
      return held.size;
    },
    clear() {
      held.clear();
    },
  };
}
