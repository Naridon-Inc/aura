//! Interactive question-to-user card for the native Aura agentic chat.
//!
//! When the brain calls its `ask_user` tool, the session carries a
//! `pending_question` and we render this card docked above the composer.
//! The card is fully keyboard-driven (1/2/3… pick or toggle, Enter submits,
//! Esc skips) and posts the answer back through `managerAnswerQuestion`,
//! which resolves the bridge waiter that the blocked CLI brain is parked on.
//!
//! The brain may club a SET of 1–4 related questions into one `ask_user`
//! call (Claude `AskUserQuestion` shape). When `question.items` carries more
//! than one entry the card stacks them — each with its own header chip,
//! options/text and custom escape hatch — and a single Continue joins the
//! per-question answers into one reply, so the brain can ask another set next
//! turn if it still needs more. A single question (or the CLI bridge, which
//! always asks one) renders exactly as it always did.
//!
//! Visual language: a calm prompt header, numbered option rows that read as a
//! set (default on bg-1/line, hover bg-2, selected = accent ring + faint accent
//! tint), mono 1/2/3 key badges, keyboard hints, and a primary submit CTA.
//!
//! `docked` fuses the card onto the composer below it: the card rounds only its
//! top, keeps a single hairline as the divider, and the composer (passed the
//! same flag) rounds only its bottom and drops its top border — so the question
//! and the input read as one stacked panel, the way Cursor docks its questions
//! as an extension of the composer rather than a card floating in the stream.

import { useCallback, useEffect, useMemo, useState } from "react";

import { api, type PendingQuestion, type QuestionItem } from "../../../lib/api";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Kbd } from "../../ui/kbd";

/** A..Z then AA, AB, … — kept exported for the inline transcript record and
 *  any other surface that still labels options by letter. */
export function indexLetter(i: number): string {
  if (i < 26) return String.fromCharCode(65 + i);
  const a = Math.floor(i / 26) - 1;
  const b = i % 26;
  return `${String.fromCharCode(65 + a)}${String.fromCharCode(65 + b)}`;
}

/** Inverse of `indexLetter` for single-letter keys; returns -1 for non-letters. */
export function letterIndex(key: string): number {
  if (key.length !== 1) return -1;
  const code = key.toUpperCase().charCodeAt(0);
  if (code < 65 || code > 90) return -1;
  return code - 65;
}

/** 1-keyed digit → option index ("1" → 0, "9" → 8); -1 for any other key.
 *  The card badges options 1, 2, 3 so the shortcut matches what you see. */
function digitIndex(key: string): number {
  if (key.length !== 1 || key < "1" || key > "9") return -1;
  return key.charCodeAt(0) - 49;
}

/** Speech-bubble glyph that anchors the prompt header. */
export function QuestionBubbleGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path
        d="M2.5 4.2a1.7 1.7 0 0 1 1.7-1.7h7.6a1.7 1.7 0 0 1 1.7 1.7v5.1a1.7 1.7 0 0 1-1.7 1.7H6.5l-3 2.6v-2.6h-.3a1.7 1.7 0 0 1-1.7-1.7V4.2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M6.4 6.5a1.6 1.6 0 0 1 3-.5c.3.6-.1 1.1-.5 1.4-.4.3-.9.5-.9 1M8 9.6v.1"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Tiny chevron for the collapse toggle in the card header. */
export function ChevronTiny({ dir }: { dir: "up" | "down" }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{ transform: dir === "up" ? "rotate(180deg)" : undefined }}
    >
      <path
        d="M3.5 6l4.5 4 4.5-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A small keyboard-affordance pill ("Esc", "1", …) — the shared `Kbd`
 *  key cap, kept a touch quieter (text-3) and spaced off the preceding text. */
export function KbdHint({ label }: { label: string }) {
  return <Kbd className="ml-1.5 text-text-3">{label}</Kbd>;
}

/** Return-key affordance shown inside the primary submit CTA. Brightens when
 *  the card has a submittable selection. */
export function ContinueArrowKbd({ active }: { active: boolean }) {
  return (
    <kbd
      className="font-mono t-2xs px-1 py-0.5 ml-1.5 inline-flex items-center"
      style={{
        borderRadius: "var(--radius-xs)",
        background: active
          ? "color-mix(in srgb, var(--color-bg-0) 22%, transparent)"
          : "color-mix(in srgb, var(--color-bg-0) 10%, transparent)",
        color: active
          ? "var(--color-bg-0)"
          : "color-mix(in srgb, var(--color-bg-0) 55%, transparent)",
        opacity: active ? 1 : 0.7,
      }}
    >
      ⏎
    </kbd>
  );
}

