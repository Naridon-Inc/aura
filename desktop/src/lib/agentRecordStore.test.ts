import { describe, expect, test } from "bun:test";

import { capRecords, hasAgentRecord, settleStreaming } from "./agentRecordStore";

// Codex, Kimi, OpenCode and Pi write their conversation to a file and the chat
// tails it. That file only grows, and the transcript re-normalizes the whole
// accumulated array on every poll — so an unbounded store is quadratic work on
// exactly the sessions that run longest. Pi is the sharp case: it streams
// per-token updates, so records arrive in the thousands.

const many = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
const at = (rows: unknown[], i: number) => (rows[i] as { i: number }).i;

describe("keeping a long session bounded", () => {
  test("a short session is left exactly as it is", () => {
    const rows = many(500);
    expect(capRecords(rows)).toBe(rows);
  });

  test("a long session is capped", () => {
    expect(capRecords(many(12_000))).toHaveLength(4000);
  });

  test("the newest records are the ones kept", () => {
    const capped = capRecords(many(12_000));
    expect(at(capped, capped.length - 1)).toBe(11_999);
  });

  test("the session handshake survives, which is the whole point", () => {
    // Every one of these engines writes its session header FIRST — the model,
    // the cwd, the session id — and nothing repeats it later. Trimming purely
    // from the front deleted it, and the transcript lost its session card and
    // the name of the model that ran.
    const capped = capRecords(many(12_000));
    expect(at(capped, 0)).toBe(0);
    expect(at(capped, 31)).toBe(31);
  });

  test("the hole is in the middle, not at either end", () => {
    const capped = capRecords(many(12_000));
    expect(at(capped, 32)).toBeGreaterThan(32);
  });

  test("capping twice changes nothing further", () => {
    const once = capRecords(many(12_000));
    expect(capRecords(once)).toBe(once);
  });

  test("a session sitting exactly on the cap is untouched", () => {
    const rows = many(4000);
    expect(capRecords(rows)).toBe(rows);
  });
});

describe("which engines are read from a file at all", () => {
  test("the four that paint a TUI and write their own record", () => {
    for (const id of ["codex", "kimi", "opencode", "pi"]) {
      expect(hasAgentRecord(id)).toBe(true);
    }
  });

  test("an engine that streams over the wire is read from the PTY", () => {
    // Claude streams its structure over the stream-json wire, so tailing a
    // file for it would be a second, conflicting source of the same events.
    expect(hasAgentRecord("claude")).toBe(false);
    expect(hasAgentRecord("gemini")).toBe(false);
    expect(hasAgentRecord("some-toml-agent")).toBe(false);
  });
});

// The busy flag. These four engines say nothing over the wire, so their record
// growing is the ONLY evidence that a turn is in flight — and the chat needs
// that evidence, because the Stop button only exists while the agent is
// working. Before this the flag never went true for them and the button never
// appeared at all.
describe("whether a file-backed agent is mid-turn", () => {
  const idle = { streaming: false, quietReads: 3 };

  test("one new record starts the turn", () => {
    expect(settleStreaming(idle, 1)).toEqual({ streaming: true, quietReads: 0 });
  });

  test("a pause inside a turn does not end it", () => {
    // A tool running, or a model thinking, is a quiet read — and ending the
    // turn there would make Stop blink out from under the cursor.
    let s = settleStreaming(idle, 4);
    s = settleStreaming(s, 0);
    expect(s.streaming).toBe(true);
    s = settleStreaming(s, 0);
    expect(s.streaming).toBe(true);
  });

  test("three quiet reads in a row end it", () => {
    let s = settleStreaming(idle, 4);
    for (let i = 0; i < 3; i++) s = settleStreaming(s, 0);
    expect(s.streaming).toBe(false);
  });

  test("output landing in the middle of the wait resets the count", () => {
    let s = settleStreaming(idle, 4);
    s = settleStreaming(s, 0);
    s = settleStreaming(s, 0);
    s = settleStreaming(s, 2); // the agent spoke again
    expect(s).toEqual({ streaming: true, quietReads: 0 });
    s = settleStreaming(s, 0);
    expect(s.streaming).toBe(true);
  });

  test("an agent that has never run stays quiet however long we wait", () => {
    let s = idle;
    for (let i = 0; i < 20; i++) s = settleStreaming(s, 0);
    expect(s.streaming).toBe(false);
  });

  test("it never ends a turn on the same read that fed it", () => {
    const s = settleStreaming({ streaming: true, quietReads: 99 }, 1);
    expect(s.streaming).toBe(true);
  });
});
