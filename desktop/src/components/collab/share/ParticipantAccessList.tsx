// ParticipantAccessList — everyone in the session, and what each of them is
// allowed to do. The host changes a level here and it takes effect live.
//
// Compact rows, not cards: one line of identity, one quiet line of what they're
// doing, and the level control on the right. The list is the surface; boxing
// each person inside it would draw a frame around five people who are already
// obviously a list.
//
// Two rows can never be changed and both say so instead of going grey with no
// explanation:
//   • the host — it is their machine, and a host who could set themselves to
//     "watch" would lock themselves out of the agent they are running;
//   • agents — an agent is a thing you instruct, so "can it instruct?" is not a
//     question the product has an answer for.

import type { JSX } from "react";

import { Avatar } from "../../team/presentation/Avatar";
import { EmptyState } from "../../ui/state";
import { Users } from "lucide-react";
import { AccessLevelMenu } from "./AccessLevelMenu";
import {
  ACCESS_META,
  accessFor,
  type AccessLevel,
  type Participant,
  type SharedSession,
} from "./shareTypes";

/** The protocol's `state` values, said the way a person would say them. The
 *  wire words ("instructing", "idle") are fine in a frame and wrong on a row. */
function stateLine(p: Participant): string {
  switch (p.state) {
    case "coding":
      return "Working in the code";
    case "instructing":
      return "Giving instructions";
    case "talking":
      return "Talking";
    case "watching":
      return "Watching";
    case "idle":
      return "Here, not doing anything";
    default:
      return "Here";
  }
}

/** Whose machine, and whether that is you. Says the one thing about a person
 *  that changes what the rest of the row means. */
function roleLine(p: Participant, isYou: boolean): string | null {
  const bits: string[] = [];
  if (isYou) bits.push("You");
  if (p.role === "host") bits.push("Running the session");
  if (p.kind === "agent") {
    bits.push(p.agent_kind ? `${p.agent_kind} agent` : "Agent");
  }
  return bits.length > 0 ? bits.join(" · ") : null;
}

export type ParticipantAccessListProps = {
  session: SharedSession;
  /** The participant id of whoever is looking at this list. */
  youId: string;
  /** Only the host may change levels. A guest sees the same list, read-only —
   *  which is the point: a guest should be able to see that someone else can
   *  drive and they can't, rather than wondering. */
  canManage: boolean;
  /** Change one person's level. The caller sends it and re-renders from the
   *  server's echo; this list never assumes the change landed. */
  onAccessChange: (participantId: string, level: AccessLevel) => void;
  /** Ids with a change still in flight. */
  savingIds?: string[];
};

export function ParticipantAccessList({
  session,
  youId,
  canManage,
  onAccessChange,
  savingIds = [],
}: ParticipantAccessListProps): JSX.Element {
  if (session.participants.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="Nobody has joined yet"
        body="Send someone the link or the code above. They'll show up here the moment they arrive."
        size="sm"
      />
    );
  }

  return (
    <>
      <ul className="flex flex-col">
        {session.participants.map((p) => {
          const isYou = p.id === youId;
          const level = accessFor(session, p.id);
          const isAgent = p.kind === "agent";
          const isHost = p.role === "host";
          const locked = !canManage || isAgent || isHost;
          const sub = roleLine(p, isYou);

          return (
            <li
              key={p.id}
              className="flex items-center gap-3 border-b border-line-soft py-2.5 last:border-b-0"
            >
              <Avatar
                name={p.name}
                src={p.avatar}
                size={26}
                shape={isAgent ? "rounded" : "circle"}
                presence={p.state === "idle" ? "idle" : "online"}
              />

              <div className="min-w-0 flex-1">
                <p className="truncate text-base text-text-1">
                  {p.name}
                  {sub && (
                    <span className="ml-1.5 text-xs font-normal text-text-4">
                      {sub}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 truncate text-xs text-text-4">
                  {stateLine(p)}
                  {level === "watch" && !isAgent && (
                    <span className="text-text-5"> · can&apos;t type here</span>
                  )}
                </p>
              </div>

              <AccessLevelMenu
                personName={isYou ? "you" : p.name}
                value={level}
                saving={savingIds.includes(p.id)}
                disabled={locked}
                disabledReason={
                  isAgent
                    ? "Agents are given instructions here. They don't give them, so there's nothing to set."
                    : isHost
                      ? "This session runs on their machine, so they're always driving."
                      : "Only the person running the session can change this."
                }
                onChange={(next) => onAccessChange(p.id, next)}
              />
            </li>
          );
        })}
      </ul>

      {/* One line under the list, because "watching" is the state people
          misread. Someone whose composer went quiet assumes the app broke long
          before they assume a colleague changed a setting. */}
      <p className="pt-2.5 text-xs leading-snug text-text-4">
        {ACCESS_META.watch.label} means{" "}
        {ACCESS_META.watch.hostBlurb.toLowerCase()} Everyone sees their own level
        on screen, so a quiet composer is never a mystery.
      </p>
    </>
  );
}
