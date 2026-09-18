import { describe, expect, test } from "bun:test";
import {
  normalizeClaude,
  normalizeStream,
  canNormalize,
  AGENT_MANIFESTS,
  supportsStructuredChat,
} from "../src/lib/agentProtocol";
import { reduceEvents } from "../src/lib/agentProtocol/reduce";
import { toTranscriptGroups } from "../src/components/agent/normalized/blockMap";
import { toolStatus } from "../src/components/manager/chat/types";
import type { NormalizedEvent } from "../src/lib/agentProtocol/events";
import type { StreamEvent } from "../src/lib/api";
import { coverageEvents, envelope, tool } from "./chatProtocol.fixture";

const normalize = (events: unknown[]) =>
  normalizeClaude(events as StreamEvent[], "fixture-session");
const content = (id: string, payload: unknown, turn = "turn-1") => ({
  kind: "content_block",
  event_id: id,
  payload,
  role: "assistant",
  turn_id: turn,
});
const done = (
  subtype: "success" | "error" | "cancelled" = "success",
): NormalizedEvent => ({ ...envelope, kind: "result", id: "done", subtype });

describe("lossless wire boundary", () => {
  test("repeated words with distinct provider identities remain real content", () => {
    const events = normalize([
      content("a", { type: "text", text: "Again" }),
      content("b", { type: "text", text: "Again" }),
    ]);
    expect(reduceEvents(events).events).toHaveLength(2);
  });
  test("replayed provider blocks replace in place", () => {
    const events = normalize([
      content("a", { type: "text", text: "draft" }),
      content("a", { type: "text", text: "final" }),
    ]);
    expect(reduceEvents(events).events).toMatchObject([{ text: "final" }]);
  });
  test("identified assistant_text replays deduplicate without changing the legacy wire kind", () => {
    const event = {
      kind: "assistant_text",
      text: "Hello",
      event_id: "msg:0",
      turn_id: "turn-1",
    };
    expect(reduceEvents(normalize([event, event])).events).toHaveLength(1);
  });
  test("legacy text without ids is not guessed to be a duplicate", () => {
    const text = { kind: "assistant_text", text: "Again", turn_id: "turn-1" };
    expect(normalize([text, text])).toHaveLength(2);
  });
  test.each([
    null,
    42,
    "unparsed",
    {},
    { kind: "assistant_text", turn_id: "t", text: null },
    { kind: "tool_use", name: 42, id: "a", turn_id: "t" },
  ])("malformed event stays inspectable: %j", (payload) => {
    expect(normalize([payload])).toMatchObject([{ kind: "raw", payload }]);
  });
  test.each([
    "audio",
    "video",
    "document",
    "resource_link",
    "redacted_thinking",
    "future-vendor-block",
  ])("preserves %s", (type) => {
    const payload = { type, value: { nested: [1, 2] } };
    expect(normalize([content("a", payload)])).toMatchObject([
      { kind: "raw", payload },
    ]);
  });
  test("reasoning and inline images reach the canonical model", () => {
    expect(
      normalize([
        content("r", { type: "thinking", thinking: "Checking" }),
        content("i", {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "abc" },
        }),
      ]),
    ).toMatchObject([
      { kind: "reasoning", text: "Checking" },
      { kind: "image", data: "abc" },
    ]);
  });
  test("legacy images with equal size and prefix do not collide", () => {
    const img = {
      kind: "image",
      media_type: "image/png",
      role: "assistant",
      turn_id: "t",
    };
    const events = normalize([
      { ...img, data: "a".repeat(24) + "b" },
      { ...img, data: "a".repeat(24) + "c" },
    ]);
    expect(reduceEvents(events).events).toHaveLength(2);
  });
  test("total tokens are not invented output tokens", () => {
    expect(
      normalize([
        {
          kind: "result",
          success: true,
          duration_ms: 1,
          total_tokens: 17,
          turn_id: "t",
        },
      ])[0],
    ).toMatchObject({ totalTokens: 17 });
    expect(
      normalize([
        {
          kind: "result",
          success: true,
          duration_ms: 1,
          total_tokens: 17,
          turn_id: "t",
        },
      ])[0],
    ).not.toHaveProperty("usage");
  });
});

