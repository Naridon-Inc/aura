// The point of the whole feature: one line under a session row saying what is
// happening inside it, readable from the rail without opening anything.
//
// One line, and only one. A session where two agents are working can produce a
// frame a second; rendering them would turn the calmest surface in the app into
// a log tail. `pickActivity` (railModel) does the choosing — impact outranks
// chatter, latest wins inside a rank, and anything past its window is dropped —
// so by the time this component runs there is exactly one thing to say or
// nothing at all. Nothing at all renders nothing: the row goes quiet on its
// own, with no separate "clear" anywhere.
//
// The line truncates rather than wraps. A session row that can grow to three
// lines because someone's agent was verbose breaks the rail's rhythm for every
// row below it, and the full text is one hover away.
//
// Named `ActivityLine`, not `SessionActivityLine`, because `sessionLiveStore`
// already exports a TYPE by that name — the rail will import both, and two
// things called the same thing in one file is an alias waiting to be forgotten.

import { AlertTriangle } from "lucide-react";

import { describeActivity } from "./railActivity";
import type { RailActivity, RailActor } from "./railModel";
import "../../ui/people-rail.css";

export type ActivityLineProps = {
  /** The one thing worth saying, already chosen. Null renders nothing. */
  activity: RailActivity | null;
  /** Every actor on the rail, so speakers can be named. */
  byId: Map<string, RailActor>;
};

export function ActivityLine({ activity, byId }: ActivityLineProps) {
  if (!activity) return null;
  const copy = describeActivity(activity, byId);
  const isImpact = activity.kind === "impact";

  // A span, not a div: the line sits inside the session row's button.
  return (
    <span
      className="ui-rail-activity"
      data-kind={isImpact ? "impact" : undefined}
      title={copy.full}
    >
      {isImpact ? (
        <AlertTriangle size={10} aria-hidden strokeWidth={2} />
      ) : (
        <span aria-hidden className="ui-rail-activity-dot" />
      )}
      <span>
        <span className="ui-rail-activity-who">{copy.who}</span>
        {copy.ref ? (
          <>
            {" "}
            <code>{copy.ref}</code>
          </>
        ) : null}
        {copy.said ? (
          <>
            {" "}
            <span className="ui-rail-activity-said">{copy.said}</span>
          </>
        ) : null}
      </span>
    </span>
  );
}
