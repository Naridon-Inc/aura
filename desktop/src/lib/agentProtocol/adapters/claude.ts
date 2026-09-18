//! Claude Code adapter — maps the Anthropic stream-json wire (already parsed
//! into `StreamEvent` by the Rust backend + the session JSONL tailer) into the
//! engine-agnostic `NormalizedEvent` model.
//!
//! This is the reference adapter: Claude Code is the cleanest protocol, so
//! every other engine's adapter is judged against how completely it can fill
//! the same normalized shape. It runs over the WHOLE event array (not one
//! event at a time) so block ids are deterministic without the adapter holding
//! state — the reducer then folds same-id updates (a tool call's result onto
//! its request) in place.
//!
//! Special tool_use names are lifted out of the generic tool-card path into
//! first-class normalized events the way the ecosystem converges on:
//!   • `AskUserQuestion`  → `question_set` (sets + multiSelect)
//!   • `ExitPlanMode`     → `plan` awaiting Build/Revise
//!   • `TodoWrite`        → `todo` live checklist
//! Everything else is a `tool_call` state-machine object keyed by callId.

import type { StreamEvent } from "../../api";
import type { ToolResult } from "../../../components/manager/chat/types";
import { asObj, kindFor, norm, titleFor } from "./describe";
import type {
  NormalizedEvent,
  NormalizedQuestion,
  ToolContent,
  ToolKind,
  TodoItem,
} from "../events";

/** Parse Claude's `AskUserQuestion` input into normalized questions (a set,
 *  each possibly multi-select). A flat single-question input degrades to a
 *  one-entry set. */
