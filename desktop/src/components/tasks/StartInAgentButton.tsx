// "Start in agent" — the affordance that turns a task into work. The user
// picks an agent (Aura Manager chat, or a CLI agent like Claude Code) and the
// task opens IN that agent, seeded with `buildTaskAgentPrompt`. It dispatches
// the `aura:hand-task-to-agent` window event the App already listens for: the
// handler runs the chosen agent with the prompt and claims the task as that
// agent. The default selection follows the task's pinned agent (its
// `agent_assignee` or a prior local assignment), falling back to the Manager.
//
// Beyond spawning a fresh agent, the picker lists existing sessions to hand the
// task to instead of booting a new one, in two tiers:
//   1. LIVE PTYs in this repo (an ongoing Claude Code / Gemini / Codex ADE
//      spawned) — the prompt is injected straight into that running input.
//   2. RECENT on-disk Claude sessions (this repo + sibling worktrees). Picking
//      one resumes it (`claude --resume`) with the task prompt. This is how an
//      externally-running Claude — one ADE didn't spawn, so it's absent from
//      tier 1 — still shows up: its freshly-written transcript lands here.

import { useState } from "react";
import { Bot, ChevronDown, History, Radio } from "lucide-react";

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
import { AgentIcon } from "../agent/AgentIcon";
import { useAgents, type Agent } from "../../lib/agents";
import { ticketKey, useAgentAssignments } from "../../lib/agentAssignments";
import { buildTaskAgentPrompt } from "./taskPrompt";
import {
  api,
  type ClaudeSession,
  type LiveAgentSession,
  type Task,
} from "../../lib/api";

type Props = {
  task: Task;
  repoRoot: string;
  /** Direct sub-tasks, folded into the prompt as a checklist. */
  childTasks?: Task[];
  /** Fired after dispatch — used to close the task overlay so the agent
   *  surface (manager chat / CLI tab) is what the user lands on. */
  onStarted?: () => void;
  size?: "xs" | "sm" | "default";
};

