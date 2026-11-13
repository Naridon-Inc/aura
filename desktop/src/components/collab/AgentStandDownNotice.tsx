// AgentStandDownNotice — the agent saying, out loud, that this one isn't its.
//
// The delivery rule is that a message addressed to a *person* is never
// injected into an agent. That is correct and invisible, which is the
// problem: you type "@Shahabas can you take the retry path" into the same box
// you normally type instructions into, and nothing tells you the agent
// already sitting in that box just stayed out of it. Two people then both
// assume the other's agent has it.
//
// So the stand-down is rendered. It is not a bubble — nobody said it to
// anyone — it is a thin ambient line in the stream, the same weight as a
// join/leave notice.

import type { JSX } from "react";
import { CornerDownRight } from "lucide-react";

import type { Participant } from "../../lib/sessionLive";
import { hhmm } from "../team/domain/labels";
import { ParticipantFace } from "./ParticipantsStrip";
import { participantLabel, participantName } from "./collabPresence";
import "../ui/session-room.css";

export type AgentStandDownNoticeProps = {
  /** The agent that would otherwise have picked this up. */
  agent: Participant;
  /** The person the message went to instead. */
  addressee: Participant;
  participants: readonly Participant[];
  youId: string | null;
  /** Epoch seconds; omitted when the notice is immediate and local. */
  at?: number;
};

export function AgentStandDownNotice({
  agent,
  addressee,
  participants,
  youId,
  at,
}: AgentStandDownNoticeProps): JSX.Element {
  const agentLabel = participantLabel(agent, participants, youId);
  const toLabel = participantName(addressee, participants);
  return (
    <div className="ui-session-standdown" role="note">
      <CornerDownRight aria-hidden />
      <ParticipantFace p={agent} size={16} />
      <p>
        <strong>{agentLabel}</strong> is leaving this one to {toLabel}.{" "}
        <small>It won't act on this message.</small>
      </p>
      {at ? <time>{hhmm(at)}</time> : null}
    </div>
  );
}
