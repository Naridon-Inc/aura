// The bar that floats over the board while tasks are selected: how many
// are selected, the actions that apply to all of them, the result of the
// last action, and a way to clear the selection.

import type { ReactNode } from "react";
import { X } from "lucide-react";

import { Button } from "./button";
import "./tasks-selection-bar.css";

export function TaskSelectionBar({
  count,
  children,
  status,
  onClear,
  busy = false,
}: {
  count: number;
  children: ReactNode;
  /** The outcome of the last action, or why it failed. */
  status?: { text: string; tone: "neutral" | "error" } | null;
  onClear: () => void;
  busy?: boolean;
}) {
  return (
    <div role="toolbar" aria-label="Selected tasks" className="ui-tasks-selection-bar">
      <span className="ui-tasks-selection-count">{count} selected</span>
      <span className="ui-tasks-selection-divider" aria-hidden />
      {children}
      {status && (
        <span className="ui-tasks-selection-status" data-tone={status.tone} role="status">
          {status.text}
        </span>
      )}
      <Button
        variant="ghost"
        size="iconXs"
        onClick={onClear}
        disabled={busy}
        aria-label="Clear selection"
        title="Clear selection"
      >
        <X aria-hidden />
      </Button>
    </div>
  );
}

export function TaskSelectionDivider() {
  return <span className="ui-tasks-selection-divider" aria-hidden />;
}
