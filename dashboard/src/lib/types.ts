// ─── Core Models ─────────────────────────────────────────────────────────────

export interface AstNode {
  node_id: string;
  kind: string;
  identifier: string | null;
  content_hash: string;
  children: AstNode[];
  dependencies: { name: string; uri: string }[];
  contains_secret: boolean;
  is_stub: boolean;
}

export interface Checkpoint {
  id: string;
  agent_id: string;
  intent: string;
  timestamp: number;
  node_count: number;
  node_kinds?: string[];
  ast_nodes?: AstNode[];
}

export interface AiFinding {
  node: string;
  file: string;
  severity: 'HIGH' | 'MED' | 'LOW';
  issue: string;
  category: string;
}

export interface AiFix {
  node: string;
  file: string;
  issue: string;
  suggested_fix: string;
}

export interface ReviewReport {
  base_branch: string;
  total_changes: number;
  unverified_nodes: Record<string, number>;
  invariant_violations: string[];
  blast_radius: string[];
  cross_branch_conflicts: string[];
  ai_bugs: AiFinding[];
  ai_security: AiFinding[];
  ai_fixes: AiFix[];
  risk_score: number;
  risk_label: string;
  timestamp?: number;
  omni_graph_impact?: Record<string, unknown>;
}

export interface PlanWave {
  id: number;
  action: string;
  files: string[];
  functions: string[];
  verify: string;
}

export interface AuraConfig {
  ai_provider: string | null;
  provider_architect: string | null;
  provider_researcher: string | null;
  provider_auditor: string | null;
  provider_arbitrator: string | null;
  model_architect: string | null;
  model_researcher: string | null;
  model_auditor: string | null;
  model_arbitrator: string | null;
  strict_gatekeeper_mode: boolean;
  use_local_embeddings: boolean;
  dev_mode: boolean;
  telemetry_enabled: boolean;
  has_gemini_key: boolean;
  has_anthropic_key: boolean;
  has_openai_key: boolean;
  has_mercury_key: boolean;
}

// ─── Review Files (Diff View) ────────────────────────────────────────────────

export interface DiffLine {
  type: 'add' | 'del' | 'context';
  old_lineno: number | null;
  new_lineno: number | null;
  content: string;
}

export interface DiffHunk {
  lines: DiffLine[];
}

export interface FileFindings {
  bugs: AiFinding[];
  security: AiFinding[];
  fixes: AiFix[];
}

export interface ReviewFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  language: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  findings: FileFindings;
}

export interface ReviewFilesData {
  files: ReviewFile[];
  total: number;
  review_id: string;
  base_branch: string;
}

export interface ReviewFilesResponse {
  status: string;
  data?: ReviewFilesData;
  error?: string;
}

// ─── API Responses ───────────────────────────────────────────────────────────

export interface StatusResponse {
  status: string;
  data: {
    branch: string;
    repo_name: string;
    last_commit: { id: string; message: string };
    total_checkpoints: number;
    last_checkpoint: Checkpoint | null;
    has_cached_review: boolean;
    review_count: number;
    default_base: string;
    branches: string[];
  };
}

