//! Conductor-style activity roll-up for a SETTLED assistant turn.
//!
//! A finished turn that involved tool calls and/or reasoning used to render
//! its whole step-run always-expanded — every read line, every reasoning
//! whisper, every action chip stacked under the answer. A turn with many
//! steps then reads as a wall of activity.
//!
//! This collapses that finished step-run into ONE quiet summary line —
//! a small activity glyph + plain-language counts ("Worked through 9 steps ·
//! read 5 files · ran 3 commands") + a chevron — with the turn's answer prose
//! still rendered below it by the caller (TurnActivity only owns the step-run,
//! never the answer text). Clicking the summary expands a FLAT vertical list
//! of the same compact step rows the live stream uses — each reasoning block a
//! `ReasoningBlock`, each tool block its own `ToolCard` — in emission order,
//! NO nested grouping (the live view's ExploringGroup/LiveToolStatus batching
//! is for the in-flight stream only; a settled turn reads as one uniform list).
//!
//! Counts are derived from the blocks (reasoning vs tool, and the tool's verb
//! family via the registry's `describeTool`) and phrased for non-engineers —
//! no "tool calls", no "tokens". Tokens only for color; the summary line is a
//! quiet disclosure affordance (muted ink), never a loud accent button.

import * as React from "react";

import { describeTool } from "./toolDescribe";
import { ToolCard } from "./ToolCard";
import { ReasoningBlock } from "./ReasoningBlock";
import type { StreamBlock } from "./types";
import { countOf } from "../../../lib/plural";

type ToolBlock = Extract<StreamBlock, { kind: "tool" }>;

/** Plain-language family a tool call falls into, for the summary counts. The
 *  registry's verb is the source of truth (it already normalizes every brain's
 *  naming), so a tool added to the registry is counted automatically. */
type StepFamily = "read" | "search" | "edit" | "run" | "other";

/** Bucket a tool block into a non-engineer-facing family using the verb the
 *  registry assigns it. We key off the verb's leading word (lowercased) so
 *  "Reading"/"Reading page"/"Reading memory" all count as a read, "Editing"/
 *  "Writing" as a change, "Running" as a command, "Searching"/"Finding"/
 *  "Listing"/"Web search" as a look-up. Everything else ("Dispatched …",
 *  "Asking you", "Proving", "Creating task", …) is "other" — counted toward
 *  the total but not given its own clause, so the line stays short. */
function toolFamily(block: ToolBlock): StepFamily {
  const verb = describeTool(block.name, block.input, block.result).verb
    .trim()
    .toLowerCase();
  const head = verb.split(/\s+/, 1)[0] ?? "";
  if (head === "reading" || head === "recalling") return "read";
  if (
    head === "searching" ||
    head === "finding" ||
    head === "listing" ||
    head === "skimming" ||
    verb === "web search" ||
    verb.startsWith("looking up")
  ) {
    return "search";
  }
  if (head === "editing" || head === "writing") return "edit";
  if (head === "running") return "run";
  return "other";
}

/** Build the quiet, plain-language summary clauses from a turn's blocks. The
 *  lead clause is always the total step count ("Worked through N steps"); the
 *  trailing clauses surface the families that actually occurred, in a fixed,
 *  scannable order (read → searched → changed → ran), capped so the line never
 *  sprawls. Returns null when there's nothing worth rolling up. */
