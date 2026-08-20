// Somebody else's session, open in a tab of yours.
//
// This is the room a guest actually stands in. Until it existed, joining was a
// door with nothing behind it: `joinSession` opened the socket, the share
// surface closed itself, and every piece built to render what came down that
// socket — the transcript, the composer, the access banner — was mounted
// nowhere. You could be a participant in a session and have no way to read it.
//
// What a guest needs, in the order they need it:
//
//  1. **Whose machine this is.** Their words end up on someone else's computer,
//     driving an agent with write access to someone else's repo. That is the
//     first thing said, not a footnote (`YourAccessBanner`).
//  2. **What may they do.** Watching and driving are different rooms wearing
//     the same furniture; the composer is live in one and inert in the other.
//  3. **What's being said.** One ordered stream, agent output and people
//     together — see SessionStream for why they are not two feeds.
//  4. **Where the host's ports are.** A session about a web app is unreadable
//     without the page it renders; the chips open the host's localhost through
//     the relay.
//
// Nothing here is fetched. Every field is the live state the socket is already
// maintaining, so this pane cannot disagree with the participants strip on a
// terminal a few tabs over — they read the same store.
//
// Leaving is the one destructive thing in here, so it is a button and never a
// side effect of unmounting: closing the tab keeps you in the session (the
// transcript stays warm and the tab re-opens full), and only "Leave" drops the
// socket. See `leaveSharedSession`.

import { useCallback, useMemo, useState, type JSX } from "react";

import { openExternal } from "../../lib/openExternal";
import type { Participant } from "../../lib/sessionLive";
import {
  leaveSession,
  sendSessionMessage,
  setSessionTyping,
  useSessionLive,
} from "../../lib/sessionLiveStore";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { fromMsgFrame, mergeSessionStream } from "./collabTypes";
import { ParticipantsStrip } from "./ParticipantsStrip";
import { SessionComposer, type SessionDraft } from "./SessionComposer";
import { SessionStream } from "./SessionStream";
import { SessionTypingLine } from "./SessionTypingLine";
import { TunnelChip } from "./share/TunnelChip";
import { YourAccessBanner } from "./share/YourAccessBanner";

export type LiveSessionPaneProps = {
  /** The session's external id — what the share link carries and what the
   *  store is keyed by. */
  sessionId: string;
  /** Close this tab. Leaving the session is a separate, deliberate act. */
  onClose: () => void;
};

