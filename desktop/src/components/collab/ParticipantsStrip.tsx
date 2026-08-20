// ParticipantsStrip — who is in this session, right now.
//
// The one line that answers "am I alone in here?". People render as their
// photo/animal disc, agents render as their CLI's own brand mark on a squared
// tile, so a human and a machine are never mistaken for each other at 22px.
// The dot on each avatar is what they are *doing*; hovering says it in words.
//
// Overflow collapses to "+N", which opens the same list as a menu rather than
// a second bespoke panel — the rows use the shared menuSurface recipe.

import { useState } from "react";
import type { JSX } from "react";

import type { Participant } from "../../lib/sessionLive";
import { Avatar } from "../team/presentation/Avatar";
import { AgentIcon } from "../agent/AgentIcon";
import { AsciiSpinner } from "../ui/ascii-spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  activitySentence,
  agentIconId,
  participantLabel,
  presenceDotStyle,
  sinceWords,
  sortParticipants,
} from "./collabPresence";

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
  const [hovered, setHovered] = useState<string | null>(null);

  if (error) {
    return (
      <div className="flex items-center gap-2 h-7 px-2 text-xs text-red">
        <span className="truncate">{error}</span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="px-1.5 py-0.5 rounded border border-red/30 text-red hover:bg-red/10 text-2xs leading-none"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 h-7 px-2 text-xs text-text-3">
        <AsciiSpinner size={12} />
        <span>Seeing who else is here…</span>
      </div>
    );
  }

  if (participants.length === 0) {
    return (
      <div className="flex items-center h-7 px-2 text-xs text-text-4">
        Nobody has joined this session yet.
      </div>
    );
  }

  const ordered = sortParticipants(participants);
  const shown = ordered.slice(0, max);
  const rest = ordered.slice(max);

  return (
    <div className="relative flex items-center gap-1.5 h-7 px-2">
      {shown.map((p) => (
        <div
          key={p.id}
          className="relative"
          onMouseEnter={() => setHovered(p.id)}
          onMouseLeave={() => setHovered((cur) => (cur === p.id ? null : cur))}
        >
          <button
            type="button"
            onFocus={() => setHovered(p.id)}
            onBlur={() => setHovered((cur) => (cur === p.id ? null : cur))}
            onClick={onSelect ? () => onSelect(p) : undefined}
            aria-label={activitySentence(p, ordered, youId)}
            className="block rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <ParticipantFace p={p} />
          </button>
          {hovered === p.id && (
            <ParticipantHoverCard p={p} all={ordered} youId={youId} />
          )}
        </div>
      ))}

      {rest.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="h-[22px] min-w-[22px] px-1 rounded-md border border-line-soft bg-bg-2 text-text-3 hover:text-text-1 hover:border-line text-2xs font-medium tabular-nums"
              title={`${rest.length} more in this session`}
            >
              +{rest.length}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Also in this session</DropdownMenuLabel>
            {rest.map((p) => (
              <DropdownMenuItem
                key={p.id}
                onSelect={onSelect ? () => onSelect(p) : undefined}
              >
                <ParticipantFace p={p} size={18} />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-text-1">
                    {participantLabel(p, ordered, youId)}
                  </span>
                  <span className="block truncate text-2xs text-text-4">
                    {activitySentence(p, ordered, youId)}
                  </span>
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
 *  same mark beside a name. */
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
      className="relative inline-flex flex-shrink-0"
      style={{ width: size, height: size }}
    >
      {p.kind === "agent" ? (
        <span
          className="flex items-center justify-center w-full h-full rounded-md border border-line-soft bg-bg-2"
          aria-hidden
        >
          <AgentIcon agentId={agentIconId(p)} label={p.name} size={Math.round(size * 0.72)} />
        </span>
      ) : (
        <Avatar name={p.name} size={size} src={p.avatar} title="" />
      )}
      <span
        className="absolute rounded-full"
        style={{
          width: dot,
          height: dot,
          right: -2,
          bottom: -2,
          ...presenceDotStyle(p.state),
        }}
        aria-hidden
      />
      {p.role === "host" && (
        <span
          className="absolute -top-1 -left-1 w-1.5 h-1.5 rounded-full"
          style={{ background: "var(--color-accent)" }}
          aria-hidden
          title="Runs the agent for this session"
        />
      )}
    </span>
  );
}

/** Hover card: the name, then what they're doing, in a sentence. Built from
 *  the shared flyout look rather than a native `title` so the sentence can be
 *  two lines and still read as one calm surface. */
function ParticipantHoverCard({
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
    <div
      role="tooltip"
      className="absolute left-1/2 top-full z-50 mt-1.5 w-max max-w-[240px] -translate-x-1/2 rounded-lg border border-line-soft bg-bg-float px-2.5 py-1.5 shadow-[var(--shadow-flyout)]"
    >
      <div className="text-xs font-medium text-text-1 leading-tight">
        {activitySentence(p, all, youId)}
      </div>
      <div className="text-2xs text-text-4 leading-tight mt-0.5">
        {p.role === "host" ? "Runs the agent for this session" : "Joined from another machine"}
        {duration ? ` · ${duration}` : ""}
      </div>
    </div>
  );
}
