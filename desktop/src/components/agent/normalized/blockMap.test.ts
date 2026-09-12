import { describe, expect, test } from "bun:test";

import { toTranscriptGroups } from "./blockMap";
import type { NormalizedEvent } from "../../../lib/agentProtocol";

// This is the only place that turns a normalized timeline into rows, for every
// engine. A defect here shows up as a transcript that is hard to read rather
// than one that throws, so the tests are about shape: what got its own row,
// what stayed inside the prose run, and which prompts still take input.

const base = { sessionId: "s1", ts: 0, source: "agent" as const };

const say = (id: string, text: string): NormalizedEvent => ({
  ...base,
  kind: "text",
  id,
  role: "assistant",
  text,
});

const todo = (id: string, content: string): NormalizedEvent => ({
  ...base,
  kind: "todo",
  id,
  todos: [{ id: "1", content, status: "in_progress" }],
});

const question = (id: string, answer?: string): NormalizedEvent => ({
  ...base,
  kind: "question_set",
  id,
  requestId: id,
  questions: [{ id: "q", prompt: "Which one?", options: [{ optionId: "a", label: "A" }] }],
  ...(answer == null ? {} : { answer }),
});

describe("the checklist is one row, not a scrapbook", () => {
  test("a dozen checklist updates render one checklist", () => {
    const events = Array.from({ length: 12 }, (_, i) => todo(`tu_${i}`, `Step ${i}`));
    const groups = toTranscriptGroups(events);
    expect(groups.filter((g) => g.kind === "todo")).toHaveLength(1);
  });

  test("the checklist shown is the newest one", () => {
    const groups = toTranscriptGroups([todo("tu_1", "Old"), todo("tu_2", "New")]);
    const row = groups.find((g) => g.kind === "todo");
    expect(row && row.kind === "todo" && row.ev.todos[0].content).toBe("New");
  });

  test("a dropped checklist does not chop the prose around it", () => {
    // Superseded snapshots are skipped WITHOUT flushing the open run, so the
    // two sentences stay one bubble instead of three rows with a stale list
    // wedged between them.
    const groups = toTranscriptGroups([
      say("t1", "Starting."),
      todo("tu_1", "Old"),
      say("t2", "Still going."),
      todo("tu_2", "New"),
    ]);
    const streams = groups.filter((g) => g.kind === "stream");
    expect(streams).toHaveLength(1);
    expect(streams[0].kind === "stream" && streams[0].blocks).toHaveLength(2);
  });

  test("the live checklist still breaks the run where it sits", () => {
    const groups = toTranscriptGroups([say("t1", "Starting."), todo("tu_1", "Only")]);
    expect(groups.map((g) => g.kind)).toEqual(["stream", "todo"]);
  });
});

describe("which prompts still take input", () => {
  test("an unanswered question is live", () => {
    const groups = toTranscriptGroups([question("tu_1")]);
    const row = groups.find((g) => g.kind === "question");
    expect(row && row.kind === "question" && row.live).toBe(true);
  });

  test("an answered question is kept but is no longer live", () => {
    // It must stay in the transcript — it is the record of what was asked —
    // but its buttons must not fire a prompt into an agent that moved on.
    const groups = toTranscriptGroups([question("tu_1"), question("tu_1", "A")]);
    const rows = groups.filter((g) => g.kind === "question");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind === "question" && rows[0].live).toBe(false);
  });

  test("an older question goes quiet when a newer one opens", () => {
    const groups = toTranscriptGroups([
      question("tu_1"),
      question("tu_1", "A"),
      say("t1", "Next."),
      question("tu_2"),
    ]);
    const live = groups
      .filter((g) => g.kind === "question")
      .map((g) => (g.kind === "question" ? [g.id, g.live] : null));
    expect(live).toEqual([
      ["tu_1", false],
      ["tu_2", true],
    ]);
  });

  test("an approved plan is kept but is no longer live", () => {
    const plan = (extra: Record<string, unknown>): NormalizedEvent =>
      ({ ...base, kind: "plan", id: "tu_9", entries: [], ...extra }) as NormalizedEvent;
    const groups = toTranscriptGroups([
      plan({ markdown: "Do the thing", awaitingApproval: true }),
      plan({ awaitingApproval: false, decision: "approved" }),
    ]);
    const rows = groups.filter((g) => g.kind === "plan");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind === "plan" && rows[0].live).toBe(false);
    expect(rows[0].kind === "plan" && rows[0].ev.markdown).toBe("Do the thing");
  });

  test("a permission prompt goes quiet once its call has run", () => {
    const call = (status: "pending" | "completed"): NormalizedEvent => ({
      ...base,
      kind: "tool_call",
      id: "call_1",
      callId: "call_1",
      toolKind: "execute",
      status,
      toolName: "Bash",
      title: "Run tests",
      input: {},
    });
    const groups = toTranscriptGroups([
      call("pending"),
      {
        ...base,
        kind: "permission_request",
        id: "perm_1",
        requestId: "perm_1",
        callId: "call_1",
        toolName: "Bash",
        input: {},
        title: "Run tests",
        options: [],
      },
      call("completed"),
    ]);
    const row = groups.find((g) => g.kind === "permission");
    expect(row && row.kind === "permission" && row.live).toBe(false);
  });
});

describe("runs, rows and token accounting", () => {
  test("prose, thinking and tools stay one bubble", () => {
    const groups = toTranscriptGroups([
      { ...base, kind: "reasoning", id: "r1", text: "Hmm." },
      say("t1", "Here goes."),
      {
        ...base,
        kind: "tool_call",
        id: "c1",
        callId: "c1",
        toolKind: "execute",
        status: "completed",
        toolName: "Bash",
        title: "ls",
        input: { command: "ls" },
        output: "a\nb",
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind === "stream" && groups[0].blocks.map((b) => b.kind)).toEqual([
      "reasoning",
      "text",
      "tool",
    ]);
  });

  test("a user message breaks the run", () => {
    const groups = toTranscriptGroups([
      say("t1", "Done."),
      { ...base, kind: "text", id: "u1", role: "user", text: "Now deploy." },
      say("t2", "On it."),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["stream", "user", "stream"]);
  });

  test("usage folds as max context and summed output", () => {
    const groups = toTranscriptGroups([
      say("t1", "Working."),
      { ...base, kind: "usage", id: "m1", contextTokens: 1000, outputTokens: 20 },
      { ...base, kind: "usage", id: "m2", contextTokens: 1400, outputTokens: 30 },
    ]);
    expect(groups[0].kind === "stream" && groups[0].usage).toEqual({
      context: 1400,
      output: 50,
    });
  });

  test("usage with nothing to attach to shows no row", () => {
    const groups = toTranscriptGroups([
      { ...base, kind: "usage", id: "m1", contextTokens: 10, outputTokens: 1 },
    ]);
    expect(groups).toEqual([]);
  });

  test("a tool call still running carries no result yet", () => {
    const groups = toTranscriptGroups([
      {
        ...base,
        kind: "tool_call",
        id: "c1",
        callId: "c1",
        toolKind: "execute",
        status: "running",
        toolName: "Bash",
        title: "bun test",
        input: { command: "bun test" },
      },
    ]);
    const block = groups[0].kind === "stream" ? groups[0].blocks[0] : null;
    expect(block?.kind === "tool" && block.result).toBeUndefined();
  });
});
