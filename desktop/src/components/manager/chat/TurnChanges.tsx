//! Per-round "what changed" block, shown at the foot of a settled turn.
//!
//! Antigravity closes each agent round with a small block — "1 file changed ·
//! +30 −2" plus a way to review the moves — and it reads really well: you get a
//! glance-level receipt of what the turn actually did to your code, right under
//! the answer, without scrolling the step-run open. This is that block, on real
//! data: `extractTurnChanges` folds the turn's persisted edit/write tool calls
//! into a per-file tally, and the block renders the totals collapsed. "Review"
//! expands the same inline before/after diffs (`FileDiffTool`, the shared Monaco
//! engine) the step-run uses — so reviewing the round and opening a step show
//! the identical diff, never two sources of truth.
//!
//! Plain language for the vibecoder audience: "files changed", "+/−" lines, and
//! "Review" — no commit/stat/hunk jargon. Green = added, red = removed (status
//! colours, allowed); the Review affordance leans on the in-chat accent.

import { useState } from "react";

import { FileDiffTool } from "./FileDiffTool";
import type { TurnChangeSummary } from "./turnChangeSummary";
import { basename } from "../../../lib/paths";

/** The round's change receipt. Collapsed: a one-line tally. Expanded: the
 *  per-file before/after diffs. Renders nothing when `summary` is null upstream
 *  (the caller guards), so a read-only / command-only turn shows no block. */
export function TurnChanges({ summary }: { summary: TurnChangeSummary }) {
  const [open, setOpen] = useState(false);
  const { files, filesChanged, added, removed } = summary;

  return (
    <div
      className="mt-2 overflow-hidden"
      style={{
        background: "var(--color-bg-1)",
        border: "1px solid var(--color-line)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left min-w-0 transition-colors hover:bg-[color-mix(in_srgb,var(--color-text-3)_6%,transparent)]"
        aria-expanded={open}
        title={open ? "Hide the changes" : "Review the changes from this round"}
      >
        <span aria-hidden style={{ color: "var(--color-text-3)" }}>
          <FileEditGlyph />
        </span>
        <span className="t-xs t-ui shrink-0" style={{ color: "var(--color-text-1)" }}>
          {filesChanged === 1 ? "1 file changed" : `${filesChanged} files changed`}
        </span>
        <span
          className="shrink-0 tabular-nums text-xs flex items-center gap-1.5"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {added > 0 && (
            <span style={{ color: "var(--color-accent-green)" }}>+{added}</span>
          )}
          {removed > 0 && (
            <span style={{ color: "var(--color-red)" }}>−{removed}</span>
          )}
        </span>
        <span
          className="ml-auto shrink-0 flex items-center gap-1 t-2xs t-ui"
          style={{ color: "var(--color-accent)" }}
        >
          {open ? "Hide" : "Review"}
          <Chevron dir={open ? "up" : "down"} />
        </span>
      </button>

      {open && (
        <div
          className="border-t flex flex-col gap-1.5 px-2 py-2"
          style={{ borderColor: "var(--color-line-soft)" }}
        >
          {files.map((f, i) =>
            f.block ? (
              // A renderable edit/write call → the real inline before/after diff,
              // the same card the step-run shows.
              <FileDiffTool
                key={f.path + i}
                name={f.block.name}
                input={f.block.input}
                result={f.block.result}
              />
            ) : (
              // multiedit / apply_patch tally with no single old/new pair to
              // mount Monaco on — an honest one-line stat row, no faked diff.
              <div
                key={f.path + i}
                className="flex items-center gap-2 px-1.5 py-1 min-w-0"
                title={f.path}
              >
                <span
                  className="min-w-0 truncate font-mono text-xs"
                  style={{ color: "var(--color-text-1)" }}
                >
                  {basename(f.path) || f.path}
                </span>
                <span
                  className="ml-auto shrink-0 tabular-nums text-xs flex items-center gap-1.5"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {f.added > 0 && (
                    <span style={{ color: "var(--color-accent-green)" }}>+{f.added}</span>
                  )}
                  {f.removed > 0 && (
                    <span style={{ color: "var(--color-red)" }}>−{f.removed}</span>
                  )}
                </span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** A small file-with-a-pencil glyph — quiet monoline matching the tool-row
 *  weight, so the block reads as one of the chat family. */
function FileEditGlyph() {
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
      <path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z" />
      <path d="M9 1.5V5.5h4" />
      <path d="M6 9.5l1.5-.4 3-3-1.1-1.1-3 3z" />
    </svg>
  );
}

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
