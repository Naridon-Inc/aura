//! Codex adapter — maps Codex's rollout JSONL into the engine-agnostic
//! `NormalizedEvent` model.
//!
//! Codex runs as a full TUI in a PTY, so the obvious source for its chat is
//! the terminal. It is the wrong one: a terminal faithfully reproduces the
//! SCREEN, and a CLI's screen is mostly its own furniture — the prompt it
//! echoes back, the composer placeholder ("Improve documentation in @file"),
//! the model/cwd status footer. None of that is anything the agent said, and
//! no amount of grid fidelity separates the two, because on the screen they
//! are the same pixels. So the chat reads Codex's own structured record
//! instead: `~/.codex/sessions/**/rollout-*.jsonl`, tailed by
//! `codex_rollout_read`. What the agent said is a field in there, not
//! something to be recovered by guessing at layout.
//!
//! Two shapes of duplicate in that file that would each render everything
//! twice, and how this handles them:
//!
//!   • Assistant prose is written BOTH as `event_msg/agent_message` and as
//!     `response_item/message` with `role: "assistant"` — measured on a real
//!     rollout, 24 and 24, overlapping exactly. We consume the `event_msg`
//!     one (it carries `phase`) and skip the response_item, falling back to
//!     the response_item only when a rollout has no `agent_message` records
//!     at all, which is how older Codex builds wrote it.
//!   • Reasoning can arrive as `event_msg/agent_reasoning` and again as a
//!     `response_item/reasoning` summary. Those are deduped by exact text.
//!
//! Everything Codex writes for its own bookkeeping — `world_state`,
//! `turn_context`, `thread_settings_applied`, the `developer`-role messages
//! carrying injected instructions — is deliberately not chat, and is skipped.

import { asObj, kindFor, norm, titleFor } from "./describe";
import type { NormalizedEvent, ToolContent, ToolKind } from "../events";

/** Codex tool names routed to the describe registry's vocabulary, so an
 *  `exec` card says "Running <command>" like every other engine's shell tool
 *  rather than "Exec" with a JSON blob under it. */
const TOOL_ALIAS: Record<string, string> = {
  exec: "bash",
  shell: "bash",
  local_shell: "bash",
  apply_patch: "write",
};

function aliasOf(name: string): string {
  return TOOL_ALIAS[norm(name)] ?? name;
}

/** Codex hands a tool its arguments three different ways: a bare string (the
 *  script `exec` is about to run), a JSON string (`function_call.arguments`),
 *  or an object. Land all three on the object the describe registry wants. */
function toolInput(name: string, raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try {
        return asObj(JSON.parse(trimmed));
      } catch {
        // Not JSON after all — fall through and treat it as the command.
      }
    }
    return aliasOf(name) === "bash" ? { command: raw } : { input: raw };
  }
  return asObj(raw);
}

/** Pull readable text out of a tool result. Codex writes outputs as a plain
 *  string, as a list of `{type, text}` parts, or as an MCP result object. */
function textOf(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((part) => textOf(part))
      .filter((s) => s !== "")
      .join("\n");
  }
  const o = asObj(v);
  if (typeof o.text === "string") return o.text;
  if (o.content != null) return textOf(o.content);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/** Milliseconds from either a number or serde's `{secs, nanos}` Duration. */
