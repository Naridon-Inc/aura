//! Consecutive read-only tool calls, batched into one collapsible group.
//!
//! When the brain is gathering context it fires a burst of read/grep/glob/ls/
//! fetch calls — each one rendering as its own quiet "thinking" line clutters
//! the timeline. `ExploringGroup` collapses a run of ≥2 consecutive read-only
//! tools into a single "Exploring…" header (with a count + the files touched)
//! that expands to the individual cards. Action tools (edit/write/run/dispatch)
//! are never grouped — those are world-changing and each deserves its own card.
//!
//! The grouping decision is the registry's `tier`, not a hardcoded name list:
//! `describeTool(...).tier === "thinking"` is exactly the read-only set, so a
//! new read tool added to the registry is grouped automatically.

import { useState } from "react";

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

/** Collapsed-by-default group of consecutive read-only tool cards. Renders a
 *  summary header (count + the distinct subjects it touched) that expands to
 *  the individual `ToolCard`s. While any tool in the group is still running
 *  the header shows a live pip so the user knows exploration is ongoing. */
export function ExploringGroup({ tools }: { tools: ToolBlock[] }) {
  const [open, setOpen] = useState(false);
  const running = tools.some((t) => !t.result);

  // A compact list of the distinct subjects the run touched — the basenames /
  // patterns the registry already extracted — so the collapsed header is
  // informative ("Read 4 files · api.ts, ToolCard.tsx, …") without expanding.
  const subjects: string[] = [];
  for (const t of tools) {
    const subj = describeTool(t.name, t.input, t.result).subject;
    if (subj && !subjects.includes(subj)) subjects.push(subj);
  }
  const subjectLabel =
    subjects.length > 0
      ? subjects.slice(0, 3).join(" · ") +
        (subjects.length > 3 ? ` +${subjects.length - 3}` : "")
      : "";

  return (
    <div>
      {/* Flat header line — same leading-column · verb · count · subjects ·
          trailing-chevron skeleton as a lone read row, so a grouped burst and
          a single read sit in one uniform vertical list. A leading pip (pulses
          while exploring) fills the fixed glyph column; no box, no [ ] shout. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="aura-tool-row"
      >
        <span className="aura-tool-glyph">
          <span
            aria-hidden
            className={`inline-block rounded-full ${running ? "animate-pulse" : ""}`}
            style={{
              width: 6,
              height: 6,
              background: running ? "var(--color-text-3)" : "var(--color-text-4)",
            }}
          />
        </span>
        <span className="aura-tool-chip-verb">
          {running ? "Exploring…" : "Explored"}
        </span>
        <span
          className="shrink-0 text-right tabular-nums t-2xs"
          style={{
            color: "var(--color-text-4)",
            fontFamily: "var(--font-mono)",
            minWidth: "2ch",
          }}
        >
          {tools.length}
        </span>
        {subjectLabel && (
          <span className="aura-tool-chip-subject" title={subjectLabel}>
            {subjectLabel}
          </span>
        )}
        <span className="ml-auto shrink-0" style={{ color: "var(--color-text-4)" }}>
          <Chevron dir={open ? "up" : "down"} />
        </span>
      </button>
      {open && (
        <div className="aura-tool-substream">
          {tools.map((t, i) => (
            <ToolCard key={t.tool_use_id || i} name={t.name} input={t.input} result={t.result} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Tiny inline chevron — own SVG, currentColor, rotates on open. */
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
