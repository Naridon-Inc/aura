import { describe, expect, test } from "bun:test";

import { normalizeCodex } from "./codex";
import { normalizeStream } from "../index";
import type { NormalizedEvent, TextEvent, ToolCallEvent } from "../events";

// The cases below are the shapes a real rollout actually contains, measured
// against `~/.codex/sessions/**/rollout-*.jsonl`. Codex writes several things
// twice — assistant prose lands as both an `event_msg` and a `response_item`,
// reasoning can arrive from either side — and it writes a lot that is not
// chat at all. Getting those wrong doesn't throw; it renders the conversation
// twice, or renders Codex's injected instruction blob as if the user typed it.

const evt = (type: string, payload: Record<string, unknown> = {}) => ({
  timestamp: "2026-08-01T00:00:00.000Z",
  type,
  payload: { type, ...payload },
});

/** `session_meta` / `turn_context` name themselves on the envelope and carry
 *  no `payload.type` — the adapter has to read the name from either place. */
const bare = (type: string, payload: Record<string, unknown>) => ({
  timestamp: "2026-08-01T00:00:00.000Z",
  type,
  payload,
});

const texts = (out: NormalizedEvent[]) =>
  out.filter((e): e is TextEvent => e.kind === "text");

const tools = (out: NormalizedEvent[]) =>
  out.filter((e): e is ToolCallEvent => e.kind === "tool_call");