function durationMs(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  const o = asObj(v);
  if (typeof o.secs === "number") {
    const nanos = typeof o.nanos === "number" ? o.nanos : 0;
    return o.secs * 1000 + nanos / 1e6;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** The record name, wherever this record happens to carry it: `event_msg` and
 *  `response_item` name themselves on the payload, while `session_meta`,
 *  `turn_context` and `world_state` name themselves on the envelope. */
function recordKind(r: Record<string, unknown>, p: Record<string, unknown>): string {
  return typeof p.type === "string" ? p.type : String(r.type ?? "");
}

/** The model Codex ran this session on. It is not in `session_meta` — it
 *  arrives later on `turn_context` / `thread_settings_applied` — so the
 *  session card would say "unknown" if we only looked at the first record. */
function modelOf(records: unknown[]): string | null {
  for (const rec of records) {
    const p = asObj(asObj(rec).payload);
    const settings = asObj(p.thread_settings);
    const m = str(settings.model) ?? str(p.model);
    if (m) return m;
  }
  return null;
}

/** Stable per-turn block counter so distinct text blocks within one turn get
 *  distinct ids (the rollout carries no block index). Mirrors the Claude
 *  adapter, which is why the reducer can treat both alike. */
type Counters = Map<string, number>;
function nextId(counters: Counters, turn: string, kind: string): string {
  const key = `${turn}:${kind}`;
  const n = (counters.get(key) ?? 0) + 1;
  counters.set(key, n);
  return `${key}:${n}`;
}

/** A tool call this rollout already opened, so its `_output` record can title
 *  itself from the request it is answering. */
type OpenCall = { name: string; input: Record<string, unknown> };

/** Diff/content blocks for one `apply_patch`. */
function patchContent(changes: Record<string, unknown>): ToolContent[] {
  const out: ToolContent[] = [];
  for (const [path, raw] of Object.entries(changes)) {
    const c = asObj(raw);
    const unified = str(c.unified_diff);
    if (unified) {
      out.push({ type: "content", text: unified });
      continue;
    }
    const content = str(c.content);
    if (content != null) {
      // `add` writes a whole new file, so there is no old side to show.
      out.push({
        type: "diff",
        path,
        oldText: c.type === "add" ? undefined : str(c.old_content),
        newText: content,
      });
      continue;
    }
    out.push({ type: "content", text: `${str(c.type) ?? "changed"} ${path}` });
  }
  return out;
}

function patchTitle(changes: Record<string, unknown>): string {
  const paths = Object.keys(changes);
  if (paths.length === 0) return "Applying a patch";
  if (paths.length > 1) return `Editing ${paths.length} files`;
  const only = paths[0]!;
  const type = str(asObj(changes[only]).type);
  const verb =
    type === "add" ? "Creating" : type === "delete" ? "Deleting" : "Editing";
  return `${verb} ${basename(only)}`;
}

function patchKind(changes: Record<string, unknown>): ToolKind {
  const types = Object.values(changes).map((c) => str(asObj(c).type));
  return types.length > 0 && types.every((t) => t === "delete") ? "delete" : "edit";
}

/** Normalize a Codex rollout into the engine-agnostic model.
 *  Pure + deterministic over the input array: the rollout is append-only, so
 *  re-running this over a longer prefix mints the same ids for the records it
 *  already saw and the reducer folds updates in place. */
export function normalizeCodex(raw: unknown, sessionId: string): NormalizedEvent[] {
  const records: unknown[] = Array.isArray(raw) ? raw : [];
  const out: NormalizedEvent[] = [];
  const counters: Counters = new Map();
  const calls = new Map<string, OpenCall>();
  const seenReasoning = new Set<string>();
  const model = modelOf(records);
  // Older rollouts wrote assistant prose ONLY as a response_item. Consuming
  // both shapes when both exist renders every message twice, so the
  // response_item path is a fallback, not a second source.
  const hasAgentMessages = records.some(
    (rec) => recordKind(asObj(rec), asObj(asObj(rec).payload)) === "agent_message",
  );
  const hasUserMessages = records.some(
    (rec) => recordKind(asObj(rec), asObj(asObj(rec).payload)) === "user_message",
  );

  let ts = 0;
  let turn = "t0";

  /** Open (or re-open) a tool call. Keyed on `call_id`, so the matching
   *  output lands on the same event and the reducer merges them. */
  const openCall = (callId: string, name: string, input: Record<string, unknown>) => {
    calls.set(callId, { name, input });
    out.push({
      kind: "tool_call",
      id: `tool:${callId}`,
      sessionId,
      ts,
      source: "agent",
      callId,
      toolKind: kindFor(aliasOf(name), input),
      status: "running",
      toolName: name,
      title: titleFor(aliasOf(name), input),
      input,
    });
  };

  /** Settle a tool call with what it produced. */
  const closeCall = (
    callId: string,
    output: string,
    opts: { isError?: boolean; durationMs?: number; content?: ToolContent[] } = {},
  ) => {
    const open = calls.get(callId) ?? { name: "exec", input: {} };
    out.push({
      kind: "tool_call",
      id: `tool:${callId}`,
      sessionId,
      ts,
      source: "environment",
      callId,
      toolKind: kindFor(aliasOf(open.name), open.input),
      status: opts.isError ? "error" : "completed",
      toolName: open.name,
      title: titleFor(aliasOf(open.name), open.input, {
        is_error: !!opts.isError,
        content: output,
      }),
      input: open.input,
      content: opts.content ?? (output ? [{ type: "content", text: output }] : []),
      output: output || undefined,
      isError: opts.isError,
      durationMs: opts.durationMs,
    });
  };

  for (const rec of records) {
    const r = asObj(rec);
    const p = asObj(r.payload);
    ts += 1; // monotonic ordinal; rollout timestamps are per-record ISO strings.

    const t = str(p.turn_id);
    if (t) turn = t;

    switch (recordKind(r, p)) {
      case "session_meta":
        out.push({
          kind: "session_init",
          id: "session",
          sessionId,
          ts,
          source: "environment",
          model,
          cwd: str(p.cwd),
          tools: [],
          provider: str(p.model_provider),
        });
        break;

      case "user_message": {
        const text = String(p.message ?? "").trim();
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

      case "agent_message": {
        const text = String(p.message ?? "").trim();
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

      // The response_item twin of the two cases above. Only reached for the
      // roles the rollout does not already carry as an event_msg.
      case "message": {
        const role = str(p.role);
        // `developer` is Codex's own injected instruction context — the
        // system prompt, the environment blob, the AGENTS.md it read. It is
        // not something a person typed and is not chat.
        if (role === "developer") break;
        if (role === "assistant" && hasAgentMessages) break;
        if (role === "user" && hasUserMessages) break;
        const text = textOf(p.content).trim();
        // Injected context rides in on the user role wearing an XML-ish
        // envelope (`<environment_context>`, `<user_instructions>`). Only
        // reachable on the fallback path, where nothing else distinguishes it.
        if (!text || (role === "user" && text.startsWith("<"))) break;
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

      case "reasoning":
      case "agent_reasoning": {
        // `response_item/reasoning` keeps the real chain in
        // `encrypted_content`, which is opaque to us by design; only the
        // `summary` is readable, and it is routinely empty. An empty
        // reasoning card is worse than none, so it has to be text or nothing.
        const text = (str(p.text) ?? textOf(p.summary)).trim();
        if (!text || seenReasoning.has(text)) break;
        seenReasoning.add(text);
        out.push({
          kind: "reasoning",
          id: nextId(counters, turn, "reasoning"),
          sessionId,
          ts,
          source: "agent",
          text,
        });
        break;
      }

      case "custom_tool_call":
      case "function_call": {
        const callId = str(p.call_id) ?? str(p.id);
        if (!callId) break;
        const name = str(p.name) ?? "exec";
        openCall(callId, name, toolInput(name, p.input ?? p.arguments));
        break;
      }

      case "exec_command_begin": {
        const callId = str(p.call_id);
        if (!callId) break;
        const command = Array.isArray(p.command)
          ? (p.command as unknown[]).map((c) => String(c)).join(" ")
          : String(p.command ?? "");
        openCall(callId, "exec", { command, cwd: str(p.cwd) });
        break;
      }

      case "custom_tool_call_output":
      case "function_call_output": {
        const callId = str(p.call_id);
        if (!callId) break;
        closeCall(callId, textOf(p.output));
        break;
      }

      case "exec_command_end": {
        const callId = str(p.call_id);
        if (!callId) break;
        const exit = typeof p.exit_code === "number" ? p.exit_code : 0;
        const body = [textOf(p.stdout), textOf(p.stderr)]
          .filter((s) => s !== "")
          .join("\n");
        closeCall(callId, body, {
          isError: exit !== 0,
          durationMs: durationMs(p.duration),
        });
        break;
      }

      case "mcp_tool_call_end": {
        const callId = str(p.call_id);
        if (!callId) break;
        const inv = asObj(p.invocation);
        const server = str(inv.server) ?? "mcp";
        const tool = str(inv.tool) ?? "call";
        const name = `mcp__${server}__${tool}`;
        // Begin and end can both be present; keying on call_id means the
        // second one updates the first rather than adding a card.
        if (!calls.has(callId)) {
          calls.set(callId, { name, input: asObj(inv.arguments) });
        }
        const result = asObj(p.result);
        const failed = result.Err != null || p.is_error === true;
        closeCall(callId, textOf(result.Ok ?? p.result), {
          isError: failed,
          durationMs: durationMs(p.duration),
        });
        break;
      }

      case "patch_apply_end": {
        const callId = str(p.call_id);
        if (!callId) break;
        const changes = asObj(p.changes);
        const failed = p.success === false || str(p.status) === "failed";
        const body = [textOf(p.stdout), textOf(p.stderr)]
          .filter((s) => s !== "")
          .join("\n");
        out.push({
          kind: "tool_call",
          id: `tool:${callId}`,
          sessionId,
          ts,
          source: "environment",
          callId,
          toolKind: patchKind(changes),
          status: failed ? "error" : "completed",
          toolName: "apply_patch",
          title: patchTitle(changes),
          input: { changes },
          content: patchContent(changes),
          output: body || undefined,
          isError: failed || undefined,
          locations: Object.keys(changes).map((path) => ({ path })),
        });
        break;
      }

      case "token_count": {
        const info = asObj(p.info);
        const last = asObj(info.last_token_usage ?? info.total_token_usage);
        out.push({
          kind: "usage",
          // One usage event per turn, re-emitted under the same id as the
          // count climbs — a rollout carries dozens of these and they are
          // one number changing, not dozens of facts.
          id: `${turn}:usage`,
          sessionId,
          ts,
          source: "environment",
          // `input_tokens` is already the whole input side — Codex's own
          // arithmetic is `input + output == total`, with
          // `cached_input_tokens` naming the share of that input that was a
          // cache hit rather than an addition to it. Summing the two counts
          // the cached tokens twice and puts a context figure on screen that
          // is bigger than the conversation.
          contextTokens: num(last.input_tokens),
          outputTokens: num(last.output_tokens),
        });
        break;
      }

      case "task_complete":
        out.push({
          kind: "result",
          id: `${turn}:result`,
          sessionId,
          ts,
          source: "environment",
          subtype: "success",
          // Deliberately no `text`: `last_agent_message` repeats the final
          // agent_message verbatim, and the transcript already rendered it.
          durationMs: durationMs(p.duration_ms),
        });
        break;

      case "error":
      case "stream_error": {
        const message = (str(p.message) ?? textOf(p)).trim();
        if (!message) break;
        out.push({
          kind: "error",
          id: nextId(counters, turn, "error"),
          sessionId,
          ts,
          source: "environment",
          message,
        });
        break;
      }

      // Codex's own bookkeeping — world_state, turn_context,
      // thread_settings_applied, task_started, the *_begin halves already
      // covered by their _end, token rate limits. Read above for the turn id
      // and the model; nothing here is chat.
      default:
        break;
    }
  }

  return out;
}
