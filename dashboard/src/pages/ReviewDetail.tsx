import { useState, useEffect } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ChevronLeft, Loader2, GitBranch, Box, ShieldAlert,
  Fingerprint, Network, Zap, AlertTriangle
} from 'lucide-react';
import type { ReviewReport, ReviewFile } from '../lib/types';
import { api } from '../lib/api';
import FileTree from '../components/FileTree';
import DiffViewer from '../components/DiffViewer';
import AIChatPanel from '../components/AIChatPanel';

export default function ReviewDetail() {
  const location = useLocation();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const [review, setReview] = useState<ReviewReport | undefined>(
    location.state?.review as ReviewReport | undefined
  );
  const [reviewLoading, setReviewLoading] = useState(!review);
  const [files, setFiles] = useState<ReviewFile[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [showSemanticBar, setShowSemanticBar] = useState(true);

  const reviewId = id || review?.timestamp?.toString() || '';

  // Fetch review from API if not passed via navigation state
  useEffect(() => {
    if (!review && id) {
      setReviewLoading(true);
      api.getReview(id).then(res => {
        if (res.status === 'ok' && res.review) {
          setReview(res.review);
        } else {
          setError('Review not found');
        }
        setReviewLoading(false);
      }).catch(() => {
        setError('Failed to load review');
        setReviewLoading(false);
      });
    }
  }, [review, id]);

  // Load diff files once we have a valid review
  useEffect(() => {
    if (!review || !reviewId) return;
    if (!review.base_branch || review.total_changes === undefined) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await api.getReviewFiles(reviewId);
        if (cancelled) return;
        if (res.status === 'ok' && res.data) {
          setFiles(res.data.files);
          if (res.data.files.length > 0) setSelectedFilePath(res.data.files[0].path);
        } else {
          setError(res.error || 'Failed to load files');
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load review files');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [review, reviewId]);

  if (reviewLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={24} className="animate-spin text-gray-400" />
      </div>
    );
  }

  if (!review) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-base font-medium text-gray-500 mb-1">Review not found</p>
          <p className="text-sm text-gray-400 mb-4">This review may have been deleted or the ID is invalid.</p>
          <button onClick={() => navigate('/dashboard/reviews')} className="text-sm text-blue-600 hover:underline">Back to Reviews</button>
        </div>
      </div>
    );
  }

  const selectedFile = files.find(f => f.path === selectedFilePath) || null;
  const unverified = review.unverified_nodes ? Object.entries(review.unverified_nodes) : [];
  const totalUnverified = unverified.reduce((s, [, c]) => s + (c as number), 0);

  return (
    <div className="flex flex-col h-full">
      {/* Top header bar */}
      <div className="px-4 py-2 border-b border-gray-200 bg-white flex items-center gap-3 shrink-0">
        <button onClick={() => navigate('/dashboard/reviews')} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ChevronLeft size={16} /> Reviews
        </button>
        <div className="w-px h-5 bg-gray-200" />
        <div className="flex items-center gap-1.5">
          <Fingerprint size={14} className="text-violet-500" />
          <span className="text-sm text-gray-700 font-semibold">Semantic Review</span>
        </div>
        <span className="text-xs text-gray-400">against</span>
        <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-xs font-mono border border-gray-200 flex items-center gap-1">
          <GitBranch size={10} /> {review.base_branch}
        </span>
        <div className="flex-1" />
        <span className="text-xs text-gray-500">{review.total_changes} AST nodes changed</span>
        <RiskBadge score={review.risk_score} label={review.risk_label} />
        {review.timestamp && (
          <span className="text-xs text-gray-400">{new Date(review.timestamp * 1000).toLocaleDateString()}</span>
        )}
      </div>

      {/* Aura Semantic Analysis Bar — this is what makes Aura different */}
      {showSemanticBar && (
        <div className="border-b border-gray-200 bg-gradient-to-r from-violet-50/80 to-blue-50/80 px-4 py-2.5 shrink-0">
          <div className="flex items-center gap-5">
            {/* Unverified Nodes */}
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded bg-violet-100 flex items-center justify-center">
                <Box size={13} className="text-violet-600" />
              </div>
              <div>
                <div className="text-xs font-semibold text-gray-700">{totalUnverified} Unverified Nodes</div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  {unverified.map(([kind, count]) => (
                    <span key={kind} className="text-[10px] px-1.5 py-0.5 bg-violet-100 text-violet-700 rounded font-mono">
                      {kind.replace(/_/g, ' ')} ({count as number})
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="w-px h-8 bg-gray-200" />

            {/* Blast Radius */}
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded bg-orange-100 flex items-center justify-center">
                <Network size={13} className="text-orange-600" />
              </div>
              <div>
                <div className="text-xs font-semibold text-gray-700">Blast Radius</div>
                <div className="text-[10px] text-gray-500">
                  {review.blast_radius?.length ? `${review.blast_radius.length} affected modules` : 'Contained — no cross-module impact'}
                </div>
              </div>
            </div>

            <div className="w-px h-8 bg-gray-200" />

            {/* Invariant Violations */}
            <div className="flex items-center gap-2">
              <div className={`w-6 h-6 rounded flex items-center justify-center ${review.invariant_violations?.length ? 'bg-red-100' : 'bg-green-100'}`}>
                <ShieldAlert size={13} className={review.invariant_violations?.length ? 'text-red-600' : 'text-green-600'} />
              </div>
              <div>
                <div className="text-xs font-semibold text-gray-700">Invariants</div>
                <div className="text-[10px] text-gray-500">
                  {review.invariant_violations?.length ? `${review.invariant_violations.length} architectural violations` : 'All architectural rules pass'}
                </div>
              </div>
            </div>

            <div className="w-px h-8 bg-gray-200" />

            {/* Cross-branch Conflicts */}
            <div className="flex items-center gap-2">
              <div className={`w-6 h-6 rounded flex items-center justify-center ${review.cross_branch_conflicts?.length ? 'bg-yellow-100' : 'bg-green-100'}`}>
                <Zap size={13} className={review.cross_branch_conflicts?.length ? 'text-yellow-600' : 'text-green-600'} />
              </div>
              <div>
                <div className="text-xs font-semibold text-gray-700">Cross-Branch</div>
                <div className="text-[10px] text-gray-500">
                  {review.cross_branch_conflicts?.length ? `${review.cross_branch_conflicts.length} semantic conflicts` : 'No conflicts with other branches'}
                </div>
              </div>
            </div>

            <div className="flex-1" />
            <button onClick={() => setShowSemanticBar(false)} className="text-xs text-gray-400 hover:text-gray-600">Hide</button>
          </div>
        </div>
      )}

      {/* Invariant violations detail */}
      {review.invariant_violations?.length > 0 && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 shrink-0">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle size={14} className="text-red-600" />
            <span className="text-xs font-semibold text-red-800">Architectural Violations Detected</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {review.invariant_violations.map((v, i) => (
              <span key={i} className="text-[10px] px-2 py-0.5 bg-red-100 text-red-700 rounded border border-red-200">{v}</span>
            ))}
          </div>
        </div>
      )}

      {/* 3-pane layout */}
      <div className="flex flex-1 min-h-0">
        {/* Pane 1: File Tree */}
        <div className="w-56 border-r border-gray-200 bg-white shrink-0 overflow-hidden flex flex-col">
          <div className="px-3 py-2 border-b border-gray-100 bg-gray-50">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Changed Files</div>
            <div className="text-[10px] text-gray-400 mt-0.5">{files.length} files, {review.total_changes} AST nodes</div>
          </div>
          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 size={20} className="animate-spin text-gray-400" />
              </div>
            ) : error ? (
              <div className="p-3 text-xs text-red-500">{error}</div>
            ) : (
              <FileTree files={files} selectedFile={selectedFilePath} onSelectFile={setSelectedFilePath} />
            )}
          </div>
        </div>

        {/* Pane 2: Diff Editor */}
        <div className="flex-1 min-w-0 bg-white overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 size={24} className="animate-spin text-gray-400" />
            </div>
          ) : !selectedFile ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              {files.length === 0 ? 'No changed files found' : 'Select a file to view diff'}
            </div>
          ) : (
            <DiffViewer file={selectedFile} />
          )}
        </div>

        {/* Pane 3: AI Review Panel */}
        <AIChatPanel
          review={review}
          selectedFile={selectedFile}
          collapsed={chatCollapsed}
          onToggle={() => setChatCollapsed(!chatCollapsed)}
        />
      </div>
    </div>
  );
}

function RiskBadge({ score, label }: { score: number; label: string }) {
  const color = score > 100 ? 'red' : score > 50 ? 'yellow' : 'green';
  const colors = {
    red: 'bg-red-50 text-red-700 border-red-200',
    yellow: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    green: 'bg-green-50 text-green-700 border-green-200',
  };
  return (
    <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${colors[color]}`}>
      {label} ({score})
    </span>
  );
}
