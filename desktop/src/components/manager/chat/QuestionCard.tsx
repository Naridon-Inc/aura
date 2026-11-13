// Adapter from Aura's pending question contract to the shared chat question
// flow. Source labels and the tool-use ID are preserved in the reply. Draft
// answers survive failed delivery; completion follows backend acknowledgement.

import { useMemo } from "react";
import { QuestionFlow } from "../../chat/QuestionFlow";

import { api, type PendingQuestion, type QuestionItem } from "../../../lib/api";
import { relativeAgeFromSecs } from "../../../lib/relativeTime";

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
