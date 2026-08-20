import { describe, expect, test } from "bun:test";

import { normalizeKimi } from "./kimi";
import { normalizeStream } from "../index";
import type { NormalizedEvent, TextEvent, ToolCallEvent } from "../events";

// The cases below are the shapes a real wire actually contains, measured
// against `~/.kimi-code/sessions/**/agents/main/wire.jsonl` across ten
// sessions. Kimi writes several things twice — every prompt is also an
// appended message, token counts land on both `step.end` and `usage.record` —
// and it writes a lot that is not chat at all. Getting those wrong doesn't
// throw; it renders the conversation twice, or renders the context Kimi fed
// itself as if the user had typed it.

const rec = (type: string, body: Record<string, unknown> = {}) => ({
  type,
  time: 1,
  ...body,
});

/** Most of the conversation rides inside a loop event, where `event.type` is
 *  the real discriminator. */
const loop = (type: string, event: Record<string, unknown> = {}) =>
  rec("context.append_loop_event", { event: { type, ...event } });

const texts = (out: NormalizedEvent[]) =>
  out.filter((e): e is TextEvent => e.kind === "text");

const tools = (out: NormalizedEvent[]) =>
  out.filter((e): e is ToolCallEvent => e.kind === "tool_call");

describe("reading a Kimi wire as a conversation", () => {
  test("a prompt written twice is rendered once", () => {
    // Measured: 9 `turn.prompt` records and 9 `context.append_message` with
    // role user, duplicating them exactly. Consuming both is the difference
    // between a chat and an echo.
    const out = normalizeKimi(
      [
        rec("turn.prompt", { input: [{ type: "text", text: "fix the retry loop" }], origin: { kind: "user" } }),
        rec("context.append_message", {
          message: {
            role: "user",
            content: [{ type: "text", text: "fix the retry loop" }],
            origin: { kind: "user" },
          },
        }),
      ],
      "s1",
    );
    expect(texts(out).map((t) => t.text)).toEqual(["fix the retry loop"]);
  });

  test("context Kimi fed itself is not something the user said", () => {
    const out = normalizeKimi(
      [
        rec("context.append_message", {
          message: {
            role: "user",
            content: [{ type: "text", text: "<AGENTS.md>…</AGENTS.md>" }],
            origin: { kind: "injection" },
          },
        }),
        rec("turn.prompt", { input: [{ type: "text", text: "hi" }] }),
      ],
      "s1",
    );
    expect(texts(out).map((t) => t.text)).toEqual(["hi"]);
  });

  test("a session that only appends messages still shows the answer", () => {
    // Older Kimi builds wrote assistant prose only as an appended message.
    // Skipping it unconditionally would leave those sessions with an empty
    // chat and no error to explain why.
    const out = normalizeKimi(
      [
        rec("context.append_message", {
          message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
        }),
      ],
      "s1",
    );
    expect(texts(out).map((t) => t.text)).toEqual(["Done."]);
  });

  test("a session that streams parts does not also render the appended copy", () => {
    const out = normalizeKimi(
      [
        loop("content.part", { part: { type: "text", text: "Done." } }),
        rec("context.append_message", {
          message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
        }),
      ],
      "s1",
    );
    expect(texts(out).map((t) => t.text)).toEqual(["Done."]);
  });

  test("tool results are cards, not a third voice in the chat", () => {
    // Kimi appends every tool result as a `role: "tool"` message as well as
    // emitting `tool.result`. Rendering both puts raw stdout in the transcript
    // as if someone had said it.
    const out = normalizeKimi(
      [
        rec("context.append_message", {
          message: { role: "tool", content: [{ type: "text", text: "a\nb" }] },
        }),
      ],
      "s1",
    );
    expect(texts(out)).toHaveLength(0);
  });

  test("a tool call and its result are one card", () => {
    const out = normalizeKimi(
      [
        loop("tool.call", {
          toolCallId: "c1",
          name: "Bash",
          args: { command: "ls -la" },
          display: { kind: "command", command: "ls -la", cwd: "/repo" },
        }),
        loop("tool.result", { toolCallId: "c1", result: { output: "a\nb" } }),
      ],
      "s1",
    );
    const cards = tools(out);
    expect(cards).toHaveLength(2);
    // Same id = the reducer folds the result onto the request in place.
    expect(cards[0]!.id).toBe(cards[1]!.id);
    expect(cards[0]!.status).toBe("running");
    expect(cards[1]!.status).toBe("completed");
    expect(cards[1]!.output).toBe("a\nb");
    expect(cards[0]!.title).toBe("Running ls -la");
    expect(cards[0]!.toolKind).toBe("execute");
    // `display` carries the cwd Kimi resolved; the raw args do not.
    expect(cards[0]!.input.cwd).toBe("/repo");
  });

  test("a failed tool settles as an error", () => {
    const out = normalizeKimi(
      [
        loop("tool.call", { toolCallId: "c1", name: "Bash", args: { command: "npm test" } }),
        loop("tool.result", { toolCallId: "c1", result: { output: "boom", isError: true } }),
      ],
      "s1",
    );
    const last = tools(out).at(-1)!;
    expect(last.status).toBe("error");
    expect(last.isError).toBe(true);
  });

  test("an edit carries both sides of the change as a diff", () => {
    // Kimi hands us `before` and `after` outright. Falling back to raw output
    // here would render a diff as a wall of text when the real thing is free.
    const out = normalizeKimi(
      [
        loop("tool.call", { toolCallId: "e1", name: "Edit", args: { path: "/repo/src/a.ts" } }),
        loop("tool.result", {
          toolCallId: "e1",
          result: { output: "ok" },
          display: {
            kind: "file_io",
            operation: "edit",
            path: "/repo/src/a.ts",
            before: "const a = 1;",
            after: "const a = 2;",
          },
        }),
      ],
      "s1",
    );
    const card = tools(out).at(-1)!;
    expect(card.content).toEqual([
      { type: "diff", path: "/repo/src/a.ts", oldText: "const a = 1;", newText: "const a = 2;" },
    ]);
    expect(card.locations).toEqual([{ path: "/repo/src/a.ts" }]);
  });

  test("a rejected call stops spinning instead of running forever", () => {
    // A rejected tool never produces a `tool.result`, so nothing else would
    // ever settle the card — it would sit "running" for the rest of the
    // session with no explanation on screen.
    const out = normalizeKimi(
      [
        loop("tool.call", { toolCallId: "c1", name: "Bash", args: { command: "rm -rf /" } }),
        rec("permission.record_approval_result", {
          toolCallId: "c1",
          toolName: "Bash",
          action: "Running: rm -rf /",
          result: { decision: "rejected" },
        }),
      ],
      "s1",
    );
    expect(tools(out).at(-1)!.status).toBe("cancelled");
  });

  test("an approval that was granted adds nothing — the card already says it ran", () => {
    const out = normalizeKimi(
      [
        loop("tool.call", { toolCallId: "c1", name: "Bash", args: { command: "ls" } }),
        rec("permission.record_approval_result", {
          toolCallId: "c1",
          toolName: "Bash",
          result: { decision: "approved", scope: "session" },
        }),
        loop("tool.result", { toolCallId: "c1", result: { output: "a" } }),
      ],
      "s1",
    );
    expect(tools(out)).toHaveLength(2);
  });

  test("thinking is reasoning, not the reply", () => {
    const out = normalizeKimi(
      [
        loop("content.part", { part: { type: "think", think: "Checking the retry path." } }),
        loop("content.part", { part: { type: "text", text: "Fixed it." } }),
      ],
      "s1",
    );
    expect(out.filter((e) => e.kind === "reasoning")).toHaveLength(1);
    expect(texts(out).map((t) => t.text)).toEqual(["Fixed it."]);
  });

  test("cached input is counted, because Kimi's fields are addends", () => {
    // Kimi splits the input side three ways and each names a different slice:
    // `inputOther` is what was not cached at all. Reporting only that would
    // put a context figure on screen far smaller than the conversation —
    // the mirror image of double-counting Codex's already-total input.
    const out = normalizeKimi(
      [
        rec("usage.record", {
          model: "kimi-k3",
          usageScope: "turn",
          usage: {
            inputOther: 1200,
            inputCacheRead: 18000,
            inputCacheCreation: 800,
            output: 217,
          },
        }),
      ],
      "s1",
    );
    expect(out.find((e) => e.kind === "usage")).toMatchObject({
      contextTokens: 20000,
      outputTokens: 217,
    });
  });

  test("a turn's token counts collapse into one running number", () => {
    // `usage.record` lands once per step and `step.end` repeats the identical
    // numbers (53 of 53 on real sessions). One id per turn, one source.
    const usage = (n: number) =>
      rec("usage.record", { usage: { inputOther: n, output: 1 } });
    const out = normalizeKimi(
      [
        loop("step.begin", { turnId: "t1" }),
        usage(10),
        usage(20),
        loop("step.end", { turnId: "t1", usage: { inputOther: 20, output: 1 }, finishReason: "tool_use" }),
      ],
      "s1",
    );
    const ids = new Set(out.filter((e) => e.kind === "usage").map((e) => e.id));
    expect(ids.size).toBe(1);
  });

  test("only the step that ends the turn is a result", () => {
    // 44 of 48 steps finish with `tool_use` — the turn is still running and
    // hands off to another call. A footer under each of those would stamp the
    // transcript with "finished" a dozen times mid-turn.
    const out = normalizeKimi(
      [
        loop("step.end", { turnId: "t1", finishReason: "tool_use" }),
        loop("step.end", { turnId: "t1", finishReason: "end_turn", llmStreamDurationMs: 4200 }),
      ],
      "s1",
    );
    const results = out.filter((e) => e.kind === "result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ durationMs: 4200 });
  });

  test("a finished todo reads as finished", () => {
    // Kimi's word is `done`; the shared model's is `completed`. Passing it
    // through unmapped leaves a ticked item rendering as still open.
    const out = normalizeKimi(
      [
        rec("tools.update_store", {
          key: "todo",
          value: [
            { title: "Read the config", status: "done" },
            { title: "Fix the parser", status: "in_progress" },
            { title: "Run the tests", status: "pending" },
          ],
        }),
      ],
      "s1",
    );
    expect(out.find((e) => e.kind === "todo")).toMatchObject({
      todos: [
        { content: "Read the config", status: "completed" },
        { content: "Fix the parser", status: "in_progress" },
        { content: "Run the tests", status: "pending" },
      ],
    });
  });

  test("the session card knows the model, which is not in the metadata record", () => {
    const out = normalizeKimi(
      [
        rec("metadata", { protocol_version: "1", created_at: 1 }),
        rec("tools.set_active_tools", { names: ["Bash", "Read", "Edit"] }),
        rec("usage.record", { model: "kimi-k3", usage: { output: 1 } }),
      ],
      "s1",
    );
    expect(out.find((e) => e.kind === "session_init")).toMatchObject({
      model: "kimi-k3",
      tools: ["Bash", "Read", "Edit"],
    });
  });
});

describe("picking an adapter by agent", () => {
  const wire = [loop("content.part", { part: { type: "text", text: "hello" } })];

  test("kimi gets the kimi adapter", () => {
    expect(normalizeStream("kimi", wire, "s1")).not.toBeNull();
  });

  test("codex does not read a Kimi wire as if it were a rollout", () => {
    // Both are JSONL records with a `type`, which is exactly enough overlap
    // for the wrong adapter to run and return nothing rather than fail.
    expect(normalizeStream("codex", wire, "s1")).toEqual([]);
  });
});
