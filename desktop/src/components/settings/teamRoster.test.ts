// Run with: bun test src/components/settings/teamRoster.test.ts
//
// AURA-265, both halves. The count line and its note pin the copy that stops
// `6` here and `9` in the Console reading as a contradiction; the source scan
// at the bottom pins the other half of the same report — the selected sub-tab
// looked exactly like the one under the pointer, so "Usage highlights but
// Members is still on screen" was a hover being mistaken for a selection.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { rosterCountLine, rosterSourceNote } from "./teamRoster";

describe("rosterCountLine", () => {
  it("counts people, not members — the word that collided with the org's seat count", () => {
    expect(rosterCountLine(6, 1)).toBe("6 people · 1 admin");
    expect(rosterCountLine(6, 1)).not.toContain("member");
  });

  it("agrees with itself at one", () => {
    expect(rosterCountLine(1, 1)).toBe("1 person · 1 admin");
  });

  it("pluralises admins", () => {
    expect(rosterCountLine(9, 3)).toBe("9 people · 3 admins");
  });

  it("says nothing about admins when there is no admin yet", () => {
    // A team with no admin gets a Claim button beside this line; the line
    // itself must not print "0 admins" next to it.
    expect(rosterCountLine(4, 0)).toBe("4 people");
  });
});

describe("rosterSourceNote", () => {
  it("names the project, so the number is attached to something", () => {
    expect(rosterSourceNote("New Git")).toBe(
      "Everyone who has worked in New Git, from its own history.",
    );
  });

  it("falls back to a sentence that still works with no project name", () => {
    expect(rosterSourceNote(null)).toBe(
      "Everyone who has worked in this project, from its own history.",
    );
    expect(rosterSourceNote("   ")).toContain("in this project");
  });

  it("explains the other number only when the reader can see one", () => {
    // Signed in to a cloud org is exactly when a second, larger count exists.
    const signedIn = rosterSourceNote("New Git", "Naridon, Inc");
    expect(signedIn).toContain("Naridon, Inc can have more members than this");
    expect(signedIn).toContain("once they commit");

    // Signed out, raising it would answer a question nobody asked.
    expect(rosterSourceNote("New Git")).not.toContain("more members");
    expect(rosterSourceNote("New Git", "  ")).not.toContain("more members");
  });

  it("stays in the reader's words", () => {
    const s = rosterSourceNote("New Git", "Naridon, Inc").toLowerCase();
    for (const jargon of ["manifest", "git log", "presence", "roster", "seat"]) {
      expect(s).not.toContain(jargon);
    }
  });
});

describe("the Team sub-tabs", () => {
  // The audit reported: "Selecting Usage highlights the Usage tab, but after
  // 5+ seconds the full Members UI remains on screen." Switching sub-tab is a
  // single `setSub` — it cannot take five seconds. What it can do is look
  // switched: selected was `bg-bg-2 text-text-1 font-medium` and hover was
  // `hover:bg-state-hover hover:text-text-1`, near-identical, so a pointer
  // resting on Usage read as Usage being open.
  const src = readFileSync(join(import.meta.dir, "TeamTab.tsx"), "utf8");
  const button = src.slice(
    src.indexOf("function SubTabButton"),
    src.indexOf("function SubTabButton") + 1400,
  );

  it("marks the selected tab with something hover cannot produce", () => {
    // An underline drawn from the accent. Hover may tint; only selection
    // draws a rule under the tab.
    expect(button).toContain("borderBottom");
    expect(button).toContain("var(--color-accent)");
  });

  it("tells assistive tech which tab is open, not just which is warm", () => {
    expect(button).toContain("aria-selected");
    expect(button).toContain('role="tab"');
  });

  it("keeps the row a tablist, so the tabs are navigable as a set", () => {
    expect(src).toContain('role="tablist"');
  });
});
