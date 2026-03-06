import { useState, useCallback, useMemo, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useMutation } from '../hooks/useApi';
import { api } from '../lib/api';
import type { ReviewReport } from '../lib/types';
import {
  GitPullRequest, Play, AlertTriangle, Bug,
  Loader2, ChevronDown, Check, SlidersHorizontal,
  Settings2, Zap
} from 'lucide-react';

type Section = 'high_risk' | 'needs_review' | 'clean';

export default function ReviewList() {
  const { data: status } = useApi(useCallback(() => api.getStatus(), []));
  const { data, loading, refetch } = useApi(useCallback(() => api.getReviews(), []));
  const [baseBranch, setBaseBranch] = useState('');
  const [expandedSections, setExpandedSections] = useState<Set<Section>>(new Set(['high_risk', 'needs_review', 'clean']));
  const runReview = useMutation(useCallback((base: string) => api.runReview(base), []));

  // Auto-detect base branch from server
  useEffect(() => {
    if (status && !baseBranch) {
      setBaseBranch(status.data.default_base || 'main');
    }
  }, [status, baseBranch]);

  const handleRun = async () => {
    try { await runReview.mutate(baseBranch); refetch(); } catch {}
  };

  const toggleSection = (s: Section) => {
    const next = new Set(expandedSections);
    next.has(s) ? next.delete(s) : next.add(s);
    setExpandedSections(next);
  };

  const { highRisk, needsReview, clean } = useMemo(() => {
    const reviews = data?.reviews ?? [];
    return {
      highRisk: reviews.filter(r => r.risk_score > 100),
      needsReview: reviews.filter(r => r.risk_score > 0 && r.risk_score <= 100),
      clean: reviews.filter(r => r.risk_score === 0),
    };
  }, [data]);

  return (
    <div className="flex h-full">
      {/* Left filter sidebar */}
      <div className="w-56 border-r border-gray-200 bg-white shrink-0 hidden lg:flex flex-col">
        <div className="p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">Reviews</h3>
          <p className="text-xs text-gray-400 leading-relaxed">
            Semantic code reviews powered by AI. Analyzes your actual code changes (functions, classes, modules) — not just text diffs.
          </p>
        </div>
        <div className="px-3 space-y-0.5">
          <FilterItem label="High Risk" count={highRisk.length} dot="red" active />
          <FilterItem label="Needs Review" count={needsReview.length} dot="yellow" active />
          <FilterItem label="Clean" count={clean.length} dot="green" active />
        </div>
        <div className="mt-auto p-4 border-t border-gray-100">
          <label className="block text-xs font-medium text-gray-500 mb-1.5">Base branch</label>
          {/* Branch selector dropdown if branches available */}
          {status?.data?.branches && status.data.branches.length > 1 ? (
            <select
              value={baseBranch}
              onChange={e => setBaseBranch(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono mb-2 bg-white"
            >
              {status.data.branches.map(b => (
                <option key={b} value={b}>{b}{b === status.data.default_base ? ' (default)' : ''}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={baseBranch}
              onChange={e => setBaseBranch(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono mb-2"
            />
          )}
          <p className="text-xs text-gray-400 mb-2">Aura will compare your current branch against this base.</p>
          <button
            onClick={handleRun}
            disabled={runReview.loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {runReview.loading ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
            Run Review
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto">
        {/* Mobile run bar */}
        <div className="lg:hidden flex items-center gap-3 px-5 py-4 border-b border-gray-200 bg-white">
          <input type="text" value={baseBranch} onChange={e => setBaseBranch(e.target.value)} className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg font-mono" />
          <button onClick={handleRun} disabled={runReview.loading} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {runReview.loading ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} Run
          </button>
        </div>

        {/* Running indicator */}
        {runReview.loading && (
          <div className="flex items-center gap-3 mx-5 mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <Loader2 size={16} className="text-blue-600 animate-spin" />
            <div>
              <div className="text-sm font-medium text-blue-800">Running review...</div>
              <p className="text-xs text-blue-600">Analyzing AST changes against <code className="font-mono">{baseBranch}</code>. This may take a moment.</p>
            </div>
          </div>
        )}

        {runReview.error && (
          <div className="mx-5 mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{runReview.error}</div>
        )}

        {loading ? (
          <div className="p-6 space-y-3">
            {[1,2,3].map(i => <div key={i} className="h-16 bg-gray-50 rounded-lg animate-pulse" />)}
          </div>
        ) : !data?.reviews?.length ? (
          <div className="text-center py-24">
            <GitPullRequest size={40} className="mx-auto text-gray-300 mb-4" />
            <p className="text-base font-medium text-gray-500">No reviews yet</p>
            <p className="text-sm text-gray-400 mt-1.5 max-w-sm mx-auto">
              Click <strong>Run Review</strong> to analyze your code changes against <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono">{baseBranch}</code>.
              Aura will detect the git diff automatically and run AI analysis on your changes.
            </p>
            <button
              onClick={handleRun}
              disabled={runReview.loading}
              className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {runReview.loading ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
              Run First Review
            </button>
          </div>
        ) : (
          <div>
            <ReviewSection title="High Risk" count={highRisk.length} expanded={expandedSections.has('high_risk')} onToggle={() => toggleSection('high_risk')} reviews={highRisk} />
            <ReviewSection title="Needs Review" count={needsReview.length} expanded={expandedSections.has('needs_review')} onToggle={() => toggleSection('needs_review')} reviews={needsReview} />
            <ReviewSection title="Clean" count={clean.length} expanded={expandedSections.has('clean')} onToggle={() => toggleSection('clean')} reviews={clean} />
          </div>
        )}
      </div>
    </div>
  );
}

function FilterItem({ label, count, active, dot }: { label: string; count: number; active?: boolean; dot?: string }) {
  const dotColor = dot === 'red' ? 'bg-red-500' : dot === 'yellow' ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors ${active ? 'bg-gray-50 text-gray-900' : 'text-gray-500 hover:bg-gray-50'}`}>
      {dot && <div className={`w-2 h-2 rounded-full ${dotColor}`} />}
      <span className="flex-1">{label}</span>
      <span className="text-xs text-gray-400">{count}</span>
    </div>
  );
}

function ReviewSection({ title, count, expanded, onToggle, reviews }: {
  title: string; count: number; expanded: boolean; onToggle: () => void; reviews: ReviewReport[];
}) {
  return (
    <div className="border-b border-gray-100">
      <button onClick={onToggle} className="w-full flex items-center gap-2.5 px-5 py-3 hover:bg-gray-50 transition-colors">
        <ChevronDown size={16} className={`text-gray-400 transition-transform ${expanded ? '' : '-rotate-90'}`} />
        <span className="text-sm text-gray-500">{count}</span>
        <span className="text-sm font-semibold text-gray-900">{title}</span>
        <div className="flex-1" />
        <SlidersHorizontal size={15} className="text-gray-300" />
        <Settings2 size={15} className="text-gray-300" />
      </button>

      {expanded && reviews.length > 0 && (
        <div>
          {/* Column headers */}
          <div className="flex items-center px-5 py-2 text-xs font-medium text-gray-400 uppercase tracking-wider border-t border-gray-50">
            <div className="w-8" />
            <div className="flex-1 pl-2 flex items-center gap-1">Title <ChevronDown size={10} /></div>
            <div className="w-20 text-center">Status</div>
            <div className="w-24 text-right flex items-center justify-end gap-1">Changes</div>
            <div className="w-24 text-right">Updated</div>
          </div>

          {reviews.map((review, i) => (
            <ReviewRow key={review.timestamp || i} review={review} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewRow({ review }: { review: ReviewReport }) {
  const totalFindings = (review.ai_bugs?.length ?? 0) + (review.ai_security?.length ?? 0);
  const hasViolations = (review.invariant_violations?.length ?? 0) > 0;

  return (
    <Link
      to={`/dashboard/reviews/${review.timestamp}`}
      state={{ review }}
      className="flex items-center px-5 py-3.5 hover:bg-gray-50 transition-colors border-t border-gray-50 group"
    >
      {/* Risk dot */}
      <div className="w-8 flex justify-center">
        <div className={`w-2.5 h-2.5 rounded-full ${review.risk_score > 100 ? 'bg-red-500' : review.risk_score > 50 ? 'bg-yellow-500' : 'bg-green-500'}`} />
      </div>

      {/* Title */}
      <div className="flex-1 pl-2 min-w-0">
        <div className="text-sm font-medium text-gray-900 group-hover:text-blue-600 transition-colors">
          Review against <span className="font-mono">{review.base_branch}</span>
        </div>
        <div className="text-xs text-gray-400 mt-0.5">
          {review.risk_label} — {review.total_changes} nodes changed
        </div>
      </div>

      {/* Status icons */}
      <div className="w-20 flex items-center justify-center gap-1.5">
        {totalFindings > 0 ? (
          <span className="text-red-500"><Bug size={15} /></span>
        ) : (
          <span className="text-gray-300">—</span>
        )}
        {hasViolations ? (
          <span className="text-yellow-500"><AlertTriangle size={15} /></span>
        ) : (
          <span className="text-green-500"><Check size={15} /></span>
        )}
      </div>

      {/* Changes */}
      <div className="w-24 text-right">
        <span className="text-sm font-mono">
          <span className="text-green-600">+{review.total_changes}</span>
          <span className="text-gray-300"> / </span>
          <span className="text-red-500">-0</span>
        </span>
      </div>

      {/* Updated */}
      <div className="w-24 text-right">
        <span className="text-sm text-gray-400">
          {review.timestamp ? formatRelativeTime(review.timestamp) : '—'}
        </span>
      </div>
    </Link>
  );
}

function formatRelativeTime(timestamp: number): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < 60) return '<1m';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / 2592000)}mo`;
}
