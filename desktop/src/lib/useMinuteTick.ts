// A clock for relative ages — one interval for the whole app.
//
// A row that says "2d" is a rendering of `now`, not of the data, so it goes
// stale the moment nothing else re-renders. The naive fix is a `setInterval`
// inside whichever component prints the age, which in the project roster means
// one timer per copy row: eleven projects with four copies each is 44 timers
// firing 44 renders a minute for text most of which never changes.
//
// So the timer is the module's, and components subscribe to it. It only runs
// while somebody is listening, and it stops when the last one unmounts.
//
// Not every list needs the same pace. The ladder (lib/relativeTime) has a
// seconds rung and a minutes rung, so a list whose freshest row is under an
// hour old moves every few seconds, while one whose freshest row is a day old
// can't change more than once an hour. Each subscriber says how often it needs
// re-reading; the one interval runs at the fastest pace anyone asked for, and a
// slower subscriber is only re-rendered when its own period has passed.
//
// The cloud sidebar once held `useState(() => Date.now())` — the moment it
// mounted, forever. Anything that happened after that read as "just now" (an
// age below zero clamps to the floor) and everything older kept whatever age it
// had at mount, so the list said "just now" ten minutes later.

import { useEffect, useState } from "react";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** A tick may land a little early or late; a subscriber whose period is
 *  this close to elapsed is due rather than left for a whole extra tick. */
const SLACK_MS = SECOND;

/**
 * How often a list should re-read the clock, from the age of its freshest row.
 *
 * Under a minute the seconds rung is showing ("27s ago"); under an hour the
 * minutes rung is ("12m ago"); past that, the label can't move faster than
 * hourly and a minute of lag is invisible. An unknown age, or none at all,
 * gets the slow pace — there is nothing showing that could move faster.
 */
export function agePeriodFor(ageMs: number): number {
  if (!Number.isFinite(ageMs)) return MINUTE;
  if (ageMs < MINUTE) return 15 * SECOND;
  if (ageMs < HOUR) return 30 * SECOND;
  return MINUTE;
}

/** What the clock needs from the outside, so it can be driven by a test. */
export type ClockEnv = {
  now: () => number;
  every: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  hidden: () => boolean;
};

type Subscriber = { period: number; last: number; notify: (now: number) => void };

export type AgeClock = {
  /** Listen at `period`; returns the way to stop. */
  subscribe: (period: number, notify: (now: number) => void) => () => void;
  /** Every subscriber, now — the window has just come back into view. */
  wake: () => void;
  /** The interval's pace, or 0 when nobody is listening. */
  pace: () => number;
};

export function createAgeClock(env: ClockEnv): AgeClock {
  const subs = new Set<Subscriber>();
  let handle: unknown = null;
  let running = 0;

  function tick(): void {
    // Nobody can read a hidden window; `wake` catches it up when it shows.
    if (env.hidden()) return;
    // One reading for everyone due this tick, so two lists can't disagree
    // about the same instant.
    const now = env.now();
    for (const s of subs) {
      if (now - s.last >= s.period - SLACK_MS) {
        s.last = now;
        s.notify(now);
      }
    }
  }

  function reschedule(): void {
    let want = 0;
    for (const s of subs) want = want === 0 ? s.period : Math.min(want, s.period);
    if (want === running) return;
    if (handle != null) env.cancel(handle);
    handle = null;
    running = want;
    if (want > 0) handle = env.every(tick, want);
  }

  return {
    subscribe(period, notify) {
      const sub: Subscriber = { period, last: env.now(), notify };
      subs.add(sub);
      reschedule();
      return () => {
        subs.delete(sub);
        reschedule();
      };
    },
    wake() {
      const now = env.now();
      for (const s of subs) {
        s.last = now;
        s.notify(now);
      }
    },
    pace: () => running,
  };
}

let shared: AgeClock | null = null;

/** The app's one clock, made on first use so importing this file touches no
 *  browser global. */
function appClock(): AgeClock {
  if (shared) return shared;
  const clock = createAgeClock({
    now: () => Date.now(),
    every: (fn, ms) => window.setInterval(fn, ms),
    cancel: (h) => window.clearInterval(h as number),
    hidden: () => document.visibilityState === "hidden",
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") clock.wake();
  });
  shared = clock;
  return clock;
}

/** The clock, re-read at whatever pace `periodOf` asks for at the time it
 *  last read — so a list that just got a fresh row speeds up on that render. */
function useClock(periodOf: (now: number) => number): number {
  const [now, setNow] = useState(() => Date.now());
  const period = periodOf(now);
  useEffect(() => appClock().subscribe(period, setNow), [period]);
  return now;
}

/**
 * `Date.now()`, refreshed once a minute.
 *
 * Read it once per component and pass it down to every age you format, so a
 * list's rows all agree about what time it is — two rows reading the clock a
 * few milliseconds apart can land on different sides of a boundary and print
 * "1m" next to "now" for the same instant.
 */
export function useMinuteTick(): number {
  return useClock(() => MINUTE);
}

/**
 * `Date.now()`, refreshed as often as a list whose freshest row happened at
 * `newestMs` (epoch ms) can visibly change — every 15 s while that row is
 * seconds old, slower as it ages. Same rule as `useMinuteTick`: one reading
 * per component, passed to every age it prints.
 */
export function useAgeTick(newestMs: number | null | undefined): number {
  return useClock((now) => agePeriodFor(newestMs != null && newestMs > 0 ? now - newestMs : Number.NaN));
}
