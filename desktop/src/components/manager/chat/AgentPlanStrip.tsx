// The running agent's own plan, as it revises it.
//
// OpenCode and pi both publish a plan over the session's update stream and
// restate it in full on every change — so this replaces rather than grows,
// and it is the agent's *current* intention, not a history of intentions.
// It is session state, not transcript: it belongs beside the composer with
// the live strips, not inside the conversation where it would be replayed
// on reload as if it had been said.

import type { AgentPlanEntry } from "../../../lib/api";

/** One row's glyph + how loudly it reads. `in_progress` is the only line
 *  the eye should catch; done is quiet, pending is quieter still. */
function toneFor(status: string): { mark: string; color: string; strike: boolean } {
  const s = status.toLowerCase();
  if (s === "completed" || s === "done") {
    return { mark: "✓", color: "var(--color-text-4)", strike: true };
  }
  if (s === "in_progress" || s === "in-progress" || s === "active") {
    return { mark: "▸", color: "var(--color-accent)", strike: false };
  }
  return { mark: "·", color: "var(--color-text-3)", strike: false };
}

function isDone(status: string): boolean {
  const s = status.toLowerCase();
  return s === "completed" || s === "done";
}

export function AgentPlanStrip({
  plan,
  agentLabel,
}: {
  plan: AgentPlanEntry[];
  /** The agent whose plan this is — "OpenCode", "Pi". Named because this
   *  sits next to Aura's own plan card, and whose plan it is decides who
   *  you talk to about changing it. */
  agentLabel?: string | null;
}) {
  if (plan.length === 0) return null;
  const done = plan.filter((e) => isDone(e.status)).length;
  return (
    <div
      className="aura-block flex flex-col gap-1 px-2.5 py-1.5"
      style={{ background: "var(--color-bg-1)", margin: "8px 0" }}
    >
      <div className="flex items-center gap-1.5">
        <span className="aura-block-label shrink-0">
          {agentLabel ? `${agentLabel} PLAN` : "PLAN"}
        </span>
        <span
          className="shrink-0"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "10.5px",
            color: "var(--color-text-3)",
            letterSpacing: "0.04em",
          }}
        >
          {done}/{plan.length} DONE
        </span>
      </div>
      <ul className="flex flex-col gap-0.5 m-0 p-0 list-none">
        {plan.map((entry, i) => {
          const tone = toneFor(entry.status);
          return (
            <li
              // The agent restates the whole plan on every change and gives
              // its lines no ids, so position is the only stable handle
              // there is — and a replaced list re-renders wholesale anyway.
              key={`${i}:${entry.content}`}
              className="flex items-baseline gap-1.5 min-w-0"
              style={{
                fontSize: "11.5px",
                color: tone.color,
                textDecoration: tone.strike ? "line-through" : undefined,
              }}
            >
              <span
                className="shrink-0"
                style={{ fontFamily: "var(--font-mono)", fontSize: "10.5px" }}
              >
                {tone.mark}
              </span>
              <span className="truncate">{entry.content}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
