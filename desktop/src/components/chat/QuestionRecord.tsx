import { useState, type ReactNode } from "react";
import { QuestionRequest, type QuestionAnswer } from "../ui/chat-decisions";

export interface RecordedQuestion {
  id: string;
  prompt: string;
  options: { id: string; label: string; description?: string }[];
  multiple?: boolean;
}

/** Questions from a turn that has moved on, drawn as the shared question
 *  request with nothing left to pick: the options as they were offered, the
 *  answer when the engine reported one, and the request's own arrows between
 *  several. `actions` is the way to answer elsewhere while it is still open. */
export function QuestionRecord({
  questions,
  answer,
  title,
  actions,
}: {
  questions: RecordedQuestion[];
  answer?: string;
  title?: string;
  actions?: ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const at = Math.min(index, questions.length - 1);
  const question = questions[at];
  if (!question) return null;
  return (
    <QuestionRequest
      key={question.id}
      className="chat-question-record"
      readOnly
      title={title}
      question={question.prompt}
      options={question.options}
      multiple={question.multiple}
      value={recordedAnswer(question, answer)}
      actions={actions}
      step={{
        index: at,
        total: questions.length,
        onPrevious: () => setIndex(at - 1),
        onNext: () => setIndex(at + 1),
      }}
    />
  );
}

/** The reported answer as the request's own value: the options it names are
 *  picked, and an answer that names none is shown as written. */
export function recordedAnswer(question: RecordedQuestion, answer?: string): QuestionAnswer {
  const said = answer?.trim();
  if (!said) return { selected: [], text: "" };
  const selected = question.options
    .filter((option) => said === option.label || said.includes(`"${option.label}"`))
    .map((option) => option.id);
  return selected.length ? { selected, text: "" } : { selected: [], text: said };
}
