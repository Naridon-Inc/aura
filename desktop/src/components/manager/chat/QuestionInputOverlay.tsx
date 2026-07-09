//! Full-dock question overlay — the prominent answer surface for a brain's
//! `ask_user` call.
//!
//! `QuestionCard` is the compact docked card; this is its taller sibling for
//! when the question deserves the user's full attention: the prompt reads as a
//! heading at the top, and a roomy multi-line input sits below with its own
//! Send CTA. Choice / multi-choice questions still flow through `QuestionCard`
//! (its keyboard-driven option rows are the right affordance there) — this
//! overlay specializes the free-text case, where a one-line input was cramped.
//!
//! Mounted in the `.p-dock` in place of the inline card when
//! `session.pending_question` is a `text` question and no turn is mid-flight.
//! Esc skips, ⌘/Ctrl+Enter (or the button) submits. Tokens only.

import { useCallback, useEffect, useRef, useState } from "react";

import { api, type PendingQuestion } from "../../../lib/api";
import { Button } from "../../ui/button";
import { QuestionBubbleGlyph, KbdHint } from "./QuestionCard";

/** Tall free-text answer surface for a pending `text` question. For choice /
 *  multi-choice the parent renders `QuestionCard` instead. */
export function QuestionInputOverlay({
  sessionId,
  question,
  onError,
  onAnswered,
}: {
  sessionId: string;
  question: PendingQuestion;
  onError: (msg: string) => void;
  /** Fires before the API call so the parent can flip its post-answer busy
   *  state. The persisted Q+A renders from `session.chat` on the next snapshot. */
  onAnswered?: () => void;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Focus + auto-grow the input on mount so the user can type immediately.
  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      ta.style.height = "0px";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    }
  }, []);

  const submit = useCallback(
    async (answer: string) => {
      if (submitting) return;
      const trimmed = answer.trim();
      if (!trimmed) return;
      setSubmitting(true);
      onAnswered?.();
      try {
        await api.managerAnswerQuestion(sessionId, question.tool_use_id, trimmed);
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
        setSubmitting(false);
      }
    },
    [submitting, sessionId, question.tool_use_id, onError, onAnswered],
  );

  const skip = useCallback(() => {
    if (submitting) return;
    setSubmitting(true);
    onAnswered?.();
    api
      .managerAnswerQuestion(sessionId, question.tool_use_id, "(skipped)")
      .catch((e) => {
        onError(e instanceof Error ? e.message : String(e));
        setSubmitting(false);
      });
  }, [submitting, sessionId, question.tool_use_id, onAnswered, onError]);

  return (
    <div
      className="w-full flex flex-col overflow-hidden"
      style={{
        background: "var(--color-bg-1)",
        border: "1px solid var(--color-line)",
        borderRadius: "var(--radius-md)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
      }}
    >
      <div
        className="flex items-center gap-1.5 px-3.5 pt-3 pb-2 t-sm t-ui"
        style={{ color: "var(--color-text-2)" }}
      >
        <QuestionBubbleGlyph />
        <span>Aura is asking</span>
      </div>
      <div className="px-3.5 pb-3 flex flex-col gap-3">
        <div
          className="t-base t-heading"
          style={{ color: "var(--color-text-1)" }}
        >
          {question.question}
        </div>
        <textarea
          ref={taRef}
          value={text}
          disabled={submitting}
          placeholder="Type your answer…"
          rows={2}
          onChange={(e) => {
            setText(e.target.value);
            const ta = e.currentTarget;
            ta.style.height = "0px";
            ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit(text);
            } else if (e.key === "Escape") {
              e.preventDefault();
              skip();
            }
          }}
          className="w-full resize-none outline-none px-2.5 py-2 t-base no-scrollbar focus:border-[var(--color-accent)] transition-colors"
          style={{
            background: "var(--color-bg-0)",
            border: "1px solid var(--color-line-soft)",
            borderRadius: "var(--radius-sm)",
            color: "var(--color-text-1)",
            maxHeight: 200,
          }}
        />
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={skip}
            className="inline-flex items-center t-sm t-ui px-1 disabled:opacity-50 transition-colors hover:text-[var(--color-text-2)]"
            style={{ color: "var(--color-text-3)" }}
          >
            Skip
            <KbdHint label="Esc" />
          </button>
          <Button
            type="button"
            size="sm"
            variant="accentSoft"
            disabled={submitting || !text.trim()}
            onClick={() => void submit(text)}
          >
            {submitting ? "Sending…" : "Send"}
            <KbdHint label="⌘⏎" />
          </Button>
        </div>
      </div>
    </div>
  );
}
