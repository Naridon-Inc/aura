// ParticipantsStrip — who is in this session, right now.
//
// The one line that answers "am I alone in here?". People render as their
// photo/animal disc, agents render as their CLI's own brand mark on a squared
// tile, so a human and a machine are never mistaken for each other at 22px.
// The dot on each avatar is what they are *doing*; hovering says it in words.
//
// Overflow collapses to "+N", which opens the same list as a menu rather than
// a second bespoke panel. The hover card is the shared hover card, and the
// "+N" is the shared menu.

import type { JSX } from "react";

import type { Participant } from "../../lib/sessionLive";
import { Avatar } from "../team/presentation/Avatar";
import { AgentIcon } from "../agent/AgentIcon";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card";
import { LoadingState } from "../ui/state";
import {
  activitySentence,
  agentIconId,
  participantLabel,
  sinceWords,
  sortParticipants,
} from "./collabPresence";
import "../ui/session-room.css";

export type ParticipantsStripProps = {
  participants: readonly Participant[];
  /** The local user's own participant id, so they read as "You". */
  youId: string | null;
  /** How many avatars before the rest fold into "+N". */
  max?: number;
  /** Still opening the session socket — nobody is known yet. */
  loading?: boolean;
  /** Plain-language failure ("Lost the connection to this session"). */
  error?: string | null;
  onRetry?: () => void;
  /** Click a face to address your next message to them. */
  onSelect?: (p: Participant) => void;
};

export function ParticipantsStrip({
  participants,
  youId,
  max = 6,
  loading = false,
  error = null,
  onRetry,
  onSelect,
}: ParticipantsStripProps): JSX.Element {
  if (error) {
    return (
      <div className="ui-session-strip" role="alert">
        <span className="ui-session-strip-note" data-tone="error">
          {error}
        </span>
        {onRetry && (
          <Button variant="ghost" size="xs" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    );
  }

  if (loading) {
    return <LoadingState label="Seeing who else is here…" className="ui-session-strip" />;
  }

  if (participants.length === 0) {
    return (
      <div className="ui-session-strip">
        <span className="ui-session-strip-note">Nobody has joined this session yet.</span>
      </div>
    );
  }

  const ordered = sortParticipants(participants);
  const shown = ordered.slice(0, max);
  const rest = ordered.slice(max);

  return (
    <div className="ui-session-strip" aria-label="People in this session">
      {shown.map((p) => (
        <HoverCard key={p.id} openDelay={150} closeDelay={60}>
          <HoverCardTrigger asChild>
            <button
              type="button"
              className="ui-session-presence-face"
              onClick={onSelect ? () => onSelect(p) : undefined}
              aria-label={activitySentence(p, ordered, youId)}
            >
              <ParticipantFace p={p} />
            </button>
          </HoverCardTrigger>
          <HoverCardContent side="bottom" sideOffset={6} className="ui-session-hover-card">
            <ParticipantCard p={p} all={ordered} youId={youId} />
          </HoverCardContent>
        </HoverCard>
      ))}

      {rest.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="ui-session-presence-more"
              title={`${rest.length} more in this session`}
            >
              +{rest.length}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="ui-session-presence-menu">
            <DropdownMenuLabel>Also in this session</DropdownMenuLabel>
            {rest.map((p) => (
              <DropdownMenuItem
                key={p.id}
                onSelect={onSelect ? () => onSelect(p) : undefined}
              >
                <ParticipantFace p={p} size={18} />
                <span className="ui-session-person">
                  <span>{participantLabel(p, ordered, youId)}</span>
                  <small>{activitySentence(p, ordered, youId)}</small>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** The face itself — human disc or agent brand tile, with the state dot.
 *  Exported because the message row and the mention picker need the exact
 *  same mark beside a name.
 *
 *  Who hosts is said in words (the hover card, and first place in every
 *  list), not by a second dot: a mark in the corner of a face sat outside
 *  its box and read as a stray pixel in the menus. */
export function ParticipantFace({
  p,
  size = 22,
}: {
  p: Participant;
  size?: number;
}): JSX.Element {
  const dot = Math.max(7, Math.round(size * 0.33));
  return (
    <span
      className="ui-session-face"
      data-kind={p.kind}
      data-host={p.role === "host" ? "" : undefined}
      style={{ width: size, height: size }}
    >
      {p.kind === "agent" ? (
        <span className="ui-session-face-tile" aria-hidden>
          <AgentIcon agentId={agentIconId(p)} label={p.name} size={Math.round(size * 0.72)} />
        </span>
      ) : (
        <Avatar name={p.name} size={size} src={p.avatar} title="" />
      )}
      <span
        className="ui-session-face-dot"
        data-state={p.state}
        style={{ width: dot, height: dot }}
        aria-hidden
      />
    </span>
  );
}

/** Hover card: what they're doing in a sentence, then their part in the
 *  session and for how long. */
function ParticipantCard({
  p,
  all,
  youId,
}: {
  p: Participant;
  all: readonly Participant[];
  youId: string | null;
}): JSX.Element {
  const duration = sinceWords(p.since);
  return (
    <>
      <strong>{activitySentence(p, all, youId)}</strong>
      <small>
        {p.role === "host" ? "Runs the agent for this session" : "Joined from another machine"}
        {duration ? ` · ${duration}` : ""}
      </small>
    </>
  );
}
