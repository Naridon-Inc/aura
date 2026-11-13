// The running agent's own plan, as it revises it.
//
// OpenCode and pi both publish a plan over the session's update stream and
// restate it in full on every change — so this replaces rather than grows,
// and it is the agent's *current* intention, not a history of intentions.
// It is session state, not transcript: it belongs beside the composer with
// the live strips, not inside the conversation where it would be replayed
// on reload as if it had been said.

import type { AgentPlanEntry } from "../../../lib/api";
import { ToolCall } from "../../ui/message";
import { StepLoader } from "./ToolDetail";
import type { ToolStep } from "./types";

/** The agent's status words onto the chat's own to-do states: in progress is
 *  the only line the eye should catch; done is quiet, pending is quieter. */
function stepStatus(status: string): ToolStep["status"] {
  const s = status.toLowerCase();
  if (s === "completed" || s === "done") return "completed";
  if (s === "in_progress" || s === "in-progress" || s === "active") return "in_progress";
  return "pending";
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
  const steps = plan.map((entry) => ({ label: entry.content, status: stepStatus(entry.status) }));
  const done = steps.filter((s) => s.status === "completed").length;
  return (
    // The agent restates the whole plan on every change and gives its lines
    // no ids, so the list re-renders wholesale; the row itself stays mounted,
    // so folding it holds across revisions.
    <ToolCall
      title={`${agentLabel ? `${agentLabel}'s plan` : "Plan"} · ${done} of ${plan.length} done`}
      status={done === plan.length ? "done" : "running"}
      defaultOpen
    >
      <StepLoader steps={steps} />
    </ToolCall>
  );
}
