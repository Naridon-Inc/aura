//! Fold a normalized event timeline into render groups for the agent
//! transcript. The whole point of the engine-agnostic layer is that THIS file
//! — not a per-engine renderer — is the only place that knows how a normalized
//! stream becomes UI rows. Every adapter (Claude today, Codex/Gemini next)
//! produces the same `NormalizedEvent[]`, so they all flow through here and out
//! the same cards.
//!
//! Reuse over reinvention: the assistant's interleaved prose / thinking / tool
//! calls map 1:1 onto the native chat's existing `StreamBlock` union, so a run
//! of them renders through the SAME `StreamingBubble` + `ToolCard` stack the
//! native Aura brain uses. Only the genuinely-structured events
//! (question sets, plans, todo checklists, permission prompts, the result
//! footer) become their own groups.

import { reduceEvents } from "../../../lib/agentProtocol";
import type {
  ErrorEvent,
  ImageEvent,
  NormalizedEvent,
  PermissionRequestEvent,
  PlanEvent,
  QuestionSetEvent,
  ResultEvent,
  SessionInitEvent,
  TodoEvent,
} from "../../../lib/agentProtocol";
import type { StreamBlock, ToolResult } from "../../manager/chat/types";

/** One row of the rendered transcript. A `stream` group carries a run of
 *  consecutive assistant blocks (prose/thinking/tools) so it renders through
 *  the shared `StreamingBubble`; every other kind is a first-class card. */
/** Token accounting for one response, folded from the run's per-call usage
 *  events: `context` is the largest context fed across the calls (the final
 *  call sees the most), `output` is the sum of what they generated. */
export type GroupUsage = { context: number; output: number };

export type TranscriptGroup =
  | { kind: "user"; id: string; text: string }
  | { kind: "stream"; id: string; blocks: StreamBlock[]; usage?: GroupUsage }
  | { kind: "question"; id: string; ev: QuestionSetEvent }
  | { kind: "plan"; id: string; ev: PlanEvent }
  | { kind: "todo"; id: string; ev: TodoEvent }
  | { kind: "permission"; id: string; ev: PermissionRequestEvent }
  | { kind: "result"; id: string; ev: ResultEvent }
  | { kind: "error"; id: string; ev: ErrorEvent }
  | { kind: "image"; id: string; ev: ImageEvent }
  | { kind: "init"; id: string; ev: SessionInitEvent };

/** Map a settled `tool_call` to the native chat's tool `StreamBlock`. The
 *  result is attached only once the call has output, so a still-running call
 *  renders as a live (spinner) card exactly like the brain's. */
function toToolBlock(
  ev: Extract<NormalizedEvent, { kind: "tool_call" }>,
  blockIdx: number,
): Extract<StreamBlock, { kind: "tool" }> {
  const settled = ev.status === "completed" || ev.status === "error";
  const result: ToolResult | undefined =
    settled && ev.output != null
      ? { is_error: ev.isError ?? ev.status === "error", content: ev.output }
      : undefined;
  return {
    kind: "tool",
    block_idx: blockIdx,
    tool_use_id: ev.callId,
    name: ev.toolName,
    input: ev.input,
    result,
  };
}

/** Fold a normalized event list into transcript groups. Pure: reduces first
 *  (merging same-id updates), then walks the settled timeline in order,
 *  accreting consecutive assistant blocks into one `stream` run and breaking
 *  the run wherever a user message or a structured event interrupts. */
export function toTranscriptGroups(events: NormalizedEvent[]): TranscriptGroup[] {
  const { events: timeline } = reduceEvents(events);
  const groups: TranscriptGroup[] = [];

  // The open assistant run we're accreting into, plus its block counter and
  // the per-call token usage folded across the response (max context, summed
  // output). `runHasUsage` distinguishes "no usage seen" from a real zero.
  let runBlocks: StreamBlock[] | null = null;
  let runId = "";
  let blockIdx = 0;
  let runCtx = 0;
  let runOut = 0;
  let runHasUsage = false;

  const flush = () => {
    if (runBlocks && runBlocks.length > 0) {
      groups.push({
        kind: "stream",
        id: `stream:${runId}`,
        blocks: runBlocks,
        usage: runHasUsage ? { context: runCtx, output: runOut } : undefined,
      });
    }
    runBlocks = null;
    blockIdx = 0;
    runCtx = 0;
    runOut = 0;
    runHasUsage = false;
  };

  const ensureRun = (seedId: string) => {
    if (!runBlocks) {
      runBlocks = [];
      runId = seedId;
      blockIdx = 0;
    }
  };

  for (const ev of timeline) {
    switch (ev.kind) {
      case "session_init":
        flush();
        groups.push({ kind: "init", id: ev.id, ev });
        break;
      case "text":
        if (ev.role === "user") {
          flush();
          groups.push({ kind: "user", id: ev.id, text: ev.text });
        } else {
          ensureRun(ev.id);
          runBlocks!.push({ kind: "text", block_idx: blockIdx++, text: ev.text });
        }
        break;
      case "reasoning":
        ensureRun(ev.id);
        runBlocks!.push({ kind: "reasoning", block_idx: blockIdx++, text: ev.text });
        break;
      case "tool_call": {
        ensureRun(ev.id);
        runBlocks!.push(toToolBlock(ev, blockIdx++));
        break;
      }
      case "usage":
        // Token accounting for whichever response is open. Don't open a run for
        // it (usage with no prose is nothing to show); fold into the live one.
        if (runBlocks) {
          runHasUsage = true;
          runCtx = Math.max(runCtx, ev.contextTokens);
          runOut += ev.outputTokens;
        }
        break;
      case "question_set":
        flush();
        groups.push({ kind: "question", id: ev.id, ev });
        break;
      case "plan":
        flush();
        groups.push({ kind: "plan", id: ev.id, ev });
        break;
      case "todo":
        flush();
        groups.push({ kind: "todo", id: ev.id, ev });
        break;
      case "permission_request":
        flush();
        groups.push({ kind: "permission", id: ev.id, ev });
        break;
      case "result":
        flush();
        groups.push({ kind: "result", id: ev.id, ev });
        break;
      case "error":
        flush();
        groups.push({ kind: "error", id: ev.id, ev });
        break;
      case "image":
        // A picture breaks the prose run — show it as its own block, aligned
        // by who supplied it (user attachment vs agent output).
        flush();
        groups.push({ kind: "image", id: ev.id, ev });
        break;
      default:
        break;
    }
  }
  flush();
  return groups;
}
