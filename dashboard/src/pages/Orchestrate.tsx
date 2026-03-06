import { useState, useCallback } from 'react';
import { useApi, useMutation } from '../hooks/useApi';
import { api } from '../lib/api';
import type {
  OrchestrateWave, WaveStatus, AgentType, OrchestrateActiveResponse,
  DuoTask, DuoRound, RelayMessage, TaskStatus, SessionTokenStats,
} from '../lib/types';
import {
  Play, Pause, Square, RotateCcw, Wand2, ChevronDown, ChevronRight,
  Clock, CheckCircle2, XCircle, Loader2, ArrowRight, MessageCircleQuestion,
  Cpu, TrendingDown, Coins
} from 'lucide-react';

const POLL_INTERVAL = 2000;

export default function Orchestrate() {
  const [objective, setObjective] = useState('');
  const [strategy, setStrategy] = useState('smart');
  const [mode, setMode] = useState('duo');
  const [expandedItem, setExpandedItem] = useState<string | null>(null);

  const { data: activeData, loading } = useApi<OrchestrateActiveResponse>(
    useCallback(() => api.getOrchestrateActive(), []),
    [],
    { pollInterval: POLL_INTERVAL }
  );

  const startMutation = useMutation(
    useCallback((params: { objective: string; strategy: string }) =>
      api.startOrchestrate(params.objective, params.strategy), [])
  );
  const pauseMutation = useMutation(useCallback(() => api.pauseOrchestrate(), []));
  const resumeMutation = useMutation(useCallback(() => api.resumeOrchestrate(), []));
  const cancelMutation = useMutation(useCallback(() => api.cancelOrchestrate(), []));

  const session = activeData?.session ?? null;
  const isRunning = session?.status === 'running';
  const isPaused = session?.status === 'paused';
  const isDuo = session?.mode === 'duo';

  const handleStart = async () => {
    if (!objective.trim()) return;
    await startMutation.mutate({ objective: objective.trim(), strategy });
    setObjective('');
  };

  if (loading && !activeData) {
    return (
      <div className="p-8 space-y-5 animate-pulse">
        <div className="h-32 bg-white rounded-lg border border-gray-200" />
        <div className="h-64 bg-white rounded-lg border border-gray-200" />
      </div>
    );
  }

  // Progress calculation
  const progressInfo = isDuo
    ? (() => {
        const done = session?.tasks?.filter((t: DuoTask) => t.status === 'done').length ?? 0;
        const total = session?.tasks?.length ?? 0;
        return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
      })()
    : (() => {
        const done = session?.waves?.filter((w: OrchestrateWave) => w.status === 'passed').length ?? 0;
        const total = session?.waves?.length ?? 0;
        return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
      })();

  return (
    <div className="p-8 max-w-[1080px] mx-auto space-y-6">
      {/* Agent Availability */}
      {!session && (
        <AgentStatusBar agents={activeData?.session?.agents_available} />
      )}

      {/* Start Form */}
      {!session && (
        <div className="bg-white border border-gray-200 rounded-lg p-5">
          <div className="flex items-center gap-2 mb-4">
            <Wand2 size={18} strokeWidth={1.75} className="text-violet-500" />
            <span className="text-sm font-semibold text-gray-900">New Orchestration</span>
          </div>
          <div className="space-y-3">
            <input
              type="text"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="Describe the objective (e.g., 'Add user authentication with JWT')"
              className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400"
              onKeyDown={(e) => e.key === 'Enter' && handleStart()}
            />
            <div className="flex items-center gap-3">
              <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
                <button
                  onClick={() => setMode('duo')}
                  className={`px-3 py-1.5 ${mode === 'duo' ? 'bg-violet-50 text-violet-700 font-medium' : 'text-gray-500 hover:bg-gray-50'}`}
                >
                  Duo (parallel)
                </button>
                <button
                  onClick={() => setMode('wave')}
                  className={`px-3 py-1.5 border-l border-gray-200 ${mode === 'wave' ? 'bg-violet-50 text-violet-700 font-medium' : 'text-gray-500 hover:bg-gray-50'}`}
                >
                  Wave (sequential)
                </button>
              </div>
              {mode === 'wave' && (
                <select
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value)}
                  className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none"
                >
                  <option value="smart">Smart</option>
                  <option value="round-robin">Round Robin</option>
                </select>
              )}
              <button
                onClick={handleStart}
                disabled={!objective.trim() || startMutation.loading}
                className="inline-flex items-center gap-2 px-4 py-2 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {startMutation.loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                Start
              </button>
            </div>
            {startMutation.error && (
              <p className="text-sm text-red-600">{String(startMutation.error)}</p>
            )}
          </div>
        </div>
      )}

      {/* Timeline */}
      {session && (
        <>
          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wand2 size={18} strokeWidth={1.75} className="text-violet-500" />
                <span className="text-sm font-semibold text-gray-900 truncate max-w-md">{session.objective}</span>
                <span className={`px-2 py-0.5 rounded text-xs font-mono ${isDuo ? 'bg-violet-50 text-violet-600' : 'bg-gray-50 text-gray-500'}`}>
                  {isDuo ? 'duo' : 'wave'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <AgentDots agents={session.agents_available} />
                <StatusBadge status={session.status} />
              </div>
            </div>

            <div className="p-5">
              {isDuo && session.rounds && session.tasks ? (
                <DuoTimeline
                  tasks={session.tasks}
                  rounds={session.rounds}
                  relayLog={session.relay_log ?? []}
                  expandedItem={expandedItem}
                  onToggle={(id) => setExpandedItem(expandedItem === id ? null : id)}
                />
              ) : (
                <WaveTimeline
                  waves={session.waves}
                  currentWave={session.current_wave}
                  isRunning={isRunning}
                  expandedItem={expandedItem}
                  onToggle={(id) => setExpandedItem(expandedItem === id ? null : id)}
                />
              )}
            </div>
          </div>

          {/* Controls */}
          <div className="sticky bottom-0 bg-white border border-gray-200 rounded-lg p-4 flex items-center justify-between shadow-sm">
            <div className="flex items-center gap-2">
              {isPaused ? (
                <button onClick={() => resumeMutation.mutate(undefined)} disabled={resumeMutation.loading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors">
                  <Play size={14} /> Resume
                </button>
              ) : isRunning ? (
                <button onClick={() => pauseMutation.mutate(undefined)} disabled={pauseMutation.loading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-yellow-600 text-white text-sm font-medium rounded-lg hover:bg-yellow-700 transition-colors">
                  <Pause size={14} /> Pause
                </button>
              ) : null}
              {(isRunning || isPaused) && (
                <button onClick={() => cancelMutation.mutate(undefined)} disabled={cancelMutation.loading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors">
                  <Square size={14} /> Cancel
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="w-32 h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-violet-500 rounded-full transition-all duration-500" style={{ width: `${progressInfo.pct}%` }} />
              </div>
              <span className="text-sm font-medium text-gray-700">
                {progressInfo.done}/{progressInfo.total} — {progressInfo.pct}%
              </span>
            </div>
          </div>

          {/* Token Stats */}
          {session.token_stats && <TokenStatsCard stats={session.token_stats} />}
        </>
      )}

      {/* Empty state */}
      {!session && !loading && (
        <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
          <Wand2 size={32} strokeWidth={1.5} className="text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-500">No active orchestration session.</p>
          <p className="text-xs text-gray-400 mt-1">Start one above to coordinate Claude Code and Gemini CLI.</p>
        </div>
      )}
    </div>
  );
}

// ─── Agent Status Bar ────────────────────────────────────────────────────────

function AgentStatusBar({ agents }: { agents?: AgentType[] }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg px-5 py-3 flex items-center gap-6">
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Cpu size={14} className="text-gray-400" />
        <span className="font-medium text-gray-700">Agents</span>
      </div>
      <div className="flex items-center gap-4">
        <AgentDotLabel name="Claude Code" color="violet" available={!agents || agents.includes('claude_code')} />
        <AgentDotLabel name="Gemini CLI" color="blue" available={!agents || agents.includes('gemini_cli')} />
      </div>
    </div>
  );
}

function AgentDotLabel({ name, color, available }: { name: string; color: 'violet' | 'blue'; available: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-2 h-2 rounded-full ${
        available
          ? (color === 'violet' ? 'bg-violet-400' : 'bg-blue-400')
          : 'bg-gray-300'
      }`} />
      <span className={`text-xs ${available ? 'text-gray-700' : 'text-gray-400 line-through'}`}>
        {name}
      </span>
    </div>
  );
}

function AgentDots({ agents }: { agents: AgentType[] }) {
  return (
    <div className="flex items-center gap-1">
      <div className={`w-2 h-2 rounded-full ${agents.includes('claude_code') ? 'bg-violet-400' : 'bg-gray-300'}`}
        title="Claude Code" />
      <div className={`w-2 h-2 rounded-full ${agents.includes('gemini_cli') ? 'bg-blue-400' : 'bg-gray-300'}`}
        title="Gemini CLI" />
    </div>
  );
}

// ─── Duo Timeline (dual-track) ──────────────────────────────────────────────

function DuoTimeline({
  tasks, rounds, relayLog, expandedItem, onToggle,
}: {
  tasks: DuoTask[];
  rounds: DuoRound[];
  relayLog: RelayMessage[];
  expandedItem: string | null;
  onToggle: (id: string) => void;
}) {
  // Check if planning phase is visible (round 0 or tasks being decomposed)
  const hasPlanning = rounds.length > 0 || tasks.length > 0;

  return (
    <div className="space-y-4">
      {/* Planning phase indicator */}
      {hasPlanning && (
        <div className="flex items-center gap-3 px-4 py-2 bg-gradient-to-r from-violet-50 to-blue-50 rounded-lg border border-violet-100">
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-violet-400" />
            <div className="w-2 h-2 rounded-full bg-blue-400" />
          </div>
          <span className="text-xs font-medium text-gray-600">
            Collaborative Planning — both agents contributed to task decomposition
          </span>
          <span className="text-xs text-gray-400 ml-auto">{tasks.length} tasks planned</span>
        </div>
      )}

      {rounds.map((round) => {
        const roundTasks = tasks.filter(t => round.task_ids.includes(t.id));
        const geminiTasks = roundTasks.filter(t => t.agent === 'gemini_cli');
        const claudeTasks = roundTasks.filter(t => t.agent === 'claude_code');
        const roundRelays = relayLog.filter(m => m.round_id === round.id);

        return (
          <div key={round.id} className="border border-gray-200 rounded-lg overflow-hidden">
            {/* Round header */}
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-500">Round {round.id}</span>
              <span className="text-xs text-gray-400">{roundTasks.length} task(s)</span>
            </div>

            {/* Dual-track layout */}
            <div className="grid grid-cols-2 divide-x divide-gray-100">
              {/* Gemini track (left) */}
              <div className="p-3 space-y-2">
                <div className="flex items-center gap-1.5 mb-2">
                  <div className="w-2 h-2 rounded-full bg-blue-400" />
                  <span className="text-xs font-medium text-blue-600">Gemini</span>
                </div>
                {geminiTasks.length === 0 ? (
                  <div className="text-xs text-gray-300 italic">idle</div>
                ) : geminiTasks.map(task => (
                  <DuoTaskCard key={task.id} task={task}
                    expanded={expandedItem === `task-${task.id}`}
                    onToggle={() => onToggle(`task-${task.id}`)} />
                ))}
              </div>

              {/* Claude track (right) */}
              <div className="p-3 space-y-2">
                <div className="flex items-center gap-1.5 mb-2">
                  <div className="w-2 h-2 rounded-full bg-violet-400" />
                  <span className="text-xs font-medium text-violet-600">Claude</span>
                </div>
                {claudeTasks.length === 0 ? (
                  <div className="text-xs text-gray-300 italic">idle</div>
                ) : claudeTasks.map(task => (
                  <DuoTaskCard key={task.id} task={task}
                    expanded={expandedItem === `task-${task.id}`}
                    onToggle={() => onToggle(`task-${task.id}`)} />
                ))}
              </div>
            </div>

            {/* Relay messages between tracks */}
            {roundRelays.length > 0 && (
              <div className="px-4 py-2 bg-amber-50/50 border-t border-gray-100 space-y-1">
                {roundRelays.map((msg, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className={msg.from === 'gemini_cli' ? 'text-blue-500' : 'text-violet-500'}>
                      {msg.from === 'gemini_cli' ? 'Gemini' : 'Claude'}
                    </span>
                    {msg.msg_type === 'question' ? (
                      <MessageCircleQuestion size={12} className="text-amber-500" />
                    ) : (
                      <ArrowRight size={12} className="text-gray-400" />
                    )}
                    <span className={msg.to === 'gemini_cli' ? 'text-blue-500' : 'text-violet-500'}>
                      {msg.to === 'gemini_cli' ? 'Gemini' : 'Claude'}
                    </span>
                    <span className="text-gray-500 truncate">{msg.content}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Pending tasks not yet in a round */}
      {(() => {
        const scheduledIds = new Set(rounds.flatMap(r => r.task_ids));
        const pending = tasks.filter(t => !scheduledIds.has(t.id));
        if (pending.length === 0) return null;
        return (
          <div className="border border-dashed border-gray-200 rounded-lg p-4">
            <span className="text-xs font-medium text-gray-400 mb-2 block">Queued</span>
            <div className="space-y-1">
              {pending.map(t => (
                <div key={t.id} className="flex items-center gap-2 text-xs text-gray-400">
                  <span className="font-mono">#{t.id}</span>
                  <span>{t.action}</span>
                  <AgentBadge agent={t.agent} />
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function DuoTaskCard({ task, expanded, onToggle }: { task: DuoTask; expanded: boolean; onToggle: () => void }) {
  return (
    <div className={`border rounded-lg ${task.status === 'running' ? 'border-blue-200 bg-blue-50/30 animate-pulse' : 'border-gray-200'}`}>
      <button onClick={onToggle} className="w-full px-3 py-2 flex items-center justify-between text-left">
        <div className="flex items-center gap-2 min-w-0">
          <DuoStatusIcon status={task.status} />
          <span className="text-xs text-gray-800 truncate">{task.action}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {task.retry_count > 0 && (
            <span className="text-xs text-orange-500 flex items-center gap-0.5"><RotateCcw size={10} /> {task.retry_count}</span>
          )}
          {task.started_at && task.completed_at && (
            <span className="text-xs text-gray-400">{formatDuration(task.completed_at - task.started_at)}</span>
          )}
          {expanded ? <ChevronDown size={12} className="text-gray-400" /> : <ChevronRight size={12} className="text-gray-400" />}
        </div>
      </button>
      {expanded && task.output && (
        <div className="px-3 pb-2 border-t border-gray-100 pt-2">
          <pre className="p-2 bg-gray-50 border border-gray-200 rounded text-xs text-gray-700 overflow-auto max-h-48 whitespace-pre-wrap">
            {task.output}
          </pre>
        </div>
      )}
    </div>
  );
}

function DuoStatusIcon({ status }: { status: TaskStatus }) {
  switch (status) {
    case 'pending': return <Clock size={12} className="text-gray-300" />;
    case 'running': return <Loader2 size={12} className="text-blue-500 animate-spin" />;
    case 'done': return <CheckCircle2 size={12} className="text-green-500" />;
    case 'failed': return <XCircle size={12} className="text-red-500" />;
  }
}

// ─── Wave Timeline (existing, for wave mode) ────────────────────────────────

function WaveTimeline({
  waves, currentWave, isRunning, expandedItem, onToggle,
}: {
  waves: OrchestrateWave[];
  currentWave: number;
  isRunning: boolean;
  expandedItem: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="relative">
      <div className="absolute left-4 top-0 bottom-0 w-px bg-gray-200" />
      <div className="space-y-4">
        {waves.map((wave) => {
          const isCurrent = currentWave + 1 === wave.id && isRunning;
          const key = `wave-${wave.id}`;
          const expanded = expandedItem === key;
          return (
            <div key={wave.id} className={`relative pl-10 ${isCurrent ? 'animate-pulse' : ''}`}>
              <div className={`absolute left-2.5 top-3 w-3 h-3 rounded-full border-2 ${waveStatusDotColor(wave.status)}`} />
              <div className={`border rounded-lg ${isCurrent ? 'border-violet-300 ring-1 ring-violet-100' : 'border-gray-200'}`}>
                <button onClick={() => onToggle(key)} className="w-full px-4 py-3 flex items-center justify-between text-left">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-xs font-mono text-gray-400">#{wave.id}</span>
                    <span className="text-sm text-gray-900 truncate">{wave.action}</span>
                    <AgentBadge agent={wave.assigned_agent} />
                    <WaveStatusBadge status={wave.status} />
                  </div>
                </button>
                {expanded && wave.logs && (
                  <div className="px-4 pb-4 border-t border-gray-100 pt-3">
                    <pre className="p-3 bg-gray-50 border border-gray-200 rounded text-xs text-gray-700 overflow-auto max-h-60 whitespace-pre-wrap">
                      {wave.logs}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Shared sub-components ──────────────────────────────────────────────────

function waveStatusDotColor(status: WaveStatus): string {
  const c: Record<WaveStatus, string> = {
    pending: 'border-gray-300 bg-white', running: 'border-blue-400 bg-blue-400',
    validating: 'border-yellow-400 bg-yellow-400', passed: 'border-green-400 bg-green-400',
    failed: 'border-red-400 bg-red-400', retrying: 'border-orange-400 bg-orange-400',
  };
  return c[status] || c.pending;
}

function AgentBadge({ agent }: { agent: AgentType }) {
  const isGemini = agent === 'gemini_cli';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
      isGemini ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-violet-50 text-violet-700 border border-violet-200'
    }`}>
      {isGemini ? 'Gemini' : 'Claude'}
    </span>
  );
}

function WaveStatusBadge({ status }: { status: WaveStatus }) {
  const c: Record<WaveStatus, { icon: typeof Clock; color: string; label: string }> = {
    pending: { icon: Clock, color: 'text-gray-400', label: 'Pending' },
    running: { icon: Loader2, color: 'text-blue-500', label: 'Running' },
    validating: { icon: Loader2, color: 'text-yellow-500', label: 'Validating' },
    passed: { icon: CheckCircle2, color: 'text-green-500', label: 'Passed' },
    failed: { icon: XCircle, color: 'text-red-500', label: 'Failed' },
    retrying: { icon: RotateCcw, color: 'text-orange-500', label: 'Retrying' },
  };
  const cfg = c[status];
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${cfg.color}`}>
      <Icon size={12} className={status === 'running' || status === 'validating' ? 'animate-spin' : ''} />
      {cfg.label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: 'bg-blue-50 text-blue-700 border-blue-200', paused: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    completed: 'bg-green-50 text-green-700 border-green-200', failed: 'bg-red-50 text-red-700 border-red-200',
    cancelled: 'bg-gray-50 text-gray-500 border-gray-200', planning: 'bg-violet-50 text-violet-700 border-violet-200',
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${colors[status] || colors.planning}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

// ─── Token Stats Card ────────────────────────────────────────────────────────

function TokenStatsCard({ stats }: { stats: SessionTokenStats }) {
  const savingsBarWidth = Math.min(Math.max(stats.savings_pct, 0), 100);

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5">
      <div className="flex items-center gap-2 mb-4">
        <Coins size={16} className="text-amber-500" />
        <span className="text-sm font-semibold text-gray-900">Token Usage</span>
        {stats.savings_pct > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
            <TrendingDown size={10} />
            {stats.savings_pct.toFixed(0)}% saved
          </span>
        )}
      </div>

      {/* Main stats grid */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div>
          <div className="text-xs text-gray-400 mb-1">Total Tokens</div>
          <div className="text-lg font-semibold text-gray-900">{formatTokens(stats.total_tokens)}</div>
          <div className="text-xs text-gray-400">
            {formatTokens(stats.total_input)} in / {formatTokens(stats.total_output)} out
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-400 mb-1">Total Cost</div>
          <div className="text-lg font-semibold text-gray-900">${stats.total_cost_usd.toFixed(4)}</div>
          <div className="text-xs text-gray-400">
            vs ${stats.estimated_cost_without_aura.toFixed(4)} without Aura
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-400 mb-1">Tokens Saved</div>
          <div className="text-lg font-semibold text-green-600">
            {formatTokens(stats.tokens_saved_handover + stats.tokens_saved_resume)}
          </div>
          <div className="text-xs text-gray-400">
            by handover + resume
          </div>
        </div>
      </div>

      {/* Agent breakdown */}
      <div className="flex gap-4 mb-4">
        <div className="flex-1 bg-violet-50 rounded-lg p-3 border border-violet-100">
          <div className="flex items-center gap-1.5 mb-1">
            <div className="w-2 h-2 rounded-full bg-violet-400" />
            <span className="text-xs font-medium text-violet-700">Claude</span>
          </div>
          <div className="text-sm font-semibold text-violet-900">{formatTokens(stats.claude_tokens)}</div>
          <div className="text-xs text-violet-500">${stats.claude_cost_usd.toFixed(4)}</div>
        </div>
        <div className="flex-1 bg-blue-50 rounded-lg p-3 border border-blue-100">
          <div className="flex items-center gap-1.5 mb-1">
            <div className="w-2 h-2 rounded-full bg-blue-400" />
            <span className="text-xs font-medium text-blue-700">Gemini</span>
          </div>
          <div className="text-sm font-semibold text-blue-900">{formatTokens(stats.gemini_tokens)}</div>
          <div className="text-xs text-blue-500">${stats.gemini_cost_usd.toFixed(4)}</div>
        </div>
      </div>

      {/* Savings bar */}
      <div>
        <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
          <span>With Aura: ${stats.total_cost_usd.toFixed(4)}</span>
          <span>Without: ${stats.estimated_cost_without_aura.toFixed(4)}</span>
        </div>
        <div className="h-3 bg-red-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-green-400 rounded-full transition-all duration-700"
            style={{ width: `${100 - savingsBarWidth}%` }}
          />
        </div>
        <div className="text-xs text-gray-400 mt-1 text-center">
          Green = actual cost, Red = what you would have paid
        </div>
      </div>
    </div>
  );
}
