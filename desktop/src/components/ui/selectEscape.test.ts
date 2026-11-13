import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { escapeTaker } from "./select";

function key(k: string, extra: Partial<KeyboardEvent> = {}) {
  const seen = { prevented: false, stopped: false };
  const event = {
    key: k,
    isComposing: false,
    preventDefault: () => (seen.prevented = true),
    stopPropagation: () => (seen.stopped = true),
    ...extra,
  } as unknown as KeyboardEvent;
  return { event, seen };
}

describe("an open dropdown takes Escape before the dialog under it", () => {
  test("Escape closes the dropdown and goes no further", () => {
    let closed = 0;
    const { event, seen } = key("Escape");
    escapeTaker(() => closed++)(event);
    expect(closed).toBe(1);
    expect(seen).toEqual({ prevented: true, stopped: true });
  });

  test("other keys and typing in a composition pass through", () => {
    let closed = 0;
    const take = escapeTaker(() => closed++);
    for (const { event, seen } of [key("Enter"), key("ArrowDown"), key("Escape", { isComposing: true })]) {
      take(event);
      expect(seen).toEqual({ prevented: false, stopped: false });
    }
    expect(closed).toBe(0);
  });

  test("the dropdown listens on the window, in capture, only while open", () => {
    const src = readFileSync(join(import.meta.dir, "select.tsx"), "utf8");
    expect(src).toContain('window.addEventListener("keydown", take, true)');
    expect(src).toContain('window.removeEventListener("keydown", take, true)');
    expect(src).toMatch(/if \(!open\) return;/);
    expect(src).toMatch(/open=\{open\}\s+onOpenChange=\{setOpen\}/);
  });
});