export interface CheckpointsResponse {
  checkpoints: Checkpoint[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

export interface CheckpointDetailResponse {
  status: string;
  checkpoint?: Checkpoint & { ast_nodes: AstNode[] };
}

export interface ReviewsResponse {
  reviews: ReviewReport[];
  total: number;
}

export interface ReviewDetailResponse {
  status: string;
  review?: ReviewReport;
  error?: string;
}

export interface ReviewRunResponse {
  status: string;
  review?: ReviewReport;
  message?: string;
  error?: string;
}

export interface PlansResponse {
  plans: { name: string; type: string; data?: unknown; content?: string }[];
  total: number;
}

export interface ActivePlanResponse {
  status: string;
  active_plan: {
    name: string;
    plan: { waves: PlanWave[] };
    progress: string;
  } | null;
}

export interface PlanDiscoverResponse {
  status: string;
  discovery?: {
    gray_areas: {
      question: string;
      option_a: string;
      option_b: string;
    }[];
    research_summary: string;
  };
  error?: string;
}

export interface PlanLockResponse {
  status: string;
  plan?: { waves: PlanWave[] };
  error?: string;
}

export interface MetricsResponse {
  total_checkpoints: number;
  top_churned_nodes: [string, number][];
  node_kind_distribution: Record<string, number>;
  review_history: {
    timestamp: number;
    risk_score: number;
    risk_label: string;
    total_changes: number;
    bug_count: number;
    security_count: number;
    violation_count: number;
  }[];
  total_reviews: number;
}

export interface ConfigGetResponse {
  status: string;
  config: AuraConfig;
}

export interface ConfigUpdate {
  ai_provider?: string;
  provider_architect?: string;
  provider_researcher?: string;
  provider_auditor?: string;
  provider_arbitrator?: string;
  model_architect?: string;
  model_researcher?: string;
  model_auditor?: string;
  model_arbitrator?: string;
  gemini_api_key?: string;
  anthropic_api_key?: string;
  openai_api_key?: string;
  mercury_api_key?: string;
  strict_gatekeeper_mode?: boolean;
  use_local_embeddings?: boolean;
  dev_mode?: boolean;
  telemetry_enabled?: boolean;
}

export interface RewindResponse {
  status: string;
  identifier?: string;
  file?: string;
  old_source?: string;
  restored_source?: string;
  error?: string;
}

// ─── Orchestration ──────────────────────────────────────────────────────────

export type AgentType = 'claude_code' | 'gemini_cli';
export type WaveStatus = 'pending' | 'running' | 'validating' | 'passed' | 'failed' | 'retrying';
export type OrchestrationStatus = 'planning' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  saved_by_handover: number;
  saved_by_resume: number;
}

export interface SessionTokenStats {
  total_input: number;
  total_output: number;
  total_tokens: number;
  total_cost_usd: number;
  gemini_tokens: number;
  gemini_cost_usd: number;
  claude_tokens: number;
  claude_cost_usd: number;
  tokens_saved_handover: number;
  tokens_saved_resume: number;
  estimated_without_aura: number;
  estimated_cost_without_aura: number;
  savings_pct: number;
}

export interface OrchestrateWave {
  id: number;
  action: string;
  files: string[];
  functions: string[];
  verify: string;
  assigned_agent: AgentType;
  status: WaveStatus;
  logs: string;
  review_summary: string | null;
  risk_score: number | null;
  started_at: number | null;
  completed_at: number | null;
  retry_count: number;
  git_ref_before: string | null;
  usage?: TokenUsage;
}

export interface OrchestrationSession {
  id: string;
  objective: string;
  strategy: { smart?: null; round_robin?: null; manual?: AgentType[] };
  status: OrchestrationStatus;
  waves: OrchestrateWave[];
  current_wave: number;
  created_at: number;
  updated_at: number;
  agents_available: AgentType[];
  mode?: OrchestrateMode;
  tasks?: DuoTask[];
  rounds?: DuoRound[];
  relay_log?: RelayMessage[];
  token_stats?: SessionTokenStats;
}

export type OrchestrateMode = 'wave' | 'duo';
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';
export type RelayType = 'output' | 'question' | 'answer';

export interface DuoTask {
  id: number;
  action: string;
  agent: AgentType;
  depends_on: number[];
  status: TaskStatus;
  output: string;
  relay_summary: string | null;
  started_at: number | null;
  completed_at: number | null;
  retry_count: number;
  usage?: TokenUsage;
}

export interface DuoRound {
  id: number;
  task_ids: number[];
  relay_context: string;
}

export interface RelayMessage {
  from: AgentType;
  to: AgentType;
  content: string;
  round_id: number;
  msg_type: RelayType;
}

export interface OrchestrateSessionsResponse {
  status: string;
  sessions: OrchestrationSession[];
  total: number;
}

export interface OrchestrateActiveResponse {
  status: string;
  session: OrchestrationSession | null;
}

export interface OrchestrateActionResponse {
  status: string;
  session?: OrchestrationSession;
  error?: string;
}

// ─── Symphony ────────────────────────────────────────────────────────────────

export interface SymphonyWorker {
  issue_id: string;
  identifier: string;
  title: string;
  started_at: number;
  elapsed_secs: number;
}

export interface SymphonyCompleted {
  issue_id: string;
  identifier: string;
  success: boolean;
  pr_url: string | null;
  error: string | null;
  duration_secs: number;
  tokens: number | null;
  cost: number | null;
}

export interface SymphonyDaemonState {
  running: boolean;
  tracker: string;
  project_slug: string;
  poll_interval_ms: number;
  max_concurrent: number;
  workers: SymphonyWorker[];
  recent: SymphonyCompleted[];
  completed_count: number;
  failed_count: number;
  total_tokens: number;
  total_cost: number;
  updated_at: number;
}

export interface SymphonyStatusResponse {
  status: string;
  daemon: SymphonyDaemonState | null;
}

export interface SymphonyTeamMeta {
  team_id: string;
  labels: { id: string; name: string }[];
  members: { id: string; name: string }[];
  states?: { id: string; name: string }[];
  projects?: { id: string; name: string }[];
  cycles?: { id: string; name: string | null; number: number; starts_at: string | null; ends_at: string | null }[];
}

export interface SymphonyMetaResponse {
  status: string;
  meta?: SymphonyTeamMeta;
  error?: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state: string;
  branch_name?: string;
  url: string;
  priority?: number;
  labels: string[];
  assignee?: string;
  project?: string;
  cycle?: string;
  due_date?: string;
  parent_id?: string;
  sub_issue_count?: number;
}

export interface SymphonyIssuesResponse {
  status: string;
  issues?: LinearIssue[];
  total?: number;
  error?: string;
}

export interface SymphonyCreateIssueRequest {
  title: string;
  description?: string;
  priority?: number;
  labels?: string[];
  assignee?: string;
  estimate?: number;
  project?: string;
  cycle?: string;
  due_date?: string;
  parent_id?: string;
}

export interface SymphonyCreateIssueResponse {
  status: string;
  issue?: LinearIssue;
  error?: string;
}

export interface SymphonyUpdateIssueRequest {
  id: string;
  title?: string;
  description?: string;
  priority?: number;
  state?: string;
  labels?: string[];
  assignee?: string;
  project?: string;
  cycle?: string;
  due_date?: string;
  parent_id?: string;
  estimate?: number;
}

export interface SymphonyUpdateIssueResponse {
  status: string;
  issue?: LinearIssue;
  error?: string;
}

export interface DecomposedTask {
  title: string;
  description: string;
  priority: number;
  labels: string[];
  estimate: number | null;
  wave: number;
  depends_on: string[];
}

export interface DecompositionWave {
  wave_number: number;
  tasks: DecomposedTask[];
}

export interface DecompositionResult {
  project_name: string;
  summary: string;
  waves: DecompositionWave[];
  created_issues: LinearIssue[];
  total_tasks: number;
}

export interface SymphonyDecomposeRequest {
  prd_content: string;
  project?: string;
  assignees?: string[];
  labels?: string[];
  dry_run?: boolean;
}

export interface SymphonyDecomposeResponse {
  status: string;
  result?: DecompositionResult;
  error?: string;
}

// ─── Pull Requests ──────────────────────────────────────────────────────────

export interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  author: { login: string; name?: string };
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt?: string;
  url?: string;
  labels?: { name: string }[];
}

export interface PrsResponse {
  status: string;
  prs?: PullRequest[];
  total?: number;
  error?: string;
}

export interface PrReviewResponse {
  status: string;
  pr?: PullRequest;
  review?: ReviewReport;
  review_raw?: string;
  message?: string;
  error?: string;
}

// ─── Multi-Project ──────────────────────────────────────────────────────────

export interface ProjectEntry {
  path: string;
  name: string;
}

export interface ProjectsResponse {
  status: string;
  projects: ProjectEntry[];
  active: string;
}

export interface ProjectSwitchResponse {
  status: string;
  active?: string;
  name?: string;
  error?: string;
}

export interface ProjectRegisterResponse {
  status: string;
  message?: string;
  projects?: ProjectEntry[];
  error?: string;
}
