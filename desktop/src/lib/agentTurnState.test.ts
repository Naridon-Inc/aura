import { describe, expect, test } from "bun:test";

import type { CliAgentEvent } from "./api";
import {
  TURN_QUIET_MS,
  initialTurn,
  reduceTurn,
  settleTurn,
  turnWentQuiet,
  type TurnState,
} from "./agentTurnState";

const ev = (event: string, extra: Partial<CliAgentEvent> = {}): CliAgentEvent => ({
  v: 1,
  agent: "claude",
  event,
  ...extra,
});

/** Run a script of `[ms, event]` pairs through the reducer. */
function run(steps: Array<[number, CliAgentEvent]>, from = initialTurn()): TurnState {
  return steps.reduce((s, [at, e]) => reduceTurn(s, e, at), from);
}

describe("a turn's edges", () => {
  test("a prompt opens a turn and stamps when it began", () => {
    const s = run([[1_000, ev("prompt_submit")]]);
    expect(s.status.kind).toBe("in_progress");
    expect(s.startedAt).toBe(1_000);
  });

  test("stop closes the turn and clears the start", () => {
    const s = run([
      [1_000, ev("prompt_submit")],
      [9_000, ev("stop", { response: "done" })],
    ]);
    expect(s.status).toEqual({ kind: "success", query: undefined, response: "done" });
    expect(s.startedAt).toBeNull();
  });

  test("tools inside a turn keep its original start", () => {
    const s = run([
      [1_000, ev("prompt_submit")],
      [2_000, ev("pre_tool_use", { tool_name: "Bash" })],
      [5_000, ev("tool_complete", { tool_name: "Bash" })],
    ]);
    expect(s.status.kind).toBe("in_progress");
    expect(s.startedAt).toBe(1_000);
    expect(s.lastEventAt).toBe(5_000);
  });

  test("a follow-up typed mid-turn does not restart the timer", () => {
    const s = run([
      [1_000, ev("prompt_submit")],
      [4_000, ev("prompt_submit")],
    ]);
    expect(s.startedAt).toBe(1_000);
  });

  test("the next prompt after a finished turn starts a fresh count", () => {
    const s = run([
      [1_000, ev("prompt_submit")],
      [2_000, ev("stop")],
      [7_000, ev("prompt_submit")],
    ]);
    expect(s.startedAt).toBe(7_000);
  });
});

describe("waiting on the user", () => {
  test("a permission prompt parks the turn without ending it", () => {
    const s = run([
      [1_000, ev("prompt_submit")],
      [2_000, ev("permission_request", { tool_name: "Bash" })],
    ]);
    expect(s.status).toEqual({ kind: "blocked", summary: "Wants to run Bash" });
    expect(s.startedAt).toBe(1_000);
  });

  test("the tool finishing means the prompt was answered — same turn resumes", () => {
    const s = run([
      [1_000, ev("prompt_submit")],
      [2_000, ev("permission_request", { tool_name: "Bash" })],
      [6_000, ev("tool_complete", { tool_name: "Bash" })],
    ]);
    expect(s.status.kind).toBe("in_progress");
    expect(s.startedAt).toBe(1_000);
  });

  test("another tool starting does not clear a pending permission prompt", () => {
    const s = run([
      [1_000, ev("prompt_submit")],
      [2_000, ev("permission_request", { tool_name: "Bash" })],
      [2_100, ev("pre_tool_use", { tool_name: "Bash" })],
    ]);
    expect(s.status.kind).toBe("blocked");
  });

  test("the idle nudge comes after a turn has ended", () => {
    const s = run([
      [1_000, ev("prompt_submit")],
      [2_000, ev("stop")],
      [62_000, ev("idle_prompt")],
    ]);
    expect(s.status).toEqual({ kind: "blocked", summary: "Input needed" });
    expect(s.startedAt).toBeNull();
  });
});

describe("a turn we joined late", () => {
  test("a tool starting while we think the agent is idle opens a turn", () => {
    // The app restarted under a live session: the prompt fired before we
    // were listening, and the first thing we hear is a tool.
    const s = run([[3_000, ev("pre_tool_use", { tool_name: "Read" })]]);
    expect(s.status.kind).toBe("in_progress");
    expect(s.startedAt).toBe(3_000);
  });

  test("so does a tool finishing after the last turn was closed", () => {
    const s = run([
      [1_000, ev("prompt_submit")],
      [2_000, ev("stop")],
      [9_000, ev("tool_complete", { tool_name: "Edit" })],
    ]);
    expect(s.status.kind).toBe("in_progress");
    expect(s.startedAt).toBe(9_000);
  });

  test("session start and unknown events leave the status alone", () => {
    const open = run([[1_000, ev("prompt_submit")]]);
    const s = run(
      [
        [2_000, ev("session_start")],
        [3_000, ev("something_new")],
      ],
      open,
    );
    expect(s.status.kind).toBe("in_progress");
    expect(s.startedAt).toBe(1_000);
  });
});

describe("a turn that ended without saying so", () => {
  const open = run([[1_000, ev("prompt_submit")]]);
  const quiet = { idle_ms: TURN_QUIET_MS, alive: true };

  test("hooks and terminal both silent: the turn is over (Escape runs no Stop hook)", () => {
    expect(turnWentQuiet(open, quiet, 1_000 + TURN_QUIET_MS)).toBe(true);
  });

  test("a terminal still drawing its spinner is still working, however long the command", () => {
    expect(turnWentQuiet(open, { idle_ms: 120, alive: true }, 1_000 + 300_000)).toBe(false);
  });

  test("a turn that has only just opened is never judged by an old silence", () => {
    // The PTY may have been idle for minutes before the prompt landed; the
    // spinner simply has not drawn yet.
    expect(turnWentQuiet(open, { idle_ms: 600_000, alive: true }, 1_500)).toBe(false);
  });

  test("a dead process ends its turn at once", () => {
    expect(turnWentQuiet(open, { idle_ms: 0, alive: false }, 1_100)).toBe(true);
  });

  test("a turn parked on a permission prompt is meant to be silent", () => {
    const parked = reduceTurn(open, ev("permission_request"), 2_000);
    expect(turnWentQuiet(parked, quiet, 2_000 + TURN_QUIET_MS * 10)).toBe(false);
  });

  test("an idle agent is never judged", () => {
    expect(turnWentQuiet(initialTurn(), quiet, 60_000)).toBe(false);
  });

  test("settling closes an open turn and leaves anything else untouched", () => {
    const settled = settleTurn(open);
    expect(settled.status.kind).toBe("idle");
    expect(settled.startedAt).toBeNull();

    const parked = reduceTurn(open, ev("permission_request"), 2_000);
    expect(settleTurn(parked)).toBe(parked);
    const done = reduceTurn(open, ev("stop"), 2_000);
    expect(settleTurn(done)).toBe(done);
  });
});
