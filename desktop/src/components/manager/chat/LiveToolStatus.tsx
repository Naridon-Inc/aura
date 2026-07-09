//! Consecutive ACTION tool calls, clubbed into one living status bar.
//!
//! Read-only bursts collapse into `ExploringGroup` ("Exploring… / Explored").
//! Their world-changing siblings — a run of edit / write / run / dispatch /
//! task calls fired back-to-back for the same plan — used to stack as a tower
//! of separate cards. This clubs them instead: a single bar that *morphs*
//! through the run. While the brain works it mirrors the active step
//! ("Editing · ToolCard.tsx" → its result → "Running · cargo check"), a dot
//! rail tracking how far the sequence has progressed. When the run settles it
//! reads as one calm summary ("Ran 4 steps · cargo check"). Click expands to
//! every step's full card — nothing is hidden, just folded.
//!
//! The same "intent/plan is the same → show one living status, not ten cards"
//! ask the user raised for the tool stream. Streaming-only: tool blocks aren't
//! persisted, so this never has to render a settled-reload timeline.
//!
//! Tokens only — colours track the theme; the bar must never out-shout the
//! prose it sits beside.

import { useState } from "react";

import { describeTool } from "./toolDescribe";
import { ToolCard } from "./ToolCard";
import { FileDiffTool, isFileDiffTool } from "./FileDiffTool";
import type { StreamBlock, ToolStatus } from "./types";

type ToolBlock = Extract<StreamBlock, { kind: "tool" }>;

/** Per-tool status from its result: absent → running, error flag → error,
 *  else ok. The same derivation `ToolCard` uses, kept local so the bar and
 *  the cards it expands to agree. */
function statusOf(t: ToolBlock): ToolStatus {
  if (!t.result) return "running";
  return t.result.is_error ? "error" : "ok";
}

/** Render one tool block the way the bubble would on its own — an inline
 *  Monaco diff for edits/writes with extractable content, else the generic
 *  card. Reused for every row of the expanded list so a clubbed edit keeps
 *  its diff. */
function renderToolBlock(t: ToolBlock, key: string | number) {
  if (isFileDiffTool(t.name, t.input)) {
    return <FileDiffTool key={key} name={t.name} input={t.input} result={t.result} />;
  }
  return <ToolCard key={key} name={t.name} input={t.input} result={t.result} />;
}

/** A run of ≥2 consecutive action-tier tool calls, rendered as one morphing
 *  status bar that expands to the individual cards. */
export function LiveToolStatus({ tools }: { tools: ToolBlock[] }) {
  const [open, setOpen] = useState(false);

  // The step the bar currently reflects: the first one still running (the
  // live edge), or — once everything has landed — the last one, so the bar
  // settles on the final result instead of snapping back to the top.
  const runningIdx = tools.findIndex((t) => !t.result);
  const activeIdx = runningIdx === -1 ? tools.length - 1 : runningIdx;
  const active = tools[activeIdx]!;
  const activeView = describeTool(active.name, active.input, active.result);
  const activeStatus = statusOf(active);

  const allDone = runningIdx === -1;
  const anyError = tools.some((t) => t.result?.is_error);

  // Headline: while the run is live it IS the active step (verb · subject),
  // so the one bar morphs action→action as the stream advances. Once settled
  // it folds into a count + the last subject — the calm post-run summary.
  const verb = allDone ? `Ran ${tools.length} steps` : activeView.verb;
  const subject = activeView.subject;

  return (
    <div>
      {/* Flat header line — a chevron leads, then a plain verb (no box, no
          [RUNNING] shout). Live: "Working · N steps"; settled: "Ran N steps".
          The dot rail + active subject + metric ride the right edge. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? "Collapse steps" : "Show every step"}
        className="aura-tool-row"
      >
        {/* Chevron fills the fixed leading column so the verb after it lands at
            the same x as every other row's verb. */}
        <span className="aura-tool-glyph" style={{ color: "var(--color-text-4)" }}>
          <Chevron dir={open ? "up" : "down"} />
        </span>
        <span
          className="aura-tool-chip-verb"
          style={anyError ? { color: "var(--color-red)" } : undefined}
        >
          {verb}
        </span>
        {!allDone && (
          <span
            className="shrink-0 tabular-nums text-[10.5px]"
            style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-3)" }}
          >
            · {tools.length} steps
          </span>
        )}
        {/* Right cluster: the dot rail (live progression — done fill green,
            active pulses, pending hollow), the active step's subject, and its
            result metric once it lands. Pushed right as one unit. */}
        <span className="ml-auto flex items-center gap-2 min-w-0">
          <StepDots tools={tools} activeIdx={activeIdx} />
          {subject && (
            <span
              className={`min-w-0 truncate text-[11.5px] ${activeView.mono ? "font-mono" : ""}`}
              style={{ color: "var(--color-text-3)" }}
              title={subject}
            >
              {subject}
            </span>
          )}
          {activeStatus !== "running" && activeView.metric && (
            <span
              className="shrink-0 tabular-nums text-[10.5px]"
              style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-3)" }}
            >
              {activeView.metric}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="aura-tool-substream">
          {tools.map((t, i) => renderToolBlock(t, t.tool_use_id || i))}
        </div>
      )}
    </div>
  );
}

/** A compact rail of step pips — done (filled), active (pulsing), pending
 *  (hollow). Caps at 8 visible so a long run doesn't sprawl; the overflow
 *  count rides along as "+N". */
function StepDots({
  tools,
  activeIdx,
  className = "",
}: {
  tools: ToolBlock[];
  activeIdx: number;
  className?: string;
}) {
  const MAX = 8;
  const overflow = tools.length - MAX;
  const shown = overflow > 0 ? tools.slice(0, MAX) : tools;
  return (
    <span className={`flex items-center gap-1 shrink-0 ${className}`} aria-hidden>
      {shown.map((t, i) => {
        const st = statusOf(t);
        const isActive = i === activeIdx;
        const bg =
          st === "error"
            ? "var(--color-red)"
            : st === "ok"
              ? "var(--color-text-3)"
              : isActive
                ? "var(--color-text-2)"
                : "transparent";
        return (
          <span
            key={t.tool_use_id || i}
            className={isActive && st === "running" ? "animate-pulse" : ""}
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: bg,
              border:
                bg === "transparent" ? "1px solid var(--color-line)" : "none",
            }}
          />
        );
      })}
      {overflow > 0 && (
        <span
          className="tabular-nums t-2xs"
          style={{ color: "var(--color-text-4)", fontFamily: "var(--font-mono)" }}
        >
          +{overflow}
        </span>
      )}
    </span>
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
