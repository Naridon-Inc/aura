//! Steps of a SETTLED assistant turn.
//!
//! The live turn streams every read, edit and command as its own row; once
//! the answer is in, those rows fold away so the answer leads. Leading
//! reasoning keeps its own "Thought for Ns" line, and the steps after it
//! become one group ("4 tool calls, 1 message") that opens to the same rows
//! in the order they happened.

import { ToolCard } from "./ToolCard";
import { ReasoningBlock } from "./ReasoningBlock";
import type { StreamBlock } from "./types";
import { MarkdownBody } from "./Markdown";
import { MessageBody } from "../../ui/message";
import { ToolGroup } from "../../ui/transcript-patterns";


/** A finished turn's steps, the way they read once the answer is in:
 *  reasoning that led the turn sits on its own line ("Thought for Ns"), and
 *  every step after it folds into one group that counts its tool calls and
 *  the short notes written between them. Opening the group lists the same
 *  rows the live turn showed, in order. The caller renders the answer prose
 *  itself. */
export function TurnActivity({ blocks }: { blocks: StreamBlock[] }) {
  const firstStep = blocks.findIndex((b) => b.kind !== "reasoning");
  const lead = firstStep < 0 ? blocks : blocks.slice(0, firstStep);
  const steps = firstStep < 0 ? [] : blocks.slice(firstStep);
  const tools = steps.filter((b) => b.kind === "tool").length;
  const notes = steps.filter(
    (b) => (b.kind === "text" || b.kind === "reasoning") && b.text.trim(),
  ).length;
  return (
    <>
      {lead.map((b, i) =>
        b.kind === "reasoning" ? <ReasoningBlock key={i} text={b.text} streaming={false} /> : null,
      )}
      {tools > 0 ? (
        <ToolGroup count={tools} messages={notes}>
          {steps.map((b, i) => <TurnStep key={stepKey(b, i)} block={b} />)}
        </ToolGroup>
      ) : (
        steps.map((b, i) => <TurnStep key={stepKey(b, i)} block={b} />)
      )}
    </>
  );
}

function stepKey(block: StreamBlock, index: number): string | number {
  return block.kind === "tool" && block.tool_use_id ? block.tool_use_id : index;
}

/** One row inside a finished turn's group. */
function TurnStep({ block }: { block: StreamBlock }) {
  if (block.kind === "reasoning") {
    return <ReasoningBlock text={block.text} streaming={false} />;
  }
  if (block.kind === "tool") {
    return <ToolCard name={block.name} input={block.input} result={block.result} />;
  }
  if (block.kind === "text" && block.text.trim()) {
    return (
      <MessageBody className="ui-turn-step-note">
        <MarkdownBody source={block.text} />
      </MessageBody>
    );
  }
  return null;
}
