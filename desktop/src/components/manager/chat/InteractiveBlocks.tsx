//! Interactive blocks hoisted OUT of the settled-turn roll-up.
//!
//! A finished assistant turn folds its whole step-run into the quiet
//! "Worked through N steps" disclosure (`TurnActivity`). That is right for
//! reads / searches / edits / commands — but WRONG for the two things the user
//! must actually see: a **question the brain asked** (`AskUserQuestion`) and a
//! **plan it proposed** (`ExitPlanMode`). Buried two disclosures deep, a
//! question reads as "it said it asked something, but where is it?".
//!
//! So the caller partitions a turn's blocks: the interactive ones surface here
//! as prominent standalone cards in the main flow (never collapsed), and only
//! the rest fold into the roll-up. The card layout copies how Cursor surfaces
//! its question cards — a titled header, the bold question, numbered options —
//! in Aura's own tokens (no orange: that's agent-brand only).

import { describeTool } from "./toolDescribe";
import { MarkdownBody } from "./Markdown";
import type { AskView, StreamBlock } from "./types";

type ToolBlock = Extract<StreamBlock, { kind: "tool" }>;

/** Split a settled turn's blocks into the interactive ones — questions the
 *  brain asked you and plans it proposed — and everything else. The interactive
 *  blocks render as prominent cards in the main flow; the rest fold into the
 *  quiet "Worked through N steps" roll-up. This is the single reason a question
 *  is never buried under two chevrons. */
export function partitionInteractive(blocks: StreamBlock[]): {
  interactive: ToolBlock[];
  rest: StreamBlock[];
} {
  const interactive: ToolBlock[] = [];
  const rest: StreamBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "tool") {
      const view = describeTool(b.name, b.input, b.result);
      if (view.ask || view.planMarkdown) {
        interactive.push(b);
        continue;
      }
    }
    rest.push(b);
  }
  return { interactive, rest };
}

/** Render the hoisted interactive blocks for a settled turn — each
 *  `AskUserQuestion` as a prominent `QuestionCard`, each `ExitPlanMode` as a
 *  `PlanCard`. Returns null when the turn had none, so a normal answer carries
 *  no empty chrome. */
export function InteractiveBlocks({ blocks }: { blocks: ToolBlock[] }) {
  if (blocks.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b) => {
        const view = describeTool(b.name, b.input, b.result);
        if (view.ask) return <QuestionCard key={b.tool_use_id} ask={view.ask} />;
        if (view.planMarkdown) {
          return <PlanCard key={b.tool_use_id} markdown={view.planMarkdown} />;
        }
        return null;
      })}
    </div>
  );
}

/** The brain asked you something — surfaced as a prominent titled card with the
 *  bold question and numbered options, the way Cursor shows its question cards.
 *  Settled turns are a RECORD of what was asked (the answer already followed in
 *  the conversation), so there are no dead Skip/Continue buttons — the value is
 *  that the question is unmissable, not buried. */
function QuestionCard({ ask }: { ask: AskView }) {
  const many = ask.questions.length > 1;
  return (
    <div className="aura-ask-card">
      <div className="aura-ask-card-head">
        <QuestionGlyph />
        <span>{many ? "Questions" : "Question"}</span>
      </div>
      <div className="aura-ask-card-body">
        {ask.questions.map((q, qi) => (
          <div key={qi} className="aura-ask-q">
            {q.question && <div className="aura-ask-q-text">{q.question}</div>}
            <div className="aura-ask-options">
              {q.options.map((o, oi) => (
                <div key={oi} className="aura-ask-option">
                  <span className="aura-ask-num" aria-hidden>
                    {oi + 1}
                  </span>
                  <span className="aura-ask-option-body">
                    <span className="aura-ask-option-label">{o.label}</span>
                    {o.description && (
                      <span
                        className="aura-ask-option-desc"
                        title={o.description}
                      >
                        {o.description}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {q.multiSelect && (
              <div className="aura-ask-hint">Pick one or more</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A plan the brain proposed (ExitPlanMode), surfaced prominently as real
 *  markdown — headings, lists, code render through the prose engine, never a
 *  raw `{plan:"…"}` blob. */
function PlanCard({ markdown }: { markdown: string }) {
  return (
    <div className="aura-plan-card">
      <div className="aura-plan-card-head">
        <PlanGlyph />
        <span>Plan</span>
      </div>
      <div className="aura-plan-card-body">
        <MarkdownBody source={markdown} />
      </div>
    </div>
  );
}

/** A small speech-bubble-with-question glyph for the question card header. */
function QuestionGlyph() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h8a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11H4a1.5 1.5 0 0 1-1.5-1.5z" />
      <path d="M6.6 6.1a1.4 1.4 0 0 1 2.6.6c0 .9-1.2 1.1-1.2 1.8" />
      <circle cx={8} cy={9.4} r={0.5} fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A small checklist glyph for the plan card header. */
function PlanGlyph() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 4.5l1.2 1.2L6.4 3.5M3 11l1.2 1.2L6.4 10M8.5 5h4.5M8.5 11h4.5" />
    </svg>
  );
}
