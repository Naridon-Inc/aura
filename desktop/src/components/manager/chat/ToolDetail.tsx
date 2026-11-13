//! What a step shows once it is opened: the facts it was given, the plan or
//! question it carried, the diff it made, and what came back. Every face is a
//! shared transcript piece — a code block for output, the file diff for an
//! edit — so an opened step reads like the rest of the conversation.

import * as React from "react";
import { Check, Circle } from "lucide-react";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { CodeMessage } from "../../ui/transcript-content";
import { FileDiff } from "../../ui/workspace-patterns";
import { parseUnifiedDiff } from "../../../lib/diff";
import { MarkdownBody } from "./Markdown";
import type { AskView, ToolField, ToolResult, ToolStatus, ToolStep, ToolView } from "./types";
import "../../ui/chat-tool-detail.css";

/** Output past this many lines folds behind "Show all": ten lines is enough
 *  to tell a command worked without a build log burying the answer. */
const OUTPUT_LINES = 10;
/** A diff past this many lines folds the same way — about one hunk. */
const DIFF_LINES = 14;

/** The shared row's three states. A step that was cancelled or never
 *  reported back did not finish, so it does not wear the finished check. */
export function toolCallStatus(status: ToolStatus): "running" | "done" | "error" {
  if (status === "running") return "running";
  return status === "ok" ? "done" : "error";
}

/** The questions an ask carried, each with the options it offered. */
export function AskBlock({ ask }: { ask: AskView }) {
  return (
    <div className="ui-tool-ask">
      {ask.questions.map((q, qi) => (
        <div key={qi}>
          {q.question && <p>{q.question}</p>}
          <ul>
            {q.options.map((o, oi) => (
              <li key={oi}>
                <strong>{o.label}</strong>
                {o.description && <span title={o.description}>{o.description}</span>}
              </li>
            ))}
          </ul>
          {q.multiSelect && <small>Pick one or more</small>}
        </div>
      ))}
    </div>
  );
}

/** A proposed plan, rendered as the markdown it was written in. */
export function PlanBlock({ markdown }: { markdown: string }) {
  return (
    <div className="ui-tool-plan">
      <MarkdownBody source={markdown} />
    </div>
  );
}

/** A step's inputs as plain label/value pairs, never a raw JSON blob. */
export function FieldsBlock({ fields }: { fields: ToolField[] }) {
  return (
    <dl className="ui-tool-fields">
      {fields.map((f, i) => (
        <div key={i}>
          <dt>{f.label}</dt>
          <dd title={f.value}>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Count added/removed lines in a unified diff, ignoring the `+++`/`---`
 *  file headers so the count reflects real edits. */
export function diffStat(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line[0] === "+") add++;
    else if (line[0] === "-") del++;
  }
  return { add, del };
}

/** A unified diff drawn as the shared file diff, folded after one hunk. */
export function DiffView({ diff, name }: { diff: string; name: string }) {
  const [showAll, setShowAll] = React.useState(false);
  const lines = React.useMemo(() => parseUnifiedDiff(diff), [diff]);
  const folded = !showAll && lines.length > DIFF_LINES;
  return (
    <>
      <FileDiff name={name || "Changes"} lines={folded ? lines.slice(0, DIFF_LINES) : lines} />
      {folded && (
        <Button size="xs" variant="ghost" onClick={() => setShowAll(true)}>
          Show all {lines.length} lines
        </Button>
      )}
    </>
  );
}

/** A to-do list a step reported: done, in progress, still to do. */
export function StepLoader({ steps }: { steps: ToolStep[] }) {
  return (
    <ul className="ui-tool-steps">
      {steps.map((step, i) => (
        <li key={i} data-status={step.status}>
          {step.status === "completed" ? (
            <Check size={14} aria-label="Done" />
          ) : step.status === "in_progress" ? (
            <AsciiSpinner />
          ) : (
            <Circle size={14} aria-label="To do" />
          )}
          <span>{step.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** The body a step carries: a to-do list, a diff, or a short note. */
export function CardBody({ view }: { view: ToolView }) {
  if (view.steps) return <StepLoader steps={view.steps} />;
  if (view.diff) return <DiffView diff={view.diff} name={view.subject ?? ""} />;
  if (view.body) return <p className="ui-tool-body">{view.body}</p>;
  return null;
}

/** Whether a step's output is raw terminal or file text, shown as a code
 *  listing, rather than prose to render as markdown. */
function isRawTextOutput(view?: ToolView): boolean {
  switch (view?.glyph) {
    case "run":
    case "read":
    case "search":
    case "glob":
    case "list":
      return true;
    default:
      return false;
  }
}

/** The "Show all" toggle shared by every folded output. */
function MoreToggle({
  total,
  open,
  onToggle,
}: {
  total: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Button size="xs" variant="ghost" onClick={onToggle}>
      {open ? `Show first ${OUTPUT_LINES}` : `Show all ${total} lines`}
    </Button>
  );
}

/** What a step returned. An error stays verbatim in red, terminal and file
 *  text is a code listing (a file read is numbered), anything else is
 *  rendered markdown — a page body, a review. Folded after ten lines. */
export function ToolResultBlock({ result, view }: { result: ToolResult; view?: ToolView }) {
  const [showAll, setShowAll] = React.useState(false);
  const content = result.content?.trimEnd() || "";
  if (!content) return null;
  const lines = content.split("\n");
  const folded = !showAll && lines.length > OUTPUT_LINES;
  const shown = folded ? lines.slice(0, OUTPUT_LINES) : lines;
  const raw = result.is_error || isRawTextOutput(view);
  return (
    <div className="ui-tool-output" data-tone={result.is_error ? "error" : undefined}>
      {raw ? (
        <CodeMessage language={result.is_error ? "Error" : "Output"}>
          <span
            className="ui-tool-lines"
            data-numbered={!result.is_error && view?.glyph === "read" ? "" : undefined}
          >
            {shown.map((line, i) => (
              <span key={i}>{line || " "}</span>
            ))}
          </span>
        </CodeMessage>
      ) : (
        <MarkdownBody source={folded ? `${shown.join("\n")}\n\n…` : content} />
      )}
      {lines.length > OUTPUT_LINES && (
        <MoreToggle total={lines.length} open={showAll} onToggle={() => setShowAll((v) => !v)} />
      )}
    </div>
  );
}

/** A command and what it printed, in one shell listing. The command wraps
 *  instead of scrolling off; a command that printed nothing says so. */
export function TerminalBlock({ command, result }: { command: string; result?: ToolResult }) {
  const [showAll, setShowAll] = React.useState(false);
  const out = result?.content?.trimEnd() || "";
  const lines = out ? out.split("\n") : [];
  const folded = !showAll && lines.length > OUTPUT_LINES;
  const shown = folded ? lines.slice(0, OUTPUT_LINES) : lines;
  return (
    <div
      className="ui-tool-output ui-tool-terminal"
      data-tone={result?.is_error ? "error" : undefined}
    >
      <CodeMessage language="Shell">
        <span className="ui-tool-lines">
          <span>
            <span className="ui-tool-prompt" aria-hidden>
              ${" "}
            </span>
            {command}
          </span>
          {lines.length > 0 ? (
            shown.map((line, i) => <span key={i}>{line || " "}</span>)
          ) : result ? (
            <span className="ui-tool-quiet">No output</span>
          ) : null}
        </span>
      </CodeMessage>
      {lines.length > OUTPUT_LINES && (
        <MoreToggle total={lines.length} open={showAll} onToggle={() => setShowAll((v) => !v)} />
      )}
    </div>
  );
}
