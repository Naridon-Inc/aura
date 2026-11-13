import type { ChatTurn, PersistedToolCall } from "../../../lib/api";
import type { StreamBlock } from "./types";

// What the brain accumulates mid-turn — see `chat/types`. This used to be a
// byte-identical second copy declared right here; it is now imported so the
// view, the cards that render it, and managerStore's durable mirror all speak
// ONE declaration and can't drift apart.

/** Convert a settled turn's persisted tool calls into the stream-block shape
 *  `StreamingBubble` consumes, so the reload timeline renders the same tool
 *  cards the live stream did — consecutive read-only calls clubbed into one
 *  "Explored" line, consecutive world-changing calls into one living status
 *  bar. Block indices are positional.
 *
 *  A persisted call with no stored result defaults to a clean DONE result
 *  (not absent): the turn has already settled, so the tool finished — leaving
 *  the result undefined would derive status "running" and paint a perpetual
 *  bold "Running" badge on a finished turn (the backend doesn't always capture
 *  a tool's output). Empty content renders nothing, so this only fixes the
 *  verb/status, never fabricates output. */
function persistedToolBlocks(calls: PersistedToolCall[]): StreamBlock[] {
  return calls.map((c, i) => ({
    kind: "tool",
    block_idx: i,
    tool_use_id: c.tool_use_id || `tc-${i}`,
    name: c.name,
    input: c.input,
    result: c.result
      ? { is_error: c.result.is_error, content: c.result.content }
      : { is_error: false, content: "" },
  }));
}

/** The full settled-turn block stream: any hydrated extended-thinking
 *  (`turn.thinking`, populated only on imported CLI transcripts) as a leading
 *  `reasoning` disclosure, then the persisted tool cards. `StreamingBubble`
 *  renders blocks in array order, so reasoning-before-tools matches the order
 *  the agent emitted them. Returns [] when a turn has neither. */
export function persistedTurnBlocks(turn: ChatTurn): StreamBlock[] {
  const blocks: StreamBlock[] = [];
  if (turn.thinking && turn.thinking.trim()) {
    blocks.push({ kind: "reasoning", block_idx: 0, text: turn.thinking });
  }
  const offset = blocks.length;
  for (const b of persistedToolBlocks(turn.tool_calls ?? [])) {
    blocks.push({ ...b, block_idx: b.block_idx + offset });
  }
  return blocks;
}
