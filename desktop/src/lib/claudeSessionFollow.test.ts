import { describe, expect, test } from "bun:test";
import {
  followClaudeSession,
  followDecision,
  forgetTranscriptSession,
  needsReplay,
  NO_BINDING,
  noteTranscriptSession,
  transcriptSessionOf,
  type ChatBinding,
} from "./claudeSessionFollow";
import type { LiveClaudeSession } from "./api";

const oldThread: ChatBinding = {
  sessionId: "96fec09e",
  filePath: "/p/96fec09e.jsonl",
};

describe("followDecision", () => {
  test("the CLI running /resume moves the chat to the resumed conversation", () => {
    expect(
      followDecision(oldThread, {
        session_id: "3518ab13",
        file_path: "/p/3518ab13.jsonl",
      }),
    ).toEqual({ sessionId: "3518ab13", filePath: "/p/3518ab13.jsonl" });
  });

  test("/clear moves the chat to an empty conversation, then onto its file", () => {
    const cleared = followDecision(oldThread, {
      session_id: "fresh",
      file_path: null,
    });
    expect(cleared).toEqual({ sessionId: "fresh", filePath: null });
    // Claude writes the transcript with the first prompt after /clear.
    expect(
      followDecision(cleared!, { session_id: "fresh", file_path: "/p/fresh.jsonl" }),
    ).toEqual({ sessionId: "fresh", filePath: "/p/fresh.jsonl" });
  });

  test("the same conversation is not a move", () => {
    expect(
      followDecision(oldThread, {
        session_id: "96fec09e",
        file_path: "/p/96fec09e.jsonl",
      }),
    ).toBeNull();
    // Nor is the file briefly failing to resolve.
    expect(
      followDecision(oldThread, { session_id: "96fec09e", file_path: null }),
    ).toBeNull();
  });

  test("no answer from the CLI keeps whatever the chat has", () => {
    expect(followDecision(oldThread, null)).toBeNull();
    expect(followDecision(NO_BINDING, null)).toBeNull();
  });

  test("an unbound tab binds to the first conversation the CLI reports", () => {
    expect(
      followDecision(NO_BINDING, { session_id: "a", file_path: "/p/a.jsonl" }),
    ).toEqual({ sessionId: "a", filePath: "/p/a.jsonl" });
  });
});

describe("needsReplay", () => {
  test("an empty channel is always filled", () => {
    expect(needsReplay(0, undefined, "a")).toBe(true);
    expect(needsReplay(0, "a", "a")).toBe(true);
  });

  test("a channel holding this conversation is kept", () => {
    expect(needsReplay(12, "a", "a")).toBe(false);
  });

  test("a channel holding another conversation is replaced", () => {
    // The reported bug: the chat kept the pre-/resume thread because the
    // channel was not empty.
    expect(needsReplay(12, "96fec09e", "3518ab13")).toBe(true);
  });

  test("a channel of unknown origin is kept, as before", () => {
    expect(needsReplay(12, undefined, "a")).toBe(false);
  });
});

describe("transcript channel ownership", () => {
  test("is remembered per channel and forgotten on close", () => {
    const ch = "claude@/r_tab-ownership";
    expect(transcriptSessionOf(ch)).toBeUndefined();
    noteTranscriptSession(ch, "a");
    noteTranscriptSession(ch, "b");
    expect(transcriptSessionOf(ch)).toBe("b");
    forgetTranscriptSession(ch);
    expect(transcriptSessionOf(ch)).toBeUndefined();
  });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("followClaudeSession", () => {
  test("follows /resume then /clear typed into the CLI, once each", async () => {
    const answers: (LiveClaudeSession | null)[] = [
      { session_id: "96fec09e", file_path: "/p/96fec09e.jsonl" },
      { session_id: "3518ab13", file_path: "/p/3518ab13.jsonl" },
      { session_id: "3518ab13", file_path: "/p/3518ab13.jsonl" },
      null,
      { session_id: "fresh", file_path: null },
      { session_id: "fresh", file_path: "/p/fresh.jsonl" },
    ];
    let asked = 0;
    const moves: ChatBinding[] = [];
    const stop = followClaudeSession({
      initial: oldThread,
      probe: async () => answers[Math.min(asked++, answers.length - 1)],
      rebind: async (next) => {
        moves.push(next);
      },
      intervalMs: 2,
    });
    for (let i = 0; i < 200 && asked < answers.length + 2; i++) await wait(2);
    stop();
    expect(moves).toEqual([
      { sessionId: "3518ab13", filePath: "/p/3518ab13.jsonl" },
      { sessionId: "fresh", filePath: null },
      { sessionId: "fresh", filePath: "/p/fresh.jsonl" },
    ]);
  });

  test("a move that fails is retried, and stopping ends the asking", async () => {
    let asked = 0;
    let attempts = 0;
    const moved: ChatBinding[] = [];
    const stop = followClaudeSession({
      initial: oldThread,
      probe: async () => {
        asked++;
        return { session_id: "3518ab13", file_path: "/p/3518ab13.jsonl" };
      },
      rebind: async (next) => {
        attempts++;
        if (attempts === 1) throw new Error("transcript locked");
        moved.push(next);
      },
      intervalMs: 2,
    });
    for (let i = 0; i < 200 && moved.length === 0; i++) await wait(2);
    expect(attempts).toBe(2);
    expect(moved).toHaveLength(1);
    stop();
    const askedAtStop = asked;
    await wait(20);
    expect(asked).toBe(askedAtStop);
  });
});
