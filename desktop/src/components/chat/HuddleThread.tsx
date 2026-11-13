// The huddle's thread — the column beside the call stage where what you
// type reaches everyone in the huddle and stays in the channel afterwards.
// Mounted by ScreenshareTab while the thread toggle is on.
//
// It re-reads the channel every three seconds (top-level messages only;
// thread replies belong to their own threads) and sends through the same
// chat call the channel uses. The rows are the shared-message rows the
// session room uses and the reply box is the chat's own composer.

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api, type ChatMessage } from "../../lib/api";
import { clockTimeFromSecs } from "../../lib/clockTime";
import { parseAttachments } from "./attachmentWire";
import { Avatar } from "../team/presentation/Avatar";
import { AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { ChatComposerArea, ChatEmpty, ChatTranscript } from "../ui/chat-surface";
import { Composer } from "../ui/composer";
import { ErrorNote } from "../ui/state";
import "../ui/cloud-patterns.css";
import "../ui/session-room.css";
import "../ui/call-stage.css";

type ThreadError = { what: "sync" | "send"; why: string };

export function HuddleThread({
  repoRoot,
  channel,
  onClose,
}: {
  repoRoot: string;
  channel: string;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ThreadError | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    try {
      const rows = await api.chatList(repoRoot, channel, undefined, 60);
      setMessages(rows.filter((message) => !message.thread_parent));
      setError((prev) => (prev?.what === "sync" ? null : prev));
    } catch (reason) {
      setError({ what: "sync", why: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  // Channel identity defines the lifetime of this huddle thread.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, channel]);

  // Follow the newest message. Keyed on the last id, not the count: the
  // read is capped at 60, so once a channel is past that the count stops
  // changing while new messages keep arriving.
  const lastId = messages.length ? messages[messages.length - 1].id : null;
  useEffect(() => {
    const node = scrollerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lastId]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const message = await api.chatSend({ repoRoot, channel, body });
      setMessages((rows) => [...rows, message]);
      setDraft("");
      setError(null);
    } catch (reason) {
      setError({ what: "send", why: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="ui-call-thread" aria-label="Huddle thread">
      <header className="ui-call-thread-header">
        <strong>Thread</strong>
        <Button variant="ghost" size="iconXs" onClick={onClose} aria-label="Close huddle thread" title="Close thread">
          <X size={14} />
        </Button>
      </header>
      <ChatTranscript ref={scrollerRef} className="ui-call-thread-messages">
        <ChatEmpty
          title="Every huddle has a thread."
          description={
            <>
              What you send here reaches everyone in the huddle and is saved in <b>#{channel}</b>, so it’s still there
              after the huddle ends.
            </>
          }
        />
        {messages.slice(-18).map((message) => {
          const body = parseAttachments(message.body).text;
          const who = message.from_name || message.from_handle;
          const time = clockTimeFromSecs(message.ts);
          return (
            <div key={message.id} className="ui-shared-message ui-session-message" aria-label={`Message from ${who}`}>
              <header>
                <span className="ui-cloud-avatar ui-cloud-avatar-static ui-session-message-face" role="img" aria-label={who} title={who}>
                  <Avatar name={who} size={24} />
                </span>
                <span>{who}</span>
                <time>{time}</time>
              </header>
              <div>
                <div className="ui-session-message-meta">
                  <strong>{who}</strong>
                  <time>{time}</time>
                </div>
                {body || "Shared an attachment"}
              </div>
            </div>
          );
        })}
      </ChatTranscript>
      <ChatComposerArea className="ui-call-thread-reply">
        {error && (
          <ErrorNote>
            <AlertTitle>{error.what === "send" ? "Couldn’t send that reply." : "Couldn’t sync the huddle thread."}</AlertTitle>
            <AlertDescription>{error.why}</AlertDescription>
          </ErrorNote>
        )}
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          sendDisabled={!draft.trim() || sending}
          placeholder="Reply…"
          ariaLabel="Reply in the huddle thread"
          footer={<span className="ui-call-thread-note">Huddle notes are shared with everyone in this channel</span>}
        />
      </ChatComposerArea>
    </aside>
  );
}
