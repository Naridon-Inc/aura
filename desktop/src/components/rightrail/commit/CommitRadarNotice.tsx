// Shown when a commit is about to land on code a teammate or another agent is
// working on right now. It informs and never blocks: "Commit anyway" resumes
// the commit that was interrupted, "Review first" puts it down.

import type { RadarCollision } from "../../../lib/api";
import { ShellNotice } from "../../ui/shell-notice";
import { actorShort, agoFromMs, severityMeta } from "../radar/radarFormat";

/** Rows drawn before the rest are summarised; the Team Radar panel has all of them. */
const SHOWN = 3;

export function CommitRadarNotice({
  warnings,
  onCommitAnyway,
  onReviewFirst,
}: {
  warnings: RadarCollision[];
  onCommitAnyway: () => void;
  onReviewFirst: () => void;
}) {
  return (
    <ShellNotice
      tone="attention"
      action={{ label: "Commit anyway", onClick: onCommitAnyway }}
      secondary={{ label: "Review first", onClick: onReviewFirst }}
      onDismiss={onReviewFirst}
      dismissLabel="Dismiss"
      detail={
        <ul className="ui-details-commit-radar">
          {warnings.slice(0, SHOWN).map((c) => {
            const meta = severityMeta(c.severity);
            return (
              <li
                key={c.event_id}
                title={[c.reason, c.their_intent].filter(Boolean).join("\n")}
              >
                <i style={{ background: meta.color }} aria-hidden />
                <span>
                  <strong>{actorShort(c.peer)}</strong>
                  {c.peer_is_agent ? " (agent)" : ""} · {meta.disposition} ·{" "}
                  <code>{c.their_symbol || c.their_file || "your in-flight files"}</code>{" "}
                  · {agoFromMs(c.age_ms)}
                  {!c.same_branch && c.their_branch ? ` on ${c.their_branch}` : ""}
                </span>
              </li>
            );
          })}
          {warnings.length > SHOWN && (
            <li className="ui-details-commit-radar-more">
              +{warnings.length - SHOWN} more in the Team Radar panel
            </li>
          )}
        </ul>
      }
    >
      {warnings.length === 1
        ? "A teammate is on this code"
        : `${warnings.length} teammates are on this code`}
    </ShellNotice>
  );
}
