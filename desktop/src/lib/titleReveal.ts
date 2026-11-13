// When a tab or a sidebar row learns what it is actually called — a chat once
// its first message is summarised, an agent once its terminal says what it is
// doing, a workspace once its branch has a name — the new name arrives in a
// short pixel reveal instead of a silent swap. The eye was on "New chat"; the
// reveal is what tells it that this is the same tab, now with a name.
//
// This file is the part with no React in it: which changes are worth showing,
// and what the label looks like at any instant of the reveal. The component in
// components/ui/title-reveal.tsx only draws what this returns.
//
// The memory is module-level, keyed by the thing's own identity (a tab's pane
// ref, a row's path), not held in component state. A tab strip remounts a tab
// when its label changes, a split moves a tab between panes, and a hot reload
// remounts everything; none of those is a rename, and component state would
// see every one of them as a first sight or lose the reveal halfway through.

/** How long one reveal lasts. */
export const REVEAL_MS = 520;

/** A name that changes this soon after its row first appeared is the row
 *  finishing loading — a reopened chat trading the opener's hint for its
 *  stored title, a page's host giving way to its title — not news. It is
 *  adopted without a show. */
export const SETTLE_MS = 700;

/** Keys remembered at once. Far above any real count of tabs and rows; the cap
 *  only keeps a long session from holding every tab it ever closed. */
const MEMORY_CAP = 400;

type Seen = { value: string; firstSeenAt: number };

type Playing = { from: string; to: string; startedAt: number; seed: number };

/** A reveal in progress: what the label was, what it is now, and how far
 *  between the two it has got (0 → 1). */
export type RevealState = Playing & { progress: number };

const seen = new Map<string, Seen>();
const playing = new Map<string, Playing>();

const systemClock = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();
let clock: () => number = systemClock;

/** The time every reveal is measured against. */
export function revealNow(): number {
  return clock();
}

/** Swap the clock — tests step it by hand, and the visual harness stops it at
 *  the frame it is capturing. `null` puts the real one back. */
export function setRevealClock(next: (() => number) | null): void {
  clock = next ?? systemClock;
}

/** Forget every name seen, so the next sight of each is a first one. */
export function forgetReveals(): void {
  seen.clear();
  playing.clear();
}

function remember(key: string, entry: Seen): void {
  if (!seen.has(key) && seen.size >= MEMORY_CAP) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) {
      seen.delete(oldest);
      playing.delete(oldest);
    }
  }
  seen.set(key, entry);
}

function hashText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Note that `key` now reads `value`, and say whether a reveal is playing.
 *
 * Called on every render of the thing that shows the name, so it is
 * idempotent: only the first call to see a new value can start a reveal, and
 * every later call reads that same reveal back until it ends.
 *
 * Nothing plays on the first sight of a key (a tab opening, the app starting,
 * a module reloading), within {@link SETTLE_MS} of it, for an unchanged value,
 * or while the reader has asked the system for less motion.
 */
export function noteReveal(
  key: string,
  value: string,
  opts: { reducedMotion?: boolean; now?: number } = {},
): RevealState | null {
  const now = opts.now ?? clock();
  const prev = seen.get(key);
  if (!prev) {
    remember(key, { value, firstSeenAt: now });
    return null;
  }
  if (prev.value !== value) {
    seen.set(key, { value, firstSeenAt: prev.firstSeenAt });
    if (now - prev.firstSeenAt >= SETTLE_MS && !opts.reducedMotion) {
      playing.set(key, {
        from: prev.value,
        to: value,
        startedAt: now,
        seed: hashText(`${key}\u0000${value}`),
      });
    } else {
      playing.delete(key);
    }
  }
  const p = playing.get(key);
  if (!p) return null;
  const progress = (now - p.startedAt) / REVEAL_MS;
  if (opts.reducedMotion || p.to !== value || progress >= 1 || progress < 0) {
    playing.delete(key);
    return null;
  }
  return { ...p, progress };
}

/** One character position of a frame: a letter, or a lit pixel standing in for
 *  the letter that is about to land there. `level` is how bright it is. */
export type RevealCell = { kind: "char"; ch: string } | { kind: "px"; level: 1 | 2 | 3 };

/** Frames per reveal at which a pixel may change brightness. Coarse on
 *  purpose: a pixel that flickers every display frame reads as noise. */
const STEPS = 24;

function noise(seed: number, a: number, b: number): number {
  let h = seed ^ Math.imul(a + 1, 0x27d4eb2d) ^ Math.imul(b + 1, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The label at `progress` (0 → 1) of a reveal from `from` to `to`.
 *
 * Positions turn over left to right: each one holds the old letter, flickers
 * as a pixel for a moment, then lands on the new letter. The start times are
 * staggered along the word and each pixel's dwell is a little different, so
 * the name resolves as a ripple rather than a single blink. Spaces stay
 * spaces throughout, so the shape of the new words shows before their
 * letters do. At 1 the frame is exactly `to`.
 */
export function revealFrame(from: string, to: string, progress: number, seed: number): RevealCell[] {
  const was = Array.from(from);
  const next = Array.from(to);
  const n = Math.max(was.length, next.length);
  const step = Math.floor(Math.min(Math.max(progress, 0), 1) * STEPS);
  const cells: RevealCell[] = [];
  for (let i = 0; i < n; i++) {
    const start = (n <= 1 ? 0 : i / (n - 1)) * 0.5;
    const end = Math.min(1, start + 0.22 + 0.28 * noise(seed, i, -1));
    const old = was[i];
    const fresh = next[i];
    if (progress >= end) {
      if (fresh !== undefined) cells.push({ kind: "char", ch: fresh });
    } else if (progress < start) {
      if (old !== undefined) cells.push({ kind: "char", ch: old });
    } else {
      const under = fresh ?? old;
      if (under === undefined) continue;
      if (/\s/.test(under)) cells.push({ kind: "char", ch: " " });
      else cells.push({ kind: "px", level: (1 + Math.floor(noise(seed, i, step) * 3)) as 1 | 2 | 3 });
    }
  }
  return cells;
}
