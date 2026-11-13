import { useRef, useState } from "react";
import { QuestionRequest, type QuestionAnswer } from "../ui/chat-decisions";

export type FlowQuestion = {
  id: string;
  prompt: string;
  options: { id: string; label: string; description?: string }[];
  multiple?: boolean;
  freeText?: boolean;
};
export type FlowAnswer = { selected: string[]; text: string; skipped?: boolean };

/** Several questions, one at a time, each drawn as the shared question
 *  request. This keeps only what the request cannot: which question is up,
 *  every answer so far, and the send. Answers use source IDs, never option
 *  positions. A failed send reopens with every selection kept. A pick and a
 *  written answer replace each other, so a reply is one or the other. */
export function QuestionFlow({ questions, onSubmit, docked = false, title = "Questions", allowSkip = true, submitLabel = "Continue" }: {
  questions: FlowQuestion[];
  onSubmit: (answers: FlowAnswer[]) => Promise<void>;
  docked?: boolean;
  title?: string;
  allowSkip?: boolean;
  submitLabel?: string;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<FlowAnswer[]>(() => questions.map(() => ({ selected: [], text: "" })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const question = questions[index];
  if (!question) return null;
  const answer = answers[index] ?? { selected: [], text: "" };
  const last = index === questions.length - 1;

  function change(next: QuestionAnswer) {
    const picked = next.selected.join("\u0000") !== answer.selected.join("\u0000");
    const value: FlowAnswer = picked ? { selected: next.selected, text: "" } : { selected: [], text: next.text };
    setAnswers(prev => prev.map((v, i) => i === index ? value : v));
  }
  async function advance(skip = false) {
    if (lock.current) return;
    const next = answers.map((v, i) => i === index && skip ? { selected: [], text: "", skipped: true } : v);
    setAnswers(next);
    if (!last) { setIndex(index + 1); return; }
    const missing = next.findIndex(v => !v.skipped && !v.text.trim() && !v.selected.length);
    if (missing >= 0) { setIndex(missing); return; }
    lock.current = true; setBusy(true); setError("");
    try { await onSubmit(next); }
    catch (e) { setError(String(e)); setBusy(false); lock.current = false; }
  }

  return <QuestionRequest
    key={question.id}
    className={`chat-question-request${docked ? " is-docked" : ""}`}
    title={title}
    question={question.prompt}
    options={question.options}
    multiple={question.multiple}
    freeText={!!question.freeText}
    value={answer}
    onValueChange={change}
    onSubmit={() => void advance()}
    onSkip={allowSkip ? () => void advance(true) : undefined}
    pending={busy}
    error={error || undefined}
    submitLabel={busy ? "Sending…" : last ? submitLabel : "Continue"}
    step={{ index, total: questions.length, onPrevious: () => setIndex(index - 1), onNext: () => setIndex(index + 1) }}
  />;
}
