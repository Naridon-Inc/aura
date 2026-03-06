import { useCallback, useState } from 'react';
import { useApi, useMutation } from '../hooks/useApi';
import { api } from '../lib/api';
import type {
  SymphonyStatusResponse, SymphonyWorker, SymphonyCompleted,
  SymphonyMetaResponse, SymphonyIssuesResponse, LinearIssue,
  SymphonyCreateIssueRequest, SymphonyUpdateIssueRequest,
  SymphonyDecomposeRequest, DecompositionResult,
} from '../lib/types';
import {
  Music, Clock, CheckCircle2, XCircle, Loader2, ExternalLink,
  Cpu, Coins, AlertTriangle, Plus, List, Edit3, ChevronDown, ChevronRight,
  FileText,
} from 'lucide-react';

const POLL_INTERVAL = 3000;
const PRIORITY_OPTIONS = [
  { value: 0, label: 'No priority' },
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
];

type Tab = 'daemon' | 'issues' | 'create' | 'decompose';

export default function Symphony() {
  const { data: statusData, loading } = useApi<SymphonyStatusResponse>(
    useCallback(() => api.getSymphonyStatus(), []),
    [],
    { pollInterval: POLL_INTERVAL }
  );

  const [tab, setTab] = useState<Tab>('issues');
  const [createdIssue, setCreatedIssue] = useState<{ identifier: string; url: string } | null>(null);

  const daemon = statusData?.daemon ?? null;

  if (loading && !statusData) {
    return (
      <div className="p-8 space-y-5 animate-pulse">
        <div className="h-32 bg-white rounded-lg border border-gray-200" />
        <div className="h-64 bg-white rounded-lg border border-gray-200" />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-[1080px] mx-auto space-y-6">
      {/* Header */}
      <div className="bg-white border border-gray-200 rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Music size={18} strokeWidth={1.75} className="text-cyan-500" />
            <span className="text-sm font-semibold text-gray-900">Aura Symphony</span>
            {daemon && <StatusPill running={daemon.running} stale={daemon.updated_at > 0 && (Date.now() / 1000 - daemon.updated_at) > 30} />}
          </div>
          {daemon && (
            <div className="text-xs text-gray-400">Updated {formatTimestamp(daemon.updated_at)}</div>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex items-center gap-1 border-b border-gray-100 -mx-5 px-5">
          <TabButton active={tab === 'issues'} onClick={() => setTab('issues')} icon={<List size={13} />} label="Issues" />
          <TabButton active={tab === 'create'} onClick={() => { setTab('create'); setCreatedIssue(null); }} icon={<Plus size={13} />} label="Create" />
          <TabButton active={tab === 'decompose'} onClick={() => setTab('decompose')} icon={<FileText size={13} />} label="PRD → Tasks" />
          <TabButton active={tab === 'daemon'} onClick={() => setTab('daemon')} icon={<Cpu size={13} />} label="Daemon" />
        </div>
      </div>

      {/* Success banner */}
      {createdIssue && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 size={14} className="text-green-600" />
            <span className="text-green-800 font-medium">Created {createdIssue.identifier}</span>
          </div>
          <a href={createdIssue.url} target="_blank" rel="noopener noreferrer"
            className="text-xs text-green-700 hover:underline flex items-center gap-1">
            Open in Linear <ExternalLink size={10} />
          </a>
        </div>
      )}

      {/* Tab content */}
      {tab === 'issues' && <IssuesTab />}
      {tab === 'create' && (
        <CreateIssueForm onCreated={(issue) => {
          setCreatedIssue({ identifier: issue.identifier, url: issue.url });
          setTab('issues');
        }} />
      )}
      {tab === 'decompose' && <DecomposeTab />}
      {tab === 'daemon' && <DaemonTab daemon={daemon} />}
    </div>
  );
}

// ─── Issues Tab ─────────────────────────────────────────────────────────────

function IssuesTab() {
  const { data, loading, refetch } = useApi<SymphonyIssuesResponse>(
    useCallback(() => api.getSymphonyIssues(80), []),
    []
  );

  const [editingId, setEditingId] = useState<string | null>(null);

  const issues = data?.issues ?? [];

  // Group by state
  const grouped = issues.reduce<Record<string, LinearIssue[]>>((acc, issue) => {
    const state = issue.state || 'Unknown';
    if (!acc[state]) acc[state] = [];
    acc[state].push(issue);
    return acc;
  }, {});

  // Order states sensibly
  const stateOrder = ['In Progress', 'Todo', 'Backlog', 'Done', 'Cancelled', 'Closed'];
  const orderedStates = [
    ...stateOrder.filter(s => grouped[s]),
    ...Object.keys(grouped).filter(s => !stateOrder.includes(s)),
  ];

  if (loading && !data) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
        <Loader2 size={20} className="text-gray-300 mx-auto animate-spin" />
      </div>
    );
  }

  if (issues.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
        <p className="text-sm text-gray-500">No issues found for this team.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {orderedStates.map(state => (
        <IssueStateGroup
          key={state}
          state={state}
          issues={grouped[state]}
          editingId={editingId}
          onEdit={setEditingId}
          onUpdated={() => { setEditingId(null); refetch(); }}
        />
      ))}
    </div>
  );
}

