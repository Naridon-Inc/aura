import { describe, expect, test } from "bun:test";

import { normalizePi } from "./pi";
import { normalizeStream } from "../index";
import { reduceEvents } from "../reduce";
import type {
  ErrorEvent,
  NormalizedEvent,
  ReasoningEvent,
  ResultEvent,
  SessionInitEvent,
  TextEvent,
  ToolCallEvent,
  UsageEvent,
} from "../events";

// Every record below is built to pi 0.83.0's own declared types — the
// `AgentSessionEvent` union in `dist/core/agent-session.d.ts`, `AgentEvent` in
// pi-agent-core, `AssistantMessageEvent` in pi-ai — and to the emission ORDER
// its compiled `agent-loop.js` actually produces.
//
// Two of those details are the whole reason this adapter is not a copy of the
// OpenCode one, and both are exercised below: pi's messages carry no id, so
// ids come from counting `message_start`; and pi streams deltas alongside a
// `partial` snapshot, so the adapter emits the snapshot and lets the reducer
// replace rather than accrete.

const header = (cwd = "/repo", id = "ses_pi") => ({
  type: "session",
  version: 1,
  id,
  timestamp: 1785700745959,
  cwd,
});

/** A streaming text delta, with the accumulated message pi sends alongside it. */
const textDelta = (delta: string, soFar: string, contentIndex = 0) => ({
  type: "message_update",
  assistantMessageEvent: {
    type: "text_delta",
    contentIndex,
    delta,
    partial: { role: "assistant", content: [{ type: "text", text: soFar }] },
  },
});

const thinkingDelta = (delta: string, soFar: string, contentIndex = 0) => ({
  type: "message_update",
  assistantMessageEvent: {
    type: "thinking_delta",
    contentIndex,
    delta,
    partial: { role: "assistant", content: [{ type: "thinking", thinking: soFar }] },
  },
});

const usage = (over: Record<string, unknown> = {}) => ({
  input: 137,
  output: 42,
  cacheRead: 9088,
  cacheWrite: 0,
  totalTokens: 9267,
  cost: { input: 0.0004, output: 0.0006, cacheRead: 0.0002, cacheWrite: 0, total: 0.0012 },
  ...over,
});

const assistantEnd = (
  content: Record<string, unknown>[],
  over: Record<string, unknown> = {},
) => ({
  type: "message_end",
  message: {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: usage(),
    stopReason: "stop",
    timestamp: 1785700746000,
    ...over,
  },
});

const texts = (out: NormalizedEvent[]) =>
  out.filter((e): e is TextEvent => e.kind === "text");
const reasonings = (out: NormalizedEvent[]) =>
  out.filter((e): e is ReasoningEvent => e.kind === "reasoning");
const tools = (out: NormalizedEvent[]) =>
  out.filter((e): e is ToolCallEvent => e.kind === "tool_call");
const usages = (out: NormalizedEvent[]) =>
  out.filter((e): e is UsageEvent => e.kind === "usage");
const results = (out: NormalizedEvent[]) =>
  out.filter((e): e is ResultEvent => e.kind === "result");
const errors = (out: NormalizedEvent[]) =>
  out.filter((e): e is ErrorEvent => e.kind === "error");
const inits = (out: NormalizedEvent[]) =>
  out.filter((e): e is SessionInitEvent => e.kind === "session_init");

const run = (rows: unknown[]) => normalizePi(rows, "ses_pi");

