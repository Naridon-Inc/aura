import { describe, expect, test } from "bun:test";

import { watchMotionClock, type MotionClockHost } from "./motionClock";

/** A document with a clock we move by hand, and timers we fire by hand. */
function fakeHost(opts: { hidden?: boolean; flyoutOpen?: boolean } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const state = {
    hidden: opts.hidden ?? false,
    flyoutOpen: opts.flyoutOpen ?? true,
    now: 1000 as number | null,
  };
  const root = { dataset: {} as Record<string, string> };
  const doc = {
    documentElement: root,
    get visibilityState() {
      return state.hidden ? "hidden" : "visible";
    },
    get timeline() {
      return { currentTime: state.now };
    },
    querySelector: (sel: string) => (state.flyoutOpen && sel.includes("ui-flyout-motion") ? {} : null),
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
  };
  const host = {
    doc,
    setTimer: (fn: () => void, _ms: number) => {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id: number) => void timers.delete(id),
  } as unknown as MotionClockHost;
  return {
    host,
    state,
    clock: () => root.dataset.motionClock,
    fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()),
    flush: () => {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((fn) => fn());
    },
    listening: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe("watchMotionClock", () => {
  test("a visible page starts live", () => {
    const h = fakeHost();
    watchMotionClock(h.host);
    expect(h.clock()).toBe("live");
  });

  test("a hidden page is parked, and live again when it shows", () => {
    const h = fakeHost({ hidden: true });
    watchMotionClock(h.host);
    expect(h.clock()).toBe("parked");
    h.state.hidden = false;
    h.fire("visibilitychange");
    expect(h.clock()).toBe("live");
  });

  test("a flyout whose clock did not move after the press parks it", () => {
    const h = fakeHost();
    watchMotionClock(h.host);
    h.fire("pointerdown");
    h.flush();
    expect(h.clock()).toBe("parked");
  });

  test("the next press that sees the clock move makes it live again", () => {
    const h = fakeHost();
    watchMotionClock(h.host);
    h.fire("pointerdown");
    h.flush();
    h.fire("keydown");
    h.state.now = 1400;
    h.flush();
    expect(h.clock()).toBe("live");
  });

  test("a press that opened nothing says nothing about the clock", () => {
    const h = fakeHost({ flyoutOpen: false });
    watchMotionClock(h.host);
    h.fire("pointerdown");
    h.flush();
    expect(h.clock()).toBe("live");
  });

  test("an engine without a readable timeline is left as the page says", () => {
    const h = fakeHost();
    h.state.now = null;
    watchMotionClock(h.host);
    h.fire("pointerdown");
    h.flush();
    expect(h.clock()).toBe("live");
  });

  test("stopping removes every listener", () => {
    const h = fakeHost();
    const stop = watchMotionClock(h.host);
    expect(h.listening()).toBe(3);
    stop();
    expect(h.listening()).toBe(0);
  });
});
