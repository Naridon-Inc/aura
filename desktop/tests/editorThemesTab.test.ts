// Settings → Editor themes: the library is called the library, and the one
// thing on the pane that looks like a link is one.
//
//   bun test
//
// Driven in a real window, the pane read:
//
//     ACTIVE THEME
//     Aura default          GitHub-matched dark / light        ✓ Active
//     Pitch Black           Dark                          [ Activate ] 🗑
//     Pitch Black Amber     Dark                          [ Activate ] 🗑
//     … six more rows, each with Activate and a delete …
//
// A heading that names one thing over a list of eight, seven of which are
// explicitly not it. It is the library; one row of it happens to be active.
//
// And above it, "Find themes on the VS Code Marketplace" set the destination
// in `text-text-2` — brighter than the sentence around it, so it read as a
// link. It was a `<span>`. Clicking it did nothing, which inside a Tauri
// webview is also what a plain `target="_blank"` anchor would have done.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const DIALOG = "components/dialogs/SettingsDialog.tsx";

async function themesTab(): Promise<string> {
  const src = await readSrc(DIALOG);
  const start = src.indexOf("function EditorThemesTab()");
  expect(start).toBeGreaterThan(0);
  return src.slice(start, src.indexOf("\nfunction ", start + 10));
}

describe("editor themes — the library is named for what it holds", () => {
  test("the section over every theme is not called Active theme", async () => {
    const tab = await themesTab();
    expect(tab).not.toContain('<Section title="Active theme">');
    expect(tab).toContain('<Section title="Your themes">');
  });

  test("exactly one row in it can say Active", async () => {
    const src = await readSrc(DIALOG);
    const row = src.slice(src.indexOf("function ThemeChoiceRow("));
    // The row renders Active or an Activate button off the same boolean, so
    // the count follows from the single `active` prop rather than from the
    // heading — which is why the heading was free to lie.
    expect(row.slice(0, 900)).toContain("active ? (");
  });
});

describe("editor themes — the marketplace pointer is a real link", () => {
  test("it is an anchor routed through openExternal, not a bright span", async () => {
    const tab = await themesTab();
    expect(tab).not.toContain(
      '<span className="text-text-2">VS Code Marketplace</span>',
    );
    expect(tab).toContain("href={MARKETPLACE_THEMES_URL}");
    expect(tab).toContain("onClick={onExternalAnchorClick}");
  });

  test("the URL lands on themes, not on every extension", async () => {
    const src = await readSrc(DIALOG);
    const url = src.slice(src.indexOf("const MARKETPLACE_THEMES_URL"));
    expect(url.slice(0, 200)).toContain("marketplace.visualstudio.com");
    expect(url.slice(0, 200)).toContain("category=Themes");
  });

  test("the dialog imports the opener helper", async () => {
    const src = await readSrc(DIALOG);
    // A bare target="_blank" is silently dropped in the webview; anything
    // leaving the app goes through lib/openExternal.
    expect(src).toContain(
      'import { onExternalAnchorClick } from "../../lib/openExternal"',
    );
  });
});

describe("editor themes — presets say where they end up", () => {
  test("applying a preset is described as adding it to the library", async () => {
    const tab = await themesTab();
    // Otherwise the same eight names appear twice on one pane with no
    // explanation of why.
    expect(tab).toContain("adds it to your themes below");
  });
});
