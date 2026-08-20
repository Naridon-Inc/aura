// sharedRead — "several surfaces want the same answer at the same time; ask
// once."
//
// The shape recurs all over this app: a handful of components each keep their
// own timer polling the same backend command about the same repo, none of them
// aware the others exist, and none of them unmounting when you look elsewhere
// (panes are hidden with a CSS class, not unmounted). Each poller is then
// multiplied by whatever the command costs — a git process spawn, an
// 800 KB JSONL file read and parsed line by line.
//
// This is the one implementation of the rule. Two things in it are load-bearing
// and easy to get subtly wrong on a re-write:
//
//   A failed read is not an answer. Every caller of these commands has a
//   hand-written catch whose job is to stop a read failure being rendered as a
//   real value — an empty impacts list reads as "nothing is reaching your
//   work", a zeroed ahead/behind reads as "published nowhere". So a failure
//   rejects, caches nothing, and leaves no rejected promise in `inflight` for
//   the next caller to join.
//
//   A read that was already running when the world changed describes the old
//   world. It is allowed to resolve — someone is waiting on it — but it must
//   not be stored, or the next surface to ask gets pre-change data stamped with
//   a post-change timestamp. That is what `epoch` is for.

/** A shared read of one command, keyed by repo (or whatever the caller keys
 *  on). Create with {@link sharedReader}; read with {@link readShared}. */
export type SharedReader<T> = {
  cache: Map<string, { value: T; readAt: number }>;
  inflight: Map<string, Promise<T>>;
  load: (key: string) => Promise<T>;
  /** How long a landed read stays good enough to hand to the next caller.
   *  Size it *under* the callers' own poll interval: the pollers overlapping
   *  inside one cycle then collapse to a single read, while the next cycle
   *  still does a real one. Above the poll interval and surfaces start showing
   *  answers older than they believe they are showing. */
  freshMs: number;
  epoch: number;
};

export function sharedReader<T>(
  load: (key: string) => Promise<T>,
  freshMs: number,
): SharedReader<T> {
  return { cache: new Map(), inflight: new Map(), load, freshMs, epoch: 0 };
}

/** The shared answer for `key`. Serves a read from the freshness window
 *  without touching the backend; otherwise reads, and concurrent callers join
 *  the read already running. `force` skips the window — for a surface that has
 *  just changed something and has to see it — but still shares in flight. */
export function readShared<T>(
  r: SharedReader<T>,
  key: string,
  force = false,
): Promise<T> {
  if (!force) {
    const entry = r.cache.get(key);
    if (entry !== undefined && Date.now() - entry.readAt < r.freshMs) {
      return Promise.resolve(entry.value);
    }
  }
  const pending = r.inflight.get(key);
  if (pending) return pending;

  const startedIn = r.epoch;
  const promise = r
    .load(key)
    .then((value) => {
      if (r.epoch === startedIn) r.cache.set(key, { value, readAt: Date.now() });
      r.inflight.delete(key);
      return value;
    })
    .catch((e) => {
      // Nothing cached and nothing invented — the caller's own catch decides
      // what a failed read means for its surface.
      r.inflight.delete(key);
      throw e;
    });
  r.inflight.set(key, promise);
  return promise;
}

/** Synchronous peek at what was last read, however old. For a surface that
 *  would otherwise paint a spinner over something it already knows. */
export function peekShared<T>(r: SharedReader<T>, key: string): T | undefined {
  return r.cache.get(key)?.value;
}

/** Forget what is known, so the next read is real. Bumps the epoch too, so a
 *  read that is still out when this lands is not written back afterwards. */
export function dropShared<T>(r: SharedReader<T>, key?: string): void {
  r.epoch += 1;
  if (key === undefined) r.cache.clear();
  else r.cache.delete(key);
}
