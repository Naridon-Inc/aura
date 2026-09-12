// Run with: bun test src/components/workpanes/CostUsagePane.test.ts
//
// AURA-1375. The pane printed a cost and left the reader to guess what it
// counted. These pin the two halves of the answer: local spend is described
// in the CLI's own words, and cloud spend — which the CLI never sees — is
// not described in them.

import { describe, expect, test } from "bun:test";

import { coverageNotes, spendFootnote } from "./CostUsagePane";

const local = (notes: string[]) => ({ measurementNotes: notes });

describe("coverageNotes", () => {
  test("local spend is described in the CLI's own words", () => {
    const notes = ["Counts every Claude Code turn recorded on this machine."];
    expect(coverageNotes(false, local(notes))).toEqual(notes);
  });

  test("cloud spend is not described by the local report's limits", () => {
    // The hero is the org's billed total; saying it covers "this machine
    // only" would be false in the reassuring direction.
    const notes = coverageNotes(true, local(["…on this machine…"]));
    expect(notes.join(" ")).not.toContain("this machine");
    expect(notes.join(" ")).toContain("Aura Cloud");
  });

  test("an older CLI that sends no notes gets no invented ones", () => {
    expect(coverageNotes(false, local([]))).toEqual([]);
    expect(coverageNotes(false, null)).toEqual([]);
  });
});

describe("spendFootnote", () => {
  test("a signed-in reader is never told to sign in", () => {
    expect(spendFootnote(true)).not.toContain("Sign in");
  });
});
