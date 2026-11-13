import { describe, expect, test } from "bun:test";

import { paletteNoMatch, palettePlaceholder, paletteTabsFor, stepPaletteTab } from "./paletteTabs";

describe("palette tabs", () => {
  test("Repositories is listed only where the place has them", () => {
    expect(paletteTabsFor(true).map((t) => t.id)).toEqual([
      "all",
      "workspaces",
      "repositories",
      "actions",
      "settings",
    ]);
    expect(paletteTabsFor(false).map((t) => t.id)).toEqual(["all", "workspaces", "actions", "settings"]);
  });

  test("Tab steps forward and wraps; Shift-Tab steps back", () => {
    expect(stepPaletteTab("all", true)).toBe("workspaces");
    expect(stepPaletteTab("settings", true)).toBe("all");
    expect(stepPaletteTab("all", true, true)).toBe("settings");
    expect(stepPaletteTab("workspaces", false)).toBe("actions");
    expect(stepPaletteTab("actions", true, true)).toBe("repositories");
  });

  test("a tab no longer on show starts again from All", () => {
    expect(stepPaletteTab("repositories", false)).toBe("all");
  });

  test("each tab says what it searches", () => {
    expect(palettePlaceholder("all")).toBe("Type a command or search...");
    expect(palettePlaceholder("settings")).toBe("Search settings...");
    expect(paletteNoMatch("actions")).toBe("No matching actions");
  });
});
