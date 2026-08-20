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

  return (
    <div
      className="flex items-center gap-1 min-w-0 text-2xs leading-[14px]"
      title={copy.full}
    >
      {isImpact ? (
        // Amber, not red. Someone's agent noticing that you both touch the
        // same thing is an ask, not a fault — red in this app means broken.
        <AlertTriangle
          size={10}
          className="flex-none text-amber"
          aria-hidden
          strokeWidth={2}
        />
      ) : (
        <span
          aria-hidden
          className="flex-none rounded-full bg-text-4"
          style={{ width: 3, height: 3, marginLeft: 3, marginRight: 3 }}
        />
      )}
      <span className="min-w-0 truncate">
        <span className={isImpact ? "text-amber" : "text-text-3"}>
          {copy.who}
        </span>
        {copy.ref ? (
          <>
            {" "}
            <code className="font-mono text-accent">{copy.ref}</code>
          </>
        ) : null}
        {copy.said ? (
          <>
            {" "}
            <span className="text-text-4">{copy.said}</span>
          </>
        ) : null}
      </span>
    </div>
  );
}
