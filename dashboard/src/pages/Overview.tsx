import { useCallback, useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useMutation } from '../hooks/useApi';
import { api } from '../lib/api';
import {
  GitPullRequest, Clock, BarChart3, AlertTriangle,
  Shield, Bug, ArrowRight, GitBranch, Check, X, Info,
  Loader2, Play, Zap
} from 'lucide-react';

export default function Overview() {
  const { data: status, loading } = useApi(
    useCallback(() => api.getStatus(), []),
    [],
    { pollInterval: 10000 }
  );
  const { data: reviews, refetch: refetchReviews } = useApi(useCallback(() => api.getReviews(), []));
  const { data: metrics } = useApi(useCallback(() => api.getMetrics(), []));

  // Auto-review state
  const [autoReviewStarted, setAutoReviewStarted] = useState(false);
  const autoReviewTriggered = useRef(false);
  const runReview = useMutation(useCallback((base: string) => api.runReview(base), []));

  // Auto-trigger a review when dashboard opens and no reviews exist
  useEffect(() => {
    if (
      status &&
      !loading &&
      reviews &&
      reviews.reviews.length === 0 &&
      !autoReviewTriggered.current &&
      !runReview.loading
    ) {
      autoReviewTriggered.current = true;
      setAutoReviewStarted(true);
      const base = status.data.default_base || 'main';
      runReview.mutate(base).then(() => {
        refetchReviews();
        setAutoReviewStarted(false);
      }).catch(() => {
        setAutoReviewStarted(false);
      });
    }
  }, [status, loading, reviews, runReview, refetchReviews]);

  if (loading || !status) {
    return (
      <div className="p-8 space-y-5 animate-pulse">
        <div className="h-24 bg-white rounded-lg border border-gray-200" />
        <div className="grid grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <div key={i} className="h-28 bg-white rounded-lg border border-gray-200" />)}
        </div>
      </div>
    );
  }

  const s = status.data;
  const latestReview = reviews?.reviews?.[0];
  const totalBugs = metrics?.review_history?.reduce((acc, r) => acc + r.bug_count, 0) ?? 0;
  const totalSecurity = metrics?.review_history?.reduce((acc, r) => acc + r.security_count, 0) ?? 0;
  const avgRisk = metrics?.review_history?.length
    ? Math.round(metrics.review_history.reduce((acc, r) => acc + r.risk_score, 0) / metrics.review_history.length)
    : 0;

  return (
    <div className="p-8 max-w-[1080px] mx-auto space-y-6">
      {/* Auto-review banner */}
      {autoReviewStarted && (
        <div className="flex items-center gap-3 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <Loader2 size={18} className="text-blue-600 animate-spin" />
          <div>
            <div className="text-sm font-medium text-blue-800">Running first review automatically...</div>
            <p className="text-xs text-blue-600 mt-0.5">
              Aura detected your local git repo and is analyzing changes against <code className="font-mono bg-blue-100 px-1 rounded">{s.default_base}</code>. This may take a moment.
            </p>
          </div>
        </div>
      )}

      {/* Repository status card */}
      <div className="bg-white border border-gray-200 rounded-lg p-5">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Repository Connected</h2>
            <p className="text-sm text-gray-500">
              Aura is connected to your local git repository and tracking semantic changes automatically.
              {s.review_count === 0 && !autoReviewStarted && ' No reviews yet — click "Run Review" in PR Reviews to get started.'}
              {s.review_count > 0 && ` ${s.review_count} review${s.review_count > 1 ? 's' : ''} completed.`}
            </p>
          </div>
          <div className="text-right shrink-0 ml-8">
            <div className="text-2xl font-bold text-blue-600">{s.total_checkpoints}</div>
            <div className="text-xs text-gray-500">checkpoints</div>
          </div>
        </div>
        <div className="flex items-center gap-3 mt-4 pt-4 border-t border-gray-100">
          <GitBranch size={16} className="text-blue-500" />
          <span className="text-sm font-mono text-gray-700 font-medium">{s.branch}</span>
          <span className="text-gray-300">|</span>
          <span className="text-sm text-gray-500 truncate">{s.last_commit.message}</span>
          <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded font-mono ml-auto shrink-0">{s.last_commit.id.slice(0, 7)}</span>
        </div>
        {/* Show available branches */}
        {s.branches && s.branches.length > 1 && (
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-50">
            <span className="text-xs text-gray-400">Branches:</span>
            {s.branches.slice(0, 6).map(b => (
              <span key={b} className={`text-xs px-2 py-0.5 rounded font-mono ${b === s.default_base ? 'bg-blue-50 text-blue-600 border border-blue-200' : 'bg-gray-50 text-gray-500'}`}>
                {b}{b === s.default_base && ' (base)'}
              </span>
            ))}
            {s.branches.length > 6 && <span className="text-xs text-gray-400">+{s.branches.length - 6} more</span>}
          </div>
        )}
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricTile label="Checkpoints" value={s.total_checkpoints} desc="Semantic snapshots of your codebase" />
        <MetricTile label="Avg Risk" value={avgRisk} desc="Average risk score across reviews" color={avgRisk > 100 ? 'red' : avgRisk > 50 ? 'yellow' : 'green'} />
        <MetricTile label="Bugs Found" value={totalBugs} desc="AI-detected bugs in your code" color={totalBugs > 0 ? 'red' : 'green'} />
        <MetricTile label="Security" value={totalSecurity} desc="Security vulnerabilities detected" color={totalSecurity > 0 ? 'red' : 'green'} />
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <QuickLink
          to="/dashboard/reviews"
          icon={<GitPullRequest size={20} />}
          label="PR Reviews"
          desc="Run AI-powered code reviews against any branch. Aura analyzes your actual code changes (AST diffs), not just text diffs."
          badge={reviews?.reviews?.length ? `${reviews.reviews.length} reviews` : undefined}
        />
        <QuickLink
          to="/dashboard/checkpoints"
          icon={<Clock size={20} />}
          label="Checkpoints"
          desc="Browse your commit history as semantic snapshots. Each checkpoint records which functions, classes, and modules changed."
          badge={s.total_checkpoints ? `${s.total_checkpoints} tracked` : undefined}
        />
        <QuickLink
          to="/dashboard/analytics"
          icon={<BarChart3 size={20} />}
          label="Analytics"
          desc="Track code health trends: risk scores, bug counts, most-modified functions, and node type distribution."
        />
      </div>

      {/* Latest review */}
      {latestReview && (
        <div className="bg-white border border-gray-200 rounded-lg">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <Zap size={16} className="text-blue-500" />
              <span className="text-sm font-semibold text-gray-900">Latest Review</span>
              <span className="text-sm text-gray-400">against <span className="font-mono">{latestReview.base_branch}</span></span>
            </div>
            <div className="flex items-center gap-3">
              <RiskPill score={latestReview.risk_score} label={latestReview.risk_label} />
              {latestReview.risk_score <= 100 ? (
                <span className="flex items-center gap-1 text-sm text-green-600"><Check size={14} /> Ready to merge</span>
              ) : (
                <span className="flex items-center gap-1 text-sm text-red-600"><X size={14} /> Needs attention</span>
              )}
            </div>
          </div>
          <div className="px-5 py-4 flex items-center gap-8">
            <Stat icon={<GitPullRequest size={15} />} label="Changes" value={latestReview.total_changes} />
            <Stat icon={<Bug size={15} />} label="Bugs" value={latestReview.ai_bugs?.length ?? 0} warn={(latestReview.ai_bugs?.length ?? 0) > 0} />
            <Stat icon={<Shield size={15} />} label="Security" value={latestReview.ai_security?.length ?? 0} warn={(latestReview.ai_security?.length ?? 0) > 0} />
            <Stat icon={<AlertTriangle size={15} />} label="Violations" value={latestReview.invariant_violations?.length ?? 0} warn={(latestReview.invariant_violations?.length ?? 0) > 0} />
            <div className="flex-1" />
            <Link to={`/dashboard/reviews/${latestReview.timestamp}`} state={{ review: latestReview }} className="text-sm text-blue-600 hover:underline flex items-center gap-1 font-medium">
              View full review <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      )}

      {/* No reviews prompt */}
      {!latestReview && !autoReviewStarted && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 text-center">
          <Play size={32} className="mx-auto text-gray-300 mb-3" />
          <h3 className="text-base font-semibold text-gray-900 mb-1">No Reviews Yet</h3>
          <p className="text-sm text-gray-500 max-w-md mx-auto mb-4">
            Go to <strong>PR Reviews</strong> and click <strong>Run Review</strong> to analyze your code changes against the <code className="font-mono bg-gray-100 px-1.5 py-0.5 rounded text-xs">{s.default_base}</code> branch.
          </p>
          <Link to="/dashboard/reviews" className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
            <GitPullRequest size={16} /> Go to Reviews
          </Link>
        </div>
      )}

      {/* Top churned nodes — improved labels */}
      {metrics && metrics.top_churned_nodes.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-900">Most Changed Code</span>
            <span className="group relative">
              <Info size={14} className="text-gray-300 cursor-help" />
              <span className="absolute left-6 top-0 w-72 p-2.5 bg-gray-900 text-white text-xs rounded-md opacity-0 group-hover:opacity-100 pointer-events-none z-50 shadow-lg transition-opacity leading-relaxed">
                These are the functions, classes, and variables that change most frequently across commits. High churn often indicates code that's fragile, has unclear ownership, or needs refactoring.
              </span>
            </span>
          </div>
          <div className="divide-y divide-gray-50">
            {metrics.top_churned_nodes.slice(0, 8).map(([name, count]) => (
              <div key={name} className="flex items-center px-5 py-3">
                <div className="w-56 min-w-0">
                  <span className="text-sm font-mono text-gray-700 truncate block">{name}</span>
                  <span className="text-xs text-gray-400">{count} modification{count > 1 ? 's' : ''} across commits</span>
                </div>
                <div className="flex-1 mx-4">
                  <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-400 rounded-full transition-all" style={{ width: `${(count / metrics.top_churned_nodes[0][1]) * 100}%` }} />
                  </div>
                </div>
                <span className="text-sm font-semibold text-gray-600 w-12 text-right">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MetricTile({ label, value, desc, color }: { label: string; value: number; desc: string; color?: string }) {
  const valColor = color === 'red' ? 'text-red-600' : color === 'yellow' ? 'text-yellow-600' : color === 'green' ? 'text-green-600' : 'text-gray-900';
  return (
    <div className="bg-white border border-gray-200 rounded-lg px-5 py-4">
      <div className={`text-2xl font-bold ${valColor}`}>{value}</div>
      <div className="text-sm font-medium text-gray-700 mt-1">{label}</div>
      <div className="text-xs text-gray-400 mt-0.5">{desc}</div>
    </div>
  );
}

function QuickLink({ to, icon, label, desc, badge }: { to: string; icon: React.ReactNode; label: string; desc: string; badge?: string }) {
  return (
    <Link to={to} className="group bg-white border border-gray-200 rounded-lg p-5 hover:border-gray-300 hover:shadow-sm transition-all">
      <div className="flex items-center justify-between mb-3">
        <div className="text-gray-400 group-hover:text-blue-600 transition-colors">{icon}</div>
        <div className="flex items-center gap-2">
          {badge && <span className="text-xs text-gray-400 bg-gray-50 px-2 py-0.5 rounded">{badge}</span>}
          <ArrowRight size={16} className="text-gray-300 group-hover:text-blue-500 transition-colors" />
        </div>
      </div>
      <h3 className="text-base font-semibold text-gray-900">{label}</h3>
      <p className="text-sm text-gray-500 mt-1.5 leading-relaxed">{desc}</p>
    </Link>
  );
}

function RiskPill({ score, label }: { score: number; label: string }) {
  const c = score > 100 ? 'bg-red-50 text-red-700 border-red-200' : score > 50 ? 'bg-yellow-50 text-yellow-700 border-yellow-200' : 'bg-green-50 text-green-700 border-green-200';
  return <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${c}`}>{label}</span>;
}

function Stat({ icon, label, value, warn }: { icon: React.ReactNode; label: string; value: number; warn?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={warn ? 'text-red-500' : 'text-gray-400'}>{icon}</span>
      <span className={`text-sm ${warn ? 'text-red-600 font-medium' : 'text-gray-600'}`}>{value} {label}</span>
    </div>
  );
}
