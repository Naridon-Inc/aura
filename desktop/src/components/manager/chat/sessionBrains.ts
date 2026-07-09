//! Which brains ran this conversation — the "session details" you reach for
//! when you've been switching models mid-thread.
//!
//! Every assistant turn records the brain that produced it (`ChatTurn.brain`),
//! so the whole picture of "Claude did 6 turns, then Gemini took over for 3,
//! then back to Claude" is already in the persisted chat. This folds that into
//! a compact per-brain tally — first-seen order, turn counts, last-active time,
//! and how many times the thread changed hands — for the session-details panel
//! the brain-handoff divider opens. Pure + deterministic; no backend call.

import type { ChatTurn } from "../../../lib/api";
import { humanizeBrainId } from "./StatusLine";

/** One brain's footprint across the conversation. */
export type SessionBrainUse = {
  brain: string;
  label: string;
  turns: number;
  lastAt: number;
};

/** The conversation's model story, for the session-details panel. */
export type SessionBrainsSummary = {
  /** Brains in the order they first ran, each with its turn count. */
  brains: SessionBrainUse[];
  /** How many times the thread changed brains across assistant turns. */
  switches: number;
  /** Assistant turns that recorded a brain. */
  totalTurns: number;
  /** Epoch seconds of the first / last brain-bearing turn (for the span). */
  firstAt: number | null;
  lastAt: number | null;
};

/** Fold a chat into its per-brain summary, or `null` when no assistant turn has
 *  recorded a brain yet (a brand-new or all-CLI-pre-attribution thread). */
export function summarizeSessionBrains(
  chat: ChatTurn[],
): SessionBrainsSummary | null {
  const order: string[] = [];
  const map = new Map<string, SessionBrainUse>();
  let switches = 0;
  let prevBrain: string | null = null;
  let total = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;

  for (const t of chat) {
    if (t.role === "user") continue;
    const brain = t.brain ?? null;
    if (!brain) continue;
    total += 1;
    if (firstAt === null) firstAt = t.at;
    lastAt = t.at;
    let use = map.get(brain);
    if (!use) {
      use = { brain, label: humanizeBrainId(brain), turns: 0, lastAt: t.at };
      map.set(brain, use);
      order.push(brain);
    }
    use.turns += 1;
    use.lastAt = t.at;
    if (prevBrain !== null && prevBrain !== brain) switches += 1;
    prevBrain = brain;
  }

  if (map.size === 0) return null;
  return {
    brains: order.map((b) => map.get(b) as SessionBrainUse),
    switches,
    totalTurns: total,
    firstAt,
    lastAt,
  };
}
