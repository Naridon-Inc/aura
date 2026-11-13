import type { StreamBlock } from "./types";

// ── Stream-block accumulators ────────────────────────────────────────────

export function upsertText(blocks: StreamBlock[], idx: number, text: string): StreamBlock[] {
  const i = blocks.findIndex((b) => b.kind === "text" && b.block_idx === idx);
  if (i >= 0) {
    const next = blocks.slice();
    const cur = next[i]!;
    if (cur.kind === "text") {
      next[i] = { ...cur, text: cur.text + text };
    }
    return next;
  }
  const added: StreamBlock = { kind: "text", block_idx: idx, text };
  return [...blocks, added].sort((a, b) => a.block_idx - b.block_idx);
}

// Reasoning blocks accumulate exactly like text, but keyed to their own
// block_idx so the model's chain-of-thought renders as a separate collapsible
// disclosure above the answer (never interleaved into answer prose).
export function upsertReasoning(blocks: StreamBlock[], idx: number, text: string): StreamBlock[] {
  const i = blocks.findIndex((b) => b.kind === "reasoning" && b.block_idx === idx);
  if (i >= 0) {
    const next = blocks.slice();
    const cur = next[i]!;
    if (cur.kind === "reasoning") {
      next[i] = { ...cur, text: cur.text + text };
    }
    return next;
  }
  const added: StreamBlock = { kind: "reasoning", block_idx: idx, text };
  return [...blocks, added].sort((a, b) => a.block_idx - b.block_idx);
}

export function upsertTool(
  blocks: StreamBlock[],
  tool: StreamBlock & { kind: "tool" },
): StreamBlock[] {
  const i = blocks.findIndex(
    (b) => b.kind === "tool" && b.block_idx === tool.block_idx,
  );
  if (i >= 0) {
    const next = blocks.slice();
    const cur = next[i] as typeof tool;
    // Keep the ORIGINAL start stamp on an update — re-stamping would restart
    // the live "Running …" timer every time the block is touched.
    next[i] = { ...tool, result: cur.result, started_at: cur.started_at };
    return next;
  }
  return [
    ...blocks,
    { ...tool, started_at: tool.started_at ?? Date.now() },
  ].sort((a, b) => a.block_idx - b.block_idx);
}

export function attachResult(
  blocks: StreamBlock[],
  tool_use_id: string,
  result: { is_error: boolean; content: string },
): StreamBlock[] {
  const i = blocks.findIndex((b) => b.kind === "tool" && b.tool_use_id === tool_use_id);
  if (i < 0) return blocks;
  const next = blocks.slice();
  const cur = next[i]!;
  if (cur.kind === "tool") {
    next[i] = { ...cur, result };
  }
  return next;
}
