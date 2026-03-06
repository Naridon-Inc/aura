import { useState, useCallback } from 'react';
import { useApi, useMutation } from '../hooks/useApi';
import { api } from '../lib/api';
import { CheckCircle, Circle, Play, Loader2, FileText, ChevronDown, ChevronRight, Info } from 'lucide-react';

export default function Plans() {
  const { data: plansData } = useApi(useCallback(() => api.getPlans(), []));
  const { data: activePlan, refetch: refetchActive } = useApi(useCallback(() => api.getActivePlan(), []));

  const [discoverObjective, setDiscoverObjective] = useState('');
  const discover = useMutation(useCallback((obj: string) => api.planDiscover(obj), []));

  const handleDiscover = async () => {
    if (!discoverObjective.trim()) return;
    await discover.mutate(discoverObjective);
    refetchActive();
  };

  const plan = activePlan?.active_plan;

  return (
    <div className="flex h-full">
      {/* Left sidebar */}
      <div className="w-56 border-r border-gray-200 bg-white shrink-0 hidden lg:flex flex-col">
        <div className="p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">Plans</h3>
          <p className="text-xs text-gray-400 leading-relaxed">
            Break complex features into atomic "Waves" — small, verifiable implementation steps. Aura discovers gray areas in your architecture before you write code.
          </p>
        </div>
        <div className="px-3 space-y-0.5">
          <SidebarItem label="Active Plan" count={plan ? 1 : 0} active />
          <SidebarItem label="All Plans" count={plansData?.plans?.length ?? 0} />
        </div>
        <div className="mt-auto p-4 border-t border-gray-100 text-xs text-gray-400">
          <div className="flex items-center gap-1.5 mb-1">
            <Info size={12} /> <span className="font-medium text-gray-500">How plans work</span>
          </div>
          <p className="leading-relaxed">Describe what you're building. Aura researches your codebase, identifies architectural gray areas (decisions with trade-offs), and generates a Wave-based execution plan.</p>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto p-8 space-y-6">
        {/* Quick Discover */}
        <div className="bg-white border border-gray-200 rounded-lg p-5">
          <div className="text-base font-semibold text-gray-900 mb-1">Discover Gray Areas</div>
          <p className="text-sm text-gray-500 mb-4">
            Enter what you're trying to build. Aura will analyze your codebase and surface architectural decisions that need attention before coding starts.
          </p>
          <div className="flex gap-3">
            <input
              type="text"
              value={discoverObjective}
              onChange={e => setDiscoverObjective(e.target.value)}
              placeholder="e.g. Add user authentication with OAuth"
              className="flex-1 px-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={handleDiscover}
              disabled={discover.loading || !discoverObjective.trim()}
              className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {discover.loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              Discover
            </button>
          </div>

          {discover.data?.discovery && (
            <div className="mt-5 space-y-4">
              <p className="text-sm text-gray-600 leading-relaxed">{discover.data.discovery.research_summary}</p>
              {discover.data.discovery.gray_areas.map((ga, i) => (
                <div key={i} className="border border-gray-200 rounded-lg p-4">
                  <div className="text-sm font-semibold text-gray-900 mb-3">Gray Area {i + 1}: {ga.question}</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-blue-50 px-4 py-3 rounded-lg border border-blue-100">
                      <span className="text-xs font-semibold text-blue-700">Option A:</span>
                      <p className="text-sm text-blue-600 mt-1">{ga.option_a}</p>
                    </div>
                    <div className="bg-violet-50 px-4 py-3 rounded-lg border border-violet-100">
                      <span className="text-xs font-semibold text-violet-700">Option B:</span>
                      <p className="text-sm text-violet-600 mt-1">{ga.option_b}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Active Plan */}
        {plan && (
          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <div>
                <span className="text-base font-semibold text-gray-900">Active Plan</span>
                <p className="text-xs text-gray-400 mt-0.5">Execute each wave in order. Each wave is an atomic, verifiable step.</p>
              </div>
              <span className="text-xs text-gray-400 font-mono bg-gray-50 px-2.5 py-1 rounded">{plan.name}</span>
            </div>
            <div className="p-4 space-y-2">
              {plan.plan.waves?.map((wave) => {
                const done = plan.progress?.includes(`Wave ${wave.id}: DONE`);
                return (
                  <div key={wave.id} className={`flex items-start gap-3 px-4 py-3.5 rounded-lg border ${done ? 'bg-green-50/50 border-green-200' : 'border-gray-100 hover:bg-gray-50/50'} transition-colors`}>
                    {done ? <CheckCircle size={18} className="text-green-500 mt-0.5 shrink-0" /> : <Circle size={18} className="text-gray-300 mt-0.5 shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900">Wave {wave.id}: {wave.action}</div>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {wave.files?.map(f => (
                          <span key={f} className="px-2 py-0.5 bg-gray-100 rounded text-xs font-mono text-gray-500">{f}</span>
                        ))}
                      </div>
                      {wave.verify && <p className="text-xs text-gray-400 mt-2">Verify: {wave.verify}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Plan Files */}
        {plansData && plansData.plans.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-5 py-4 border-b border-gray-100">
              <span className="text-base font-semibold text-gray-900">Plan Files</span>
              <p className="text-xs text-gray-400 mt-0.5">All plan files stored in <code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono">.aura/plans/</code></p>
            </div>
            <div className="divide-y divide-gray-50">
              {plansData.plans.map((p, i) => (
                <PlanFileRow key={i} plan={p} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SidebarItem({ label, count, active }: { label: string; count: number; active?: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors ${active ? 'bg-gray-50 text-gray-900 font-medium' : 'text-gray-500 hover:bg-gray-50'}`}>
      <span className="flex-1">{label}</span>
      <span className="text-xs text-gray-400">{count}</span>
    </div>
  );
}

function PlanFileRow({ plan }: { plan: { name: string; type: string; content?: string } }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button onClick={() => setExpanded(!expanded)} className="w-full text-left px-5 py-3.5 flex items-center gap-3 hover:bg-gray-50/50 transition-colors">
        {expanded ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
        <FileText size={16} className="text-gray-400" />
        <span className="text-sm font-mono text-gray-700 flex-1">{plan.name}</span>
        <span className="text-xs text-gray-400 bg-gray-50 px-2 py-0.5 rounded">{plan.type}</span>
      </button>
      {expanded && plan.content && (
        <pre className="px-5 pb-4 text-xs text-gray-600 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap font-mono leading-relaxed">{plan.content}</pre>
      )}
    </div>
  );
}
