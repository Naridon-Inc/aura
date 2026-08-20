// The task handle ("AURA-42") — click to copy.
//
// Lives in its own module because four surfaces need it (the board card, the
// list row, the detail pane and the peek overlay) and it used to be exported
// from the 3,000-line TasksBoard, which made every one of those imports drag
// the whole board in behind it.
//
// Falls back to rendering nothing when `sequence_id` is 0 — legacy rows that
// haven't been healed yet (see `backfill_sequence_ids` on the Rust side)
// genuinely have no handle, and inventing one would be worse than omitting it.

import { useState, type JSX } from "react";

export function TaskIdChip({
  sequenceId,
  className,
}: {
  sequenceId: number;
  className?: string;
}): JSX.Element | null {
  const [copied, setCopied] = useState(false);
  if (!sequenceId || sequenceId <= 0) return null;
  const label = `AURA-${sequenceId}`;

  const copy = (e: { stopPropagation: () => void }): void => {
    // stopPropagation so copying the handle doesn't also open the card's
    // detail drawer underneath it.
    e.stopPropagation();
    try {
      void navigator.clipboard.writeText(label);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard rejected (rare in the Tauri webview) — leave the UI quiet
      // rather than surfacing an error for something this incidental.
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      onMouseDown={(e) => e.stopPropagation()}
      title={copied ? "Copied" : `Copy ${label}`}
      aria-label={copied ? "Copied" : `Copy ${label}`}
      className={
        className ??
        "rounded px-1 py-0 font-mono text-xs leading-4 text-text-3 transition-colors hover:bg-state-hover hover:text-text-1"
      }
    >
      {copied ? "copied" : label}
    </button>
  );
}
