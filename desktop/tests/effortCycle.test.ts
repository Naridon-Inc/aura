// ⌘⇧/ walks the effort ladder in the order the strip draws it, and wraps.

import { describe, expect, test } from "bun:test";

import { EFFORT_ORDER, effortLabel, nextEffort } from "../src/lib/effortCycle";
import { readSrc } from "./support/code";

describe("nextEffort", () => {
  test("walks Default → Low → Medium → High → Max → Default", () => {
    expect(nextEffort(null)).toBe("low");
    expect(nextEffort("low")).toBe("medium");
    expect(nextEffort("medium")).toBe("high");
    expect(nextEffort("high")).toBe("max");
    expect(nextEffort("max")).toBeNull();
  });

  test("an unknown value restarts from Default", () => {
    expect(nextEffort("turbo" as never)).toBe("low");
    expect(nextEffort(undefined)).toBe("low");
  });

  test("every level has a plain label", () => {
    for (const level of EFFORT_ORDER) expect(effortLabel(level).length).toBeGreaterThan(0);
  });

  test("the ladder matches the composer's strip order", async () => {
    // EFFORT_OPTIONS in ManagerComposer draws the buttons; the key must walk
    // them in the same order or the chord and the strip disagree.
    const src = await readSrc("components/manager/ManagerComposer.tsx");
    const block = src.match(/const EFFORT_OPTIONS[\s\S]*?\] = \[([\s\S]*?)\n\];/)?.[1] ?? "";
    const values = [...block.matchAll(/value: (null|"[a-z]+")/g)].map((m) =>
      m[1] === "null" ? null : m[1]!.slice(1, -1),
    );
    expect(values).toEqual([...EFFORT_ORDER]);
  });
});