function summarize(blocks: StreamBlock[]): string | null {
  let reasoning = 0;
  const fam: Record<StepFamily, number> = {
    read: 0,
    search: 0,
    edit: 0,
    run: 0,
    other: 0,
  };
  for (const b of blocks) {
    if (b.kind === "reasoning") {
      if (b.text.trim()) reasoning += 1;
      continue;
    }
    if (b.kind === "tool") fam[toolFamily(b)] += 1;
  }
  const tools = fam.read + fam.search + fam.edit + fam.run + fam.other;
  // A turn with neither a real thought nor a tool call has no roll-up — the
  // caller renders the answer prose directly with no summary line.
  if (tools === 0 && reasoning === 0) return null;

  // Total steps = reasoning whispers + tool calls. Phrased as work, not
  // "tool calls": "Worked through N steps".
  const steps = tools + reasoning;
  const lead = `Worked through ${countOf(steps, "step")}`;

  const clauses: string[] = [];
  if (fam.read > 0) clauses.push(`read ${countOf(fam.read, "file")}`);
  if (fam.search > 0)
    clauses.push(`ran ${countOf(fam.search, "search")}`);
  if (fam.edit > 0)
    clauses.push(`changed ${countOf(fam.edit, "file")}`);
  if (fam.run > 0)
    clauses.push(`ran ${countOf(fam.run, "command")}`);

  // Keep it to one line: the lead plus at most the three most salient
  // clauses. Anything beyond folds into nothing — the expanded list carries
  // the full detail.
  const shown = clauses.slice(0, 3);
  return [lead, ...shown].join(" · ");
}

/** The settled-turn step-run, rolled up Conductor-style. `blocks` is the same
 *  `StreamBlock[]` `persistedTurnBlocks()` produces (a leading reasoning
 *  disclosure, then the persisted tool cards). The caller renders the turn's
 *  answer prose itself — this owns ONLY the collapsed summary ⇄ expanded flat
 *  step list. `repoRoot` is accepted for parity with the chat-render contract
 *  but isn't threaded down: `ToolCard`/`FileDiffTool` already read it from
 *  `ChatRepoRootContext`. */
export function TurnActivity({
  blocks,
  repoRoot: _repoRoot,
}: {
  blocks: StreamBlock[];
  /** Reserved — the chat render layer resolves file paths through
   *  `ChatRepoRootContext`, so the step rows don't need it threaded. */
  repoRoot?: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const summary = React.useMemo(() => summarize(blocks), [blocks]);

  // Nothing happened this turn (no thought, no tools) — render nothing; the
  // caller still shows the answer prose on its own.
  if (!summary) return null;

  return (
    <div className="aura-turn-activity">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="aura-turn-activity-summary"
        title={open ? "Hide the steps" : "Show the steps"}
        aria-expanded={open}
      >
        <span className="aura-turn-activity-glyph" aria-hidden>
          <ActivityGlyph />
        </span>
        <span className="aura-turn-activity-counts">{summary}</span>
        <span className="aura-turn-activity-chev" aria-hidden>
          <Chevron dir={open ? "up" : "down"} />
        </span>
      </button>
      {open && (
        <div className="aura-turn-activity-list">
          {blocks.map((b, i) => {
            if (b.kind === "reasoning") {
              return <ReasoningBlock key={i} text={b.text} streaming={false} />;
            }
            if (b.kind === "tool") {
              return (
                <ToolCard
                  key={b.tool_use_id || i}
                  name={b.name}
                  input={b.input}
                  result={b.result}
                />
              );
            }
            // A "text" block here would be answer prose; the caller renders
            // the turn's answer itself, so we never reach it from
            // persistedTurnBlocks() (which carries reasoning + tools only).
            return null;
          })}
        </div>
      )}
    </div>
  );
}

/** Small activity glyph for the summary line — three stepped dots tracing a
 *  worked-through run. Calm monoline in muted ink (set by CSS), matching the
 *  tool-row glyph weight so the summary reads as one of the family. */
function ActivityGlyph() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 4h2M8 4h5M3 8h7M3 12h2M8 12h5" />
      <circle cx={6.5} cy={8} r={0.6} fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Tiny inline chevron — own SVG, currentColor, rotates on open. Matches the
 *  one ReasoningBlock/ToolCard use so disclosure rows share a rhythm. */
function Chevron({ dir }: { dir: "up" | "down" }) {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: dir === "up" ? "rotate(180deg)" : undefined,
        transition: "transform var(--motion-fast)",
      }}
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
