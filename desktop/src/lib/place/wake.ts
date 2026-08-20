// A minute of nothing, said out loud.
//
// Reaching a sleeping place starts it, and the caller's action then goes ahead —
// that half is the engine's, and by the time a member notices anything it has
// already happened. What the member notices is the wait: the better part of a
// minute in which a click did nothing visible. Silence over that stretch is
// indistinguishable from a hang, and the two things somebody does about a hang —
// click again, or go and find support — are both wrong here and both expensive.
//
// So the words. Three claims, and the file exists to keep all three true at
// once:
//
//   1. Something is happening. Named, not a bare spinner.
//   2. It usually takes about this long. The number comes from the engine
//      (`Waking.usually`), so the expectation set here and the wait the sweep
//      actually performs cannot drift apart.
//   3. When it takes longer than usual, say THAT — still not an error. A cloud
//      having a slow afternoon is not a fault, and a surface that turns amber at
//      sixty-one seconds has taught the member to distrust a working feature.
//
// The prohibition is the same one `sleep.ts` keeps, carried through the minute
// that follows it: a machine that is starting is never described as
// unreachable, offline, failed or down. It is doing exactly what it was asked
// to. The test file holds that as an assertion over every sentence here, because
// the failure is one word in one branch and it reads as broken hardware.

import type { Waking } from "../api";

/** Is a wake in the air for this place right now? */
export function isWaking(waking: Waking): boolean {
  return waking.state === "waking";
}

/** Would using this place start it, rather than failing?
 *
 *  The question that makes sleeping cheap instead of annoying. A member told
 *  only "asleep" goes looking for the button; told this, they carry on and the
 *  machine is up by the time it matters. False for this laptop, and for a box
 *  somebody brought — Aura holds no account that could switch on hardware it
 *  did not make. */
export function startsWhenUsed(waking: Waking): boolean {
  return waking.wakes_on_demand;
}

/** How long the wake has been running, in seconds, from a clock the caller
 *  supplies.
 *
 *  `nowMs` rather than `Date.now()` so a test can state the answer instead of
 *  racing it, and so one draw of a panel uses one reading. Zero when nothing is
 *  starting, and zero rather than negative when the clocks disagree — a wake
 *  that reads as having begun in the future is a clock problem, and rounding it
 *  to "just started" is closer to the truth than showing it. */
export function wakingFor(waking: Waking, nowMs: number): number {
  if (!isWaking(waking) || waking.since <= 0) return 0;
  return Math.max(0, Math.floor(nowMs / 1000) - waking.since);
}

/** How far through the usual wait we are, 0 to 1.
 *
 *  Capped at 1 rather than allowed past it, because a bar that keeps filling
 *  past its own end is a bar that lied. What happens after 1 is
 *  {@link runningLate}'s business: the bar sits full and the words change, which
 *  is honest in a way a bar creeping to 130% is not. */
export function wakeProgress(waking: Waking, nowMs: number): number {
  const usually = waking.usually > 0 ? waking.usually : 60;
  return Math.min(1, wakingFor(waking, nowMs) / usually);
}

/** Has this wake gone past how long one usually takes?
 *
 *  Not a failure and not a timeout — how long Aura actually waits is measured in
 *  minutes, and this is a couple of tens of seconds. It exists so the words can
 *  stop claiming "about a minute" once a minute has gone by, which is the point
 *  at which a member starts wondering whether anybody is watching. */
export function runningLate(waking: Waking, nowMs: number): boolean {
  const usually = waking.usually > 0 ? waking.usually : 60;
  return isWaking(waking) && wakingFor(waking, nowMs) > usually;
}

/** The usual wait in words — "about a minute", "about 2 minutes".
 *
 *  Approximate on purpose. A machine that comes back in 47 seconds against a
 *  promise of "about a minute" kept its promise; against "60s" it was late. */
export function usuallyTakes(waking: Waking): string {
  const secs = waking.usually > 0 ? waking.usually : 60;
  if (secs < 90) return "about a minute";
  const mins = Math.round(secs / 60);
  return `about ${mins} minutes`;
}

/** The elapsed count, in words, for the line under a spinner.
 *
 *  Seconds while there are few enough of them to be worth counting, then
 *  minutes. Empty when nothing is starting, which is a caller's cue to draw
 *  nothing rather than "0s". */
export function waitedFor(waking: Waking, nowMs: number): string {
  const secs = wakingFor(waking, nowMs);
  if (!isWaking(waking)) return "";
  if (secs < 1) return "just now";
  if (secs < 90) return `${secs}s`;
  return `${Math.round(secs / 60)}m`;
}

/** The one line to show while a place is starting.
 *
 *  Carries the reassurance as well as the state, because "starting" on its own
 *  leaves open the question a member actually has, which is whether the work
 *  they left on the box is still there. It is. Saying so here is what stops
 *  somebody provisioning a second machine while the first one boots. */
export function wakeHeadline(waking: Waking, nowMs: number): string {
  if (!isWaking(waking)) return "";
  const late = runningLate(waking, nowMs);
  const waited = waitedFor(waking, nowMs);
  if (late) {
    return `Still starting ${waking.place} — ${waited} so far, a bit longer than usual. Nothing is wrong; it will pick up where you left off.`;
  }
  return `Starting ${waking.place} — usually ${usuallyTakes(waking)}. Everything on its disk is still there.`;
}

/** What to say about a place that is asleep and would start if used.
 *
 *  The version of {@link sleepingInsteadOfError} for a surface that knows the
 *  wake is automatic: not "press this to start it" but "go ahead, it starts
 *  itself". Returns empty for a place that would not — a box you brought says
 *  nothing here, and {@link Waking.note} carries the engine's sentence about
 *  who has to switch that one on. */
export function startsItselfLine(waking: Waking): string {
  if (waking.state !== "asleep" || !startsWhenUsed(waking)) return "";
  return `${waking.place} is asleep, so it isn't costing anything. Using it starts it — that takes ${usuallyTakes(waking)}, and everything on its disk is still there.`;
}

/** The word for a badge, across all three states.
 *
 *  Empty for an awake place, because a chip that says "Awake" on every row is
 *  noise. "Starting…" rather than "Waking" — one is what the machine is doing
 *  and the other is a metaphor the member has to decode. */
export function wakeBadge(waking: Waking): string {
  if (isWaking(waking)) return "Starting…";
  if (waking.state === "asleep") return "Asleep";
  return "";
}