describe("pi adapter — the wire", () => {
  test("the header line is a session card, not an unrecognized event", () => {
    // `runPrintMode` writes `getHeader()` before it subscribes, so the first
    // line of every pi run is a SessionHeader whose `type` is "session" —
    // the one record outside the event union, which is exactly what makes it
    // safe to discriminate on.
    const out = run([header("/Users/me/proj")]);
    expect(inits(out)).toHaveLength(1);
    expect(inits(out)[0].cwd).toBe("/Users/me/proj");
    expect(inits(out)[0].model).toBeNull();
  });

  test("raw NDJSON parses the same as a parsed array", () => {
    const rows = [
      header(),
      { type: "message_start", message: { role: "assistant" } },
      textDelta("hi", "hi"),
      assistantEnd([{ type: "text", text: "hi" }]),
      { type: "agent_end", messages: [] },
    ];
    const raw = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    expect(normalizePi(raw, "ses_pi")).toEqual(normalizePi(rows, "ses_pi"));
  });

  test("a truncated last line is skipped, not thrown on", () => {
    // A live tail hits this constantly: the process is mid-write when we read.
    // One unparseable line must not blank the conversation around it.
    const raw = [
      JSON.stringify(header()),
      JSON.stringify({ type: "message_start", message: { role: "assistant" } }),
      JSON.stringify(assistantEnd([{ type: "text", text: "done" }])),
      '{"type":"message_upda',
    ].join("\n");
    expect(texts(normalizePi(raw, "ses_pi")).map((t) => t.text)).toEqual(["done"]);
  });

  test("an unknown event type is ignored rather than rendered", () => {
    const out = run([header(), { type: "some_future_event", payload: 1 }]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("session_init");
  });
});

describe("pi adapter — streaming text", () => {
  test("deltas carry the ACCUMULATED text, so re-parsing converges", () => {
    // Pi sends both the delta and `partial`, the message so far. The chat
    // re-normalizes the whole raw stream on every tick, so emitting deltas
    // would concatenate them a second time on the second pass. Emitting the
    // accumulated string with no `delta` makes the reducer REPLACE, which is
    // idempotent.
    const rows = [
      header(),
      { type: "message_start", message: { role: "assistant" } },
      textDelta("Let ", "Let "),
      textDelta("me ", "Let me "),
      textDelta("look.", "Let me look."),
    ];
    const out = run(rows);
    const t = texts(out);
    expect(t.map((e) => e.text)).toEqual(["Let ", "Let me ", "Let me look."]);
    expect(t.every((e) => e.delta === undefined)).toBe(true);
    // All three land on ONE id, and the reducer settles on the last.
    expect(new Set(t.map((e) => e.id)).size).toBe(1);
    expect(texts(reduceEvents(out).events)[0].text).toBe("Let me look.");

    // The point of replacement semantics: normalizing a longer prefix does not
    // double the text that was already there.
    const again = run([...rows, assistantEnd([{ type: "text", text: "Let me look." }])]);
    expect(texts(reduceEvents(again).events)[0].text).toBe("Let me look.");
  });

  test("the final message replaces the stream on the same id", () => {
    const out = run([
      header(),
      { type: "message_start", message: { role: "assistant" } },
      textDelta("partia", "partia"),
      assistantEnd([{ type: "text", text: "partial no more" }]),
    ]);
    const settled = texts(reduceEvents(out).events);
    expect(settled).toHaveLength(1);
    expect(settled[0].text).toBe("partial no more");
    expect(settled[0].partial).toBeUndefined();
  });

  test("thinking streams as reasoning and keeps its signature", () => {
    const out = run([
      header(),
      { type: "message_start", message: { role: "assistant" } },
      thinkingDelta("weigh", "weigh"),
      thinkingDelta("ing it", "weighing it"),
      assistantEnd([
        { type: "thinking", thinking: "weighing it", thinkingSignature: "sig_abc" },
        { type: "text", text: "yes" },
      ]),
    ]);
    const settled = reduceEvents(out).events;
    const r = reasonings(settled);
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe("weighing it");
    // Carried through because Anthropic requires it back verbatim on the next
    // turn for multi-turn thinking continuity.
    expect(r[0].signature).toBe("sig_abc");
    expect(texts(settled)[0].text).toBe("yes");
  });

  test("two assistant messages in one run do not collide on ids", () => {
    // Pi's messages have NO id field, so ids come from counting
    // `message_start`. If that counter were wrong, the second answer would
    // overwrite the first and the transcript would lose a turn.
    const out = run([
      header(),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "first" }]),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "second" }]),
    ]);
    expect(texts(reduceEvents(out).events).map((t) => t.text)).toEqual([
      "first",
      "second",
    ]);
  });

  test("the tool-result message between two assistant turns keeps ids apart", () => {
    // The counter has to advance for toolResult messages too, because pi emits
    // message_start for them. Miss that and the assistant message AFTER a tool
    // lands on the id of the one BEFORE it.
    const out = run([
      header(),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "checking" }]),
      { type: "message_start", message: { role: "toolResult" } },
      {
        type: "message_end",
        message: { role: "toolResult", toolCallId: "tc_1", toolName: "read", content: [] },
      },
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "found it" }]),
    ]);
    expect(texts(reduceEvents(out).events).map((t) => t.text)).toEqual([
      "checking",
      "found it",
    ]);
  });

  test("a user message renders as the user's own turn", () => {
    const out = run([
      header(),
      { type: "message_start", message: { role: "user" } },
      {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "fix the parser" }] },
      },
    ]);
    const t = texts(out);
    expect(t).toHaveLength(1);
    expect(t[0].role).toBe("user");
    expect(t[0].source).toBe("user");
    expect(t[0].text).toBe("fix the parser");
  });

  test("a user message whose content is a bare string still renders", () => {
    // `UserMessage.content` is `string | (TextContent|ImageContent)[]` — both
    // forms are real and pi's own prompt path uses the string one.
    const out = run([
      header(),
      { type: "message_start", message: { role: "user" } },
      { type: "message_end", message: { role: "user", content: "hello" } },
    ]);
    expect(texts(out)[0].text).toBe("hello");
  });

  test("a tool-result message is not shown twice", () => {
    // `tool_execution_end` already rendered that card; the toolResult message
    // is the same output on its way into the model's context.
    const out = run([
      header(),
      { type: "message_start", message: { role: "toolResult" } },
      {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "tc_1",
          toolName: "read",
          content: [{ type: "text", text: "file body" }],
          isError: false,
        },
      },
    ]);
    expect(texts(out)).toHaveLength(0);
  });
});

