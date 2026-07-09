/** Team (chat) presentation — message stream + dividers + empty states.
 *
 *  Moved verbatim out of the CommsPanel monolith; logic unchanged.
 *  Imports are filled in after extraction. */

import { useEffect, useMemo, useRef } from "react";
import { animalForName, colorForName, tintForName } from "../../../lib/identityColors";
import { type TeamMember } from "../../../lib/api";
import { sameLocalDay, humanDateLabel } from "./messageHelpers";
import { type Conversation, type Msg, type ReadCursorEntry, type SelfKeys } from "../domain";
import { Bubble } from "./Bubble";

// ── message stream + empty states ────────────────────────────────────

export function MessageStream({
  conv,
  repoRoot,
  msgs,
  members,
  selfHandle,
  selfKeys,
  threadCounts,
  allMsgs,
  lastRead,
  myDeviceId,
  myDisplay,
  readCursors,
  onOpenReplies,
  onTogglePin,
  onResend,
}: {
  conv: Conversation;
  repoRoot: string;
  msgs: Msg[];
  members: TeamMember[];
  selfHandle: string;
  /** Local-user identity key set — forwarded to each Bubble so `fromMe`
   *  resolves against every handle variant we've ever sent under. */
  selfKeys: SelfKeys;
  threadCounts: Map<string, number>;
  /** Full message list (including thread replies) — used by the reply
   *  chip to pull the last-reply author + timestamp. */
  allMsgs: Msg[];
  lastRead: number;
  /** This device's id (used to attribute reactions). Null until the
   *  identity fetch completes — reactions toggle is disabled in that
   *  brief window. */
  myDeviceId: string | null;
  /** Human-readable name for this device, denormalised onto the
   *  reaction row server-side so chip tooltips can show it. */
  myDisplay: string | null;
  /** Peer read cursors for this channel (excluding our own device).
   *  Renders as "Seen by …" under the most recent of our own messages
   *  whose `seq` is at or below each peer's `last_read_seq`. */
  readCursors?: ReadCursorEntry[];
  onOpenReplies: (m: Msg) => void;
  onTogglePin: (msgId: string) => void;
  onResend?: (msgId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, conv.id]);

  // Pinned-panel "jump to message" handler — scroll the row into view
  // and flash a highlight ring so the user spots it.
  useEffect(() => {
    function onJump(e: Event) {
      const detail = (e as CustomEvent<{ msgId: string }>).detail;
      if (!detail?.msgId) return;
      const el = ref.current?.querySelector(
        `[data-msg-id="${CSS.escape(detail.msgId)}"]`,
      ) as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("aura-msg-flash");
      window.setTimeout(() => el.classList.remove("aura-msg-flash"), 1800);
    }
    window.addEventListener("aura:scroll-to-message", onJump);
    return () => window.removeEventListener("aura:scroll-to-message", onJump);
  }, []);

  // First message id whose ts > lastRead AND not from me — that's where
  // the "NEW" divider lands. If everything is unread (lastRead === 0)
  // we suppress it so a freshly-opened channel doesn't get a divider
  // before its very first message.
  const newDividerId = useMemo(() => {
    if (lastRead <= 0) return null;
    const m = msgs.find((x) => x.ts > lastRead && !x.fromMe);
    return m?.id ?? null;
  }, [msgs, lastRead]);

  // For each peer cursor, find the highest-seq `fromMe` message that
  // sits at or below `last_read_seq`. Those are the anchors for the
  // "Seen by …" footer. Building a Map keyed by `Msg.id` lets the
  // Bubble pluck its viewers in O(1).
  const seenByAnchor = useMemo(() => {
    const out = new Map<string, ReadCursorEntry[]>();
    if (!readCursors || readCursors.length === 0) return out;
    const mineWithSeq = msgs.filter(
      (m) => m.fromMe && typeof m.seq === "number" && (m.seq ?? 0) > 0,
    );
    if (mineWithSeq.length === 0) return out;
    for (const cursor of readCursors) {
      let anchor: Msg | null = null;
      for (const m of mineWithSeq) {
        if ((m.seq ?? 0) <= cursor.last_read_seq) anchor = m;
        else break; // msgs is ts-sorted; seq is monotonic with ts
      }
      if (!anchor) continue;
      const list = out.get(anchor.id) ?? [];
      list.push(cursor);
      out.set(anchor.id, list);
    }
    return out;
  }, [msgs, readCursors]);

  if (msgs.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto">
        <EmptyChannel conv={conv} />
      </div>
    );
  }

  return (
    <div ref={ref} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pl-3 pr-2 py-2">
      {msgs.map((m, i) => {
        const prev = msgs[i - 1];
        const showDate = !prev || !sameLocalDay(prev.ts, m.ts);
        const showNew = m.id === newDividerId;
        const repliesForChip = allMsgs.filter((x) => x.thread_parent === m.id);
        return (
          <div key={m.id} data-msg-id={m.id} className="aura-msg-anchor">
            {showDate && <DateSeparator ts={m.ts} />}
            {showNew && <NewDivider />}
            <Bubble
              msg={m}
              prev={prev}
              repoRoot={repoRoot}
              members={members}
              selfHandle={selfHandle}
              selfKeys={selfKeys}
              replyCount={threadCounts.get(m.id) ?? 0}
              replies={repliesForChip}
              channel={conv.channel ?? null}
              myDeviceId={myDeviceId}
              myDisplay={myDisplay}
              seenBy={seenByAnchor.get(m.id)}
              onReply={() => onOpenReplies(m)}
              onTogglePin={() => onTogglePin(m.id)}
              onResend={onResend ? () => onResend(m.id) : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

// ── divider primitives ──────────────────────────────────────────────

function DateSeparator({ ts }: { ts: number }) {
  const label = humanDateLabel(ts);
  return (
    <div className="flex items-center my-3 select-none">
      <div className="flex-1 h-px bg-line-soft" />
      <span className="mx-2 text-[10px] uppercase tracking-wider text-text-5 bg-bg-1 px-2 py-0.5 rounded-full border border-line-soft">
        {label}
      </span>
      <div className="flex-1 h-px bg-line-soft" />
    </div>
  );
}

export function NewDivider() {
  return (
    <div className="flex items-center my-2 select-none">
      <div className="flex-1 h-px bg-red-500" />
      <span className="ml-2 text-[10px] uppercase tracking-wider text-red-500 font-semibold">
        New
      </span>
    </div>
  );
}

export function EmptyNoSelection() {
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-center px-8">
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center mb-4 text-text-5"
        style={{ background: "var(--color-bg-1)", border: "1px solid var(--color-line-soft)" }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <path
            d="M3 5a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H8l-5 4V5z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="text-text-1 text-[13px] font-medium mb-1">Pick a channel or start a DM</div>
      <div className="text-text-4 text-[11px] max-w-[260px] leading-snug">
        Channels are per-repo and shared with anyone who has cloned the same
        git origin. No signup required.
      </div>
    </div>
  );
}

function EmptyChannel({ conv }: { conv: Conversation }) {
  if (conv.kind === "dm") {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-8">
        <span
          className="w-14 h-14 rounded-full flex items-center justify-center mb-3"
          style={{ background: tintForName(conv.name), fontSize: 28 }}
        >
          {animalForName(conv.name)}
        </span>
        <div className="text-text-1 text-[13px] font-medium mb-1">
          @{conv.name}
        </div>
        <div className="text-text-4 text-[11px] max-w-[280px] leading-snug">
          This is the start of your direct message with{" "}
          <span className="text-text-2">@{conv.name}</span>. Messages here are
          private to the two of you.
        </div>
      </div>
    );
  }
  if (conv.kind === "system") {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-8 text-text-4 text-[11.5px]">
        no events yet — local activity will appear here
      </div>
    );
  }
  if (conv.kind === "project") {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-8 text-text-4 text-[11.5px]">
        no project activity yet — intents, snapshots and commits will appear
        here as you work.
      </div>
    );
  }
  // channel / custom
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8">
      <span
        className="w-14 h-14 rounded-full flex items-center justify-center mb-3 font-medium"
        style={{
          background: tintForName(conv.name),
          color: colorForName(conv.name),
          fontSize: 22,
        }}
      >
        #
      </span>
      <div className="text-text-1 text-[13px] font-medium mb-1">
        Welcome to #{conv.name}
      </div>
      <div className="text-text-4 text-[11px] max-w-[280px] leading-snug">
        Start the conversation in <span className="text-text-2">#{conv.name}</span>.
        Send the first message below.
      </div>
    </div>
  );
}
