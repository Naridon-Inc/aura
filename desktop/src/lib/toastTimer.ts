// The toast stack's clock, as plain functions (`components/Toaster.tsx` and
// `components/LiveToast.tsx` drive them).
//
// A timed toast shows its countdown as a ring filling round its close button,
// and closes when the ring is full. The two have to agree: the ring stops
// whenever the timer does, both start over together, and once a notice has
// closed it stays closed.

import type { ToastTone } from "./toast";

/** A toast's countdown: the toast it belongs to (its duration and when it was
 *  first shown) and how much of it is left. */
export type ToastClock = {
  duration: number | null;
  since: number;
  remaining: number;
};

export function startClock(durationMs: number | null, since: number): ToastClock {
  return { duration: durationMs, since, remaining: durationMs ?? 0 };
}

/** The clock for the toast as it is now. The same toast replaced in place
 *  keeps its clock. A new duration (back from a spell with none too), or the
 *  same id shown again as a new toast, starts it full — the ring is drawn from
 *  empty again in both cases, so the timer must be too. */
export function retime(clock: ToastClock, durationMs: number | null, since: number): ToastClock {
  return clock.duration === durationMs && clock.since === since
    ? clock
    : startClock(durationMs, since);
}

/** What is left after counting for `elapsed` ms. */
export function spend(clock: ToastClock, elapsed: number): number {
  return Math.max(0, clock.remaining - Math.max(0, elapsed));
}

/** Where the pointer and the focus are, as far as the stack knows. */
export type StackPresence = { hovered: boolean; focusInside: boolean };

/** The presence the stack's events reported, checked against the page. A
 *  toast removed under the pointer, or with focus in it, sends no leave and
 *  no blur, so the events alone can say "on the stack" for good — and every
 *  timer waits for good. The page is the truth for leaving; arriving always
 *  comes with an event. */
export function settlePresence(reported: StackPresence, page: StackPresence): StackPresence {
  const hovered = reported.hovered && page.hovered;
  const focusInside = reported.focusInside && page.focusInside;
  return hovered === reported.hovered && focusInside === reported.focusInside
    ? reported
    : { hovered, focusInside };
}

/** Whether every timer in the stack stops: the pointer on it, focus in it, or
 *  the window in the background. The rings read this same answer. */
export function stackPaused(p: StackPresence & { windowFocused: boolean }): boolean {
  return p.hovered || p.focusInside || !p.windowFocused;
}

/** Which notice a component-owned toast is showing. Its words below the title
 *  can move (a download's percent) and it is still the same notice; a new
 *  id, tone or title is a different one. */
export function noticeKey(input: { id: string; tone?: ToastTone; title?: string }): string {
  return [input.id, input.tone ?? "", input.title ?? ""].join("\u0000");
}

/** Whether to put a component-owned toast up: not when this same notice was
 *  just closed by its timer or by the person. */
export function shouldResend(closedKey: string | null, key: string): boolean {
  return closedKey !== key;
}