describe("lifecycle and isolation", () => {
  test.each(["text", "reasoning"] as const)(
    "%s deltas accumulate from the first chunk",
    (kind) => {
      const e = {
        ...envelope,
        kind,
        id: "a",
        role: "assistant" as const,
        text: "",
        delta: "one",
      };
      expect(
        reduceEvents([e, { ...e, delta: " two" }]).events[0],
      ).toMatchObject({ text: "one two", delta: undefined });
    },
  );
  test("sessions and parent agents can reuse tool ids", () => {
    const events = [
      tool(),
      tool({ sessionId: "other" }),
      tool({ parentId: "child" }),
    ];
    expect(reduceEvents(events).events).toHaveLength(3);
    expect(reduceEvents(events, "fixture-session").events).toHaveLength(2);
  });
  test("late start cannot reopen a settled tool", () => {
    expect(
      reduceEvents([tool({ status: "completed", output: "done" }), tool()])
        .events[0],
    ).toMatchObject({ status: "completed", output: "done", partial: false });
  });
  test("result overlay keeps the request input and name", () => {
    expect(
      reduceEvents([
        tool(),
        tool({ status: "completed", toolName: "tool", input: {}, output: "" }),
      ]).events[0],
    ).toMatchObject({
      input: { command: "bun test" },
      toolName: "Bash",
      status: "completed",
    });
  });
  test.each(["success", "error", "cancelled"] as const)(
    "%s closes active UI without inventing a successful result",
    (status) => {
      const state = reduceEvents([tool(), done(status)]);
      expect(state.activeToolCalls).toHaveLength(0);
      expect(state.events[0]).toMatchObject({
        status: status === "cancelled" ? "cancelled" : "unknown",
      });
    },
  );
  test("ending one turn leaves other turns running", () => {
    expect(
      reduceEvents([tool({ turnId: "turn-2" }), done()]).activeToolCalls,
    ).toHaveLength(1);
  });
  test("question results close the historical card and retain the answer", () => {
    const events = normalize([
      {
        kind: "tool_use",
        id: "q",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Which?",
              options: [{ label: "A" }],
              multiSelect: true,
            },
          ],
        },
        turn_id: "turn-1",
      },
      {
        kind: "tool_result",
        tool_use_id: "q",
        content: "A",
        is_error: false,
        turn_id: "turn-1",
      },
    ]);
    expect(reduceEvents(events).pendingQuestions).toBeNull();
    expect(reduceEvents(events).events[0]).toMatchObject({
      partial: false,
      resolution: { text: "A" },
    });
  });
  test("failed special tools preserve their error", () => {
    const events = normalize([
      {
        kind: "tool_use",
        id: "p",
        name: "ExitPlanMode",
        input: { plan: "Proposed work" },
        turn_id: "turn-1",
      },
      {
        kind: "tool_result",
        tool_use_id: "p",
        content: "Denied",
        is_error: true,
        turn_id: "turn-1",
      },
    ]);
    expect(reduceEvents(events).pendingPlan).toBeNull();
    expect(
      events.some((e) => e.kind === "error" && e.message === "Denied"),
    ).toBe(true);
  });
});

describe("renderer contract", () => {
  test.each(["completed", "error", "cancelled", "unknown"] as const)(
    "%s without output is settled",
    (status) => {
      const [group] = toTranscriptGroups([tool({ status })]);
      expect(group.kind).toBe("stream");
      if (group.kind !== "stream" || group.blocks[0].kind !== "tool")
        throw Error("missing tool");
      expect(group.blocks[0].result).toBeDefined();
      expect(toolStatus(group.blocks[0].result)).toBe(
        status === "completed" ? "ok" : status,
      );
    },
  );
  test("structured tool output survives without a text result", () => {
    const [g] = toTranscriptGroups([
      tool({
        status: "completed",
        content: [{ type: "content", text: "Resource body" }],
      }),
    ]);
    expect(g).toMatchObject({
      blocks: [{ result: { content: "Resource body" } }],
    });
  });
  test("every normalized kind is represented in the transcript", () => {
    const groups = toTranscriptGroups(coverageEvents);
    const kinds = new Set(groups.map((g) => g.kind));
    expect([...kinds].sort()).toEqual(
      [
        "init",
        "user",
        "stream",
        "status",
        "question",
        "plan",
        "todo",
        "permission",
        "raw",
        "image",
        "error",
        "result",
      ].sort(),
    );
  });
  test("group keys do not collide across sessions", () => {
    const events = [
      tool(),
      tool({ sessionId: "other" }),
      {
        ...envelope,
        kind: "raw" as const,
        id: "a",
        label: "extra",
        payload: 1,
      },
      {
        ...envelope,
        sessionId: "other",
        kind: "raw" as const,
        id: "a",
        label: "extra",
        payload: 2,
      },
    ];
    const keys = toTranscriptGroups(events).map((g) => g.id);
    expect(new Set(keys).size).toBe(keys.length);
  });
  test.each([
    "custom/new-model",
    "opus-family",
    "sonnet-family",
    "haiku-family",
    "local/fine-tuned",
  ])("model labels are data, never a rendering allowlist: %s", (model) => {
    expect(
      normalizeStream(
        "claude",
        [
          {
            kind: "system_init",
            session_id: "s",
            turn_id: "t",
            tools: [],
            model,
          },
        ],
        "s",
      ),
    ).toMatchObject([{ model }]);
  });
  test.each(
    Object.keys(AGENT_MANIFESTS).filter((id) => id !== "openai-compat"),
  )("%s renders its connected canonical transport", (id) => {
    expect(canNormalize(id)).toBe(true);
    expect(supportsStructuredChat(id)).toBe(true);
  });
  test("unknown custom agents retain the terminal fallback", () => {
    expect(
      normalizeStream(
        "future-agent",
        [{ kind: "assistant_text", text: "Generic output", turn_id: "t" }],
        "s",
      ),
    ).toMatchObject([{ kind: "text", text: "Generic output" }]);
    expect(canNormalize("future-agent")).toBe(false);
  });
  test("non-array input never crashes the dispatcher", () => {
    expect(normalizeStream("claude", null, "s")).toMatchObject([
      { kind: "raw" },
    ]);
  });
});

