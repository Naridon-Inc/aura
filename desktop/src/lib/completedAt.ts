// "finished 3:42 PM" — the wall-clock moment a turn settled.
//
// The duration chip says how long a reply took; it never said WHEN. Coming
// back to a tab after lunch, "2m 10s" is not the answer to "did this finish
// before or after I left?". The time is in the user's locale, and the day is
// added only when it isn't today, because "finished Sep 6, 3:42 PM" on a
// reply from an hour ago is noise.

/** `atSec` is epoch seconds (what a ChatTurn carries). `nowMs` is injected so
 *  the "today" decision is testable; `locale` is left to the host unless a
 *  test pins it. */
export function formatCompletedAt(
  atSec: number,
  nowMs: number = Date.now(),
  locale?: string,
): string {
  const at = new Date(atSec * 1000);
  const now = new Date(nowMs);
  const time = at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return `finished ${time}`;
  const day = at.toLocaleDateString(locale, { month: "short", day: "numeric" });
  return `finished ${day}, ${time}`;
}
