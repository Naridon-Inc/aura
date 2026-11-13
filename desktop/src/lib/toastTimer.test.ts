// What these pin: a toast's timer starts over exactly when its ring does, the
// stack stops thinking it is pointed at or focused once the page says it
// isn't (a toast removed with focus in it sends no blur), and a notice closed
// by its timer is not put back by the component that owns it.

import { describe, expect, it } from "bun:test";

import {
  noticeKey,
  retime,
  settlePresence,
  shouldResend,
  spend,
  stackPaused,
  startClock,
} from "./toastTimer";

describe("retime", () => {
  it("keeps the clock of a toast replaced in place", () => {
    const clock = { ...startClock(5000, 100), remaining: 1200 };
    expect(retime(clock, 5000, 100)).toBe(clock);
  });

  it("starts full for a new duration", () => {
    const clock = { ...startClock(5000, 100), remaining: 1200 };
    expect(retime(clock, 6000, 100)).toEqual({ duration: 6000, since: 100, remaining: 6000 });
  });

  it("starts full when a duration comes back after a spell with none", () => {
    // 5s → stays (a loading face) → 5s again: the ring is redrawn from empty,
    // so the timer can't carry on from where it was and close early.
    let clock = { ...startClock(5000, 100), remaining: 1200 };
    clock = retime(clock, null, 100);
    expect(clock.remaining).toBe(0);
    clock = retime(clock, 5000, 100);
    expect(clock.remaining).toBe(5000);
  });

  it("starts full when the same id is shown again as a new toast", () => {
    const spent = { ...startClock(5000, 100), remaining: 0 };
    expect(retime(spent, 5000, 900).remaining).toBe(5000);
  });
});

describe("spend", () => {
  it("counts down and stops at zero", () => {
    const clock = startClock(5000, 0);
    expect(spend(clock, 1500)).toBe(3500);
    expect(spend(clock, 9000)).toBe(0);
    expect(spend(clock, -20)).toBe(5000);
  });
});

describe("settlePresence", () => {
  it("drops focus the page no longer has", () => {
    // The close button was clicked (focus went to the toast), then that toast
    // was removed: no blur, but the page's focus is elsewhere now.
    const next = settlePresence(
      { hovered: false, focusInside: true },
      { hovered: false, focusInside: false },
    );
    expect(next).toEqual({ hovered: false, focusInside: false });
    expect(stackPaused({ ...next, windowFocused: true })).toBe(false);
  });

  it("drops a pointer the page says has left", () => {
    expect(
      settlePresence({ hovered: true, focusInside: false }, { hovered: false, focusInside: false }),
    ).toEqual({ hovered: false, focusInside: false });
  });

  it("never invents an arrival the events did not report", () => {
    const reported = { hovered: false, focusInside: false };
    expect(settlePresence(reported, { hovered: true, focusInside: true })).toBe(reported);
  });

  it("keeps what is still true", () => {
    const reported = { hovered: true, focusInside: true };
    expect(settlePresence(reported, { hovered: true, focusInside: true })).toBe(reported);
  });
});

describe("stackPaused", () => {
  it("stops for the pointer, the focus, or a window in the background", () => {
    const idle = { hovered: false, focusInside: false, windowFocused: true };
    expect(stackPaused(idle)).toBe(false);
    expect(stackPaused({ ...idle, hovered: true })).toBe(true);
    expect(stackPaused({ ...idle, focusInside: true })).toBe(true);
    expect(stackPaused({ ...idle, windowFocused: false })).toBe(true);
  });
});

describe("noticeKey / shouldResend", () => {
  const done = { id: "cli-update", tone: "success" as const, title: "Updated to 0.20.8" };

  it("keeps a notice closed by its timer closed", () => {
    expect(shouldResend(noticeKey(done), noticeKey(done))).toBe(false);
  });

  it("shows a different notice on the same id", () => {
    const closed = noticeKey(done);
    expect(shouldResend(closed, noticeKey({ ...done, title: "Updated to 0.20.9" }))).toBe(true);
    expect(shouldResend(closed, noticeKey({ ...done, tone: "warning" }))).toBe(true);
    expect(shouldResend(closed, noticeKey({ ...done, id: "other" }))).toBe(true);
  });

  it("shows anything when nothing was closed", () => {
    expect(shouldResend(null, noticeKey(done))).toBe(true);
  });
});
