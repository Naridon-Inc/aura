// SessionMessageRow — one line of a shared session, attributed.
//
// In a solo session a `role: "user"` line is implicitly *you*, so nothing has
// to say who wrote it. The moment a second person is in the room that stops
// being true, and the transcript becomes unreadable without an author. This
// row is the fix: sender's face and name on every message, the recipient
// named whenever the message was addressed to someone, and an agent's message
// reading as from *that agent* rather than as anonymous output.
//
// It is the shared-message row the cloud chat uses: the face beside the
// words, yours on the right, and an agent's words on the page the way the
// chat's assistant reads, with the face saying whose agent it is. What a room
// adds sits on one quiet line above the words, and only when it says
// something: whose agent this is, who it was for, and what kind of message.
// A tool the host's agent ran is the chat's own tool row.

import { useMemo } from "react";
import type { JSX } from "react";
import { ArrowRight, FileCode2 } from "lucide-react";

import type {
  EntryRole,
  MsgIntent,
  Participant,
  SessionLiveRef,
} from "../../lib/sessionLive";
import { hhmm } from "../team/domain/labels";
import { ChatMarkdown } from "../chat/ChatMarkdown";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ToolCall } from "../ui/message";
import { StatusChip } from "../ui/statusChip";
import { ParticipantFace } from "./ParticipantsStrip";
import { isYou, mentionHandle, participantLabel } from "./collabPresence";
import "../ui/cloud-patterns.css";
import "../ui/session-room.css";

/** How each intent reads in the room. `chat` is deliberately unlabelled —
 *  most traffic is chat, and a chip on every line is noise. */
const INTENT_LABEL: Record<MsgIntent, string | null> = {
  instruct: "Do this",
  handoff: "Handed over",
  ask: "Question",
  tell: "Heads-up",
  chat: null,
};

/** The two that change what happens next, and so get the accent rail. */
const LOUD: ReadonlySet<string> = new Set(["instruct", "handoff"]);

export type SessionMessageRowProps = {
  /** Sender, resolved against the live roster. */
  from: Participant | null;
  /** Name to show when the sender has already left the session. */
  fromName?: string;
  /** Who it was addressed to; null/undefined means the whole room. */
  to?: Participant | null;
  intent?: MsgIntent | null;
  text: string;
  /** Epoch seconds. */
  at: number;
  refs?: readonly SessionLiveRef[];
  /** Present on transcript entries; addressed messages have none. */
  role?: EntryRole;
  participants: readonly Participant[];
  youId: string | null;
  /** Same sender as the row above — drops the face, keeps the hover time. */
  grouped?: boolean;
  /** The agent is still producing this one. */
  streaming?: boolean;
  onOpenRef?: (ref: SessionLiveRef) => void;
};