describe("pi adapter — tool calls", () => {
  test("start → end folds into one card keyed by pi's own toolCallId", () => {
    const out = run([
      header(),
      {
        type: "tool_execution_start",
        toolCallId: "tc_read_1",
        toolName: "read",
        args: { path: "src/main.rs" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tc_read_1",
        toolName: "read",
        args: { path: "src/main.rs" },
        result: { content: [{ type: "text", text: "fn main() {}" }], details: {} },
        isError: false,
      },
    ]);
    const settled = tools(reduceEvents(out).events);
    expect(settled).toHaveLength(1);
    expect(settled[0].status).toBe("completed");
    expect(settled[0].toolKind).toBe("read");
    expect(settled[0].output).toBe("fn main() {}");
    expect(settled[0].locations).toEqual([{ path: "src/main.rs" }]);
  });

  test("a running card appears before the tool finishes", () => {
    // Pi emits `tool_execution_start` immediately before `execute()`, so this
    // is a genuinely running tool, not a queued one.
    const out = run([
      header(),
      {
        type: "tool_execution_start",
        toolCallId: "tc_bash",
        toolName: "bash",
        args: { command: "cargo test" },
      },
    ]);
    expect(reduceEvents(out).activeToolCalls).toHaveLength(1);
    expect(tools(out)[0].status).toBe("running");
  });

  test("a long command's partial output grows the same card", () => {
    const out = run([
      header(),
      {
        type: "tool_execution_start",
        toolCallId: "tc_bash",
        toolName: "bash",
        args: { command: "cargo test" },
      },
      {
        type: "tool_execution_update",
        toolCallId: "tc_bash",
        toolName: "bash",
        args: { command: "cargo test" },
        partialResult: { content: [{ type: "text", text: "running 4 tests\n" }], details: {} },
      },
    ]);
    const settled = tools(reduceEvents(out).events);
    expect(settled).toHaveLength(1);
    expect(settled[0].output).toBe("running 4 tests\n");
    // The headline came from the start event and must survive an update that
    // doesn't carry one.
    expect(settled[0].title).not.toBe("");
  });

  test("a failed command is an error card — pi's bash throws on non-zero exit", () => {
    // This is why there is no exit-code sniffing here the way OpenCode needs:
    // pi's bash tool throws `Command exited with code N`, and a thrown tool is
    // what sets `isError`. A failing build cannot arrive wearing a green card.
    const out = run([
      header(),
      {
        type: "tool_execution_start",
        toolCallId: "tc_bash",
        toolName: "bash",
        args: { command: "cargo build" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tc_bash",
        toolName: "bash",
        args: { command: "cargo build" },
        result: {
          content: [{ type: "text", text: "error[E0433]\nCommand exited with code 101" }],
          details: {},
        },
        isError: true,
      },
    ]);
    const settled = tools(reduceEvents(out).events);
    expect(settled[0].status).toBe("error");
    expect(settled[0].isError).toBe(true);
    expect(settled[0].toolKind).toBe("execute");
  });

  test("`find` is aliased so it reads as a search, not an unknown tool", () => {
    // Pi calls its glob tool `find`; our card registry calls the same act
    // `glob`. Without the alias the card falls to the generic glyph and a
    // headline built from the raw name.
    const out = run([
      header(),
      {
        type: "tool_execution_start",
        toolCallId: "tc_find",
        toolName: "find",
        args: { pattern: "**/*.rs" },
      },
    ]);
    expect(tools(out)[0].toolKind).toBe("search");
    expect(tools(out)[0].title).toContain("**/*.rs");
    // The raw name is kept — it is what pi actually ran.
    expect(tools(out)[0].toolName).toBe("find");
  });

  test("write renders the file it wrote as a diff", () => {
    const out = run([
      header(),
      {
        type: "tool_execution_start",
        toolCallId: "tc_w",
        toolName: "write",
        args: { path: "notes.md", content: "# Notes\n" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tc_w",
        toolName: "write",
        args: { path: "notes.md", content: "# Notes\n" },
        result: { content: [{ type: "text", text: "Wrote notes.md" }], details: {} },
        isError: false,
      },
    ]);
    const card = tools(reduceEvents(out).events)[0];
    expect(card.content).toEqual([
      { type: "diff", path: "notes.md", newText: "# Notes\n" },
    ]);
  });

  test("pi's edit takes an ARRAY of replacements — each one is its own diff", () => {
    // Unlike Claude's and OpenCode's single-pair edit, pi's `edit` applies a
    // LIST of `{oldText, newText}` in one call. Rendering only the first would
    // hide the rest of what the file just did.
    const edits = [
      { oldText: "let a = 1;", newText: "let a = 2;" },
      { oldText: "let b = 3;", newText: "let b = 4;" },
    ];
    const out = run([
      header(),
      {
        type: "tool_execution_end",
        toolCallId: "tc_e",
        toolName: "edit",
        args: { path: "src/lib.rs", edits },
        result: { content: [{ type: "text", text: "Applied 2 edits" }], details: {} },
        isError: false,
      },
    ]);
    const card = tools(out)[0];
    expect(card.content).toEqual([
      { type: "diff", path: "src/lib.rs", oldText: "let a = 1;", newText: "let a = 2;" },
      { type: "diff", path: "src/lib.rs", oldText: "let b = 3;", newText: "let b = 4;" },
    ]);
    expect(card.toolKind).toBe("edit");
  });

  test("an unknown extension tool still gets a card rather than being dropped", () => {
    // Pi loads extensions and MCP servers, so tools our registry has never
    // heard of are the normal case, not an edge one.
    const out = run([
      header(),
      {
        type: "tool_execution_start",
        toolCallId: "tc_x",
        toolName: "linear_create_issue",
        args: { title: "Fix the parser" },
      },
    ]);
    expect(tools(out)).toHaveLength(1);
    expect(tools(out)[0].toolName).toBe("linear_create_issue");
    expect(tools(out)[0].title).not.toBe("");
  });

  test("streamed tool arguments are not rendered as half-written JSON", () => {
    // `toolcall_delta` carries raw argument fragments mid-parse. The whole
    // call arrives validated on `tool_execution_start` a moment later.
    const out = run([
      header(),
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '{"path":"src/ma',
          partial: { role: "assistant", content: [{ type: "toolCall", id: "tc_1" }] },
        },
      },
    ]);
    expect(texts(out)).toHaveLength(0);
    expect(tools(out)).toHaveLength(0);
  });
});

describe("pi adapter — the session card", () => {
  test("the model is filled in once the first answer reveals it", () => {
    // The header knows the cwd and the assistant message knows the model, and
    // neither knows the other. Same id, so the card is completed in place.
    const out = run([
      header("/repo"),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "ok" }]),
    ]);
    const settled = inits(reduceEvents(out).events);
    expect(settled).toHaveLength(1);
    // Spelled the way pi's own `--model` flag takes it.
    expect(settled[0].model).toBe("anthropic/claude-sonnet-5");
    expect(settled[0].provider).toBe("anthropic");
    expect(settled[0].cwd).toBe("/repo");
  });

  test("the same model over many messages does not re-emit the card", () => {
    const out = run([
      header(),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "one" }]),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "two" }]),
    ]);
    expect(inits(out)).toHaveLength(2); // header + first model reveal, and no more
  });

  test("a mid-run model switch is reflected", () => {
    // `/model` in the TUI and `cycle_model` over rpc both do this, and the
    // session card should say what is answering NOW.
    const out = run([
      header(),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "one" }]),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "two" }], {
        provider: "google",
        model: "gemini-3-pro",
      }),
    ]);
    expect(inits(reduceEvents(out).events)[0].model).toBe("google/gemini-3-pro");
  });
});

