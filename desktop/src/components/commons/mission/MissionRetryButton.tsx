// MissionRetryButton — the one retry affordance shared across Mission Control.
// Used as a per-card / per-row "Retry" on a single failed run AND as the Failed
// column's "Retry all". It re-arms the given runs back into the ready set
// through the parent's `onRetry` (one click → the work re-queues; the next Run
// crew picks it back up). `stopPropagation` on BOTH mousedown and click so it
// never also selects/opens the card or row it sits on. Renders nothing when
// there's no handler or no run carries a re-armable `nodeId`, so it is safe to
// drop into any failed slot — list row, board card, or column header.
//
// Audience: non-engineers. The label is plain ("Retry" / "Retry all") and the
// tooltip says exactly what happens in human words, never "re-arm node".

import type { JSX } from "react";
import { RotateCcw } from "lucide-react";

import type { MissionRun } from "../../../lib/api";

export function MissionRetryButton({
  runs,
  onRetry,
  label,
  className = "",
}: {
  runs: MissionRun[];
  onRetry?: (runs: MissionRun[]) => void;
  label: string;
  className?: string;
}): JSX.Element | null {
  const armable = runs.filter((r) => r.nodeId);
  if (!onRetry || armable.length === 0) return null;
  return (
    <button
      type="button"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onRetry(armable);
      }}
      className={`inline-flex flex-shrink-0 items-center gap-1 rounded-[5px] border border-line-soft px-1.5 py-[3px] text-[10.5px] font-medium text-text-3 transition-colors hover:border-accent/60 hover:bg-accent/[0.06] hover:text-accent ${className}`}
      title={
        armable.length > 1
          ? `Re-queue ${armable.length} failed tasks`
          : "Re-queue this task"
      }
    >
      <RotateCcw
        className="h-3 w-3 flex-shrink-0"
        strokeWidth={1.5}
        aria-hidden
      />
      {label}
    </button>
  );
}
