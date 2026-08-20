// Settings → Modes is a list you pick one of, and it shows which one.
//
//   bun test
//
// Driven in a real window, Settings > Personal > Modes read:
//
//     Modes                          <- the rail already says this
//     Modes                          <- and the pane said it again
//     Install and manage modes. A mode bundles a system prompt, tool ACL…
//
//     ┌─┬──────────────────────────────────────────────┐
//     │▌│ ARC  Architect        …description cut mid-s… │
//     └─┴──────────────────────────────────────────────┘
//                                              Publish
//     ┌─┬──────────────────────────────────────────────┐
//     │▌│ CODE Implementer      …description cut mid-s… │
//     └─┴──────────────────────────────────────────────┘
//
// Four things wrong. The pane printed the heading the rail had already
// printed. It drew bordered cards with coloured rails — the shape the
// Brains pane was rewritten out of, because a list you pick one of is
// hairline rows. "Publish" floated between one card and the next, owned by
// neither. And nothing anywhere showed which mode was in use: clicking a
// card set the active mode and the list did not change.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const PANE = "components/marketplace/InstalledModesPane.tsx";
const CARD = "components/marketplace/ModeCard.tsx";

describe("modes pane", () => {
  test("does not print the heading the rail already printed", async () => {
    const src = await readSrc(PANE);
    expect(src).not.toMatch(/<h2[^>]*>\s*Modes/);
    // PaneHeader is rendered centrally by SettingsDialog for every pane.
    expect(src).not.toContain("PaneHeader");
  });

  test("is hairline rows, not a stack of cards", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("Section");
    expect(src).not.toContain("ModeCard");
  });

  test("the row shows which mode is in use", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("row-selected");
    expect(src).toContain("text-accent");
    expect(src).toContain("in use");
    // A toggle, not a radio: clearing back to no mode is a real answer,
    // and a radio group has no way to express it.
    expect(src).toContain("aria-pressed");
    expect(src).not.toContain('role="radio"');
  });

  test("publish belongs to a mode, not to the gap between two", async () => {
    const src = await readSrc(PANE);
    // Publish, Update and Uninstall sit in one cluster on the row.
    const cluster = src.slice(src.indexOf("shrink-0 items-center"));
    expect(cluster).toContain("onPublish");
    expect(cluster).toContain("onUninstall");
  });

  test("one publish control, not a pencil that opens the same dialog", async () => {
    const src = await readSrc(PANE);
    expect((src.match(/onClick=\{onPublish\}/g) ?? []).length).toBe(1);
    // PublishModeDialog publishes to a Gist; there is no YAML editor
    // behind the pencil that used to claim one.
    expect(src).not.toContain("Edit YAML");
    expect(src).not.toContain("Pencil");
  });

  test("descriptions are not cut mid-sentence", async () => {
    const src = await readSrc(PANE);
    expect(src).not.toContain("line-clamp");
  });

  test("the intro says what a mode is without naming the plumbing", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("PaneIntro");
    expect(src).not.toContain("tool ACL");
    expect(src).not.toContain("system prompt");
  });
});

describe("mode card", () => {
  test("keeps only what the marketplace grid mounts", async () => {
    const src = await readSrc(CARD);
    // onEdit / onSelect / inert existed only for the settings pane, which
    // no longer mounts a card at all.
    expect(src).not.toContain("onEdit");
    expect(src).not.toContain("onSelect");
    expect(src).not.toContain("inert");
    expect(src).not.toContain("Pencil");
  });
});
