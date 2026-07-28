// Live status chip for an agent PTY session, driven by OSC 777
// cli-agent events emitted by the agent's plugin scripts. Shows
// `idle` / `working` / `blocked: <reason>` / `done` so the user
// doesn't have to scrape the terminal to know what state the agent
// is in.
//
// Pairs with AuraChip (intent / snapshot / audit counts) on the
// AgentSurface header.

import { useAgentEvent } from "../../lib/agentEventStore";
import { liveActivityText } from "../../lib/agentActivity";
import type { CliAgentEvent, CliAgentStatus } from "../../lib/api";

type Props = {
  sessionId: string;
  /** When false (PTY exited), render nothing — the status is moot. */
  visible: boolean;
};

export function AgentStatusChip({ sessionId, visible }: Props) {
  const { status, last, title } = useAgentEvent(sessionId);
  if (!visible) return null;
  if (status.kind === "idle") return null; // pre-event — don't surface noise

  const palette = paletteFor(status);
  return (
    <div
      title={tooltipFor(status, last?.plugin_version)}
      className="inline-flex items-center gap-1.5 px-2 h-6 rounded-md text-[10.5px] font-medium transition-colors"
      style={{
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        maxWidth: 220,
      }}
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ background: palette.dot }}
      />
      <span className="truncate">{labelFor(status, last, title)}</span>
    </div>
  );
}

function labelFor(
  s: CliAgentStatus,
  last: CliAgentEvent | null,
  title: string | null,
): string {
  switch (s.kind) {
    case "in_progress":
      // The agent's own native title if it set one ("Refactoring auth"),
      // else our hook-derived phrase ("Editing api.ts"), else the verb.
      return liveActivityText(title, last) ?? "working";
    case "blocked":
      return s.summary;
    case "success":
      return "done";
    case "idle":
      return "idle";
  }
}

function tooltipFor(s: CliAgentStatus, pluginVersion?: string): string {
  const head = (() => {
    switch (s.kind) {
      case "in_progress":
        return "Agent is processing your prompt.";
      case "blocked":
        return `Agent is waiting: ${s.summary}`;
      case "success":
        return s.response
          ? `Agent finished. Last reply: ${s.response.slice(0, 120)}`
          : "Agent finished its turn.";
      case "idle":
        return "No structured events yet.";
    }
  })();
  return pluginVersion ? `${head}\nplugin v${pluginVersion}` : head;
}

function paletteFor(s: CliAgentStatus) {
  switch (s.kind) {
    case "in_progress":
      // Work in flight. The chip itself stays quiet; only the dot carries the
      // accent, so a running agent reads as live without shouting.
      return {
        bg: "var(--color-pill-bg)",
        fg: "var(--color-text-2)",
        border: "var(--color-composer-border)",
        dot: "var(--color-accent)",
      };
    case "blocked":
      // The one state that needs the user — it gets the full amber chip.
      // Amber is the pack's attention slot; using the accent here made a
      // blocked agent look identical to a running one (the dot above) and
      // to every selected row on screen.
      return {
        bg: "color-mix(in srgb, var(--color-amber) 12%, transparent)",
        fg: "var(--color-amber)",
        border: "color-mix(in srgb, var(--color-amber) 40%, transparent)",
        dot: "var(--color-amber)",
      };
    case "success":
      // Finished, nothing to do — off the colour ramp entirely.
      return {
        bg: "var(--color-pill-bg)",
        fg: "var(--color-text-3)",
        border: "var(--color-composer-border)",
        dot: "var(--color-accent-green)",
      };
    default:
      return {
        bg: "var(--color-pill-bg)",
        fg: "var(--color-text-3)",
        border: "var(--color-composer-border)",
        dot: "var(--color-text-5)",
      };
  }
}
