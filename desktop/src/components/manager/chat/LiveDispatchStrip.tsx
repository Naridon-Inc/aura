import { useMemo } from "react";
import type { RibbonEntry } from "../../../lib/api";
import { getAgentIdentity } from "../../../lib/agentIdentity";
import { AgentIcon } from "../../agent/AgentIcon";
import { Badge } from "../../ui/badge";
import { ChatStatus } from "../../ui/message";
import "../../ui/live-strips.css";

// ─── Live Dispatch Strip ──────────────────────────────────────────────
// Derives currently-running task dispatches from the ribbon. A task is
// "in flight" once `task_dispatched` fires and stays in flight until
// `task_completed` or `task_failed` arrives for the same id. Renders a
// working chat status with one agent badge per dispatch; hides itself when
// nothing is active so it doesn't squat at the top of the chat.

type LiveDispatch = {
  task_id: number;
  agent_id: string;
  channel: string;
  at: number;
};

function collectLiveDispatches(ribbon: RibbonEntry[]): LiveDispatch[] {
  const active = new Map<number, LiveDispatch>();
  for (const entry of ribbon) {
    const ev = entry.event;
    if (ev.kind === "task_dispatched") {
      active.set(ev.task_id, {
        task_id: ev.task_id,
        agent_id: ev.agent_id,
        channel: ev.channel,
        at: entry.at,
      });
    } else if (ev.kind === "task_completed" || ev.kind === "task_failed") {
      active.delete(ev.task_id);
    }
  }
  return Array.from(active.values()).sort((a, b) => a.at - b.at);
}

export function LiveDispatchStrip({ ribbon }: { ribbon: RibbonEntry[] }) {
  const dispatches = useMemo(() => collectLiveDispatches(ribbon), [ribbon]);
  if (dispatches.length === 0) return null;
  return (
    <ChatStatus state="working">
      <span className="ui-live-dispatch">
        <span>{dispatches.length} dispatched</span>
        {dispatches.map((d) => (
          <DispatchChip key={d.task_id} dispatch={d} />
        ))}
      </span>
    </ChatStatus>
  );
}

function DispatchChip({ dispatch }: { dispatch: LiveDispatch }) {
  const identity = getAgentIdentity(dispatch.agent_id);
  return (
    <Badge
      variant="outline"
      className="ui-live-dispatch-chip"
      title={`${identity.label} · task #${dispatch.task_id} · ${dispatch.channel}`}
    >
      <AgentIcon agentId={identity.id} size={11} />
      {identity.tag}
      <small>#{dispatch.task_id}</small>
    </Badge>
  );
}
