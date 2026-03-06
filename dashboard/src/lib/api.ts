// In dev mode, Vite proxies /api to localhost:8090.
// In production (served by aura dashboard), relative URLs work directly.
const BASE_URL = '/api/v2';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  // Status
  getStatus: () => request<StatusResponse>('/status'),

  // Checkpoints
  getCheckpoints: (page = 1, limit = 20) =>
    request<CheckpointsResponse>(`/checkpoints?page=${page}&limit=${limit}`),
  getCheckpoint: (id: string) =>
    request<CheckpointDetailResponse>(`/checkpoints/${id}`),

  // Reviews
  getReviews: () => request<ReviewsResponse>('/reviews'),
  getReview: (id: string) => request<ReviewDetailResponse>(`/reviews/${id}`),
  runReview: (base: string) =>
    request<ReviewRunResponse>('/reviews/run', {
      method: 'POST',
      body: JSON.stringify({ base }),
    }),
  getReviewFiles: (id: string) =>
    request<ReviewFilesResponse>(`/reviews/${id}/files`),

  // Plans
  getPlans: () => request<PlansResponse>('/plans'),
  getActivePlan: () => request<ActivePlanResponse>('/plans/active'),
  planDiscover: (objective: string, codebase_context?: string) =>
    request<PlanDiscoverResponse>('/plans/discover', {
      method: 'POST',
      body: JSON.stringify({ objective, codebase_context }),
    }),
  planLock: (objective: string, decisions: string, codebase_context?: string) =>
    request<PlanLockResponse>('/plans/lock', {
      method: 'POST',
      body: JSON.stringify({ objective, decisions, codebase_context }),
    }),

  // Metrics
  getMetrics: () => request<MetricsResponse>('/metrics'),

  // Config
  getConfig: () => request<ConfigGetResponse>('/config'),
  setConfig: (updates: Partial<ConfigUpdate>) =>
    request<{ status: string; message: string }>('/config', {
      method: 'POST',
      body: JSON.stringify(updates),
    }),

  // Rewind
  rewind: (identifier: string, file: string) =>
    request<RewindResponse>('/rewind', {
      method: 'POST',
      body: JSON.stringify({ identifier, file }),
    }),

  // Orchestration
  getOrchestrateSessions: () =>
    request<OrchestrateSessionsResponse>('/orchestrate/sessions'),
  getOrchestrateActive: () =>
    request<OrchestrateActiveResponse>('/orchestrate/active'),
  startOrchestrate: (objective: string, strategy = 'smart') =>
    request<OrchestrateActionResponse>('/orchestrate/start', {
      method: 'POST',
      body: JSON.stringify({ objective, strategy }),
    }),
  pauseOrchestrate: () =>
    request<OrchestrateActionResponse>('/orchestrate/pause', { method: 'POST' }),
  resumeOrchestrate: () =>
    request<OrchestrateActionResponse>('/orchestrate/resume', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  cancelOrchestrate: () =>
    request<OrchestrateActionResponse>('/orchestrate/cancel', { method: 'POST' }),

  // Symphony
  getSymphonyStatus: () => request<SymphonyStatusResponse>('/symphony/status'),
  getSymphonyMeta: () => request<SymphonyMetaResponse>('/symphony/meta'),
  getSymphonyFullMeta: () => request<SymphonyMetaResponse>('/symphony/meta/full'),
  getSymphonyIssues: (limit = 50) =>
    request<SymphonyIssuesResponse>(`/symphony/issues?limit=${limit}`),
  createSymphonyIssue: (params: SymphonyCreateIssueRequest) =>
    request<SymphonyCreateIssueResponse>('/symphony/issues/create', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  updateSymphonyIssue: (params: SymphonyUpdateIssueRequest) =>
    request<SymphonyUpdateIssueResponse>('/symphony/issues/update', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  decomposePrd: (params: SymphonyDecomposeRequest) =>
    request<SymphonyDecomposeResponse>('/symphony/decompose', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  // Pull Requests
  getPrs: () => request<PrsResponse>('/prs'),
  reviewPr: (number: number) =>
    request<PrReviewResponse>('/prs/review', {
      method: 'POST',
      body: JSON.stringify({ number }),
    }),

  // Projects
  getProjects: () => request<ProjectsResponse>('/projects'),
  switchProject: (path: string) =>
    request<ProjectSwitchResponse>('/projects/switch', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  registerProject: (path: string) =>
    request<ProjectRegisterResponse>('/projects/register', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
};

// Type imports from types.ts (re-exported for convenience)
import type {
  StatusResponse,
  CheckpointsResponse,
  CheckpointDetailResponse,
  ReviewsResponse,
  ReviewDetailResponse,
  ReviewRunResponse,
  ReviewFilesResponse,
  PlansResponse,
  ActivePlanResponse,
  PlanDiscoverResponse,
  PlanLockResponse,
  MetricsResponse,
  ConfigGetResponse,
  ConfigUpdate,
  RewindResponse,
  OrchestrateSessionsResponse,
  OrchestrateActiveResponse,
  OrchestrateActionResponse,
  SymphonyStatusResponse,
  SymphonyMetaResponse,
  SymphonyIssuesResponse,
  SymphonyCreateIssueRequest,
  SymphonyCreateIssueResponse,
  SymphonyUpdateIssueRequest,
  SymphonyUpdateIssueResponse,
  SymphonyDecomposeRequest,
  SymphonyDecomposeResponse,
  PrsResponse,
  PrReviewResponse,
  ProjectsResponse,
  ProjectSwitchResponse,
  ProjectRegisterResponse,
} from './types';
