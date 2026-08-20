//! Pi adapter — maps `pi --mode json` into the engine-agnostic
//! `NormalizedEvent` model.
//!
//! Pi's print mode is the plainest wire of the five: `session.subscribe` is
//! piped straight to stdout, one `JSON.stringify(event)` per line, preceded by
//! a single session header. There is no envelope and no second naming of the
//! record — the object IS the event, and `type` is its only discriminator.
//!
//! Which makes Pi the first engine after Claude Code with REAL streaming.
//! Every other CLI we read hands us finished parts: OpenCode's `run` writes
//! whole `part` objects, Codex writes settled rollout rows. Pi forwards the
//! provider's own token stream — `message_update` carries an
//! `assistantMessageEvent` of `text_delta` / `thinking_delta` with the
//! characters as they arrive, alongside `partial`, the message accumulated so
//! far. That is what lets a Pi answer type itself into the transcript.
//!
//! Two shapes below are worth stating outright because they are what keeps
//! this correct rather than merely working:
//!
//!   • **Full text, never our own accretion.** Each delta event also carries
//!     `partial`, so this emits the ACCUMULATED string from
//!     `partial.content[contentIndex]` and no `delta` field. The reducer treats
//!     a full `text` as a replacement, so re-normalizing a longer prefix of the
//!     same stream — which is what the chat does on every tick — converges on
//!     the same transcript instead of concatenating the deltas a second time.
//!
//!   • **Ids derived from message ORDER, because Pi's messages have none.**
//!     `UserMessage`, `AssistantMessage` and `ToolResultMessage` carry a role
//!     and a timestamp and nothing else; there is no id to key on. Pi does emit
//!     exactly one `message_start` per message, in order, so counting them
//!     gives a stable ordinal — the stream is append-only, so the nth message
//!     is the nth message on every re-parse. Tool calls are exempt: those have
//!     a real `toolCallId` from the provider and use it.
//!
//! ONE adapter reads TWO wires, because Pi writes the same records to both.
//! Its session file opens with the very `{type:"session"}` header print mode
//! opens with, and its `{type:"message", message}` entries hold the same
//! `UserMessage` / `AssistantMessage` / `ToolResultMessage` values
//! `message_end` carries. So the file entries route into the same handlers,
//! and the chat reads a Pi tab running as a TUI in a PTY (via
//! `pi_session_read`) with no second parser and no second set of bugs. The
//! file's three entry types that have no wire twin — `message`,
//! `model_change`, `compaction` — are handled beside the events they mirror.
//!
//! Everything here was read out of the 0.83.0 packages' own type declarations
//! and compiled loop — `pi-agent-core`'s `AgentEvent`, `pi-coding-agent`'s
//! `AgentSessionEvent` and `SessionEntry`, `pi-ai`'s `AssistantMessageEvent` —
//! not inferred from a sample. Records outside those unions are skipped rather
//! than guessed at.

import { asObj, kindFor, norm, titleFor } from "./describe";
import type {
  NormalizedEvent,
  ResultEvent,
  ToolCallStatus,
  ToolContent,
  ToolLocation,
} from "../events";

/** Pi's tool names routed to the describe registry's vocabulary. Only `find`
 *  needs it: Pi's `find` takes a glob and finds files, which is what our
 *  registry calls `glob` ("Finding <pattern>"). `read`, `bash`, `edit`,
 *  `write`, `grep` and `ls` are already the registry's own words. */
const TOOL_ALIAS: Record<string, string> = {
  find: "glob",
};

/** Pi's seven built-in tools. Anything else is an extension or MCP tool our
 *  registry has never seen, and for those a generic headline built from the
 *  tool's own name beats pretending to recognize it. */
const BUILT_IN = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

function aliasOf(name: string): string {
  return TOOL_ALIAS[norm(name)] ?? name;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** The readable text of a `(TextContent | ImageContent)[]`, which is the shape
 *  Pi uses for both a user message's content and a tool result's. Image blocks
 *  have no text to contribute and are dropped here; the image path is already
 *  on whichever tool call produced it. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content)
    .map((c) => {
      const o = asObj(c);
      return o.type === "text" ? String(o.text ?? "") : "";
    })
    .filter(Boolean)
    .join("");
}

