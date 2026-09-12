import { describe, expect, test } from "bun:test";

import type { StreamEvent } from "@shared/streamEvent";

import { normalizeClaude } from "./claude";
import { reduceEvents } from "../reduce";
import type {
  NormalizedEvent,
  PlanEvent,
  QuestionSetEvent,
  TodoEvent,
  ToolCallEvent,
} from "../events";

// Claude Code routes its three interactive surfaces — AskUserQuestion,
// ExitPlanMode, TodoWrite — through ordinary tool calls. So the chat's
// question card, plan card and checklist are all built out of tool traffic,
// and the tool RESULT is the only place the engine says what the human chose.

const T = "turn_1";

const use = (id: string, name: string, input: unknown): StreamEvent => ({
  kind: "tool_use",
  id,
  name,
  input,
  turn_id: T,
});

const result = (id: string, content: string, isError = false): StreamEvent => ({
  kind: "tool_result",
  tool_use_id: id,
  content,
  is_error: isError,
  turn_id: T,
});

const run = (events: StreamEvent[]): NormalizedEvent[] => normalizeClaude(events, "s1");

const only = <K extends NormalizedEvent["kind"]>(out: NormalizedEvent[], kind: K) =>
  out.filter((e) => e.kind === kind) as Extract<NormalizedEvent, { kind: K }>[];

describe("a question the human answered", () => {
  const ask = use("tu_1", "AskUserQuestion", {
    questions: [
      {
        header: "Store",
        question: "Which store should the cache use?",
        options: [{ label: "Postgres" }, { label: "Redis" }],
      },
    ],
  });

  test("the request becomes a question set with its options", () => {
    const qs = only(run([ask]), "question_set");
    expect(qs).toHaveLength(1);
    expect(qs[0].questions[0].prompt).toBe("Which store should the cache use?");
    expect(qs[0].questions[0].options?.map((o) => o.label)).toEqual(["Postgres", "Redis"]);
  });

  test("the result carries the answer back on the same id", () => {
    // Same id is what makes it an update rather than a second card.
    const qs = only(run([ask, result("tu_1", "Postgres")]), "question_set");
    expect(qs).toHaveLength(2);
    expect(qs[1].id).toBe(qs[0].id);
    expect(qs[1].answer).toBe("Postgres");
  });

  test("reduced, it is one settled card the agent is no longer blocked on", () => {
    const t = reduceEvents(run([ask, result("tu_1", "Postgres")]));
    const qs = t.events.filter((e): e is QuestionSetEvent => e.kind === "question_set");
    expect(qs).toHaveLength(1);
    expect(qs[0].questions).toHaveLength(1);
    expect(qs[0].answer).toBe("Postgres");
    expect(t.pendingQuestions).toBeNull();
  });

  test("an unanswered question is still what the agent waits on", () => {
    expect(reduceEvents(run([ask])).pendingQuestions?.id).toBe("tu_1");
  });

  test("the answer is never mistaken for a tool card", () => {
    expect(only(run([ask, result("tu_1", "Postgres")]), "tool_call")).toHaveLength(0);
  });
});

describe("a plan the human ruled on", () => {
  const propose = use("tu_2", "ExitPlanMode", { plan: "1. Move the reader\n2. Drop the shim" });

  test("the proposal awaits approval", () => {
    const plans = only(run([propose]), "plan");
    expect(plans[0].awaitingApproval).toBe(true);
    expect(plans[0].markdown).toContain("Move the reader");
  });

  test("approval settles the card and keeps the plan body", () => {
    const t = reduceEvents(run([propose, result("tu_2", "User approved the plan")]));
    const plans = t.events.filter((e): e is PlanEvent => e.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0].awaitingApproval).toBe(false);
    expect(plans[0].decision).toBe("approved");
    expect(plans[0].markdown).toContain("Drop the shim");
    expect(t.pendingPlan).toBeNull();
  });

  test("a rejected plan is settled too, and says so", () => {
    const t = reduceEvents(run([propose, result("tu_2", "User rejected the plan", true)]));
    const plans = t.events.filter((e): e is PlanEvent => e.kind === "plan");
    expect(plans[0].decision).toBe("rejected");
    expect(t.pendingPlan).toBeNull();
  });
});

describe("the checklist", () => {
  const write = (id: string, content: string) =>
    use(id, "TodoWrite", { todos: [{ content, status: "in_progress" }] });

  test("each write is a checklist, and its result is not a tool card", () => {
    const out = run([write("tu_3", "Write the tests"), result("tu_3", "Todos updated")]);
    expect(only(out, "todo")).toHaveLength(1);
    expect(only(out, "tool_call")).toHaveLength(0);
  });

  test("successive writes leave the newest as the live one", () => {
    const out = run([
      write("tu_3", "First"),
      result("tu_3", "ok"),
      write("tu_4", "Second"),
      result("tu_4", "ok"),
    ]);
    const t = reduceEvents(out);
    expect((t.todos as TodoEvent).todos[0].content).toBe("Second");
  });
});

describe("ordinary tool traffic is unaffected", () => {
  test("a call and its result fold into one completed card", () => {
    const t = reduceEvents(
      run([use("tu_5", "Bash", { command: "bun test" }), result("tu_5", "12 pass")]),
    );
    const calls = t.events.filter((e): e is ToolCallEvent => e.kind === "tool_call");
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe("completed");
    expect(calls[0].output).toBe("12 pass");
  });

  test("a failing call is marked, not dropped", () => {
    const t = reduceEvents(
      run([use("tu_6", "Bash", { command: "false" }), result("tu_6", "exit 1", true)]),
    );
    const calls = t.events.filter((e): e is ToolCallEvent => e.kind === "tool_call");
    expect(calls[0].status).toBe("error");
    expect(calls[0].isError).toBe(true);
  });

  test("a result with no request still renders rather than vanishing", () => {
    // Happens on a resumed session whose history starts mid-turn.
    const calls = only(run([result("tu_7", "stray output")]), "tool_call");
    expect(calls).toHaveLength(1);
    expect(calls[0].output).toBe("stray output");
  });
});