function IssueStateGroup({ state, issues, editingId, onEdit, onUpdated }: {
  state: string;
  issues: LinearIssue[];
  editingId: string | null;
  onEdit: (id: string | null) => void;
  onUpdated: () => void;
}) {
  const [collapsed, setCollapsed] = useState(state === 'Done' || state === 'Cancelled' || state === 'Closed');

  return (
    <div className="bg-white border border-gray-200 rounded-lg">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full px-5 py-3 flex items-center gap-2 text-left hover:bg-gray-50 transition-colors"
      >
        {collapsed ? <ChevronRight size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
        <span className="text-sm font-semibold text-gray-900">{state}</span>
        <span className="text-xs text-gray-400">({issues.length})</span>
      </button>
      {!collapsed && (
        <div className="divide-y divide-gray-100 border-t border-gray-100">
          {issues.map(issue => (
            editingId === issue.id
              ? <InlineEditRow key={issue.id} issue={issue} onCancel={() => onEdit(null)} onUpdated={onUpdated} />
              : <IssueRow key={issue.id} issue={issue} onEdit={() => onEdit(issue.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function IssueRow({ issue, onEdit }: { issue: LinearIssue; onEdit: () => void }) {
  const priorityIcon = issue.priority === 1 ? '🔴' : issue.priority === 2 ? '🟠' : issue.priority === 3 ? '🟡' : issue.priority === 4 ? '🔵' : '⚪';

  return (
    <div className="px-5 py-2.5 flex items-center justify-between group hover:bg-gray-50 transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-xs shrink-0">{priorityIcon}</span>
        <a href={issue.url} target="_blank" rel="noopener noreferrer"
          className="text-sm font-semibold text-blue-600 hover:underline shrink-0">
          {issue.identifier}
        </a>
        <span className="text-sm text-gray-700 truncate">{issue.title}</span>
        {issue.labels.map(l => (
          <span key={l} className="px-1.5 py-0.5 text-[10px] rounded-full bg-gray-100 text-gray-500 shrink-0">{l}</span>
        ))}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {issue.project && <span className="text-[10px] px-1.5 py-0.5 bg-purple-50 text-purple-600 rounded">{issue.project}</span>}
        {issue.due_date && <span className="text-[10px] text-gray-400">{issue.due_date}</span>}
        {issue.assignee && <span className="text-xs text-gray-500">{issue.assignee.split(' ')[0]}</span>}
        {(issue.sub_issue_count ?? 0) > 0 && <span className="text-[10px] text-gray-400">{issue.sub_issue_count} sub</span>}
        <button onClick={onEdit} className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-gray-200 rounded">
          <Edit3 size={12} className="text-gray-400" />
        </button>
      </div>
    </div>
  );
}

// ─── Inline Edit ────────────────────────────────────────────────────────────

function InlineEditRow({ issue, onCancel, onUpdated }: { issue: LinearIssue; onCancel: () => void; onUpdated: () => void }) {
  const { data: metaData } = useApi<SymphonyMetaResponse>(
    useCallback(() => api.getSymphonyFullMeta(), []),
    []
  );
  const { mutate, loading, error } = useMutation(
    useCallback((params: SymphonyUpdateIssueRequest) => api.updateSymphonyIssue(params), [])
  );

  const meta = metaData?.meta;
  const [state, setState] = useState(issue.state);
  const [priority, setPriority] = useState(issue.priority ?? 0);
  const [assignee, setAssignee] = useState(issue.assignee ?? '');
  const [project, setProject] = useState(issue.project ?? '');
  const [dueDate, setDueDate] = useState(issue.due_date ?? '');

  const handleSave = async () => {
    const params: SymphonyUpdateIssueRequest = { id: issue.id };
    if (state !== issue.state) params.state = state;
    if (priority !== (issue.priority ?? 0)) params.priority = priority || undefined;
    if (assignee !== (issue.assignee ?? '')) params.assignee = assignee || undefined;
    if (project !== (issue.project ?? '')) params.project = project || undefined;
    if (dueDate !== (issue.due_date ?? '')) params.due_date = dueDate || undefined;

    try {
      await mutate(params);
      onUpdated();
    } catch { /* handled by useMutation */ }
  };

  return (
    <div className="px-5 py-3 bg-cyan-50/50 border-l-2 border-cyan-400 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-cyan-700">{issue.identifier} — {issue.title}</span>
        <div className="flex items-center gap-2">
          <button onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
          <button onClick={handleSave} disabled={loading}
            className="text-xs px-2.5 py-1 bg-cyan-600 text-white rounded hover:bg-cyan-700 disabled:opacity-50">
            {loading ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-5 gap-3">
        <div>
          <label className="block text-[10px] text-gray-400 mb-0.5">State</label>
          <select value={state} onChange={e => setState(e.target.value)}
            className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded bg-white">
            {meta?.states?.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
            {!meta?.states?.find(s => s.name === state) && <option value={state}>{state}</option>}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-gray-400 mb-0.5">Priority</label>
          <select value={priority} onChange={e => setPriority(Number(e.target.value))}
            className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded bg-white">
            {PRIORITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-gray-400 mb-0.5">Assignee</label>
          <select value={assignee} onChange={e => setAssignee(e.target.value)}
            className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded bg-white">
            <option value="">Unassigned</option>
            {meta?.members?.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-gray-400 mb-0.5">Project</label>
          <select value={project} onChange={e => setProject(e.target.value)}
            className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded bg-white">
            <option value="">None</option>
            {meta?.projects?.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-gray-400 mb-0.5">Due Date</label>
          <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
            className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded bg-white" />
        </div>
      </div>
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}

// ─── Create Issue Form ──────────────────────────────────────────────────────

function CreateIssueForm({ onCreated }: { onCreated: (issue: { identifier: string; url: string }) => void }) {
  const { data: metaData, loading: metaLoading } = useApi<SymphonyMetaResponse>(
    useCallback(() => api.getSymphonyFullMeta(), []),
    []
  );

  const { mutate, loading: submitting, error } = useMutation(
    useCallback((params: SymphonyCreateIssueRequest) => api.createSymphonyIssue(params), [])
  );

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(0);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [assignee, setAssignee] = useState('');
  const [estimate, setEstimate] = useState('');
  const [project, setProject] = useState('');
  const [cycle, setCycle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [parentId, setParentId] = useState('');

  const meta = metaData?.meta;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    const params: SymphonyCreateIssueRequest = { title: title.trim() };
    if (description.trim()) params.description = description.trim();
    if (priority > 0) params.priority = priority;
    if (selectedLabels.length > 0) params.labels = selectedLabels;
    if (assignee) params.assignee = assignee;
    if (estimate && parseInt(estimate) > 0) params.estimate = parseInt(estimate);
    if (project) params.project = project;
    if (cycle) params.cycle = cycle;
    if (dueDate) params.due_date = dueDate;
    if (parentId) params.parent_id = parentId;

    try {
      const result = await mutate(params);
      if (result.status === 'ok' && result.issue) {
        onCreated({ identifier: result.issue.identifier, url: result.issue.url });
      }
    } catch { /* error handled by useMutation */ }
  };

  const toggleLabel = (name: string) => {
    setSelectedLabels(prev => prev.includes(name) ? prev.filter(l => l !== name) : [...prev, name]);
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
      <div className="flex items-center gap-2 mb-1">
        <Plus size={14} className="text-cyan-500" />
        <span className="text-sm font-semibold text-gray-900">Create Issue</span>
      </div>

      {/* Title */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Title *</label>
        <input type="text" value={title} onChange={e => setTitle(e.target.value)}
          placeholder="Issue title" required autoFocus
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-400 focus:border-cyan-400" />
      </div>

      {/* Description */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Description</label>
        <textarea value={description} onChange={e => setDescription(e.target.value)}
          placeholder="Describe the issue..." rows={3}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-400 focus:border-cyan-400 resize-y" />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Priority</label>
          <select value={priority} onChange={e => setPriority(Number(e.target.value))}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-400 bg-white">
            {PRIORITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Estimate (points)</label>
          <input type="number" value={estimate} onChange={e => setEstimate(e.target.value)}
            placeholder="0" min={0}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-400" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Due Date</label>
          <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-400" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* Assignee */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Assignee</label>
          <select value={assignee} onChange={e => setAssignee(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-400 bg-white">
            <option value="">Unassigned</option>
            {meta?.members?.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
          </select>
        </div>
        {/* Project */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Project</label>
          <select value={project} onChange={e => setProject(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-400 bg-white">
            <option value="">None</option>
            {meta?.projects?.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
          </select>
        </div>
        {/* Cycle */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Cycle</label>
          <select value={cycle} onChange={e => setCycle(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-400 bg-white">
            <option value="">None</option>
            {meta?.cycles?.map(c => (
              <option key={c.id} value={c.name || c.number.toString()}>
                {c.name || `Cycle ${c.number}`}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Parent issue (sub-issue) */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Parent Issue ID (for sub-issues)</label>
        <input type="text" value={parentId} onChange={e => setParentId(e.target.value)}
          placeholder="Leave empty for top-level issue"
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-400" />
      </div>

      {/* Labels */}
      {meta && meta.labels.length > 0 && (
        <div>
          <label className="block text-xs text-gray-500 mb-1.5">Labels</label>
          <div className="flex flex-wrap gap-1.5">
            {meta.labels.map(l => (
              <button key={l.id} type="button" onClick={() => toggleLabel(l.name)}
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                  selectedLabels.includes(l.name)
                    ? 'bg-cyan-50 border-cyan-300 text-cyan-700'
                    : 'bg-gray-50 border-gray-200 text-gray-500 hover:border-gray-300'
                }`}>
                {l.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {metaLoading && (
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <Loader2 size={12} className="animate-spin" /> Loading team metadata...
        </div>
      )}

      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>
      )}

      <div className="flex justify-end">
        <button type="submit" disabled={!title.trim() || submitting}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          {submitting ? 'Creating...' : 'Create Issue'}
        </button>
      </div>
    </form>
  );
}

// ─── Decompose Tab ──────────────────────────────────────────────────────────

function DecomposeTab() {
  const { data: metaData } = useApi<SymphonyMetaResponse>(
    useCallback(() => api.getSymphonyFullMeta(), []),
    []
  );
  const { mutate, loading, error } = useMutation(
    useCallback((params: SymphonyDecomposeRequest) => api.decomposePrd(params), [])
  );

  const [prdContent, setPrdContent] = useState('');
  const [project, setProject] = useState('');
  const [selectedAssignees, setSelectedAssignees] = useState<string[]>([]);
  const [dryRun, setDryRun] = useState(true);
  const [result, setResult] = useState<DecompositionResult | null>(null);

  const meta = metaData?.meta;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prdContent.trim()) return;

    const params: SymphonyDecomposeRequest = {
      prd_content: prdContent.trim(),
      dry_run: dryRun,
    };
    if (project) params.project = project;
    if (selectedAssignees.length > 0) params.assignees = selectedAssignees;

    try {
      const res = await mutate(params);
      if (res.status === 'ok' && res.result) {
        setResult(res.result);
      }
    } catch { /* handled by useMutation */ }
  };

  const handleExecute = async () => {
    if (!prdContent.trim()) return;
    const params: SymphonyDecomposeRequest = {
      prd_content: prdContent.trim(),
      dry_run: false,
    };
    if (project) params.project = project;
    if (selectedAssignees.length > 0) params.assignees = selectedAssignees;

    try {
      const res = await mutate(params);
      if (res.status === 'ok' && res.result) {
        setResult(res.result);
      }
    } catch { /* handled */ }
  };

  const toggleAssignee = (name: string) => {
    setSelectedAssignees(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);
  };

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <FileText size={14} className="text-cyan-500" />
          <span className="text-sm font-semibold text-gray-900">PRD → Linear Issues</span>
          <span className="text-xs text-gray-400">Paste a PRD and Aura will decompose it into waves of tasks</span>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">PRD Content *</label>
          <textarea value={prdContent} onChange={e => setPrdContent(e.target.value)}
            placeholder="Paste your Product Requirements Document here..."
            rows={12} required
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-400 font-mono resize-y" />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Project</label>
            <select value={project} onChange={e => setProject(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white">
              <option value="">Auto-detect from PRD</option>
              {meta?.projects?.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Round-Robin Assignees</label>
            <div className="flex flex-wrap gap-1.5 min-h-[38px] items-center">
              {meta?.members?.map(m => (
                <button key={m.id} type="button" onClick={() => toggleAssignee(m.name)}
                  className={`px-2 py-1 text-xs rounded-full border transition-colors ${
                    selectedAssignees.includes(m.name)
                      ? 'bg-cyan-50 border-cyan-300 text-cyan-700'
                      : 'bg-gray-50 border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}>
                  {m.name.split(' ')[0]}
                </button>
              ))}
            </div>
          </div>
        </div>

        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>}

        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs text-gray-500">
            <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)}
              className="rounded border-gray-300" />
            Dry run (preview without creating)
          </label>
          <button type="submit" disabled={!prdContent.trim() || loading}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50 transition-colors">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
            {loading ? 'Decomposing...' : dryRun ? 'Preview Plan' : 'Create Issues'}
          </button>
        </div>
      </form>

      {/* Results */}
      {result && (
        <div className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-sm font-semibold text-gray-900">{result.project_name}</span>
                <span className="text-xs text-gray-400 ml-2">{result.total_tasks} tasks in {result.waves.length} waves</span>
              </div>
              {result.created_issues.length === 0 && !loading && (
                <button onClick={handleExecute} disabled={loading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-colors">
                  {loading ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                  Create All in Linear
                </button>
              )}
            </div>
            <p className="text-xs text-gray-500">{result.summary}</p>
          </div>

          {result.waves.map(wave => (
            <div key={wave.wave_number} className="bg-white border border-gray-200 rounded-lg">
              <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
                <span className="text-xs font-bold text-cyan-600 bg-cyan-50 px-2 py-0.5 rounded">Wave {wave.wave_number}</span>
                <span className="text-xs text-gray-400">{wave.tasks.length} tasks</span>
              </div>
              <div className="divide-y divide-gray-100">
                {wave.tasks.map((task, i) => {
                  const pIcon = task.priority === 1 ? '🔴' : task.priority === 2 ? '🟠' : task.priority === 3 ? '🟡' : '🔵';
                  const created = result.created_issues.find(iss => iss.title === task.title);
                  return (
                    <div key={i} className="px-5 py-2.5 flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-xs shrink-0">{pIcon}</span>
                        {created ? (
                          <a href={created.url} target="_blank" rel="noopener noreferrer"
                            className="text-sm font-semibold text-green-600 hover:underline shrink-0">
                            {created.identifier}
                          </a>
                        ) : (
                          <span className="text-xs text-gray-300 shrink-0">--</span>
                        )}
                        <span className="text-sm text-gray-700 truncate">{task.title}</span>
                        {task.labels.map(l => (
                          <span key={l} className="px-1.5 py-0.5 text-[10px] rounded-full bg-gray-100 text-gray-500 shrink-0">{l}</span>
                        ))}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {task.estimate && <span className="text-[10px] text-gray-400">{task.estimate}pt</span>}
                        {task.depends_on.length > 0 && (
                          <span className="text-[10px] text-orange-400">← {task.depends_on.length} dep</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {result.created_issues.length > 0 && (
            <div className="bg-green-50 border border-green-200 rounded-lg px-5 py-3">
              <div className="flex items-center gap-2 text-sm text-green-800 font-medium">
                <CheckCircle2 size={14} className="text-green-600" />
                Created {result.created_issues.length} issues in Linear
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Daemon Tab ─────────────────────────────────────────────────────────────

function DaemonTab({ daemon }: { daemon: SymphonyStatusResponse['daemon'] }) {
  if (!daemon) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
        <Music size={32} strokeWidth={1.5} className="text-gray-300 mx-auto mb-3" />
        <p className="text-sm text-gray-500">No Symphony daemon detected.</p>
        <p className="text-xs text-gray-400 mt-1">
          Start one with <code className="px-1.5 py-0.5 bg-gray-100 rounded text-xs">aura symphony start</code>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="bg-white border border-gray-200 rounded-lg p-5">
        <div className="grid grid-cols-4 gap-4">
          <StatBox label="Tracker" value={`${daemon.tracker}/${daemon.project_slug}`} />
          <StatBox label="Workers" value={`${daemon.workers.length}/${daemon.max_concurrent}`} />
          <StatBox label="Completed" value={String(daemon.completed_count)} color="green" />
          <StatBox label="Failed" value={String(daemon.failed_count)} color={daemon.failed_count > 0 ? 'red' : undefined} />
        </div>
      </div>

      {/* Tokens */}
      {(daemon.total_tokens > 0 || daemon.total_cost > 0) && (
        <div className="bg-white border border-gray-200 rounded-lg px-5 py-3 flex items-center gap-6">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Coins size={14} className="text-amber-500" />
            <span className="font-medium text-gray-700">Tokens</span>
          </div>
          <span className="text-sm font-mono text-gray-700">{formatTokens(daemon.total_tokens)}</span>
          <div className="w-px h-4 bg-gray-200" />
          <span className="text-sm font-mono text-gray-700">${daemon.total_cost.toFixed(4)}</span>
        </div>
      )}

      {/* Workers */}
      {daemon.workers.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
            <Cpu size={14} className="text-blue-500" />
            <span className="text-sm font-semibold text-gray-900">Running Workers</span>
            <span className="text-xs text-gray-400">({daemon.workers.length})</span>
          </div>
          <div className="divide-y divide-gray-100">
            {daemon.workers.map(w => <WorkerRow key={w.issue_id} worker={w} />)}
          </div>
        </div>
      )}

      {/* Recent */}
      {daemon.recent.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
            <Clock size={14} className="text-gray-400" />
            <span className="text-sm font-semibold text-gray-900">Recent</span>
          </div>
          <div className="divide-y divide-gray-100">
            {[...daemon.recent].reverse().map((c, i) => (
              <CompletedRow key={`${c.issue_id}-${i}`} completed={c} />
            ))}
          </div>
        </div>
      )}

      {daemon.running && daemon.workers.length === 0 && daemon.recent.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <Loader2 size={24} className="text-cyan-400 mx-auto mb-2 animate-spin" />
          <p className="text-sm text-gray-500">Daemon is polling for issues...</p>
          <p className="text-xs text-gray-400 mt-1">Checking every {daemon.poll_interval_ms / 1000}s</p>
        </div>
      )}
    </div>
  );
}

// ─── Shared Components ──────────────────────────────────────────────────────

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
        active
          ? 'border-cyan-500 text-cyan-700'
          : 'border-transparent text-gray-400 hover:text-gray-600'
      }`}>
      {icon} {label}
    </button>
  );
}

function StatusPill({ running, stale }: { running: boolean; stale: boolean }) {
  if (!running) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">Stopped</span>;
  if (stale) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-50 text-yellow-700 border border-yellow-200"><AlertTriangle size={10} /> Stale</span>;
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200"><span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /> Running</span>;
}

function StatBox({ label, value, color }: { label: string; value: string; color?: string }) {
  const colorClass = color === 'green' ? 'text-green-600' : color === 'red' ? 'text-red-600' : 'text-gray-900';
  return (
    <div>
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className={`text-sm font-semibold ${colorClass} truncate`}>{value}</div>
    </div>
  );
}

function WorkerRow({ worker }: { worker: SymphonyWorker }) {
  return (
    <div className="px-5 py-3 flex items-center justify-between">
      <div className="flex items-center gap-3 min-w-0">
        <Loader2 size={14} className="text-blue-500 animate-spin shrink-0" />
        <span className="text-sm font-semibold text-blue-600 shrink-0">{worker.identifier}</span>
        <span className="text-sm text-gray-600 truncate">{worker.title}</span>
      </div>
      <span className="text-xs text-gray-400 font-mono shrink-0">{formatDuration(worker.elapsed_secs)}</span>
    </div>
  );
}

function CompletedRow({ completed }: { completed: SymphonyCompleted }) {
  return (
    <div className="px-5 py-3 flex items-center justify-between">
      <div className="flex items-center gap-3 min-w-0">
        {completed.success
          ? <CheckCircle2 size={14} className="text-green-500 shrink-0" />
          : <XCircle size={14} className="text-red-500 shrink-0" />}
        <span className={`text-sm font-semibold shrink-0 ${completed.success ? 'text-green-700' : 'text-red-600'}`}>
          {completed.identifier}
        </span>
        {completed.pr_url && (
          <a href={completed.pr_url} target="_blank" rel="noopener noreferrer"
            className="text-xs text-blue-500 hover:underline flex items-center gap-1 shrink-0">
            PR <ExternalLink size={10} />
          </a>
        )}
        {completed.error && <span className="text-xs text-red-400 truncate">{completed.error}</span>}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {completed.cost != null && <span className="text-xs text-gray-400 font-mono">${completed.cost.toFixed(4)}</span>}
        <span className="text-xs text-gray-400 font-mono">{formatDuration(completed.duration_secs)}</span>
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function formatTimestamp(ts: number): string {
  if (!ts) return 'never';
  const d = new Date(ts * 1000);
  const now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return d.toLocaleTimeString();
}
