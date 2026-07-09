// Hover popover for a workspace tile. Shows live progress for the
// active workspace (subscribed to the agentStreamStore so the running
// indicator + last assistant snippet update as events arrive) and a
// best-known snapshot for other workspaces — branch, last commit age,
// today's intent + audit counts, and the persisted agent roster.

import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { readPersistedAgents, useEditorStore, type AgentTab } from "../lib/editorStore";
import { streamChannel, useAgentStream } from "../lib/agentStreamStore";
import { relAge, relAgeShort, summarizeEvents } from "../lib/streamSummary";
import { AgentIcon } from "./agent/AgentIcon";

type Props = {
  root: string;
  letter: string;
  accent: string;
  isActive: boolean;
  /** Forwarded so the parent's hover bridge keeps the popover open
   *  while the cursor is over it (same hover group as the tile). */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

type Stats = {
  branch: string;
  ageSecs: number;
  intentsToday: number;
  auditUnacked: number;
  costUsd: number;
  tokensOut: number;
  loaded: boolean;
};

const EMPTY_STATS: Stats = {
  branch: "",
  ageSecs: -1,
  intentsToday: 0,
  auditUnacked: 0,
  costUsd: 0,
  tokensOut: 0,
  loaded: false,
};

export function WorkspaceProgressPopover({
  root,
  letter,
  accent,
  isActive,
  onMouseEnter,
  onMouseLeave,
}: Props) {
  const editor = useEditorStore();
  const liveTabs = isActive
    ? editor.agentTabs.filter((t) => t.repoRoot === root)
    : [];
  const persisted = !isActive ? readPersistedAgents(root) : [];
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      const [branch, ageSecs, intentsToday, auditUnacked, usage] =
        await Promise.all([
          api.gitBranch(root).catch(() => ""),
          api.gitLastCommitAge(root).catch(() => -1),
          api.auraCountIntentsToday(root).catch(() => 0),
          api.auraCountAuditUnacked(root).catch(() => 0),
          api
            .auraUsageSummary(root)
            .catch(() => ({ tokens_in: 0, tokens_out: 0, cost_usd: 0, calls: 0, model: "" })),
        ]);
      if (cancelled) return;
      setStats({
        branch,
        ageSecs,
        intentsToday,
        auditUnacked,
        costUsd: usage.cost_usd,
        tokensOut: usage.tokens_out,
        loaded: true,
      });
    };
    fetch();
    // While the popover is open, refresh every 3s so a long-running
    // agent's commit / intent / audit chips reflect reality without the
    // user having to re-hover.
    const id = window.setInterval(fetch, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [root]);

  const name = root.split("/").filter(Boolean).pop() ?? root;

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="absolute z-30 left-full ml-2 top-0 bg-bg-1 border border-line rounded-lg shadow-xl"
      style={{ width: 300 }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-line-soft"
        style={{
          background: `color-mix(in srgb, ${accent} 10%, transparent)`,
        }}
      >
        <span
          className="inline-flex items-center justify-center text-[12px] font-semibold flex-shrink-0"
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: `color-mix(in srgb, ${accent} 32%, transparent)`,
            color: "var(--color-text-1)",
            border: `1px solid ${accent}`,
          }}
        >
          {letter}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-medium text-text-1 truncate" title={root}>
            {name}
          </div>
          <div className="text-[10px] font-mono text-text-4 truncate">
            {stats.branch || "—"}{stats.ageSecs >= 0 ? ` · ${relAge(stats.ageSecs)}` : ""}
          </div>
        </div>
        {isActive && (
          <span className="text-[9.5px] uppercase tracking-wider text-text-5">
            active
          </span>
        )}
      </div>

      <div className="px-2 py-2 flex flex-col gap-1.5">
        {isActive ? (
          liveTabs.length === 0 ? (
            <EmptyAgents label="No agents open in this workspace." />
          ) : (
            liveTabs.map((tab) => <LiveAgentRow key={tab.sessionId} tab={tab} />)
          )
        ) : persisted.length === 0 ? (
          <EmptyAgents label="No agents saved here yet." />
        ) : (
          persisted.map((p) => (
            <PersistedAgentRow key={p.sessionId} agent={p} repoRoot={root} />
          ))
        )}
      </div>

      <div className="px-3 py-2 border-t border-line-soft flex items-center gap-3 text-[10.5px]">
        <Stat
          label="reasons"
          value={stats.intentsToday.toString()}
          muted={stats.intentsToday === 0}
        />
        <Stat
          label="audit"
          value={stats.auditUnacked.toString()}
          tone={stats.auditUnacked > 0 ? "warn" : undefined}
        />
        {stats.costUsd > 0 && (
          <Stat
            label="spent"
            value={`$${stats.costUsd < 1 ? stats.costUsd.toFixed(2) : stats.costUsd.toFixed(1)}`}
          />
        )}
        <span className="ml-auto text-text-5 text-[9.5px]">
          {stats.loaded ? "live" : "loading…"}
        </span>
      </div>
    </div>
  );
}

