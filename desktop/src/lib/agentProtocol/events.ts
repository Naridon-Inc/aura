//! Engine-agnostic chat event model — the normalized vocabulary every
//! coding-agent CLI maps INTO so the chat renderer never sees engine bytes.
//!
//! Design of record (see the team Page "Engine-agnostic chat — the agent
//! abstraction"): a turn is a flat, append-only list of `NormalizedEvent`,
//! each with a stable `id`. Producers re-emit the SAME id to update an event
//! in place (a tool call growing from `pending` → `running` → `completed`,
//! assistant text accreting deltas). This "whole-object, keyed by stable id,
//! re-sent as it grows" shape is OpenCode's model; the enums below lean on
//! ACP's taxonomy (`ToolKind`, `ToolCallStatus`, permission options) because
//! it's the cleanest cross-vendor superset.
//!
//! Each engine (Claude Code, Codex, Gemini, Cursor, Kimi, OpenCode, …) ships
//! ONE adapter under `adapters/` implementing `normalize(raw) →
//! NormalizedEvent[]`. Adding an agent is an adapter + a manifest entry — the
//! renderer, the question/plan/permission round-trip, and the reducer never
//! change. That is the whole point: add agents without designing for each.

/** Where an event came from. `environment` = tool output / system, `hook` =
 *  an Aura-injected side effect (snapshot taken, intent watchdog). */
export type EventSource = "user" | "agent" | "environment" | "hook";

/** Common envelope on every normalized event. `id` is stable across updates:
 *  a producer re-emits the same id to replace the prior value in place. */
export type EventEnvelope = {
  /** Stable id. Re-emit the same id to update this event in place. */
  id: string;
  /** Channel/session this belongs to (agent stream channel or session id). */
  sessionId: string;
  /** Parent event id for sub-agent / sub-task nesting (ACP `parentId`,
   *  Claude `parent_tool_use_id`). Absent at top level. */
  parentId?: string;
  /** Unix milliseconds. */
  ts: number;
  /** Still streaming — the consumer should expect further same-id updates. */
  partial?: boolean;
  source: EventSource;
};

// ── Tool-call state machine ──────────────────────────────────────────────
//
// ONE object per tool invocation, keyed by `callId`, updated in place as it
// runs. Input is present even while `pending` (engines stream the arguments);
// output/content replaces on update. The renderer never pairs result-to-
// request by sniffing content — the `callId` does it.

/** ACP's 10 tool kinds collapsed to what we render distinctly. Drives the
 *  card's leading glyph. `other` is the safe default for unknown tools. */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "todo"
  | "plan"
  | "other";

/** ACP's 4 statuses + a distinct `cancelled` (Gemini emits 7, Codex 3 — all
 *  collapse to these 5). */
export type ToolCallStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "cancelled";

/** One piece of a tool call's output. Discriminated so the card can render a
 *  diff, a terminal well, or plain content without guessing. */
export type ToolContent =
  | { type: "content"; text: string }
  | {
      /** Unified-diff body. `oldText` null/absent = new file (all additions). */
      type: "diff";
      path: string;
      oldText?: string;
      newText: string;
    }
  | { type: "terminal"; terminalId: string };

/** A file location a tool touched — lets the editor "follow" the agent. */
export type ToolLocation = { path: string; line?: number };

// ── The event union ──────────────────────────────────────────────────────

/** First event of a session — the configuration handshake. */
export type SessionInitEvent = EventEnvelope & {
  kind: "session_init";
  model: string | null;
  cwd?: string;
  tools: string[];
  permissionMode?: string;
  provider?: string;
  slashCommands?: string[];
  mcpServers?: string[];
};

/** Assistant or user prose. `delta` carries the incremental chunk; the
 *  consumer accumulates onto the same `id`. */
export type TextEvent = EventEnvelope & {
  kind: "text";
  role: "user" | "assistant";
  text: string;
  delta?: string;
};

/** Extended-thinking stream. Rendered as a collapsed-by-default whisper. */
export type ReasoningEvent = EventEnvelope & {
  kind: "reasoning";
  text: string;
  delta?: string;
  signature?: string;
  durationMs?: number;
};

/** A tool invocation as a state-machine object. Re-emitted same-id as it
 *  runs; the reducer folds updates by `callId`. */
export type ToolCallEvent = EventEnvelope & {
  kind: "tool_call";
  /** Correlates updates AND links to a `permission_request`. */
  callId: string;
  toolKind: ToolKind;
  status: ToolCallStatus;
  /** Raw engine tool name (`Bash`, `str_replace`, `shell`, `read_file`). */
  toolName: string;
  /** Humanized headline ("Editing src/foo.ts"). */
  title: string;
  /** Present even while pending (engines stream the args). */
  input: Record<string, unknown>;
  /** Output — replaces (not appends) on update. */
  content?: ToolContent[];
  output?: string;
  isError?: boolean;
  locations?: ToolLocation[];
  durationMs?: number;
};

/** How long an "always/once/session" decision sticks. */
export type PermissionScope = "once" | "session" | "always";

export type PermissionOption = {
  optionId: string;
  label: string;
  scope: PermissionScope;
  decision: "allow" | "reject";
};