/** One content block of a partial assistant message, by index. Pi addresses
 *  deltas with `contentIndex` into `partial.content`, so this is how the
 *  accumulated string for that block is recovered. */
function blockAt(partial: unknown, index: number): Record<string, unknown> {
  return asObj(arr(asObj(partial).content)[index]);
}

/** Files a tool touched, so the editor can follow along. Every Pi tool that
 *  names a file names it `path`. */
function locationsOf(
  name: string,
  input: Record<string, unknown>,
): ToolLocation[] | undefined {
  const n = norm(name);
  if (n !== "read" && n !== "write" && n !== "edit") return undefined;
  const path = str(input.path);
  return path ? [{ path }] : undefined;
}

/** The body of a settled tool call.
 *
 *  `write` and `edit` carry their literal before/after in the INPUT, so those
 *  render as a real diff rather than the string "File written". Pi's `edit`
 *  takes an ARRAY of `{oldText, newText}` replacements in one call — unlike
 *  Claude's and OpenCode's single-pair edit — so a multi-edit produces one
 *  diff block per replacement, which is what actually happened. Everything
 *  else shows the text Pi returned to the model. */
function toolContent(
  name: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): ToolContent[] {
  const n = norm(name);
  const path = str(input.path);

  if (n === "write" && path) {
    return [{ type: "diff", path, newText: String(input.content ?? "") }];
  }
  if (n === "edit" && path) {
    const edits = arr(input.edits)
      .map((e): ToolContent | null => {
        const o = asObj(e);
        if (typeof o.newText !== "string") return null;
        return {
          type: "diff",
          path,
          oldText: typeof o.oldText === "string" ? o.oldText : undefined,
          newText: o.newText,
        };
      })
      .filter((c): c is ToolContent => c !== null);
    if (edits.length) return edits;
  }
  const text = textOf(result.content);
  return text ? [{ type: "content", text }] : [];
}

/** Pi's stop reasons → our terminal subtype. `toolUse` and `pending` are not
 *  terminal at all — the model paused to run a tool, or the message is still
 *  being built — so they never reach here. */
function subtypeOf(reason: string | undefined): ResultEvent["subtype"] {
  if (reason === "aborted") return "cancelled";
  if (reason === "error") return "error";
  return "success";
}

/** Accept either parsed records or the raw NDJSON the CLI wrote, so a caller
 *  holding stdout doesn't have to know the framing. An unparseable line is
 *  skipped rather than thrown on: one bad line should not blank the
 *  conversation around it. */
function records(raw: unknown): Record<string, unknown>[] {
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("{"))
          .map((line) => {
            try {
              return JSON.parse(line) as unknown;
            } catch {
              return null;
            }
          })
          .filter((v) => v !== null)
      : [];
  return rows.map((r) => asObj(r));
}

/** Normalize a `pi --mode json` stream into the shared model. Pure and
 *  deterministic: the stream is append-only, so re-running this over a longer
 *  prefix mints the same ids for the records it already saw and the reducer
 *  folds the updates in place. */
