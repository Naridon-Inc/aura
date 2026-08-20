// Watching a machine start, without touching it.
//
// The wake itself is not this hook's job. Anything that reaches a sleeping place
// starts it — a terminal opening, an agent beginning, a file being read — so by
// the time a member notices, the machine is usually already on its way up. What
// this watches is the *wait*: whether a wake is in the air, since when, and
// whether it has run past the usual minute.
//
// It exists as a separate poll from `useBox` because the two ask opposite
// questions. `useBox` reaches the machine, and must therefore go quiet while the
// machine is asleep — a poll that dialled would be a poll that woke the box
// every twelve seconds, which is scale-to-zero undone by a panel somebody left
// open. `place_waking` reaches nothing at all: it reads the machine book and the
// wake in flight, in-process, so it is safe to ask on a timer precisely when the
// other one cannot be.
//
// The other half of why it is polled rather than derived from the click: the
// wake may not be ours. Five surfaces reaching one sleeping place produce one
// wake with five callers on it, and four of those callers never pressed
// anything. A panel that only knew about its own button would show "Asleep" over
// a machine that is visibly starting.

import { useEffect, useState } from "react";

import { api, type Waking } from "../../lib/api";

/** How often to re-ask while a place is starting.
 *
 *  Fast, because the answer is a local read and because the number on screen is
 *  a running count of seconds — one that jumped in twelve-second steps would
 *  read as a stalled screen rather than a live one. */
const WHILE_WAKING_MS = 1_000;

/** How often to re-ask about a place that is merely asleep.
 *
 *  Slower: nothing is happening, and the only thing that could change is
 *  somebody elsewhere reaching the machine. Still polled, because that is
 *  exactly the case worth catching. */
const WHILE_ASLEEP_MS = 4_000;

/** Whether this place is starting, refreshed while it matters.
 *
 *  Null until the first answer lands, and null for a place with no machine —
 *  this laptop is not something Aura switches on. Stops polling once the place
 *  is awake: a machine that is up has no wait to report, and the panel's other
 *  reads take over from there.
 *
 *  `nudge` re-asks now. Pass the same counter a caller bumps after pressing a
 *  wake button, so the first "Starting…" appears immediately rather than up to a
 *  second later. */
export function useWaking(machineId: string | null, nudge = 0): Waking | null {
  const [waking, setWaking] = useState<Waking | null>(null);

  useEffect(() => {
    if (!machineId) {
      setWaking(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const ask = async () => {
      try {
        const answer = await api.placeWaking({ root: null, machineId });
        if (!alive) return;
        setWaking(answer);
        // An awake place is the end of the watch. Not an error and not a state
        // to keep polling — there is nothing left to wait for, and the panel's
        // session read is a better use of the next second.
        if (answer.state === "awake") return;
        timer = setTimeout(
          () => void ask(),
          answer.state === "waking" ? WHILE_WAKING_MS : WHILE_ASLEEP_MS,
        );
      } catch {
        // A local read that failed says nothing about the machine. Leaving the
        // last good answer on screen and trying again is truer than replacing
        // "Starting…" with a fault about a box that is very likely booting.
        if (alive) timer = setTimeout(() => void ask(), WHILE_ASLEEP_MS);
      }
    };

    void ask();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [machineId, nudge]);

  return waking;
}
