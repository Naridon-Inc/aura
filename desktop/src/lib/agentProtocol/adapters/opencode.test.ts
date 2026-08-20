import { describe, expect, test } from "bun:test";

import { normalizeOpencode } from "./opencode";
import { normalizeStream } from "../index";
import { reduceEvents } from "../reduce";
import type {
  ErrorEvent,
  NormalizedEvent,
  ResultEvent,
  TextEvent,
  TodoEvent,
  ToolCallEvent,
  UsageEvent,
} from "../events";

// Every record below is the shape a real `opencode run --format json` wrote,
// captured from opencode 1.18.11 driving its own built-in tools. The details
// that look like trivia are the ones that break the UI when guessed: OpenCode
// names its arguments `filePath`/`oldString` where our card registry reads
// `file_path`/`old_string`, and it reports a failing shell command as a
// COMPLETED tool with a non-zero `metadata.exit`.

const rec = (type: string, part: Record<string, unknown>, ts = 1785700745959) => ({
  type,
  timestamp: ts,
  sessionID: "ses_test",
  part: { sessionID: "ses_test", messageID: "msg_1", ...part },
});

const tool = (
  name: string,
  state: Record<string, unknown>,
  id = `prt_${name}`,
  callID = `call_${name}`,
) => rec("tool_use", { id, type: "tool", callID, tool: name, state });

const stepFinish = (
  reason: string,
  tokens: Record<string, unknown> = {
    total: 9231,
    input: 137,
    output: 6,
    reasoning: 0,
    cache: { write: 0, read: 9088 },
  },
  cost = 0,
  id = "prt_step",
) => rec("step_finish", { id, type: "step-finish", reason, tokens, cost });

const texts = (out: NormalizedEvent[]) =>
  out.filter((e): e is TextEvent => e.kind === "text");
const tools = (out: NormalizedEvent[]) =>
  out.filter((e): e is ToolCallEvent => e.kind === "tool_call");
const todos = (out: NormalizedEvent[]) =>
  out.filter((e): e is TodoEvent => e.kind === "todo");
const usages = (out: NormalizedEvent[]) =>
  out.filter((e): e is UsageEvent => e.kind === "usage");
const results = (out: NormalizedEvent[]) =>
  out.filter((e): e is ResultEvent => e.kind === "result");
const errors = (out: NormalizedEvent[]) =>
  out.filter((e): e is ErrorEvent => e.kind === "error");

