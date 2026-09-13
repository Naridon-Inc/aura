import { describe, expect, test } from "bun:test";
import {
  DAYS_TO_EARN,
  TURNS_TO_EARN,
  emptyLedger,
  hasEarnedTheAsk,
  isoDay,
  recordDay,
  recordTurn,
  shouldGreet,
  type CommunityLedger,
} from "./community";

function used(days: number, turns = 0): CommunityLedger {
  let l = emptyLedger();
  for (let i = 0; i < days; i++) l = recordDay(l, `2026-09-${String(i + 1).padStart(2, "0")}`);
  for (let i = 0; i < turns; i++) l = recordTurn(l);
  return l;
}

describe("when Aura is allowed to ask for a star", () => {
  test("a fresh install has not earned it", () => {
    expect(hasEarnedTheAsk(emptyLedger())).toBe(false);
  });

  test("one long session is not enough on its own", () => {
    expect(hasEarnedTheAsk(used(1, TURNS_TO_EARN - 1))).toBe(false);
  });

  test("enough finished turns earns it, even inside one day", () => {
    expect(hasEarnedTheAsk(used(1, TURNS_TO_EARN))).toBe(true);
  });

  test("coming back on enough separate days earns it, with no agent at all", () => {
    expect(hasEarnedTheAsk(used(DAYS_TO_EARN))).toBe(true);
    expect(hasEarnedTheAsk(used(DAYS_TO_EARN - 1))).toBe(false);
  });

  test("opening the app twice in one day counts once", () => {
    let l = emptyLedger();
    for (let i = 0; i < 10; i++) l = recordDay(l, "2026-09-13");
    expect(l.days).toEqual(["2026-09-13"]);
    expect(hasEarnedTheAsk(l)).toBe(false);
  });

  test("once asked, it never asks again", () => {
    const earned = { ...used(DAYS_TO_EARN, TURNS_TO_EARN * 4), asked: true };
    expect(hasEarnedTheAsk(earned)).toBe(false);
  });

  test("someone who already starred and joined is never asked", () => {
    const l = { ...used(DAYS_TO_EARN), starred: true, joined: true };
    expect(hasEarnedTheAsk(l)).toBe(false);
  });

  test("starring without joining still leaves one thing to ask for", () => {
    const l = { ...used(DAYS_TO_EARN), starred: true };
    expect(hasEarnedTheAsk(l)).toBe(true);
  });

  test("the day list never grows without bound", () => {
    let l = emptyLedger();
    for (let i = 1; i <= 60; i++) l = recordDay(l, `2026-09-${String(i).padStart(2, "0")}`);
    expect(l.days.length).toBeLessThanOrEqual(DAYS_TO_EARN);
    expect(hasEarnedTheAsk(l)).toBe(true);
  });
});

describe("the first-run screen", () => {
  test("shows on a new install", () => {
    expect(shouldGreet(emptyLedger())).toBe(true);
  });

  test("never shows twice, whether they acted or skipped", () => {
    expect(shouldGreet({ ...emptyLedger(), greeted: true })).toBe(false);
    expect(shouldGreet({ ...emptyLedger(), greeted: true, starred: true })).toBe(false);
  });
});

describe("the day stamp", () => {
  test("is the user's own day, not UTC", () => {
    // 2026-01-01 05:00 UTC is still 2025-12-31 in the Americas. Whatever this
    // machine's zone, the stamp must match the local calendar date.
    const at = new Date("2026-01-01T05:00:00Z");
    expect(isoDay(at)).toBe(
      `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`,
    );
  });

  test("is a plain YYYY-MM-DD", () => {
    expect(isoDay(new Date(2026, 8, 3))).toBe("2026-09-03");
  });
});
