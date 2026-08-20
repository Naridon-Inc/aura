// "Fix with agent" — closes the review loop. A review comment (or any
// finding) is handed to the user's chosen agent — the Aura Manager or any
// installed CLI agent (Claude / Codex / Gemini …) — seeded with a prompt
// that already carries the file, line, and the comment text. Reuses the
// `aura:hand-task-to-agent` window event the App already listens for
// (App.tsx onHand → runAgentPrompt), so the agent opens with the prompt.
// No taskId is sent: this is a fix, not a task claim.

import { ChevronDown, Wrench } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";

import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { AgentIcon } from "./AgentIcon";
import { useAgents, type Agent } from "../../lib/agents";

type Props = {
  /** The prompt the agent opens with — the caller bakes in the file, line,
   *  and the comment/finding text. */
  prompt: string;
  /** Compact icon-only trigger, for dense action rows (e.g. a thread card). */
  iconOnly?: boolean;
  size?: "xs" | "sm" | "default";
  label?: string;
};

export function FixWithAgentButton({
  prompt,
  iconOnly = false,
  size = "xs",
  label = "Fix with agent",
}: Props) {
  const { agents, loading } = useAgents();

  const hand = (agent: Agent) => {
    if (!agent.available) return;
    window.dispatchEvent(
      new CustomEvent("aura:hand-task-to-agent", {
        detail: { agent: agent.id, label: agent.label, prompt },
      }),
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {iconOnly ? (
          <button
            type="button"
            title={label}
            aria-label={label}
            className="w-6 h-6 rounded flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-state-hover transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            <Wrench className="h-3.5 w-3.5" />
          </button>
        ) : (
          <Button size={size} variant="ghost" className="gap-1.5">
            <Wrench className="h-3.5 w-3.5" />
            {label}
            <ChevronDown className="h-3 w-3 opacity-70" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px] text-sm">
        <DropdownMenuLabel>Hand this to…</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {agents.map((agent) => (
          <DropdownMenuItem
            key={agent.id}
            disabled={!agent.available}
            onSelect={() => hand(agent)}
            className="gap-2.5"
          >
            <AgentIcon agentId={agent.id} label={agent.label} size={16} />
            <span className="flex-1 truncate">{agent.label}</span>
            {!agent.available && (
              <DropdownMenuShortcut>not installed</DropdownMenuShortcut>
            )}
          </DropdownMenuItem>
        ))}
        {loading && agents.length <= 1 && (
          <DropdownMenuItem disabled className="gap-1.5 text-text-4">
            <AsciiSpinner />
            Finding agents…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
