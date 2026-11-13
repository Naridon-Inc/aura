import type { ReactNode } from "react";
import { AgentIcon } from "../../agent/AgentIcon";
import { humanizeBrainId, brainAgentId } from "./StatusLine";

// #2 — cohesive assistant-turn group. A CLI-wrapper brain persists one
// logical reply as MANY contiguous `manager` turns; left ungrouped they read
// as N scattered "Claude" bubbles. This wraps a contiguous run in ONE block:
// a single agent header (AgentIcon + name) up top, then the member turns
// stacked beneath it. Each member's own answer prose + step roll-up still
// render through ChatBubble/TurnActivity — the group only adds the shared
// header + a quiet left rail so the run reads as one turn, not a pile.
//
// Reuses the existing `.aura-msg-who` header family (avatar + name) so the
// header matches the rest of the chat's tone; the rail is a faint hairline,
// tokens only — never a new color. The header brain is resolved from the
// first member that recorded one (falling back to the generic Aura mark).
export function AssistantTurnGroup({
  headerBrain,
  children,
}: {
  headerBrain: string | null;
  children: ReactNode;
}) {
  const iconId = headerBrain ? brainAgentId(headerBrain) : "aura-manager";
  const name = headerBrain ? humanizeBrainId(headerBrain) : "Aura";
  return (
    <section className="ui-chat-agent-group" aria-label={`${name || "Aura"} reply`}>
      <div className="ui-chat-agent-header">
        <AgentIcon agentId={iconId} size={14} />
        <span>{name || "Aura"}</span>
      </div>
      {children}
    </section>
  );
}
