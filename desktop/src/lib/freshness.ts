// freshness.ts — AUDIT-UI-02: shared freshness vocabulary.
//
// Surfaces that keep serving cached figures after a failed refresh used
// to do so silently — a number that looked live could be an hour old.
// The convention (generalized from ClaudeUsageRing, the one surface that
// already did this right): keep the last good data on a failure, but say
// so, with an age stamp, through these helpers.

/** Compact human age for a freshness stamp: "just now", "3m ago",
 *  "2h ago", "5d ago". */
export function formatAgo(msEpoch: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - msEpoch) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** One shared line for "this data is not live". Returns null while the
 *  surface is healthy so callers can `&&` it straight into JSX.
 *  `lastUpdated` is the ms-epoch of the last successful load, or null
 *  when nothing ever loaded. */
export function staleNote(
  lastUpdated: number | null,
  failing: boolean,
): string | null {
  if (!failing) return null;
  if (lastUpdated === null) return "Offline — couldn't load";
  return `Offline — showing data from ${formatAgo(lastUpdated)}`;
}