/** The agent is blocked waiting for the human to allow/deny a tool call. */
export type PermissionRequestEvent = EventEnvelope & {
  kind: "permission_request";
  requestId: string;
  /** Which `tool_call` is blocked (its callId), when applicable. */
  callId?: string;
  toolName: string;
  input: Record<string, unknown>;
  title: string;
  riskLevel?: "low" | "medium" | "high";
  options: PermissionOption[];
  /** The user may edit `input` and approve the modified version. */
  allowsEditedInput?: boolean;
};

/** One question inside a `question_set`. */
export type NormalizedQuestion = {
  id: string;
  /** Markdown prompt. */
  prompt: string;
  multiSelect?: boolean;
  options?: { optionId: string; label: string; description?: string; mode?: string }[];
  freeText?: boolean;
};

/** A SET of questions thrown at the user at once (Claude `AskUserQuestion`,
 *  MCP elicitation). A single question degrades to a one-entry set. */
export type QuestionSetEvent = EventEnvelope & {
  kind: "question_set";
  requestId: string;
  questions: NormalizedQuestion[];
};

/** One line of a proposed/streaming plan. 3 statuses only (no `failed`) —
 *  kept distinct from `ToolCallStatus` on purpose. */
export type PlanEntry = {
  content: string;
  priority?: "high" | "medium" | "low";
  status?: "pending" | "in_progress" | "completed";
};

/** A proposed plan. Always a FULL-LIST replacement on update (never append).
 *  When `awaitingApproval` the renderer offers Build / Revise. */
export type PlanEvent = EventEnvelope & {
  kind: "plan";
  entries: PlanEntry[];
  markdown?: string;
  awaitingApproval?: boolean;
  /** When awaiting approval, reply through this permission request id. */
  requestId?: string;
};

/** One todo / task-tracking item. */
export type TodoItem = {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  priority?: string;
};

/** The live checklist. FULL-ARRAY replacement per update. */
export type TodoEvent = EventEnvelope & {
  kind: "todo";
  todos: TodoItem[];
};

export type TokenUsageDetail = {
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** Terminal turn event — the run finished (or failed). */
export type ResultEvent = EventEnvelope & {
  kind: "result";
  subtype: "success" | "error" | "cancelled";
  text?: string;
  errors?: string[];
  usage?: TokenUsageDetail;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  stopReason?: string;
};

export type ErrorEvent = EventEnvelope & {
  kind: "error";
  message: string;
  errorId?: string;
};

/** Per-assistant-message token accounting (Claude `message.usage`). One per
 *  model call; the renderer folds the calls of a single response into a faint
 *  footer (max context fed · summed tokens generated). `id` is the model's
 *  `message.id` so a re-emit merges rather than double-counts. */
export type UsageEvent = EventEnvelope & {
  kind: "usage";
  /** Everything fed INTO this call — fresh input + both cache planes. */
  contextTokens: number;
  /** What the model generated on this call. */
  outputTokens: number;
};

/** An inline image — a screenshot the user attached, or one the agent
 *  produced / read back (PNG/JPEG). `data` is base64 (no data-URI prefix);
 *  `mediaType` is the MIME label. Rendered as a thumbnail in the transcript,
 *  click to open full-size. */
export type ImageEvent = EventEnvelope & {
  kind: "image";
  role: "user" | "assistant";
  mediaType: string;
  data: string;
};

/** Session lifecycle / retry breadcrumbs (busy, retrying, idle). */
export type StatusEvent = EventEnvelope & {
  kind: "status";
  state: "idle" | "busy" | "retry";
  attempt?: number;
  message?: string;
};

export type NormalizedEvent =
  | SessionInitEvent
  | TextEvent
  | ReasoningEvent
  | ToolCallEvent
  | PermissionRequestEvent
  | QuestionSetEvent
  | PlanEvent
  | TodoEvent
  | ResultEvent
  | ErrorEvent
  | UsageEvent
  | ImageEvent
  | StatusEvent;

/** Discriminator literals — handy for exhaustive switches in renderers. */
export type NormalizedEventKind = NormalizedEvent["kind"];

// ── Reply events (UI → agent) ────────────────────────────────────────────
//
// The round-trip the renderer emits back when the human answers. The transport
// (PTY stdin line, stream control-response, ACP RPC) is the adapter's job; the
// renderer only produces these intent objects.

export type PermissionReply = {
  kind: "permission_reply";
  requestId: string;
  optionId?: string;
  allow: boolean;
  /** Modified tool input when the user edited-then-approved. */
  updatedInput?: Record<string, unknown>;
  /** Persist the decision as a rule for this scope. */
  rememberScope?: PermissionScope;
  cancelled?: boolean;
};

export type QuestionReply = {
  kind: "question_reply";
  requestId: string;
  answers: { questionId: string; optionIds?: string[]; text?: string }[];
};

export type PlanReply = {
  kind: "plan_reply";
  requestId: string;
  /** true = Build, false = Revise (carry `message`). */
  approved: boolean;
  message?: string;
};

export type AgentReply = PermissionReply | QuestionReply | PlanReply;