export function StartInAgentButton({
  task,
  repoRoot,
  childTasks = [],
  onStarted,
  size = "xs",
}: Props) {
  const { agents, loading } = useAgents();
  const [assignments, setAssignment] = useAgentAssignments(repoRoot);
  // Live PTY sessions in this repo, fetched lazily when the menu opens.
  const [live, setLive] = useState<LiveAgentSession[] | null>(null);
  // Recent on-disk Claude sessions (resumable), fetched alongside the live
  // list. Capped to the most-recent few so the menu stays scannable.
  const [recent, setRecent] = useState<ClaudeSession[] | null>(null);

  // Pinned agent for this task: explicit AI owner, else a prior local pick.
  const pinnedId = task.agent_assignee || assignments[ticketKey(task.id)] || null;

  // Resolve an agent_id to its discovered Agent (for icon + label).
  const agentFor = (id: string): Agent | undefined =>
    agents.find((a) => a.id === id);

  const labelFor = (sess: LiveAgentSession): string => {
    const a = agentFor(sess.agent_id);
    const base = a?.label || sess.agent_id;
    const t = sess.title?.trim();
    return t ? `${base} · ${t}` : base;
  };

  const refreshSessions = () => {
    api
      .agentPtyList(repoRoot)
      .then(setLive)
      .catch(() => setLive([]));
    api
      .claudeListSessions(repoRoot)
      .then((rows) => setRecent(rows.slice(0, 6)))
      .catch(() => setRecent([]));
  };

  const relAgo = (sec: number): string => {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - sec);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  const recentLabel = (sess: ClaudeSession): string => {
    const t = (sess.last_prompt || sess.first_prompt || "").trim();
    const base = t || "Claude session";
    return sess.cwd_rel ? `${base}  ·  ${sess.cwd_rel}` : base;
  };

  const start = (agent: Agent) => {
    if (!agent.available) return;
    const prompt = buildTaskAgentPrompt(task, childTasks);
    // Remember the pick so the task's agent chip stays in sync.
    setAssignment(ticketKey(task.id), agent.id);
    window.dispatchEvent(
      new CustomEvent("aura:hand-task-to-agent", {
        detail: { agent: agent.id, label: agent.label, prompt, taskId: task.id },
      }),
    );
    onStarted?.();
  };

  // Hand to an already-running session — the prompt is injected into that
  // PTY instead of spawning a fresh agent. The App handler routes on the
  // presence of `sessionId`.
  const startInExisting = (sess: LiveAgentSession) => {
    const agent = agentFor(sess.agent_id);
    const label = agent?.label || sess.agent_id;
    const prompt = buildTaskAgentPrompt(task, childTasks);
    setAssignment(ticketKey(task.id), sess.agent_id);
    window.dispatchEvent(
      new CustomEvent("aura:hand-task-to-agent", {
        detail: {
          agent: sess.agent_id,
          label,
          prompt,
          taskId: task.id,
          sessionId: sess.session_id,
        },
      }),
    );
    onStarted?.();
  };

  // Hand to a recent on-disk Claude session — resume it (`claude --resume`)
  // from its own cwd WITH the task prompt. The App handler reattaches if the
  // session happens to be live, else respawns it; `cwd` keeps a session
  // authored in a sibling worktree resolvable.
  const startInResumable = (sess: ClaudeSession) => {
    const prompt = buildTaskAgentPrompt(task, childTasks);
    setAssignment(ticketKey(task.id), "claude");
    window.dispatchEvent(
      new CustomEvent("aura:hand-task-to-agent", {
        detail: {
          agent: "claude",
          label: "Claude Code",
          prompt,
          taskId: task.id,
          sessionId: sess.session_id,
          resume: true,
          cwd: sess.cwd || undefined,
        },
      }),
    );
    onStarted?.();
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) refreshSessions();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button size={size} variant="default" className="gap-1.5">
          <Bot className="h-3.5 w-3.5" />
          Start in agent
          <ChevronDown className="h-3 w-3 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[240px] text-[12px]">
        {live && live.length > 0 && (
          <>
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <Radio className="h-3 w-3 text-accent-green" />
              Hand to a running session
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {live.map((sess) => (
              <DropdownMenuItem
                key={sess.session_id}
                onSelect={() => startInExisting(sess)}
                className="gap-2.5"
              >
                <AgentIcon
                  agentId={sess.agent_id}
                  label={agentFor(sess.agent_id)?.label || sess.agent_id}
                  size={16}
                />
                <span className="flex-1 truncate">{labelFor(sess)}</span>
                <DropdownMenuShortcut className="text-accent-green">
                  live
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        {recent && recent.length > 0 && (
          <>
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <History className="h-3 w-3 text-text-4" />
              Resume a recent session
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {recent.map((sess) => (
              <DropdownMenuItem
                key={sess.session_id}
                onSelect={() => startInResumable(sess)}
                className="gap-2.5"
              >
                <AgentIcon agentId="claude" label="Claude Code" size={16} />
                <span className="flex-1 truncate">{recentLabel(sess)}</span>
                <DropdownMenuShortcut className="text-text-4">
                  {relAgo(sess.mtime)}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>Start this task in…</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {agents.map((agent) => {
          const isPinned = agent.id === pinnedId;
          return (
            <DropdownMenuItem
              key={agent.id}
              disabled={!agent.available}
              onSelect={() => start(agent)}
              className="gap-2.5"
            >
              <AgentIcon agentId={agent.id} label={agent.label} size={16} />
              <span className="flex-1 truncate">{agent.label}</span>
              {!agent.available ? (
                <DropdownMenuShortcut>not installed</DropdownMenuShortcut>
              ) : isPinned ? (
                <DropdownMenuShortcut className="text-accent">default</DropdownMenuShortcut>
              ) : null}
            </DropdownMenuItem>
          );
        })}
        {loading && agents.length <= 1 && (
          <DropdownMenuItem disabled className="text-text-4">
            Finding agents…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