export function SessionMessageRow({
  from,
  fromName,
  to = null,
  intent = null,
  text,
  at,
  refs,
  role,
  participants,
  youId,
  grouped = false,
  streaming = false,
  onOpenRef,
}: SessionMessageRowProps): JSX.Element {
  const label = from
    ? participantLabel(from, participants, youId)
    : fromName?.trim() || "Someone who left";
  const loud = !!intent && LOUD.has(intent);
  const chip = intent ? INTENT_LABEL[intent] : null;
  const own = !!from && isYou(from, youId);
  const agent = from?.kind === "agent" || role === "tool";
  const time = at ? hhmm(at) : "";
  // Two agents of the same kind wear the same face, so an agent's line always
  // says whose it is. A person's face is enough.
  const named = !grouped && from?.kind === "agent";

  // Mention highlighting needs the set of handles that exist in this room,
  // which is exactly the set the mention picker offers.
  const mentionMembers = useMemo(
    () => participants.map((p) => ({ handle: mentionHandle(p, participants) })),
    [participants],
  );
  const selfHandle = useMemo(() => {
    const me = participants.find((p) => isYou(p, youId));
    return me ? mentionHandle(me, participants) : "";
  }, [participants, youId]);

  const words = (body: string) =>
    body.trim() ? (
      <ChatMarkdown body={body} members={mentionMembers} selfHandle={selfHandle} />
    ) : null;

  let content: JSX.Element | null;
  if (role === "tool") {
    const [first = "", ...more] = text.trim().split("\n");
    content = (
      <ToolCall title={first.trim() || "Ran a tool"} status={streaming ? "running" : "done"}>
        {words(more.join("\n"))}
      </ToolCall>
    );
  } else {
    content = (
      <>
        {words(text) ??
          (streaming ? null : <span className="ui-session-message-empty">(no text)</span>)}
        {streaming && (
          <span className="ui-session-message-streaming" role="status">
            <AsciiSpinner size={12} />
            still writing
          </span>
        )}
      </>
    );
  }

  return (
    <div
      className="ui-shared-message ui-session-message"
      data-own={own}
      data-kind={agent ? "agent" : "human"}
      data-grouped={grouped ? "" : undefined}
      data-loud={loud ? "" : undefined}
      aria-label={`Message from ${label}`}
    >
      <header>
        <span
          className="ui-cloud-avatar ui-cloud-avatar-static ui-session-message-face"
          role="img"
          aria-label={label}
          title={label}
        >
          {from ? (
            <ParticipantFace p={from} size={24} />
          ) : (
            <span className="ui-session-message-gone" aria-hidden />
          )}
        </span>
        <span>{label}</span>
        <time>{time}</time>
      </header>

      <div title={grouped && time ? time : undefined}>
        {(named || to || chip) && (
          <div className="ui-session-message-meta">
            {named && <strong>{label}</strong>}
            {to && <AddressedTo to={to} participants={participants} youId={youId} />}
            {chip && (
              <StatusChip tone={loud ? "green" : "neutral"} dense>
                {chip}
              </StatusChip>
            )}
          </div>
        )}
        {content}
        {refs && refs.length > 0 && <RefChips refs={refs} onOpenRef={onOpenRef} />}
      </div>
    </div>
  );
}

/** "→ Shahabas's Claude" — the half of attribution that a solo session never
 *  needed. Without it, an instruction aimed at someone else's machine is
 *  indistinguishable from one aimed at yours. */
function AddressedTo({
  to,
  participants,
  youId,
}: {
  to: Participant;
  participants: readonly Participant[];
  youId: string | null;
}): JSX.Element {
  const label = participantLabel(to, participants, youId);
  return (
    <span className="ui-session-message-to" title={`Addressed to ${label}`}>
      <ArrowRight aria-hidden />
      <span>{label === "You" ? "you" : label}</span>
    </span>
  );
}

/** The `refs` a message carries — the symbol and file it is about. Rendered
 *  as chips so "try the retry path instead" points at something clickable
 *  rather than leaving the reader to go find it. */
function RefChips({
  refs,
  onOpenRef,
}: {
  refs: readonly SessionLiveRef[];
  onOpenRef?: (ref: SessionLiveRef) => void;
}): JSX.Element {
  return (
    <div className="ui-session-refs">
      {refs.map((r, i) => {
        const file = r.file ?? "";
        const base = file.split("/").pop() ?? file;
        const key = `${r.symbol}:${file}:${i}`;
        const body = (
          <>
            <FileCode2 aria-hidden />
            <code>{r.symbol}</code>
            {base && <small>{base}</small>}
          </>
        );
        return onOpenRef ? (
          <Button
            key={key}
            variant="outline"
            size="xs"
            className="ui-session-ref"
            onClick={() => onOpenRef(r)}
            title={file || r.symbol}
          >
            {body}
          </Button>
        ) : (
          <Badge key={key} variant="outline" className="ui-session-ref" title={file || r.symbol}>
            {body}
          </Badge>
        );
      })}
    </div>
  );
}
