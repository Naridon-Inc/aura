import { useState, useCallback } from 'react';
import { useApi, useMutation } from '../hooks/useApi';
import { api } from '../lib/api';
import type { PullRequest, PrReviewResponse, ReviewReport } from '../lib/types';
import {
  GitPullRequest, GitBranch, User, FileCode, Plus, Minus,
  Shield, AlertTriangle, Bug, Loader2, ExternalLink, ChevronDown, ChevronRight
} from 'lucide-react';

export default function PullRequests() {
  const { data, loading, error } = useApi(
    useCallback(() => api.getPrs(), []),
    []
  );
  const [expandedPr, setExpandedPr] = useState<number | null>(null);
  const [reviewResults, setReviewResults] = useState<Record<number, PrReviewResponse>>({});
  const { mutate: reviewPr } = useMutation(
    useCallback((num: number) => api.reviewPr(num), [])
  );
  const [reviewingPr, setReviewingPr] = useState<number | null>(null);

  const prs = data?.prs || [];

  const handleReview = async (pr: PullRequest) => {
    setReviewingPr(pr.number);
    setExpandedPr(pr.number);
    try {
      const result = await reviewPr(pr.number);
      setReviewResults(prev => ({ ...prev, [pr.number]: result }));
    } catch {
      // error handled by useMutation
    }
    setReviewingPr(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-gray-400" size={24} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Pull Requests</h2>
          <p className="text-sm text-gray-500 mt-0.5">{prs.length} open</p>
        </div>
      </div>

      {prs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <GitPullRequest size={40} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">No open pull requests</p>
        </div>
      ) : (
        <div className="space-y-3">
          {prs.map(pr => {
            const isExpanded = expandedPr === pr.number;
            const review = reviewResults[pr.number];
            const isReviewing = reviewingPr === pr.number;

            return (
              <div key={pr.number} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                {/* PR Header */}
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="mt-0.5">
                        <GitPullRequest size={18} className="text-green-500" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-gray-900">{pr.title}</span>
                          <span className="text-xs text-gray-400 font-mono">#{pr.number}</span>
                        </div>
                        <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-500">
                          <span className="flex items-center gap-1">
                            <GitBranch size={12} className="text-yellow-500" />
                            <span className="font-mono">{pr.headRefName}</span>
                            <span className="text-gray-300 mx-0.5">→</span>
                            <span className="font-mono text-green-600">{pr.baseRefName}</span>
                          </span>
                          <span className="flex items-center gap-1">
                            <User size={12} />
                            {pr.author?.login || 'unknown'}
                          </span>
                          <span className="flex items-center gap-1">
                            <FileCode size={12} />
                            {pr.changedFiles} files
                          </span>
                          <span className="flex items-center gap-1">
                            <Plus size={12} className="text-green-500" />
                            <span className="text-green-600">{pr.additions}</span>
                            <Minus size={12} className="text-red-500 ml-1" />
                            <span className="text-red-600">{pr.deletions}</span>
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {pr.url && (
                        <a
                          href={pr.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
                          title="Open on GitHub"
                        >
                          <ExternalLink size={14} />
                        </a>
                      )}
                      <button
                        onClick={() => handleReview(pr)}
                        disabled={isReviewing}
                        className="px-3 py-1.5 bg-violet-600 text-white text-xs font-medium rounded-md hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {isReviewing ? (
                          <>
                            <Loader2 size={12} className="animate-spin" />
                            Reviewing...
                          </>
                        ) : (
                          <>
                            <Shield size={12} />
                            Aura Review
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => setExpandedPr(isExpanded ? null : pr.number)}
                        className="p-1.5 rounded hover:bg-gray-100 text-gray-400"
                      >
                        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Review Results */}
                {isExpanded && review && (
                  <div className="border-t border-gray-100 bg-gray-50/50 p-4">
                    {review.error ? (
                      <div className="text-sm text-red-600 bg-red-50 p-3 rounded-md">{review.error}</div>
                    ) : review.review ? (
                      <ReviewSummary review={review.review} />
                    ) : review.message ? (
                      <p className="text-sm text-gray-500">{review.message}</p>
                    ) : null}
                  </div>
                )}

                {isExpanded && isReviewing && (
                  <div className="border-t border-gray-100 bg-gray-50/50 p-6 text-center">
                    <Loader2 size={20} className="animate-spin text-violet-500 mx-auto mb-2" />
                    <p className="text-sm text-gray-500">Running semantic review on {pr.headRefName} → {pr.baseRefName}...</p>
                    <p className="text-xs text-gray-400 mt-1">This may take a minute for large PRs</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReviewSummary({ review }: { review: ReviewReport }) {
  const riskScore = review.risk_score || 0;
  const riskLabel = review.risk_label || 'Unknown';
  const totalChanges = review.total_changes || 0;
  const bugs = review.ai_bugs || [];
  const security = review.ai_security || [];
  const violations = review.invariant_violations || [];
  const blastRadius = review.blast_radius || [];

  const riskColor = riskScore >= 7 ? 'text-red-600 bg-red-50 border-red-200'
    : riskScore >= 4 ? 'text-yellow-600 bg-yellow-50 border-yellow-200'
    : 'text-green-600 bg-green-50 border-green-200';

  return (
    <div className="space-y-3">
      {/* Risk Score */}
      <div className="flex items-center gap-3">
        <div className={`px-3 py-1.5 rounded-md border text-sm font-semibold ${riskColor}`}>
          Risk: {riskScore}/10 ({riskLabel})
        </div>
        <span className="text-xs text-gray-500">{totalChanges} semantic changes detected</span>
      </div>

      {/* Findings Grid */}
      <div className="grid grid-cols-2 gap-3">
        {bugs.length > 0 && (
          <div className="bg-white border border-orange-200 rounded-md p-3">
            <div className="flex items-center gap-1.5 text-orange-600 text-xs font-semibold mb-2">
              <Bug size={13} />
              {bugs.length} Bug{bugs.length > 1 ? 's' : ''} Found
            </div>
            {bugs.slice(0, 5).map((bug, i) => (
              <div key={i} className="text-xs text-gray-600 py-1 border-t border-gray-100 first:border-0">
                <span className="font-mono text-gray-400">{bug.file}:</span> {bug.issue}
              </div>
            ))}
          </div>
        )}

        {security.length > 0 && (
          <div className="bg-white border border-red-200 rounded-md p-3">
            <div className="flex items-center gap-1.5 text-red-600 text-xs font-semibold mb-2">
              <AlertTriangle size={13} />
              {security.length} Security Issue{security.length > 1 ? 's' : ''}
            </div>
            {security.slice(0, 5).map((sec, i) => (
              <div key={i} className="text-xs text-gray-600 py-1 border-t border-gray-100 first:border-0">
                <span className="font-mono text-gray-400">{sec.file}:</span> {sec.issue}
              </div>
            ))}
          </div>
        )}
      </div>

      {violations.length > 0 && (
        <div className="bg-white border border-yellow-200 rounded-md p-3">
          <div className="text-xs font-semibold text-yellow-700 mb-1">Invariant Violations</div>
          {violations.slice(0, 5).map((v, i) => (
            <div key={i} className="text-xs text-gray-600 py-0.5">{v}</div>
          ))}
        </div>
      )}

      {blastRadius.length > 0 && (
        <div className="text-xs text-gray-500">
          <span className="font-medium">Blast Radius:</span> {blastRadius.slice(0, 10).join(', ')}
          {blastRadius.length > 10 && ` +${blastRadius.length - 10} more`}
        </div>
      )}

      {bugs.length === 0 && security.length === 0 && violations.length === 0 && (
        <div className="text-sm text-green-600 bg-green-50 border border-green-200 rounded-md p-3">
          No bugs, security issues, or invariant violations detected.
        </div>
      )}
    </div>
  );
}
