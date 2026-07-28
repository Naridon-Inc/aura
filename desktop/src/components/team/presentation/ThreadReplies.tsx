/** Team (chat) presentation — the thread (replies) view: parent post + scoped replies + thread composer.
 *
 *  Moved verbatim out of the CommsPanel monolith; logic unchanged. */

import { useMemo, useRef } from "react";
import { Pin as PinLucide } from "lucide-react";
import { type TeamMember } from "../../../lib/api";
import { type ChatAttachment } from "../../chat/FileAttachment";
import { type RepoFileAttachment } from "../../chat/RepoFileChip";
import { prettyName, type Conversation, type Msg, type SelfKeys } from "../domain";
import { Bubble } from "./Bubble";
import { NewDivider } from "./MessageStream";
import { Composer } from "./Composer";

// ── thread (replies) view ────────────────────────────────────────────

export function ThreadReplies({
  conv,
  repoRoot,
  parent,
  replies,
  members,
  selfHandle,
  selfKeys,
  lastRead,
  myDeviceId,
  myDisplay,
  onBack,
  onSend,
  onBackToRail,
  onTogglePin,
  onResend,
  onMarkRead,
}: {
  conv: Conversation;
  repoRoot: string;
  parent: Msg;
  replies: Msg[];
  members: TeamMember[];
  selfHandle: string;
  /** Local-user identity key set — forwarded to each Bubble for `fromMe`. */
  selfKeys: SelfKeys;
  lastRead: number;
  myDeviceId: string | null;
  myDisplay: string | null;
  onBack: () => void;
  onSend: (
    body: string,
    attachments?: ChatAttachment[],
    repoFiles?: RepoFileAttachment[],
  ) => Promise<void> | void;
  onBackToRail?: () => void;
  onTogglePin: (msgId: string) => void;
  onResend?: (msgId: string) => void;
  onMarkRead: () => void;
}) {
  const all = useMemo(() => [parent, ...replies], [parent, replies]);
  const composerFocusRef = useRef<HTMLTextAreaElement | null>(null);

  // Participants line: union of parent + reply senders, in first-seen
  // order, capped to keep the header compact.
  const participants = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of all) {
      if (seen.has(m.sender)) continue;
      seen.add(m.sender);
      out.push(m.sender);
    }
    return out;
  }, [all]);

  // NEW divider boundary inside the thread (replies-only — the parent
  // post is always rendered).
  const newDividerId = useMemo(() => {
    if (lastRead <= 0) return null;
    const m = replies.find((x) => x.ts > lastRead && !x.fromMe);
    return m?.id ?? null;
  }, [replies, lastRead]);

  const hasUnread = useMemo(
    () => replies.some((r) => r.ts > lastRead && !r.fromMe),
    [replies, lastRead],
  );

  // The project feed is the team's activity story, not a chat channel — it
  // has no room to post into (`sendMessage` no-ops without a `conv.channel`).
  // So an intent thread is read-only: you read the play-by-play, which fills
  // in live as the agent keeps working. Swap the composer for a quiet hint.
  const readOnly = conv.kind === "project";

  return (
    <div className="slack-thread-view h-full flex flex-col">
      <header className="flex-shrink-0 flex items-center gap-2 px-2 h-11 border-b border-line-soft bg-bg-content">
        {onBackToRail && (
          <button
            type="button"
            onClick={onBackToRail}
            className="w-7 h-7 rounded text-text-2 hover:text-text-1 hover:bg-bg-2 flex items-center justify-center"
            title="Back to channels"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M10 3.5L5.5 8 10 12.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
        <button
          type="button"
          onClick={onBack}
          className="w-7 h-7 rounded text-text-2 hover:text-text-1 hover:bg-bg-2 flex items-center justify-center"
          title="Back to channel"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M3 8h10M3 8l3-3M3 8l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-text-1 text-[12.5px] font-medium truncate">Thread</div>
          <div className="text-text-4 text-[10.5px] truncate -mt-0.5">
            in {prettyName(conv)} · {replies.length} repl
            {replies.length === 1 ? "y" : "ies"}
          </div>
        </div>
      </header>

      {/* Slack-style sub-header — channel name + participant handles. */}
      <div className="flex-shrink-0 px-3 py-1.5 border-b border-line-soft bg-bg-1">
        <div className="text-text-2 text-[11.5px] font-medium">
          {prettyName(conv)}
        </div>
        {participants.length > 0 && (
          <div className="text-text-4 text-[10.5px] truncate" title={participants.join(", ")}>
            {participants.join(", ")}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {/* Parent — wrapped in a soft-yellow card when pinned. */}
        {parent.pinned ? (
          <div className="rounded-md bg-bg-2 border-l-2 border-line p-2 mb-2">
            <div className="flex items-center gap-1 mb-1 text-[10px] text-text-4 font-medium">
              <PinLucide size={10} />
              <span>Pinned</span>
            </div>
            <Bubble
              msg={parent}
              repoRoot={repoRoot}
              members={members}
              selfHandle={selfHandle}
              selfKeys={selfKeys}
              channel={conv.channel ?? null}
              myDeviceId={myDeviceId}
              myDisplay={myDisplay}
              onTogglePin={() => onTogglePin(parent.id)}
              onResend={onResend ? () => onResend(parent.id) : undefined}
            />
          </div>
        ) : (
          <Bubble
            msg={parent}
            repoRoot={repoRoot}
            members={members}
            selfHandle={selfHandle}
            selfKeys={selfKeys}
            channel={conv.channel ?? null}
            myDeviceId={myDeviceId}
            myDisplay={myDisplay}
            onTogglePin={() => onTogglePin(parent.id)}
            onResend={onResend ? () => onResend(parent.id) : undefined}
          />
        )}
        {/* Replies, with NEW divider scoped to the thread. */}
        {replies.map((m, i) => {
          const prev = i === 0 ? parent : replies[i - 1];
          const showNew = m.id === newDividerId;
          return (
            <div key={m.id}>
              {showNew && <NewDivider />}
              <Bubble
                msg={m}
                prev={prev}
                repoRoot={repoRoot}
                members={members}
                selfHandle={selfHandle}
                selfKeys={selfKeys}
                channel={conv.channel ?? null}
                myDeviceId={myDeviceId}
                myDisplay={myDisplay}
                onTogglePin={() => onTogglePin(m.id)}
                onResend={onResend ? () => onResend(m.id) : undefined}
              />
            </div>
          );
        })}
      </div>

      {/* Mark-as-read / Reply pills — Slack pattern, only on unread. */}
      {!readOnly && hasUnread && (
        <div className="flex-shrink-0 px-3 pt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={onMarkRead}
            className="h-7 px-3 rounded-full text-[11px] font-medium"
            style={{
              background: "var(--color-accent-green)",
              color: "var(--color-bg-deep)",
            }}
          >
            Mark as read
          </button>
          <button
            type="button"
            onClick={() => composerFocusRef.current?.focus()}
            className="h-7 px-3 rounded-full text-[11px] font-medium bg-bg-2 border border-line-soft text-text-2 hover:text-text-1"
          >
            Reply
          </button>
        </div>
      )}

      {/* TODO(parallel): typing-indicator slot (thread variant) */}
      <div
        data-slot="typing-indicator"
        className="flex-shrink-0 px-3 text-[10.5px] text-text-4 leading-[18px] truncate"
        style={{ height: 18 }}
      />
      {readOnly ? (
        <div className="flex-shrink-0 px-3 py-2.5 border-t border-line-soft text-[10.5px] text-text-5 text-center leading-snug">
          This thread updates live as the session continues.
        </div>
      ) : (
        <Composer
          conv={conv}
          repoRoot={repoRoot}
          members={members}
          onSend={onSend}
          placeholder="Reply to thread…"
          textareaRef={composerFocusRef}
        />
      )}
    </div>
  );
}
