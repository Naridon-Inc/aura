import { describe, expect, test } from "bun:test";

import { reduceEvents } from "./reduce";
import type {
  NormalizedEvent,
  PermissionRequestEvent,
  PlanEvent,
  QuestionSetEvent,
  ToolCallEvent,
} from "./events";

// The reducer decides what the chat treats as STILL WAITING on the human.
// Getting that wrong is not a crash — it is a transcript full of questions
// that all look like they need answering, and a plan stuck at "awaiting your
// go-ahead" an hour after it was approved.

const base = { sessionId: "s1", ts: 0, source: "agent" as const };

const question = (
  id: string,
  extra: Partial<QuestionSetEvent> = {},
): QuestionSetEvent => ({
  ...base,
  kind: "question_set",
  id,
  requestId: id,
  questions: [
    { id: "q0", prompt: "Which store?", options: [{ optionId: "a", label: "Postgres" }] },
  ],
  ...extra,
});

const plan = (id: string, extra: Partial<PlanEvent> = {}): PlanEvent => ({
  ...base,
  kind: "plan",
  id,
  entries: [],
  markdown: "1. Move the reader\n2. Delete the shim",
  awaitingApproval: true,
  ...extra,
});

const tool = (callId: string, status: ToolCallEvent["status"]): ToolCallEvent => ({
  ...base,
  kind: "tool_call",
  id: callId,
  callId,
  toolKind: "execute",
  status,
  toolName: "Bash",
  title: "Running tests",
  input: { command: "bun test" },
});

const permission = (
  id: string,
  callId?: string,
): PermissionRequestEvent => ({
  ...base,
  kind: "permission_request",
  id,
  requestId: id,
  callId,
  toolName: "Bash",
  input: {},
  title: "Run bun test",
  options: [],
});

describe("what the agent is still waiting on", () => {
  test("an unanswered question is what the agent is blocked on", () => {
    const t = reduceEvents([question("tu_1")]);
    expect(t.pendingQuestions?.id).toBe("tu_1");
  });

  test("an answered question stops being pending", () => {
    // The engine reports the answer as a same-id update. Before this, every
    // question ever asked stayed pending for the life of the session.
    const t = reduceEvents([
      question("tu_1"),
      { ...question("tu_1"), questions: [], answer: "Postgres" },
    ]);
    expect(t.pendingQuestions).toBeNull();
  });

  test("the answer does not blank the questions it answered", () => {
    // The settle update carries only what it learned, so a wholesale replace
    // would leave a card with no question on it.
    const t = reduceEvents([
      question("tu_1"),
      { ...question("tu_1"), questions: [], answer: "Postgres" },
    ]);
    const q = t.events.find((e): e is QuestionSetEvent => e.kind === "question_set");
    expect(q?.questions).toHaveLength(1);
    expect(q?.questions[0].prompt).toBe("Which store?");
    expect(q?.answer).toBe("Postgres");
  });

  test("a newer unanswered question replaces an older answered one", () => {
    const t = reduceEvents([
      question("tu_1"),
      { ...question("tu_1"), questions: [], answer: "Postgres" },
      question("tu_2"),
    ]);
    expect(t.pendingQuestions?.id).toBe("tu_2");
  });

  test("an approved plan stops awaiting approval and keeps its body", () => {
    const t = reduceEvents([
      plan("tu_9"),
      {
        ...plan("tu_9"),
        entries: [],
        markdown: undefined,
        awaitingApproval: false,
        decision: "approved",
      },
    ]);
    expect(t.pendingPlan).toBeNull();
    const p = t.events.find((e): e is PlanEvent => e.kind === "plan");
    expect(p?.decision).toBe("approved");
    expect(p?.markdown).toContain("Delete the shim");
  });

  test("a permission prompt clears once the call it gated has run", () => {
    // No engine reports "the human answered the permission prompt". The tool
    // call leaving `pending` is that signal, and it is the honest one.
    const t = reduceEvents([
      tool("call_1", "pending"),
      permission("perm_1", "call_1"),
      tool("call_1", "completed"),
    ]);
    expect(t.pendingPermission).toBeNull();
  });

  test("a permission prompt on a call that has not run is still pending", () => {
    const t = reduceEvents([tool("call_1", "pending"), permission("perm_1", "call_1")]);
    expect(t.pendingPermission?.id).toBe("perm_1");
  });

  test("a permission prompt tied to no call stays pending", () => {
    const t = reduceEvents([permission("perm_1")]);
    expect(t.pendingPermission?.id).toBe("perm_1");
  });
});

describe("collapsing updates onto one event", () => {
  test("a tool call and its result are one entry, not two", () => {
    const t = reduceEvents([
      tool("call_1", "pending"),
      { ...tool("call_1", "completed"), output: "3 passed", title: "" },
    ]);
    const calls = t.events.filter((e) => e.kind === "tool_call");
    expect(calls).toHaveLength(1);
    const c = calls[0] as ToolCallEvent;
    expect(c.status).toBe("completed");
    expect(c.output).toBe("3 passed");
    // The result carries no title of its own; the request's must survive.
    expect(c.title).toBe("Running tests");
  });

  test("a still-running call is what the working affordance reads", () => {
    const t = reduceEvents([tool("call_1", "running"), tool("call_2", "completed")]);
    expect(t.activeToolCalls.map((c) => c.callId)).toEqual(["call_1"]);
  });

  test("the newest checklist is the live one", () => {
    const todo = (id: string, content: string): NormalizedEvent => ({
      ...base,
      kind: "todo",
      id,
      todos: [{ id: "1", content, status: "pending" }],
    });
    const t = reduceEvents([todo("tu_1", "First"), todo("tu_2", "Second")]);
    expect(t.todos?.id).toBe("tu_2");
  });

  test("first-appearance order survives a late update", () => {
    const t = reduceEvents([
      tool("call_1", "pending"),
      { ...base, kind: "text", id: "t1", role: "assistant", text: "Done." } as NormalizedEvent,
      tool("call_1", "completed"),
    ]);
    expect(t.events.map((e) => e.kind)).toEqual(["tool_call", "text"]);
  });
});
