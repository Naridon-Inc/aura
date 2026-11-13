import { describe, expect, test } from "bun:test";
import { historyRequestIsFor, isOnScreen } from "./chatHistoryEvent";

describe("historyRequestIsFor", () => {
  test("an addressed request opens only that chat's menu", () => {
    expect(historyRequestIsFor({ sessionId: "s1" }, "s1", false)).toBe(true);
    expect(historyRequestIsFor({ sessionId: "s1" }, "s2", true)).toBe(false);
  });

  test("an unaddressed request reaches only a menu on screen", () => {
    expect(historyRequestIsFor({ sessionId: null }, "s1", true)).toBe(true);
    expect(historyRequestIsFor({ sessionId: null }, "s1", false)).toBe(false);
    expect(historyRequestIsFor(null, "s1", true)).toBe(true);
    expect(historyRequestIsFor(undefined, "s1", false)).toBe(false);
  });
});

describe("isOnScreen", () => {
  test("no element is never on screen", () => {
    expect(isOnScreen(null)).toBe(false);
  });

  test("defers to checkVisibility when the engine has it", () => {
    const shown = { checkVisibility: () => true, getClientRects: () => [] } as unknown as Element;
    const hidden = { checkVisibility: () => false, getClientRects: () => [1] } as unknown as Element;
    expect(isOnScreen(shown)).toBe(true);
    expect(isOnScreen(hidden)).toBe(false);
  });

  test("falls back to layout boxes without it", () => {
    const laidOut = { getClientRects: () => [1] } as unknown as Element;
    const none = { getClientRects: () => [] } as unknown as Element;
    expect(isOnScreen(laidOut)).toBe(true);
    expect(isOnScreen(none)).toBe(false);
  });
});
