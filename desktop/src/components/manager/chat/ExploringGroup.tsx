//! Consecutive read-only tool calls, folded into one step group.
//!
//! When the brain is gathering context it fires a burst of read/grep/glob/ls/
//! fetch calls, and one row per call clutters the timeline. `ExploringGroup`
//! folds a run of two or more into a single group line that names the files
//! the run touched, and opens to the individual steps. Action tools
//! (edit/write/run/dispatch) fold separately, in `LiveToolStatus`.
//!
//! The grouping decision is the registry's `tier`, not a hardcoded name list:
//! `describeTool(...).tier === "thinking"` is exactly the read-only set, so a
//! new read tool added to the registry is grouped automatically.

import { ToolGroup } from "../../ui/transcript-patterns";
import { describeTool } from "./toolDescribe";
import { ToolCard } from "./ToolCard";
import type { StreamBlock } from "./types";

type ToolBlock = Extract<StreamBlock, { kind: "tool" }>;

/** Whether a tool call is read-only context-gathering — the `thinking` tier
 *  in the registry (read/grep/glob/ls/fetch and friends). Action tools
 *  (edit/write/run/dispatch/ask) are `action` and return false. */
export function isReadOnlyTool(block: ToolBlock): boolean {
  return describeTool(block.name, block.input, block.result).tier === "thinking";
}

/** The distinct subjects a run touched, three at most plus a count of the
 *  rest — "api.ts · ToolCard.tsx · types.ts +2". */
export function subjectSummary(tools: ToolBlock[]): string {
  const subjects: string[] = [];
  for (const t of tools) {
    const subj = describeTool(t.name, t.input, t.result).subject;
    if (subj && !subjects.includes(subj)) subjects.push(subj);
  }
  if (subjects.length === 0) return "";
  const rest = subjects.length > 3 ? ` +${subjects.length - 3}` : "";
  return subjects.slice(0, 3).join(" · ") + rest;
}

/** A folded run of read-only steps. The group spins while any read is still
 *  running, and says how many failed or never reported back. */
export function ExploringGroup({ tools }: { tools: ToolBlock[] }) {
  return (
    <ToolGroup
      count={tools.length}
      running={tools.some((t) => !t.result)}
      failed={tools.filter((t) => t.result?.is_error).length}
      incomplete={tools.filter((t) => t.result?.status).length}
      detail={subjectSummary(tools)}
    >
      {tools.map((t, i) => (
        <ToolCard key={t.tool_use_id || i} name={t.name} input={t.input} result={t.result} />
      ))}
    </ToolGroup>
  );
}
