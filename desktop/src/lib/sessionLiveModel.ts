// Session Live plane — what the store holds, and the rules for putting things
// into it.
//
// Types, the empty snapshot, and the two merge helpers. No React, no Tauri and
// no mutable session registry, so the ordering/dedupe rules that decide whether
// a re-join duplicates a conversation can be reasoned about (and exercised) on
// their own.

import type {
  Entry,
  ImpactSeverity,
  MsgFrame,
  MsgIntent,
  Participant,
  SessionLiveConnectionStatus,
  SessionLiveRef,
  SessionShare,
  SessionTunnel,
} from "./sessionLive";

/** The protocol replays the last 200 entries on join; keep more than that so
 *  a long shared session still scrolls back past the catch-up window. */
export const ENTRY_RETENTION = 500;
export const MESSAGE_RETENTION = 500;
/** How much of the recent msg + impact stream is kept for the rail. */
export const ACTIVITY_RETENTION = 50;
/** A peer that drops mid-keystroke never sends `typing:false`; expire it. */
export const TYPING_TTL_MS = 8000;

/**
 * One thing that happened in a session: someone said something, or a collision
 * was noticed.
 *
 * Field-compatible with the rail's `RailActivity` on purpose — `railFromLive`
 * copies it across one field at a time. The rail already owns the ranking and
 * the wording, and a second near-identical shape here is how the two drift.
 *
 * A message names symbols (`refs`) but the rail has ~180px, so the one a person
 * would recognise is flattened into `ref` at ingest and the rest stays on the
 * `msg` frame in `messages` for anything that wants them all.
 */
export type SessionActivity = {
  /** Dedupe key — the frame's `seq`, or sender+time for an impact. */
  id: string;
  kind: "impact" | "message";
  /** Participant id of the speaker. */
  fromId: string;
  /** Who it was addressed to; null means the room. */
  toId: string | null;
  /** How loud it was meant to be. An impact is a report, which is exactly what
   *  `tell` means — the frame has no `intent` field of its own. */
  intent: MsgIntent;
  /** The symbol or file the line is about, when there is one. */
  ref: string | null;
  /** Their own words. Empty for an impact — nobody said anything, something
   *  was noticed. */
  text: string;
  severity: ImpactSeverity | null;
  /** Epoch SECONDS, matching the protocol's `at`. */
  at: number;
};

/** The interleaved shared stream: agent output and what people said, in one
 *  ordered list. A teammate's message belongs *in* the agent's output. */
export type SessionStreamItem =
  | { kind: "msg"; msg: MsgFrame }
  | { kind: "entry"; entry: Entry };

export type SessionLiveState = {
  sessionId: string;
  connection: SessionLiveConnectionStatus;
  /** The role the server actually granted — a host that lost the race to
   *  another desktop reads "guest" here even though it asked for "host". */
  role: "host" | "guest" | null;
  /** Our own participant record, once the server has said `ready`. */
  you: Participant | null;
  /** Participant ids of the agents THIS desktop hosts. A message addressed at
   *  one of these is what actually reaches a running agent here. */
  yourAgents: string[];
  participants: Participant[];
  /** Agent transcript, ordered by server-assigned seq and deduped. */
  entries: Entry[];
  /** Addressed messages, ordered by seq and deduped. */
  messages: MsgFrame[];
  /** Recent msg + impact, oldest first — what the rail's activity line reads. */
  activity: SessionActivity[];
  hostOnline: boolean;
  /** Participant ids currently typing. */
  typing: ReadonlySet<string>;
  /** Null means "not asked yet"; `[]` means "nothing open". The share surface
   *  says a different sentence for each, so they must not collapse. */
  tunnels: SessionTunnel[] | null;
  /** The code + link, once this session has been shared. */
  share: SessionShare | null;
  /** The relay URL for this session, as the desktop reports it. */
  shareUrl: string | null;
  /** The name of the machine the session actually runs on, when we were told
   *  it. Only the join preview carries it — no live frame does — so this is
   *  null for a session nobody previewed, and the guest's banner falls back to
   *  "their machine" rather than naming the wrong computer. It matters because
   *  the sentence it appears in is the one that says a guest's words execute
   *  somewhere other than here. */
  hostMachine: string | null;
  /** The local agent session this share is wired to. Null means a message
   *  addressed at an agent has nowhere to land on this desktop. */
  agentSessionId: string | null;
  /** Highest seq applied. */
  lastSeq: number;
  /** Last `error` frame or refused command, in words a person can read. */
  lastError: string | null;
};
/** Memoised empty snapshots. `getSnapshot` runs during render, so it must
 *  return the same reference every time for a session we know nothing about —
 *  minting a fresh object would spin useSyncExternalStore forever. */
