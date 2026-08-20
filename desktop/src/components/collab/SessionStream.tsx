// SessionStream — the shared transcript: agent output and people's messages
// in one ordered list.
//
// They are not two feeds. The reason a shared session is worth having is that
// a teammate can say "try the retry path instead" *at the point in the run
// where it matters*, and the next person to read the session sees the remark
// sitting exactly there. Splitting people into a side channel would throw
// that away.

import { useEffect, useMemo, useRef } from "react";
import type { JSX } from "react";

import type { MsgIntent, Participant, SessionLiveRef } from "../../lib/sessionLive";
import type { SessionStreamItem } from "./collabTypes";
import { findParticipant, itemAt, itemKey } from "./collabTypes";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { SessionMessageRow } from "./SessionMessageRow";
import { AgentStandDownNotice } from "./AgentStandDownNotice";
import { ownerOf } from "./collabPresence";

export type SessionStreamProps = {
  items: readonly SessionStreamItem[];
  participants: readonly Participant[];
  youId: string | null;
  /** Loading the last 200 entries a late joiner is sent. */
  loading?: boolean;
  /** Plain-language failure ("Lost the connection to this session"). */
  error?: string | null;
  onRetry?: () => void;
  /** Entry ids the host is still streaming into. */
  streamingIds?: readonly string[];
  onOpenRef?: (ref: SessionLiveRef) => void;
  /** Render an agent's stand-down under a message addressed to a person.
   *  On by default — see AgentStandDownNotice for why it is not optional in
   *  practice. */
  standDown?: boolean;
  className?: string;
};

/** Two rows group when the same sender speaks twice inside five minutes and
 *  the second one isn't addressed at anybody — an addressed or loud row
 *  always keeps its header, because who it is *for* is the point of it. */
const GROUP_WINDOW_SECS = 300;

export function SessionStream({
  items,
  participants,
  youId,
  loading = false,
  error = null,
  onRetry,
  streamingIds,
  onOpenRef,
  standDown = true,
  className,
}: SessionStreamProps): JSX.Element {
  const ordered = useMemo(
    () =>
      [...items].sort(
        (a, b) => itemAt(a) - itemAt(b) || itemKey(a).localeCompare(itemKey(b)),
      ),
    [items],
  );
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [ordered.length]);

  const streaming = useMemo(
    () => new Set(streamingIds ?? []),
    [streamingIds],
  );

  if (error) {
    return (
      <div className={`flex flex-col items-center justify-center gap-2 py-8 ${className ?? ""}`}>
        <div className="text-xs text-red">{error}</div>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="px-2 py-0.5 rounded border border-red/30 text-red hover:bg-red/10 text-2xs"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className={`flex items-center justify-center gap-2 py-8 text-xs text-text-3 ${className ?? ""}`}>
        <AsciiSpinner size={12} />
        <span>Catching up on the conversation…</span>
      </div>
    );
  }

  if (ordered.length === 0) {
    return (
      <div className={`flex flex-col items-center justify-center gap-1 py-10 text-center ${className ?? ""}`}>
        <div className="text-xs text-text-2">Nothing has been said in here yet.</div>
        <div className="text-2xs text-text-4 max-w-[260px]">
          Type below to talk to the room, or use “@” to send it to one person
          or one agent.
        </div>
      </div>
    );
  }

  let prevSender: string | null = null;
  let prevAt = 0;

  return (
    <div className={`flex flex-col ${className ?? ""}`}>
      {ordered.map((item) => {
        const row = describe(item, participants);
        const grouped =
          prevSender === row.senderKey &&
          row.at - prevAt < GROUP_WINDOW_SECS &&
          !row.to &&
          !row.intent;
        prevSender = row.senderKey;
        prevAt = row.at;

        const standingDown =
          standDown && item.kind === "msg"
            ? standingDownAgent(row.from, row.to, row.intent, participants)
            : null;

        return (
          <div key={row.key}>
            <SessionMessageRow
              from={row.from}
              fromName={row.fromName}
              to={row.to}
              intent={row.intent}
              text={row.text}
              at={row.at}
              refs={row.refs}
              role={row.role}
              participants={participants}
              youId={youId}
              grouped={grouped}
              streaming={streaming.has(row.key)}
              onOpenRef={onOpenRef}
            />
            {standingDown && row.to && (
              <AgentStandDownNotice
                agent={standingDown}
                addressee={row.to}
                participants={participants}
                youId={youId}
              />
            )}
          </div>
        );
      })}
      <div ref={bottom} />
    </div>
  );
}

/** Which agent — if any — just got left out of this message.
 *
 *  A message addressed to a person is never injected into an agent, so
 *  strictly *every* such message stands one down. Saying so every time would
 *  bury the two moments it matters: a deliberate hand-over, and a message
 *  that lands while your agent is mid-work and might otherwise be assumed to
 *  have picked it up. Outside those, nothing was going to happen anyway and
 *  the line is noise. */
function standingDownAgent(
  from: Participant | null,
  to: Participant | null,
  intent: MsgIntent | null,
  participants: readonly Participant[],
): Participant | null {
  if (from?.kind !== "human" || to?.kind !== "human") return null;
  const agent = participants.find(
    (p) => p.kind === "agent" && ownerOf(p, participants)?.id === from.id,
  );
  if (!agent) return null;
  const midWork = agent.state === "coding" || agent.state === "instructing";
  return intent === "handoff" || midWork ? agent : null;
}

/** Flatten either stream shape into the row's props. The two shapes differ
 *  only in where the author lives and whether an intent was declared. */
function describe(item: SessionStreamItem, participants: readonly Participant[]) {
  if (item.kind === "msg") {
    const { msg } = item;
    return {
      key: msg.id,
      senderKey: msg.from,
      from: findParticipant(participants, msg.from),
      fromName: undefined as string | undefined,
      to: findParticipant(participants, msg.to),
      intent: msg.intent,
      text: msg.text,
      at: msg.at,
      refs: msg.refs,
      role: undefined,
    };
  }
  const { entry } = item;
  return {
    key: entry.id,
    senderKey: entry.author.id,
    from: findParticipant(participants, entry.author.id),
    fromName: entry.author.name,
    to: null,
    intent: null,
    text: entry.text,
    at: entry.at,
    refs: undefined,
    role: entry.role,
  };
}
