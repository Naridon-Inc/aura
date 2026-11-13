// The reading these pin: a note written a minute ago says "1m ago", not "56y
// ago". Intent rows and ask hits are epoch seconds; the strip draws ages from
// milliseconds; the conversion happens once, where the rows come in.

import { expect, test } from "bun:test";

import type { AskHit, IntentEntry } from "./api";
import { noteAge, noteFromAskHit, noteFromIntent, rankNotes, secondsToMs, signerName } from "./insightNotes";

const NOW_MS = 1_794_252_198_000;

function intent(over: Partial<IntentEntry>): IntentEntry {
  return {
    id: "i1",
    timestamp: NOW_MS / 1000 - 120,
    agent: "claude",
    intent: "Moved the agent to the top of the roster",
    branch: "main",
    commit: "",
    status: "",
    ...over,
  };
}

test("an intent row's seconds read as a real age", () => {
  const n = noteFromIntent(intent({}));
  expect(n.whenMs).toBe(NOW_MS - 120_000);
  expect(noteAge(n, NOW_MS)).toBe("2m ago");
  expect(noteAge(n, NOW_MS)).not.toContain("y ago");
});

test("an ask hit's seconds read as a real age", () => {
  const hit: AskHit = {
    tier: "stated",
    score: 1,
    when: NOW_MS / 1000 - 3 * 3600,
    who: "MCP Agent",
    what: "Stop saving per-machine paths in the team file",
    store: "intent",
  } as AskHit;
  const n = noteFromAskHit(hit, ".aura/team/team.json", 0);
  expect(noteAge(n, NOW_MS)).toBe("3h ago");
  expect(n.id).toBe(`ask:.aura/team/team.json:${hit.when}:0`);
});

test("a row with no time has no age at all", () => {
  expect(secondsToMs(0)).toBeNull();
  expect(secondsToMs(Number.NaN)).toBeNull();
  expect(noteAge(noteFromIntent(intent({ timestamp: 0 })), NOW_MS)).toBe("");
});

test("stated reasons outrank edit-hook rows, and are signed plainly", () => {
  const notes = rankNotes([
    noteFromIntent(intent({ id: "a", agent: "hook_auto" })),
    noteFromIntent(intent({ id: "b", agent: "claude" })),
  ]);
  expect(notes.map((n) => n.id)).toEqual(["b", "a"]);
  expect(notes.map((n) => n.who)).toEqual(["Claude", "Recorded on edit"]);
  expect(signerName("MCP Agent")).toBe("MCP Agent");
});
