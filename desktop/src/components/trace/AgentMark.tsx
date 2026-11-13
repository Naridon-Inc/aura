// An agent's icon with its name for screen readers and on hover.

import { agentDisplayLabel, canonicalAgentId } from "../../lib/agentIdentity";
import { AgentIcon } from "../ui/agent-icon";

export function AgentMark({ agentId }: { agentId: string }) {
  const canonical = canonicalAgentId(agentId);
  const label = agentDisplayLabel(canonical);
  return (
    <span role="img" aria-label={label} title={label} className="ui-trace-agent">
      <AgentIcon provider={canonical || agentId} />
    </span>
  );
}