describe("pi adapter — cost, errors and the close", () => {
  test("usage counts the cache planes as context, not as nothing", () => {
    const out = run([
      header(),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "ok" }]),
    ]);
    const u = usages(out);
    expect(u).toHaveLength(1);
    // `input` is the uncached share only; the two cache planes were still fed
    // into the call and a footer that omitted them would understate context by
    // an order of magnitude.
    expect(u[0].contextTokens).toBe(137 + 9088 + 0);
    expect(u[0].outputTokens).toBe(42);
  });

  test("the closing card carries pi's OWN dollar figure, summed over calls", () => {
    // Pi is the one engine that reports money rather than tokens alone — it
    // prices each call against its own model catalog — so there is no reason
    // to re-derive a number it already computed.
    const out = run([
      header(),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "one" }], { stopReason: "toolUse" }),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "two" }]),
      { type: "agent_end", messages: [] },
    ]);
    const r = results(out);
    expect(r).toHaveLength(1);
    expect(r[0].subtype).toBe("success");
    expect(r[0].costUsd).toBeCloseTo(0.0024, 6);
    expect(r[0].usage).toEqual({
      inputTokens: 274,
      outputTokens: 84,
      cacheRead: 18176,
      cacheWrite: 0,
    });
  });

  test("a stream that ends mid-tool gets no closing card", () => {
    // `toolUse` means the model paused to run something and another call
    // follows. A run that stops there stopped early, and printing "success"
    // over it would be a lie.
    const out = run([
      header(),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "let me check" }], { stopReason: "toolUse" }),
    ]);
    expect(results(out)).toHaveLength(0);
  });

  test("an aborted run closes as cancelled, not as an error", () => {
    const out = run([
      header(),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([], { stopReason: "aborted", errorMessage: "Aborted by user" }),
      { type: "agent_end", messages: [] },
    ]);
    expect(results(out)[0].subtype).toBe("cancelled");
  });

  test("a failed call surfaces the provider's OWN sentence", () => {
    // The reason a model call failed — a key refused, a model that doesn't
    // resolve, a context overflow — is in `errorMessage`, and restating it as
    // "the request failed" throws away the only actionable part.
    const out = run([
      header(),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([], {
        stopReason: "error",
        errorMessage: "401 invalid x-api-key",
      }),
      { type: "agent_end", messages: [] },
    ]);
    expect(errors(out)[0].message).toBe("401 invalid x-api-key");
    expect(results(out)[0].subtype).toBe("error");
    expect(results(out)[0].errors).toEqual(["401 invalid x-api-key"]);
  });

  test("hitting the output limit says so instead of closing silently", () => {
    const out = run([
      header(),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "..." }], { stopReason: "length" }),
      { type: "agent_end", messages: [] },
    ]);
    expect(results(out)[0].subtype).toBe("success");
    expect(results(out)[0].text).toContain("output token limit");
  });

  test("a retry is announced with the reason and the attempt count", () => {
    // Pi retries a failed provider call on its own. Without this the chat sits
    // silent for the backoff and looks frozen.
    const out = run([
      header(),
      {
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 5,
        delayMs: 4000,
        errorMessage: "529 overloaded",
      },
    ]);
    expect(errors(out)[0].message).toBe(
      "Attempt 2 of 5 failed: 529 overloaded — retrying.",
    );
  });

  test("a retry that worked adds no noise; one that gave up does", () => {
    const ok = run([header(), { type: "auto_retry_end", success: true, attempt: 3 }]);
    expect(errors(ok)).toHaveLength(0);

    const gaveUp = run([
      header(),
      {
        type: "auto_retry_end",
        success: false,
        attempt: 5,
        finalError: "529 overloaded after 5 attempts",
      },
    ]);
    expect(errors(gaveUp)[0].message).toBe("529 overloaded after 5 attempts");
  });

  test("compaction is explained, because it is why the agent forgets", () => {
    const out = run([header(), { type: "compaction_start", reason: "overflow" }]);
    expect(errors(out)[0].message).toContain("outgrew the context window");
  });

  test("a run that will retry does not close early", () => {
    // `agent_end` with `willRetry` means the loop is about to run again.
    const out = run([
      header(),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([], { stopReason: "error", errorMessage: "boom" }),
      { type: "agent_end", messages: [], willRetry: true },
    ]);
    expect(results(out)).toHaveLength(0);
  });

  test("bookkeeping events render nothing", () => {
    const out = run([
      header(),
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "queue_update", steering: [], followUp: [] },
      { type: "entry_appended", entry: { id: "e1" } },
      { type: "session_info_changed", name: "renamed" },
      { type: "thinking_level_changed", level: "high" },
      { type: "agent_settled" },
      { type: "turn_end", message: {}, toolResults: [] },
      { type: "bash_execution_update", delta: "ls\n" },
      { type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 100 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("session_init");
  });
});

