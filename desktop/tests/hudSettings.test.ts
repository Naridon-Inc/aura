// Settings → Floating HUD, and what the HUD says when it has nothing to say.
//
//   bun test
//
// Driven in a real window with the HUD switched off, the pane read:
//
//     AVAILABILITY
//     Enable the floating HUD                                  [ off ]
//       "When off, ⌘⇧A and the menu-bar icon do nothing and the
//        HUD stays hidden."
//     Desk pet                                                 [ ON  ]
//     SHAPE
//     Presentation                        [ Capsule | Sidebar | Minimal ]
//     Opacity                                          [ − 100% + ]
//     PREVIEW
//     Show the HUD                                    [ Show HUD ] ← greyed
//
// The button knew. Everything else went on taking settings for a window the
// same pane had just said cannot appear.
//
// Then the HUD itself, summoned cold, read:
//
//     🦉  [ Ready                                    ]
//              ◌ Ready · mixrank
//
// The one line you summon it to read spent itself repeating the line under it.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const DIALOG = "components/dialogs/SettingsDialog.tsx";
const CONTROLS = "components/settings/kit/controls.tsx";
const HUD = "components/hud/HudApp.tsx";

async function hudTab(): Promise<string> {
  const src = await readSrc(DIALOG);
  const start = src.indexOf("function HudTab()");
  expect(start).toBeGreaterThan(0);
  return src.slice(start, src.indexOf("\nfunction ", start + 10));
}

describe("HUD settings — nothing pretends to work while the HUD is off", () => {
  test("the pane derives one off-switch from the enable toggle", async () => {
    const tab = await hudTab();
    expect(tab).toContain("const off = !hud.enabled");
  });

  test("every control below Availability is gated on it", async () => {
    const tab = await hudTab();
    // Desk pet, Presentation, Opacity, and both sidebar sizes. The Show HUD
    // button was already gated on `!hud.enabled` — that's the one that gave
    // the game away.
    const gated = tab.split("disabled={off}").length - 1;
    expect(gated).toBe(5);
    expect(tab).toContain("disabled={!hud.enabled}");
  });

  test("and the page says why they're inert", async () => {
    const tab = await hudTab();
    expect(tab).toContain("The HUD is off, so the rest of this page has nothing to change");
  });

  test("the note only renders while it's off", async () => {
    const tab = await hudTab();
    expect(tab).toContain("{off && (");
  });
});

describe("HUD settings — the Stepper can be switched off whole", () => {
  test("disabled reaches both buttons, on top of the range clamps", async () => {
    const src = await readSrc(CONTROLS);
    const stepper = src.slice(src.indexOf("export function Stepper("));
    expect(stepper).toContain("disabled={disabled || value <= min}");
    expect(stepper).toContain("disabled={disabled || value >= max}");
  });

  test("and it reads as disabled, not merely unclickable", async () => {
    const src = await readSrc(CONTROLS);
    const stepper = src.slice(src.indexOf("export function Stepper("));
    expect(stepper.slice(0, 1400)).toContain('disabled && "opacity-50"');
  });
});

describe("the HUD's cold start says something new", () => {
  test("the pill no longer echoes the status caption under it", async () => {
    const src = await readSrc(HUD);
    expect(src).toContain("const coldStart = !state.lastUser && !state.lastAgent");
    expect(src).toContain("coldStart ? GREETING : STATUS_LABEL[state.status]");
  });

  test("collapsed and expanded open with the same sentence", async () => {
    const src = await readSrc(HUD);
    expect(src).toContain('const GREETING = "Where should we start?"');
    // The expanded greeting used to hard-code the string; two copies of an
    // opening line is how they drift apart.
    expect(src).not.toContain(">Where should we start?<");
    expect(src).toContain("{GREETING}");
  });

  test("a real reply still wins over the greeting", async () => {
    const src = await readSrc(HUD);
    const glance = src.slice(src.indexOf("const glanceText ="));
    expect(glance.slice(0, 200)).toContain("state.lastAgent?.text?.trim() ||");
  });
});
