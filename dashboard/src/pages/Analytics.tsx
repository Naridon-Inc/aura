import { useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { Clock, Info, BarChart3 } from 'lucide-react';

export default function Analytics() {
  const { data, loading } = useApi(useCallback(() => api.getMetrics(), []));

  if (loading || !data) {
    return (
      <div className="flex h-full">
        <div className="w-56 border-r border-gray-200 bg-white shrink-0 hidden lg:flex flex-col" />
        <div className="flex-1 p-8 space-y-5 animate-pulse">
          <div className="grid grid-cols-3 gap-5">
            {[1,2,3].map(i => <div key={i} className="h-56 bg-white border border-gray-200 rounded-lg" />)}
          </div>
        </div>
      </div>
    );
  }

  const totalBugs = data.review_history.reduce((s, r) => s + r.bug_count, 0);
  const totalSecurity = data.review_history.reduce((s, r) => s + r.security_count, 0);
  const avgRisk = data.review_history.length > 0
    ? Math.round(data.review_history.reduce((s, r) => s + r.risk_score, 0) / data.review_history.length)
    : 0;
  const totalViolations = data.review_history.reduce((s: number, r: { violation_count: number }) => s + r.violation_count, 0);

  return (
    <div className="flex h-full">
      {/* Left filter sidebar */}
      <div className="w-56 border-r border-gray-200 bg-white shrink-0 hidden lg:flex flex-col">
        <div className="p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">Analytics</h3>
          <p className="text-xs text-gray-400 leading-relaxed">
            Track code health trends over time. See risk scores, bug counts, code churn, and node type distribution across all your reviews.
          </p>
        </div>
        <div className="px-3 space-y-0.5">
          <SidebarItem label="Overview" count={data.total_reviews} active />
          <SidebarItem label="Bugs" count={totalBugs} dot={totalBugs > 0 ? 'red' : 'green'} />
          <SidebarItem label="Security" count={totalSecurity} dot={totalSecurity > 0 ? 'red' : 'green'} />
          <SidebarItem label="Violations" count={totalViolations} dot={totalViolations > 0 ? 'yellow' : 'green'} />
        </div>
        <div className="mt-auto p-4 border-t border-gray-100 text-xs text-gray-400">
          <div className="flex items-center gap-1.5 mb-1">
            <Info size={12} /> <span className="font-medium text-gray-500">How analytics work</span>
          </div>
          <p className="leading-relaxed">Aura aggregates data from all PR reviews. Metrics update automatically each time you run a review.</p>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto p-8 space-y-6">
        {/* Chart cards row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <ChartCard title="Risk Score" desc="Risk score trend across recent reviews. Higher scores indicate more dangerous changes.">
            <RiskChart reviews={data.review_history} />
            <div className="mt-4 pt-3 border-t border-gray-100 flex items-center justify-between">
              <span className="text-sm text-gray-500">{avgRisk} avg risk</span>
              <span className="text-xs text-gray-400">{data.total_reviews} reviews</span>
            </div>
          </ChartCard>

          <ChartCard title="Findings" desc="Number of bugs and security vulnerabilities detected per review.">
            <FindingsChart reviews={data.review_history} />
            <div className="mt-4 pt-3 border-t border-gray-100 flex items-center gap-5">
              <Legend color="bg-red-400" label="Bugs" />
              <Legend color="bg-orange-400" label="Security" />
            </div>
          </ChartCard>

          <ChartCard title="Changes" desc="AST node changes per review. Larger changes may carry higher risk.">
            <ChangesChart reviews={data.review_history} />
            <div className="mt-4 pt-3 border-t border-gray-100">
              <span className="text-sm text-gray-500">
                {data.review_history.length > 0
                  ? Math.round(data.review_history.reduce((s, r) => s + r.total_changes, 0) / data.review_history.length)
                  : 0} avg nodes changed
              </span>
            </div>
          </ChartCard>
        </div>

        {/* Summary stat cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <StatCard
            icon={<BarChart3 size={20} className="text-gray-400" />}
            value={totalBugs}
            unit="bugs"
            label="Total Bugs Found"
            badge={totalBugs === 0 ? 'Good' : totalBugs > 5 ? 'Warning' : 'Moderate'}
            badgeColor={totalBugs === 0 ? 'green' : totalBugs > 5 ? 'red' : 'yellow'}
            desc={totalBugs === 0
              ? 'No bugs detected across all reviews — your code patterns are clean.'
              : `${totalBugs} bugs detected. Review the findings in your PR reviews to fix them.`}
          />
          <StatCard
            icon={<Clock size={20} className="text-gray-400" />}
            value={totalSecurity}
            unit="issues"
            label="Security Vulnerabilities"
            badge={totalSecurity === 0 ? 'Good' : 'Critical'}
            badgeColor={totalSecurity === 0 ? 'green' : 'red'}
            desc={totalSecurity === 0
              ? 'No security vulnerabilities found. Your code maintains secure practices.'
              : `${totalSecurity} security issues require immediate attention. Check PR reviews for details.`}
          />
        </div>

        {/* Code churn */}
        {data.top_churned_nodes.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-900">Most Modified Nodes</span>
                <span className="group relative">
                  <Info size={14} className="text-gray-300 cursor-help" />
                  <span className="absolute left-6 top-0 w-64 p-2 bg-gray-900 text-white text-xs rounded-md opacity-0 group-hover:opacity-100 pointer-events-none z-50 shadow-lg transition-opacity">
                    Functions and classes that change most frequently. High churn may indicate fragile code or areas that need refactoring.
                  </span>
                </span>
              </div>
              <span className="text-xs text-gray-400">{data.top_churned_nodes.length} nodes tracked</span>
            </div>
            <div className="divide-y divide-gray-50">
              {data.top_churned_nodes.slice(0, 10).map(([name, count]) => (
                <div key={name} className="flex items-center px-5 py-3">
                  <span className="text-sm font-mono text-gray-600 w-48 truncate">{name}</span>
                  <div className="flex-1 mx-4 h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-400 rounded-full" style={{ width: `${(count / data.top_churned_nodes[0][1]) * 100}%` }} />
                  </div>
                  <span className="text-sm text-gray-400 w-8 text-right">{count}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Node type distribution */}
        {Object.keys(data.node_kind_distribution).length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-900">Node Type Distribution</span>
                <span className="group relative">
                  <Info size={14} className="text-gray-300 cursor-help" />
                  <span className="absolute left-6 top-0 w-64 p-2 bg-gray-900 text-white text-xs rounded-md opacity-0 group-hover:opacity-100 pointer-events-none z-50 shadow-lg transition-opacity">
                    Breakdown of AST node types in your codebase: functions, classes, modules, etc.
                  </span>
                </span>
              </div>
            </div>
            <div className="p-5 grid grid-cols-2 md:grid-cols-4 gap-3">
              {Object.entries(data.node_kind_distribution)
                .sort(([, a], [, b]) => b - a)
                .map(([kind, count]) => (
                  <div key={kind} className="flex items-center justify-between px-4 py-3 bg-gray-50 rounded-lg">
                    <span className="text-sm font-mono text-gray-600">{kind}</span>
                    <span className="text-sm font-semibold text-gray-900">{count}</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Review history table */}
        {data.review_history.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <span className="text-sm font-semibold text-gray-900">Review History</span>
              <p className="text-xs text-gray-400 mt-0.5">Complete history of all PR reviews. Each row shows the risk score, findings, and node changes.</p>
            </div>
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 uppercase tracking-wider">
                <tr className="border-b border-gray-100">
                  <th className="px-5 py-3 text-left font-medium">Date</th>
                  <th className="px-5 py-3 text-right font-medium">Changes</th>
                  <th className="px-5 py-3 text-right font-medium">Risk</th>
                  <th className="px-5 py-3 text-right font-medium">Bugs</th>
                  <th className="px-5 py-3 text-right font-medium">Security</th>
                  <th className="px-5 py-3 text-right font-medium">Violations</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.review_history.map((r, i) => (
                  <tr key={i} className="hover:bg-gray-50/50">
                    <td className="px-5 py-3 text-gray-600">{new Date(r.timestamp * 1000).toLocaleDateString()}</td>
                    <td className="px-5 py-3 text-right font-mono text-gray-900">{r.total_changes}</td>
                    <td className="px-5 py-3 text-right">
                      <span className={r.risk_score > 100 ? 'text-red-600 font-medium' : r.risk_score > 50 ? 'text-yellow-600' : 'text-green-600'}>{r.risk_score}</span>
                    </td>
                    <td className="px-5 py-3 text-right text-gray-900">{r.bug_count}</td>
                    <td className="px-5 py-3 text-right text-gray-900">{r.security_count}</td>
                    <td className="px-5 py-3 text-right text-gray-900">{r.violation_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function SidebarItem({ label, count, active, dot }: { label: string; count: number; active?: boolean; dot?: string }) {
  const dotColor = dot === 'red' ? 'bg-red-500' : dot === 'yellow' ? 'bg-yellow-500' : dot === 'green' ? 'bg-green-500' : '';
  return (
    <div className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors ${active ? 'bg-gray-50 text-gray-900 font-medium' : 'text-gray-500 hover:bg-gray-50'}`}>
      {dot && <div className={`w-2 h-2 rounded-full ${dotColor}`} />}
      <span className="flex-1">{label}</span>
      <span className="text-xs text-gray-400">{count}</span>
    </div>
  );
}

function ChartCard({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5">
      <div className="mb-1">
        <span className="text-sm font-semibold text-gray-900">{title}</span>
      </div>
      <p className="text-xs text-gray-400 mb-4 leading-relaxed">{desc}</p>
      {children}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`w-2.5 h-2.5 rounded-full ${color}`} />
      <span className="text-xs text-gray-500">{label}</span>
    </div>
  );
}

function StatCard({ icon, value, unit, label, badge, badgeColor, desc }: {
  icon: React.ReactNode; value: number; unit: string; label: string;
  badge: string; badgeColor: string; desc: string;
}) {
  const badgeColors: Record<string, string> = {
    green: 'bg-green-100 text-green-700',
    red: 'bg-red-100 text-red-700',
    yellow: 'bg-yellow-100 text-yellow-700',
  };
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5">
      <div className="mb-3">{icon}</div>
      <div className="text-2xl font-bold text-gray-900">{value} <span className="text-base font-normal text-gray-500">{unit}</span></div>
      <div className="text-sm text-gray-500 mt-1">{label}</div>
      <div className="mt-3">
        <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${badgeColors[badgeColor]}`}>{badge}</span>
      </div>
      <p className="text-xs text-gray-400 mt-3 leading-relaxed">{desc}</p>
    </div>
  );
}

function RiskChart({ reviews }: { reviews: { timestamp: number; risk_score: number }[] }) {
  const sorted = [...reviews].sort((a, b) => a.timestamp - b.timestamp).slice(-20);
  if (sorted.length === 0) return <div className="h-28 flex items-center justify-center text-sm text-gray-300">No review data yet</div>;
  const maxRisk = Math.max(...sorted.map(r => r.risk_score), 100);
  return (
    <div className="h-28 flex items-end gap-1">
      {sorted.map((r, i) => {
        const h = Math.max(3, (r.risk_score / maxRisk) * 100);
        const color = r.risk_score > 100 ? '#ef4444' : r.risk_score > 50 ? '#eab308' : '#22c55e';
        return <div key={i} className="flex-1 rounded-t" style={{ height: `${h}%`, backgroundColor: color, minHeight: '3px' }} title={`Risk: ${r.risk_score}`} />;
      })}
    </div>
  );
}

function FindingsChart({ reviews }: { reviews: { bug_count: number; security_count: number }[] }) {
  const sorted = [...reviews].slice(-20);
  if (sorted.length === 0) return <div className="h-28 flex items-center justify-center text-sm text-gray-300">No review data yet</div>;
  const max = Math.max(...sorted.map(r => r.bug_count + r.security_count), 1);
  return (
    <div className="h-28 flex items-end gap-1">
      {sorted.map((r, i) => {
        const bugH = (r.bug_count / max) * 100;
        const secH = (r.security_count / max) * 100;
        return (
          <div key={i} className="flex-1 flex flex-col justify-end" title={`Bugs: ${r.bug_count}, Security: ${r.security_count}`}>
            <div className="rounded-t bg-orange-400" style={{ height: `${Math.max(secH > 0 ? 2 : 0, secH)}%` }} />
            <div className="bg-red-400" style={{ height: `${Math.max(bugH > 0 ? 2 : 0, bugH)}%` }} />
          </div>
        );
      })}
    </div>
  );
}

function ChangesChart({ reviews }: { reviews: { total_changes: number }[] }) {
  const sorted = [...reviews].slice(-20);
  if (sorted.length === 0) return <div className="h-28 flex items-center justify-center text-sm text-gray-300">No review data yet</div>;
  const max = Math.max(...sorted.map(r => r.total_changes), 1);
  return (
    <div className="h-28 flex items-end gap-1">
      {sorted.map((r, i) => {
        const h = Math.max(3, (r.total_changes / max) * 100);
        return <div key={i} className="flex-1 rounded-t bg-blue-400" style={{ height: `${h}%`, minHeight: '3px' }} title={`Changes: ${r.total_changes}`} />;
      })}
    </div>
  );
}