describe("pi adapter — wiring", () => {
  test("the dispatcher routes pi by id, not by ingress", () => {
    // Codex, OpenCode and pi all declare `json-events` and share no schema, so
    // the id table is what keeps pi's records away from Codex's parser.
    const rows = [
      header(),
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "routed" }]),
    ];
    const out = normalizeStream("pi", rows, "ses_pi");
    expect(out).not.toBeNull();
    expect(texts(out!).map((t) => t.text)).toEqual(["routed"]);
  });

  test("a full turn reads in the order it happened", () => {
    // The exact emission order of pi's own agent loop: the user's prompt, the
    // assistant's thinking and text, the tool, the tool's result message, then
    // the close.
    const out = run([
      header(),
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message: { role: "user" } },
      {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "what is in main?" }] },
      },
      { type: "message_start", message: { role: "assistant" } },
      thinkingDelta("read it", "read it"),
      textDelta("Looking.", "Looking.", 1),
      assistantEnd(
        [
          { type: "thinking", thinking: "read it" },
          { type: "text", text: "Looking." },
          { type: "toolCall", id: "tc_1", name: "read", arguments: { path: "src/main.rs" } },
        ],
        { stopReason: "toolUse" },
      ),
      {
        type: "tool_execution_start",
        toolCallId: "tc_1",
        toolName: "read",
        args: { path: "src/main.rs" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tc_1",
        toolName: "read",
        args: { path: "src/main.rs" },
        result: { content: [{ type: "text", text: "fn main() {}" }], details: {} },
        isError: false,
      },
      { type: "message_start", message: { role: "toolResult" } },
      {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "tc_1",
          toolName: "read",
          content: [{ type: "text", text: "fn main() {}" }],
          isError: false,
        },
      },
      { type: "message_start", message: { role: "assistant" } },
      assistantEnd([{ type: "text", text: "An empty main." }]),
      { type: "turn_end", message: {}, toolResults: [] },
      { type: "agent_end", messages: [] },
    ]);

    expect(reduceEvents(out).events.map((e) => e.kind)).toEqual([
      "session_init",
      "text", // the user's prompt
      "reasoning",
      "text", // "Looking."
      "usage",
      "tool_call",
      "text", // "An empty main."
      "usage",
      "result",
    ]);
    expect(reduceEvents(out).activeToolCalls).toHaveLength(0);
  });
});