// Inventory blocker #3 — "Approved by @handle · 2h ago" timestamp.
// Backend stamps `approved_at` as unix-seconds, matching the rest of
// the PendingPlan struct's time fields. Mirrors the inline helpers in
// MonacoEditor / FileInsightStrip rather than pulling a dep just for
// one row, but caps at days because plans typically resolve same-day.
export function formatRelativeApprovalTime(approvedAtSecs: number): string {
  const nowSecs = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, nowSecs - approvedAtSecs);
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

/** Per-question working state inside the card. One of these per item in the
 *  set; for a single question it's a 1-element array. `picked` is an array
 *  (not a Set) so the immutable per-item updates stay simple. */
type ItemState = {
  singlePick: string | null;
  picked: string[];
  text: string;
  /** Conductor's "0 · Type something…" escape hatch — a free-text answer that
   *  overrides any picked option when non-empty, so you're never boxed in. */
  custom: string;
};

function emptyState(): ItemState {
  return { singlePick: null, picked: [], text: "", custom: "" };
}

/** Resolve one item's current answer to a plain string. Empty = unanswered. */
function answerFor(item: QuestionItem, st: ItemState): string {
  if (item.kind === "text") return st.text.trim();
  const custom = st.custom.trim();
  if (custom) return custom;
  if (item.kind === "choice") return st.singlePick ?? "";
  return item.options.filter((o) => st.picked.includes(o)).join(", ");
}

