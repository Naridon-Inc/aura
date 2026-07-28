/** Team (chat) presentation — the message bubble (grouping, reactions, hover actions, delivery/seen, rich-link unfurl).
 *
 *  Moved verbatim out of the CommsPanel monolith; logic unchanged.
 *  Imports are filled in after extraction. */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { onExternalAnchorClick } from "../../../lib/openExternal";
import {
  Bookmark,
  MessageSquareReply,
  MoreHorizontal,
  Pin as PinLucide,
  SmilePlus,
} from "lucide-react";
import { type TeamMember } from "../../../lib/api";
import { ChatMarkdown } from "../../chat/ChatMarkdown";
import { PICKER_EMOJIS, reactionsStore } from "../../../lib/reactionsStore";
import { AttachmentList, parseAttachments } from "../../chat/FileAttachment";
import { RepoFileChip, parseRepoFiles } from "../../chat/RepoFileChip";
import { AuraRefUnfurl, RelayCardView } from "../../chat/AuraRefCard";
import { parseRelay, pickSoloAuraRef } from "../../../lib/auraRelay";
import { animalForName, tintForName } from "../../../lib/identityColors";
import { hhmm, isSelfSender, norm, type Msg, type ReadCursorEntry, type SelfKeys } from "../domain";
import { MiniAvatar } from "./MiniAvatar";
import { Avatar } from "./Avatar";
import { ActivityRow } from "./ActivityRow";
import { isSystemNotice, pickSoloLink, relativeTime, useUniqueAuthors } from "./messageHelpers";

// ── message bubble ───────────────────────────────────────────────────

type BubbleProps = {
  msg: Msg;
  prev?: Msg;
  repoRoot: string;
  members: TeamMember[];
  selfHandle: string;
  /** The local user's full identity key set. `fromMe` is resolved against
   *  it so a message stamped under any of our historical handle variants
   *  (override / roster / email-local-part) still files as ours. */
  selfKeys: SelfKeys;
  replyCount?: number;
  replies?: Msg[];
  /** Channel slug the bubble belongs to — propagated into the reaction
   *  frame so the cloud can scope its broadcast. */
  channel: string | null;
  myDeviceId: string | null;
  myDisplay: string | null;
  /** Peer devices whose read cursors land at or past this message's
   *  seq. Renders as a compact "Seen by …" row under our own bubbles. */
  seenBy?: ReadCursorEntry[];
  onReply?: () => void;
  onTogglePin?: () => void;
  onResend?: () => void;
};

