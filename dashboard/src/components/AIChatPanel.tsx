import { useState } from 'react';
import {
  ChevronDown, ChevronRight, Bug, Shield, Wrench,
  Check, X, AlertTriangle, Box,
  Fingerprint, Network, GitBranch
} from 'lucide-react';
import type { ReviewReport, ReviewFile, AiFinding, AiFix } from '../lib/types';

interface AIChatPanelProps {
  review: ReviewReport;
  selectedFile: ReviewFile | null;
  collapsed: boolean;
  onToggle: () => void;
}

export default function AIChatPanel({ review, selectedFile, collapsed, onToggle }: AIChatPanelProps) {
  if (collapsed) {
    return (
      <button
        onClick={onToggle}
        className="w-10 border-l border-gray-200 bg-gray-50 flex flex-col items-center pt-4 hover:bg-gray-100 transition-colors"
      >
        <Fingerprint size={16} className="text-violet-500" />
        <span className="text-[9px] text-gray-400 mt-1" style={{ writingMode: 'vertical-rl' }}>
          Aura Analysis
        </span>
      </button>
    );
  }

  const totalBugs = review.ai_bugs?.length ?? 0;
  const totalSecurity = review.ai_security?.length ?? 0;
  const totalViolations = review.invariant_violations?.length ?? 0;
  const totalFixes = review.ai_fixes?.length ?? 0;
  const mergeReady = review.risk_score <= 100;

  // Unverified nodes breakdown
  const unverified = review.unverified_nodes ? Object.entries(review.unverified_nodes) : [];
  const totalUnverified = unverified.reduce((s, [, c]) => s + (c as number), 0);

  // File-specific findings
  const fileBugs = selectedFile?.findings?.bugs ?? [];
  const fileSecurity = selectedFile?.findings?.security ?? [];
  const fileFixes = selectedFile?.findings?.fixes ?? [];
  const hasFileFindings = fileBugs.length + fileSecurity.length + fileFixes.length > 0;

  return (
    <div className="w-80 border-l border-gray-200 bg-white flex flex-col shrink-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-gradient-to-r from-violet-50 to-blue-50">
        <div className="flex items-center gap-2">
          <Fingerprint size={16} className="text-violet-600" />
          <span className="text-sm font-semibold text-gray-900">Aura Semantic Analysis</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-bold ${review.risk_score > 100 ? 'text-red-600' : review.risk_score > 50 ? 'text-yellow-600' : 'text-green-600'}`}>
            {review.risk_score}
          </span>
          <button onClick={onToggle} className="text-gray-400 hover:text-gray-600">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Risk Score Explanation */}
        <div className={`rounded-lg p-3 ${mergeReady ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
          <div className="flex items-center gap-2 mb-1">
            {mergeReady ? <Check size={14} className="text-green-600" /> : <X size={14} className="text-red-600" />}
            <span className={`text-sm font-semibold ${mergeReady ? 'text-green-800' : 'text-red-800'}`}>
              {mergeReady ? 'Safe to merge' : 'Merge blocked'}
            </span>
          </div>
          <p className="text-xs text-gray-600 leading-relaxed">
            {mergeReady
              ? 'Aura\'s semantic analysis found no critical issues. All architectural invariants pass.'
              : `Risk score ${review.risk_score} exceeds threshold (100). Fix the issues below before merging.`}
          </p>
        </div>

        {/* Semantic Summary — Aura's unique value */}
        <div className="bg-gray-50 rounded-lg p-3">
          <h4 className="text-xs font-semibold text-gray-900 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
            <Box size={12} className="text-violet-500" /> Semantic Breakdown
          </h4>
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-gray-500">AST nodes changed</span>
              <span className="font-semibold text-gray-900">{review.total_changes}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-500">Unverified nodes</span>
              <span className={`font-semibold ${totalUnverified > 0 ? 'text-violet-600' : 'text-green-600'}`}>{totalUnverified}</span>
            </div>
            {unverified.length > 0 && (
              <div className="pt-1.5 border-t border-gray-200 space-y-1">
                {unverified.map(([kind, count]) => (
                  <div key={kind} className="flex items-center justify-between">
                    <span className="text-gray-400 font-mono text-[10px]">{kind.replace(/_/g, ' ')}</span>
                    <span className="text-violet-600 font-mono text-[10px]">{count as number}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Findings Count */}
        <div className="grid grid-cols-2 gap-2">
          <StatBox icon={<Bug size={13} />} label="Bugs" count={totalBugs} color={totalBugs > 0 ? 'red' : 'gray'} />
          <StatBox icon={<Shield size={13} />} label="Security" count={totalSecurity} color={totalSecurity > 0 ? 'red' : 'gray'} />
          <StatBox icon={<AlertTriangle size={13} />} label="Violations" count={totalViolations} color={totalViolations > 0 ? 'yellow' : 'gray'} />
          <StatBox icon={<Wrench size={13} />} label="Fixes" count={totalFixes} color={totalFixes > 0 ? 'blue' : 'gray'} />
        </div>

        {/* Architectural Analysis */}
        <div className="bg-gray-50 rounded-lg p-3">
          <h4 className="text-xs font-semibold text-gray-900 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
            <Network size={12} className="text-orange-500" /> Architecture Impact
          </h4>
          <div className="space-y-2 text-xs">
            <ArchRow
              label="Blast radius"
              value={review.blast_radius?.length ? `${review.blast_radius.length} modules affected` : 'Contained'}
              ok={!review.blast_radius?.length}
            />
            <ArchRow
              label="Invariants"
              value={review.invariant_violations?.length ? `${review.invariant_violations.length} violations` : 'All pass'}
              ok={!review.invariant_violations?.length}
            />
            <ArchRow
              label="Cross-branch"
              value={review.cross_branch_conflicts?.length ? `${review.cross_branch_conflicts.length} conflicts` : 'No conflicts'}
              ok={!review.cross_branch_conflicts?.length}
            />
          </div>
          {review.blast_radius && review.blast_radius.length > 0 && (
            <div className="mt-2 pt-2 border-t border-gray-200">
              <span className="text-[10px] text-gray-400 uppercase tracking-wider">Affected:</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {review.blast_radius.map((m, i) => (
                  <span key={i} className="text-[10px] px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded font-mono">{m}</span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Branch context */}
        <div className="bg-gray-50 rounded-lg p-3">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <GitBranch size={12} />
            <span>Comparing <span className="font-mono font-medium text-gray-700">HEAD</span> against <span className="font-mono font-medium text-gray-700">{review.base_branch}</span></span>
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-gray-200 pt-2">
          <h4 className="text-xs font-semibold text-gray-900 uppercase tracking-wider mb-2">AI Findings</h4>
        </div>

        {/* File-specific findings */}
        {selectedFile && (
          <div>
            <div className="text-xs text-gray-500 mb-2 font-mono">{selectedFile.path.split('/').pop()}</div>
            {!hasFileFindings ? (
              <div className="text-xs text-gray-400 py-4 text-center bg-green-50 rounded-lg">
                <Check size={16} className="mx-auto text-green-400 mb-1" />
                No findings for this file
              </div>
            ) : (
              <div className="space-y-2">
                {fileBugs.map((bug, i) => <FindingMessage key={`b${i}`} finding={bug} type="bug" />)}
                {fileSecurity.map((sec, i) => <FindingMessage key={`s${i}`} finding={sec} type="security" />)}
                {fileFixes.map((fix, i) => <FixMessage key={`f${i}`} fix={fix} />)}
              </div>
            )}
          </div>
        )}

        {/* All findings (when no file selected) */}
        {!selectedFile && (
          <>
            {totalSecurity > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Security</h4>
                <div className="space-y-2">
                  {review.ai_security.map((sec, i) => <FindingMessage key={i} finding={sec} type="security" />)}
                </div>
              </div>
            )}
            {totalBugs > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Bugs</h4>
                <div className="space-y-2">
                  {review.ai_bugs.map((bug, i) => <FindingMessage key={i} finding={bug} type="bug" />)}
                </div>
              </div>
            )}
            {totalFixes > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Suggested Fixes</h4>
                <div className="space-y-2">
                  {review.ai_fixes.map((fix, i) => <FixMessage key={i} fix={fix} />)}
                </div>
              </div>
            )}
            {totalBugs + totalSecurity + totalFixes === 0 && (
              <div className="text-xs text-gray-400 py-6 text-center">
                <Check size={20} className="mx-auto text-green-400 mb-2" />
                No AI findings — code looks clean
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatBox({ icon, label, count, color }: { icon: React.ReactNode; label: string; count: number; color: string }) {
  const bg = color === 'red' ? 'bg-red-50' : color === 'yellow' ? 'bg-yellow-50' : color === 'blue' ? 'bg-blue-50' : 'bg-gray-50';
  const text = color === 'red' ? 'text-red-600' : color === 'yellow' ? 'text-yellow-600' : color === 'blue' ? 'text-blue-600' : 'text-gray-400';
  return (
    <div className={`${bg} rounded-lg p-2.5 flex items-center gap-2`}>
      <span className={text}>{icon}</span>
      <div>
        <div className={`text-base font-bold ${count > 0 ? text : 'text-gray-400'}`}>{count}</div>
        <div className="text-[10px] text-gray-500">{label}</div>
      </div>
    </div>
  );
}

function ArchRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-500">{label}</span>
      <span className={`font-medium ${ok ? 'text-green-600' : 'text-red-600'}`}>{value}</span>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const colors: Record<string, string> = {
    HIGH: 'bg-red-100 text-red-700 border-red-200',
    MED: 'bg-yellow-100 text-yellow-700 border-yellow-200',
    LOW: 'bg-blue-100 text-blue-700 border-blue-200',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${colors[severity] || colors.LOW}`}>
      {severity}
    </span>
  );
}

function FindingMessage({ finding, type }: { finding: AiFinding; type: 'bug' | 'security' }) {
  const [expanded, setExpanded] = useState(false);
  const icon = type === 'bug'
    ? <Bug size={14} className="text-red-500 shrink-0 mt-0.5" />
    : <Shield size={14} className="text-orange-500 shrink-0 mt-0.5" />;

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button onClick={() => setExpanded(!expanded)} className="w-full text-left p-3 flex items-start gap-2 hover:bg-gray-50 transition-colors">
        {icon}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <SeverityBadge severity={finding.severity} />
            <span className="text-xs font-mono text-gray-500 truncate">{finding.node}</span>
          </div>
          <p className={`text-xs text-gray-700 leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}>{finding.issue}</p>
        </div>
        {expanded ? <ChevronDown size={14} className="text-gray-400 shrink-0" /> : <ChevronRight size={14} className="text-gray-400 shrink-0" />}
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t border-gray-100 pt-2">
          <div className="text-xs text-gray-500 space-y-1">
            <div><span className="font-medium">File:</span> <span className="font-mono">{finding.file}</span></div>
            <div><span className="font-medium">Category:</span> {finding.category}</div>
            <div><span className="font-medium">AST Node:</span> <span className="font-mono">{finding.node}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}

function FixMessage({ fix }: { fix: AiFix }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-blue-200 rounded-lg overflow-hidden">
      <button onClick={() => setExpanded(!expanded)} className="w-full text-left p-3 flex items-start gap-2 hover:bg-blue-50/50 transition-colors">
        <Wrench size={14} className="text-blue-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-mono text-blue-600 mb-1">{fix.node}</div>
          <p className={`text-xs text-gray-700 leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}>{fix.issue}</p>
        </div>
        {expanded ? <ChevronDown size={14} className="text-gray-400 shrink-0" /> : <ChevronRight size={14} className="text-gray-400 shrink-0" />}
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t border-blue-100 pt-2">
          <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-1.5">Suggested Fix</div>
          <pre className="bg-gray-900 text-green-400 text-[11px] p-3 rounded-lg overflow-x-auto font-mono mb-2 leading-relaxed max-h-64 overflow-y-auto">
            {fix.suggested_fix}
          </pre>
          <button className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors font-medium">
            Apply Fix
          </button>
        </div>
      )}
    </div>
  );
}
