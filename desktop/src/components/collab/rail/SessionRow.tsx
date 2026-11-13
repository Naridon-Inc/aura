// One session, under the person whose it is.
//
// Two tiers, and the second one only when there is something to put in it:
//
//   ● Retry path for rate limits            🦊  4m
//     ◉◉◉◉  Claude → Claude: planning the retry path
//
// The top tier is the row you click — a status glyph, the title, who moved
// last, and how long ago. The bottom tier is the live one: who is in the room
// and the single freshest thing they did. It disappears when the session goes
// quiet, so an idle rail is a list of one-line rows and only the sessions that
// are actually alive cost a second line.
//
// A `<div role="button">` rather than a `<button>` because the row contains the
// Join control, and a button inside a button is invalid — clicking the row
// shows you the session, clicking Join puts you in it, and those are different
// enough to need two targets.

import { relativeAgeFromSecs } from "../../../lib/relativeTime";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { ActivityLine } from "./ActivityLine";
import { JoinSessionButton } from "./JoinSessionButton";
import { ParticipantPips } from "./ParticipantPips";
import { RailAvatar } from "./RailAvatar";
import { pickActivity } from "./railActivity";
import { isSessionLive, type RailActor, type RailSession } from "./railModel";
import "../../ui/people-rail.css";

export type SessionRowProps = {
  session: RailSession;
  /** Every actor on the rail, so an activity line can name people who aren't
   *  in this session's own participant list. */
  byId: Map<string, RailActor>;
  /** Epoch SECONDS. Passed down rather than read here so every row on the rail
   *  ages and decays on the same tick. */
  nowSecs: number;
  /** Whose session this is — the Join control names the room it opens. */
  ownerName: string;
  /** This is the session on screen. */
  active?: boolean;
  onOpen: (sessionId: string) => void;
  /** Omitted for your own sessions — you are already in them. */
  onJoin?: (sessionId: string) => void | Promise<void>;
};

/** The status slot a workspace row's icon takes: working, live, or quiet. */
function StatusGlyph({ session }: { session: RailSession }) {
  if (session.agentBusy) {
    return (
      <span
        className="ui-workspace-status"
        data-status="working"
        style={{ width: 14, height: 14 }}
        title="An agent is working in here"
      >
        <AsciiSpinner size={14} />
      </span>
    );
  }
  const live = isSessionLive(session);
  return (
    <span
      className="ui-workspace-status"
      style={{ width: 14, height: 14 }}
      title={live ? "Someone is in here" : "Nobody is in here right now"}
      aria-hidden
    >
      <span className="ui-rail-live-dot" data-live={live || undefined} />
    </span>
  );
}

export function SessionRow({
  session,
  byId,
  nowSecs,
  ownerName,
  active = false,
  onOpen,
  onJoin,
}: SessionRowProps) {
  const activity = pickActivity(session.activity, nowSecs);
  const live = isSessionLive(session);
  const lastActor = session.lastActorId
    ? byId.get(session.lastActorId)
    : undefined;
  const showSecondTier = live || activity !== null;

  // The shared age ladder, read off the rail's own clock rather than the wall
  // clock — otherwise a pinned `nowSecs` (the screenshot harness) would decay
  // the activity line at one time and print the age at another.
  const clock = { now: nowSecs * 1000 };
  const age = relativeAgeFromSecs(session.lastAt, {
    ...clock,
    style: "compact",
  });
  const agePose = relativeAgeFromSecs(session.lastAt, {
    ...clock,
    style: "prose",
  });
  const rowTitle = lastActor
    ? `${session.title} · ${lastActor.name} moved ${agePose}`
    : session.title;

  // A workspace row, with room for a second line. The row is one real button
  // now: Join sits in the item's actions slot beside it, the way a
  // workspace's menu does, instead of inside a div standing in for a button.
  return (
    <div
      className="ui-sidebar-item ui-rail-session"
      data-workspace="true"
      data-selected={active || undefined}
    >
      <button
        type="button"
        className="ui-sidebar-item-target"
        aria-current={active ? "page" : undefined}
        title={rowTitle}
        onClick={() => onOpen(session.id)}
      >
        <span className="ui-rail-session-line">
          <StatusGlyph session={session} />
          <span className="ui-sidebar-item-label">{session.title}</span>
          {lastActor || age ? (
            <span className="ui-sidebar-item-trailing ui-rail-session-trailing">
              {lastActor ? (
                <RailAvatar
                  actor={lastActor}
                  size={16}
                  title={`${lastActor.name} moved ${agePose}`}
                />
              ) : null}
              {age ? <span>{age}</span> : null}
            </span>
          ) : null}
        </span>

        {showSecondTier ? (
          <span className="ui-rail-session-detail">
            {live ? (
              <ParticipantPips
                participants={session.participants}
                byId={byId}
                size={14}
              />
            ) : null}
            <ActivityLine activity={activity} byId={byId} />
          </span>
        ) : null}
      </button>
      {!session.joined && onJoin ? (
        <div className="ui-sidebar-item-actions">
          <JoinSessionButton
            sessionId={session.id}
            ownerName={ownerName}
            hostOnline={session.hostOnline}
            access={session.access}
            onJoin={onJoin}
          />
        </div>
      ) : null}
    </div>
  );
}
