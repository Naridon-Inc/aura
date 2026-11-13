import { describe, expect, test } from "bun:test";

import type { StreamEvent } from "@shared/streamEvent";

import { acpCurrentModel, acpModels, acpSessionState } from "./acp";
import { normalizeClaude } from "./claude";
import { reduceEvents } from "../reduce";
import type { TextEvent, ToolCallEvent, UsageEvent } from "../events";

// The ACP chat path emits each `session/update` as a content block. These
// tests drive the shared normalizer with what a real agent sends: prose in
// many small chunks, tool calls updated in place, and state updates that
// belong to the composer rather than the transcript.

const T = "turn_1";
let seq = 0;
const update = (u: Record<string, unknown>): StreamEvent => ({
  kind: "content_block",
  event_id: `${T}:acp:${++seq}`,
  role: "assistant",
  payload: { type: "acp_update", update: u },
  turn_id: T,
});
const chunk = (text: string, sessionUpdate = "agent_message_chunk") =>
  update({ sessionUpdate, content: { type: "text", text } });
const session = (extra: Record<string, unknown> = {}): StreamEvent => ({
  kind: "content_block",
  event_id: `${T}:acp:${++seq}`,
  role: "assistant",
  payload: {
    type: "acp_session",
    session: {
      id: "sess-1",
      how: "new",
      config: [
        {
          id: "model",
          name: "Model",
          category: "model",
          kind: "select",
          current: "fast",
          choices: [
            { value: "fast", name: "Fast" },
            { value: "deep", name: "Deep", description: "Slower" },
          ],
        },
      ],
      modes: { current: "default", available: [["default", "Default"], ["plan", "Plan"]] },
      legacy_models: [],
      legacy_current_model: null,
      ...extra,
    },
  },
  turn_id: T,
});

const settled = (events: StreamEvent[]) =>
  reduceEvents(normalizeClaude(events, "chan")).events;

describe("ACP transcript", () => {
  test("a stream of chunks reads as one paragraph", () => {
    const out = settled([chunk("Hel"), chunk("lo, "), chunk("world")]);
    const texts = out.filter((e): e is TextEvent => e.kind === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe("Hello, world");
  });

  test("a tool call between chunks starts a new paragraph", () => {
    const out = settled([
      chunk("Reading. "),
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a.rs", kind: "read", status: "pending" }),
      chunk("Done."),
    ]);
    expect(out.map((e) => e.kind)).toEqual(["text", "tool_call", "text"]);
  });

  test("thoughts and prose stay in their own blocks", () => {
    const out = settled([
      chunk("Let me ", "agent_thought_chunk"),
      chunk("check.", "agent_thought_chunk"),
      chunk("Here it is."),
    ]);
    expect(out.map((e) => e.kind)).toEqual(["reasoning", "text"]);
    expect(out[0].kind === "reasoning" && out[0].text).toBe("Let me check.");
  });

  test("a tool update without a kind keeps the card's kind and title", () => {
    const out = settled([
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit lib.rs", kind: "edit", status: "pending" }),
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "diff", path: "lib.rs", oldText: "a", newText: "b" }],
      }),
    ]);
    const tool = out.find((e): e is ToolCallEvent => e.kind === "tool_call")!;
    expect(tool.toolKind).toBe("edit");
    expect(tool.title).toBe("Edit lib.rs");
    expect(tool.status).toBe("completed");
    expect(tool.content?.[0]).toMatchObject({ type: "diff", path: "lib.rs" });
  });

  test("state updates draw nothing and do not split prose", () => {
    const out = settled([
      session(),
      chunk("One "),
      update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "init", description: "Set up" }] }),
      update({ sessionUpdate: "current_mode_update", currentModeId: "plan" }),
      chunk("two"),
    ]);
    expect(out.map((e) => e.kind)).toEqual(["text"]);
    expect(out[0].kind === "text" && out[0].text).toBe("One two");
  });

  test("the context meter follows the latest usage update", () => {
    const out = settled([
      update({ sessionUpdate: "usage_update", used: 1200, size: 200000 }),
      update({ sessionUpdate: "usage_update", used: 5400, size: 200000 }),
    ]);
    const usage = out.filter((e): e is UsageEvent => e.kind === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0].contextTokens).toBe(5400);
  });

  test("agent images and links come through", () => {
    const out = settled([
      update({ sessionUpdate: "agent_message_chunk", content: { type: "image", mimeType: "image/jpeg", data: "AAAA" } }),
      update({ sessionUpdate: "agent_message_chunk", content: { type: "resource_link", name: "spec.md", uri: "file:///r/spec.md" } }),
    ]);
    expect(out[0]).toMatchObject({ kind: "image", mediaType: "image/jpeg", data: "AAAA" });
    expect(out[1]).toMatchObject({ kind: "text", text: "[spec.md](file:///r/spec.md)" });
  });
});

describe("ACP session state", () => {
  test("no session block, no state", () => {
    expect(acpSessionState([chunk("hi")])).toBeNull();
  });

  test("models, mode, commands, title and usage fold from the stream", () => {
    const state = acpSessionState([
      session(),
      update({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "review", description: "Review changes", input: { hint: "branch" } }],
      }),
      update({ sessionUpdate: "current_mode_update", currentModeId: "plan" }),
      update({ sessionUpdate: "session_info_update", title: "Fix the parser" }),
      update({ sessionUpdate: "usage_update", used: 900, size: 128000 }),
    ])!;
    expect(acpModels(state).map((m) => m.value)).toEqual(["fast", "deep"]);
    expect(acpCurrentModel(state)).toBe("fast");
    expect(state.modes.current).toBe("plan");
    expect(state.commands).toEqual([{ name: "review", description: "Review changes", hint: "branch" }]);
    expect(state.title).toBe("Fix the parser");
    expect(state.usage).toEqual({ used: 900, size: 128000 });
  });

  test("a config update replaces the options in their wire shape", () => {
    const state = acpSessionState([
      session(),
      update({
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "deep",
            options: [{ name: "Hosted", options: [{ value: "deep", name: "Deep" }] }],
          },
        ],
      }),
    ])!;
    expect(acpCurrentModel(state)).toBe("deep");
    expect(acpModels(state)).toEqual([{ value: "deep", name: "Deep", description: undefined, group: "Hosted" }]);
  });

  test("older agents list models without config options", () => {
    const state = acpSessionState([
      session({ config: [], legacy_models: ["m1", "m2"], legacy_current_model: "m2" }),
    ])!;
    expect(acpModels(state).map((m) => m.value)).toEqual(["m1", "m2"]);
    expect(acpCurrentModel(state)).toBe("m2");
  });
});
