// Reusable 3-dot overflow menu for pane headers (AgentSurface,
// TerminalPaneSurface, FilePaneSurface). Folds Split / Story / Blocks
// / Restart / Stop / Close-pane / Leave-split into one chip so the
// pane header keeps its real estate for status chips and identity.

import { useRef, useState, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { MENU_PANEL, MENU_ROW, MENU_ROW_DANGER, MENU_SEP } from "./ui/menuSurface";
import { useDismiss } from "../lib/useDismiss";

export type PaneMenuItem =
  | {
      kind: "item";
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      icon?: ReactNode;
      tone?: "default" | "danger";
    }
  | { kind: "separator" };

type Props = {
  items: PaneMenuItem[];
  /** Optional title attribute for the trigger. */
  title?: string;
  /** Inline style override for the trigger button — used by AgentSurface
   *  to tint the dots in the agent's brand colour. */
  triggerClassName?: string;
};

export function PaneOverflowMenu({ items, title = "More actions", triggerClassName }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useDismiss(open, () => setOpen(false), wrapRef);

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        className={
          triggerClassName ??
          "w-7 h-6 inline-flex items-center justify-center rounded text-text-3 hover:text-text-1 hover:bg-state-hover transition-colors"
        }
      >
        <DotsIcon />
      </button>
      {open && (
        <div
          role="menu"
          className={cn(MENU_PANEL, "absolute right-0 top-7 min-w-[180px]")}
        >
          {items.map((item, i) =>
            item.kind === "separator" ? (
              <div key={`sep-${i}`} className={MENU_SEP} />
            ) : (
              <button
                key={`it-${i}-${item.label}`}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return;
                  setOpen(false);
                  item.onSelect();
                }}
                className={cn(MENU_ROW, item.tone === "danger" && MENU_ROW_DANGER)}
              >
                {item.icon && (
                  <span className="inline-flex items-center justify-center">{item.icon}</span>
                )}
                <span className="truncate">{item.label}</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}
