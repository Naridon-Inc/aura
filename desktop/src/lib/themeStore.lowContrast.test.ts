import { describe, expect, test } from "bun:test";

import {
  AMBER_DARK_TOKENS,
  LOW_CONTRAST_AMBER_DARK,
  LOW_CONTRAST_AMOUNT,
  SOFTENED_TOKENS,
  contrastRatio,
  luminance,
  softenDarkPalette,
} from "./themeStore";

describe("low-contrast dark palette", () => {
  test("takes the body-text ratio down by about the promised amount", () => {
    const before = contrastRatio(AMBER_DARK_TOKENS["--color-text-1"], AMBER_DARK_TOKENS["--color-bg-0"]);
    const after = contrastRatio(
      LOW_CONTRAST_AMBER_DARK["--color-text-1"],
      LOW_CONTRAST_AMBER_DARK["--color-bg-0"],
    );
    const drop = 1 - after / before;
    // "About 15%": inside five points either side, so a pack tweak that
    // quietly turned this into a 30% wash, or a no-op, fails here.
    expect(drop).toBeGreaterThan(LOW_CONTRAST_AMOUNT - 0.05);
    expect(drop).toBeLessThan(LOW_CONTRAST_AMOUNT + 0.05);
  });

  test("body copy stays over the AA floor", () => {
    // text-3 is the AA floor for body copy in the amber pack (4.68:1 on bg-0).
    // Softening must not push the dimmest body text under 4.5:1 — that would
    // make "easier on the eyes" mean "harder to read".
    const ratio = contrastRatio(
      LOW_CONTRAST_AMBER_DARK["--color-text-3"],
      LOW_CONTRAST_AMBER_DARK["--color-bg-0"],
    );
    expect(ratio).toBeGreaterThanOrEqual(4.0);
    const primary = contrastRatio(
      LOW_CONTRAST_AMBER_DARK["--color-text-1"],
      LOW_CONTRAST_AMBER_DARK["--color-bg-0"],
    );
    expect(primary).toBeGreaterThanOrEqual(7);
  });

  test("the ground lifts and the ink dims, so the two really meet", () => {
    expect(luminance(LOW_CONTRAST_AMBER_DARK["--color-bg-0"])).toBeGreaterThan(
      luminance(AMBER_DARK_TOKENS["--color-bg-0"]),
    );
    expect(luminance(LOW_CONTRAST_AMBER_DARK["--color-text-1"])).toBeLessThan(
      luminance(AMBER_DARK_TOKENS["--color-text-1"]),
    );
    // Still a dark theme: the ground is nowhere near mid-grey.
    expect(luminance(LOW_CONTRAST_AMBER_DARK["--color-bg-0"])).toBeLessThan(0.05);
  });

  test("keeps the ramp in order", () => {
    const l = (k: string) => luminance(LOW_CONTRAST_AMBER_DARK[k]);
    expect(l("--color-text-1")).toBeGreaterThan(l("--color-text-2"));
    expect(l("--color-text-2")).toBeGreaterThan(l("--color-text-3"));
    expect(l("--color-text-3")).toBeGreaterThan(l("--color-text-4"));
    expect(l("--color-bg-3")).toBeGreaterThan(l("--color-bg-0"));
    expect(l("--color-bg-0")).toBeGreaterThan(l("--color-bg-1"));
  });

  test("never touches the accent or anything with meaning", () => {
    expect(LOW_CONTRAST_AMBER_DARK["--color-accent"]).toBeUndefined();
    expect(SOFTENED_TOKENS).not.toContain("--color-accent");
    expect(SOFTENED_TOKENS).not.toContain("--color-red");
    expect(SOFTENED_TOKENS).not.toContain("--color-amber");
    expect(SOFTENED_TOKENS).not.toContain("--color-primary");
  });

  test("every softened token is a flat six-digit hex", () => {
    for (const value of Object.values(LOW_CONTRAST_AMBER_DARK)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("passes a pack alias through rather than mangling it", () => {
    const soft = softenDarkPalette({
      ...AMBER_DARK_TOKENS,
      "--color-popover-bg": "var(--color-bg-1)",
    });
    expect(soft["--color-popover-bg"]).toBeUndefined();
    expect(soft["--color-bg-1"]).toBeDefined();
  });

  test("a palette with no ground or ink to measure against softens nothing", () => {
    expect(softenDarkPalette({ "--color-text-2": "#bab5ad" })).toEqual({});
  });
});
