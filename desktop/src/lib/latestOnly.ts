// Latest-only, bounded work.
//
// Two failures keep recurring wherever a surface asks the backend a question
// and paints the answer, and Project Health had both. The card awaited the
// engine with nothing to stop it, so a backend that never answered left
// "Checking your project…" on screen for good. And switching project started a
// second check without retiring the first, so the slower of the two won and one
// project's health was shown under another project's name.
//
// Both are the same shape: a promise is not the current question by the time it
// settles, and nobody is counting how long it has been out. So this counts, and
// this bounds. The rule is only ever "answer if you are still the newest", and
// a run that is not gets `stale` rather than a value the caller might paint.

/** What a run settled as. `stale` means a newer run started, or the caller
 *  retired this one, while it was still out — there is nothing to paint. */
export type Settled<T> =
  | { kind: "stale" }
  | { kind: "ok"; value: T }
  | { kind: "failed"; message: string };

export type LatestOnly = {
  /** Run `work`, bounded by `timeoutMs`. Overtime settles as `failed` with
   *  `timeoutMessage` — a sentence for a person, not a stack trace. */
  run<T>(
    work: () => Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<Settled<T>>;
  /** Retire whatever is in flight. Its answer will read as `stale`. Call this
   *  when the surface goes away or moves to a different subject. */
  retire(): void;
};

/** One of these per surface that asks. Nothing is shared between them. */
export function createLatestOnly(): LatestOnly {
  let newest = 0;

  return {
    async run<T>(
      work: () => Promise<T>,
      timeoutMs: number,
      timeoutMessage: string,
    ): Promise<Settled<T>> {
      const mine = ++newest;

      let expire: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<never>((_, reject) => {
        expire = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      });

      try {
        const value = await Promise.race([work(), bounded]);
        return newest === mine ? { kind: "ok", value } : { kind: "stale" };
      } catch (e) {
        // A failure from a run nobody is waiting for is not an error worth
        // showing. Reporting it would replace the live run's screen with the
        // dead one's message.
        if (newest !== mine) return { kind: "stale" };
        return {
          kind: "failed",
          message: e instanceof Error ? e.message : String(e),
        };
      } finally {
        // Always, including on the stale path: an unheld timer keeps the
        // process awake and eventually rejects into nothing.
        clearTimeout(expire);
      }
    },

    retire() {
      newest++;
    },
  };
}
