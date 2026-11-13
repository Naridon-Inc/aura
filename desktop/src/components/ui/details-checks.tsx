// A check row with an action — the check-run list's row, for checks the
// reader can act on (push, pull, run a review) rather than only watch.

import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Check, Circle, X } from "lucide-react";

import { AsciiSpinner } from "./ascii-spinner";
import { Button } from "./button";
import "./details-checks.css";

export type DetailsCheckStatus = "pending" | "running" | "passed" | "failed";

/** Rows drawn with the check-run list's own layout. `flat` drops the rules
 *  between rows and sets them as one quiet list: a mark, a line of text and
 *  a text action at the end. */
export function DetailsCheckList({ children, flat = false }: { children: ReactNode; flat?: boolean }) {
  return <div className={flat ? "ui-check-runs ui-check-runs--flat" : "ui-check-runs"}>{children}</div>;
}

/** The scroll body of a checks tab: check lists, captions and documents. */
export function DetailsChecks({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="ui-details-checks min-h-0 overflow-y-auto overflow-x-hidden" style={style}>
      {children}
    </div>
  );
}

/** A draggable hairline between two stacked panes. */
export function DetailsSplit({ onPointerDown }: { onPointerDown: (e: ReactPointerEvent) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      title="Drag to resize"
      className="ui-details-split"
      onPointerDown={onPointerDown}
    />
  );
}

export function DetailsCheckRow({
  status,
  icon,
  title,
  detail,
  hint,
  action,
  onClick,
  trailing,
  nested = false,
}: {
  status: DetailsCheckStatus;
  /** Replaces the status mark when the row is idle — a row that launches a
   *  tool rather than tracking a step. */
  icon?: ReactNode;
  title: string;
  detail?: string;
  /** The longer explanation, on hover. */
  hint?: string;
  action?: { label: string; onClick: () => void };
  /** The whole row opens something (the merge queue page). */
  onClick?: () => void;
  /** Drawn where the action goes, for a row that opens on click. */
  trailing?: ReactNode;
  /** One of the rows a roll-up row opens out into, set in under it. */
  nested?: boolean;
}) {
  const mark =
    status === "running" ? (
      <AsciiSpinner />
    ) : status === "passed" ? (
      <Check size={14} />
    ) : status === "failed" ? (
      <X size={14} />
    ) : (
      icon ?? <Circle size={14} />
    );
  return (
    <div
      data-status={status}
      data-clickable={onClick ? "" : undefined}
      data-nested={nested ? "" : undefined}
      title={hint}
      role={onClick ? "link" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              // Only the row's own keys: Enter on its action button is the action's.
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {mark}
      <span>
        {title}
        {detail && <small>{detail}</small>}
      </span>
      {status === "running" ? (
        <Button size="xs" variant="ghost" disabled>
          Working…
        </Button>
      ) : trailing ? (
        trailing
      ) : (
        action && (
          <Button
            size="xs"
            variant="ghost"
            onClick={(e) => {
              // The row may open something of its own; the action is not that.
              e.stopPropagation();
              action.onClick();
            }}
          >
            {action.label}
          </Button>
        )
      )}
    </div>
  );
}