describe("reading a Codex rollout as a conversation", () => {
  test("assistant prose written twice is rendered once", () => {
    // Measured on a real rollout: 24 `agent_message` and 24 assistant
    // `response_item/message`, overlapping exactly. Consuming both is the
    // difference between a chat and an echo.
    const out = normalizeCodex(
      [
        evt("agent_message", { message: "Fixed the retry loop.", phase: "final_answer" }),
        evt("message", { role: "assistant", content: [{ type: "output_text", text: "Fixed the retry loop." }] }),
      ],
      "s1",
    );
    expect(texts(out).map((t) => t.text)).toEqual(["Fixed the retry loop."]);
  });

  test("a rollout that only has the response_item still shows the answer", () => {
    // Older Codex builds wrote assistant prose only as a response_item.
    // Skipping it unconditionally would leave those sessions with an empty
    // chat and no error to explain why.
    const out = normalizeCodex(
      [evt("message", { role: "assistant", content: [{ type: "output_text", text: "Done." }] })],
      "s1",
    );
    expect(texts(out).map((t) => t.text)).toEqual(["Done."]);
  });

  test("Codex's injected instructions are not something the user said", () => {
    const out = normalizeCodex(
      [
        evt("message", { role: "developer", content: [{ type: "input_text", text: "You are Codex..." }] }),
        evt("message", { role: "user", content: [{ type: "input_text", text: "<environment_context>cwd=/tmp</environment_context>" }] }),
        evt("user_message", { message: "hi" }),
      ],
      "s1",
    );
    expect(texts(out).map((t) => t.text)).toEqual(["hi"]);
  });

  test("a tool call and its output are one card, not two", () => {
    const out = normalizeCodex(
      [
        evt("custom_tool_call", { call_id: "c1", name: "exec", input: "ls -la" }),
        evt("custom_tool_call_output", { call_id: "c1", output: "a\nb" }),
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
    // The command reads as a command, not as `Exec` over a JSON blob.
    expect(cards[0]!.title).toBe("Running ls -la");
    expect(cards[0]!.toolKind).toBe("execute");
  });

  test("a non-zero exit settles the card as an error", () => {
    const out = normalizeCodex(
      [
        evt("exec_command_begin", { call_id: "c1", command: ["cargo", "test"] }),
        evt("exec_command_end", { call_id: "c1", exit_code: 101, stdout: "", stderr: "boom" }),
      ],
      "s1",
    );
    const last = tools(out).at(-1)!;
    expect(last.status).toBe("error");
    expect(last.isError).toBe(true);
    expect(last.output).toBe("boom");
  });

  test("reasoning with nothing readable in it produces no card", () => {
    // Every `response_item/reasoning` in the sampled rollout — all 74 — had an
    // empty summary and an opaque `encrypted_content`. An empty thinking card
    // for each of them is worse than none.
    const out = normalizeCodex(
      [evt("reasoning", { summary: [], encrypted_content: "gAAAAA..." })],
      "s1",
    );
    expect(out.filter((e) => e.kind === "reasoning")).toHaveLength(0);
  });

  test("the same thought from both records is shown once", () => {
    const out = normalizeCodex(
      [
        evt("agent_reasoning", { text: "Checking the retry path." }),
        evt("reasoning", { summary: [{ type: "summary_text", text: "Checking the retry path." }] }),
      ],
      "s1",
    );
    expect(out.filter((e) => e.kind === "reasoning")).toHaveLength(1);
  });

  test("an applied patch carries the file it wrote", () => {
    const out = normalizeCodex(
      [
        evt("patch_apply_end", {
          call_id: "p1",
          turn_id: "t1",
          success: true,
          changes: { "/repo/src/main.rs": { type: "add", content: "fn main() {}" } },
        }),
      ],
      "s1",
    );
    const card = tools(out).at(-1)!;
    expect(card.title).toBe("Creating main.rs");
    expect(card.toolKind).toBe("edit");
    expect(card.content).toEqual([
      { type: "diff", path: "/repo/src/main.rs", oldText: undefined, newText: "fn main() {}" },
    ]);
    expect(card.locations).toEqual([{ path: "/repo/src/main.rs" }]);
  });

  test("cached input is a share of the input, not an addition to it", () => {
    // Codex's own arithmetic is `input + output == total`, so
    // `cached_input_tokens` names how much of `input_tokens` was a cache hit.
    // Adding the two puts a context figure on screen bigger than the
    // conversation — and it looks plausible, which is why it needs a test.
    const out = normalizeCodex(
      [
        evt("token_count", {
          info: {
            last_token_usage: {
              input_tokens: 18667,
              cached_input_tokens: 11008,
              cache_write_input_tokens: 0,
              output_tokens: 217,
              total_tokens: 18884,
            },
          },
        }),
      ],
      "s1",
    );
    expect(out.find((e) => e.kind === "usage")).toMatchObject({
      contextTokens: 18667,
      outputTokens: 217,
    });
  });

  test("a turn's token counts collapse into one running number", () => {
    // A rollout carries dozens of `token_count` records per turn. They are one
    // number changing, so they share an id and update in place.
    const usage = (n: number) =>
      evt("token_count", { info: { last_token_usage: { input_tokens: n, output_tokens: 1 } } });
    const out = normalizeCodex(
      [evt("task_started", { turn_id: "t1" }), usage(10), usage(20), usage(30)],
      "s1",
    );
    const ids = new Set(out.filter((e) => e.kind === "usage").map((e) => e.id));
    expect(ids.size).toBe(1);
  });

  test("the session card knows the model, which is not in session_meta", () => {
    const out = normalizeCodex(
      [
        bare("session_meta", { id: "abc", cwd: "/repo", model_provider: "openai" }),
        bare("turn_context", { model: "gpt-5.6-sol", turn_id: "t1" }),
      ],
      "s1",
    );
    const init = out.find((e) => e.kind === "session_init");
    expect(init).toMatchObject({ model: "gpt-5.6-sol", cwd: "/repo", provider: "openai" });
  });

  test("finishing a turn does not repeat the final answer", () => {
    // `task_complete.last_agent_message` is the agent_message verbatim; the
    // transcript already rendered it.
    const out = normalizeCodex(
      [
        evt("agent_message", { message: "All set." }),
        evt("task_complete", { turn_id: "t1", last_agent_message: "All set.", duration_ms: 4200 }),
      ],
      "s1",
    );
    expect(texts(out).map((t) => t.text)).toEqual(["All set."]);
    expect(out.find((e) => e.kind === "result")).toMatchObject({ durationMs: 4200 });
  });
});

describe("picking an adapter by agent", () => {
  const rollout = [evt("agent_message", { message: "hello" })];

  test("codex gets the codex adapter", () => {
    expect(normalizeStream("codex", rollout, "s1")).not.toBeNull();
  });

  test("opencode does not inherit it by sharing an ingress", () => {
    // Both declare `json-events`, which describes the transport's shape and
    // says nothing about the vocabulary inside. Binding by ingress would hand
    // OpenCode a parser for a schema it doesn't speak, and the symptom would
    // be an empty chat rather than an error. OpenCode has its own adapter now,
    // so the check is no longer "no adapter" but "not THIS adapter": Codex
    // records must not read as OpenCode chat.
    const out = normalizeStream("opencode", rollout, "s1");
    expect(out).not.toBeNull();
    expect(out!.filter((e) => e.kind === "text")).toEqual([]);
  });
});
