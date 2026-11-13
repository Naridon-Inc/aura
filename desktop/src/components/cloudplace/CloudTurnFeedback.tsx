// What hangs under each turn of a shared workspace: the turn's threads,
// folded to one line until opened, and "Comment" in the turn's ⋯ menu. The
// workspace provides the room (its comments, who you are, who can be
// mentioned, whether you can prompt its agent); each turn reads it by the
// turn's id. The same parts hang under the turns of a machine chat on the
// laptop driving it, for the turns this laptop can name; there "Comment"
// joins the menu the turn already has.

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { MessageSquare, MoreHorizontal } from "lucide-react";

import type { CommentDto } from "../../lib/cloudFeedbackApi";
import {
  CommentBox,
  CommentThread,
  ThreadFold,
  type CommentHandlers,
  type CommentView,
  type ThreadView,
} from "../ui/cloud-comments";
import { Button } from "../ui/button";
import type { CloudMember } from "../ui/cloud-workspace";
import type { ComposerSuggestion } from "../ui/composer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import type { TurnAction } from "../ui/transcript-patterns";
import { relTime } from "../workspaces/workspacesModel";
import {
  commentCount,
  isOwn,
  isResolved,
  saidLine,
  threadLine,
  threadsOf,
  turnIdOf,
  turnIdsByKey,
  type FeedbackState,
  type KeyedTurn,
  type Thread,
} from "./cloudFeedback";
import { TurnSideContext } from "./CloudTurn";
import type { FeedbackActions } from "./useWorkspaceFeedback";

export type FeedbackRoom = {
  state: FeedbackState;
  threads: ReturnType<typeof threadsOf>;
  actions: FeedbackActions;
  me: string | null;
  members: readonly CloudMember[];
  /** Teammates offered after "@". */
  suggestions: ComposerSuggestion[];
  /** Why nothing can be added here (an archived workspace), else null. */
  closed: string | null;
  /** Hand a comment to the agent's prompt box; null for whoever can't
   *  prompt this chat. */
  sendToAgent: ((text: string) => void) | null;
  /** "Claude", "Codex" or "the agent". */
  agentName: string;
  /** The turns whose threads are open. */
  open: ReadonlySet<string>;
  setOpen: (messageId: string, open: boolean, compose?: boolean) => void;
  /** The turn whose new-comment box takes the keyboard. */
  composing: string | null;
  /** A turn of this laptop's copy of a machine chat, as the cloud names it. */
  idOf: (turn: KeyedTurn) => string | null;
};

const Room = createContext<FeedbackRoom | null>(null);

export function FeedbackRoomProvider({ room, children }: { room: FeedbackRoom | null; children: ReactNode }) {
  return <Room.Provider value={room}>{children}</Room.Provider>;
}

export const useFeedbackRoom = () => useContext(Room);

/** The room a workspace keeps for its turns. */
export function useRoom({
  state,
  actions,
  me,
  members,
  suggestions,
  closed,
  sendToAgent,
  agentName,
  kept,
}: Pick<FeedbackRoom, "state" | "actions" | "me" | "members" | "suggestions" | "closed" | "sendToAgent" | "agentName"> & {
  /** Turn key → cloud id, from what this laptop's relay kept. */
  kept?: Readonly<Record<string, string>>;
}): FeedbackRoom {
  const [open, setOpenSet] = useState<ReadonlySet<string>>(new Set());
  const [composing, setComposing] = useState<string | null>(null);
  const setOpen = useCallback((messageId: string, on: boolean, compose = false) => {
    setOpenSet((s) => {
      if (s.has(messageId) === on) return s;
      const next = new Set(s);
      if (on) next.add(messageId);
      else next.delete(messageId);
      return next;
    });
    setComposing(on && compose ? messageId : null);
  }, []);
  const threads = useMemo(() => threadsOf(state.comments), [state.comments]);
  const ids = useMemo(() => turnIdsByKey(state, kept), [state, kept]);
  const idOf = useCallback((turn: KeyedTurn) => turnIdOf(turn, ids), [ids]);
  return {
    state,
    threads,
    actions,
    me,
    members,
    suggestions,
    closed,
    sendToAgent,
    agentName,
    open,
    setOpen,
    composing,
    idOf,
  };
}

// ── Comments as the screen draws them ──────────────────────────────────────

const GONE_COLOR = "#6b6b6b";
const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

