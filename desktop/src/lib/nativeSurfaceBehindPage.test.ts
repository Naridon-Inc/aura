// Run with: bun test src/lib/nativeSurfaceBehindPage.test.ts
//
// A page (Home, the Dashboard, Trace, a machine) is drawn over the work
// surface and leaves it mounted, so its agents keep streaming. The page's
// background hides DOM content and nothing else: a terminal or browser view
// floats above the whole webview, and it went on painting across the page.
// The shell now marks the covered layer `inert`, and every native surface
// reads that on its way to the screen.
//
// Source scans rather than renders: the native surfaces need the desktop
// shell, and the claim is about which attribute each one reads.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

const APP = read("App.tsx");
const TERMINAL = read("components/NativeTerminal.tsx");
const BROWSERS = ["components/workpanes/BrowserTab.tsx"];

/** The body of `function name(...) { ... }` up to the next blank line. */
function fnBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n\n", start);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("the work surface under a page", () => {
  // A machine in front takes the work surface's place in the frame: the
  // laptop's surface and any page leave the layout but stay mounted, and stay
  // inert so a native terminal or browser view under them steps off too.
  test("is inert while a page or a machine is in front of it", () => {
    expect(APP).toMatch(
      /className=\{remoteEntry \? "hidden" : "contents"\}\s*inert=\{activePage \|\| remoteEntry \? true : undefined\}\s*>\s*<WorkSurface\b/,
    );
  });

  test("a page under a machine is inert too", () => {
    expect(APP).toMatch(
      /remoteEntry \? "hidden" : "absolute inset-0 z-20 overflow-hidden bg-bg-content"[\s\S]{0,240}inert=\{remoteEntry \? true : undefined\}/,
    );
  });
});

describe("a native terminal behind a page", () => {
  test("is not shown when its subtree is inert", () => {
    expect(fnBody(TERMINAL, "isShown")).toContain("isWithheld(el)");
  });

  test("hears the attribute change, not only the next sweep", () => {
    expect(TERMINAL).toMatch(/attributeFilter: \[[^\]]*"inert"[^\]]*\]/);
  });

  test("parks a surface nobody is showing", () => {
    expect(TERMINAL).toContain("dropSurface(termId, token) || !surfaceHeld(termId)");
  });

  test("hands its surface back on unmount even before it was live", () => {
    expect(TERMINAL).toMatch(/const mine = dropSurface\(termId, token\);\s*if \(mine && liveNativeTerms\.has\(termId\)\) parkNow\(\);/);
  });
});

describe("a browser view behind a page", () => {
  for (const rel of BROWSERS) {
    test(`${rel.split("/").pop()} hides when its hole is inert`, () => {
      expect(fnBody(read(rel), "visibleRect")).toContain("isWithheld(el)");
    });
  }
});
