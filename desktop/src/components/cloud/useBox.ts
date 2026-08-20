// What a box is holding right now: its projects, and the sessions working in
// them.
//
// Both are read off the machine every time, never cached across a mount. The
// machine is the only thing that knows — a session can be started by yesterday's
// laptop, by the CLI over ssh, or by a teammate on the same box, and none of
// those tell this app anything. A list we kept believing in is the worse
// failure: you click a row, a terminal opens on nothing, and the app looks like
// it lied.
//
// It is also why the reads are polled rather than fetched once. "Who else is in
// here" and "did the clone finish" are questions whose answer changes while you
// watch, and the honest way to show that is to keep asking.

import { useCallback, useEffect, useRef, useState } from "react";

import { api, type BoxProject, type BoxSession, type PlaceProjects } from "../../lib/api";
import { UNREAD } from "../../lib/place";

/** How often to re-ask a healthy box. Each read is two commands over the one
 *  multiplexed ssh connection, so this is cheap — cheap enough that the list
 *  can be trusted to be roughly now rather than roughly whenever you opened
 *  the workspace. */
const EVERY_MS = 12_000;

/** Where the interval walks to when the box stops answering. A stopped VM eats
 *  a full connect timeout per attempt, and hammering it every twelve seconds
 *  buys nothing but a queue of doomed dials. */
const MAX_EVERY_MS = 60_000;

export type BoxState = {
  /** Null until the first read lands, or after a read fails — never a stale
   *  list and never an invented empty one. */
  sessions: BoxSession[] | null;
  /** The projects on offer here: what the box holds, narrowed to the org it was
   *  opened as. Null on the same terms as `sessions`. */
  projects: BoxProject[] | null;
  /** The same answer whole — what was held back, and why. Kept beside
   *  `projects` rather than folded into it because a shorter list with nothing
   *  said is indistinguishable from a box that lost half its checkouts, and the
   *  person looking at it is the one who knows the repo is there.
   *
   *  `UNREAD` before the first read lands, so a caller never has to null-check
   *  a shape whose empty case means the same thing. */
  offered: PlaceProjects;
  /** Why the last read failed, in the machine's own words. Callers must not
   *  render this as "nothing running": an unreachable box and an idle box look
   *  nothing alike to the person waiting on work. */
  error: string | null;
  /** A read is in flight. Distinct from `sessions === null` — a refresh over an
   *  already-good list should not blank the screen. */
  reading: boolean;
  /** Ask now. Called on opening the panel and after anything that changes what
   *  is running, so the list never lags the action that changed it. */
  refresh: () => void;
};

/** What a box is holding, polled — unless Aura has stopped it.
 *
 *  `asleep` is not an optimisation. A machine Aura put to sleep will refuse
 *  every connection until something starts it, so polling one produces a
 *  connect timeout on a loop and, worse, an `error` string that reads exactly
 *  like a broken box. Skipping the read is how the panel gets to say "asleep"
 *  instead of the machine's own words for a door that isn't open. Callers get
 *  the honest state for a box nobody has asked: no sessions, no error. */
export function useBox(machineId: string | null, asleep = false): BoxState {
  const [sessions, setSessions] = useState<BoxSession[] | null>(null);
  const [offered, setOffered] = useState<PlaceProjects | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  // A counter rather than a boolean: two refreshes in a row must both be heard,
  // and a boolean that is already true swallows the second.
  const [asked, setAsked] = useState(0);

  const refresh = useCallback(() => setAsked((n) => n + 1), []);

  // Held in a ref so a failing box slows the *next* wait without restarting the
  // effect — which would fire another read immediately and undo the backoff.
  const waitRef = useRef(EVERY_MS);

  useEffect(() => {
    if (!machineId || asleep) {
      setSessions(null);
      setOffered(null);
      // No error, deliberately. There is nothing wrong here — a stopped box has
      // nothing running on it, and the one thing it must not do is report the
      // reason it wouldn't answer as a fault.
      setError(null);
      setReading(false);
      // And the backoff resets, so the first read after it wakes is prompt
      // rather than a minute behind whatever started it.
      waitRef.current = EVERY_MS;
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const read = async () => {
      setReading(true);
      try {
        // Together, because a session naming a project the list doesn't have is
        // the one inconsistency a person would notice — and the two reads share
        // a connection, so asking in parallel costs one round trip, not two.
        const [ss, ps] = await Promise.all([
          api.boxSessions(machineId),
          api.boxProjects(machineId),
        ]);
        if (!alive) return;
        setSessions(ss);
        setOffered(ps);
        setError(null);
        waitRef.current = EVERY_MS;
      } catch (e) {
        if (!alive) return;
        setSessions(null);
        setOffered(null);
        setError(e instanceof Error ? e.message : String(e));
        waitRef.current = Math.min(waitRef.current * 2, MAX_EVERY_MS);
      } finally {
        if (alive) {
          setReading(false);
          timer = setTimeout(() => void read(), waitRef.current);
        }
      }
    };

    void read();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [machineId, asked, asleep]);

  return {
    sessions,
    // Null carries "nobody has asked yet / the read failed" — the same promise
    // `sessions` makes, and the reason no caller has to invent an empty list.
    projects: offered ? offered.projects : null,
    offered: offered ?? UNREAD,
    error,
    reading,
    refresh,
  };
}

/** How long ago, in the words someone would actually say. Sessions carry unix
 *  seconds of the last thing tmux saw, and the gap between "3m" and "since
 *  Tuesday" is the difference between an agent thinking and an agent that
 *  finished without anyone noticing. */
export function sinceWords(unixSeconds: number, nowMs: number): string {
  if (!unixSeconds) return "";
  const s = Math.max(0, Math.round(nowMs / 1000 - unixSeconds));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** The last segment of a path on the box. Paths there are POSIX whatever this
 *  laptop is, so this is deliberately not the platform's own path module. */
export function basename(path: string): string {
  const p = path.replace(/\/+$/, "");
  return p.slice(p.lastIndexOf("/") + 1);
}

/** What to call a session on screen.
 *
 *  The box records a title when it was given one and falls back to the
 *  directory's name, so this is nearly always a real answer. The session name
 *  is the last resort and is never pretty — `aura-agent-naridon-3f1c` — which
 *  is precisely why it comes last. */
export function sessionLabel(s: BoxSession): string {
  const t = s.title.trim();
  if (t) return t;
  return basename(s.project) || s.name;
}

/** Sessions under the project they work in, projects alphabetical and sessions
 *  newest-active first inside each.
 *
 *  The grouping is the whole reason a box reads as a machine rather than a
 *  list: one runner holding three repos is three headings, not nine rows of the
 *  same shape. Sessions started before any of this existed carry no project and
 *  are still listed — under a heading that says so, rather than hidden or
 *  filed under someone else's repo. */
export function groupByProject(sessions: BoxSession[]): [string, BoxSession[]][] {
  const by = new Map<string, BoxSession[]>();
  for (const s of sessions) {
    const key = basename(s.project) || "elsewhere on the box";
    const list = by.get(key);
    if (list) list.push(s);
    else by.set(key, [s]);
  }
  return [...by.entries()]
    .map(
      ([k, v]) =>
        [k, [...v].sort((a, b) => b.activity_at - a.activity_at)] as [
          string,
          BoxSession[],
        ],
    )
    .sort((a, b) => a[0].localeCompare(b[0]));
}
