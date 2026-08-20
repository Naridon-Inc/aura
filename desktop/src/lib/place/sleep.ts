// Asleep is not offline, and this is the only file allowed to tell them apart.
//
// Aura stops a machine it made when nobody is using it, so an idle place costs
// nothing. That is the feature. The failure mode is the whole reason this file
// exists: a stopped machine refuses every connection in exactly the way a broken
// one does, so any surface that works out "is it up" by trying to reach it will
// draw the cheapest state Aura offers as the most alarming one — a red row, an
// error line, a box that looks like it died overnight.
//
// It cannot be discovered by asking. It can only be known from the row, which
// carries `asleepSince` because Aura wrote it there at the moment it stopped the
// machine. So: three surfaces read this — the roster, the sidebar rail, and the
// session list inside a place — and none of them keeps its own spelling of it.
// A second `place.asleepSince > 0` somewhere is how one of the three comes to
// say "offline" while the other two say "asleep".
//
// The sentences are here for the same reason. "Asleep — costs nothing" and
// "Couldn't reach it" are opposite messages, and the difference between them is
// whether the member goes back to work or goes looking for a support channel.

import type { Place } from "./contract";

/** Is Aura holding this place stopped?
 *
 *  The one question. Everything else in this file is words about the answer. */
export function isAsleep(place: Place): boolean {
  return place.asleepSince > 0;
}

/** Should a surface try to reach this place at all?
 *
 *  A sleeping box answers nothing, so dialling one produces a timeout and then
 *  an error message about a machine that is working exactly as intended. The
 *  session list, the capability probe and anything else that reaches should ask
 *  this first and draw the sleeping state instead. */
export function isReachable(place: Place): boolean {
  return !isAsleep(place);
}

/** The word for the state, for a badge or a chip.
 *
 *  Empty for an awake place: a row that says "Awake" on every machine is noise,
 *  and the state worth marking is the one that would otherwise be misread. */
export function sleepBadge(place: Place): string {
  return isAsleep(place) ? "Asleep" : "";
}

/** What to say instead of an error, when something couldn't reach this place.
 *
 *  Returns null when the place is awake, which means "your error is a real
 *  error, show it". That shape is deliberate: the caller keeps its existing
 *  failure path and only has to ask whether this particular failure was
 *  expected. */
export function sleepingInsteadOfError(place: Place): string | null {
  if (!isAsleep(place)) return null;
  return `${place.name} is asleep, so nothing is running on it right now. Its disk is exactly as you left it — opening it starts it again.`;
}

/** How long it has been asleep, in words, from a clock the caller supplies.
 *
 *  `nowMs` rather than `Date.now()` so a list that draws a hundred rows uses one
 *  reading of the clock, and so a test can state the answer instead of racing
 *  it. Empty string when the place is awake or the timestamp is unusable — a
 *  row with a broken stamp should show nothing rather than "asleep for 56
 *  years". */
export function asleepFor(place: Place, nowMs: number): string {
  if (!isAsleep(place)) return "";
  const secs = Math.floor(nowMs / 1000) - place.asleepSince;
  if (secs < 0) return "";
  const mins = Math.floor(secs / 60);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The tooltip for a sleeping row: what happened, and what it costs.
 *
 *  Both halves matter. "Asleep" alone reads as a machine that has gone away;
 *  the reassurance that nothing was lost is the part that stops somebody
 *  re-provisioning a box they still have. */
export function sleepTooltip(place: Place, nowMs: number): string {
  if (!isAsleep(place)) return "";
  const since = asleepFor(place, nowMs);
  const when = since && since !== "just now" ? ` for ${since}` : "";
  return `Asleep${when} — Aura stopped it because nobody was using it, so it isn't costing anything. Everything on its disk is still there; opening it starts it again.`;
}