function authorOf(c: CommentDto, members: readonly CloudMember[], me: string | null) {
  const m = c.author_id ? members.find((x) => x.id === c.author_id) : undefined;
  if (m) return { name: me && m.id === me ? "You" : m.name, initials: m.initials, color: m.color, photo: m.photo };
  const name = c.author_name?.trim() || "Someone no longer in this team";
  return { name, initials: initialsOf(name), color: GONE_COLOR };
}

/** Who wrote it, by name, for "Priya said: …". */
function writerName(c: CommentDto, members: readonly CloudMember[]): string | null {
  const m = c.author_id ? members.find((x) => x.id === c.author_id) : undefined;
  return m?.name ?? c.author_name ?? null;
}

export function commentView(c: CommentDto, members: readonly CloudMember[], me: string | null): CommentView {
  return {
    id: c.id,
    author: authorOf(c, members, me),
    when: relTime(Math.floor(Date.parse(c.created_at) / 1000), Date.now()),
    edited: !!c.edited_at && !c.deleted,
    deleted: c.deleted,
    body: c.body,
    own: isOwn(c, me),
  };
}

export function threadView(t: Thread, members: readonly CloudMember[], me: string | null): ThreadView {
  return {
    id: t.root.id,
    root: commentView(t.root, members, me),
    replies: t.replies.map((r) => commentView(r, members, me)),
    resolved: isResolved(t),
  };
}

/** What a thread's comments can do, for this room. */
export function handlersOf(room: FeedbackRoom): CommentHandlers {
  const send = room.sendToAgent;
  return {
    onEdit: room.actions.edit,
    onDelete: room.actions.remove,
    sendLabel: `Send to ${room.agentName}`,
    onSendToAgent: send
      ? (c) => {
          const dto = room.state.comments[c.id];
          if (dto) send(saidLine(writerName(dto, room.members), dto.body));
        }
      : undefined,
  };
}

/** One thread, wired to the room. */
export function RoomThread({ t, above }: { t: Thread; above?: ReactNode }) {
  const room = useFeedbackRoom();
  if (!room) return null;
  return (
    <CommentThread
      t={threadView(t, room.members, room.me)}
      suggestions={room.suggestions}
      handlers={handlersOf(room)}
      onReply={(parentId, body) => room.actions.comment({ parentId }, body)}
      onResolve={room.actions.resolve}
      onReopen={room.actions.reopen}
      above={above}
    />
  );
}

// ── Under one turn ─────────────────────────────────────────────────────────

/** "Comment" in a turn's ⋯ menu: opens the turn's threads with a new-comment
 *  box that takes the keyboard. Greyed out once the workspace stops taking
 *  comments. */
export function commentAction(room: FeedbackRoom, messageId: string): TurnAction {
  return {
    label: "Comment",
    icon: <MessageSquare />,
    disabled: !!room.closed,
    onSelect: () => room.setOpen(messageId, true, true),
  };
}

/** "Comment" for a turn of this laptop's copy of a machine chat, for a menu
 *  the turn already has; null when the cloud has no copy of the turn this
 *  laptop can name. */
export function useTurnComment(turn: KeyedTurn): TurnAction | null {
  const room = useFeedbackRoom();
  const id = room?.idOf(turn) ?? null;
  return room && id ? commentAction(room, id) : null;
}

/** A turn's ⋯ menu, for a turn that has none of its own. Each choice runs once
 *  the menu has closed, so a box it opens keeps the keyboard. */