const empties = new Map<string, SessionLiveState>();
export const EMPTY_TYPING: ReadonlySet<string> = new Set<string>();
export const EMPTY_PARTICIPANTS: Participant[] = [];
export const EMPTY_ENTRIES: Entry[] = [];
export const EMPTY_MESSAGES: MsgFrame[] = [];
export const EMPTY_ACTIVITY: SessionActivity[] = [];
export const EMPTY_AGENTS: string[] = [];
export const EMPTY_STREAM: SessionStreamItem[] = [];

export function emptyState(sessionId: string): SessionLiveState {
  let s = empties.get(sessionId);
  if (s) return s;
  s = {
    sessionId,
    connection: "idle",
    role: null,
    you: null,
    yourAgents: EMPTY_AGENTS,
    participants: EMPTY_PARTICIPANTS,
    entries: EMPTY_ENTRIES,
    messages: EMPTY_MESSAGES,
    activity: EMPTY_ACTIVITY,
    hostOnline: false,
    typing: EMPTY_TYPING,
    tunnels: null,
    share: null,
    shareUrl: null,
    hostMachine: null,
    agentSessionId: null,
    lastSeq: 0,
    lastError: null,
  };
  empties.set(sessionId, s);
  return s;
}
// ── Ordered, deduped insertion ───────────────────────────────────────────

/** Insert one seq-carrying item in order, dropping duplicates. Returns the
 *  SAME array when nothing changed, so a replayed frame can't re-render. */
export function mergeBySeq<T extends { seq: number }>(
  list: T[],
  next: T,
  sameId: (a: T, b: T) => boolean,
  cap: number,
): T[] {
  for (let i = list.length - 1; i >= 0; i--) {
    const cur = list[i];
    if (next.seq > 0 && cur.seq === next.seq) return list;
    if (sameId(cur, next)) return list;
    // Items arrive in order almost always — stop scanning once we are safely
    // older than the newcomer rather than walking the whole backlog.
    if (next.seq > 0 && cur.seq > 0 && cur.seq < next.seq) break;
  }
  const out = [...list];
  if (next.seq > 0) {
    let at = out.length;
    while (at > 0) {
      const prev = out[at - 1];
      if (prev.seq > 0 && prev.seq > next.seq) at -= 1;
      else break;
    }
    out.splice(at, 0, next);
  } else {
    // seq 0 means "seeded from history without a cursor" — those just append.
    out.push(next);
  }
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** The one reference worth showing: the symbol a message named, else the file.
 *  A path is a poor second — the rail's line is ~180px and a symbol is what a
 *  person recognises — but it beats saying nothing. */
export function refOf(refs: readonly SessionLiveRef[]): string | null {
  const first = refs[0];
  if (!first) return null;
  return first.symbol || first.file || null;
}

/** Append one activity, deduped by id and capped. Same-reference-on-no-change
 *  rule as `mergeBySeq`. */
export function pushActivity(
  list: SessionActivity[],
  next: SessionActivity,
): SessionActivity[] {
  if (list.some((a) => a.id === next.id)) return list;
  const out = [...list, next];
  return out.length > ACTIVITY_RETENTION
    ? out.slice(out.length - ACTIVITY_RETENTION)
    : out;
}
