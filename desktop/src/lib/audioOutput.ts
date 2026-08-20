// One shared, self-releasing AudioContext for every sound Aura plays out of
// the speakers: the chat chime, the turn-end completion chime, the terminal
// bell, and soundboard clips.
//
// ## Why this module exists
//
// Each of those four used to own a module-level `AudioContext` that was built
// on first play, `resume()`d, and then never suspended and never closed. A
// *running* AudioContext is not free: on macOS it keeps a CoreAudio output
// unit open, which registers Aura as an active audio client for as long as the
// app is up — with no sound playing.
//
// With AirPods that is not cosmetic. macOS's automatic device switching moves
// AirPods to whichever device is using audio, so a Mac that permanently looks
// like it is "playing" pulls the AirPods off the iPhone, and keeps pulling
// them back every time the phone tries to take them again. What the user sees
// is AirPods ping-ponging between iPhone and Mac for as long as Aura is open.
//
// The rule this module enforces: **Aura holds the output device only while a
// sound is actually being rendered, and hands it straight back afterwards.**
//
//   play → acquire (construct-or-resume) → schedule → arm a release
//   release fires once the tail has decayed → suspend → device handed back
//
// Overlapping sounds extend the same hold instead of fighting over it: a
// release is always armed for the *latest* deadline anyone asked for, so a
// short bell scheduled during a long soundboard clip can never cut the clip
// off early.
//
// ## suspend(), not close()
//
// `suspend()` is what releases the hardware route — that is the part that
// matters here. `close()` is final, and re-creating a context per chime is
// both slower and risky (WebKit has historically capped the number of live
// AudioContexts per page). So we suspend when idle and resume on the next
// sound, keeping exactly one context for the lifetime of the window.
//
// Nothing here runs at import time. The first AudioContext is constructed by
// the first `acquireOutputContext()` call, which only ever happens from inside
// a play path.

/** How long the device is held past the end of the last scheduled sound.
 *  Long enough that a burst (a run of terminal bells, two turn-ends landing
 *  together) coalesces into one hold; short enough that the route goes back
 *  to whoever else wants it almost immediately. */
export const OUTPUT_IDLE_GRACE_MS = 400;

/** Schedules one sound onto `ac`, starting no earlier than `startAt`
 *  (a value in the context's own clock). Returns the context time at which
 *  the last node it created goes silent — that is what the release timer is
 *  armed from. */
export type OutputSchedule = (ac: AudioContext, startAt: number) => number;

let ctx: AudioContext | null = null;
let releaseHandle: ReturnType<typeof setTimeout> | null = null;
/** Epoch-ms deadline before which the context must stay running. */
let holdUntil = 0;

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  return ctor ?? null;
}

/** Construct-or-resume the shared output context. Returns null when Web Audio
 *  isn't available at all (non-browser, or a platform without the API).
 *
 *  Callers MUST pair this with `releaseOutputContextAfter` — an acquire with
 *  no matching release is exactly the leak this module was written to kill. */
export function acquireOutputContext(): AudioContext | null {
  try {
    if (!ctx || ctx.state === "closed") {
      const Ctor = audioContextCtor();
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") {
      void Promise.resolve(ctx.resume()).catch(() => {});
    }
    return ctx;
  } catch {
    return null;
  }
}

function armRelease(): void {
  const wait = Math.max(0, holdUntil - Date.now());
  releaseHandle = setTimeout(() => {
    releaseHandle = null;
    // Someone extended the hold while we were waiting — re-arm for the new
    // deadline instead of suspending under a sound that is still playing.
    if (Date.now() < holdUntil) {
      armRelease();
      return;
    }
    releaseOutputContextNow();
  }, wait);
}

/** Keep the output device for at least `ms` more, then suspend if nothing
 *  else has asked for it. Deadlines take the max, never the min, so a short
 *  sound scheduled on top of a long one cannot shorten the long one's hold. */
export function releaseOutputContextAfter(ms: number): void {
  const until = Date.now() + Math.max(0, ms);
  if (until > holdUntil) holdUntil = until;
  // A timer is already running; it re-arms itself against the new deadline.
  if (releaseHandle !== null) return;
  armRelease();
}

/** Hand the device back right now. Used on teardown paths and by tests. */
export function releaseOutputContextNow(): void {
  if (releaseHandle !== null) {
    clearTimeout(releaseHandle);
    releaseHandle = null;
  }
  holdUntil = 0;
  const ac = ctx;
  if (!ac) return;
  if (ac.state === "running") {
    void Promise.resolve(ac.suspend()).catch(() => {});
  }
}

/** Acquire, schedule one sound, and arm its release. Returns false when Web
 *  Audio is unavailable or the schedule threw — in both cases the device is
 *  never left stranded on a sound that did not play. */
export function playOutputSound(schedule: OutputSchedule): boolean {
  const ac = acquireOutputContext();
  if (!ac) return false;
  try {
    const startAt = ac.currentTime;
    const endsAt = schedule(ac, startAt);
    const tailMs =
      typeof endsAt === "number" && Number.isFinite(endsAt)
        ? Math.max(0, (endsAt - ac.currentTime) * 1000)
        : 0;
    releaseOutputContextAfter(tailMs + OUTPUT_IDLE_GRACE_MS);
    return true;
  } catch {
    releaseOutputContextAfter(OUTPUT_IDLE_GRACE_MS);
    return false;
  }
}

/** `"none"` until the first sound builds a context; the live state after.
 *  Exists so a test can assert "nothing was constructed yet" and "the device
 *  went back" without reaching into module internals. */
export function outputContextState(): AudioContextState | "none" {
  return ctx ? ctx.state : "none";
}

/** Test-only: drop the shared context and any armed release so each case
 *  starts from "Aura has never made a sound". */
export function __resetOutputContextForTests(): void {
  if (releaseHandle !== null) {
    clearTimeout(releaseHandle);
    releaseHandle = null;
  }
  holdUntil = 0;
  ctx = null;
}
