// A time on the clock — one way of writing one.
//
// There were two, and team chat used both. A message's own timestamp came
// from a hand-rolled `${pad(getHours())}:${pad(getMinutes())}` and read
// "14:05"; the pinned-message list beside it called toLocaleTimeString and
// read "2:05 PM". Same surface, same fact, two clocks.
//
// The hand-rolled one was written out four times under the same name, `hhmm`,
// in four files — and the fourth copy doesn't return a time at all. It
// returns "Jul 31". Someone reading `hhmm(c.timestamp)` in the provenance
// timeline has no way to know that.
//
// This is the locale one, because it is the only one of the two that can be
// right for two different readers: a 24-hour clock is what most of the world
// sets, a 12-hour clock is what the US sets, and the OS already knows which.
// Padding the hours by hand forces one of those answers on everybody.
//
//   "2:05 PM"  or  "14:05", depending on the reader's own clock.
//
// A precise instant in a log — seconds included — is a different thing and
// stays with the log that asks for it, the same way a media position stays
// with its player rather than joining the elapsed-duration ladder.

export type ClockOptions = {
  /** What an absent or unparseable stamp prints. Empty by default. */
  empty?: string;
};

/** From epoch MILLISECONDS. */
export function clockTime(ms: number, opts: ClockOptions = {}): string {
  if (!Number.isFinite(ms)) return opts.empty ?? "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return opts.empty ?? "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** From epoch SECONDS — the shape most of our Rust commands return. */
export function clockTimeFromSecs(
  unixSecs: number,
  opts: ClockOptions = {},
): string {
  if (!Number.isFinite(unixSecs) || unixSecs <= 0) return opts.empty ?? "";
  return clockTime(unixSecs * 1000, opts);
}
