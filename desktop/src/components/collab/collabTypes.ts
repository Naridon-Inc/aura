// What the shared stream is made of.
//
// The protocol keeps two things: `transcript` entries (agent output) and
// `msg` frames (addressed messages). The store keeps them apart too —
// `state.entries` and `state.activity`. The *reader* does not experience two
// feeds, and shouldn't: the reason a shared session is worth having is that a
// teammate can say "try the retry path instead" at the point in the run where
// it matters, and whoever reads it later finds the remark sitting exactly
// there. So the view merges them, and this is the merged shape.
//
// Nothing here re-declares a wire type — `Entry`, `MsgIntent` and
// `SessionLiveRef` come straight from `lib/sessionLive`.

import type {
  Entry,
  MsgFrame,
  MsgIntent,
  Participant,
  SessionLiveRef,
} from "../../lib/sessionLive";

/** A delivered `msg`, in the one shape the view needs. Both forms the app
 *  holds satisfy it structurally: the wire's `MsgFrame` (via `fromMsgFrame`,
 *  which supplies the id `seq` implies) and the store's `SessionActivity`. */
export type SessionMessage = {
  /** Stable React key. */
  id: string;
  /** Sender participant id, server-stamped. */
  from: string;
  /** Recipient participant id, or null for the whole room. */
  to: string | null;
  text: string;
  intent: MsgIntent | null;
  refs: SessionLiveRef[];
  /** Epoch seconds. */
  at: number;
};

export type SessionStreamItem =
  | { kind: "entry"; entry: Entry }
  | { kind: "msg"; msg: SessionMessage };

/** The wire frame carries `seq` rather than an id; `seq` is monotonic per
 *  session, so it is the id. */
export function fromMsgFrame(frame: MsgFrame): SessionMessage {
  return {
    id: `m_${frame.seq}`,
    from: frame.from,
    to: frame.to,
    text: frame.text,
    intent: frame.intent,
    refs: frame.refs,
    at: frame.at,
  };
}

/** Interleave transcript and messages into one ordered list, oldest first.
 *  `at` is the only clock both shapes share; `id` breaks ties so the order is
 *  stable across renders rather than dependent on input order.
 *
 *  From the store this is
 *  `mergeSessionStream(state.entries, state.activity.filter((a) => a.kind === "msg"))`
 *  — `impact` activity belongs on the rail, not in the transcript. */
export function mergeSessionStream(
  entries: readonly Entry[],
  messages: readonly SessionMessage[],
): SessionStreamItem[] {
  const items: SessionStreamItem[] = [
    ...entries.map((entry) => ({ kind: "entry" as const, entry })),
    ...messages.map((msg) => ({ kind: "msg" as const, msg })),
  ];
  return items.sort((a, b) => {
    const at = itemAt(a) - itemAt(b);
    if (at !== 0) return at;
    return itemKey(a).localeCompare(itemKey(b));
  });
}

export function itemAt(item: SessionStreamItem): number {
  return item.kind === "msg" ? item.msg.at : item.entry.at;
}

export function itemKey(item: SessionStreamItem): string {
  return item.kind === "msg" ? item.msg.id : item.entry.id;
}

/** Resolve a participant id against the live roster. Returns null when the
 *  sender has since left — the row falls back to the name it was sent with. */
export function findParticipant(
  all: readonly Participant[],
  id: string | null | undefined,
): Participant | null {
  if (!id) return null;
  return all.find((p) => p.id === id) ?? null;
}
