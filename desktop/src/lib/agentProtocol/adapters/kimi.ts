//! Kimi adapter — maps Kimi Code's `wire.jsonl` into the engine-agnostic
//! `NormalizedEvent` model.
//!
//! Kimi runs as a full TUI in a PTY, so the obvious source for its chat is the
//! terminal, and it is the wrong one for the same reason it was wrong for
//! Codex: a terminal reproduces the SCREEN, and Kimi's screen is largely its
//! own furniture — the prompt echoed back under a ✨, the box-drawn composer,
//! the `K3 thinking: high … context: 0% (0/256k)` status footer. None of that
//! is anything the agent said. So the chat reads Kimi's own record instead:
//! `~/.kimi-code/sessions/**/agents/main/wire.jsonl`, tailed by
//! `kimi_wire_read`.
//!
//! The wire is a flat stream of `{type, …}` records. Most of the conversation
//! rides inside `context.append_loop_event`, whose `event.type` is the real
//! discriminator — `content.part`, `tool.call`, `tool.result`, `step.begin`,
//! `step.end`.
//!
//! Three shapes of duplicate in that file, each of which would render the
//! conversation twice, and how this handles them:
//!
//!   • Every `turn.prompt` is written again as a `context.append_message`
//!     with `role: "user"` — measured 9 of 9 on real sessions. `turn.prompt`
//!     is the one we consume.
//!   • Assistant prose arrives as `content.part` with `type: "text"` in
//!     current builds, and as a `context.append_message` with
//!     `role: "assistant"` in older ones. Measured across ten sessions, a
//!     session uses one shape or the other and never both, but consuming both
//!     unconditionally would double any session that ever did — so the
//!     append_message path is a fallback, not a second source.
//!   • `step.end` and `usage.record` carry byte-identical token counts (53 of
//!     53). Only `usage.record` is read; it also names the model.
//!
//! `context.append_message` with `origin.kind: "injection"` is context Kimi
//! fed itself, not something a person typed, and `role: "tool"` messages are
//! the tool results already rendered as cards. Both are skipped.

import { asObj, kindFor, titleFor } from "./describe";
import type { NormalizedEvent, TodoItem, ToolContent } from "../events";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Text out of a `content` array of `{type, text}` parts, or a bare string. */
function textOf(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((part) => textOf(part))
      .filter((s) => s !== "")
      .join("");
  }
  const o = asObj(v);
  if (typeof o.text === "string") return o.text;
  if (o.content != null) return textOf(o.content);
  return "";
}

/** The event a record actually describes: loop events name themselves on the
 *  nested `event`, everything else on the record. */
function recordKind(r: Record<string, unknown>): string {
  if (r.type === "context.append_loop_event") {
    return `loop:${String(asObj(r.event).type ?? "")}`;
  }
  return String(r.type ?? "");
}

/** The model this session ran on. It is not in the opening `metadata` record —
 *  it arrives later on `usage.record` / `llm.request` / `config.update` — so
 *  the session card would say "unknown" if we only read the first record. */
function modelOf(records: unknown[]): string | null {
  for (const rec of records) {
    const r = asObj(rec);
    const m = str(r.model) ?? str(r.modelAlias);
    if (m) return m;
  }
  return null;
}

/** The tools this session had available, from the last `set_active_tools`. */
function toolsOf(records: unknown[]): string[] {
  let names: string[] = [];
  for (const rec of records) {
    const r = asObj(rec);
    if (r.type !== "tools.set_active_tools" || !Array.isArray(r.names)) continue;
    names = (r.names as unknown[]).map((n) => String(n));
  }
  return names;
}

type Counters = Map<string, number>;
function nextId(counters: Counters, turn: string, kind: string): string {
  const key = `${turn}:${kind}`;
  const n = (counters.get(key) ?? 0) + 1;
  counters.set(key, n);
  return `${key}:${n}`;
}

type OpenCall = { name: string; input: Record<string, unknown> };

/** Kimi's own rendering hint for a tool call. `file_io` carries the path and,
 *  for an edit, both sides of the change — which is a real diff we would
 *  otherwise have to reconstruct from the raw args. */
function displayContent(display: Record<string, unknown>): ToolContent[] {
  const path = str(display.path);
  const operation = str(display.operation);
  if (!path) return [];
  if (operation === "edit") {
    const before = str(display.before);
    const after = str(display.after);
    if (after != null) return [{ type: "diff", path, oldText: before, newText: after }];
  }
  if (operation === "write") {
    const content = str(display.content);
    if (content != null) return [{ type: "diff", path, newText: content }];
  }
  return [];
}

