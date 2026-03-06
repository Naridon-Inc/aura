import { useState, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import {
  Clock, ChevronDown, Bot, User,
  ChevronLeft, ChevronRight as ChevronRightIcon,
  Info
} from 'lucide-react';

export default function Checkpoints() {
  const [page, setPage] = useState(1);
  const { data, loading } = useApi(
    useCallback(() => api.getCheckpoints(page, 20), [page]),
    [page]
  );

  return (
    <div className="flex h-full">
      {/* Left filter panel */}
      <div className="w-56 border-r border-gray-200 bg-white shrink-0 hidden lg:flex flex-col">
        <div className="p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">Checkpoints</h3>
          <p className="text-xs text-gray-400 leading-relaxed">
            Every commit creates a semantic snapshot of your codebase. Aura tracks AST node changes, agent authorship, and intent verification.
          </p>
        </div>
        <div className="px-3 space-y-0.5">
          <FilterItem label="All checkpoints" count={data?.total ?? 0} active />
          <FilterItem label="By agents" count={0} />
          <FilterItem label="By users" count={0} />
        </div>
        <div className="mt-auto p-4 border-t border-gray-100 text-xs text-gray-400">
          <div className="flex items-center gap-1.5 mb-1">
            <Info size={12} /> <span className="font-medium text-gray-500">What are checkpoints?</span>
          </div>
          <p className="leading-relaxed">Semantic snapshots of your codebase's logical structure. Each checkpoint records which functions, classes, and modules changed.</p>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-6 space-y-2 animate-pulse">
            {[1,2,3,4,5].map(i => <div key={i} className="h-16 bg-white border border-gray-200 rounded-lg" />)}
          </div>
        ) : !data?.checkpoints?.length ? (
          <div className="text-center py-24">
            <Clock size={40} className="mx-auto text-gray-300 mb-4" />
            <p className="text-base font-medium text-gray-500">No checkpoints yet</p>
            <p className="text-sm text-gray-400 mt-1.5 max-w-sm mx-auto">Checkpoints are created automatically when you commit. Run <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono">aura init</code> to start tracking.</p>
          </div>
        ) : (
          <>
            {/* Column headers — Graphite style */}
            <div className="flex items-center px-5 py-3 border-b border-gray-200 bg-white sticky top-0 z-10">
              <div className="w-10" />
              <div className="flex-1 text-xs font-medium text-gray-500 uppercase tracking-wider flex items-center gap-1">
                <span>Title</span>
                <ChevronDown size={12} className="text-gray-300" />
              </div>
              <div className="w-24 text-xs font-medium text-gray-500 uppercase tracking-wider text-right">Nodes</div>
              <div className="w-32 text-xs font-medium text-gray-500 uppercase tracking-wider text-right">Agent</div>
              <div className="w-28 text-xs font-medium text-gray-500 uppercase tracking-wider text-right flex items-center justify-end gap-1">
                Changes
              </div>
              <div className="w-28 text-xs font-medium text-gray-500 uppercase tracking-wider text-right">Updated</div>
            </div>

            <div className="divide-y divide-gray-100">
              {data.checkpoints.map((cp) => (
                <CheckpointRow key={cp.id} checkpoint={cp} />
              ))}
            </div>

            {/* Pagination */}
            {data.total_pages > 1 && (
              <div className="flex items-center justify-center gap-4 py-6 border-t border-gray-100">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="flex items-center gap-1 px-4 py-2 text-sm border border-gray-200 rounded-lg disabled:opacity-30 hover:bg-gray-50"
                >
                  <ChevronLeft size={16} /> Previous
                </button>
                <span className="text-sm text-gray-500">
                  Page {data.page} of {data.total_pages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(data.total_pages, p + 1))}
                  disabled={page >= data.total_pages}
                  className="flex items-center gap-1 px-4 py-2 text-sm border border-gray-200 rounded-lg disabled:opacity-30 hover:bg-gray-50"
                >
                  Next <ChevronRightIcon size={16} />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FilterItem({ label, count, active }: { label: string; count: number; active?: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors ${active ? 'bg-gray-100 text-gray-900 font-medium' : 'text-gray-500 hover:bg-gray-50'}`}>
      <span className="flex-1">{label}</span>
      <span className="text-xs text-gray-400">{count}</span>
    </div>
  );
}

function CheckpointRow({ checkpoint }: { checkpoint: { id: string; agent_id: string; intent: string; timestamp: number; node_count: number; node_kinds?: string[] } }) {
  const [expanded, setExpanded] = useState(false);
  const isAgent = checkpoint.agent_id?.toLowerCase().includes('claude') || checkpoint.agent_id?.toLowerCase().includes('cursor') || checkpoint.agent_id?.toLowerCase().includes('gemini');
  const intentLine = checkpoint.intent.split('\n')[0].replace(/\[.*?\]/, '').trim();

  return (
    <div>
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center px-5 py-3.5 hover:bg-gray-50/80 transition-colors text-left group">
        {/* Avatar */}
        <div className="w-10 flex justify-center">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${isAgent ? 'bg-violet-100 text-violet-600' : 'bg-blue-100 text-blue-600'}`}>
            {isAgent ? <Bot size={15} /> : <User size={15} />}
          </div>
        </div>

        {/* Title + subtitle */}
        <div className="flex-1 min-w-0 pl-2">
          <div className="text-sm font-medium text-gray-900 truncate group-hover:text-blue-600 transition-colors">{intentLine || 'Checkpoint'}</div>
          <div className="text-xs text-gray-400 font-mono mt-0.5">{checkpoint.id.substring(0, 10)}</div>
        </div>

        {/* Nodes */}
        <div className="w-24 text-right">
          <span className="text-sm font-mono text-gray-600">{checkpoint.node_count}</span>
        </div>

        {/* Agent */}
        <div className="w-32 text-right">
          <span className="text-xs text-gray-400">{checkpoint.agent_id || 'user'}</span>
        </div>

        {/* Changes indicator */}
        <div className="w-28 text-right">
          <span className="text-sm text-green-600 font-mono">+{checkpoint.node_count}</span>
        </div>

        {/* Time */}
        <div className="w-28 text-right">
          <span className="text-sm text-gray-400">{formatTime(checkpoint.timestamp)}</span>
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-5 pb-4 pl-16 bg-gray-50/50">
          <p className="text-sm text-gray-600 whitespace-pre-wrap leading-relaxed mb-3">{checkpoint.intent}</p>
          {checkpoint.node_kinds && checkpoint.node_kinds.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {[...new Set(checkpoint.node_kinds)].map(kind => (
                <span key={kind} className="px-2 py-0.5 bg-white border border-gray-200 rounded text-xs font-mono text-gray-500">{kind}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = Date.now();
  const diff = Math.floor((now - d.getTime()) / 1000);
  if (diff < 60) return '<1m';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / 2592000)}mo`;
}
