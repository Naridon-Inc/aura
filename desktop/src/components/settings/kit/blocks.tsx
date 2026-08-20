import * as React from "react";
import { RefreshCw } from "lucide-react";

import { cn } from "../../../lib/utils";

// The two blocks a label-and-control row can't carry: a set of facts about
// something, and whether we can reach it right now.
//
// Deliberately small. Three other patterns were built for this file and
// then removed, because each one re-introduced something the app had
// already decided against:
//   • a bordered empty-state box — `ui/state.tsx` rejects exactly that
//     shape by name ("the middle variant's job, drawing a bordered box, is
//     one we don't want at all"), and `EmptyState` already covers the case;
//   • a rounded card per option in a pick-list, selected one wearing an
//     accent border and fill — `BrainTab` is on record replacing precisely
//     that with hairline rows and a single `row-selected` mark;
//   • a per-engine tab strip, which has no pane to live in yet.
// A primitive nobody calls is a suggestion the next person has to evaluate.

export type KeyValueRow = {
  key: string;
  label: string;
  value: React.ReactNode;
  /** Renders the value in the mono face — for paths, ids, commands. */
  mono?: boolean;
};

/** A read-only table of facts: which files, which device, when. The label
 *  column is a fixed width so the values line up into a column you can
 *  read down, which is the whole reason this isn't three sentences. */
export function KeyValueTable({ rows }: { rows: KeyValueRow[] }) {
  return (
    <div className="divide-y divide-line-soft overflow-hidden rounded-lg border border-line-soft">
      {rows.map((r) => (
        <div key={r.key} className="flex items-baseline gap-4 px-3.5 py-2.5">
          <span className="w-[132px] shrink-0 text-[13px] text-text-3">{r.label}</span>
          <span
            className={cn(
              "min-w-0 flex-1 text-right text-[13px] text-text-2",
              r.mono && "font-mono text-xs",
            )}
          >
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Whether something we depend on is reachable, and a way to ask again.
 *  The dot is a second channel for the word beside it, not a replacement:
 *  a colour on its own is a state nobody was taught. */
export function ConnectionStatus({
  state,
  label,
  onRefresh,
  refreshing,
}: {
  state: "connected" | "disconnected" | "checking";
  /** Overrides the default wording when the pane has something better to say. */
  label?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const text =
    label ??
    (state === "connected"
      ? "Connected"
      : state === "checking"
        ? "Checking…"
        : "Not connected");
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          state === "connected" ? "bg-accent" : "bg-text-4",
        )}
      />
      <span className="text-[13px] text-text-2">{text}</span>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="ml-1 flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-text-2 transition-colors hover:bg-state-hover disabled:opacity-50"
        >
          <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
          Refresh
        </button>
      )}
    </div>
  );
}
