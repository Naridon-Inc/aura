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
                description: oo.description ? String(oo.description) : undefined,
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
    return [{ type: "diff", path, newText: String(obj.content ?? obj.contents ?? "") }];
  }
  return result.content ? [{ type: "content", text: result.content }] : [];
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
  // `assistant_text` carries NO stable id — its block id is minted from a
  // per-turn counter below. But the source event array is append-only and the
  // backend / JSONL tailer can re-emit the SAME assistant line (reconnect, or a
  // resumed-session history overlapping the live tail). Two identical lines
  // would then get DIFFERENT generated ids and render the paragraph twice. So
  // we dedup assistant prose by exact text, scoped to its own turn_id: same
  // line + same turn = re-emit, skip it. A different turn genuinely repeating
  // the same words is real agent output, not a bug, so we never dedup across
  // turns. Exact-string equality only — no substring/prefix — to stay
  // conservative; this Map is local to one call, so normalizeClaude stays pure
  // and deterministic over the input array.
  const seenAssistantText = new Map<string, Set<string>>();
  let ts = 0;

  for (const ev of events) {
    ts += 1; // monotonic ordinal; the wire has no per-event ms.
    switch (ev.kind) {
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
        // Skip a re-emitted identical line within the same turn (see
        // `seenAssistantText` above). Empty/whitespace-only text never poisons
        // the dedup set — behavior for it is unchanged; only non-empty prose is
        // tracked, and a repeat of non-empty prose is dropped (no push, and the
        // assistant counter is NOT advanced for the skipped line).
        const trimmed = ev.text.trim();
        if (trimmed) {
          let seen = seenAssistantText.get(ev.turn_id);
          if (!seen) {
            seen = new Set<string>();
            seenAssistantText.set(ev.turn_id, seen);
          }
          if (seen.has(ev.text)) break;
          seen.add(ev.text);
        }
        out.push({
          kind: "text",
          id: nextId(counters, ev.turn_id, "assistant"),
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
          id: ev.message_id ? `usage:${ev.message_id}` : nextId(counters, ev.turn_id, "usage"),
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
        // own event; their results are noise. Skip emitting a tool_call update
        // for them.
        const n = norm(name);
        if (
          n === "todowrite" ||
          n === "todos" ||
          n === "askuserquestion" ||
          n === "askuser" ||
          n === "exitplanmode" ||
          n === "exitplan"
        ) {
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
          usage: ev.total_tokens
            ? { inputTokens: 0, outputTokens: ev.total_tokens }
            : undefined,
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
        // A screenshot the user attached, or one the agent read back / made.
        // Keyed by role + size + a content prefix so a re-emit (reconnect /
        // resumed history overlap) merges instead of duplicating the picture.
        out.push({
          kind: "image",
          id: `image:${ev.role}:${ev.data.length}:${ev.data.slice(0, 24)}`,
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
      default:
        break;
    }
  }
  return out;
}
