// The claim under test: every panel built from the app's one flyout recipe
// is findable in the DOM as a flyout.
//
// That matters for exactly one reason. The native GPU terminal is a view the
// host floats OVER the webview, so a menu cannot be put in front of it with a
// z-index; `lib/nativeSurfacePlacement` instead steps the surface off the
// rectangle an open overlay needs, and it finds overlays by selector. A panel
// the selector cannot see opens behind a running terminal and shows only the
// strip of itself that clears the hole — which is what the status bar's CLI
// version chip did, along with the topbar pickers, Ports, the cloud pickers
// and both mention pickers.
//
// The selector names this recipe's marker class, and it repeats the literal
// rather than importing it so that module stays DOM-only (importing this one
// would pull React in through FinderList). Repeating a literal is only safe
// while the two agree, so the agreement is asserted here, from the side that
// can afford the import.

import { describe, expect, it } from "bun:test";

import { OVERLAY_SELECTOR } from "../../lib/nativeSurfacePlacement";

import { MENU_PANEL, MENU_SURFACE_CLASS } from "./menuSurface";

describe("MENU_SURFACE_CLASS", () => {
  it("is stamped on the shared panel recipe", () => {
    // Not `toContain` on the string: a substring match would pass on a class
    // that merely starts with the same prefix.
    expect(MENU_PANEL.split(/\s+/)).toContain(MENU_SURFACE_CLASS);
  });

  it("is what the native surface's overlay list looks for", () => {
    expect(OVERLAY_SELECTOR.split(",")).toContain(`.${MENU_SURFACE_CLASS}`);
  });

  it("carries no styling of its own", () => {
    // It is a name to query, not a look. If it ever grows a rule, the panels
    // stop being able to drop it without changing how they are drawn, and the
    // marker becomes load-bearing for appearance as well as for placement.
    expect(MENU_SURFACE_CLASS).toBe("aura-menu-surface");
  });
});
