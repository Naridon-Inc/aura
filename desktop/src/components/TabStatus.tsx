// What a tab says about the thing behind it — is it working, is it waiting
// for you, is it done.
//
// This lived inside the global `Tabs` strip, written twice (once for agent
// tabs, once for Aura chat tabs) and reachable from nowhere else. The strip
// that draws the top of the window nearly always is the per-pane one in
// WorkSurface, and it had none of it: four agents open, one of them stopped
// dead on a permission prompt, and the row of tabs said nothing. The signal
// that matters most on a tab — "this one needs you" — was on the tab bar you
// only see before you have ever opened Pages.
//
// So it lives here, once, and both strips render it.

import type { AgentTab } from "../lib/editorStore";
import { useAgentEvent } from "../lib/agentEventStore";
import { streamChannel, useAllStreamStates } from "../lib/agentStreamStore";
import { useManagerSession, useManagerTurnsTick } from "../lib/managerStore";
import { isSessionWorking } from "../lib/useFleetActivity";
import { AgentIcon, type AgentRunState } from "./agent/AgentIcon";
import { AsciiSpinner } from "./ui/ascii-spinner";

/** "Is this agent working right now?" — covers BOTH tab modes: stream tabs
 *  carry it on the channel's `running` flag, pty/chat tabs on the OSC status.
 *  A hook rather than a value passed down, because both readings need a live
 *  subscription and both strips render their tabs from inside a `.map`. */
function useAgentRunState(tab: AgentTab): {
  run: AgentRunState;
  title: string | undefined;
} {
  const { status } = useAgentEvent(tab.sessionId);
  const streamStates = useAllStreamStates();
  const working =
    tab.mode === "stream"
      ? !!streamStates.get(streamChannel(tab.agentId, tab.repoRoot))?.running
      : status.kind === "in_progress";
  if (tab.attention) return { run: "attention", title: "Waiting for your input" };
  if (working) return { run: "working", title: "Working" };
  // `blocked` is the agent stopped on something it can't answer itself — the
  // same "this one needs you" as `attention`, arriving by a different route.
  if (status.kind === "blocked") return { run: "attention", title: "Blocked" };
  return { run: "idle", title: undefined };
}

/** The mark an agent tab wears, with what the agent is doing folded INTO it.
 *
 *  The state used to sit beside the mark as an amber dot plus a spinner —
 *  three glyphs for one fact, and the amber read as an error. Now the agent's
 *  own icon breathes while it works and wears a ring when it wants you, so
 *  the mark you already recognise is the status light. */
export function AgentTabMark({
  tab,
  agentId,
  size = 11,
}: {
  tab: AgentTab;
  /** The brand to draw. Falls back to the tab's own agent id. */
  agentId?: string;
  size?: number;
}) {
  const { run, title } = useAgentRunState(tab);
  return (
    <AgentIcon
      agentId={agentId ?? tab.agentId}
      size={size}
      run={run}
      runTitle={title}
    />
  );
}

/** Whether a coding-agent tab is asking for something. Callers use it to bold
 *  the label — the dot above is small, and a tab that needs you should read
 *  as different from three tabs that don't before you look for the dot. */
export function agentTabAwaits(tab: AgentTab): boolean {
  return !!tab.attention;
}

/** Live status mark for an Aura chat tab. The native brain awaits a human
 *  just like a CLI agent does — when it has raised a question
 *  (AskUserQuestion) or parked a plan for review — but it has no terminal BEL
 *  to ride on, so this is the only cue a backgrounded chat gets. */
export function ManagerTabStatus({ sessionId }: { sessionId: string }) {
  const session = useManagerSession(sessionId);
  // `isManagerTurnInFlight` (inside `isSessionWorking`) is a plain Set read, so
  // it needs a re-render to be noticed — without this the loader waits on
  // whatever else happens to re-render the tab. Same subscription the sidebar
  // uses.
  useManagerTurnsTick();
  const awaiting = !!(session?.pending_question || session?.pending_plan);
  // A native-brain turn in flight is the Manager's equivalent of a CLI agent's
  // `in_progress`. `isSessionWorking` rather than the raw `running` flag: that
  // flag is persisted and nothing clears it when the process holding the turn
  // dies, so reopening a session whose turn was killed used to spin forever.
  const working =
    !awaiting && !!session && isSessionWorking(session, Date.now() / 1000);

  if (awaiting) {
    return (
      <span
        title="Aura is waiting for your input"
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        // Same attention amber as the agent tabs beside it — the chat row must
        // not read differently from the rows next to it.
        style={{ background: "var(--color-amber)" }}
      />
    );
  }
  if (working) {
    return (
      <span title="Working" className="flex-shrink-0">
        <AsciiSpinner className="text-2xs" />
      </span>
    );
  }
  return null;
}