export function TurnMenu({ actions, size = "iconXs" }: { actions: TurnAction[]; size?: "iconXs" | "icon-sm" }) {
  const side = useContext(TurnSideContext);
  const after = useRef<(() => void) | undefined>(undefined);
  if (!actions.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={size} variant="ghost" aria-label="Message actions" className="ui-turn-menu">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align={side === "end" ? "end" : "start"}
        onCloseAutoFocus={(e) => {
          const run = after.current;
          after.current = undefined;
          if (!run) return;
          e.preventDefault();
          queueMicrotask(run);
        }}
      >
        {actions.map((a) => (
          <DropdownMenuItem
            key={a.label}
            disabled={a.disabled}
            onSelect={() => {
              after.current = a.onSelect;
            }}
          >
            {a.icon}
            {a.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TurnFeedback({
  messageId,
  menu = true,
}: {
  messageId: string;
  /** Draw the turn's own ⋯ with "Comment" in it. False where the turn
   *  already has a ⋯ that offers it. */
  menu?: boolean;
}) {
  const room = useFeedbackRoom();
  const [showResolved, setShowResolved] = useState(false);
  // With a thread already open, a new one starts from a button, so the
  // turn shows one box at a time.
  const [starting, setStarting] = useState(false);
  if (!room) return null;
  const { me } = room;
  const threads = room.threads.byTurn[messageId] ?? [];
  const open = room.open.has(messageId);
  const live = threads.filter((t) => !isResolved(t));
  const done = threads.filter(isResolved);
  const count = commentCount(threads);
  // "Comment" from a menu asks for a new thread even when the turn has some.
  const composing = starting || room.composing === messageId;
  const settle = () => {
    setStarting(false);
    if (room.composing === messageId) room.setOpen(messageId, true);
  };
  // The ⋯ shows while the pointer or the keyboard is on the turn: floating at
  // the bubble's corner when the turn has no comments, beside the folded
  // thread's line when it has some. Open threads have their own box, so the
  // ⋯ steps aside.
  const place = open ? null : count > 0 ? "inline" : "float";
  return (
    <>
      {/* Also where a notification scrolls to. */}
      <div
        className="ui-feedback-bar"
        data-feedback-for={messageId}
        data-place={place ?? undefined}
        hidden={!menu || !place || undefined}
      >
        {menu && <TurnMenu actions={[commentAction(room, messageId)]} />}
      </div>
      {!open && count > 0 && (
        <div className="ui-feedback-folded">
          <ThreadFold line={threadLine(threads, me)} open={false} onToggle={() => room.setOpen(messageId, true)} />
        </div>
      )}
      {open && (
        <div className="ui-feedback-threads">
          {count > 0 && <ThreadFold line={threadLine(threads, me)} open onToggle={() => room.setOpen(messageId, false)} />}
          {live.map((t) => (
            <RoomThread key={t.root.id} t={t} />
          ))}
          {done.length > 0 && (
            <ThreadFold
              line={`${done.length} resolved ${done.length === 1 ? "thread" : "threads"}`}
              open={showResolved}
              onToggle={() => setShowResolved(!showResolved)}
            />
          )}
          {showResolved && done.map((t) => <RoomThread key={t.root.id} t={t} />)}
          {!room.closed &&
            (live.length === 0 || composing ? (
              <CommentBox
                key={`new-${messageId}`}
                placeholder={live.length ? "Start another thread" : "Comment, or @mention a teammate"}
                suggestions={room.suggestions}
                autoFocus={composing}
                onCancel={() => (live.length ? settle() : room.setOpen(messageId, false))}
                onSubmit={async (body) => {
                  const ok = await room.actions.comment({ messageId }, body);
                  if (ok) settle();
                  return ok;
                }}
              />
            ) : (
              <button type="button" className="ui-thread-reply" onClick={() => setStarting(true)}>
                Start another thread
              </button>
            ))}
        </div>
      )}
    </>
  );
}

/** Under a turn of this laptop's copy of a machine chat: nothing unless the
 *  cloud has a copy of the turn this laptop can name. */
export function KeyedTurnFeedback({ turn, menu = true }: { turn: KeyedTurn; menu?: boolean }) {
  const room = useFeedbackRoom();
  const id = room?.idOf(turn) ?? null;
  if (!id) return null;
  return (
    <div className="ui-feedback-turn-actions">
      <TurnFeedback messageId={id} menu={menu} />
    </div>
  );
}

/** Around a turn of a chat: in a machine chat shared through a workspace, the
 *  turn with its comments under it; anywhere else, the turn alone. */
export function FeedbackFrame({
  turn,
  role,
  menu = true,
  children,
}: {
  turn: KeyedTurn;
  role: "user" | "assistant";
  /** Draw a ⋯ with "Comment" under the turn. False where the turn's own ⋯
   *  offers it (see {@link useTurnComment}). */
  menu?: boolean;
  children: ReactNode;
}) {
  const room = useFeedbackRoom();
  if (!room) return <>{children}</>;
  // A machine chat's prompts are this laptop's own: on the right.
  const side = role === "user" ? "end" : "start";
  return (
    <div className="ui-feedback-turn" data-role={role} data-side={side}>
      {children}
      <TurnSideContext.Provider value={side}>
        <KeyedTurnFeedback turn={turn} menu={menu} />
      </TurnSideContext.Provider>
    </div>
  );
}
