import { useId, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerUpRight,
  Play,
  ShieldCheck,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Kbd } from "./kbd";
import { Checkbox } from "./checkbox";
import { Textarea } from "./textarea";
import "./chat-decision.css";
export interface PermissionChoice {
  id: string;
  label: string;
  description?: string;
  primary?: boolean;
}
export function PermissionRequest({
  title,
  description,
  command,
  agent,
  choices,
  pending,
  onChoose,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  command?: string;
  /** Who is asking — a name, or a short line that can carry a live timer. */
  agent?: ReactNode;
  choices: PermissionChoice[];
  pending?: boolean;
  onChoose: (choice: string) => void;
  /** Anything the request needs beyond the command — what it would break,
   *  the change itself, a note to send back — drawn above the answers. */
  children?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section
      className={cn("ui-permission-request", className)}
      aria-labelledby={id}
      tabIndex={0}
      onKeyDown={(event) => {
        if (pending || event.altKey || event.metaKey || event.ctrlKey || !/^[1-9]$/.test(event.key))
          return;
        const choice = choices[Number(event.key) - 1];
        if (choice) {
          event.preventDefault();
          onChoose(choice.id);
        }
      }}
    >
      <header>
        <ShieldCheck size={16} />
        <strong id={id}>{title}</strong>
        {agent && <small>{agent}</small>}
      </header>
      {description && <p>{description}</p>}
      {command && <pre>{command}</pre>}
      {children}
      <div className="ui-permission-options">
        {choices.map((choice, index) => (
          <Button
            key={choice.id}
            className="ui-permission-option"
            variant={choice.primary ? "default" : "outline"}
            disabled={pending}
            onClick={() => onChoose(choice.id)}
          >
            <span>
              {choice.label}
              {choice.description && <small>{choice.description}</small>}
            </span>
            {index < 9 && <Kbd>{index + 1}</Kbd>}
          </Button>
        ))}
      </div>
    </section>
  );
}
export function PlanReview({
  title = "Plan ready",
  children,
  text,
  onExecute,
  onNewChat,
  onRevise,
  pending,
  status,
  onOpen,
  actions,
  summary,
  meta,
  collapsible = false,
  extra,
  className,
}: {
  title?: string;
  children?: ReactNode;
  /** The plan as text, for Copy. */
  text?: string;
  onExecute?: () => void;
  onNewChat?: () => void;
  onRevise?: () => void;
  pending?: boolean;
  /** Where the plan stands, beside its title ("Ready for review"). */
  status?: string;
  /** Makes the title the way into the full plan. */
  onOpen?: () => void;
  /** The surface's own actions, in place of Copy, New chat and Implement plan. */
  actions?: ReactNode;
  /** One line above the plan itself. */
  summary?: string;
  /** A caption under the plan ("3 tasks"). */
  meta?: ReactNode;
  /** The plan folds behind Show plan until asked for. */
  collapsible?: boolean;
  /** Anything after the plan: options, a revision note. */
  extra?: ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(false),
    [expanded, setExpanded] = useState(false);
  const shown = !!children && (!collapsible || expanded);
  const named = status != null || onOpen != null;
  return (
    <section className={cn("ui-plan-review", className)} aria-label={named ? `Plan: ${title}` : undefined}>
      <header>
        {named ? (
          <span className="chat-plan-review-title">
            {onOpen ? (
              <button
                type="button"
                className="chat-plan-review-open"
                onClick={onOpen}
                title="Open the full plan"
              >
                <strong>{title}</strong>
                <ArrowUpRight aria-hidden />
              </button>
            ) : (
              <strong>{title}</strong>
            )}
            <small>{status || "Plan"}</small>
          </span>
        ) : (
          <strong>{title}</strong>
        )}
        <div className="ui-pattern-actions">
          {collapsible && children ? (
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? <ChevronDown /> : <ChevronRight />}
              {expanded ? "Hide plan" : "Show plan"}
            </Button>
          ) : null}
          {actions ?? (
            <>
              {text != null && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(text);
                      setCopied(true);
                      setCopyError(false);
                    } catch {
                      setCopyError(true);
                    }
                  }}
                >
                  {copied ? <Check /> : <Copy />}Copy
                </Button>
              )}
              {onNewChat && (
                <Button size="xs" variant="outline" disabled={pending} onClick={onNewChat}>
                  <CornerUpRight />
                  New chat
                </Button>
              )}
              {onExecute && (
                <Button size="xs" disabled={pending} onClick={onExecute}>
                  <Play />
                  Implement plan
                </Button>
              )}
            </>
          )}
        </div>
      </header>
      {(summary || shown) && (
        <div className="ui-plan-content">
          {summary && <p>{summary}</p>}
          {shown && children}
        </div>
      )}
      {meta && <small className="chat-plan-review-meta">{meta}</small>}
      {extra}
      {onRevise && (
        <Button size="xs" variant="ghost" onClick={onRevise}>
          Revise plan
        </Button>
      )}
      {copyError && <small role="status">Could not copy the plan.</small>}
    </section>
  );
}
export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}
export interface QuestionAnswer {
  selected: string[];
  text: string;
}
export function QuestionRequest({
  question,
  options,
  multiple = false,
  onSubmit,
  pending,
  value,
  onValueChange,
  title,
  step,
  freeText = true,
  submitLabel = "Submit answer",
  onSkip,
  error,
  readOnly = false,
  actions,
  className,
}: {
  question: string;
  options: QuestionOption[];
  multiple?: boolean;
  onSubmit?: (answer: QuestionAnswer) => void;
  pending?: boolean;
  /** The answer, when the owner keeps it (across steps, or a failed send). */
  value?: QuestionAnswer;
  onValueChange?: (answer: QuestionAnswer) => void;
  /** A heading over several questions. */
  title?: string;
  /** Where this question sits among several, and the way between them. */
  step?: { index: number; total: number; onPrevious: () => void; onNext: () => void };
  /** Offer a written answer beside the options. Always on with no options. */
  freeText?: boolean;
  submitLabel?: string;
  onSkip?: () => void;
  error?: string;
  /** A question already answered: the options as offered, the answer shown,
   *  nothing left to pick. */
  readOnly?: boolean;
  /** The surface's own actions, in place of Skip and Submit. */
  actions?: ReactNode;
  className?: string;
}) {
  const [own, setOwn] = useState<QuestionAnswer>({ selected: [], text: "" });
  const answer = value ?? own;
  const { selected, text } = answer;
  const set = (next: QuestionAnswer) => {
    if (!value) setOwn(next);
    onValueChange?.(next);
  };
  const id = useId();
  const valid = !!selected.length || !!text.trim();
  const pick = (key: string, checked = !selected.includes(key)) =>
    set({
      ...answer,
      selected: multiple
        ? checked
          ? [...selected.filter((other) => other !== key), key]
          : selected.filter((other) => other !== key)
        : [key],
    });
  return (
    <form
      className={cn("ui-question-request", className)}
      aria-label={title}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !readOnly) onSubmit?.(answer);
      }}
      onKeyDown={(event) => {
        if (pending || readOnly || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey)
          return;
        const typing = (event.target as HTMLElement).matches("textarea,[contenteditable=true]");
        if (event.key === "Enter" && typing && !event.shiftKey) {
          event.preventDefault();
          if (valid) onSubmit?.(answer);
        } else if (!typing && /^[1-9]$/.test(event.key)) {
          const option = options[Number(event.key) - 1];
          if (option) {
            event.preventDefault();
            pick(option.id);
          }
        }
      }}
    >
      {step && step.total > 1 && (
        <div className="chat-question-head">
          <span>{title}</span>
          <nav aria-label="Question navigation">
            <span>
              {step.index + 1} of {step.total}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="iconXs"
              aria-label="Previous question"
              disabled={pending || step.index === 0}
              onClick={step.onPrevious}
            >
              <ChevronLeft />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="iconXs"
              aria-label="Next question"
              disabled={pending || step.index === step.total - 1}
              onClick={step.onNext}
            >
              <ChevronRight />
            </Button>
          </nav>
        </div>
      )}
      <fieldset disabled={pending || readOnly}>
        <legend aria-live="polite">{question}</legend>
        {options.map((option) => (
          <label className="ui-question-option" key={option.id}>
            {multiple ? (
              <Checkbox
                checked={selected.includes(option.id)}
                onCheckedChange={(checked) => pick(option.id, !!checked)}
              />
            ) : (
              <input
                type="radio"
                name={id}
                value={option.id}
                checked={selected[0] === option.id}
                onChange={() => pick(option.id)}
              />
            )}
            <span>
              {option.label}
              {option.description && <small>{option.description}</small>}
            </span>
          </label>
        ))}
        {(readOnly ? !!text : freeText || !options.length) && (
          <Textarea
            aria-label="Additional answer"
            placeholder={options.length ? "Something else…" : "Write an answer…"}
            value={text}
            readOnly={readOnly}
            onChange={(event) => set({ ...answer, text: event.target.value })}
          />
        )}
        {error && (
          <p role="alert" className="chat-question-error">
            {error}
          </p>
        )}
        {(!readOnly || actions) && (
          <div className="ui-pattern-actions">
            {multiple && !readOnly && <span className="chat-question-hint">Choose one or more</span>}
            {actions ?? (
              <>
                {onSkip && (
                  <Button type="button" size="sm" variant="ghost" onClick={onSkip}>
                    Skip
                  </Button>
                )}
                <Button type="submit" size="sm" disabled={!valid}>
                  {submitLabel}
                </Button>
              </>
            )}
          </div>
        )}
      </fieldset>
    </form>
  );
}
