// SessionComposer — the one box, now that it has more than one destination.
//
// Everything a shared session can do is reachable from here: the addressing
// bar says where the next message goes and changes it, "@" picks a recipient
// mid-sentence, and hand-over is a pick rather than a mode. Sending is the
// same Enter it has always been.
//
// The box is the chat's composer, not a lookalike: the addressing bar rides
// in its context line, and the "@" list opens where the chat's opens.

import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEvent, JSX, KeyboardEvent } from "react";

import type { MsgIntent, Participant } from "../../lib/sessionLive";
import { Button } from "../ui/button";
import { Composer } from "../ui/composer";
import { ErrorNote, LoadingState } from "../ui/state";
import { ComposerAddressingBar, coerceIntent } from "./ComposerAddressingBar";
import { MentionPicker, mentionQueryAt } from "./MentionPicker";
import { mentionHandle } from "./collabPresence";
import "../ui/session-room.css";

/** A client→server `msg` frame, minus the parts the server stamps. */
export type SessionDraft = {
  to: string | null;
  text: string;
  intent: MsgIntent;
  reply_to: string | null;
};

export type SessionComposerProps = {
  participants: readonly Participant[];
  youId: string | null;
  /** Rejecting the promise surfaces the failure inline; the text is kept. */
  onSend: (draft: SessionDraft) => void | Promise<void>;
  onTypingChange?: (on: boolean) => void;
  /** Set when replying inside a thread. */
  replyTo?: string | null;
  /** The desktop that runs the agent is connected. */
  hostOnline?: boolean;
  disabled?: boolean;
  /** Session socket still opening. */
  loading?: boolean;
  /** Plain-language connection failure, shown instead of the addressing bar. */
  error?: string | null;
  /** Pre-address the box — clicking a face in the participants strip. */
  addressed?: Participant | null;
  placeholder?: string;
};

const TYPING_PULSE_MS = 3000;
const TYPING_IDLE_MS = 4000;

export function SessionComposer({
  participants,
  youId,
  onSend,
  onTypingChange,
  replyTo = null,
  hostOnline = true,
  disabled = false,
  loading = false,
  error = null,
  addressed = null,
  placeholder,
}: SessionComposerProps): JSX.Element {
  const [text, setText] = useState("");
  const [to, setTo] = useState<Participant | null>(addressed);
  const [intent, setIntent] = useState<MsgIntent>(coerceIntent(addressed, "chat"));
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const pulsedAt = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A click on a face in the strip re-addresses the box under the cursor.
  useEffect(() => {
    if (!addressed) return;
    setTo(addressed);
    setIntent((cur) => coerceIntent(addressed, cur));
    boxRef.current?.focus();
  }, [addressed]);

  // A recipient who leaves mid-draft can't receive anything — fall back to
  // the room rather than silently addressing a ghost.
  useEffect(() => {
    if (to && !participants.some((p) => p.id === to.id)) {
      setTo(null);
      setIntent((cur) => coerceIntent(null, cur));
    }
  }, [participants, to]);

  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [],
  );

  const pulseTyping = useCallback(() => {
    if (!onTypingChange) return;
    const now = Date.now();
    if (now - pulsedAt.current > TYPING_PULSE_MS) {
      pulsedAt.current = now;
      onTypingChange(true);
    }
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      pulsedAt.current = 0;
      onTypingChange(false);
    }, TYPING_IDLE_MS);
  }, [onTypingChange]);

  const stopTyping = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    pulsedAt.current = 0;
    onTypingChange?.(false);
  }, [onTypingChange]);

  const syncMention = useCallback((value: string, caret: number) => {
    setMention(mentionQueryAt(value, caret));
  }, []);

  const pickMention = useCallback(
    (p: Participant, picked: MsgIntent) => {
      const span = mention;
      setTo(p);
      setIntent(coerceIntent(p, picked));
      setMention(null);
      if (span) {
        const handle = mentionHandle(p, participants);
        const head = text.slice(0, span.start);
        const tail = text.slice(span.start + 1 + span.query.length);
        const next = `${head}@${handle} ${tail.replace(/^ /, "")}`;
        setText(next);
        const caret = head.length + handle.length + 2;
        requestAnimationFrame(() => {
          boxRef.current?.focus();
          boxRef.current?.setSelectionRange(caret, caret);
        });
      } else {
        boxRef.current?.focus();
      }
    },
    [mention, participants, text],
  );

  const send = useCallback(async () => {
    const body = text.trim();
    if (!body || sending || disabled) return;
    setSending(true);
    setSendError(null);
    try {
      await onSend({ to: to?.id ?? null, text: body, intent, reply_to: replyTo });
      setText("");
      setMention(null);
      stopTyping();
      // Handing a thread over is a one-shot act; staying in "hand it over"
      // would re-hand the next line you type.
      if (intent === "handoff") setIntent(coerceIntent(to, "chat"));
    } catch (e) {
      setSendError(
        e instanceof Error && e.message ? e.message : "Couldn't send that. Try again.",
      );
    } finally {
      setSending(false);
    }
  }, [text, sending, disabled, onSend, to, intent, replyTo, stopTyping]);

  // The picker takes Enter / Tab / Escape before the box sees them; this only
  // stops a stray Enter from sending while it is open.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && e.key === "Enter") e.preventDefault();
  };

  const ready = !disabled && !loading && !error;

  const fromBox = (e: { target: EventTarget }) => e.target === boxRef.current;

  return (
    <div
      className="ui-session-composer"
      onKeyUp={(e) => {
        if (!fromBox(e)) return;
        const el = e.target as HTMLTextAreaElement;
        syncMention(el.value, el.selectionStart ?? el.value.length);
      }}
      onBlur={(e: FocusEvent<HTMLDivElement>) => {
        if (!fromBox(e)) return;
        stopTyping();
        // The picker listens for Enter on the whole window. Left open after
        // the box loses focus, an Enter pressed anywhere else would quietly
        // re-address the message.
        setMention(null);
      }}
    >
      {mention && ready && (
        <MentionPicker
          participants={participants}
          youId={youId}
          query={mention.query}
          onPick={pickMention}
          onClose={() => setMention(null)}
        />
      )}

      <Composer
        value={text}
        onChange={(next) => {
          setText(next);
          syncMention(next, boxRef.current?.selectionStart ?? next.length);
          pulseTyping();
        }}
        onSend={() => void send()}
        disabled={disabled || !!error}
        sendDisabled={!ready || sending}
        placeholder={placeholder ?? "Type a message. @ to pick who it's for"}
        ariaLabel="Message to this session"
        textareaRef={boxRef}
        onKeyDown={onKeyDown}
        context={
          <ComposerAddressingBar
            participants={participants}
            youId={youId}
            to={to}
            intent={intent}
            hostOnline={hostOnline}
            disabled={disabled || sending}
            loading={loading}
            error={error}
            onChange={(nextTo, nextIntent) => {
              setTo(nextTo);
              setIntent(nextIntent);
              boxRef.current?.focus();
            }}
          />
        }
        actions={sending ? <LoadingState label="Sending" className="ui-session-sending" /> : undefined}
      />

      {sendError && (
        <ErrorNote className="ui-session-send-error">
          <span>{sendError}</span>
          <Button variant="outline" size="xs" onClick={() => void send()}>
            Try again
          </Button>
        </ErrorNote>
      )}
    </div>
  );
}