function parseQuestions(input: unknown): NormalizedQuestion[] {
  const obj = asObj(input);
  const raw = Array.isArray(obj.questions) ? obj.questions : [];
  const out: NormalizedQuestion[] = raw
    .map((q, i): NormalizedQuestion | null => {
      const o = asObj(q);
      const prompt = String(o.question ?? o.header ?? "");
      const rawOpts = Array.isArray(o.options) ? o.options : [];
      const options = rawOpts
        .map((opt, j) => {
          const oo = asObj(opt);
          const label = String(oo.label ?? "");
          return label
            ? {
                optionId: String(oo.optionId ?? `${i}:${j}`),
                label,
                description: oo.description
                  ? String(oo.description)
                  : undefined,
              }
            : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      if (!prompt && options.length === 0) return null;
      return {
        id: String(o.header ?? `q${i}`),
        prompt,
        multiSelect: o.multiSelect === true,
        options: options.length ? options : undefined,
        freeText: options.length === 0,
      };
    })
    .filter((x): x is NormalizedQuestion => x !== null);
  if (out.length > 0) return out;
  // Flat `{ question: "…" }` (aura_ask) → single free-text question.
  const direct = obj.question ? String(obj.question) : "";
  return direct ? [{ id: "q0", prompt: direct, freeText: true }] : [];
}

function parseTodos(input: unknown): TodoItem[] {
  const obj = asObj(input);
  const raw = Array.isArray(obj.todos) ? obj.todos : [];
  return raw
    .map((t): TodoItem | null => {
      const o = asObj(t);
      const content = String(o.content ?? o.activeForm ?? o.title ?? "");
      if (!content) return null;
      const s = String(o.status ?? "").toLowerCase();
      const status: TodoItem["status"] =
        s === "completed" || s === "done"
          ? "completed"
          : s === "in_progress" || s === "running" || s === "active"
            ? "in_progress"
            : "pending";
      return {
        id: o.id ? String(o.id) : undefined,
        content,
        status,
        activeForm: o.activeForm ? String(o.activeForm) : undefined,
        priority: o.priority ? String(o.priority) : undefined,
      };
    })
    .filter((x): x is TodoItem => x !== null);
}

/** Build the richer typed output for a settled tool call. Edit/Write carry
 *  the literal text in their INPUT, so we emit a real `diff` content block
 *  (old→new) rather than dumping the raw result string. */
function toolContent(
  name: string,
  input: unknown,
  result: ToolResult,
): ToolContent[] {
  const obj = asObj(input);
  const n = norm(name);
  const path = String(obj.file_path ?? obj.path ?? "");
  if ((n === "edit" || n === "editfile") && path) {
    return [
      {
        type: "diff",
        path,
        oldText: obj.old_string != null ? String(obj.old_string) : undefined,
        newText: obj.new_string != null ? String(obj.new_string) : "",
      },
    ];
  }
  if ((n === "write" || n === "writefile") && path) {
    return [
      {
        type: "diff",
        path,
        newText: String(obj.content ?? obj.contents ?? ""),
      },
    ];
  }
  return result.content ? [{ type: "content", text: result.content }] : [];
}

/** Validate the wire boundary; a malformed known event is still inspectable. */
function isReadableEvent(value: unknown): value is StreamEvent {
  const e = asObj(value);
  if (typeof e.kind !== "string" || typeof e.turn_id !== "string") return false;
  switch (e.kind) {
    case "assistant_text":
    case "user_prompt":
      return typeof e.text === "string";
    case "system_init":
      return (
        typeof e.session_id === "string" &&
        Array.isArray(e.tools) &&
        e.tools.every((t) => typeof t === "string")
      );
    case "tool_use":
      return typeof e.id === "string" && typeof e.name === "string";
    case "tool_result":
      return (
        typeof e.tool_use_id === "string" &&
        typeof e.content === "string" &&
        typeof e.is_error === "boolean"
      );
    case "image":
      return (
        typeof e.data === "string" &&
        typeof e.media_type === "string" &&
        (e.role === "user" || e.role === "assistant")
      );
    case "usage":
      return [e.context_tokens, e.output_tokens].every(
        (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
      );
    case "result":
      return (
        typeof e.success === "boolean" && typeof e.duration_ms === "number"
      );
    case "content_block":
      return (
        (e.role === "user" || e.role === "assistant") &&
        typeof e.event_id === "string"
      );
    case "raw_error":
    case "aura_warning":
      return typeof e.message === "string";
    case "aura_snapshot":
      return typeof e.file_path === "string";
    default:
      return false;
  }
}

/** Stable per-turn block counter so distinct text/reasoning blocks within one
 *  turn get distinct ids (the wire carries no block index). */
type Counters = Map<string, number>;
function nextId(counters: Counters, turn: string, kind: string): string {
  const key = `${turn}:${kind}`;
  const n = (counters.get(key) ?? 0) + 1;
  counters.set(key, n);
  return `${key}:${n}`;
}

/** Normalize a Claude Code event stream into the engine-agnostic model.
 *  Pure + deterministic over the input array. `tool_use` and its matching
 *  `tool_result` share a callId so the reducer merges them; the result is
 *  emitted as a same-callId `tool_call` update with a settled status. */
export function normalizeClaude(
  events: StreamEvent[],
  sessionId: string,
): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const counters: Counters = new Map();
  // Index tool_use inputs by id so a later tool_result can recover the input
  // (for diff content + humanized title) it doesn't itself carry.
  const toolInputs = new Map<string, { name: string; input: unknown }>();
  // Only provider ids establish replay identity. Repeated words can be real
  // output; content equality must never erase a legitimate block.
  let ts = 0;

  for (const ev of events) {
    ts += 1; // monotonic ordinal; the wire has no per-event ms.
    if (!isReadableEvent(ev)) {
      out.push({
        kind: "raw",
        id: `raw:${ts}`,
        sessionId,
        ts,
        source: "environment",
        label: "Unrecognized event",
        payload: ev,
      });
      continue;
    }
    const start = out.length;
    switch (ev.kind) {
      case "content_block": {
        const b = asObj(ev.payload);
        const id = ev.event_id || nextId(counters, ev.turn_id, "content");
        const base = {
          id,
          sessionId,
          ts,
          source: ev.role === "user" ? ("user" as const) : ("agent" as const),
        };
        if (b.type === "turn_cancelled") {
          out.push({
            ...base,
            id: `${ev.turn_id}:result`,
            kind: "result",
            subtype: "cancelled",
          });
        } else if (b.type === "acp_update") {
          const u = asObj(b.update),
            content = asObj(u.content),
            type = String(u.sessionUpdate ?? "");
          if (
            (type === "agent_message_chunk" || type === "user_message_chunk") &&
            content.type === "text"
          ) {
            out.push({
              ...base,
              kind: "text",
              role: type === "user_message_chunk" ? "user" : "assistant",
              text: String(content.text ?? ""),
            });
          } else if (
            type === "agent_thought_chunk" &&
            content.type === "text"
          ) {
            out.push({
              ...base,
              kind: "reasoning",
              text: String(content.text ?? ""),
            });
          } else if (type === "tool_call" || type === "tool_call_update") {
            const callId = `${ev.turn_id}:acp-tool:${u.toolCallId}`;
            const name = String(u.title ?? "tool"),
              input = asObj(u.rawInput);
            const status =
              u.status === "completed"
                ? "completed"
                : u.status === "failed"
                  ? "error"
                  : u.status === "pending"
                    ? "pending"
                    : "running";
            const kinds = new Set([
              "read",
              "edit",
              "delete",
              "move",
              "search",
              "execute",
              "think",
              "fetch",
              "switch_mode",
              "other",
            ]);
            const parts: ToolContent[] = Array.isArray(u.content)
              ? u.content.map((p) => {
                  const c = asObj(p);
                  if (c.type === "diff")
                    return {
                      type: "diff",
                      path: String(c.path ?? ""),
                      oldText:
                        typeof c.oldText === "string" ? c.oldText : undefined,
                      newText: String(c.newText ?? ""),
                    } as ToolContent;
                  const inner = asObj(c.content);
                  return {
                    type: "content",
                    text:
                      inner.type === "text"
                        ? String(inner.text ?? "")
                        : JSON.stringify(p),
                  } as ToolContent;
                })
              : [];
            out.push({
              ...base,
              id: callId,
              kind: "tool_call",
              callId,
              toolName: name,
              title: u.title ? String(u.title) : "",
              toolKind: kinds.has(String(u.kind))
                ? (u.kind as ToolKind)
                : "other",
              input,
              status,
              partial: status === "pending" || status === "running",
              content: parts.length ? parts : undefined,
              output:
                u.rawOutput != null
                  ? typeof u.rawOutput === "string"
                    ? u.rawOutput
                    : JSON.stringify(u.rawOutput)
                  : undefined,
              locations: Array.isArray(u.locations)
                ? u.locations.map((l) => ({
                    path: String(asObj(l).path ?? ""),
                    line:
                      typeof asObj(l).line === "number"
                        ? (asObj(l).line as number)
                        : undefined,
                  }))
                : undefined,
            });
          } else if (type === "plan") {
            out.push({
              ...base,
              id: `${ev.turn_id}:plan`,
              kind: "plan",
              awaitingApproval: false,
              entries: Array.isArray(u.entries)
                ? u.entries.map((p) => ({
                    content: String(asObj(p).content ?? ""),
                    status:
                      asObj(p).status === "completed"
                        ? "completed"
                        : asObj(p).status === "in_progress"
                          ? "in_progress"
                          : "pending",
                  }))
                : [],
            });
          } else if (
            content.type === "image" &&
            typeof content.data === "string"
          ) {
            out.push({
              ...base,
              kind: "image",
              role: "assistant",
              data: content.data,
              mediaType: String(content.mimeType ?? "image/png"),
            });
          } else {
            out.push({
              ...base,
              kind: "raw",
              label: type.replace(/_/g, " ") || "Agent update",
              payload: u,
            });
          }
        } else if (b.type === "text" && typeof b.text === "string") {
          out.push({ ...base, kind: "text", role: ev.role, text: b.text });
        } else if (b.type === "thinking" && typeof b.thinking === "string") {
          out.push({ ...base, kind: "reasoning", text: b.thinking });
        } else if (
          b.type === "image" &&
          asObj(b.source).type === "base64" &&
          typeof asObj(b.source).data === "string"
        ) {
          const src = asObj(b.source);
          out.push({
            ...base,
            kind: "image",
            role: ev.role,
            mediaType: String(src.media_type ?? "image/png"),
            data: String(src.data),
          });
        } else {
          out.push({
            ...base,
            kind: "raw",
            label: String(b.type ?? "Content"),
            payload: ev.payload,
          });
        }
        break;
      }
      case "user_prompt":
        out.push({
          kind: "text",
          id: nextId(counters, ev.turn_id, "user"),
          sessionId,
          ts,
          source: "user",
          role: "user",
          text: ev.text,
        });
        break;
      case "system_init":
        out.push({
          kind: "session_init",
          id: `${ev.session_id}:init`,
          sessionId,
          ts,
          source: "agent",
          model: ev.model,
          tools: ev.tools,
        });
        break;
      case "assistant_text": {
        out.push({
          kind: "text",
          id: ev.event_id || nextId(counters, ev.turn_id, "assistant"),
          sessionId,
          ts,
          source: "agent",
          role: "assistant",
          text: ev.text,
        });
        break;
      }
      case "usage":
        // Keyed by the model's message id so a re-emit (reconnect / resumed-
        // session history overlapping the live tail) merges in the reducer
        // instead of getting a fresh counter id and double-counting. A blank
        // id (older backend) falls back to an ordinal so it still renders.
        out.push({
          kind: "usage",
          id: ev.message_id
            ? `usage:${ev.message_id}`
            : nextId(counters, ev.turn_id, "usage"),
          sessionId,
          ts,
          source: "agent",
          contextTokens: ev.context_tokens,
          outputTokens: ev.output_tokens,
        });
        break;
      case "tool_use": {
        toolInputs.set(ev.id, { name: ev.name, input: ev.input });
        const n = norm(ev.name);
        if (n === "askuserquestion" || n === "askuser" || n === "ask") {
          const questions = parseQuestions(ev.input);
          if (questions.length) {
            out.push({
              kind: "question_set",
              id: ev.id,
              sessionId,
              ts,
              source: "agent",
              partial: true,
              requestId: ev.id,
              questions,
            });
            break;
          }
        }
        if (n === "exitplanmode" || n === "exitplan") {
          const obj = asObj(ev.input);
          out.push({
            kind: "plan",
            id: ev.id,
            sessionId,
            ts,
            source: "agent",
            entries: [],
            markdown: obj.plan ? String(obj.plan) : undefined,
            awaitingApproval: true,
            requestId: ev.id,
          });
          break;
        }
        if (n === "todowrite" || n === "todos") {
          out.push({
            kind: "todo",
            id: ev.id,
            sessionId,
            ts,
            source: "agent",
            todos: parseTodos(ev.input),
          });
          break;
        }
        out.push({
          kind: "tool_call",
          id: ev.id,
          sessionId,
          ts,
          source: "agent",
          partial: true,
          callId: ev.id,
          toolKind: kindFor(ev.name, ev.input),
          status: "running",
          toolName: ev.name,
          title: titleFor(ev.name, ev.input),
          input: asObj(ev.input),
        });
        break;
      }
      case "tool_result": {
        const prior = toolInputs.get(ev.tool_use_id);
        const name = prior?.name ?? "tool";
        const input = prior?.input ?? {};
        const result: ToolResult = {
          is_error: ev.is_error,
          content: ev.content,
        };
        // TodoWrite / AskUserQuestion / ExitPlanMode already rendered as their
        // own event, so none of them emits a tool_call update. But the results
        // of the two INTERACTIVE ones are not noise — they are the only signal
        // that the human answered, and what they picked. Dropping them left
        // every question in the session rendered as a live, clickable prompt
        // forever, and every plan stuck at "awaiting your go-ahead" long after
        // it was approved. Re-emit the SAME id so the reducer settles the
        // original in place rather than appending a second card.
        const n = norm(name);
        if (ev.is_error && ["askuserquestion", "askuser", "ask", "exitplanmode", "exitplan", "todowrite", "todos"].includes(n)) {
          out.push({kind:"error", id:`${ev.tool_use_id}:error`, sessionId, ts, source:"environment", message:ev.content || `${name} failed`});
        }
        if (n === "askuserquestion" || n === "askuser" || n === "ask") {
          out.push({
            kind: "question_set",
            id: ev.tool_use_id,
            sessionId,
            ts,
            source: "user",
            requestId: ev.tool_use_id,
            // The questions stay on the event the reducer already holds; this
            // update carries only what it learned.
            questions: [],
            answer: ev.content,
            partial: false,
            resolution: { text: ev.content, isError: ev.is_error },
          });
          break;
        }
        if (n === "exitplanmode" || n === "exitplan") {
          out.push({
            kind: "plan",
            id: ev.tool_use_id,
            sessionId,
            ts,
            source: "user",
            entries: [],
            awaitingApproval: false,
            // Claude reports a declined plan as an error result; an accepted
            // one comes back clean.
            decision: ev.is_error ? "rejected" : "approved",
            requestId: ev.tool_use_id,
          });
          break;
        }
        if (n === "todowrite" || n === "todos") {
          break;
        }
        out.push({
          kind: "tool_call",
          id: ev.tool_use_id,
          sessionId,
          ts,
          source: "environment",
          callId: ev.tool_use_id,
          toolKind: kindFor(name, input),
          status: ev.is_error ? "error" : "completed",
          toolName: name,
          title: titleFor(name, input, result),
          input: asObj(input),
          content: toolContent(name, input, result),
          output: ev.content,
          isError: ev.is_error,
        });
        break;
      }
      case "result":
        out.push({
          kind: "result",
          id: `${ev.turn_id}:result`,
          sessionId,
          ts,
          source: "agent",
          subtype: ev.success ? "success" : "error",
          text: ev.message ?? undefined,
          totalTokens: ev.total_tokens ?? undefined,
          costUsd: ev.cost_usd ?? undefined,
          durationMs: ev.duration_ms,
        });
        break;
      case "raw_error":
        out.push({
          kind: "error",
          id: `${ev.turn_id}:error:${ts}`,
          sessionId,
          ts,
          source: "agent",
          message: ev.message,
        });
        break;
      case "image":
        // Legacy images carry no identity. Preserve every attachment rather
        // than merging different pictures that happen to share a PNG header.
        out.push({
          kind: "image",
          id: nextId(counters, ev.turn_id, `image:${ev.role}`),
          sessionId,
          ts,
          source: ev.role === "user" ? "user" : "agent",
          role: ev.role,
          mediaType: ev.media_type,
          data: ev.data,
        });
        break;
      // `aura_snapshot` / `aura_warning` are frontend-injected hook side
      // effects, not wire events — they stay in the raw stream and out of the
      // normalized model, which is faithful, not a gap.
      case "aura_snapshot":
        break;
      case "aura_warning":
        out.push({
          kind: "status",
          id: `warning:${ts}`,
          sessionId,
          ts,
          source: "hook",
          state: "idle",
          message: ev.message,
        });
        break;
      default:
        out.push({
          kind: "raw",
          id: `raw:${ts}`,
          sessionId,
          ts,
          source: "environment",
          label: "Unrecognized event",
          payload: ev,
        });
        break;
    }
    for (let i = start; i < out.length; i++) out[i].turnId = ev.turn_id;
  }
  return out;
}