export function normalizePi(raw: unknown, sessionId: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const rows = records(raw);

  // Pi's messages have no ids, so this ordinal is the id. It advances on every
  // `message_start` — user, assistant and tool-result alike — which is exactly
  // once per message, in order.
  let msgSeq = 0;

  // The header knows the cwd and the assistant messages know the model, and
  // neither knows the other. Both are held here so the session card can be
  // re-emitted, under the same id, once the second half arrives.
  let cwd: string | undefined;
  let model: string | null = null;
  let provider: string | undefined;

  // Summed across every model call, so the closing card reports what the whole
  // answer cost rather than what its last call cost.
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let costUsd = 0;
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let sawEnd = false;
  let lastTs = 0;

  const pushInit = (ts: number) => {
    out.push({
      kind: "session_init",
      id: `${sessionId}:init`,
      sessionId,
      ts,
      source: "agent",
      model,
      provider,
      cwd,
      // Pi's tool set depends on --tools/--exclude-tools, its extensions and
      // its skills, and the wire never lists it. An invented list would be a
      // card stating something we didn't read.
      tools: [],
    });
  };

  /** Fill in the session card's model once it is known, under the same id, so
   *  the reducer updates the card already on screen rather than adding a
   *  second one. */
  const setModel = (name: string | undefined, ts: number) => {
    if (!name) return;
    // `provider/model` is how Pi's own `--model` flag spells it, so the card
    // reads back the string the user would type.
    const next = provider ? `${provider}/${name}` : name;
    if (next === model) return;
    model = next;
    pushInit(ts);
  };

  /** A settled message — user, assistant or tool result.
   *
   *  Shared by both wires: `message_end` carries it live, and a session file's
   *  `{type:"message"}` entry carries the identical value. */
  const emitMessage = (msg: Record<string, unknown>, ts: number) => {
    const role = str(msg.role);

    if (role === "user") {
      const text = textOf(msg.content).trim();
      if (!text) return;
      out.push({
        kind: "text",
        id: `text:${msgSeq}`,
        sessionId,
        ts,
        source: "user",
        role: "user",
        text,
      });
      return;
    }

    // A tool result is already a settled tool card via `tool_execution_end`;
    // rendering it again as a message would show the same output twice.
    if (role !== "assistant") return;

    provider = str(msg.provider) ?? provider;
    setModel(str(msg.model), ts);

    arr(msg.content).forEach((c, idx) => {
      const block = asObj(c);
      if (block.type === "text") {
        const text = String(block.text ?? "");
        if (!text) return;
        out.push({
          kind: "text",
          id: `text:${msgSeq}:${idx}`,
          sessionId,
          ts,
          source: "agent",
          role: "assistant",
          text,
        });
      } else if (block.type === "thinking") {
        const text = String(block.thinking ?? "");
        if (!text) return;
        out.push({
          kind: "reasoning",
          id: `reasoning:${msgSeq}:${idx}`,
          sessionId,
          ts,
          source: "agent",
          text,
          signature: str(block.thinkingSignature),
        });
      }
      // A `toolCall` block is the request; `tool_execution_start` carries the
      // same call with validated arguments and is what we render.
    });

    const usage = asObj(msg.usage);
    const input = num(usage.input);
    const read = num(usage.cacheRead);
    const write = num(usage.cacheWrite);
    const output = num(usage.output);
    inputTokens += input;
    outputTokens += output;
    cacheRead += read;
    cacheWrite += write;
    // Pi is the one engine that reports MONEY rather than tokens alone — it
    // prices each call against its own model catalog. So the cost on the
    // closing card is Pi's own number, not our table's guess at it.
    costUsd += num(asObj(usage.cost).total);
    out.push({
      kind: "usage",
      id: `usage:${msgSeq}`,
      sessionId,
      ts,
      source: "environment",
      // Everything fed into this call: the fresh input plus both cache planes.
      // Pi reports `input` as the uncached share only.
      contextTokens: input + read + write,
      outputTokens: output,
    });

    const reason = str(msg.stopReason);
    if (reason === "error" || reason === "aborted") {
      stopReason = reason;
      errorMessage = str(msg.errorMessage);
      out.push({
        kind: "error",
        id: `error:${msgSeq}`,
        sessionId,
        ts,
        source: "environment",
        // Pi's own message. A model that could not be resolved, a key that was
        // refused, a context that overflowed — the reason is here and
        // restating it as "the request failed" would throw it away.
        message: errorMessage ?? `The request ${reason}.`,
        errorId: reason,
      });
    } else if (reason) {
      stopReason = reason;
    }
  };

  rows.forEach((r, i) => {
    const type = String(r.type ?? "");
    // Pi timestamps its session entries but not its live events, so the record
    // index stands in — it preserves order, which is all `ts` is used for.
    const ts = i;
    lastTs = ts;

    switch (type) {
      // The header line `runPrintMode` writes before subscribing. It is a
      // `SessionHeader`, not an `AgentEvent` — the only record whose `type` is
      // outside the event union, which is what makes it unambiguous.
      case "session": {
        cwd = str(r.cwd);
        pushInit(ts);
        break;
      }

      case "message_start": {
        msgSeq += 1;
        break;
      }

      case "message_update": {
        const ev = asObj(r.assistantMessageEvent);
        const kind = String(ev.type ?? "");
        const idx = num(ev.contentIndex);
        const block = blockAt(ev.partial, idx);

        if (kind === "text_start" || kind === "text_delta" || kind === "text_end") {
          const text = String(block.text ?? "");
          if (!text) break;
          out.push({
            kind: "text",
            id: `text:${msgSeq}:${idx}`,
            sessionId,
            ts,
            source: "agent",
            partial: true,
            role: "assistant",
            // The accumulated string, not the delta — see the file header.
            text,
          });
          break;
        }
        if (
          kind === "thinking_start" ||
          kind === "thinking_delta" ||
          kind === "thinking_end"
        ) {
          const text = String(block.thinking ?? "");
          if (!text) break;
          out.push({
            kind: "reasoning",
            id: `reasoning:${msgSeq}:${idx}`,
            sessionId,
            ts,
            source: "agent",
            partial: true,
            text,
          });
          break;
        }
        // `toolcall_start` / `toolcall_delta` stream the arguments as raw JSON
        // fragments, which are not renderable and not yet validated. The call
        // arrives whole on `tool_execution_start` a moment later, with its
        // arguments parsed — so this waits for that rather than showing a
        // half-written object.
        break;
      }

      case "message_end": {
        emitMessage(asObj(r.message), ts);
        break;
      }

      // ── Session-file entries. Everything below this point exists only in
      //    the JSONL Pi persists; the live wire never emits these types.

      // The file's own record of a settled message. It holds the SAME value
      // `message_end` carries, so it takes the same path — but it is also the
      // file's only `message_start`, so the ordinal advances here.
      case "message": {
        msgSeq += 1;
        // The file has no `agent_end`, so a run is over when its last message
        // stopped for a terminal reason. Recomputed on every message, so a
        // follow-up question reopens the run instead of leaving a closing card
        // stranded in the middle of the conversation.
        sawEnd = false;
        stopReason = undefined;
        errorMessage = undefined;
        emitMessage(asObj(r.message), ts);
        if (stopReason && stopReason !== "toolUse") sawEnd = true;
        break;
      }

      // The user switched models mid-session (`/model` in the TUI). The wire
      // reveals the model through each assistant message instead; here it is
      // its own entry, and it lands before the first message that used it.
      case "model_change": {
        provider = str(r.provider) ?? provider;
        setModel(str(r.modelId), ts);
        break;
      }

      // The persisted counterpart of `compaction_start`: history was summarized
      // and the entries before `firstKeptEntryId` are no longer in context.
      case "compaction": {
        const before = num(r.tokensBefore);
        out.push({
          kind: "error",
          id: `compaction:${str(r.id) ?? i}`,
          sessionId,
          ts,
          source: "environment",
          message: before
            ? `The conversation reached ${before.toLocaleString()} tokens and was summarized to keep going.`
            : "The conversation so far was summarized to free up context.",
          errorId: "compaction",
        });
        break;
      }

      case "tool_execution_start": {
        const callId = str(r.toolCallId) ?? `call:${i}`;
        const rawName = str(r.toolName) ?? "tool";
        const input = asObj(r.args);
        const alias = aliasOf(rawName);
        out.push({
          kind: "tool_call",
          id: `tool:${callId}`,
          sessionId,
          ts,
          source: "agent",
          partial: true,
          callId,
          toolKind: kindFor(alias, input),
          // Pi emits this immediately before `execute()`, so the tool is
          // genuinely running rather than queued.
          status: "running",
          toolName: rawName,
          title: BUILT_IN.has(norm(rawName))
            ? titleFor(alias, input)
            : titleFor(rawName, input),
          input,
        });
        break;
      }

      case "tool_execution_update": {
        // A long-running tool streaming its output — `bash` does this as the
        // command writes. Same card, growing.
        const callId = str(r.toolCallId) ?? `call:${i}`;
        const rawName = str(r.toolName) ?? "tool";
        const input = asObj(r.args);
        const text = textOf(asObj(r.partialResult).content);
        if (!text) break;
        out.push({
          kind: "tool_call",
          id: `tool:${callId}`,
          sessionId,
          ts,
          source: "agent",
          partial: true,
          callId,
          toolKind: kindFor(aliasOf(rawName), input),
          status: "running",
          toolName: rawName,
          title: "",
          input,
          content: [{ type: "content", text }],
          output: text,
        });
        break;
      }

      case "tool_execution_end": {
        const callId = str(r.toolCallId) ?? `call:${i}`;
        const rawName = str(r.toolName) ?? "tool";
        const input = asObj(r.args);
        const result = asObj(r.result);
        // Authoritative, and it is why there is no exit-code sniffing here the
        // way OpenCode needs: Pi's `bash` THROWS on a non-zero exit, and a
        // thrown tool is what sets this flag. A failing build cannot arrive
        // wearing a green card.
        const isError = r.isError === true;
        const status: ToolCallStatus = isError ? "error" : "completed";
        const output = textOf(result.content);
        const alias = aliasOf(rawName);
        out.push({
          kind: "tool_call",
          id: `tool:${callId}`,
          sessionId,
          ts,
          source: "environment",
          callId,
          toolKind: kindFor(alias, input),
          status,
          toolName: rawName,
          title: BUILT_IN.has(norm(rawName))
            ? titleFor(alias, input, { is_error: isError, content: output })
            : titleFor(rawName, input, { is_error: isError, content: output }),
          input,
          content: toolContent(rawName, input, result),
          output,
          isError: isError || undefined,
          locations: locationsOf(rawName, input),
        });
        break;
      }

      case "auto_retry_start": {
        // Pi retries a failed provider call on its own. Surfacing this is the
        // difference between a chat that looks frozen for thirty seconds and
        // one that says why it is waiting — and it carries the provider's own
        // error text, which is the part every wrapper tends to swallow.
        const attempt = num(r.attempt);
        const max = num(r.maxAttempts);
        const why = str(r.errorMessage) ?? "the request failed";
        out.push({
          kind: "error",
          id: `retry:${i}`,
          sessionId,
          ts,
          source: "environment",
          message:
            attempt && max
              ? `Attempt ${attempt} of ${max} failed: ${why} — retrying.`
              : `${why} — retrying.`,
          errorId: "auto_retry",
        });
        break;
      }

      case "auto_retry_end": {
        // Only the giving-up case is news. A retry that worked is already
        // visible as the answer that follows it.
        if (r.success === true) break;
        const why = str(r.finalError);
        if (!why) break;
        out.push({
          kind: "error",
          id: `retry_end:${i}`,
          sessionId,
          ts,
          source: "environment",
          message: why,
          errorId: "auto_retry_failed",
        });
        break;
      }

      case "compaction_start": {
        // The history was too long and Pi summarized it. Worth saying plainly:
        // it explains why the agent may seem to have forgotten something.
        const reason = str(r.reason);
        out.push({
          kind: "error",
          id: `compaction:${i}`,
          sessionId,
          ts,
          source: "environment",
          message:
            reason === "overflow"
              ? "The conversation outgrew the context window — summarizing it to continue."
              : "Summarizing the conversation so far to free up context.",
          errorId: "compaction",
        });
        break;
      }

      case "agent_end": {
        // `willRetry` means Pi is about to run the loop again, so this is not
        // the end of anything the user should see closed off.
        if (r.willRetry === true) break;
        sawEnd = true;
        break;
      }

      // Pi's own bookkeeping, none of which is chat: `agent_start`,
      // `turn_start` and `turn_end` bracket work already described by the
      // messages inside them; `agent_settled` fires after the listeners
      // finish; `queue_update` reports steering/follow-up backlogs;
      // `entry_appended` is session persistence; `session_info_changed` and
      // `thinking_level_changed` are settings; `compaction_end` and the
      // `summarization_retry_*` family narrate a summarizer whose start is
      // already announced above; `bash_execution_update` belongs to the TUI's
      // own `!` shell, which print mode never opens.
      //
      // The session file's remaining entries are likewise not conversation:
      // `thinking_level_change` and `session_info` are settings,
      // `branch_summary` describes a fork's parent, and `label` and `custom`
      // are markers extensions write for themselves.
      default:
        break;
    }
  });

  // One closing card for the run. `stop`, `length`, `error` and `aborted` are
  // terminal; `toolUse` means the model paused for a tool and another call
  // follows, so a stream that ends there ended early and gets no result.
  if (sawEnd && stopReason && stopReason !== "toolUse") {
    out.push({
      kind: "result",
      id: "result",
      sessionId,
      ts: lastTs,
      source: "environment",
      subtype: subtypeOf(stopReason),
      text: stopReason === "length" ? "The reply hit the output token limit." : undefined,
      errors: errorMessage ? [errorMessage] : undefined,
      usage: { inputTokens, outputTokens, cacheRead, cacheWrite },
      costUsd,
      stopReason,
    });
  }

  return out;
}