describe("reading an opencode run as a conversation", () => {
  test("the simplest possible run reads as one answer", () => {
    const out = normalizeOpencode(
      [
        rec("step_start", { id: "prt_a", type: "step-start" }),
        rec("text", {
          id: "prt_b",
          type: "text",
          text: "Hi!",
          time: { start: 1, end: 2 },
        }),
        stepFinish("stop"),
      ],
      "s1",
    );
    expect(texts(out).map((t) => t.text)).toEqual(["Hi!"]);
    expect(texts(out)[0]!.role).toBe("assistant");
    // step-start carries nothing but its own ids — it is not an event.
    expect(out.some((e) => e.id === "prt_a")).toBe(false);
  });

  test("a read card names the file rather than nothing at all", () => {
    // OpenCode says `filePath`; the card registry reads `file_path`. Without
    // the rename this renders as "Reading" with an empty subject — not an
    // error, just a card that tells you nothing.
    const out = normalizeOpencode(
      [
        tool("read", {
          status: "completed",
          input: { filePath: "/repo/src/notes.md" },
          output: "<path>/repo/src/notes.md</path>\n<content>\n1: hi\n</content>",
          metadata: { preview: "hi", truncated: false },
          title: "repo/src/notes.md",
          time: { start: 1000, end: 1400 },
        }),
      ],
      "s1",
    );
    const [t] = tools(out);
    expect(t!.title).toBe("Reading notes.md");
    expect(t!.toolKind).toBe("read");
    expect(t!.locations).toEqual([{ path: "/repo/src/notes.md" }]);
    expect(t!.durationMs).toBe(400);
    // The `<path>…<content>` wrapper is written for the model; the human gets
    // the preview OpenCode already extracted.
    expect(t!.content).toEqual([{ type: "content", text: "hi" }]);
  });

  test("an edit shows what changed, not the words 'Edit applied successfully'", () => {
    const out = normalizeOpencode(
      [
        tool("edit", {
          status: "completed",
          input: {
            filePath: "/repo/notes.md",
            oldString: "apple pie",
            newString: "cherry pie",
          },
          output: "Edit applied successfully.",
          metadata: { diff: "Index: /repo/notes.md\n---", truncated: false },
          time: { start: 1, end: 2 },
        }),
      ],
      "s1",
    );
    const [t] = tools(out);
    expect(t!.title).toBe("Editing notes.md");
    expect(t!.content).toEqual([
      {
        type: "diff",
        path: "/repo/notes.md",
        oldText: "apple pie",
        newText: "cherry pie",
      },
    ]);
  });

  test("a shell command that failed is not a green card", () => {
    // OpenCode's `status: "completed"` means "the tool ran", not "the command
    // worked". The exit code lives in metadata, and reading only the status
    // renders a failing build as a success.
    const out = normalizeOpencode(
      [
        tool("bash", {
          status: "completed",
          input: { command: "cargo test" },
          output: "error: test failed",
          metadata: { exit: 101, output: "error: test failed", truncated: false },
          time: { start: 1, end: 2 },
        }),
      ],
      "s1",
    );
    const [t] = tools(out);
    expect(t!.isError).toBe(true);
    expect(t!.content).toEqual([{ type: "content", text: "error: test failed" }]);
  });

  test("a shell command that worked stays a plain success", () => {
    const out = normalizeOpencode(
      [
        tool("bash", {
          status: "completed",
          input: { command: "echo hi" },
          output: "hi\n",
          metadata: { exit: 0, output: "hi\n", truncated: false },
          time: { start: 1, end: 2 },
        }),
      ],
      "s1",
    );
    expect(tools(out)[0]!.isError).toBeUndefined();
    expect(tools(out)[0]!.status).toBe("completed");
  });

  test("the checklist is the checklist surface, not a tool card", () => {
    const out = normalizeOpencode(
      [
        tool("todowrite", {
          status: "completed",
          input: {
            todos: [
              { content: "List the files", status: "completed", priority: "high" },
              { content: "Read notes.md", status: "in_progress", priority: "high" },
              { content: "Run the tests", status: "pending", priority: "medium" },
            ],
          },
          output: "[…]",
          metadata: { todos: [], truncated: false },
          title: "3 todos",
          time: { start: 1, end: 2 },
        }),
      ],
      "s1",
    );
    expect(tools(out)).toHaveLength(0);
    expect(todos(out)[0]!.todos.map((t) => t.status)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
    // And the reducer hands it to the renderer as THE live list.
    expect(reduceEvents(out).todos?.todos).toHaveLength(3);
  });

  test("a plugin or MCP tool keeps the name opencode gave it", () => {
    // Our registry has never heard of someone else's tool. OpenCode has, and
    // wrote a headline for it — better than a generic verb with no subject.
    const out = normalizeOpencode(
      [
        tool("linear_create_issue", {
          status: "completed",
          input: { title: "Ship the adapter" },
          output: "ENG-42",
          title: "Create issue: Ship the adapter",
          time: { start: 1, end: 2 },
        }),
      ],
      "s1",
    );
    expect(tools(out)[0]!.title).toBe("Create issue: Ship the adapter");
  });

  test("a tool still running is marked partial, not finished", () => {
    const out = normalizeOpencode(
      [
        tool("bash", {
          status: "running",
          input: { command: "cargo build" },
          title: "cargo build",
          time: { start: 1 },
        }),
      ],
      "s1",
    );
    const [t] = tools(out);
    expect(t!.status).toBe("running");
    expect(t!.partial).toBe(true);
    expect(reduceEvents(out).activeToolCalls).toHaveLength(1);
  });

  test("the same call updating twice is one card, not two", () => {
    const out = normalizeOpencode(
      [
        tool("bash", { status: "running", input: { command: "ls" } }),
        tool("bash", {
          status: "completed",
          input: { command: "ls" },
          output: "notes.md",
          metadata: { exit: 0, output: "notes.md" },
          time: { start: 1, end: 2 },
        }),
      ],
      "s1",
    );
    const settled = reduceEvents(out).events.filter(
      (e): e is ToolCallEvent => e.kind === "tool_call",
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe("completed");
    expect(settled[0]!.output).toBe("notes.md");
  });
});

describe("what a run cost", () => {
  test("context is the whole input side, cache included", () => {
    // OpenCode's own arithmetic on a real record: input 137 + output 6 +
    // cache.read 9088 == total 9231. `input` counts only the uncached share,
    // so the cache planes are additions — netting them out reports a context
    // smaller than the conversation.
    const out = normalizeOpencode([stepFinish("stop")], "s1");
    const [u] = usages(out);
    expect(u!.contextTokens).toBe(137 + 9088);
    expect(u!.outputTokens).toBe(6);
  });

  test("the closing card totals the whole run, not its last model call", () => {
    const cheap = { total: 0, input: 100, output: 10, reasoning: 0, cache: { write: 5, read: 20 } };
    const out = normalizeOpencode(
      [
        stepFinish("tool-calls", cheap, 0.01, "prt_s1"),
        tool("bash", { status: "completed", input: { command: "ls" }, metadata: { exit: 0 } }),
        stepFinish("stop", cheap, 0.02, "prt_s2"),
      ],
      "s1",
    );
    expect(usages(out)).toHaveLength(2);
    const [r] = results(out);
    expect(r!.usage).toEqual({
      inputTokens: 200,
      outputTokens: 20,
      cacheRead: 40,
      cacheWrite: 10,
    });
    expect(r!.costUsd).toBeCloseTo(0.03, 10);
    expect(r!.subtype).toBe("success");
  });

  test("a run that stopped to call a tool has not finished", () => {
    // `tool-calls` means another step follows. A stream that ends there was
    // killed or is still in flight — printing a completion card would claim
    // the work is done.
    const out = normalizeOpencode([stepFinish("tool-calls")], "s1");
    expect(results(out)).toHaveLength(0);
  });

  test("a run that ended in an error says so", () => {
    const out = normalizeOpencode([stepFinish("error")], "s1");
    expect(results(out)[0]!.subtype).toBe("error");
    expect(results(out)[0]!.stopReason).toBe("error");
  });

  test("hitting the output limit is a finish, and it is named", () => {
    const out = normalizeOpencode([stepFinish("length")], "s1");
    expect(results(out)[0]!.subtype).toBe("success");
    expect(results(out)[0]!.stopReason).toBe("length");
  });
});

describe("errors reach the human", () => {
  test("a provider failure is shown verbatim, not replaced with our own words", () => {
    // The complaint that started this work was a house error ("Internal
    // error: OpenCode service failure") standing in front of the real one.
    // Whatever the provider actually said is the only useful sentence here.
    const out = normalizeOpencode(
      [
        rec("retry", {
          id: "prt_r",
          type: "retry",
          attempt: 2,
          error: {
            name: "ProviderAuthError",
            data: { message: "z.ai: 401 invalid api key", statusCode: 401 },
          },
          time: { start: 1 },
        }),
      ],
      "s1",
    );
    const [e] = errors(out);
    expect(e!.message).toBe(
      "Attempt 2 failed: z.ai: 401 invalid api key — retrying.",
    );
    expect(e!.errorId).toBe("ProviderAuthError");
  });

  test("an error with no message still names the failure", () => {
    const out = normalizeOpencode(
      [rec("retry", { id: "prt_r", type: "retry", error: { name: "APIError" } })],
      "s1",
    );
    expect(errors(out)[0]!.message).toBe("APIError — retrying.");
  });
});

describe("the framing the CLI actually writes", () => {
  test("raw NDJSON parses without the caller pre-splitting it", () => {
    const blob = [
      JSON.stringify(rec("text", { id: "prt_b", type: "text", text: "One." })),
      JSON.stringify(stepFinish("stop")),
    ].join("\n");
    expect(texts(normalizeOpencode(blob, "s1")).map((t) => t.text)).toEqual(["One."]);
  });

  test("one unparseable line does not cost us the rest of the run", () => {
    const blob = [
      JSON.stringify(rec("text", { id: "prt_b", type: "text", text: "One." })),
      "{ this is not json",
      JSON.stringify(rec("text", { id: "prt_c", type: "text", text: "Two." })),
    ].join("\n");
    expect(texts(normalizeOpencode(blob, "s1")).map((t) => t.text)).toEqual([
      "One.",
      "Two.",
    ]);
  });

  test("a record missing its part still gets read from the envelope name", () => {
    const out = normalizeOpencode([{ type: "step_start", timestamp: 1 }], "s1");
    expect(out).toEqual([]);
  });
});

// The desktop app does not read a one-shot `run`; it reads OpenCode's own
// store (`opencode_record_read`), which reconstructs these same records and
// can see two things a `run` never emits — who spoke, and which model the
// session is bound to. Both are optional: a record without them normalizes
// exactly as it did before they existed.
describe("the fields only OpenCode's own store can supply", () => {
  test("a user's prompt is the user's, not another line from the assistant", () => {
    const out = normalizeOpencode(
      [
        { ...rec("text", { id: "prt_u", type: "text", text: "fix it" }), role: "user" },
        {
          ...rec("text", { id: "prt_a", type: "text", text: "Fixed." }),
          role: "assistant",
        },
      ],
      "s1",
    );
    expect(texts(out).map((t) => [t.role, t.source])).toEqual([
      ["user", "user"],
      ["assistant", "agent"],
    ]);
  });

  test("a run's records have no role and stay the assistant's", () => {
    // `opencode run --format json` emits one side of the conversation, so an
    // envelope without a role is the assistant's by construction.
    const out = normalizeOpencode(
      [rec("text", { id: "prt_a", type: "text", text: "Hello." })],
      "s1",
    );
    expect(texts(out)[0]!.role).toBe("assistant");
  });

  test("the session names the provider and model it is actually bound to", () => {
    // The complaint that sent people away from Conductor was never knowing
    // whether their own plan was in play. This is that fact, read from the
    // session row rather than from our catalog.
    const out = normalizeOpencode(
      [
        {
          type: "session_init",
          timestamp: 5,
          sessionID: "ses_1",
          cwd: "/repo",
          agent: "build",
          model: { id: "glm-5.2", providerID: "zai", variant: "default" },
          version: "1.18.11",
        },
      ],
      "s1",
    );
    const init = out.find((e) => e.kind === "session_init");
    expect(init).toBeDefined();
    expect(init).toMatchObject({
      // Spelled the way OpenCode's own `-m` flag takes it.
      model: "zai/glm-5.2",
      provider: "zai",
      cwd: "/repo",
      permissionMode: "build",
    });
  });

  test("a session with no model recorded says so instead of inventing one", () => {
    const out = normalizeOpencode(
      [{ type: "session_init", timestamp: 5, sessionID: "ses_1" }],
      "s1",
    );
    const init = out.find((e) => e.kind === "session_init");
    expect(init).toMatchObject({ model: null });
  });
});

describe("dispatching to the right adapter", () => {
  test("opencode is routed to opencode's parser, not codex's", () => {
    // Both declare the `json-events` ingress and share none of its vocabulary.
    // Binding by ingress would hand OpenCode a parser that understands nothing
    // it writes — and the symptom would be an empty chat, not an error.
    const out = normalizeStream(
      "opencode",
      [rec("text", { id: "prt_b", type: "text", text: "Routed." })],
      "s1",
    );
    expect(out).not.toBeNull();
    expect(texts(out!).map((t) => t.text)).toEqual(["Routed."]);
  });
});
