// Pull-request rows for the details panel: number and title over author,
// branch, review decision, CI state and the line counts — and, where the host
// gives one, an action at the row's end beside the button that opens it.

import type { ReactNode } from "react";

import "./details-pulls.css";
import { DiffCount } from "./sidebar";

export type DetailsPullTone = "good" | "bad" | "waiting" | "quiet";

export function DetailsPullRow({
  number,
  title,
  author,
  branch,
  risk,
  decision,
  checks,
  added,
  removed,
  selected,
  onSelect,
  action,
}: {
  number: number;
  title: string;
  author: string;
  branch: string;
  /** How much the change needs a look: "bad" is risky, "waiting" a little. */
  risk: DetailsPullTone;
  decision?: { label: string; tone: DetailsPullTone };
  checks?: { label: string; tone: DetailsPullTone };
  added: number;
  removed: number;
  selected: boolean;
  onSelect: () => void;
  /** A control of its own at the row's end ("Open as workspace"), kept out
   *  of the row's button so the two never nest. */
  action?: ReactNode;
}) {
  const row = (
    <button type="button" className="ui-details-pull" data-selected={selected} onClick={onSelect}>
      <div>
        <span className="ui-details-pull-dot" data-tone={risk} aria-hidden />
        <span className="ui-details-pull-number">#{number}</span>
        <span className="ui-details-pull-title">{title}</span>
      </div>
      <div className="ui-details-pull-meta">
        <span>{author}</span>
        <span className="ui-details-pull-branch">{branch}</span>
        {decision && (
          <span className="ui-details-pull-decision" data-tone={decision.tone}>
            {decision.label}
          </span>
        )}
        {checks && (
          <span
            className="ui-details-pull-dot ui-details-pull-dot--small"
            data-tone={checks.tone}
            title={checks.label}
            aria-label={checks.label}
          />
        )}
        <DiffCount added={added} removed={removed} />
      </div>
    </button>
  );
  if (!action) return row;
  return (
    <div className="ui-details-pull-item">
      {row}
      <div className="ui-details-pull-action">{action}</div>
    </div>
  );
}
