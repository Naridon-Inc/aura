// Run with: bun test src/components/ui/sidebarGutter.test.ts
//
// The left sidebar's list sat 6px from the left edge and 16px from the right
// once it was long enough to scroll: the app's scrollbar (styles.css, 10px)
// takes its room from the right. The list now scrolls with a scrollbar as
// wide as its left padding standing in for the right padding, so the two
// sides match whether it scrolls or not. Its top-level headings ("My
// workspaces", "People") stay pinned while the list scrolls under them.
// Measured in a browser when it was fixed; pinned here by source scan
// because it is a handful of stylesheet rules.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (name: string) =>
  readFileSync(join(import.meta.dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const nav = read("app-navigation.css");
const library = read("interface.css");

/** Declarations of every rule whose selector, whitespace collapsed, is `selector`. */
function rules(css: string, selector: string): string {
  const want = selector.replace(/\s+/g, " ").trim();
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].replace(/\s+/g, " ").trim() === want) out.push(m[2]);
  }
  return out.join(";");
}

const px = (decls: string, prop: string) =>
  decls.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`))?.[1];

describe("sidebar list gutter", () => {
  const scroller = ".ui-app-navigation > .ui-sidebar-content";

  test("the scrollbar always takes the right gutter, never the content's padding", () => {
    const d = rules(nav, scroller);
    expect(d).toMatch(/overflow-y:\s*scroll/);
    expect(d).toMatch(/padding-right:\s*0/);
  });

  test("the scrollbar is exactly as wide as the list's left padding", () => {
    const left = px(rules(library, ".ui-sidebar-content"), "padding");
    expect(left).toBeDefined();
    expect(px(rules(nav, `${scroller}::-webkit-scrollbar`), "width")).toBe(left);
  });
});

describe("sidebar list headings", () => {
  const heading = ".ui-app-navigation .ui-roster > .ui-sidebar-group > .ui-sidebar-group-header";

  test("pin to the top of the list, over the rows", () => {
    const d = rules(nav, heading);
    expect(d).toMatch(/position:\s*sticky/);
    expect(d).toMatch(/top:\s*-6px/);
    expect(Number(d.match(/z-index:\s*(\d+)/)?.[1])).toBeGreaterThan(0);
  });

  test("are opaque at rest and on hover, so rows never show through", () => {
    expect(rules(nav, heading)).toMatch(/background:\s*var\(--ui-sidebar\)/);
    expect(
      rules(nav, `${heading}:is(:hover, :has(> [data-state="open"]))`),
    ).toMatch(/background:[^;]*var\(--ui-sidebar\)/);
  });
});
