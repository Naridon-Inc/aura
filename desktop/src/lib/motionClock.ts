// Whether this document's animation clock is running, said on <html> as
// `data-motion-clock="live" | "parked"`.
//
// Menus, popovers and hover cards open with the interface library's motion: a
// 150ms fade and settle in, a 100ms fade out. Its drawer slides in over 500ms. Both keyframes start or end at
// `opacity: 0`, so a panel is only ever made visible by the clock advancing.
// WKWebView does not always advance it. When it thinks the window is occluded
// it parks the document timeline — `document.hidden` turns true and
// `document.timeline.currentTime` stops moving — and a panel opened then sits
// on its first frame: open, focused, and invisible. Measured in this app on
// the Tasks Filters popover.
//
// So the motion is conditional on the clock. styles.css drops it, and holds
// the panel at full opacity, under `data-motion-clock="parked"`; with the
// attribute absent or "live" the library's own rules run untouched, including
// its reduced-motion rule.
//
// Two signals park it:
//   - the page going hidden, which is the state that was measured;
//   - a flyout that is open while the timeline did not move across the
//     400ms after the press that opened it. That catches a clock that stalls
//     with the page still reporting itself visible.
// A later press that sees the clock move, or the page becoming visible again,
// makes it live.

export type MotionClock = "live" | "parked";

// What can be stuck on its first frame: a library flyout, or the library
// drawer, which vaul slides in from off its edge.
const OPEN_FLYOUT = '.ui-flyout-motion[data-state="open"], [data-vaul-drawer][data-state="open"]';
const SETTLE_MS = 400;

export interface MotionClockHost {
  doc: Pick<Document, "documentElement" | "visibilityState" | "querySelector" | "addEventListener" | "removeEventListener"> & {
    timeline?: { currentTime: CSSNumberish | null } | null;
  };
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
}

function browserHost(): MotionClockHost {
  return {
    doc: document,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
  };
}

export function watchMotionClock(host: MotionClockHost = browserHost()): () => void {
  const { doc } = host;
  const root = doc.documentElement;
  const say = (clock: MotionClock) => {
    if (root.dataset.motionClock !== clock) root.dataset.motionClock = clock;
  };
  const fromVisibility = () => say(doc.visibilityState === "hidden" ? "parked" : "live");

  let timer: number | null = null;
  const check = () => {
    if (doc.visibilityState === "hidden") return;
    const before = doc.timeline?.currentTime ?? null;
    if (before === null) return;
    if (timer !== null) host.clearTimer(timer);
    timer = host.setTimer(() => {
      timer = null;
      if (!doc.querySelector(OPEN_FLYOUT)) return;
      const after = doc.timeline?.currentTime ?? null;
      say(after === before ? "parked" : "live");
    }, SETTLE_MS);
  };

  fromVisibility();
  doc.addEventListener("visibilitychange", fromVisibility);
  doc.addEventListener("pointerdown", check, true);
  doc.addEventListener("keydown", check, true);
  return () => {
    if (timer !== null) host.clearTimer(timer);
    doc.removeEventListener("visibilitychange", fromVisibility);
    doc.removeEventListener("pointerdown", check, true);
    doc.removeEventListener("keydown", check, true);
  };
}
