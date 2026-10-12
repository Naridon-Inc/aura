import { describe, expect, test } from "bun:test";

import { createWheelAccumulator, wheelToLines } from "./terminalWheel";

const CELL = 16;

function wheel(deltaY: number, deltaMode = 0) {
  return { deltaY, deltaMode };
}

describe("wheelToLines", () => {
  // The defect this replaced: `deltaY < 0 ? 3 : -3` called every zero-delta
  // event a scroll *down*, and macOS sends one when a trackpad gesture begins
  // and another when it ends. A short gesture is then net downward — begin,
  // one small movement, end came out as -3, +3, -3 — so a gentle flick up
  // moved the view toward the prompt instead of into history.
  test("does nothing on a zero delta, in either direction", () => {
    const acc = createWheelAccumulator();
    expect(wheelToLines(wheel(0), acc, CELL)).toBe(0);
    expect(wheelToLines(wheel(-0), acc, CELL)).toBe(0);
  });

  test("scrolls back into history when the wheel goes up", () => {
    const acc = createWheelAccumulator();
    expect(wheelToLines(wheel(-CELL * 3), acc, CELL)).toBe(3);
  });

  test("returns toward the prompt when the wheel goes down", () => {
    const acc = createWheelAccumulator();
    expect(wheelToLines(wheel(CELL * 3), acc, CELL)).toBe(-3);
  });

  test("accumulates sub-line trackpad deltas instead of dropping them", () => {
    const acc = createWheelAccumulator();
    expect(wheelToLines(wheel(-5), acc, CELL)).toBe(0);
    expect(wheelToLines(wheel(-5), acc, CELL)).toBe(0);
    expect(wheelToLines(wheel(-5), acc, CELL)).toBe(0);
    expect(wheelToLines(wheel(-5), acc, CELL)).toBe(1);
    // The leftover carries rather than being lost.
    expect(wheelToLines(wheel(-12), acc, CELL)).toBe(1);
  });

  test("respects how far the gesture actually moved", () => {
    const acc = createWheelAccumulator();
    expect(wheelToLines(wheel(-160), acc, CELL)).toBe(10);
  });

  test("drops the pending remainder when the gesture reverses", () => {
    const acc = createWheelAccumulator();
    expect(wheelToLines(wheel(-12), acc, CELL)).toBe(0);
    expect(wheelToLines(wheel(CELL), acc, CELL)).toBe(-1);
  });

  test("takes line-mode deltas as whole lines", () => {
    const acc = createWheelAccumulator();
    expect(wheelToLines(wheel(-3, 1), acc, CELL)).toBe(3);
  });

  test("takes page-mode deltas as pages", () => {
    const acc = createWheelAccumulator();
    expect(wheelToLines(wheel(-1, 2), acc, CELL, 20)).toBe(20);
  });

  // A terminal that has not measured itself yet must not divide by zero and
  // send NaN over IPC.
  test("survives a missing cell height", () => {
    const acc = createWheelAccumulator();
    expect(wheelToLines(wheel(-4), acc, 0)).toBe(4);
    expect(wheelToLines(wheel(-4), createWheelAccumulator(), Number.NaN)).toBe(4);
  });

  test("ignores a non-finite delta", () => {
    const acc = createWheelAccumulator();
    expect(wheelToLines(wheel(Number.NaN), acc, CELL)).toBe(0);
    expect(wheelToLines(wheel(Number.POSITIVE_INFINITY), acc, CELL)).toBe(0);
  });

  // A whole gesture: begin (zero), movement, momentum, end (zero). The net has
  // to be the movement, not the movement minus two phantom notches.
  test("nets out a whole trackpad gesture as upward", () => {
    const acc = createWheelAccumulator();
    const gesture = [0, -4, -12, -20, -9, -3, 0];
    const total = gesture.reduce(
      (sum, deltaY) => sum + wheelToLines(wheel(deltaY), acc, CELL),
      0,
    );
    expect(total).toBe(3);
  });
});
