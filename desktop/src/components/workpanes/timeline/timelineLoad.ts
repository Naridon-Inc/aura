// What to say while the project timeline is still reading, and when to stop
// calling it "reading".
//
// AURA-267: Trace → Project timeline sat on "Reading the project's history…"
// past 22 seconds, and a single Try again brought it back in about 12. Two
// separate things were wrong, and this file is the second one.
//
// The read really was slow — the backend was line-diffing up to 2000 commits
// one subprocess at a time, fixed in `cmd_aura.rs`. But the pane also had no
// end to its patience: after six seconds it said "Taking longer than usual"
// and then said that forever, so a read that would never return looked exactly
// like a read that was about to. And the escape hatch was not one: "Try again"
// called into a cache that hands a second caller the read already running, so
// the button joined the stuck read instead of replacing it. The pane appeared
// to recover on retry only because the original read finally landed.
//
// So: a bounded wait with a concrete reason at the end of it, and a button
// that genuinely starts over (`restartIntentRead`).

/** Long enough that a normal read never shows a message; short enough that a
 *  reader is not left wondering whether anything is happening. */
export const SLOW_AFTER_MS = 6_000;

/** Past this, a first read is no longer merely slow. The measured worst case
 *  on a 2000-commit repo was ~22s before the backend fix and well under 3s
 *  after it, so anything still running here is stuck, not busy. */
export const STALLED_AFTER_MS = 25_000;

export type LoadStage = "reading" | "slow" | "stalled";

export function stageAt(elapsedMs: number): LoadStage {
  if (elapsedMs >= STALLED_AFTER_MS) return "stalled";
  if (elapsedMs >= SLOW_AFTER_MS) return "slow";
  return "reading";
}

export type LoadNote = {
  /** The sentence under the loader, or null while it is too early to say
   *  anything worth reading. */
  line: string | null;
  /** Label for the escape hatch, or null when pressing it cannot help. */
  action: string | null;
};

export function loadNote(stage: LoadStage, restarted: boolean): LoadNote {
  if (stage === "reading") return { line: null, action: null };
  if (stage === "slow") {
    return {
      // True, and it says what the wait buys — the counting is cached, so the
      // next open really is immediate.
      line: "Still reading. The first look at a long history counts every change; after this one it opens straight away.",
      action: "Start over",
    };
  }
  return {
    line: restarted
      ? "Starting over didn’t help either. Something is holding the read up rather than taking its time — closing the project and opening it again is the next thing to try."
      : "This is longer than reading a project’s history should ever take. Starting over drops the stuck read and begins a fresh one.",
    action: "Start over",
  };
}
