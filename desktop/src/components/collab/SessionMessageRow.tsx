// SessionMessageRow — one line of a shared session, attributed.
//
// In a solo session a `role: "user"` line is implicitly *you*, so nothing has
// to say who wrote it. The moment a second person is in the room that stops
// being true, and the transcript becomes unreadable without an author. This
// row is the fix: sender's face and name on every message, the recipient
// named whenever the message was addressed to someone, and an agent's message
// reading as from *that agent* rather than as anonymous output.
//
// It deliberately reuses the chat surface's own row grid (`slack-message-row`
// and friends) instead of inventing a second bubble language — a teammate's
// message has to sit inline in the agent's output and look like it belongs.

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
import { ParticipantFace } from "./ParticipantsStrip";
import {
  agentBrandName,
  isYou,
  mentionHandle,
  participantLabel,
} from "./collabPresence";

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
  /** Same sender as the row above — drops the header, keeps the hover time. */
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

  return (
    <div
      className={`slack-message-row group ${grouped ? "is-grouped" : ""}`}
      style={loud ? { boxShadow: "inset 2px 0 var(--color-accent)" } : undefined}
    >
      <div className="slack-message-avatar-col">
        {grouped ? (
          <span className="slack-grouped-time">{at ? hhmm(at) : ""}</span>
        ) : from ? (
          <ParticipantFace p={from} size={26} />
        ) : (
          <span className="w-[26px] h-[26px] rounded-md border border-line-soft bg-bg-2" aria-hidden />
        )}
      </div>

      <div className="slack-message-content">
        {!grouped && (
          <div className="slack-message-meta">
            <strong>{label}</strong>
            {from?.kind === "agent" && (
              <span className="slack-agent-badge">{agentBrandName(from).toUpperCase()}</span>
            )}
            {from && isYou(from, youId) && <span className="slack-you-badge">you</span>}
            {to && <AddressedTo to={to} participants={participants} youId={youId} />}
            {chip && <IntentChip label={chip} loud={loud} />}
            <time>{at ? hhmm(at) : ""}</time>
          </div>
        )}

        <div className="slack-message-body">
          {text.trim() ? (
            <ChatMarkdown body={text} members={mentionMembers} selfHandle={selfHandle} />
          ) : streaming ? null : (
            <span className="text-text-4 italic">(no text)</span>
          )}
          {streaming && (
            <span className="inline-flex items-center gap-1.5 ml-1 align-middle text-text-4">
              <AsciiSpinner size={12} />
              <span className="text-2xs">still writing</span>
            </span>
          )}
        </div>

        {refs && refs.length > 0 && (
          <RefChips refs={refs} onOpenRef={onOpenRef} />
        )}

        {role === "tool" && (
          <div className="mt-0.5 text-2xs text-text-4">Ran a tool</div>
        )}
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
    <span
      className="inline-flex items-center gap-0.5 text-2xs text-text-3 max-w-[180px]"
      title={`Addressed to ${label}`}
    >
      <ArrowRight size={10} className="flex-shrink-0" />
      <span className="truncate">{label === "You" ? "you" : label}</span>
    </span>
  );
}

function IntentChip({ label, loud }: { label: string; loud: boolean }): JSX.Element {
  return (
    <span
      className={`px-1.5 py-px rounded text-2xs font-medium leading-[13px] ${
        loud
          ? "text-accent bg-accent/12 border border-accent/25"
          : "text-text-3 bg-bg-3 border border-line-soft"
      }`}
    >
      {label}
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
    <div className="flex flex-wrap gap-1 mt-1">
      {refs.map((r, i) => {
        const file = r.file ?? "";
        const base = file.split("/").pop() ?? file;
        const body = (
          <>
            <FileCode2 size={11} className="flex-shrink-0 text-text-4" />
            <span className="font-mono text-text-2 truncate">{r.symbol}</span>
            {base && <span className="text-text-5 truncate">{base}</span>}
          </>
        );
        const cls =
          "inline-flex items-center gap-1 max-w-[240px] px-1.5 py-0.5 rounded border border-line-soft bg-bg-2 text-2xs leading-none";
        return onOpenRef ? (
          <button
            key={`${r.symbol}:${file}:${i}`}
            type="button"
            onClick={() => onOpenRef(r)}
            className={`${cls} hover:border-line`}
            title={file || r.symbol}
          >
            {body}
          </button>
        ) : (
          <span key={`${r.symbol}:${file}:${i}`} className={cls} title={file || r.symbol}>
            {body}
          </span>
        );
      })}
    </div>
  );
}
