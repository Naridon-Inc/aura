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
// A minute is the resolution the ladder actually has (see lib/relativeTime):
// below "1m" everything reads "now", and above an hour a minute of drift is
// invisible. Ticking faster would only buy re-renders.

import { useEffect, useState } from "react";

const MINUTE = 60_000;

const listeners = new Set<() => void>();
let timer: number | null = null;

function start(): void {
  if (timer != null) return;
  timer = window.setInterval(() => {
    for (const notify of listeners) notify();
  }, MINUTE);
}

function stop(): void {
  if (timer == null) return;
  window.clearInterval(timer);
  timer = null;
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
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const notify = () => setNow(Date.now());
    listeners.add(notify);
    start();
    return () => {
      listeners.delete(notify);
      if (listeners.size === 0) stop();
    };
  }, []);
  return now;
}
