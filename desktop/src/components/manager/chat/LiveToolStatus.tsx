//! Consecutive ACTION tool calls, folded into one living step group.
//!
//! Read-only bursts fold into `ExploringGroup`. Their world-changing siblings
//! — a run of edit / write / run / dispatch calls fired back-to-back for the
//! same plan — fold here instead of stacking as a tower of rows. While the
//! brain works, the group line names the step it is on right now ("Editing
//! ToolCard.tsx", then "Running cargo check"); once the run settles it names
//! the last step. Opening it shows every step in full — nothing is hidden,
//! just folded.

import { ToolGroup } from "../../ui/transcript-patterns";
import { describeTool } from "./toolDescribe";
import { ToolCard } from "./ToolCard";
import { FileDiffTool, isFileDiffTool } from "./FileDiffTool";
import { toolStatus, type StreamBlock } from "./types";

type ToolBlock = Extract<StreamBlock, { kind: "tool" }>;

/** Render one tool block the way the bubble would on its own — the file
 *  diff for an edit or write with extractable content, else the step row.
 *  Reused for every row of the open group so a folded edit keeps its diff. */
function renderToolBlock(t: ToolBlock, key: string | number) {
  if (isFileDiffTool(t.name, t.input)) {
    return <FileDiffTool key={key} name={t.name} input={t.input} result={t.result} />;
  }
  return <ToolCard key={key} name={t.name} input={t.input} result={t.result} />;
}

/** A run of two or more consecutive action steps as one group whose line
 *  follows the live edge of the run. */
export function LiveToolStatus({ tools }: { tools: ToolBlock[] }) {
  // The step the line reflects: the first one still running (the live edge),
  // or — once everything has landed — the last one, so the line settles on
  // the final step instead of snapping back to the top.
  const runningIdx = tools.findIndex((t) => !t.result);
  const active = tools[runningIdx === -1 ? tools.length - 1 : runningIdx]!;
  const view = describeTool(active.name, active.input, active.result);
  const statuses = tools.map((t) => toolStatus(t.result));
  const detail =
    runningIdx === -1 ? view.subject : [view.verb, view.subject].filter(Boolean).join(" ");

  return (
    <ToolGroup
      count={tools.length}
      running={runningIdx !== -1}
      failed={statuses.filter((s) => s === "error").length}
      incomplete={statuses.filter((s) => s === "cancelled" || s === "unknown").length}
      detail={detail}
    >
      {tools.map((t, i) => renderToolBlock(t, t.tool_use_id || i))}
    </ToolGroup>
  );
}
