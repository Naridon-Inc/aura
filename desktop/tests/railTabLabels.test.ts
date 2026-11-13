// Every tab in the right rail's strip spells its own name.
//
// It used to spell only the selected one. Files and Changes sat there as a bare
// folder and a bare grid, and the only way to learn which was which was to
// click one — the strip answered the question you already had and hid the ones
// you did not. The rail is ~310px wide and drags down to 240, so when the names
// outgrow it the strip scrolls (with a chevron at the clipped end); it never
// shortens or drops a word to make room.
//
// This is the kind of change that reverts by accident. Someone adding a tab,
// tightening the strip, or "fixing" an overflow reaches for the same
// `active && label` shortcut, and the result still looks deliberate — a tidy
// row of glyphs. The only way to tell is to read the strip, so that is what
// this does.

import { describe, expect, it } from "bun:test";

import { readSrc } from "./support/code";

const src = await readSrc("components/rightrail/RightRail.tsx");
const tabsSrc = await readSrc("components/ui/details-panel.tsx");
const tabsCss = await readSrc("components/ui/details-panel.css");
const css = await readSrc("styles.css");

/** The strip's markup — from the tab list to the end of the trigger map. */
const strip = tabsSrc.slice(
  tabsSrc.indexOf('className="ui-details-tabs"'),
  tabsSrc.indexOf("</TabsList>"),
);

/** One CSS rule's body, by its exact selector. */
function rule(sheet: string, selector: string): string {
  const at = sheet.indexOf(`${selector} {`);
  if (at < 0) return "";
  return sheet.slice(at, sheet.indexOf("}", at));
}

describe("the rail's tab strip", () => {
  it("has a strip to read in the first place", () => {
    // A slice that came back empty would pass every `not.toContain` below it.
    expect(strip).toContain("tabs.map");
    expect(strip).toContain("<TabsTrigger");
    // …and the rail draws its tabs with it rather than a strip of its own.
    expect(src).toContain("<DetailsTabs");
    expect(src).not.toContain('role="tablist"');
  });

  it("renders the label for every cell, not only the selected one", () => {
    expect(strip).toContain("{tab.label}");
    // The shortcut that caused this: a label rendered behind the selection.
    expect(strip).not.toMatch(/(active|selected)\s*&&\s*tab\.label/);
  });

  it("still carries the names in the sections list", () => {
    // Labels on screen are worth nothing if the options stopped having any.
    for (const label of ["All files", "Changes", "Checks"]) {
      expect(src).toContain(`label: "${label}"`);
    }
    // A plugin panel's label is its manifest title, on the same rule as the
    // built-ins — no second code path that could go back to a mute dot.
    expect(src).toContain("label: p.title");
  });

  it("keeps the changed-file count beside the name", () => {
    // The count is why you reach for Changes; it survived the icon-only strip
    // and it has to survive this one.
    expect(src).toContain('label: "Changes", count: changesCount');
    expect(strip).toMatch(/tab\.count != null && tab\.count > 0/);
    expect(strip).toContain("<small>{tab.count}</small>");
  });

  it("names the count in the accessible name, which the visible label cannot", () => {
    // On screen the number sits flush against the word; read aloud that
    // would be "Changes3".
    expect(strip).toContain("`${tab.label} · ${tab.count}`");
  });

  it("gives ground by scrolling rather than by hiding the word", () => {
    // A cell never wraps or shrinks its name; the strip scrolls instead, with
    // its scrollbar hidden and a chevron at whichever end is clipped.
    expect(rule(tabsCss, ".ui-details-tabs button")).toContain("white-space: nowrap");
    expect(rule(tabsCss, ".ui-details-tabs")).toContain("overflow-x: auto");
    expect(tabsSrc).toContain('aria-label="Scroll details tabs left"');
    expect(tabsSrc).toContain('aria-label="Scroll details tabs right"');
  });

  it("pins every cell so a short name can never clip", () => {
    // With scrolling as the release valve, no cell has a reason to shrink —
    // and a cell that may shrink is a name that may clip.
    for (const selector of [".ui-details-tabs button", ".ui-details-toolbar .ui-details-tabs button"]) {
      const body = rule(tabsCss, selector);
      expect(body).not.toBe("");
      expect(body).not.toMatch(/flex:|flex-shrink:|min-width:|max-width:|text-overflow/);
    }
  });

  it("lets a long plugin title scroll the strip, not squeeze the built-ins", () => {
    // One plugin with a long manifest title used to drag Files and Changes to
    // `F..` and `Ch...`. Plugin tabs now go through the same trigger as every
    // other tab, so the only thing a long title can do is make the strip scroll.
    expect(src).not.toContain("yields");
    expect(tabsSrc).not.toContain("plugin:");
  });

  it("has no icon-only cell state left to fall back into", () => {
    // `mark-only` was the class that hid the word. It is gone from every side,
    // so a half-revert cannot quietly reinstate it.
    expect(src).not.toContain("mark-only");
    expect(tabsSrc).not.toContain("mark-only");
    expect(css).not.toContain("mark-only");
  });
});