/** Kimi's todo statuses. `done` is its word for what the shared model calls
 *  `completed`; passing it through unmapped leaves a finished item rendering
 *  as if it were still open. */
function todoStatus(v: unknown): TodoItem["status"] {
  const s = str(v);
  if (s === "done" || s === "completed") return "completed";
  if (s === "in_progress") return "in_progress";
  return "pending";
}

/** Normalize a Kimi wire into the engine-agnostic model.
 *  Pure + deterministic over the input array: the wire is append-only, so
 *  re-running this over a longer prefix mints the same ids for the records it
 *  already saw and the reducer folds updates in place. */
export function normalizeKimi(raw: unknown, sessionId: string): NormalizedEvent[] {
  const records: unknown[] = Array.isArray(raw) ? raw : [];
  const out: NormalizedEvent[] = [];
  const counters: Counters = new Map();
  const calls = new Map<string, OpenCall>();
  const model = modelOf(records);
  const tools = toolsOf(records);

  // Older sessions wrote assistant prose ONLY as an appended message; current
  // ones stream it as content parts. Consuming both when both exist renders
  // every reply twice, so the message path is a fallback, not a second source.
  const hasTextParts = records.some((rec) => {
    const r = asObj(rec);
    if (recordKind(r) !== "loop:content.part") return false;
    return asObj(asObj(r.event).part).type === "text";
  });
  const hasPrompts = records.some((rec) => asObj(rec).type === "turn.prompt");

  let ts = 0;
  let turn = "t0";
  let prompts = 0;

  const openCall = (callId: string, name: string, input: Record<string, unknown>) => {
    calls.set(callId, { name, input });
    out.push({
      kind: "tool_call",
      id: `tool:${callId}`,
      sessionId,
      ts,
      source: "agent",
      callId,
      toolKind: kindFor(name, input),
      status: "running",
      toolName: name,
      title: titleFor(name, input),
      input,
    });
  };

  for (const rec of records) {
    const r = asObj(rec);
    const e = asObj(r.event);
    ts += 1; // monotonic ordinal; the wire's own `time` is per-record epoch ms.

    const t = str(e.turnId);
    if (t) turn = t;

    switch (recordKind(r)) {
      case "metadata":
        out.push({
          kind: "session_init",
          id: "session",
          sessionId,
          ts,
          source: "environment",
          model,
          tools,
        });
        break;

      case "turn.prompt": {
        const text = textOf(r.input).trim();
        prompts += 1;
        // A prompt opens a turn, and it lands before the first `step.begin`
        // that would name one — so the turn it belongs to has to be minted
        // here or its id would be the previous turn's.
        turn = `p${prompts}`;
        if (!text) break;
        out.push({
          kind: "text",
          id: nextId(counters, turn, "user"),
          sessionId,
          ts,
          source: "user",
          role: "user",
          text,
        });
        break;
      }

      case "context.append_message": {
        const m = asObj(r.message);
        const role = str(m.role);
        // Tool results are already rendered as cards by `loop:tool.result`.
        if (role === "tool") break;
        // Context Kimi fed itself — AGENTS.md, environment, resumed history.
        // It is not something a person typed and is not chat.
        if (str(asObj(m.origin).kind) === "injection") break;
        if (role === "user" && hasPrompts) break;
        if (role === "assistant" && hasTextParts) break;
        const text = textOf(m.content).trim();
        if (!text) break;
        out.push({
          kind: "text",
          id: nextId(counters, turn, role === "assistant" ? "assistant" : "user"),
          sessionId,
          ts,
          source: role === "assistant" ? "agent" : "user",
          role: role === "assistant" ? "assistant" : "user",
          text,
        });
        break;
      }

      case "loop:content.part": {
        const part = asObj(e.part);
        const think = str(part.think);
        if (think) {
          out.push({
            kind: "reasoning",
            id: nextId(counters, turn, "reasoning"),
            sessionId,
            ts,
            source: "agent",
            text: think.trim(),
          });
          break;
        }
        const text = str(part.text)?.trim();
        if (!text) break;
        out.push({
          kind: "text",
          id: nextId(counters, turn, "assistant"),
          sessionId,
          ts,
          source: "agent",
          role: "assistant",
          text,
        });
        break;
      }

      case "loop:tool.call": {
        const callId = str(e.toolCallId);
        if (!callId) break;
        const name = str(e.name) ?? "tool";
        const display = asObj(e.display);
        // The args are what the tool was actually given; `display` adds the
        // cwd Kimi resolved the command in, which the args do not carry.
        const input = { ...asObj(e.args) };
        const cwd = str(display.cwd);
        if (cwd && input.cwd == null) input.cwd = cwd;
        openCall(callId, name, input);
        break;
      }

      case "loop:tool.result": {
        const callId = str(e.toolCallId);
        if (!callId) break;
        const result = asObj(e.result);
        const open = calls.get(callId) ?? { name: "tool", input: {} };
        const output = textOf(result.output ?? "");
        const isError = result.isError === true;
        const content = displayContent(asObj(e.display));
        out.push({
          kind: "tool_call",
          id: `tool:${callId}`,
          sessionId,
          ts,
          source: "environment",
          callId,
          toolKind: kindFor(open.name, open.input),
          status: isError ? "error" : "completed",
          toolName: open.name,
          title: titleFor(open.name, open.input, { is_error: isError, content: output }),
          input: open.input,
          content: content.length > 0
            ? content
            : output
              ? [{ type: "content", text: output }]
              : [],
          output: output || undefined,
          isError: isError || undefined,
          locations: str(open.input.path) ? [{ path: String(open.input.path) }] : undefined,
        });
        break;
      }

      case "permission.record_approval_result": {
        // Written AFTER the human decided, so it is a record of the decision,
        // not a prompt to render. It matters for the one case the transcript
        // cannot otherwise explain: a REJECTED call never produces a
        // `tool.result`, so its card would sit spinning forever.
        const decision = str(asObj(r.result).decision);
        if (decision === "approved") break;
        const callId = str(r.toolCallId);
        if (!callId) break;
        const open = calls.get(callId) ?? { name: str(r.toolName) ?? "tool", input: {} };
        out.push({
          kind: "tool_call",
          id: `tool:${callId}`,
          sessionId,
          ts,
          source: "user",
          callId,
          toolKind: kindFor(open.name, open.input),
          status: "cancelled",
          toolName: open.name,
          title: titleFor(open.name, open.input),
          input: open.input,
        });
        break;
      }

      case "tools.update_store": {
        if (str(r.key) !== "todo" || !Array.isArray(r.value)) break;
        out.push({
          kind: "todo",
          // One checklist per session, replaced wholesale as it changes.
          id: "todo",
          sessionId,
          ts,
          source: "agent",
          todos: (r.value as unknown[]).map((item) => {
            const it = asObj(item);
            return {
              content: str(it.title) ?? str(it.content) ?? "",
              status: todoStatus(it.status),
            };
          }),
        });
        break;
      }

      case "usage.record": {
        const usage = asObj(r.usage);
        out.push({
          kind: "usage",
          // One usage event per turn, re-emitted under the same id as the
          // count climbs — a session carries one of these per step and they
          // are one number changing, not a fact per step.
          id: `${turn}:usage`,
          sessionId,
          ts,
          source: "environment",
          // Kimi splits the input side three ways and each names a DIFFERENT
          // slice: `inputOther` is what was not cached at all, the two cache
          // fields are what was read from and written to the cache. Unlike
          // Codex — whose `input_tokens` is already the whole input, with the
          // cached count naming a share of it — these are addends. Dropping
          // the cache planes here would report a context far smaller than the
          // conversation, which is the same class of bug in the other
          // direction.
          contextTokens:
            num(usage.inputOther) +
            num(usage.inputCacheRead) +
            num(usage.inputCacheCreation),
          outputTokens: num(usage.output),
        });
        break;
      }

      case "loop:step.end": {
        // Only the step that ENDS the turn is a result; the rest hand off to
        // another tool call and the turn is still running.
        if (str(e.finishReason) !== "end_turn") break;
        out.push({
          kind: "result",
          id: `${turn}:result`,
          sessionId,
          ts,
          source: "environment",
          subtype: "success",
          durationMs:
            typeof e.llmStreamDurationMs === "number" ? e.llmStreamDurationMs : undefined,
        });
        break;
      }

      // Kimi's own bookkeeping — `config.update`, `llm.request`,
      // `llm.tools_snapshot`, `mcp.tools_discovered`, `permission.set_mode`,
      // `tools.set_active_tools`, `loop:step.begin`. Read above for the model,
      // the tool list and the turn id; nothing here is chat.
      default:
        break;
    }
  }

  return out;
}