function BubbleImpl({
  msg,
  prev,
  repoRoot,
  members,
  selfHandle,
  selfKeys,
  replyCount,
  replies,
  channel,
  myDeviceId,
  myDisplay,
  seenBy,
  onReply,
  onTogglePin,
  onResend,
}: BubbleProps) {
  const grouped =
    prev && prev.sender === msg.sender && Math.abs(msg.ts - (prev.ts || 0)) < 300;
  const tail = !grouped;

  // `msg.fromMe` is baked into the Msg at load time and can be stale if
  // identity wasn't known yet when the message landed (it hydrates async).
  // Re-derive at render against the authoritative `selfKeys` set so the
  // user's own messages always slide to the right side once identity
  // loads — and so a message stamped under a *different* handle layer than
  // the current `selfHandle` (the root of the "my message shows as a
  // colleague" bug) is still recognised as ours. Exact membership only:
  // no fuzzy local-part split that could absorb a lookalike peer.
  //
  // A foreign device id VETOES a baked `fromMe`: a colleague who shares our
  // git-email local-part would otherwise inherit our "you" badge (identity is
  // derived, not verified). We only trust the baked flag when no device id
  // contradicts it (synthetic rows and our own local echoes carry none).
  const foreignDevice =
    !!msg.senderDeviceId &&
    !!myDeviceId &&
    norm(msg.senderDeviceId) !== norm(myDeviceId);
  const fromMe =
    isSelfSender(msg.sender, selfKeys, {
      senderDeviceId: msg.senderDeviceId ?? null,
      myDeviceId,
    }) ||
    (msg.fromMe && !foreignDevice);

  // Structured project-feed rows (commits, sentinel intents, snapshots,
  // sentinel messages). Rendered as a tight activity row, not a bubble.
  if (msg.kind === "activity" && msg.activity) {
    return <ActivityRow msg={msg} activity={msg.activity} repoRoot={repoRoot} />;
  }

  // Slack-style "system" rendering for agent-emitted membership /
  // topic-change notices. We surface these as left-padded italic gray
  // lines without an avatar / header so they read as ambient activity.
  if (msg.kind === "system" || isSystemNotice(msg)) {
    const text = msg.kind === "system" ? msg.body : msg.body;
    return (
      <div className="slack-system-message">
        <MiniAvatar name={msg.sender} agent={msg.is_agent} />
        <span><strong>@{msg.sender}</strong>{" "}
        {text}
        </span>
      </div>
    );
  }

  // Tear apart attachments + repo-files from the body so we render the
  // text + chip strip independently. Order: peel relay payloads first
  // (they own the bubble visually), then attachments (tail sentinel),
  // then repo-files from the remainder.
  const { text: afterRelay, cards: relayCards } = parseRelay(msg.body);
  const { text: afterAtts, attachments } = parseAttachments(afterRelay);
  const { text: bodyText, files: repoFiles } = parseRepoFiles(afterAtts);

  const unfurl = pickSoloLink(bodyText);
  const auraUnfurl = pickSoloAuraRef(bodyText);

  const lastReply =
    replies && replies.length > 0 ? replies[replies.length - 1] : undefined;
  const replyAvatars = useUniqueAuthors(replies ?? []).slice(0, 3);

  const replyChip =
    replyCount && replyCount > 0 ? (
      <button
        type="button"
        onClick={onReply}
        className="mt-1 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-bg-2 border border-line-soft text-text-3 hover:text-text-1 hover:border-line text-[10.5px]"
        title="Open thread"
      >
        <span className="flex -space-x-1">
          {replyAvatars.map((h) => (
            <span
              key={h}
              className="w-3.5 h-3.5 rounded-full border border-bg-1 flex items-center justify-center"
              style={{ background: tintForName(h), fontSize: 8 }}
              title={h}
            >
              {animalForName(h)}
            </span>
          ))}
        </span>
        <span className="font-medium text-text-2">
          {replyCount} repl{replyCount === 1 ? "y" : "ies"}
        </span>
        {lastReply ? (
          <span className="text-text-5 tabular-nums">{relativeTime(lastReply.ts)}</span>
        ) : null}
      </button>
    ) : null;

  // The server never stamps `msg.read_at`; the authoritative read signal is
  // the peers' read cursors (`seenBy`, RFC3339 strings). Promote the receipt
  // to "Read" whenever at least one peer cursor reached this row. `readAt`
  // (epoch seconds) is only ever a real number, so it stays optional and
  // feeds the timestamp tooltip when the server does supply one.
  const readByPeer = (seenBy?.length ?? 0) > 0;
  const deliveryBadge = msg.delivery_status ? (
    <DeliveryBadge
      status={msg.delivery_status}
      read={readByPeer}
      readAt={typeof msg.read_at === "number" ? msg.read_at : undefined}
      onResend={onResend}
    />
  ) : null;
  const pinBadge = msg.pinned ? <PinnedTag /> : null;
  const reactionStrip = (
    <ReactionStrip
      msgId={msg.id}
      channel={channel}
      myDeviceId={myDeviceId}
      myDisplay={myDisplay}
      fromMe={fromMe}
    />
  );
  const hoverActions = (
    <HoverActions
      pinned={!!msg.pinned}
      onTogglePin={onTogglePin}
      onReply={onReply}
      onAddReaction={
        myDeviceId
          ? (emoji) =>
              sendReactionFrame(msg.id, emoji, myDeviceId, myDisplay, channel)
          : undefined
      }
    />
  );

  // Body content (text + attachments + repo-files + unfurl) shared
  // between the "from me" and "from peer" layouts.
  const bodyContent = (
    <>
      {bodyText && <ChatMarkdown body={bodyText} members={members} selfHandle={selfHandle} />}
      {repoFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {repoFiles.map((f, i) => (
            <RepoFileChip
              key={`${msg.id}:rf:${i}`}
              repoRoot={repoRoot}
              path={f.path}
              lineStart={f.lineStart}
              lineEnd={f.lineEnd}
            />
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <AttachmentList attachments={attachments} fromMe={fromMe} />
      )}
      {relayCards.map((card, i) => (
        <RelayCardView key={`${msg.id}:relay:${i}`} card={card} repoRoot={repoRoot} />
      ))}
      {auraUnfurl && <AuraRefUnfurl url={auraUnfurl} repoRoot={repoRoot} />}
      {unfurl && <LinkUnfurl url={unfurl} />}
    </>
  );

  // "Seen by …" row — only meaningful under our own messages, and only
  // when at least one peer device's cursor has reached this row's seq.
  const seenByRow =
    fromMe && seenBy && seenBy.length > 0 ? <SeenByRow peers={seenBy} /> : null;

  const displayMember = members.find((member) => member.handle === msg.sender);
  const displayName = displayMember?.name || msg.sender;

  return (
    <div
      className={`slack-message-row group ${grouped ? "is-grouped" : ""} ${
        fromMe ? "is-mine" : ""
      } ${msg.pinned ? "is-pinned" : ""}`}
    >
      <div className="slack-message-avatar-col">
        {tail ? (
          msg.is_agent ? (
            <MiniAvatar name={msg.sender} agent />
          ) : (
            <Avatar
              name={displayName}
              size={36}
              src={
                displayMember?.github_login
                  ? `https://github.com/${encodeURIComponent(displayMember.github_login)}.png?size=72`
                  : null
              }
            />
          )
        ) : (
          <span className="slack-grouped-time">{msg.ts ? hhmm(msg.ts) : ""}</span>
        )}
      </div>
      <div className="slack-message-content">
        {tail && (
          <div className="slack-message-meta">
            <strong>{displayName}</strong>
            {msg.is_agent && <span className="slack-agent-badge">APP</span>}
            {fromMe && <span className="slack-you-badge">you</span>}
            <time>{msg.ts ? hhmm(msg.ts) : ""}</time>
          </div>
        )}
        {pinBadge}
        <div className="slack-message-body">{bodyContent}</div>
        <div className="slack-message-reactions">{reactionStrip}</div>
        {(replyChip || deliveryBadge || seenByRow) && (
          <div className="slack-message-footer">
            {replyChip}
            {deliveryBadge}
            {seenByRow}
          </div>
        )}
      </div>
      <div className="slack-message-hover-actions">{hoverActions}</div>
    </div>
  );
}

// Rows are memoized: a chat stream re-renders on every new message, reaction,
// typing tick, and read-cursor advance, but any given bubble's *content* rarely
// changes. We compare the data props by reference and deliberately ignore the
// `onReply` / `onTogglePin` / `onResend` callbacks — MessageStream recreates
// those inline per row every render, yet each closes only over `msg` (compared
// here) plus stable parent handlers, so skipping their identity is safe and is
// what lets the memo actually bite. `replies` is now a stable Map-backed array
// (see MessageStream.repliesByParent), so it too compares cleanly.
export const Bubble = memo(BubbleImpl, (a, b) =>
  a.msg === b.msg &&
  a.prev === b.prev &&
  a.repoRoot === b.repoRoot &&
  a.members === b.members &&
  a.selfHandle === b.selfHandle &&
  a.selfKeys === b.selfKeys &&
  a.replyCount === b.replyCount &&
  a.replies === b.replies &&
  a.channel === b.channel &&
  a.myDeviceId === b.myDeviceId &&
  a.myDisplay === b.myDisplay &&
  a.seenBy === b.seenBy,
);

// Read cursors carry an RFC3339 timestamp string (not epoch seconds), so
// `hhmm` does not apply. Render a short local "h:mm AM/PM" for the tooltip,
// degrading to empty on an unparseable value.
function fmtCursorTime(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// "Seen by …" — compact avatar row under our own most-recently-read
// message. Up to three avatars rendered inline; the rest fold into a
// "+N" pill with the full name list on hover. Avatars reuse the same
// `animalForName` palette every other peer chip in the panel uses so
// the receipt visually anchors to the team roster.
function SeenByRow({ peers }: { peers: ReadCursorEntry[] }) {
  if (!peers.length) return null;
  const shown = peers.slice(0, 3);
  const extra = peers.length - shown.length;
  const allNames = peers.map((p) => p.display || "Someone").join(", ");
  // Most recent advance — surfaced in the title for context. Cursors carry
  // RFC3339 strings, which sort correctly lexicographically.
  const mostRecent = peers.reduce((acc, p) => {
    if (!acc) return p;
    return p.last_read_at > acc.last_read_at ? p : acc;
  }, peers[0]);
  const lastAt = mostRecent ? fmtCursorTime(mostRecent.last_read_at) : "";
  return (
    <div
      className="mt-0.5 mr-1 flex items-center justify-end gap-1 text-[10px] text-text-5"
      title={`Seen by ${allNames}${lastAt ? ` · last at ${lastAt}` : ""}`}
    >
      <span className="text-text-4">Seen by</span>
      <span className="flex -space-x-1">
        {shown.map((p) => {
          const name = p.display || "Someone";
          return (
            <span
              key={p.device_id}
              className="w-3.5 h-3.5 rounded-full border border-bg-1 flex items-center justify-center"
              style={{ background: tintForName(name), fontSize: 8 }}
              title={name}
            >
              {animalForName(name)}
            </span>
          );
        })}
      </span>
      {extra > 0 ? <span className="text-text-4">+{extra}</span> : null}
    </div>
  );
}

// Hover-only action row: quick reactions + picker + thread reply + save +
// overflow. This mirrors the reference interaction while preserving Aura's
// existing reaction, thread, and pin persistence paths.
function HoverActions({
  pinned,
  onTogglePin,
  onReply,
  onAddReaction,
}: {
  pinned: boolean;
  onTogglePin?: () => void;
  onReply?: () => void;
  /** Called with the picked emoji when present. Omitted when no
   *  device identity is available — the picker stays hidden. */
  onAddReaction?: (emoji: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  if (!onTogglePin && !onReply && !onAddReaction) return null;
  return (
    <span className="slack-hover-action-strip relative opacity-0 group-hover:opacity-100 flex items-center">
      {onAddReaction && (
        <>
          {PICKER_EMOJIS.slice(0, 3).map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="slack-hover-action is-emoji"
              onClick={() => onAddReaction(emoji)}
              title={`React with ${emoji}`}
            >
              {emoji}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="slack-hover-action"
            title="Add reaction"
          >
            <SmilePlus size={16} />
          </button>
          {pickerOpen && (
            <EmojiPickerPopover
              onPick={(emoji) => {
                onAddReaction(emoji);
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </>
      )}
      {onTogglePin && (
        <button
          type="button"
          onClick={onTogglePin}
          className={`slack-hover-action ${pinned ? "is-active" : ""}`}
          title={pinned ? "Remove bookmark" : "Save for later"}
        >
          <Bookmark size={15} fill={pinned ? "currentColor" : "none"} />
        </button>
      )}
      {onReply && (
        <button
          type="button"
          onClick={onReply}
          className="slack-hover-action"
          title="Reply in thread"
        >
          <MessageSquareReply size={16} />
        </button>
      )}
      <button type="button" className="slack-hover-action" title="More actions">
        <MoreHorizontal size={16} />
      </button>
    </span>
  );
}

// Send a reaction frame through the existing aura:ws-send bridge so the
// chat WS handler (one socket per CommsPanel) forwards it to the room hub.
// We don't write to the reactions store locally — the broadcast loops back
// and applyServer handles it then, which keeps the source-of-truth at the
// cloud and stops double-toggle issues when the local frame races the
// snapshot fetch.
function sendReactionFrame(
  msgId: string,
  emoji: string,
  deviceId: string,
  display: string | null,
  channel: string | null,
) {
  window.dispatchEvent(
    new CustomEvent("aura:ws-send", {
      detail: {
        kind: "reaction",
        msg_id: msgId,
        emoji,
        device_id: deviceId,
        display: display ?? "",
        channel: channel ?? "general",
      },
    }),
  );
}

// Aggregated reaction chips below a message. Subscribed to the shared
// reactionsStore by msg_id so a single Bubble only re-renders when its
// own reactions change.
function ReactionStrip({
  msgId,
  channel,
  myDeviceId,
  myDisplay,
  fromMe: _fromMe,
}: {
  msgId: string;
  channel: string | null;
  myDeviceId: string | null;
  myDisplay: string | null;
  fromMe: boolean;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const off = reactionsStore.subscribe((touched) => {
      if (touched === null || touched === msgId) setTick((n) => n + 1);
    });
    return off;
  }, [msgId]);

  const agg = reactionsStore.getFor(msgId);
  if (agg.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 drop-shadow-sm">
      {agg.map((r) => {
        const mine = !!myDeviceId && reactionsStore.has(msgId, r.emoji, myDeviceId);
        return (
          <button
            key={r.emoji}
            type="button"
            onClick={() => {
              if (!myDeviceId) return;
              sendReactionFrame(msgId, r.emoji, myDeviceId, myDisplay, channel);
            }}
            title={r.names.join(", ")}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[11px] leading-none transition-colors ${
              mine
                ? "bg-accent/15 border-accent/40 text-text-1"
                : "bg-bg-2 border-line-soft text-text-2 hover:border-line"
            }`}
          >
            <span>{r.emoji}</span>
            <span className="tabular-nums">{r.count}</span>
          </button>
        );
      })}
    </div>
  );
}

// Popover with the canonical emoji set + a free-form input for picking
// anything else. Closes on pick or click-outside. Positioned absolutely
// off the picker button so it overlaps the bubble's hover region.
function EmojiPickerPopover({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [custom, setCustom] = useState("");
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="absolute z-40 bottom-full mb-1 left-0 w-[208px] rounded border border-line-soft bg-bg-1 p-2 shadow-lg"
      role="dialog"
    >
      <div className="grid grid-cols-6 gap-1">
        {PICKER_EMOJIS.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => onPick(e)}
            className="aspect-square flex items-center justify-center rounded text-base hover:bg-bg-2"
            title={`React with ${e}`}
          >
            {e}
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1">
        <input
          type="text"
          value={custom}
          maxLength={16}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && custom.trim()) {
              onPick(custom.trim());
            }
          }}
          placeholder="custom"
          className="flex-1 rounded border border-line-soft bg-bg-2 px-1.5 py-0.5 text-[11px] text-text-1 focus:border-line focus:outline-none"
        />
        <button
          type="button"
          onClick={() => {
            if (custom.trim()) onPick(custom.trim());
          }}
          className="text-[10px] text-text-3 hover:text-text-1"
        >
          add
        </button>
      </div>
    </div>
  );
}

// Tiny "📌 Pinned" tag above a pinned bubble.
function PinnedTag() {
  return (
    <div className="flex items-center gap-1 px-2 mb-0.5 text-[10px] text-text-4 font-medium">
      <PinLucide size={10} />
      <span>Pinned</span>
    </div>
  );
}

// Delivery status badge — only renders for the local user's own rows.
// iMessage-style receipts:
//   pending   → "•" muted    (in-flight to cloud)
//   delivered → "✓✓" muted   (acked by cloud, fan-out engaged)
//   read      → "✓✓" accent  (peer's last-read marker passed this ts)
//   failed    → "! retry"    (resend affordance)
function DeliveryBadge({
  status,
  read,
  readAt,
  onResend,
}: {
  status: "pending" | "delivered" | "failed";
  /** A peer's read cursor reached this message — promotes the badge to the
   *  read-receipt variant. Derived from `seenBy` in Bubble. */
  read?: boolean;
  /** Optional epoch-seconds read time; only present when the server stamps
   *  `msg.read_at`. Feeds the "Read · hh:mm" tooltip when known. */
  readAt?: number;
  onResend?: () => void;
}) {
  if (status === "failed") {
    return (
      <button
        type="button"
        onClick={onResend}
        className="text-[10px] text-red hover:text-red font-medium"
        title="Send failed — click to retry"
      >
        ! retry
      </button>
    );
  }
  if (status === "pending") {
    return (
      <span
        className="text-[10px] text-text-4 inline-flex items-center gap-0.5"
        title="Sending…"
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ background: "currentColor" }}
        />
      </span>
    );
  }
  // status === "delivered"
  const isRead = read === true || (typeof readAt === "number" && readAt > 0);
  return (
    <span
      className={`text-[10.5px] tabular-nums leading-none ${
        isRead ? "text-accent" : "text-text-5"
      }`}
      title={
        isRead
          ? typeof readAt === "number" && readAt > 0
            ? `Read · ${hhmm(readAt)}`
            : "Read"
          : "Delivered"
      }
    >
      ✓✓
    </span>
  );
}

// Lightweight URL unfurl card — no network fetch. Just shows the
// favicon (via Google s2) + hostname + trimmed path so the user gets a
// structured affordance for a link they shared.
// Parsed shape of a recognized code-host URL — covers PRs, issues, and
// commits across GitHub + GitLab. Everything else falls through to the
// generic favicon unfurl below.
type RichRef =
  | { kind: "gh-pr"; owner: string; repo: string; num: string }
  | { kind: "gh-issue"; owner: string; repo: string; num: string }
  | { kind: "gh-commit"; owner: string; repo: string; sha: string }
  | { kind: "gl-mr"; project: string; num: string }
  | { kind: "gl-issue"; project: string; num: string }
  | { kind: "gl-commit"; project: string; sha: string };

function parseRichLink(raw: string): RichRef | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "github.com") {
    // /<owner>/<repo>/pull/<num>, /issues/<num>, /commit/<sha>
    if (parts.length >= 4 && (parts[2] === "pull" || parts[2] === "issues")) {
      const num = parts[3];
      if (/^\d+$/.test(num)) {
        return parts[2] === "pull"
          ? { kind: "gh-pr", owner: parts[0], repo: parts[1], num }
          : { kind: "gh-issue", owner: parts[0], repo: parts[1], num };
      }
    }
    if (parts.length >= 4 && parts[2] === "commit") {
      const sha = parts[3];
      if (/^[a-f0-9]{7,40}$/i.test(sha)) {
        return { kind: "gh-commit", owner: parts[0], repo: parts[1], sha };
      }
    }
    return null;
  }
  if (host === "gitlab.com") {
    // /<group>/<project>/-/merge_requests/<num>  (project can have extra
    // namespace segments before "-")
    const dash = parts.indexOf("-");
    if (dash > 1 && parts.length > dash + 2) {
      const project = parts.slice(0, dash).join("/");
      const kind = parts[dash + 1];
      const tail = parts[dash + 2];
      if (kind === "merge_requests" && /^\d+$/.test(tail)) {
        return { kind: "gl-mr", project, num: tail };
      }
      if (kind === "issues" && /^\d+$/.test(tail)) {
        return { kind: "gl-issue", project, num: tail };
      }
      if (kind === "commit" && /^[a-f0-9]{7,40}$/i.test(tail)) {
        return { kind: "gl-commit", project, sha: tail };
      }
    }
    return null;
  }
  return null;
}

// Shape of the fetched preview — kept flat so the renderer doesn't
// care which host produced it.
type RichPreview = {
  title: string;
  state: string | null;        // "open" | "closed" | "merged" | "draft" | null
  author: string | null;
  author_avatar: string | null;
  // Commits use these instead of state/author:
  sha_short?: string;
  body_excerpt?: string;
  ref_label: string;           // "owner/repo#123", "abcd123 on owner/repo", etc.
};

// Cheap in-memory cache so the same URL pasted in several bubbles only
// hits the API once per session.
const richPreviewCache = new Map<string, Promise<RichPreview | null>>();

async function fetchRichPreview(ref: RichRef, raw: string): Promise<RichPreview | null> {
  if (richPreviewCache.has(raw)) return richPreviewCache.get(raw)!;
  const p = (async (): Promise<RichPreview | null> => {
    try {
      if (ref.kind === "gh-pr" || ref.kind === "gh-issue") {
        const path = ref.kind === "gh-pr" ? "pulls" : "issues";
        const res = await fetch(
          `https://api.github.com/repos/${ref.owner}/${ref.repo}/${path}/${ref.num}`,
          { headers: { Accept: "application/vnd.github+json" } },
        );
        if (!res.ok) return null;
        const j = await res.json();
        let state: string = j.state;
        if (ref.kind === "gh-pr") {
          if (j.merged) state = "merged";
          else if (j.draft) state = "draft";
        }
        return {
          title: String(j.title ?? ""),
          state,
          author: j.user?.login ?? null,
          author_avatar: j.user?.avatar_url ?? null,
          ref_label: `${ref.owner}/${ref.repo}#${ref.num}`,
        };
      }
      if (ref.kind === "gh-commit") {
        const res = await fetch(
          `https://api.github.com/repos/${ref.owner}/${ref.repo}/commits/${ref.sha}`,
          { headers: { Accept: "application/vnd.github+json" } },
        );
        if (!res.ok) return null;
        const j = await res.json();
        const msg: string = j.commit?.message ?? "";
        const [title, ...rest] = msg.split("\n");
        return {
          title: title || ref.sha.slice(0, 7),
          state: null,
          author: j.author?.login ?? j.commit?.author?.name ?? null,
          author_avatar: j.author?.avatar_url ?? null,
          sha_short: ref.sha.slice(0, 7),
          body_excerpt: rest.join("\n").trim().slice(0, 160),
          ref_label: `${ref.sha.slice(0, 7)} · ${ref.owner}/${ref.repo}`,
        };
      }
      // GitLab API requires a path-encoded project id; skip enrichment for
      // GitLab and just show the parsed ref nicely. The generic unfurl
      // still renders, so the user sees a labelled chip even without a fetch.
      if (ref.kind === "gl-mr" || ref.kind === "gl-issue") {
        return {
          title: ref.kind === "gl-mr" ? `Merge request !${ref.num}` : `Issue #${ref.num}`,
          state: null,
          author: null,
          author_avatar: null,
          ref_label: `${ref.project}${ref.kind === "gl-mr" ? `!${ref.num}` : `#${ref.num}`}`,
        };
      }
      if (ref.kind === "gl-commit") {
        return {
          title: `Commit ${ref.sha.slice(0, 7)}`,
          state: null,
          author: null,
          author_avatar: null,
          sha_short: ref.sha.slice(0, 7),
          ref_label: `${ref.sha.slice(0, 7)} · ${ref.project}`,
        };
      }
      return null;
    } catch {
      return null;
    }
  })();
  richPreviewCache.set(raw, p);
  return p;
}

function stateBadgeColor(state: string | null): { bg: string; fg: string; label: string } | null {
  if (!state) return null;
  switch (state) {
    case "open":
      return { bg: "rgba(46, 160, 67, 0.18)", fg: "rgb(46, 160, 67)", label: "Open" };
    case "closed":
      return { bg: "rgba(248, 81, 73, 0.18)", fg: "rgb(248, 81, 73)", label: "Closed" };
    case "merged":
      return { bg: "rgba(163, 113, 247, 0.20)", fg: "rgb(163, 113, 247)", label: "Merged" };
    case "draft":
      return { bg: "rgba(139, 148, 158, 0.20)", fg: "rgb(173, 186, 199)", label: "Draft" };
    default:
      return null;
  }
}

function LinkUnfurl({ url }: { url: string }) {
  const ref = useMemo(() => parseRichLink(url), [url]);
  const [preview, setPreview] = useState<RichPreview | null>(null);
  useEffect(() => {
    if (!ref) return;
    let cancelled = false;
    void fetchRichPreview(ref, url).then((p) => {
      if (!cancelled) setPreview(p);
    });
    return () => {
      cancelled = true;
    };
  }, [ref, url]);

  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname;
    path = `${u.pathname}${u.search}`;
    if (path === "/") path = "";
  } catch {
    return null;
  }

  // Rich preview path — GitHub/GitLab refs with metadata.
  if (ref && preview) {
    const badge = stateBadgeColor(preview.state);
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        onClick={onExternalAnchorClick}
        className="mt-1.5 flex items-start gap-2 px-3 py-2 rounded-md border border-line-soft bg-bg-2 hover:border-line max-w-[420px]"
      >
        {preview.author_avatar ? (
          <img
            src={preview.author_avatar}
            alt=""
            width={28}
            height={28}
            className="rounded-full flex-shrink-0"
          />
        ) : (
          <span className="w-7 h-7 flex items-center justify-center rounded bg-bg-1 text-text-3 text-xs flex-shrink-0">
            {ref.kind.startsWith("gh-commit") || ref.kind === "gl-commit" ? "⎇" : "#"}
          </span>
        )}
        <div className="min-w-0 leading-tight flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-text-4 text-[10.5px] truncate">{preview.ref_label}</span>
            {badge && (
              <span
                className="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide"
                style={{ background: badge.bg, color: badge.fg }}
              >
                {badge.label}
              </span>
            )}
          </div>
          <div className="text-text-1 text-[12px] font-medium truncate mt-0.5" title={preview.title}>
            {preview.title}
          </div>
          {preview.body_excerpt && (
            <div className="text-text-3 text-[10.5px] mt-0.5 line-clamp-2">
              {preview.body_excerpt}
            </div>
          )}
          {preview.author && !preview.body_excerpt && (
            <div className="text-text-4 text-[10.5px] mt-0.5">
              by {preview.author}
            </div>
          )}
        </div>
      </a>
    );
  }

  // Fallback — generic favicon chip (also shown while a rich preview is
  // still loading, which makes the embed feel instantly populated).
  const trimmedPath = path.length > 60 ? path.slice(0, 57) + "…" : path;
  const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      onClick={onExternalAnchorClick}
      className="mt-1.5 inline-flex items-center gap-2 px-2 py-1.5 rounded-md border border-line-soft bg-bg-2 hover:border-line max-w-[360px]"
    >
      <img
        src={favicon}
        alt=""
        width={16}
        height={16}
        className="rounded-sm flex-shrink-0"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
        }}
      />
      <div className="min-w-0 leading-tight">
        <div className="text-text-1 text-[11.5px] font-medium truncate">{host}</div>
        {trimmedPath && (
          <div className="text-text-4 text-[10.5px] truncate" title={trimmedPath}>
            {trimmedPath}
          </div>
        )}
      </div>
    </a>
  );
}