export function QuestionCard({
  sessionId,
  question,
  docked = false,
  onError,
  onAnswered,
}: {
  sessionId: string;
  question: PendingQuestion;
  /** Fuse the card onto the composer below it — top-rounded, square bottom,
   *  border colour matched to the composer so the two read as one panel. The
   *  caller passes the same flag to `<ManagerComposer docked>` and zeroes the
   *  dock gap. False = a standalone rounded card (e.g. a queue sits between). */
  docked?: boolean;
  onError: (msg: string) => void;
  /** Fires before the API call so the parent can flip its post-answer
   *  busy state ("Planning next moves" instead of "Thinking…"). The Q+A
   *  pair itself is persisted server-side and rendered from session.chat
   *  on the next snapshot — the parent doesn't need to stash it. */
  onAnswered?: () => void;
}) {
  // The clubbed set, or a 1-item set mirrored from the top-level triple when
  // the brain asked a single question (or the CLI bridge did). Memoised so the
  // per-item state initialiser + effect deps stay stable across renders.
  const items = useMemo<QuestionItem[]>(
    () =>
      question.items && question.items.length > 0
        ? question.items
        : [
            {
              question: question.question,
              options: question.options,
              kind: question.kind,
            },
          ],
    [question.items, question.question, question.options, question.kind],
  );
  const isSet = items.length > 1;

  const [submitting, setSubmitting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [states, setStates] = useState<ItemState[]>(() =>
    items.map(() => emptyState()),
  );

  const updateState = useCallback(
    (i: number, patch: Partial<ItemState>) => {
      setStates((prev) =>
        prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
      );
    },
    [],
  );

  const send = useCallback(
    async (main: string) => {
      if (submitting) return;
      const trimmed = main.trim();
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

  const answers = items.map((it, i) => answerFor(it, states[i] ?? emptyState()));
  const canContinue = answers.every((a) => a.trim().length > 0);

  // Build the reply. A single question posts the bare answer (so the CLI
  // socket bridge + single-question consumers see exactly what they always
  // did). A set posts a numbered, labelled block so the brain can read each
  // answer back against the question it asked.
  const doSubmit = useCallback(() => {
    if (submitting || !canContinue) return;
    if (items.length === 1) {
      void send(answers[0]!);
      return;
    }
    const combined = items
      .map((it, i) => {
        const label = (it.header?.trim() || it.question.trim()) ?? "";
        return `${i + 1}. ${label}: ${answers[i]!.trim()}`;
      })
      .join("\n");
    void send(combined);
  }, [submitting, canContinue, items, answers, send]);

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

  // Document-level keyboard shortcuts. For a single question we keep the full
  // keyboard model (1/2/3 pick or toggle, Enter submits). For a set the digit
  // keys are ambiguous (which question?), so we drop them and the set is
  // click-driven — Enter still submits once every question is answered, Esc
  // still skips the whole set.
  useEffect(() => {
    if (submitting || collapsed) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
      )
        return;
      if (!isSet) {
        const item = items[0]!;
        const st = states[0] ?? emptyState();
        if (item.kind === "choice") {
          const idx = digitIndex(e.key);
          if (idx >= 0 && idx < item.options.length) {
            e.preventDefault();
            updateState(0, { singlePick: item.options[idx]! });
            return;
          }
        } else if (item.kind === "multi_choice") {
          const idx = digitIndex(e.key);
          if (idx >= 0 && idx < item.options.length) {
            e.preventDefault();
            const opt = item.options[idx]!;
            const next = st.picked.includes(opt)
              ? st.picked.filter((o) => o !== opt)
              : [...st.picked, opt];
            updateState(0, { picked: next });
            return;
          }
        }
      }
      if (e.key === "Enter") {
        e.preventDefault();
        doSubmit();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        skip();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    isSet,
    items,
    states,
    submitting,
    collapsed,
    updateState,
    doSubmit,
    skip,
  ]);

  // When docked the card is the TOP half of a single panel: round only the top
  // corners, square the bottom, and borrow the composer's border colour so the
  // continuous side rails and the one hairline where they meet read as one
  // frame. Standalone (queue present) keeps the self-contained rounded card.
  return (
    <div
      className="w-full flex flex-col overflow-hidden"
      style={{
        background: "var(--color-bg-1)",
        border: `1px solid ${docked ? "var(--color-composer-border)" : "var(--color-line)"}`,
        borderRadius: docked
          ? "var(--radius-xl) var(--radius-xl) 0 0"
          : "var(--radius-md)",
      }}
    >
      <div className="flex items-center justify-between gap-2 px-3.5 pt-2.5 pb-1.5">
        <div
          className="flex items-center gap-1.5 t-sm t-ui"
          style={{ color: "var(--color-text-2)" }}
        >
          <QuestionBubbleGlyph />
          <span>{isSet ? "Questions" : "Question"}</span>
          {isSet && (
            <span
              className="font-mono t-2xs tabular-nums px-1.5 py-0.5"
              style={{
                borderRadius: "var(--radius-xs)",
                background: "var(--color-bg-2)",
                color: "var(--color-text-3)",
              }}
            >
              {items.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="px-1 py-0.5 transition-colors hover:text-[var(--color-text-1)]"
          style={{ color: "var(--color-text-3)" }}
          title={collapsed ? "Expand" : "Collapse"}
          aria-label="Toggle question"
        >
          <ChevronTiny dir={collapsed ? "down" : "up"} />
        </button>
      </div>

      {!collapsed && (
        <div className="px-3.5 pb-3 flex flex-col gap-3">
          {items.map((item, i) => {
            const st = states[i] ?? emptyState();
            const isMulti = item.kind === "multi_choice";
            const hasOptions = item.kind === "choice" || isMulti;
            return (
              <div
                key={i}
                className="flex flex-col gap-2"
                style={
                  // A subtle hairline between stacked questions so the set reads
                  // as distinct decisions, not one run-on block. No divider on
                  // the first (or a lone) question.
                  isSet && i > 0
                    ? {
                        borderTop: "1px solid var(--color-line-soft)",
                        paddingTop: "0.75rem",
                      }
                    : undefined
                }
              >
                <div className="flex items-start gap-2">
                  {isSet && (
                    <span
                      className="font-mono t-2xs t-ui tabular-nums inline-flex items-center justify-center shrink-0 mt-0.5"
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: "var(--radius-xs)",
                        background: "var(--color-bg-2)",
                        color: "var(--color-text-3)",
                      }}
                      aria-hidden
                    >
                      {i + 1}
                    </span>
                  )}
                  <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                    {item.header && item.header.trim() && (
                      <div
                        className="t-2xs t-ui uppercase tracking-wide"
                        style={{ color: "var(--color-text-3)" }}
                      >
                        {item.header}
                      </div>
                    )}
                    {item.question && (
                      <div
                        className="t-base t-heading"
                        style={{ color: "var(--color-text-1)" }}
                      >
                        {item.question}
                      </div>
                    )}
                  </div>
                </div>

                {hasOptions && (
                  <div className="flex flex-col gap-1">
                    {item.options.map((opt, oi) => {
                      const isPicked = isMulti
                        ? st.picked.includes(opt)
                        : st.singlePick === opt;
                      return (
                        <button
                          key={opt}
                          type="button"
                          disabled={submitting}
                          aria-pressed={isPicked}
                          aria-label={opt}
                          onClick={() => {
                            if (isMulti) {
                              const next = st.picked.includes(opt)
                                ? st.picked.filter((o) => o !== opt)
                                : [...st.picked, opt];
                              updateState(i, { picked: next });
                            } else {
                              updateState(i, { singlePick: opt });
                            }
                          }}
                          className="group flex items-center gap-2.5 px-2 py-1.5 text-left t-base disabled:opacity-50 transition-colors"
                          style={{
                            borderRadius: "var(--radius-sm)",
                            background: isPicked
                              ? "color-mix(in srgb, var(--color-accent) 12%, var(--color-bg-1))"
                              : "var(--color-bg-1)",
                            boxShadow: isPicked
                              ? "0 0 0 1px var(--color-accent)"
                              : "0 0 0 1px var(--color-line-soft)",
                            color: isPicked
                              ? "var(--color-text-1)"
                              : "var(--color-text-2)",
                          }}
                          onMouseEnter={(e) => {
                            if (!isPicked)
                              e.currentTarget.style.background =
                                "var(--color-bg-2)";
                          }}
                          onMouseLeave={(e) => {
                            if (!isPicked)
                              e.currentTarget.style.background =
                                "var(--color-bg-1)";
                          }}
                        >
                          {isMulti && (
                            <Checkbox
                              checked={isPicked}
                              tabIndex={-1}
                              aria-hidden
                              className="pointer-events-none mt-px"
                            />
                          )}
                          {/* Only single-question cards badge options with the
                              1/2/3 keyboard shortcut — a set is click-driven, so
                              a numeric badge there would be a false affordance. */}
                          {!isSet && (
                            <span
                              className="font-mono t-2xs t-ui tabular-nums inline-flex items-center justify-center shrink-0"
                              style={{
                                width: 18,
                                height: 18,
                                borderRadius: "var(--radius-xs)",
                                background: isPicked
                                  ? "color-mix(in srgb, var(--color-accent) 28%, transparent)"
                                  : "var(--color-bg-2)",
                                color: isPicked
                                  ? "var(--color-text-1)"
                                  : "var(--color-text-3)",
                              }}
                            >
                              {oi + 1}
                            </span>
                          )}
                          <span className="flex-1">{opt}</span>
                        </button>
                      );
                    })}
                    {/* Conductor's "0 · Type something…" row — a free-text answer
                        that overrides this question's listed options. */}
                    <div
                      className="flex items-center gap-2.5 px-2 py-1.5"
                      style={{ borderRadius: "var(--radius-sm)" }}
                    >
                      {!isSet && (
                        <span
                          className="font-mono t-2xs t-ui tabular-nums inline-flex items-center justify-center shrink-0"
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: "var(--radius-xs)",
                            background: "var(--color-bg-2)",
                            color: "var(--color-text-3)",
                          }}
                          aria-hidden
                        >
                          0
                        </span>
                      )}
                      <input
                        type="text"
                        value={st.custom}
                        disabled={submitting}
                        onChange={(e) =>
                          updateState(i, { custom: e.target.value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            doSubmit();
                          }
                        }}
                        placeholder="Type something…"
                        aria-label="Type your own answer"
                        className="flex-1 bg-transparent t-base outline-none"
                        style={{ color: "var(--color-text-1)" }}
                      />
                    </div>
                  </div>
                )}

                {item.kind === "text" && (
                  <input
                    type="text"
                    value={st.text}
                    autoFocus={!isSet}
                    disabled={submitting}
                    aria-label={item.question}
                    onChange={(e) => updateState(i, { text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        doSubmit();
                      }
                    }}
                    placeholder="Type an answer…"
                    className="px-2.5 py-1.5 t-sm outline-none focus:border-[var(--color-accent)] transition-colors"
                    style={{
                      background: "var(--color-bg-0)",
                      border: "1px solid var(--color-line-soft)",
                      borderRadius: "var(--radius-sm)",
                      color: "var(--color-text-1)",
                    }}
                  />
                )}
              </div>
            );
          })}

          <div className="flex items-center justify-between gap-2 mt-0.5">
            <span className="t-xs" style={{ color: "var(--color-text-3)" }}>
              {isSet
                ? "Answer each, then continue"
                : items[0]?.kind === "multi_choice"
                  ? "Pick one or more"
                  : null}
            </span>
            <div className="flex items-center gap-2">
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
                disabled={submitting || !canContinue}
                onClick={doSubmit}
              >
                {submitting ? "Sending…" : "Continue"}
                <ContinueArrowKbd active={canContinue} />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
