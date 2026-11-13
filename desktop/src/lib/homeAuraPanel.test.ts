import { describe, expect, test } from "bun:test";

import {
  AURA_PANEL_DEFAULT,
  AURA_PANEL_MAX,
  AURA_PANEL_MIN,
  auraPanelAction,
  panelShown,
  parsePanelState,
} from "./homeAuraPanel";

describe("the stored panel layout", () => {
  test("nothing stored opens the panel at its default width", () => {
    expect(parsePanelState(null)).toEqual(AURA_PANEL_DEFAULT);
    expect(AURA_PANEL_DEFAULT.open).toBe(true);
  });

  test("a stored layout is read back", () => {
    expect(parsePanelState(JSON.stringify({ open: false, width: 500 }))).toEqual({
      open: false,
      width: 500,
    });
  });

  test("a width outside this build's bounds is clamped", () => {
    expect(parsePanelState(JSON.stringify({ open: true, width: 40 })).width).toBe(AURA_PANEL_MIN);
    expect(parsePanelState(JSON.stringify({ open: true, width: 9999 })).width).toBe(AURA_PANEL_MAX);
  });

  test("garbage falls back field by field, never throws", () => {
    expect(parsePanelState("{not json")).toEqual(AURA_PANEL_DEFAULT);
    expect(parsePanelState("null")).toEqual(AURA_PANEL_DEFAULT);
    expect(parsePanelState(JSON.stringify({ open: "yes", width: 480 }))).toEqual({
      open: AURA_PANEL_DEFAULT.open,
      width: 480,
    });
    expect(parsePanelState(JSON.stringify({ open: false, width: "wide" }))).toEqual({
      open: false,
      width: AURA_PANEL_DEFAULT.width,
    });
  });
});

describe("the feature flag decides first", () => {
  test("flag off: no panel, whatever was stored while it was on", () => {
    expect(panelShown(false, { open: true, width: 420 })).toBe(false);
    expect(panelShown(false, parsePanelState(JSON.stringify({ open: true, width: 600 })))).toBe(false);
  });

  test("flag on: the stored open state decides", () => {
    expect(panelShown(true, { open: true, width: 420 })).toBe(true);
    expect(panelShown(true, { open: false, width: 420 })).toBe(false);
  });

  test("flag off: the toggle does nothing, on Home or off it", () => {
    expect(auraPanelAction(false, true, false)).toBe("none");
    expect(auraPanelAction(false, false, false)).toBe("none");
    expect(auraPanelAction(false, true, true)).toBe("none");
  });
});

describe("the toggle (toolbar button, ⌥⇧⌘A)", () => {
  test("away from Home it takes you there with the panel open", () => {
    expect(auraPanelAction(true, false, false)).toBe("open-on-home");
    expect(auraPanelAction(true, false, true)).toBe("open-on-home");
  });

  test("on Home it flips the panel", () => {
    expect(auraPanelAction(true, true, false)).toBe("open");
    expect(auraPanelAction(true, true, true)).toBe("close");
  });
});