export function LiveSessionPane({
  sessionId,
  onClose,
}: LiveSessionPaneProps): JSX.Element {
  const live = useSessionLive(sessionId);
  const [addressed, setAddressed] = useState<Participant | null>(null);

  const youId = live.you?.id ?? null;
  const host = live.participants.find((p) => p.role === "host") ?? null;
  const access = live.you?.access ?? "watch";
  const isHost = live.role === "host";

  // The store keeps the wire's own `msg` frames; the stream renders the
  // narrower `SessionMessage`. This conversion is the seam between the two,
  // and it lives here rather than in the store because the store's shape is
  // the protocol's and should stay that way.
  const items = useMemo(
    () => mergeSessionStream(live.entries, live.messages.map(fromMsgFrame)),
    [live.entries, live.messages],
  );

  const typing = useMemo(
    () => live.participants.filter((p) => p.kind === "human" && live.typing.has(p.id)),
    [live.participants, live.typing],
  );
  // "Working" is this line's word, not the protocol's. An agent's states are
  // coding / instructing / talking / watching / idle; the first two are the
  // ones where it is doing something on its own account and the room should
  // wait for it. `talking` is deliberately out — an agent mid-reply already
  // shows up as its message, and counting it here would print "working…" under
  // the thing it just said.
  const working = useMemo(
    () =>
      live.participants.filter(
        (p) => p.kind === "agent" && (p.state === "coding" || p.state === "instructing"),
      ),
    [live.participants],
  );

  const connecting = live.connection === "connecting" && live.participants.length === 0;
  // A dropped socket looks exactly like a quiet room. Say which it is.
  const failed = live.connection === "error" ? (live.lastError ?? "Lost this session.") : null;

  const onSend = useCallback(
    async (draft: SessionDraft) => {
      const ok = await sendSessionMessage(sessionId, {
        text: draft.text,
        to: draft.to,
        intent: draft.intent,
        replyTo: draft.reply_to,
      });
      // Throwing is how the composer knows to keep the text and show why.
      if (!ok) throw new Error(live.lastError ?? "That didn’t reach the session.");
      setAddressed(null);
    },
    [sessionId, live.lastError],
  );

  const onTypingChange = useCallback(
    (on: boolean) => {
      void setSessionTyping(sessionId, on);
    },
    [sessionId],
  );

  const onLeave = useCallback(() => {
    void leaveSession(sessionId);
    onClose();
  }, [sessionId, onClose]);

  // The chip knows a port and nothing else — deliberately, so it can't leak a
  // relay URL. Resolving one to the other is this pane's job.
  const onOpenPort = useCallback(
    (port: number) => {
      const t = live.tunnels?.find((x) => x.port === port);
      if (t) void openExternal(t.url);
    },
    [live.tunnels],
  );

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg-0">
      {/* Who is in here. The tab strip already carries what this session is
          about, so this row does not repeat it — it carries only what changes
          while you sit here. */}
      <div className="flex items-center gap-2 h-8 px-3 border-b border-line shrink-0">
        <ParticipantsStrip
          participants={live.participants}
          youId={youId}
          max={6}
          loading={connecting}
          error={failed}
          onSelect={setAddressed}
        />

        <div className="flex-1" />

        {live.connection === "reconnecting" && (
          <span className="flex items-center gap-1.5 text-2xs text-text-3">
            <AsciiSpinner size={11} />
            Reconnecting
          </span>
        )}

        <button
          type="button"
          onClick={onLeave}
          className="px-2 h-5 rounded text-2xs text-text-3 hover:text-text-1 hover:bg-bg-2 transition-colors"
          title={
            isHost
              ? "Stop taking part in this session. It stays shared. The link still works."
              : "Leave this session. You can walk back in with the same link."
          }
        >
          Leave
        </button>
      </div>

      {/* Only a guest gets this. A host reading "your words reach someone
          else's computer" about their own machine is noise, and it is the one
          sentence in the app that must never become noise. */}
      {!isHost && (
        <div className="px-3 pt-2 shrink-0">
          <YourAccessBanner
            level={access}
            hostName={host?.name ?? "the host"}
            hostMachine={live.hostMachine ?? "their machine"}
            hostOnline={live.hostOnline}
          />
        </div>
      )}

      {/* The host's ports, when they opened any. `null` means nobody has asked
          the desktop yet, which is not the same as "none open" — so nothing is
          drawn for it rather than an empty row implying a checked-and-empty
          answer. */}
      {live.tunnels && live.tunnels.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap px-3 pt-2 shrink-0">
          <span className="text-2xs text-text-4">Open on their machine</span>
          {live.tunnels.map((t) => (
            <TunnelChip
              key={t.code}
              port={t.port}
              label={t.label}
              status="open"
              onOpen={onOpenPort}
            />
          ))}
        </div>
      )}

      {/* The stream owns no scroller of its own (it scrolls its last row into
          view), so the scroll box is here. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
        <SessionStream
          items={items}
          participants={live.participants}
          youId={youId}
          loading={connecting}
          error={failed}
        />
      </div>

      <div className="shrink-0 px-3 pb-2">
        <SessionTypingLine
          typing={typing}
          working={working}
          participants={live.participants}
          youId={youId}
        />
        <SessionComposer
          participants={live.participants}
          youId={youId}
          onSend={onSend}
          onTypingChange={onTypingChange}
          hostOnline={live.hostOnline}
          loading={connecting}
          error={failed}
          addressed={addressed}
          // A watcher's message never reaches the agent. The box says so
          // rather than accepting the keystrokes and dropping them.
          disabled={access === "watch"}
        />
      </div>
    </div>
  );
}
