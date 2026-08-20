// Tiny "agent fleet" indicator for a workspace tile in the rail.
// Shows up to 4 small dots — one per agent currently running in this
// workspace, colored by agent kind (claude/gemini/codex/cursor/manager).
// "+N" when there are more than 4. Goes away entirely when no agent
// is running, so the rail stays calm at idle.
//
// Pure render — caller passes the live agent tab list. No polling here.

import type { AgentTab } from "../lib/editorStore";

type Props = {
  tabs: AgentTab[];
  /** Optional pulse — when at least one agent is `running`, the wrapper
   *  gets a soft outline so the eye catches it from across the screen. */
  anyRunning?: boolean;
};

export function WorkspaceFleetPips({ tabs, anyRunning }: Props) {
  if (tabs.length === 0) return null;
  const shown = tabs.slice(0, 4);
  const more = tabs.length - shown.length;
  return (
    <span
      className="absolute pointer-events-none flex items-center gap-[2px]"
      style={{ bottom: 2, right: 2 }}
    >
      {shown.map((t) => (
        <span
          key={t.sessionId}
          title={t.agentLabel}
          className={`block rounded-full ${anyRunning ? "ring-1 ring-bg-1" : ""}`}
          style={{
            width: 5,
            height: 5,
            background: agentTone(t.agentId),
          }}
        />
      ))}
      {more > 0 && (
        <span
          className="text-2xs font-semibold tabular-nums text-text-3 leading-none"
          style={{ marginLeft: 1 }}
        >
          +{more}
        </span>
      )}
    </span>
  );
}

function agentTone(agentId: string): string {
  // Brand-tone-ish palette. Falls back to neutral text for unknown ids.
  switch (agentId) {
    case "claude":
      return "var(--color-amber, #d4a017)";
    case "gemini":
      return "var(--color-blue, #4a8cff)";
    case "codex":
      return "var(--color-green, #4ade80)";
    case "cursor":
      return "var(--color-violet, #a78bfa)";
    case "aura-manager":
      return "var(--color-text-1)";
    default:
      return "var(--color-text-3)";
  }
}
