// Run with: bun test src/components/ui/popoverHeight.test.ts
//
// AURA-271: the Tasks Display menu was 440px tall by declaration. At Aura's
// supported minimum window — 900×600 — there is not 440px below that button,
// so the menu ran off the bottom of the window and the "Show on cards"
// controls could not be reached. The inner scroller did not save it: the
// content fitted inside 440px, so nothing scrolled; it was the WINDOW doing
// the clipping.
//
// The rule that fixes it, and this test pins for every menu: a popover may
// have a preferred height, but it must be capped by the room the window
// actually left it. Radix measures that and publishes it as
// --radix-popover-content-available-height.
//
// A source scan rather than a render, because the regression is a class name
// and the bug only shows at a window size no unit test has.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sources(path));
    } else if (name.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

/** `max-h-[420px]` and friends — a height fixed in pixels by a class. */
const FIXED_HEIGHT = /max-h-\[\d+(px|rem)\]/;

describe("popover menus", () => {
  const files = sources(ROOT).filter((f) =>
    readFileSync(f, "utf8").includes("PopoverContent"),
  );

  test("there are menus to check", () => {
    // Guards the scan itself: a rename that empties this list would otherwise
    // turn the whole file into a test that passes by finding nothing.
    expect(files.length).toBeGreaterThan(2);
  });

  test("none of them fixes its height in pixels", () => {
    const offenders = files
      .filter((f) => FIXED_HEIGHT.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  test("every menu that scrolls asks the window how much room it has", () => {
    // Only the markup BETWEEN the tags — a file can hold a popover and an
    // unrelated scrolling panel, and the panel is not this rule's business.
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      let at = src.indexOf("<PopoverContent");
      while (at !== -1) {
        const end = src.indexOf("</PopoverContent>", at);
        const body = end === -1 ? src.slice(at) : src.slice(at, end);
        if (
          body.includes("overflow-y-auto") &&
          !body.includes("--radix-popover-content-available-height")
        ) {
          missing.push(f.slice(ROOT.length + 1));
          break;
        }
        at = src.indexOf("<PopoverContent", at + 1);
      }
    }
    expect(missing).toEqual([]);
  });
});
