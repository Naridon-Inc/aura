// Accounts & profiles says what a choice does, in the app's own colour.
//
//   bun test
//
// Driven in a real window, Settings > Personal > Accounts & profiles read:
//
//     Git identity            (none. Use system default)
//     Default agent profile   (none. Inherit system HOME)
//     Where to save           (•) Repo file (.aura/profile.json)
//                             ( ) Global path map   (loaded from repo)
//
// The two radios drew in the macOS blue because they were bare inputs — the
// only choice controls in the app not wearing the brand accent. And every
// label named the mechanism rather than the consequence: "Repo file
// (.aura/profile.json)" vs "Global path map" is the difference between a
// setting your teammates inherit when they clone and one that never leaves
// this machine, which is the only part worth reading.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const SETTINGS = "components/settings/pages/AccountsProfiles.tsx";

describe("accounts & profiles pane", () => {
  test("the save-scope choice is named by what it does", async () => {
    const src = await readSrc(SETTINGS);
    expect(src).toContain("With the repository");
    expect(src).toContain("Only on this computer");
    // The two filenames were the whole label.
    expect(src).not.toContain("Repo file (.aura/profile.json)");
    expect(src).not.toContain("Global path map");
  });

  test("where it is saved is spelled out, not printed as a keyword", async () => {
    const src = await readSrc(SETTINGS);
    expect(src).toContain(
      "Saved with the repository, so it travels to anyone who clones it.",
    );
    expect(src).toContain("Saved on this computer only.");
    expect(src).not.toContain("(loaded from {binding.source})");
  });

  test("the two 'none' options describe what you get, not the plumbing", async () => {
    const src = await readSrc(SETTINGS);
    expect(src).toContain("This computer's git identity");
    expect(src).toContain("Your normal agent logins");
    expect(src).not.toContain("(none. Use system default)");
    expect(src).not.toContain("(none. Inherit system HOME)");
  });
});

describe("radios wear the brand accent", () => {
  // Tailwind's `accent-*` maps to CSS accent-color; without it macOS paints
  // its own blue, which is the one colour the app never uses.
  test("the save-scope choice is the shared select, not a native radio", async () => {
    // A native radio is where macOS paints its own blue; the settings page
    // offers the same two answers through the app's own Select instead.
    const src = await readSrc(SETTINGS);
    expect(src).not.toContain('type="radio"');
    expect(src).toContain("<Select");
  });

  test("Edit reason picks what to merge with in its own list, not a native radio", async () => {
    // The merge target used to be a native radio that needed an accent class
    // to avoid macOS blue; it is now a row in the shared list box that marks
    // the chosen reason with a tick.
    const src = await readSrc("components/dialogs/IntentSplitMergeDialog.tsx");
    expect(src).not.toContain('type="radio"');
    expect(src).toContain('role="radiogroup"');
    expect(src).toContain('role="radio"');
    expect(src).toContain("aria-checked={checked}");
  });
});
