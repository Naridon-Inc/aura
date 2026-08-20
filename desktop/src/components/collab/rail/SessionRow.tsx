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

/** The 16px glyph slot: working, live, or quiet. */
function StatusGlyph({ session }: { session: RailSession }) {
  if (session.agentBusy) {
    // The house loader, for the one thing in this rail that is genuinely
    // running. Nothing else here spins.
    return (
      <span
        className="flex-none grid place-items-center"
        style={{ width: 16, height: 16 }}
        title="An agent is working in here"
      >
        <AsciiSpinner size={11} />
      </span>
    );
  }
  const live = isSessionLive(session);
  return (
    <span
      className="flex-none grid place-items-center"
      style={{ width: 16, height: 16 }}
      title={live ? "Someone is in here" : "Nobody is in here right now"}
      aria-hidden
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: live ? "var(--color-accent-green)" : "transparent",
          border: live ? "none" : "1.5px solid var(--color-text-5)",
        }}
      />
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

  return (
    <div
      role="button"
      tabIndex={0}
      className={[
        "group/row w-full rounded-md px-2 py-[3px] text-left cursor-pointer",
        "transition-colors",
        active ? "row-selected" : "hover:bg-bg-2",
      ].join(" ")}
      title={rowTitle}
      onClick={() => onOpen(session.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(session.id);
        }
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <StatusGlyph session={session} />
        <span className="flex-1 min-w-0 truncate text-text-2">
          {session.title}
        </span>
        {!session.joined && onJoin ? (
          <JoinSessionButton
            sessionId={session.id}
            ownerName={ownerName}
            hostOnline={session.hostOnline}
            access={session.access}
            onJoin={onJoin}
          />
        ) : null}
        {lastActor ? (
          <RailAvatar
            actor={lastActor}
            size={16}
            title={`${lastActor.name} moved ${agePose}`}
          />
        ) : null}
        {age ? (
          <span className="flex-none text-2xs tabular-nums text-text-4">
            {age}
          </span>
        ) : null}
      </div>

      {showSecondTier ? (
        // Aligned under the title, not under the glyph — the second tier is
        // about the session, and the glyph column belongs to the row's state.
        <div
          className="flex items-center gap-2 min-w-0"
          style={{ paddingLeft: 24, marginTop: 1 }}
        >
          {live ? (
            <ParticipantPips
              participants={session.participants}
              byId={byId}
              size={14}
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <ActivityLine activity={activity} byId={byId} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
