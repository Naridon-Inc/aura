// Run with: bun test src/components/tour/tourOverNativeSurface.test.ts
//
// The tour dims the window with a layer that lets clicks through, so the
// anchored place underneath stays clickable. A native terminal paints above
// the whole webview and only steps aside for what it can find: a hit test
// (which a click-through layer is invisible to) or the overlay list in
// `lib/nativeSurfacePlacement`. Without the opt-in the terminal stayed lit
// over the dim, as if the tour were not running.
//
// A source scan rather than a render: the layer only exists once a step has
// measured its anchor, which needs a real layout.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "GetStartedTour.tsx"), "utf8");

describe("the tour's dim over a native terminal", () => {
  test("the dim layer opts in as an overlay", () => {
    const tag = SOURCE.match(/<div className="ui-tour-layer"[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag![0]).toContain("data-over-native-surface");
  });
});
