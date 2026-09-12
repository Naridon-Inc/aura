// ⌘⌥L jumps to the next tab that needs a person, wrapping, and moves on
// from the one you're already looking at.

import { describe, expect, test } from "bun:test";

import { nextNeedingAttention } from "../src/lib/attentionNav";

describe("nextNeedingAttention", () => {
  const needs = (set: number[]) => (i: number) => set.includes(i);

  test("finds the next one after the current index", () => {
    expect(nextNeedingAttention(5, 1, needs([0, 3]))).toBe(3);
  });

  test("wraps around to one behind the current index", () => {
    expect(nextNeedingAttention(5, 3, needs([0, 3]))).toBe(0);
  });

  test("checks the current tab last, so a second press moves on", () => {
    // Only the current tab needs you: you get it back, but only after the
    // walk found nothing else.
    expect(nextNeedingAttention(4, 2, needs([2]))).toBe(2);
    // Another one exists: that wins over staying put.
    expect(nextNeedingAttention(4, 2, needs([2, 0]))).toBe(0);
  });

  test("-1 when nothing needs attention", () => {
    expect(nextNeedingAttention(4, 1, () => false)).toBe(-1);
    expect(nextNeedingAttention(0, -1, () => true)).toBe(-1);
  });

  test("an out-of-range current index starts from the top", () => {
    expect(nextNeedingAttention(3, -1, needs([1]))).toBe(1);
    expect(nextNeedingAttention(3, 99, needs([0]))).toBe(0);
  });
});
