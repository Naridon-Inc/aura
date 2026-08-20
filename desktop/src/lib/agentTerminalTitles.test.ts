import { describe, expect, test } from "bun:test";

import {
  cleanTerminalTitle,
  clearAgentTerminalTitle,
  getAgentTerminalTitle,
  noteAgentTerminalTitle,
} from "./agentTerminalTitles";

// This title comes off a PTY, so it is whatever the agent felt like writing.
// These pin the four ways that ends up on a tab as something worse than the
// label it replaced.

describe("cleaning what the terminal said", () => {
  test("Claude's startup title loses its brand glyph", () => {
    expect(cleanTerminalTitle("✳ Claude Code")).toBe("Claude Code");
  });

  test("a real subject survives intact", () => {
    expect(cleanTerminalTitle("✳ fixing the retry backoff")).toBe(
      "fixing the retry backoff",
    );
  });

  test("control bytes never reach the pill", () => {
    expect(cleanTerminalTitle("a\u0000b\u001bc\u007f")).toBe("a b c");
  });

  test("a title that is only a marker is declined, not stored empty", () => {
    expect(cleanTerminalTitle("✳")).toBeNull();
    expect(cleanTerminalTitle("   ")).toBeNull();
  });

  test("a shell's cwd is not a subject", () => {
    expect(cleanTerminalTitle("/Users/x/code/aura")).toBeNull();
    expect(cleanTerminalTitle("~/code/aura")).toBeNull();
  });

  test("a runaway title is cut, not left to stretch the strip", () => {
    const out = cleanTerminalTitle("x".repeat(400));
    expect(out).not.toBeNull();
    expect(out!.length).toBe(72);
    expect(out!.endsWith("…")).toBe(true);
  });
});

describe("the store", () => {
  test("a declined title leaves the last good one standing", () => {
    const id = "sess-decline";
    noteAgentTerminalTitle(id, "✳ writing the migration");
    noteAgentTerminalTitle(id, "   ");
    expect(getAgentTerminalTitle(id)).toBe("writing the migration");
    clearAgentTerminalTitle(id);
  });

  test("closing the tab forgets the title", () => {
    const id = "sess-close";
    noteAgentTerminalTitle(id, "reviewing the diff");
    expect(getAgentTerminalTitle(id)).toBe("reviewing the diff");
    clearAgentTerminalTitle(id);
    expect(getAgentTerminalTitle(id)).toBeUndefined();
  });
});