function LiveAgentRow({ tab }: { tab: AgentTab }) {
  const channel = streamChannel(tab.agentId, tab.repoRoot);
  const { running, events } = useAgentStream(channel);
  const summary = useMemo(() => summarizeEvents(events), [events]);

  return (
    <div className="flex items-start gap-2 px-1.5 py-1">
      <div className="flex-shrink-0 mt-0.5">
        <AgentIcon agentId={tab.agentId} size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11.5px] font-medium text-text-1 truncate">
            {tab.agentLabel}
          </span>
          {running ? (
            <span className="inline-flex items-center gap-1 text-[9.5px] uppercase tracking-wider text-accent-green">
              <PulseDot color="var(--color-accent-green)" />
              working
            </span>
          ) : (
            <span className="text-[9.5px] uppercase tracking-wider text-text-5">
              idle
            </span>
          )}
        </div>
        {summary && (
          <div className="text-[10.5px] text-text-3 truncate" title={summary}>
            {summary}
          </div>
        )}
      </div>
    </div>
  );
}

function PersistedAgentRow({
  agent,
  repoRoot,
}: {
  agent: ReturnType<typeof readPersistedAgents>[number];
  repoRoot: string;
}) {
  const [age, setAge] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (agent.agentId !== "claude") return;
    api
      .claudeListSessions(repoRoot)
      .then((list) => {
        if (cancelled) return;
        const match = list.find((s) => s.session_id === agent.sessionId);
        if (match) setAge(Math.max(0, Math.floor(Date.now() / 1000 - match.mtime)));
      })
      .catch(() => {
        /* silent — best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [agent.agentId, agent.sessionId, repoRoot]);

  return (
    <div className="flex items-start gap-2 px-1.5 py-1">
      <div className="flex-shrink-0 mt-0.5">
        <AgentIcon agentId={agent.agentId} size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11.5px] font-medium text-text-1 truncate">
            {agent.agentLabel}
          </span>
          <span className="text-[9.5px] uppercase tracking-wider text-text-5">
            {agent.mode === "pty" ? "terminal" : "chat"}
          </span>
        </div>
        <div className="text-[10.5px] text-text-4 truncate font-mono">
          {age != null ? `last activity ${relAgeShort(age)}` : agent.sessionId.slice(0, 8)}
        </div>
      </div>
    </div>
  );
}

function EmptyAgents({ label }: { label: string }) {
  return (
    <div className="text-[11px] text-text-4 text-center py-3 px-2">
      {label}
    </div>
  );
}

function Stat({
  label,
  value,
  muted,
  tone,
}: {
  label: string;
  value: string;
  muted?: boolean;
  tone?: "warn";
}) {
  const colour =
    tone === "warn"
      ? "text-amber"
      : muted
        ? "text-text-4"
        : "text-text-2";
  return (
    <div className="flex items-baseline gap-1">
      <span className={`tabular-nums font-medium ${colour}`}>{value}</span>
      <span className="text-text-5 text-[9.5px] uppercase tracking-wider">{label}</span>
    </div>
  );
}

function PulseDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block rounded-full animate-pulse"
      style={{
        width: 6,
        height: 6,
        background: color,
      }}
    />
  );
}

