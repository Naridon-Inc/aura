// One turn of a cloud workspace's transcript, labelled with who said it.
//
// Until anyone but you has written, the chat reads as your own: no names.
// Once it is shared, each person's turn carries their face and name (yours
// reads "You"), a message sent to people says who it was for ("to Maya"),
// and each reply carries the agent's icon and name, so a reply can never be
// read as a person. Under every turn is a slot for what hangs off it, on the
// side the bubble sits: your own prompts on the right, the rest on the left.
// A computer's answer saying it could not run a prompt is a quiet notice
// under that prompt, not something the agent said.

import { createContext, type ReactNode } from "react";
import { Ban } from "lucide-react";

import { isFailedAnswer } from "../../lib/cloudBoxDrive";
import type { CloudMessageRow } from "../../lib/cloudWorkspacesApi";
import { stripSteeringDirective } from "../../lib/steeringDirective";
import { SharedAgentAttribution } from "../ui/cloud-agent-turn";
import { SharedChatAttribution } from "../ui/cloud-workspace";
import { Message, MessageBody, ToolCall } from "../ui/message";
import { relTime } from "../workspaces/workspacesModel";
import type { Authored, TurnAgent, TurnAuthor } from "./cloudPeople";
import "./cloud-turn.css";

/** A turn as the server answers it, with its author once one is recorded. */
export type AuthoredRow = CloudMessageRow & Authored;

/** A system row ("workspace put to sleep") as a step's title. */
function stepTitle(body: string): string {
  const text = body.trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The side of the chat a turn's bubble sits on: your own prompts on the
 *  right ("end"), everything else on the left. */
export type TurnSide = "start" | "end";

/** The side of the turn being drawn, for what hangs under it. Read by the
 *  turn's ⋯ menu so it opens over the bubble, not across the chat. */
export const TurnSideContext = createContext<TurnSide>("start");

/** A prompt you sent, or one with no author recorded, is on the right;
 *  a teammate's prompt, a reply, a step or a notice is on the left. */
export function sideOf(m: CloudMessageRow, author: TurnAuthor | null): TurnSide {
  if (m.role !== "user" || isFailedAnswer(m)) return "start";
  return !author || author.own ? "end" : "start";
}

function whenOf(m: AuthoredRow): string {
  return relTime(Math.floor(Date.parse(m.created_at) / 1000), Date.now());
}

function TurnBody({
  m,
  author,
  agent,
  to,
}: {
  m: AuthoredRow;
  author: TurnAuthor | null;
  agent: TurnAgent | null;
  to: string | null;
}) {
  if (m.role === "system") return <ToolCall title={stepTitle(m.body)} />;
  if (isFailedAnswer(m))
    return (
      <div className="ui-cloud-turn-notice" role="note">
        <Ban aria-hidden="true" />
        <span>{m.body.trim() || "This message wasn’t run."}</span>
      </div>
    );
  // A laptop that drove the chat kept the turn as the agent got it: the
  // mode directive the composer put in front of each message is wiring, and
  // nobody reading the log should see it.
  const said = m.role === "user" ? stripSteeringDirective(m.body).trim() : m.body;
  if (m.role === "user" && author)
    return (
      <SharedChatAttribution member={author.member} own={author.own} to={to} time={whenOf(m)}>
        {said}
      </SharedChatAttribution>
    );
  if (m.role === "user")
    return (
      <Message role="user">
        <MessageBody tone="user">{said}</MessageBody>
      </Message>
    );
  const reply = (
    <Message role="assistant">
      <MessageBody>{m.body}</MessageBody>
    </Message>
  );
  return agent ? (
    <SharedAgentAttribution name={agent.name} provider={agent.provider} time={whenOf(m)}>
      {reply}
    </SharedAgentAttribution>
  ) : (
    reply
  );
}

export function TurnRow({
  m,
  author,
  agent,
  to,
  actions,
}: {
  m: AuthoredRow;
  /** Who wrote a person's turn: null while the chat is only yours, or when
   *  the server recorded no one. */
  author: TurnAuthor | null;
  /** The agent's label over its replies: null while the chat is only yours. */
  agent: TurnAgent | null;
  /** "to Maya" on a message sent to people rather than the agent. */
  to: string | null;
  /** What hangs under the turn (its ⋯ menu and its comment threads). */
  actions?: ReactNode;
}) {
  const side = sideOf(m, author);
  return (
    <div className="ui-cloud-turn" data-role={m.role} data-own={author?.own || undefined} data-side={side}>
      <TurnBody m={m} author={author} agent={agent} to={to} />
      {actions && (
        <TurnSideContext.Provider value={side}>
          <div className="ui-cloud-turn-actions">{actions}</div>
        </TurnSideContext.Provider>
      )}
    </div>
  );
}
