// Run with: bun test src/components/settings/teamRoster.test.ts
//
// AURA-265, both halves. The count line and its note pin the copy that stops
// `6` here and `9` in the Console reading as a contradiction; the source scan
// at the bottom pins the other half of the same report — "Usage highlights but
// Members is still on screen" was a hover being mistaken for a selection, and
// the page now has no sub-tabs to mistake.

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
      "Everyone who has worked in this repository, from its own history.",
    );
    expect(rosterSourceNote("   ")).toContain("in this repository");
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

describe("the Team page", () => {
  // The audit reported: "Selecting Usage highlights the Usage tab, but after
  // 5+ seconds the full Members UI remains on screen" — a pointer resting on
  // a sub-tab read as that tab being open. The page no longer has sub-tabs:
  // members, activity and usage sit one under another, every section on
  // screen at once, so there is no selection for a hover to be mistaken for.
  const src = readFileSync(join(import.meta.dir, "TeamTab.tsx"), "utf8");

  it("is one page with no sub-tab strip", () => {
    expect(src).not.toContain("<TabsList");
    expect(src).not.toContain("<TabsContent");
  });

  it("shows members, then activity, then usage", () => {
    const members = src.indexOf("<MembersPane");
    const activity = src.indexOf('<SettingsSection title="Activity">');
    const usage = src.indexOf('<SettingsSection title="Usage">');
    expect(members).toBeGreaterThan(-1);
    expect(activity).toBeGreaterThan(members);
    expect(usage).toBeGreaterThan(activity);
  });
});
