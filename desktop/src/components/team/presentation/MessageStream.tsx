/** Team (chat) presentation — message stream + dividers + empty states.
 *
 *  Moved verbatim out of the CommsPanel monolith; logic unchanged.
 *  Imports are filled in after extraction. */

import { useEffect, useMemo, useRef } from "react";
import { Lock, Mail, UserPlus } from "lucide-react";
import { animalForName, tintForName } from "../../../lib/identityColors";
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
  onOpenMembers,
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
  onOpenMembers: () => void;
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

  // Group thread replies by parent id in a single pass over `allMsgs`.
  // Previously the render did `allMsgs.filter(x => x.thread_parent === m.id)`
  // inside the per-message map — O(messages × allMsgs) every render. This
  // rebuilds the index only when `allMsgs` changes, and (crucially) hands each
  // Bubble a *stable* array reference so its memo can skip re-rendering when
  // its own replies are unchanged.
  const repliesByParent = useMemo(() => {
    const out = new Map<string, Msg[]>();
    for (const m of allMsgs) {
      if (!m.thread_parent) continue;
      const list = out.get(m.thread_parent);
      if (list) list.push(m);
      else out.set(m.thread_parent, [m]);
    }
    return out;
  }, [allMsgs]);

  if (msgs.length === 0) {
    return (
      <div className="slack-message-stream flex-1 min-h-0 overflow-y-auto">
        <EmptyChannel conv={conv} members={members} onOpenMembers={onOpenMembers} />
      </div>
    );
  }

  return (
    <div ref={ref} className="slack-message-stream flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
      {conv.kind === "channel" || conv.kind === "custom" ? (
        <ChannelWelcome conv={conv} members={members} onOpenMembers={onOpenMembers} />
      ) : null}
      {msgs.map((m, i) => {
        const prev = msgs[i - 1];
        const showDate = !prev || !sameLocalDay(prev.ts, m.ts);
        const showNew = m.id === newDividerId;
        const repliesForChip = repliesByParent.get(m.id);
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
    // A bordered, filled, ALL-CAPS 10px pill on a hairline that was already
    // doing the separating. Three devices for one job. The rule separates;
    // the label names the day, in the same 11px sentence case every other
    // piece of metadata in the app is set in.
    <div className="flex items-center gap-2 my-4 select-none">
      <div className="flex-1 h-px bg-line-soft" />
      <span className="text-xs text-text-4">{label}</span>
      <div className="flex-1 h-px bg-line-soft" />
    </div>
  );
}

export function NewDivider() {
  return (
    <div className="flex items-center gap-2 my-2 select-none">
      <div className="flex-1 h-px bg-accent" />
      <span className="text-xs font-medium text-accent">New</span>
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
      <div className="text-text-1 text-base font-medium mb-1">Pick a channel or start a DM</div>
      <div className="text-text-4 text-xs max-w-[260px] leading-snug">
        Channels are per-repo and shared with anyone who has cloned the same
        git origin. No signup required.
      </div>
    </div>
  );
}

function EmptyChannel({
  conv,
  members,
  onOpenMembers,
}: {
  conv: Conversation;
  members: TeamMember[];
  onOpenMembers: () => void;
}) {
  if (conv.kind === "dm") {
    return (
      <div className="slack-empty-dm h-full flex flex-col items-center justify-center text-center px-8">
        <span
          className="w-14 h-14 rounded-full flex items-center justify-center mb-3"
          style={{ background: tintForName(conv.name), fontSize: 28 }}
        >
          {animalForName(conv.name)}
        </span>
        {/* Name first, handle in the sentence. `@` in front of a person's name
            read as a handle that doesn't exist, and this pane was the one place
            you could no longer see which seat you were writing to. */}
        <div className="text-text-1 text-base font-medium mb-1">{conv.name}</div>
        <div className="text-text-4 text-xs max-w-[280px] leading-snug">
          This is the start of your direct message with{" "}
          <span className="text-text-2">@{conv.handle ?? conv.name}</span>.
          Messages here are private to the two of you.
        </div>
      </div>
    );
  }
  if (conv.kind === "system") {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-8 text-text-4 text-sm">
        no events yet. Local activity will appear here
      </div>
    );
  }
  if (conv.kind === "project") {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-8 text-text-4 text-sm">
        no project activity yet. Intents, snapshots and commits will appear
        here as you work.
      </div>
    );
  }
  return <ChannelWelcome conv={conv} members={members} onOpenMembers={onOpenMembers} spacious />;
}

function ChannelWelcome({
  conv,
  members,
  onOpenMembers,
  spacious,
}: {
  conv: Conversation;
  members: TeamMember[];
  onOpenMembers: () => void;
  spacious?: boolean;
}) {
  const channelName = conv.name.replace(/^#/, "");
  const copyEmail = () => {
    const alias = `${channelName}@aura.team`;
    void navigator.clipboard?.writeText(alias);
  };
  return (
    <section className={`slack-channel-welcome ${spacious ? "is-spacious" : ""}`}>
      <h1>
        {conv.private ? <Lock size={25} fill="currentColor" /> : <span>#</span>}
        {channelName}
      </h1>
      <p>
        You created this channel for focused team collaboration. This is the beginning of the
        {" "}<strong>{conv.private ? <Lock size={11} fill="currentColor" /> : "#"}{channelName}</strong> channel.
      </p>
      <p className="slack-channel-description">
        Description: {conv.hint || "Share decisions, progress, and launch updates with your team."}
      </p>
      <div className="slack-channel-welcome-actions">
        <button type="button" className="is-primary" onClick={onOpenMembers}>
          <UserPlus size={15} /> Add coworkers
        </button>
        <button type="button" onClick={copyEmail}>
          <Mail size={15} /> Send emails to channel
        </button>
      </div>
      <div className="slack-channel-tip">
        <strong>Work with your whole team in one place.</strong>
        <span>
          Add collaborators, share updates, and keep every decision connected to the work.
        </span>
        <div className="slack-tip-facepile">
          {members.slice(0, 3).map((member) => (
            <span key={member.handle} title={member.name}>{animalForName(member.handle)}</span>
          ))}
        </div>
      </div>
    </section>
  );
}
