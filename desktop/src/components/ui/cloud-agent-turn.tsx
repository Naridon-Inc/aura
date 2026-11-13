// An agent's turn in a shared cloud chat, labelled with the agent's own icon
// and name ("Claude", "Codex") so a reply can never be read as a person's.

import type { ReactNode } from "react";

import { AgentIcon } from "./agent-icon";
import "./cloud-agent-turn.css";

export function SharedAgentAttribution({
  name,
  provider,
  time,
  children,
}: {
  /** "Claude", "Codex", or "Agent" when the workspace doesn't say. */
  name: string;
  /** Picks the icon; empty draws the plain agent mark. */
  provider: string;
  time?: string;
  children: ReactNode;
}) {
  return (
    <div className="ui-shared-agent">
      <header>
        <AgentIcon provider={provider || "agent"} size={14} />
        <strong>{name}</strong>
        <span>Agent</span>
        {time && <time>{time}</time>}
      </header>
      {children}
    </div>
  );
}
