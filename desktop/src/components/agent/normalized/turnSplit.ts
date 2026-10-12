//! Which part of a finished agent turn is the answer, and which part is the
//! work that produced it.
//!
//! An agent streams one flat run of blocks: a thought, a command, a line of
//! narration about what it is doing next, another command, and eventually the
//! thing it actually wants to tell you. Rendered in emission order that reads
//! as a wall — the answer is somewhere at the bottom of a column of step rows,
//! commands and half-sentences, and the eye has nowhere to land.
//!
//! The manager chat already settled this for its own turns: a finished turn
//! shows its answer, and everything it did on the way folds into one quiet
//! "Worked through N steps" line that expands (`TurnActivity`). This is the
//! same rule applied to an agent's flat stream, which needs a split the
//! manager's turn shape gives it for free.
//!
//! The rule is the trailing run of prose. An agent's last words are what it
//! concluded; prose in the middle is narration *about* the work ("pushing it
//! now, then I'll re-check"), which belongs with the work. Nothing is dropped
//! — narration moves into the expandable list rather than off the screen.

import type { StreamBlock } from "../../manager/chat/types";

/** A finished turn, cut into the part that answers and the part that works. */
export type TurnSplit = {
  /** Reasoning, tool calls and any narration between them, in emission order.
   *  Empty when the turn was pure prose. */
  steps: StreamBlock[];
  /** The trailing prose run — what the agent finished by saying. Empty when
   *  the turn ended on a command rather than a sentence. */
  answer: StreamBlock[];
};

/** Whether a block is work rather than words. */
function isStep(b: StreamBlock): boolean {
  return b.kind === "reasoning" || b.kind === "tool";
}

/** Split a settled turn's blocks into its step-run and its answer.
 *
 *  A turn that never did anything — no thought, no tool — has no step-run at
 *  all and is returned as pure answer, so a plain reply is never dressed up
 *  with a roll-up line saying it worked through nothing.
 */
export function splitSettledTurn(blocks: StreamBlock[]): TurnSplit {
  if (!blocks.some(isStep)) return { steps: [], answer: [...blocks] };

  // Walk back over the trailing prose. Stopping at the last step is what makes
  // this the *trailing* run rather than every text block in the turn.
  let cut = blocks.length;
  while (cut > 0 && blocks[cut - 1]!.kind === "text") cut -= 1;

  return { steps: blocks.slice(0, cut), answer: blocks.slice(cut) };
}
