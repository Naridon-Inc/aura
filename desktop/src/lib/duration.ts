// One ladder for "how long did that take".
//
// Three copies gave three answers for the same ninety seconds. The manager's
// chat header said "2m" — it divided by sixty and rounded, so a minute and a
// half became two minutes. The status line and the menu-bar HUD both said
// "1m 30s". And only the HUD had a floor, so a turn that finished in under a
// second read "0s" in the chat header: the app saying a turn it had just
// watched run took no time at all.
//
//   0.4 → "<1s"    45 → "45s"    90 → "1m 30s"    7500 → "2h 5m"
//
// A media position or length is not this — that stays "m:ss" and lives with
// its player.

/** Elapsed time for display. Non-finite input reads as "<1s". */
export function formatDuration(seconds: number): string {
  const v = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if (v < 1) return "<1s";
  const total = Math.round(v);
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

/** Elapsed time for a timer that is STILL RUNNING.
 *
 * Under a minute it carries a tenth: "1.4s". A whole-second counter spends
 * most of each second frozen, and a frozen number next to a spinner reads as
 * a system that has stalled — the tenth is the same wait, shown moving. Past
 * a minute the decimal is noise nobody reads, so it hands back to the settled
 * ladder above and the two agree on every value they both render.
 *
 *   0 → "0.0s"    1.44 → "1.4s"    59.9 → "59.9s"    90 → "1m 30s"
 *
 * Use `formatDuration` for a time that has finished — "Thought for 5s" should
 * not claim a precision the reader has no use for. */
export function formatLiveDuration(seconds: number): string {
  const v = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  // toFixed rounds, so guard the boundary: 59.97 must not print "60.0s".
  if (v < 60 && Number(v.toFixed(1)) < 60) return `${v.toFixed(1)}s`;
  return formatDuration(v);
}
