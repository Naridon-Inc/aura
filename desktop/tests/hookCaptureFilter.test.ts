// Which intent-log rows are a machine's notes, and which are somebody's work.
//
//   bun test ./tests/hookCaptureFilter.test.ts
//
// Trace showed a session called "running Bash on bash /private/tmp/claude-501/
// -Users-muhammed--aura-worktrees-…/9e7c366c…" — a shell command wearing the
// name of a piece of work. Every agent tool call is written to the intent log
// by a hook, and those rows were meant to be dropped at the data boundary. The
// filter that drops them tested `agent_id`, and the desktop's event listener
// had since learned to put the real CLI's name there (`AURA_AGENT=Claude`) so
// the console would stop crediting work to a mechanism. Correct on its own
// terms, and it left every capture row indistinguishable from a real one:
// 5099 of 8290 rows in one worktree's log walked past the test.
//
// The tempting repair is to test `source` instead. It is worse. `--source`
// defaults to "hook_auto" inside `aura log-intent`, so a reason stated by hand
// carries the same mark as a hook capture, and that rule silently deletes real
// work from the record.
//
// The fact that actually separates them is `tool`: a hook row is written about
// a tool call and names it; nothing else fills the field in. And a hook row
// whose text was displaced by a reason the agent gave to `aura snapshot-file
// --why` keeps the mechanical sentence in `change` — which makes `change` the
// row's own evidence that somebody explained this change, and worth more than
// the fact that a hook typed it.

import { describe, expect, test } from "bun:test";

import { AUTO_CAPTURE_AGENT_ID, isMechanicalHookCapture } from "../src/lib/api";
import type { IntentRow } from "../src/lib/api";

function row(over: Partial<IntentRow> = {}): IntentRow {
  return {
    timestamp: 1_788_000_000,
    agent_id: "Claude",
    intent: "why this changed",
    ...over,
  };
}

describe("isMechanicalHookCapture", () => {
  test("the row from the screenshot is telemetry", () => {
    // Verbatim shape of what Trace listed as a session.
    const captured = row({
      agent_id: "Claude",
      source: AUTO_CAPTURE_AGENT_ID,
      tool: "Bash",
      intent: "running Bash on bash /private/tmp/claude-501/9e7c366c.sh",
      session_id: "db956db5-3cef-419e-90d5-eaaac3561835",
    });
    expect(isMechanicalHookCapture(captured)).toBe(true);
  });

  test("an old capture that never named an agent is still telemetry", () => {
    // Rows written before the listener learned to pass AURA_AGENT.
    expect(
      isMechanicalHookCapture(
        row({ agent_id: AUTO_CAPTURE_AGENT_ID, intent: "running Read on foo.png" }),
      ),
    ).toBe(true);
  });

  test("a stated reason survives the default source", () => {
    // The whole hazard of filtering on `source` alone: nothing passed
    // `--source`, so a hand-written intent is marked exactly like a capture.
    const stated = row({
      source: AUTO_CAPTURE_AGENT_ID,
      intent:
        "an agent that fills the stderr pipe while we drain stdout deadlocks the runner",
    });
    expect(isMechanicalHookCapture(stated)).toBe(false);
  });

  test("a hook row keeps its place once somebody explains it", () => {
    // `aura snapshot-file --why` left a reason, `log-intent` claimed it, and
    // the sentence the hook would have written moved to `change`. 606 rows in
    // one worktree's log look like this and they are the best material Trace
    // has.
    const claimed = row({
      source: AUTO_CAPTURE_AGENT_ID,
      tool: "Edit",
      intent:
        "sign the console in from the OAuth redirect before React mounts, so the first authenticated render is not a guess",
      change: "Claude Edit on aura-console/src/main.tsx",
    });
    expect(isMechanicalHookCapture(claimed)).toBe(false);
  });

  test("an empty `change` is not an explanation", () => {
    const blank = row({
      source: AUTO_CAPTURE_AGENT_ID,
      tool: "Edit",
      change: "   ",
    });
    expect(isMechanicalHookCapture(blank)).toBe(true);
  });

  test("an end-of-turn summary is not a tool call", () => {
    // The Stop hook writes these with no `tool`. They read as prose and say
    // what the whole turn accomplished.
    const summary = row({
      source: AUTO_CAPTURE_AGENT_ID,
      intent: "agent turn complete: banked queue done, all 6 commits pushed",
    });
    expect(isMechanicalHookCapture(summary)).toBe(false);
  });

  test("a row nobody marked is left alone", () => {
    expect(isMechanicalHookCapture(row())).toBe(false);
    expect(isMechanicalHookCapture(row({ source: "manual", tool: "Edit" }))).toBe(
      false,
    );
  });
});
