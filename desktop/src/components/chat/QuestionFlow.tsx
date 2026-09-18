import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Check } from "lucide-react";
import "./ChatComposer.css";

export type FlowQuestion = {
  id: string;
  prompt: string;
  options: { id: string; label: string; description?: string }[];
  multiple?: boolean;
  freeText?: boolean;
};
export type FlowAnswer = { selected: string[]; text: string; skipped?: boolean };

/** One focused decision at a time. Answers use source IDs, never option
 * positions. Reopening a failed submission retains every selection. */
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
  const valid = answer.selected.length > 0 || !!answer.text.trim() || answer.skipped;
  function change(next: FlowAnswer) { setAnswers(prev => prev.map((v, i) => i === index ? next : v)); }
  function pick(id: string) {
    if (busy) return;
    change({ text: "", selected: question.multiple ? answer.selected.includes(id) ? answer.selected.filter(v => v !== id) : [...answer.selected, id] : [id] });
  }
  async function advance(skip = false) {
    if (lock.current || (!skip && !valid)) return;
    const next = answers.map((v, i) => i === index && skip ? { selected: [], text: "", skipped: true } : v);
    setAnswers(next);
    if (index < questions.length - 1) { setIndex(index + 1); return; }
    const missing = next.findIndex(v => !v.skipped && !v.text.trim() && !v.selected.length);
    if (missing >= 0) { setIndex(missing); return; }
    lock.current = true; setBusy(true); setError("");
    try { await onSubmit(next); }
    catch (e) { setError(String(e)); setBusy(false); lock.current = false; }
  }
  return <section className={`question-flow ${docked ? "is-docked" : ""}`} aria-label={title} onKeyDown={e => {
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const input = (e.target as HTMLElement).matches("input,textarea,[contenteditable=true]");
    if (e.key === "Enter" && input) { e.preventDefault(); void advance(); }
    if (!input && /^[1-9]$/.test(e.key)) { const option = question.options[Number(e.key) - 1]; if (option) { e.preventDefault(); pick(option.id); } }
  }}>
    <header className="question-flow-header"><span>{title}</span>
      <nav aria-label="Question navigation"><span>{index + 1} of {questions.length}</span>
        <button type="button" aria-label="Previous question" disabled={busy || index === 0} onClick={() => setIndex(index - 1)}><ChevronLeft size={15} /></button>
        <button type="button" aria-label="Next question" disabled={busy || index === questions.length - 1} onClick={() => setIndex(index + 1)}><ChevronRight size={15} /></button>
      </nav>
    </header>
    <div className="question-flow-prompt" aria-live="polite">{question.prompt}</div>
    <div className="question-flow-options">{question.options.map((option, i) => <button type="button" key={option.id} className="question-flow-option" aria-pressed={answer.selected.includes(option.id)} disabled={busy} onClick={() => pick(option.id)}>
      <span className="question-flow-number" aria-hidden>{question.multiple && answer.selected.includes(option.id) ? <Check size={13} /> : i + 1}</span><span>{option.label}{option.description && <small>{option.description}</small>}</span>
    </button>)}</div>
    {(question.freeText || !question.options.length) && <input className="question-flow-input" aria-label="Write an answer" placeholder={question.options.length ? "Or write an answer…" : "Write an answer…"} value={answer.text} disabled={busy} onChange={e => change({ selected: [], text: e.target.value })} />}
    {error && <p role="alert" className="mt-3 text-xs text-red">{error}</p>}
    <footer className="question-flow-footer"><span>{question.multiple ? "Choose one or more" : ""}</span>
      {allowSkip && <button type="button" disabled={busy} onClick={() => void advance(true)}>Skip</button>}
      <button type="button" className="chat-primary-action" disabled={busy || !valid} onClick={() => void advance()}>{busy ? "Sending…" : index < questions.length - 1 ? "Continue" : submitLabel}</button>
    </footer>
  </section>;
}
