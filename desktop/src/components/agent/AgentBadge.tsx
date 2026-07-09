// AgentBadge — the one reusable "which agent" chip: brand logo (AgentIcon)
// + friendly label (agentDisplayLabel). Replaces the bare-text chips that
// rendered raw agent ids as plain strings across Sessions, the session
// detail, Intent ↔ AST and Overview. One skin everywhere so an agent reads
// the same in every surface (the user: "use claude code logo and all in
// places").

import { AgentIcon } from "./AgentIcon";
import { agentDisplayLabel, canonicalAgentId } from "../../lib/agentIdentity";
import { cn } from "../../lib/utils";

type Props = {
  agentId: string;
  /** Icon size in px (label scales with the surrounding text). */
  size?: number;
  /** Hide the text label and show only the brand mark. */
  iconOnly?: boolean;
  /** Override the resolved label (rare — when a caller already normalised). */
  label?: string;
  className?: string;
};

export function AgentBadge({
  agentId,
  size = 13,
  iconOnly = false,
  label,
  className,
}: Props) {
  // Resolve the generic "MCP Agent" label (and other aliases) to the real
  // coding agent so both the brand mark and the text agree — without this the
  // icon falls back to a stacked "MCP AGENT" text monogram.
  const canonical = canonicalAgentId(agentId);
  const text = label ?? agentDisplayLabel(canonical);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded bg-bg-2 px-1.5 py-px text-[10px] text-text-2",
        className,
      )}
      title={text}
    >
      <AgentIcon agentId={canonical} label={text} size={size} />
      {iconOnly ? null : <span className="truncate">{text}</span>}
    </span>
  );
}
