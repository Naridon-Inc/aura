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
//! the rest fold into the roll-up. Questions are drawn as the shared question
//! request and plans as the shared plan review.

import { describeTool } from "./toolDescribe";
import { MarkdownBody } from "./Markdown";
import type { AskView, StreamBlock } from "./types";
import { PlanReview } from "../../ui/chat-decisions";
import { QuestionRecord } from "../../chat/QuestionRecord";

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

/** The brain asked you something — drawn as the shared question request.
 *  Settled turns are a RECORD of what was asked (the answer already followed in
 *  the conversation), so there are no dead Skip/Continue buttons and nothing to
 *  pick — the value is that the question is unmissable, not buried. */
function QuestionCard({ ask }: { ask: AskView }) {
  return (
    <QuestionRecord
      title={ask.questions.length > 1 ? "Questions" : "Question"}
      questions={ask.questions.map((q, qi) => ({
        id: String(qi),
        prompt: q.question,
        multiple: q.multiSelect,
        options: q.options.map((o, oi) => ({
          id: String(oi),
          label: o.label,
          description: o.description,
        })),
      }))}
    />
  );
}

/** A plan the brain proposed (ExitPlanMode), drawn as the shared plan review
 *  and rendered as real markdown — headings, lists, code through the prose
 *  engine, never a raw `{plan:"…"}` blob. */
function PlanCard({ markdown }: { markdown: string }) {
  return (
    <PlanReview className="chat-plan-review" title="Plan" text={markdown}>
      <MarkdownBody source={markdown} />
    </PlanReview>
  );
}
