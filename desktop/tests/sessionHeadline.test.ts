// What a session row calls itself, and who is speaking when it does.
//
//   bun test ./tests/sessionHeadline.test.ts
//
// AURA-1360. A reviewer scanning Trace has to be able to tell three things
// apart without opening anything: what the person asked for, what the agent
// says it did, and what a machine wrote about a diff. All three arrive as one
// sentence in the same field, in the same place, in the same voice.
//
// Two of them were indistinguishable. `intentProvenance` had four kinds and no
// kind for the agent's own closing message, so a Stop-hook note came back
// "stated" and the surfaces headed it "Reason" — the agent's account of its own
// work, presented as a reason somebody gave for a change. Its title was worse:
// the raw text starts "agent turn complete: " and continues into a page of
// markdown, and on one truncated line the preamble is the entire visible width.
//
// The third case is a run nobody wrote anything about. Filtering its captures
// away entirely made the run disappear; keeping them made a temp-file path the
// headline. It says the true thing instead and keeps the command.

import { describe, expect, test } from "bun:test";

import { keepOneRowPerCommandOnlyRun } from "../src/lib/api";
import type { ClaudeSession, IntentRow } from "../src/lib/api";
import {
  intentProvenance,
  isAgentTurnReport,
  provenanceLabel,
  provenanceNote,
  provenanceTag,
  sessionDisplayTitle,
  titleProvenance,
} from "../src/lib/sessionMeta";

const NOW = 1_788_000_000;
const NO_SESSIONS: ClaudeSession[] = [];

function row(over: Partial<IntentRow> = {}): IntentRow {
  return {
    timestamp: NOW,
    agent_id: "Claude",
    intent: "switch retry to exponential backoff so we stop tripping the limit",
    ...over,
  };
}

/** A tool call as the hook writes it: named tool, default source, no reason. */
function capture(over: Partial<IntentRow> = {}): IntentRow {
  return row({
    source: "hook_auto",
    tool: "Bash",
    intent: "running Bash on bash /private/tmp/claude-501/9e7c366c.sh",
    ...over,
  });
}

describe("the agent's own closing message", () => {
  const report = row({
    intent:
      "agent turn complete: **Landed:** 6 commits, all 10 verified defects fixed\n\nTests green.",
  });

  test("is recognised as the agent talking", () => {
    expect(isAgentTurnReport(report)).toBe(true);
    expect(isAgentTurnReport(row())).toBe(false);
    // The bare form the hook writes when the turn produced no closing text.
    expect(isAgentTurnReport(row({ intent: "agent turn complete" }))).toBe(true);
  });

  test("is not filed as a reason somebody gave", () => {
    expect(intentProvenance(report)).toBe("reported");
    expect(provenanceLabel(intentProvenance(report))).toBe(
      "What the agent said it did",
    );
    expect(provenanceNote(intentProvenance(report))).toContain(
      "not the same as what you asked for",
    );
  });

  test("is marked on a list, like the other sentence a person did not write", () => {
    // Only the two that *look* like somebody's reason get a marker. A marker on
    // every row is a marker nobody reads.
    expect(provenanceTag("reported")).toBe("Agent's account");
    expect(provenanceTag("inferred")).toBe("Aura's summary");
    expect(provenanceTag("stated")).toBe("");
    expect(provenanceTag("asked")).toBe("");
  });

  test("reads as a sentence, not as a preamble", () => {
    // Before: the row showed "agent turn complete: **Landed:** 6 commits, all…"
    // and the first six words were machine bookkeeping.
    expect(sessionDisplayTitle(report, NO_SESSIONS)).toBe(
      "Landed: 6 commits, all 10 verified defects fixed",
    );
  });

  test("a stated reason keeps its own words", () => {
    expect(sessionDisplayTitle(row(), NO_SESSIONS)).toBe(
      "switch retry to exponential backoff so we stop tripping the limit",
    );
    expect(intentProvenance(row())).toBe("stated");
  });
});

describe("a run nobody wrote a request for", () => {
  test("says so, instead of showing the command line", () => {
    const only = capture();
    expect(sessionDisplayTitle(only, NO_SESSIONS)).toBe("No request was recorded");
    expect(titleProvenance(only, NO_SESSIONS)).toBe("uncaptured");
  });

  test("keeps the command on the row as evidence", () => {
    // The headline stops being the command; the command does not stop existing.
    const only = capture();
    expect(only.intent).toContain("/private/tmp/claude-501/9e7c366c.sh");
  });

  test("survives as exactly one row, the last one", () => {
    const rows = [
      capture({ session_id: "run-a", timestamp: NOW + 300, intent: "running Bash on git push" }),
      capture({ session_id: "run-a", timestamp: NOW + 100 }),
      capture({ session_id: "run-a", timestamp: NOW + 200 }),
    ];
    const kept = keepOneRowPerCommandOnlyRun(rows);
    expect(kept).toHaveLength(1);
    expect(kept[0].timestamp).toBe(NOW + 300);
  });

  test("a run that explained itself loses every capture", () => {
    const rows = [
      row({ session_id: "run-b", intent: "make the guard fail closed" }),
      capture({ session_id: "run-b" }),
      capture({ session_id: "run-b", tool: "Edit" }),
    ];
    const kept = keepOneRowPerCommandOnlyRun(rows);
    expect(kept).toHaveLength(1);
    expect(kept[0].intent).toBe("make the guard fail closed");
  });

  test("a capture belonging to no run at all is dropped", () => {
    // Nothing truthful can be said about it: it names no session, so it cannot
    // be presented as "this run had no request" either.
    expect(keepOneRowPerCommandOnlyRun([capture()])).toHaveLength(0);
  });

  test("runs keep the order they arrived in", () => {
    const rows = [
      row({ session_id: "run-b", timestamp: NOW + 500, intent: "second" }),
      capture({ session_id: "run-a", timestamp: NOW + 400 }),
      capture({ session_id: "run-a", timestamp: NOW + 450 }),
      row({ session_id: "run-c", timestamp: NOW + 100, intent: "third" }),
    ];
    const kept = keepOneRowPerCommandOnlyRun(rows);
    expect(kept.map((r) => r.session_id)).toEqual(["run-b", "run-a", "run-c"]);
    expect(kept[1].timestamp).toBe(NOW + 450);
  });
});
