// "finished 3:42 PM", with the day added only when it isn't today.

import { describe, expect, test } from "bun:test";

import { formatCompletedAt } from "../src/lib/completedAt";

// Built in local time so the expectation doesn't depend on the runner's zone.
const at = new Date(2026, 8, 7, 15, 42);
const atSec = at.getTime() / 1000;

describe("formatCompletedAt", () => {
  test("today: just the time", () => {
    const now = new Date(2026, 8, 7, 18, 0).getTime();
    expect(formatCompletedAt(atSec, now, "en-US")).toBe("finished 3:42 PM");
  });

  test("another day: short date plus time", () => {
    const now = new Date(2026, 8, 9, 9, 0).getTime();
    expect(formatCompletedAt(atSec, now, "en-US")).toBe("finished Sep 7, 3:42 PM");
  });

  test("follows the locale", () => {
    const now = new Date(2026, 8, 7, 18, 0).getTime();
    expect(formatCompletedAt(atSec, now, "en-GB")).toBe("finished 15:42");
  });
});