describe("connected ACP transport", () => {
  const update = (id: string, value: unknown) =>
    content(id, { type: "acp_update", update: value });
  test("partial tool updates retain their original input and become completed", () => {
    const input = { command: "pwd" };
    const events = normalize([
      update("start", {
        sessionUpdate: "tool_call",
        toolCallId: "one",
        title: "Check directory",
        kind: "execute",
        rawInput: input,
        status: "in_progress",
      }),
      update("done", {
        sessionUpdate: "tool_call_update",
        toolCallId: "one",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "/fixture" } },
        ],
      }),
    ]);
    expect(reduceEvents(events).events).toMatchObject([
      {
        kind: "tool_call",
        status: "completed",
        input,
        content: [{ text: "/fixture" }],
      },
    ]);
  });
  test("plans, images, thinking, and future updates are all visible", () => {
    const events = normalize([
      update("plan", {
        sessionUpdate: "plan",
        entries: [{ content: "Review", status: "in_progress" }],
      }),
      update("thought", {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Reviewing" },
      }),
      update("image", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", mimeType: "image/png", data: "AAAA" },
      }),
      update("new", {
        sessionUpdate: "future_event",
        payload: { useful: true },
      }),
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      "plan",
      "reasoning",
      "image",
      "raw",
    ]);
  });
  test("cancelled turns close late permission and tool updates", () => {
    const events = normalize([
      content("cancel", { type: "turn_cancelled" }),
      update("late", {
        sessionUpdate: "tool_call",
        toolCallId: "late",
        status: "in_progress",
        title: "Late tool",
      }),
    ]);
    const reduced = reduceEvents(events);
    expect(reduced.activeToolCalls).toHaveLength(0);
    expect(reduced.events).toMatchObject([
      { subtype: "cancelled" },
      { status: "cancelled" },
    ]);
  });
  test("usage-only responses retain accounting", () => {
    const groups = toTranscriptGroups([
      {
        ...envelope,
        kind: "usage",
        id: "usage",
        contextTokens: 50,
        outputTokens: 4,
      },
    ]);
    expect(groups).toMatchObject([
      { kind: "stream", usage: { context: 50, output: 4 } },
    ]);
  });
});

import { accumulateCompletion } from "../src/lib/chatCompletion";
describe("custom model completion stream", () => {
  test("final snapshots replace deltas without duplicating output", () => {
    let state = accumulateCompletion(
      { content: "" },
      { choices: [{ delta: { content: "hello " } }] },
    );
    state = accumulateCompletion(state, {
      choices: [{ delta: { content: "世界" } }],
    });
    state = accumulateCompletion(state, {
      choices: [{ message: { content: "hello 世界" }, finish_reason: "stop" }],
    });
    expect(state.content).toBe("hello 世界");
  });
  test("interleaved tools retain exact IDs and split JSON arguments", () => {
    let state = accumulateCompletion(
      { content: "" },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "a",
                  function: { name: "read", arguments: '{"path":' },
                },
                {
                  index: 1,
                  id: "b",
                  function: { name: "search", arguments: '{"q":' },
                },
              ],
            },
          },
        ],
      },
    );
    state = accumulateCompletion(state, {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 1, function: { arguments: '"hello"}' } },
              { index: 0, function: { arguments: '"a.ts"}' } },
            ],
          },
        },
      ],
    });
    expect((state as any).tools).toEqual([
      { index: 0, id: "a", name: "read", arguments: '{"path":"a.ts"}' },
      { index: 1, id: "b", name: "search", arguments: '{"q":"hello"}' },
    ]);
  });
  test("reasoning, refusal, usage and unknown media survive", () => {
    const state = accumulateCompletion(
      { content: "" },
      {
        choices: [
          {
            delta: {
              reasoning_content: "Planning",
              refusal: "Cannot do that",
              audio: { id: "clip" },
              content: [
                { type: "text", text: "Text" },
                {
                  type: "image_url",
                  image_url: { url: "https://example.com/image.png" },
                },
              ],
            },
            finish_reason: "length",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
      },
    );
    expect(state).toMatchObject({
      content: "Text",
      reasoning: "Planning",
      refusal: "Cannot do that",
      finishReason: "length",
      usage: { input: 4, output: 5, total: 9 },
    });
    expect((state as any).parts).toHaveLength(2);
  });
});
