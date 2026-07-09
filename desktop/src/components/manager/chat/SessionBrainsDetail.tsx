//! Session details — the brains that ran this conversation, revealed from the
//! brain-handoff divider.
//!
//! When you've been switching models mid-thread (Claude → Gemini → Kimi …) it's
//! easy to lose track of who did what. This panel is the answer to "wait, which
//! models worked this session?" — a compact per-brain breakdown (logo, name,
//! how many turns each ran) plus the headline: how many models, how many times
//! the thread changed hands, and the wall-clock span. All from the persisted
//! chat (`ChatTurn.brain` / `.at`); no backend call, nothing faked.

import { AgentIcon } from "../../agent/AgentIcon";
import type { ChatTurn } from "../../../lib/api";
import { brainAgentId } from "./StatusLine";
import { summarizeSessionBrains } from "./sessionBrains";

/** Compact "session details" card: which brains ran this thread + the headline
 *  counts. Renders nothing when no turn has recorded a brain yet. */
export function SessionBrainsDetail({ chat }: { chat: ChatTurn[] }) {
  const summary = summarizeSessionBrains(chat);
  if (!summary) return null;
  const { brains, switches, totalTurns, firstAt, lastAt } = summary;
  const span = firstAt != null && lastAt != null ? humanizeSpan(lastAt - firstAt) : null;

  return (
    <div
      className="mx-auto mb-3 max-w-[460px] overflow-hidden"
      style={{
        background: "var(--color-bg-1)",
        border: "1px solid var(--color-line)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <div
        className="t-2xs t-ui px-3 pt-2 pb-1.5"
        style={{ color: "var(--color-text-3)" }}
      >
        Session details · models that worked this conversation
      </div>
      <div className="flex flex-col">
        {brains.map((b) => (
          <div
            key={b.brain}
            className="flex items-center gap-2 px-3 py-1.5 min-w-0"
          >
            <AgentIcon agentId={brainAgentId(b.brain)} size={14} />
            <span
              className="min-w-0 truncate t-xs"
              style={{ color: "var(--color-text-1)" }}
            >
              {b.label}
            </span>
            <span
              className="ml-auto shrink-0 tabular-nums t-2xs"
              style={{ color: "var(--color-text-3)", fontFamily: "var(--font-mono)" }}
            >
              {b.turns === 1 ? "1 turn" : `${b.turns} turns`}
            </span>
          </div>
        ))}
      </div>
      <div
        className="t-2xs px-3 pt-1.5 pb-2 border-t"
        style={{ color: "var(--color-text-3)", borderColor: "var(--color-line-soft)" }}
      >
        {brains.length === 1
          ? "1 model"
          : `${brains.length} models`}
        {" · "}
        {totalTurns === 1 ? "1 turn" : `${totalTurns} turns`}
        {switches > 0 && ` · ${switches === 1 ? "1 handoff" : `${switches} handoffs`}`}
        {span && ` · spanned ${span}`}
      </div>
    </div>
  );
}

/** Coarse human span for the session length — minutes / hours / days, no
 *  false precision. */
function humanizeSpan(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return mins === 1 ? "1 minute" : `${mins} minutes`;
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.round(seconds / 86400);
  return days === 1 ? "1 day" : `${days} days`;
}