// ── The session file.
//
// Pi runs as a TUI in a PTY, so the chat does not read its stdout — it tails
// the JSONL pi appends under `~/.pi/agent/sessions/--<cwd>--/`. That file opens
// with the same session header print mode opens with and carries the same
// message values, which is why one adapter serves both. These tests pin that
// equivalence, and cover the three entry types the file has and the wire does
// not: `message`, `model_change` and `compaction`.

/** One `{type:"message"}` entry as pi's session manager appends it. */
const fileMessage = (message: Record<string, unknown>, id: string) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: 1785700746000,
  message,
});

const userMessage = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1785700745000,
});

describe("pi adapter — the session file", () => {
  test("a file's message entries read exactly like the wire's", () => {
    // Same values, two framings. If these ever diverge, one of the two ways of
    // opening a pi tab is showing the user a different conversation.
    const asked = userMessage("what is in main?");
    const answered = assistantEnd([{ type: "text", text: "An empty main." }]).message;

    const wire = run([
      header(),
      { type: "message_start", message: { role: "user" } },
      { type: "message_end", message: asked },
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_end", message: answered },
      { type: "agent_end", messages: [] },
    ]);
    const file = run([header(), fileMessage(asked, "e1"), fileMessage(answered, "e2")]);

    const shape = (out: NormalizedEvent[]) => out.map((e) => `${e.kind}:${e.id}`);
    expect(shape(file)).toEqual(shape(wire));
    expect(texts(file).map((t) => t.text)).toEqual(texts(wire).map((t) => t.text));
  });

  test("the file is its own message_start, so two answers keep separate ids", () => {
    // The file has no `message_start` to count, so the ordinal has to advance
    // on the entry itself. Miss that and every message in the transcript
    // collapses onto one id.
    const out = run([
      header(),
      fileMessage(userMessage("first"), "e1"),
      fileMessage(assistantEnd([{ type: "text", text: "one" }]).message, "e2"),
      fileMessage(userMessage("second"), "e3"),
      fileMessage(assistantEnd([{ type: "text", text: "two" }]).message, "e4"),
    ]);
    expect(texts(out).map((t) => t.text)).toEqual(["first", "one", "second", "two"]);
    expect(new Set(texts(out).map((t) => t.id)).size).toBe(4);
    expect(reduceEvents(out).events.filter((e) => e.kind === "text")).toHaveLength(4);
  });

  test("a tool result entry renders nothing, because its card already exists", () => {
    const out = run([
      header(),
      fileMessage(
        {
          role: "toolResult",
          toolCallId: "tc_1",
          toolName: "read",
          content: [{ type: "text", text: "fn main() {}" }],
          isError: false,
        },
        "e1",
      ),
    ]);
    expect(texts(out)).toHaveLength(0);
    expect(usages(out)).toHaveLength(0);
  });

  test("a mid-session model switch is an entry of its own", () => {
    // In the TUI `/model` changes the model between turns, and the file
    // records it directly rather than leaving it to be inferred from the next
    // assistant message.
    const out = run([
      header(),
      { type: "model_change", id: "e1", provider: "google", modelId: "gemini-3-pro" },
      fileMessage(userMessage("go"), "e2"),
    ]);
    expect(inits(out)).toHaveLength(2);
    expect(inits(out)[1].model).toBe("google/gemini-3-pro");
    // One card, updated — not two cards.
    expect(reduceEvents(out).events.filter((e) => e.kind === "session_init")).toHaveLength(1);
  });

  test("a compaction entry says how large the conversation got", () => {
    const out = run([
      header(),
      {
        type: "compaction",
        id: "e9",
        summary: "The user asked about main.rs.",
        firstKeptEntryId: "e3",
        tokensBefore: 184320,
      },
    ]);
    expect(errors(out)).toHaveLength(1);
    expect(errors(out)[0].errorId).toBe("compaction");
    expect(errors(out)[0].message).toContain((184320).toLocaleString());
  });

  test("the run closes on the last message's stop reason, with no agent_end", () => {
    // The file never records `agent_end` — it is a wire event. Without this
    // the closing card would never appear on a pi tab read from disk.
    const out = run([
      header(),
      fileMessage(userMessage("go"), "e1"),
      fileMessage(assistantEnd([{ type: "text", text: "Done." }]).message, "e2"),
    ]);
    expect(results(out)).toHaveLength(1);
    expect(results(out)[0].subtype).toBe("success");
    expect(results(out)[0].usage.outputTokens).toBe(42);
  });

  test("a follow-up question reopens the run instead of stranding a closing card", () => {
    // A session file outlives any one turn. Closing it for good on the first
    // `stop` would leave a "finished" card sitting above a live conversation.
    const out = run([
      header(),
      fileMessage(assistantEnd([{ type: "text", text: "Done." }]).message, "e1"),
      fileMessage(userMessage("actually, one more thing"), "e2"),
    ]);
    expect(results(out)).toHaveLength(0);
  });

  test("a file paused on a tool call is not finished", () => {
    const out = run([
      header(),
      fileMessage(
        assistantEnd(
          [{ type: "toolCall", id: "tc_1", name: "read", arguments: { path: "a.rs" } }],
          { stopReason: "toolUse" },
        ).message,
        "e1",
      ),
    ]);
    expect(results(out)).toHaveLength(0);
  });

  test("an earlier failure does not follow a later answer into its closing card", () => {
    const out = run([
      header(),
      fileMessage(
        assistantEnd([], { stopReason: "error", errorMessage: "overloaded_error" }).message,
        "e1",
      ),
      fileMessage(userMessage("try again"), "e2"),
      fileMessage(assistantEnd([{ type: "text", text: "Done." }]).message, "e3"),
    ]);
    expect(results(out)).toHaveLength(1);
    expect(results(out)[0].subtype).toBe("success");
    expect(results(out)[0].errors).toBeUndefined();
    // The failure is still shown where it happened — it just doesn't get
    // reported a second time as the outcome of a run that succeeded.
    expect(errors(out).map((e) => e.message)).toContain("overloaded_error");
  });

  test("the header pi writes to the file is the header it writes to the wire", () => {
    // Same line, both places — which is what lets the file be read by the same
    // adapter without teaching it a second session shape.
    const out = run([
      { type: "session", version: 1, id: "ses_pi", timestamp: 1785700745959, cwd: "/repo" },
      fileMessage(userMessage("hi"), "e1"),
    ]);
    expect(inits(out)[0].cwd).toBe("/repo");
    expect(inits(out)[0].sessionId).toBe("ses_pi");
  });
});
