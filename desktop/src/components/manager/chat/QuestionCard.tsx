// Adapter from Aura's pending question contract to the shared chat question
// flow. Source labels and the tool-use ID are preserved in the reply. Draft
// answers survive failed delivery; completion follows backend acknowledgement.

import { useMemo } from "react";
import { QuestionFlow } from "../../chat/QuestionFlow";

import { api, type PendingQuestion, type QuestionItem } from "../../../lib/api";
import { Kbd } from "../../ui/kbd";
import { relativeAgeFromSecs } from "../../../lib/relativeTime";

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
    // Deliberately not the shared `Kbd`: this rides inside the filled primary
    // CTA, so it mixes against `--color-bg-0` to invert on that fill. The
    // shared cap paints for the page ground and would disappear here.
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
// Backend stamps `approved_at` as unix-seconds, matching the rest of the
// PendingPlan struct's time fields.
export function formatRelativeApprovalTime(approvedAtSecs: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromSecs(approvedAtSecs);
}

/** Per-question working state inside the card. One of these per item in the
 *  set; for a single question it's a 1-element array. `picked` is an array
 *  (not a Set) so the immutable per-item updates stay simple. */
export function QuestionCard({
  sessionId,
  question,
  docked = false,
  onError,
  onAnswered,
}: {
  sessionId: string;
  question: PendingQuestion;
  docked?: boolean;
  onError: (msg: string) => void;
  onAnswered?: () => void;
}) {
  const items = useMemo<QuestionItem[]>(
    () =>
      question.items?.length
        ? question.items
        : [
            {
              question: question.question,
              options: question.options,
              kind: question.kind,
            },
          ],
    [question],
  );
  return (
    <QuestionFlow
      key={question.tool_use_id}
      docked={docked}
      questions={items.map((item, i) => ({
        id: String(i),
        prompt: item.question,
        multiple: item.kind === "multi_choice",
        freeText: true,
        options: item.options.map((label, n) => ({ id: String(n), label })),
      }))}
      onSubmit={async (answers) => {
        const values = answers.map((answer, i) =>
          answer.skipped
            ? "(skipped)"
            : answer.text.trim() ||
              answer.selected
                .map((id) => items[i].options[Number(id)])
                .join(", "),
        );
        const reply =
          items.length === 1
            ? values[0]
            : items
                .map(
                  (item, i) =>
                    `${i + 1}. ${item.header?.trim() || item.question}: ${values[i]}`,
                )
                .join("\n");
        try {
          await api.managerAnswerQuestion(
            sessionId,
            question.tool_use_id,
            reply,
          );
          onAnswered?.();
        } catch (e) {
          onError(String(e));
          throw e;
        }
      }}
    />
  );
}
