// Chat surface for a Manager session. Talks to the Rust-side brain
// (Anthropic Messages API streaming + tool calling). Each user message
// fires `manager_chat`, which spawns `brain::run_turn` server-side; the
// brain emits `manager-stream:<sid>` deltas (text chunks, tool_use blocks,
// tool_result completions, done/error) that we render incrementally:
//
//   - text_delta → append to a streaming assistant bubble
//   - tool_use → inline collapsible card under the bubble
//   - tool_result → fills the card with output + ✓/✗ chip
//   - done → flush bubble into persistent chat (server already persisted it)
//
// Persisted ChatTurns from `session.chat` cover history; in-flight stream
// state lives in component state until the brain's persistence flush
// rolls it into `session.chat` on the next snapshot.

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  GitBranch,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import {
  api,
  type ActiveBrainInfo,
  type BrainChatChunk,
  type BrainChoice,
  type ChatTurn,
  type ChatImageAttachment,
  type ManagerSession,
  type ManagerStreamDelta,
  type PendingPlan,
  type PersistedToolCall,
  type PlanParallelism,
  type ReasoningEffort,
  type ApprovalPolicy,
  type RibbonEntry,
} from "../../lib/api";
import { trackFeature } from "../../lib/track";
import {
  markManagerTurnInFlight,
  clearManagerTurnInFlight,
  isManagerTurnInFlight,
  getManagerTurnStartedAt,
  setManagerTurnStartedAt,
  clearManagerTurnStartedAt,
} from "../../lib/managerStore";
import { ManagerComposer, type ComposerAttachment } from "./ManagerComposer";
import { type SelectedModel } from "../../lib/modelCatalog";
import { ManagerQueueStack, type QueuedMessage } from "./ManagerQueueStack";
import { CrewComposerBlock } from "./chat/CrewComposerBlock";
import { ScoutCard } from "./ScoutCard";
import { WaveDispatchPanel } from "./WaveDispatchPanel";
import { useEditorStore, getActiveWorkspaceRoot, openManagerSession } from "../../lib/editorStore";
import { openPlanWizard } from "../../lib/planWizardStore";
import { stripSteeringDirective } from "../../lib/steeringDirective";
import { openPopout } from "../../lib/popout";
import { pendingPlanToMarkdown, planPageId } from "../../lib/planMarkdown";
import { handleChatSlash, type SlashInteractive, type SlashResumeRow } from "../../lib/chatSlashHandler";
import { buildSteeringText } from "../../lib/managerSteering";
import { playCompletionChime } from "../../lib/completionChime";
import { notify } from "../../lib/notifications";

// W7 ambient — native-brain turn-end. Fires the same completion chime as
// the CLI-agent seam (agentStreamStore `result`) so a turn sounds the same
// whichever brain ran it, plus an OS notification when the window is away.
function announceTurnEnd(sid: string) {
  playCompletionChime();
  notify({
    title: "Aura finished",
    body: "The turn is done.",
    dedupeKey: `turn-end:manager:${sid}`,
  }).catch(() => {});
}
import { getAgentIdentity, accentTint } from "../../lib/agentIdentity";
import { useFlagPrefs } from "../../lib/settingsStore";
import { AgentIcon } from "../agent/AgentIcon";
// Chat-render layer — de-monolithed out of this file into focused modules.
// The registry that *produces* a ToolView (toolDescribe) and the cards that
// *consume* it (ToolCard) evolve independently against chat/types.
import { ChatRepoRootContext } from "./chat/context";
import { MarkdownBody } from "./chat/Markdown";
import { StreamingBubble } from "./chat/ToolCard";
import { TurnActivity } from "./chat/TurnActivity";
import { TurnChanges } from "./chat/TurnChanges";
import { extractTurnChanges } from "./chat/turnChangeSummary";
import { SessionBrainsDetail } from "./chat/SessionBrainsDetail";
import {
  InteractiveBlocks,
  partitionInteractive,
} from "./chat/InteractiveBlocks";
import { describeTool, isAskUserTool, isAuraUxBash } from "./chat/toolDescribe";
// Reuse the Trace transcript's contextual-summary knowledge: the harness's
// "This session is being continued…" compaction block (and `aura handover`
// payloads) are detected here so the chat renders them as a contextual card,
// never as a giant user bubble.
import { isHandoverSummary, summaryGist } from "../workpanes/transcript/model";
import { ChatEmptyState } from "./chat/ChatEmptyState";
import {
  ThinkingLine,
  PlanningStatusLine,
  humanizeBrainId,
  brainAgentId,
} from "./chat/StatusLine";
import { QuestionCard, formatRelativeApprovalTime } from "./chat/QuestionCard";
import { QuestionInputOverlay } from "./chat/QuestionInputOverlay";
import { MessageScrollbackRail, type RailAnchor } from "./chat/MessageScrollbackRail";

type LocalSlashEntry = {
  at: number;
  text: string;
  tone: "info" | "warn" | "ok";
  /** The raw slash the user typed (e.g. `/status`). When set, the timeline
   *  echoes it as the user's own bubble just above the response card — a
   *  handled command never becomes a real chat turn, so without this the
   *  sent message would silently vanish ("where is the message I sent?"). */
  cmd?: string;
  /** True when `text` is a multi-part markdown document (a `/help` listing, a
   *  `/loop` table, a `/agents` roster) that must render through the full
   *  MarkdownBody — lists, bold, code — instead of collapsing into a single
   *  italic breadcrumb line. Set for every handled slash output; left off the
   *  short auto-breadcrumbs (e.g. a PTY-pipe failure note). */
  rich?: boolean;
  /** Set for an *action* slash command (`/resume`): a live, clickable control
   *  (e.g. resumable-conversation rows) rendered in place of the markdown body.
   *  Ephemeral by design — never persisted to history. */
  interactive?: SlashInteractive;
  /** A designed system notice (not a slash result). `plan-mode` renders the
   *  compact "Switched to Plan mode" card instead of a flat italic markdown
   *  run — its own glyph, headline and wrapped body. `text` stays as the a11y
   *  fallback + de-dupe key. Ephemeral. */
  notice?: "plan-mode";
};

// Mode-steering prefix the composer prepends to outgoing user messages
// (e.g. "[PLAN MODE — Discuss and propose a plan FIRST. …]\n\n"). The
// brain needs it; the user shouldn't see their bubble parroting it
// back. Strip it everywhere we display, copy, or edit the user turn.
// Strip the composer's internal steering/pipe directives before rendering a
// user turn. Shared with the session-title surfaces (ManagerSurface history)
// and the backend `summarize_objective` so the directive is
// model-facing only — never shown in a bubble or used as a title.
const stripModeDirective = stripSteeringDirective;

// Auto-mode is "full autopilot — build without pausing." But when a user on
// Auto explicitly asks for a PLAN ("plan a new feature", "draft a plan",
// "how should we build X"), they want the plan flow (PlanCard → Build), not a
// silent end-to-end run. We detect that intent and quietly switch the turn to
// Plan mode, telling the user we did. Tuned for low false-positives: it only
// fires on clear "produce a plan" phrasing, never on "build the plan" /
// "run the plan" (those are execution, and stay on Auto).
function looksLikePlanRequest(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;
  // Execution, not planning — leave these on Auto.
  if (/\b(execute|run|implement|do|start|ship|finish|continue)\s+(the|this|that|your|my)?\s*plan\b/.test(t)) {
    return false;
  }
  if (/^\s*build\b/.test(t)) return false;
  const planPhrases: RegExp[] = [
    // "plan a/the/out/for/this/how … feature"
    /\bplan\s+(a|an|the|out|for|this|me|how|what|our|my)\b/,
    // "make/draft/write/propose/come up with/lay out … a plan"
    /\b(make|draft|write|create|propose|prepare|put together|come up with|lay out|sketch|outline|give me|need|want)\s+(a|an|the|me)?\s*plan\b/,
    /\bcan you plan\b/,
    /\blet'?s plan\b/,
    /\bwhat'?s the plan\b/,
    /\bplan it out\b/,
    // "how would/should we build/approach/structure X"
    /\bhow\s+(would|should|do|might)\s+(you|we|i)\b[\s\S]{0,40}\b(build|approach|implement|structure|tackle|architect|design|do this|go about)\b/,
    // "design an approach/architecture/plan for …"
    /\bdesign\s+(a|an|the)\b[\s\S]{0,30}\b(approach|architecture|plan|system|flow)\b/,
  ];
  return planPhrases.some((re) => re.test(t));
}

type Props = { session: ManagerSession };

// What the brain accumulates mid-turn. Each text block is a chunk of
// streaming assistant text; each tool block is one Anthropic tool_use the
// model emitted, with its eventual tool_result tacked on once dispatch
// returns. Rendered chronologically by `block_idx` — same order the model
// emitted them.
type StreamBlock =
  | { kind: "text"; block_idx: number; text: string }
  | { kind: "reasoning"; block_idx: number; text: string }
  | {
      kind: "tool";
      block_idx: number;
      tool_use_id: string;
      name: string;
      input: unknown;
      result?: { is_error: boolean; content: string };
    };

/** Convert a settled turn's persisted tool calls into the stream-block shape
 *  `StreamingBubble` consumes, so the reload timeline renders the same tool
 *  cards the live stream did — consecutive read-only calls clubbed into one
 *  "Explored" line, consecutive world-changing calls into one living status
 *  bar. Block indices are positional.
 *
 *  A persisted call with no stored result defaults to a clean DONE result
 *  (not absent): the turn has already settled, so the tool finished — leaving
 *  the result undefined would derive status "running" and paint a perpetual
 *  bold "Running" badge on a finished turn (the backend doesn't always capture
 *  a tool's output). Empty content renders nothing, so this only fixes the
 *  verb/status, never fabricates output. */
function persistedToolBlocks(calls: PersistedToolCall[]): StreamBlock[] {
  return calls.map((c, i) => ({
    kind: "tool",
    block_idx: i,
    tool_use_id: c.tool_use_id || `tc-${i}`,
    name: c.name,
    input: c.input,
    result: c.result
      ? { is_error: c.result.is_error, content: c.result.content }
      : { is_error: false, content: "" },
  }));
}

/** The full settled-turn block stream: any hydrated extended-thinking
 *  (`turn.thinking`, populated only on imported CLI transcripts) as a leading
 *  `reasoning` disclosure, then the persisted tool cards. `StreamingBubble`
 *  renders blocks in array order, so reasoning-before-tools matches the order
 *  the agent emitted them. Returns [] when a turn has neither. */
function persistedTurnBlocks(turn: ChatTurn): StreamBlock[] {
  const blocks: StreamBlock[] = [];
  if (turn.thinking && turn.thinking.trim()) {
    blocks.push({ kind: "reasoning", block_idx: 0, text: turn.thinking });
  }
  const offset = blocks.length;
  for (const b of persistedToolBlocks(turn.tool_calls ?? [])) {
    blocks.push({ ...b, block_idx: b.block_idx + offset });
  }
  return blocks;
}

type TimelineEntry =
  | { kind: "turn"; at: number; turn: ChatTurn }
  | {
      kind: "system";
      at: number;
      text: string;
      tone: "info" | "warn" | "ok";
      /** Markdown body — render through MarkdownBody, not the inline italic
       *  one-liner. See LocalSlashEntry.rich. */
      rich?: boolean;
      /** Action-command live control (e.g. `/resume` rows) — renders an
       *  interactive block instead of `text`. See LocalSlashEntry.interactive. */
      interactive?: SlashInteractive;
      /** Designed system notice (e.g. `plan-mode`) — renders a compact card
       *  instead of the markdown body. See LocalSlashEntry.notice. */
      notice?: "plan-mode";
    };

// A wall-clock gap at least this large between two adjacent timeline entries
// draws a TimeGapDivider — the seam where a conversation was paused and later
// resumed. Below it, turns are treated as one continuous exchange. 10 min is
// long enough that a normal back-and-forth never trips it, short enough to
// catch a "stepped away and came back" resume.
const TIME_GAP_MIN_SEC = 10 * 60;

// Windowed render. A resumed CLI session can carry hundreds of turns; rendering
// every one of them as a live bubble (markdown + tool cards) builds a DOM so
// heavy that WebKit janks the instant you try to scroll back through it — the
// "scrolling up is super stuck" symptom on a big imported chat. We keep only
// the most recent slice mounted and reveal older turns in chunks on demand, so
// the DOM stays small no matter how long the history is. Nothing is lost — the
// full transcript is still in `timeline`, just not all mounted at once.
const CHAT_WINDOW_INITIAL = 60;
const CHAT_WINDOW_STEP = 80;

// "12m later" · "about 1h later" · "3h later" · "2d later". `at` is epoch
// seconds, so the gap is already in seconds. Kept deliberately coarse — this
// is a human seam marker, not a stopwatch.
function humanizeGap(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m later`;
  const h = Math.floor(seconds / 3600);
  if (h < 24) {
    const rem = Math.round((seconds - h * 3600) / 60);
    if (h === 1 && rem < 20) return "about an hour later";
    return rem >= 30 ? `about ${h + 1}h later` : `${h}h later`;
  }
  const d = Math.round(seconds / 86400);
  return d === 1 ? "a day later" : `${d}d later`;
}

// ── W2 type-ahead queue persistence ───────────────────────────────────
// The pending queue is scoped per Manager session so a reload keeps it.
const QUEUE_KEY = (sid: string) => `aura.manager.queue.${sid}`;

function loadQueue(sid: string): QueuedMessage[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY(sid));
    if (!raw) return [];
    const arr = JSON.parse(raw) as Partial<QueuedMessage>[];
    if (!Array.isArray(arr)) return [];
    // Persisted entries never carry attachments (stripped on save — base64
    // blobs are megabyte-scale and don't survive a reload). Rehydrate as
    // text-only queued turns.
    return arr
      .filter((m) => typeof m?.text === "string")
      .map((m, i) => ({
        id: typeof m.id === "string" ? m.id : `q${i}`,
        text: m.text as string,
        attachments: [],
        mode: (m.mode as QueuedMessage["mode"]) ?? "build",
        pipeTargetSessionId: m.pipeTargetSessionId ?? null,
        effort: m.effort ?? null,
        fast: !!m.fast,
        approval: (m.approval as QueuedMessage["approval"]) ?? null,
      }));
  } catch {
    return [];
  }
}

function saveQueue(sid: string, queue: QueuedMessage[]): void {
  try {
    // Strip attachments before persisting — keep only the lightweight,
    // serializable run payload.
    const lite = queue.map((m) => ({
      id: m.id,
      text: m.text,
      mode: m.mode,
      pipeTargetSessionId: m.pipeTargetSessionId,
      effort: m.effort,
      fast: m.fast,
      approval: m.approval,
    }));
    if (lite.length === 0) localStorage.removeItem(QUEUE_KEY(sid));
    else localStorage.setItem(QUEUE_KEY(sid), JSON.stringify(lite));
  } catch {
    /* storage disabled / quota exceeded */
  }
}

// ── Model-override persistence ─────────────────────────────────────────
// The composer model picker's selection is scoped per Manager session so a
// reload restores the chip (parallels the durable brain override, which is
// persisted server-side via `manager_set_brain_override`).
const MODEL_KEY = (sid: string) => `aura.manager.model.${sid}`;

function loadModel(sid: string): SelectedModel | null {
  try {
    const raw = localStorage.getItem(MODEL_KEY(sid));
    if (!raw) return null;
    const m = JSON.parse(raw) as Partial<SelectedModel> | null;
    if (!m || typeof m.brainId !== "string" || typeof m.label !== "string") {
      return null;
    }
    return {
      brainId: m.brainId,
      modelId: typeof m.modelId === "string" ? m.modelId : null,
      longContext: !!m.longContext,
      label: m.label,
      family: (m.family as SelectedModel["family"]) ?? "generic",
    };
  } catch {
    return null;
  }
}

function saveModel(sid: string, model: SelectedModel | null): void {
  try {
    if (!model) localStorage.removeItem(MODEL_KEY(sid));
    else localStorage.setItem(MODEL_KEY(sid), JSON.stringify(model));
  } catch {
    /* storage disabled / quota exceeded */
  }
}

// The chat-header BrainPicker lifts BOTH the model and the brain it belongs
// to, but only the model was disk-persisted — so a reload restored the chip
// ("Gemini 3 Flash") while `brainOverride` reset to null, silently routing the
// next turn through the global-active brain (Claude): wrong engine, wrong
// author label, no handoff divider. Persist the brain alongside the model so
// the whole picker choice survives a reload and the engine matches the chip.
const BRAIN_KEY = (sid: string) => `aura.manager.brain.${sid}`;

function loadBrain(sid: string): BrainChoice | null {
  try {
    const raw = localStorage.getItem(BRAIN_KEY(sid));
    if (!raw) return null;
    const b = JSON.parse(raw) as Partial<BrainChoice> | null;
    if (!b || typeof b.id !== "string") return null;
    return b as BrainChoice;
  } catch {
    return null;
  }
}

function saveBrain(sid: string, brain: BrainChoice | null): void {
  try {
    if (!brain) localStorage.removeItem(BRAIN_KEY(sid));
    else localStorage.setItem(BRAIN_KEY(sid), JSON.stringify(brain));
  } catch {
    /* storage disabled / quota exceeded */
  }
}

function newQueueId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to timestamp id */
  }
  return `q-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

export function ManagerChatView({ session }: Props) {
  // Seed from the durable in-flight marker so a surface that REMOUNTS while a
  // native turn is still streaming (the workspace-switch case — AuraRailPanel
  // unmounts then remounts this view per repoRoot) shows "Working…" on the
  // first paint instead of a frozen, idle-looking pre-switch snapshot. The
  // run itself was never cancelled (see the chunk-channel cleanup below), so
  // the live chunk channel re-subscribes and resumes feeding this bubble.
  const [busy, setBusy] = useState(() => isManagerTurnInFlight(session.id));
  const [error, setError] = useState<string | null>(null);
  const [streamBlocks, setStreamBlocks] = useState<StreamBlock[]>([]);
  // Last-turn context fill from the native brain's `usage` chunk. Overwritten
  // each turn (the count is the full running context, not a per-turn delta), so
  // the composer meter always reflects how full the window is right now. Stays
  // null for CLI brains that never report usage — the meter hides itself.
  const [usage, setUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
  } | null>(null);
  // Ephemeral output from `/search`, `/zones`, `/team` slash commands —
  // rendered as system bubbles in the timeline but not persisted server-
  // side. Cleared on session change.
  const [slashLog, setSlashLog] = useState<LocalSlashEntry[]>([]);
  // Tracks whether the user just submitted an answer this turn — the
  // persisted Q+A pair is authoritative (rendered by ChatBubble from
  // session.chat), but during the round-trip we still want to show
  // "Planning next moves…" instead of "Thinking…" so the busy spinner
  // reflects post-answer state. Cleared whenever pending_question
  // toggles or a fresh manager turn lands.
  const [justAnswered, setJustAnswered] = useState(false);
  // #6 — plan-build status. A plan-mode turn shows a dedicated "Building
  // your plan…" status instead of the generic "Thinking…", and the
  // status is held for a short bounded grace after the turn stops
  // streaming so the brief server-side assembly gap (scout eligibility,
  // skill annotation, a2a mint) never reads as a dead, statusless UI.
  // Cleared the moment a plan/scout card lands, on error, or when the
  // grace timer fires.
  const [planBuilding, setPlanBuilding] = useState(false);
  const planBuildingTimer = useRef<number | null>(null);
  // The instant the user clicks Build, the pending plan clears and the chat
  // would otherwise go silent for the several seconds it takes the crew to
  // spawn + the CrewComposerBlock's 5s poll to first detect it — reading as
  // "nothing happened". This optimistic flag renders a "Spinning up the crew…"
  // line immediately on Build and hands off to the real crew strip once it
  // goes live (or a bounded timeout, so a silent spawn failure never hangs it).
  const [crewSpawning, setCrewSpawning] = useState(false);
  const crewSpawnTimer = useRef<number | null>(null);
  // Elapsed-time stat for the working indicator. Ticks once a second while a
  // turn is in flight so the "Thinking…/Working…" line carries a live timer
  // (Conductor/Claude-Code style) instead of a state that flashes once and
  // vanishes. `null` when idle; the rising edge of busy/planBuilding stamps
  // the start, the falling edge resets it.
  const turnStartRef = useRef<number | null>(null);
  // #294 — which stream path the in-flight turn took, so Stop cancels the
  // right one. The native (brain-trait) path persists partial output on
  // abort via a Drop guard and emits End{interrupted}; the legacy path
  // uses manager_cancel. Set in `send` right before the API call.
  const inflightNativeRef = useRef(false);
  // True once THIS mounted lifetime has started a turn locally. It disarms the
  // stale-marker self-correct effect: a turn we just dispatched here is driven
  // by the live chunk stream (and the snapshot still carries the PRIOR turn's
  // manager reply for a beat), so the auto-clear must only ever retire markers
  // INHERITED from a previous, now-unmounted lifetime — never one we just set.
  const ownTurnRef = useRef(false);
  // v0.2.31 LL.0 — active brain snapshot, used to decide whether the
  // current session goes through the legacy `manager-stream` MCP/CLI
  // path or the new Brain-trait `manager-chat-chunk` stream. CLI
  // wrappers stay on legacy (their UX is a terminal). Native brains
  // (`anthropic_native`, `openai_*`, `gemini_native`) use the new
  // path. `null` while the lookup is in flight → fall back to legacy
  // so the user is never stuck behind a slow keychain read.
  const [activeBrain, setActiveBrain] = useState<ActiveBrainInfo | null>(null);
  // WW-B3 — the brain the next turn runs through (chat-header BrainPicker).
  // Null = follow the globally-active brain. The picker persists the
  // choice on the session via `manager_set_brain_override`; we also pass
  // the id per-turn into `brainChatTurn` for the native path and route
  // `useBrainTrait` by the chosen brain's kind.
  const [brainOverride, setBrainOverride] = useState<BrainChoice | null>(
    () => loadBrain(session.id),
  );
  // #251 — the exact model the next turn runs (composer model picker). Set
  // alongside `brainOverride` (the picker lifts both), threaded per-turn as
  // `model` + `long_context` into `brainChatTurn`. Per-session-persisted so
  // a reload restores the chip.
  const [modelOverride, setModelOverride] = useState<SelectedModel | null>(
    () => loadModel(session.id),
  );
  useEffect(() => {
    setModelOverride(loadModel(session.id));
  }, [session.id]);
  useEffect(() => {
    saveModel(session.id, modelOverride);
  }, [modelOverride, session.id]);
  // Persist + restore the brain override in lockstep with the model so a
  // reload never desyncs the two (chip says Gemini, engine runs Claude).
  useEffect(() => {
    setBrainOverride(loadBrain(session.id));
  }, [session.id]);
  useEffect(() => {
    saveBrain(session.id, brainOverride);
  }, [brainOverride, session.id]);
  // W2 — type-ahead message queue. Populated while a turn is in flight (the
  // composer enqueues instead of dropping), drained one-per-turn-end.
  // Per-session-persisted (text + run-options; attachments are in-memory).
  const [queue, setQueue] = useState<QueuedMessage[]>(() => loadQueue(session.id));
  // Why the brain last went idle. The queue must drain ONLY after a *clean*
  // turn-end — NOT when the user hit Stop, the brain paused to ask a question,
  // or the turn errored, all of which also flip `busy` false and would
  // otherwise auto-fire the next queued message (Stop appearing to do the
  // opposite of stop; a queued follow-up racing a pending question). Each
  // busy→idle site sets this BEFORE calling setBusy(false); the drain reads it
  // on the transition. Riding the same event as setBusy avoids the
  // cross-channel race a `session.pending_question` check would have (the
  // question snapshot and the busy delta arrive on separate channels).
  const lastExitRef = useRef<"clean" | "stop" | "question" | "error">("clean");
  // The mode steering directive is a STANDING instruction, not a per-message
  // one — once the brain is told "AUTO MODE", it keeps the conversation's full
  // history, so repeating the bracketed block on every turn is noise (and it
  // leaked into the visible prompt). We send it only when the active mode for
  // THIS session first takes effect or changes. Keyed by session id so a
  // switched/resumed session re-arms the directive on its first turn.
  const steeringSentRef = useRef<{ sessionId: string; mode: string } | null>(
    null,
  );
  // Reload when the surface switches sessions — this view is not remounted
  // per session (ManagerSurface reuses one instance).
  useEffect(() => {
    setQueue(loadQueue(session.id));
  }, [session.id]);
  // Persist on every change, scoped to the active session.
  useEffect(() => {
    saveQueue(session.id, queue);
  }, [queue, session.id]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Sticky-bottom latch. The chat auto-follows new content ONLY while the
  // user is already parked at the bottom. The moment they scroll up to read
  // history we stop yanking them back — otherwise a streaming reply (which
  // fires the follow effect many times a second) makes scrolling up
  // impossible AND the repeated mid-stream `scrollTo` blanks the pane under
  // WebKit. Seeded true so the first paint lands at the latest message.
  const atBottomRef = useRef(true);
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    atBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  // How many of the most-recent timeline entries are mounted. Older turns stay
  // out of the DOM until the user asks for them, so a 400-turn import scrolls
  // as smoothly as a fresh chat. Reset to the initial window on session change
  // (see the session-id effect below).
  const [visibleCount, setVisibleCount] = useState(CHAT_WINDOW_INITIAL);
  // When we prepend older turns, the content above the fold grows and would
  // shove the viewport down. We stash the pre-reveal distance-from-bottom here
  // and restore it in a layout effect so the user stays on the exact line they
  // were reading.
  const revealAnchorRef = useRef<number | null>(null);
  const revealEarlier = useCallback(() => {
    const el = scrollRef.current;
    revealAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    setVisibleCount((n) => n + CHAT_WINDOW_STEP);
  }, []);
  useLayoutEffect(() => {
    if (revealAnchorRef.current == null) return;
    const el = scrollRef.current;
    if (el) {
      // New turns were added ABOVE the previous top, so scrollHeight grew by
      // exactly that much — offsetting scrollTop keeps the same line in view.
      el.scrollTop = el.scrollHeight - revealAnchorRef.current;
    }
    revealAnchorRef.current = null;
  }, [visibleCount]);
  // Latch: the moment a session shows ANY content (a turn, a streaming
  // bubble, a pending card) it has graduated out of the empty state for
  // good. `session.chat` can momentarily read `[]` during a snapshot
  // refresh round-trip; without this latch that blip flashes the hero in
  // and out under a message that's really still there (the "comes then
  // goes then empty state" flakiness). Reset on session-id change.
  const hadContentRef = useRef(false);
  useEffect(() => {
    hadContentRef.current = false;
  }, [session.id]);
  useEffect(() => {
    if (!justAnswered) return;
    if (session.pending_question) return;
    const lastTurn = session.chat?.[session.chat.length - 1];
    if (lastTurn && lastTurn.role === "manager") setJustAnswered(false);
  }, [session.chat, session.pending_question, justAnswered]);

  // #6 — the plan/scout card landing is the terminal state of "building
  // a plan", so clear the status the instant either appears.
  useEffect(() => {
    if (session.pending_plan || session.pending_scout) {
      if (planBuildingTimer.current) {
        window.clearTimeout(planBuildingTimer.current);
        planBuildingTimer.current = null;
      }
      setPlanBuilding(false);
    }
  }, [session.pending_plan, session.pending_scout]);

  // #6 — once a plan-mode turn stops streaming (busy false) but no plan
  // has landed yet, hold the status for a short bounded grace so the
  // brief server-side assembly gap never flashes a blank UI — then
  // clear it so a brain that simply answered in chat (no plan) doesn't
  // leave the status spinning forever.
  useEffect(() => {
    if (!planBuilding || busy) return;
    if (session.pending_plan || session.pending_scout) return;
    planBuildingTimer.current = window.setTimeout(() => {
      setPlanBuilding(false);
      planBuildingTimer.current = null;
    }, 6000);
    return () => {
      if (planBuildingTimer.current) {
        window.clearTimeout(planBuildingTimer.current);
        planBuildingTimer.current = null;
      }
    };
  }, [planBuilding, busy, session.pending_plan, session.pending_scout]);

  // Build pressed on the PlanCard → show the crew-spawning line at once and
  // arm a fallback timeout so it never spins forever if the crew never comes
  // up. The CrewComposerBlock's `onActiveChange` clears it the moment the real
  // strip goes live; a build error (surfaced via `error`) clears it too.
  const onBuildStart = useCallback(() => {
    setCrewSpawning(true);
    if (crewSpawnTimer.current) window.clearTimeout(crewSpawnTimer.current);
    crewSpawnTimer.current = window.setTimeout(() => {
      setCrewSpawning(false);
      crewSpawnTimer.current = null;
    }, 30000);
  }, []);
  const clearCrewSpawning = useCallback(() => {
    setCrewSpawning(false);
    if (crewSpawnTimer.current) {
      window.clearTimeout(crewSpawnTimer.current);
      crewSpawnTimer.current = null;
    }
  }, []);
  const onCrewActiveChange = useCallback(
    (active: boolean) => {
      if (active) clearCrewSpawning();
    },
    [clearCrewSpawning],
  );
  // A build error replaces the optimistic line with the error surface — don't
  // leave both up. Also tidy the timer on unmount.
  useEffect(() => {
    if (error) clearCrewSpawning();
  }, [error, clearCrewSpawning]);
  useEffect(
    () => () => {
      if (crewSpawnTimer.current) window.clearTimeout(crewSpawnTimer.current);
    },
    [],
  );

  // Stamp the turn's start the moment it goes in-flight (busy or assembling a
  // plan); clear it when both fall. This is a ref, NOT state — writing it
  // triggers no render. The in-flight status line reads the stamp and runs its
  // OWN 1s ticker, so the elapsed timer re-renders only that one line. A
  // view-level interval here used to re-render the entire 4000-line transcript
  // every second, which collapsed the user's text selection and made the
  // stream flicker mid-turn; the leaf-local ticker fixes both.
  useEffect(() => {
    if (!busy && !planBuilding) {
      turnStartRef.current = null;
      clearManagerTurnStartedAt(session.id);
      return;
    }
    if (turnStartRef.current == null) {
      // Resume the durable per-session start so a workspace switch — which
      // unmounts this view and drops the ref — doesn't restart the elapsed
      // timer at 0. The first observer of this turn stamps the start; later
      // mounts read it back. The backend run keeps streaming regardless; this
      // only fixes the displayed elapsed so the counter reflects real time.
      turnStartRef.current =
        getManagerTurnStartedAt(session.id) ??
        setManagerTurnStartedAt(session.id, Date.now());
    }
  }, [busy, planBuilding, session.id]);

  // Resolve the currently-active brain so `send` can pick legacy
  // (CLI wrapper PTY) vs new (Brain-trait stream). Re-runs on session
  // change so the path-switch matches a settings edit the user made
  // between switching tabs. Failure is non-fatal — we fall back to
  // legacy so a missing keychain entry doesn't break send entirely.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await api.brainActiveInfo();
        if (!cancelled) setActiveBrain(info);
      } catch {
        if (!cancelled) setActiveBrain(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  // Subscribe to the brain's stream channel. Resets on session-id change
  // so switching tabs re-binds without leaking listeners. Each delta
  // mutates the in-flight `streamBlocks`; on `done` we wipe them so the
  // persisted snapshot from `session.chat` becomes the source of truth.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    const channel = `manager-stream:${session.id}`;
    void (async () => {
      unlisten = await listen<ManagerStreamDelta>(channel, (evt) => {
        const d = evt.payload;
        if (d.kind === "text_delta") {
          setStreamBlocks((prev) => upsertText(prev, d.block_idx, d.text));
        } else if (d.kind === "tool_use") {
          // ask_user is rendered as a QuestionCard (driven by
          // session.pending_question). Skip the generic tool-card —
          // also catch the Claude-SDK PascalCase alias AskUserQuestion
          // which the model emits from training even though we only
          // declare `ask_user` in tool_definitions().
          if (isAskUserTool(d.name)) return;
          // CLI brains invoke `aura ask-user` / `aura propose-plan` via
          // Bash to drive the QuestionCard / PlanCard. The card is the
          // canonical UX — skip the redundant Bash tool-card.
          if (isAuraUxBash(d.name, d.input)) return;
          setStreamBlocks((prev) =>
            upsertTool(prev, {
              kind: "tool",
              block_idx: d.block_idx,
              tool_use_id: d.tool_use_id,
              name: d.name,
              input: d.input,
            }),
          );
        } else if (d.kind === "tool_result") {
          setStreamBlocks((prev) =>
            attachResult(prev, d.tool_use_id, {
              is_error: d.is_error,
              content: d.content,
            }),
          );
        } else if (d.kind === "question_asked") {
          // Stream-side flag — the persisted question on session.pending_question
          // is the source of truth for rendering, but flushing in-flight blocks
          // here means we don't show a half-streamed bubble next to a card.
          // NOT a turn-end: the turn pauses for the user's answer, so don't
          // let the queue drain a follow-up over the pending question.
          lastExitRef.current = "question";
          setStreamBlocks([]);
          setBusy(false);
        } else if (d.kind === "done") {
          // The legacy backend emits Done after EVERY terminal state (clean
          // finish, but ALSO trailing an Error or a QuestionAsked). So Done is
          // NOT a reliable "clean" marker — we don't touch lastExitRef here.
          // Cleanliness is the send-start default, which an Error/Question
          // overwrites before its own setBusy(false); a trailing Done causes
          // no busy transition, so the drain only ever runs on the genuine
          // terminating delta with the correct reason already set.
          setStreamBlocks([]);
          setBusy(false);
          announceTurnEnd(session.id);
        } else if (d.kind === "error") {
          lastExitRef.current = "error";
          setError(d.message);
          setBusy(false);
        }
      });
      if (cancelled && unlisten) {
        unlisten();
        unlisten = null;
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [session.id]);

  // v0.2.31 LL.0 — subscribe to the new Brain-trait chunk channel.
  // `manager-chat-chunk:<sid>` is fired by `brain_chat_turn` and
  // carries `BrainChatChunk` (text / tool_use / end / error). We
  // mirror the legacy listener's bookkeeping so the existing
  // streaming-bubble + tool-card UI keeps working without a second
  // render path. The subscription is torn down on unmount, but the
  // server-side stream is deliberately LEFT RUNNING — see the cleanup
  // note below.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    const channel = `manager-chat-chunk:${session.id}`;
    void (async () => {
      unlisten = await listen<BrainChatChunk>(channel, (evt) => {
        const c = evt.payload;
        if (c.kind === "text") {
          setStreamBlocks((prev) => upsertText(prev, c.block_idx, c.text));
        } else if (c.kind === "reasoning") {
          // Extended-thinking delta — accumulate into a reasoning block keyed
          // by its own block_idx (rendered ABOVE the answer prose).
          setStreamBlocks((prev) => upsertReasoning(prev, c.block_idx, c.text));
        } else if (c.kind === "tool_use") {
          if (isAskUserTool(c.name)) return;
          if (isAuraUxBash(c.name, c.input)) return;
          setStreamBlocks((prev) =>
            upsertTool(prev, {
              kind: "tool",
              block_idx: c.block_idx,
              tool_use_id: c.tool_use_id,
              name: c.name,
              input: c.input,
            }),
          );
        } else if (c.kind === "tool_result") {
          // Server-side board/page tool finished — attach its result to the
          // matching tool card (mirrors the legacy path's tool_result).
          setStreamBlocks((prev) =>
            attachResult(prev, c.tool_use_id, {
              is_error: c.is_error,
              content: c.content,
            }),
          );
        } else if (c.kind === "usage") {
          // The brain reported this turn's context fill — feed the composer's
          // context-window meter. Overwrite (not accumulate): the counts are the
          // full running context each turn, not a delta.
          setUsage({ inputTokens: c.input_tokens, outputTokens: c.output_tokens });
        } else if (c.kind === "end") {
          // Interrupted turn (user hit Stop): the backend already persisted
          // whatever streamed so far as a real, reload-safe turn — so we
          // mark the seam with a quiet "Interrupted" line instead of letting
          // the printed text look like it vanished. A clean end just retires
          // the live blocks (the persisted turn takes over).
          if (c.stop_reason === "interrupted") {
            // User hit Stop — not a clean end, so the queue must not drain.
            // (onStop already marks "stop"; set it again defensively in case
            // an interrupted End ever arrives without the click path.)
            lastExitRef.current = "stop";
            setSlashLog((prev) => [
              ...prev,
              { at: Date.now() / 1000, text: "Interrupted", tone: "info" },
            ]);
          }
          // The native turn has terminated server-side — retire the durable
          // in-flight marker so a later remount of this session doesn't seed a
          // phantom "Working…" for a turn that already finished.
          clearManagerTurnInFlight(session.id);
          setStreamBlocks([]);
          setBusy(false);
          announceTurnEnd(session.id);
        } else if (c.kind === "error") {
          lastExitRef.current = "error";
          clearManagerTurnInFlight(session.id);
          setError(c.message);
          setBusy(false);
        }
      });
      if (cancelled && unlisten) {
        unlisten();
        unlisten = null;
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      // DO NOT cancel the backend stream here. This cleanup fires on every
      // unmount — including a workspace switch, where AuraRailPanel resets
      // its ambient sid to null and unmounts this surface (then remounts it
      // on switch-back). Aborting the spawned `brain_chat_turn` task here is
      // exactly the "switching workspaces pauses/loses ongoing chat work"
      // bug: it killed the run mid-stream the moment the user looked away.
      //
      // The native turn runs as a detached Tokio task and keeps streaming +
      // persists on completion whether or not a listener is attached, so the
      // correct behaviour is to drop only OUR subscription and leave the run
      // alone. On remount the channel re-subscribes (resuming the live
      // stream), and managerStore's snapshot + watchdog backfill anything
      // that completed while we were away. The durable in-flight marker keeps
      // the working indicator honest across the gap.
      //
      // The run is still cancellable — explicitly, via the composer Stop
      // button (brainChatCancel on the native path) and the tab's "Cancel
      // session" action (managerCancel) — just never implicitly on a view
      // teardown the user didn't ask for. App close is out of scope (the OS
      // tears the process down); only the in-app switch is fixed here.
    };
  }, [session.id]);

  // Merge persisted chat + ribbon into a single chronological feed. Brand-
  // new sessions surface the seed objective so the user sees what they
  // typed even before the first assistant turn lands.
  const timeline = useMemo<TimelineEntry[]>(() => {
    const out: TimelineEntry[] = [];
    const chat = session.chat ?? [];
    if (chat.length === 0 && session.objective.trim()) {
      out.push({
        kind: "turn",
        at: session.created_at,
        turn: { role: "user", text: session.objective, at: session.created_at },
      });
    } else {
      for (const t of chat) out.push({ kind: "turn", at: t.at, turn: t });
    }
    for (const entry of session.ribbon ?? []) {
      const sys = ribbonAsSystem(entry);
      if (sys) out.push({ kind: "system", at: entry.at, text: sys.text, tone: sys.tone });
    }
    // A handled slash command is now PERSISTED into session.chat (a `user`
    // turn for the typed command + a `system` turn for the output) so it
    // survives a reload. The optimistic `slashLog` entry is kept only for
    // instant feedback during the persist round-trip — once the durable
    // `system` turn lands above, the ephemeral copy must be dropped or the
    // command renders twice. We de-dupe by the system output's text: a slashLog
    // entry whose `text` already exists as a persisted `system` turn (added
    // recently — within a generous window so an identical output far back in
    // history can't accidentally swallow a fresh command) is skipped whole,
    // echoed user line and all.
    const persistedSystemTexts = new Map<string, number>();
    for (const t of chat) {
      if ((t.role as string) === "system") persistedSystemTexts.set(t.text, t.at);
    }
    for (const s of slashLog) {
      const persistedAt = persistedSystemTexts.get(s.text);
      const superseded =
        persistedAt != null && Math.abs(persistedAt - s.at) < 120;
      if (superseded) continue;
      // Echo the slash the user typed as their own bubble first, so a handled
      // command (which never becomes a real chat turn) still shows what was
      // sent. Same `at` → the stable sort keeps the user line above its
      // response card.
      if (s.cmd) {
        out.push({
          kind: "turn",
          at: s.at,
          turn: { role: "user", text: s.cmd, at: s.at },
        });
      }
      out.push({ kind: "system", at: s.at, text: s.text, tone: s.tone, rich: s.rich, interactive: s.interactive, notice: s.notice });
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  }, [session.chat, session.ribbon, session.objective, session.created_at, slashLog]);

  // Settled-Scout regrouping. While Scout runs, the live `ScoutCard`
  // (driven by `pending_scout`) shows proper Architecture / Security / UX
  // rows. Once it finalizes, `pending_scout` clears and all that remains
  // are the raw `Scout: spawning…` + `[security]/[arch]/[ux]` system turns
  // the backend persisted — which otherwise render as ugly bracketed text
  // bubbles. Here we re-cluster each contiguous run of those system lines
  // back into ONE block keyed at its first index, so the finalized review
  // reads as named agents with a status, not raw text. `consumed` carries
  // every index folded into a block (the start renders the block; the rest
  // render nothing).
  const scoutGroups = useMemo(() => {
    const startAt = new Map<number, SettledSpecialist[]>();
    const consumed = new Set<number>();
    for (let i = 0; i < timeline.length; i++) {
      const e = timeline[i];
      // `ChatRole` is typed user|manager, but the backend persists Scout
      // residue under role "system" (renders as an assistant bubble) — cast
      // to read the real wire value.
      if (e.kind !== "turn" || (e.turn.role as string) !== "system") continue;
      const head = e.turn.text ?? "";
      if (!isScoutSpawnLine(head) && !parseScoutSpecialistLine(head)) continue;
      const specs: SettledSpecialist[] = [];
      let j = i;
      while (j < timeline.length) {
        const ej = timeline[j];
        if (ej.kind !== "turn" || (ej.turn.role as string) !== "system") break;
        const t = ej.turn.text ?? "";
        const spec = parseScoutSpecialistLine(t);
        if (spec) {
          specs.push(spec);
          consumed.add(j);
          j++;
          continue;
        }
        if (isScoutSpawnLine(t)) {
          consumed.add(j);
          j++;
          continue;
        }
        break;
      }
      consumed.add(i);
      startAt.set(i, specs);
      i = j - 1;
    }
    return { startAt, consumed };
  }, [timeline]);

  // #2 — cohesive assistant-turn grouping. A CLI-wrapper brain
  // (claude_code / cli:claude) persists ONE logical reply as MANY separate
  // `manager`-role turns — each streamed message / tool step lands as its own
  // ChatTurn, so the timeline renders them as N scattered "Claude" bubbles,
  // each with its own action row + step roll-up. Here we cluster each
  // contiguous run of assistant turns (role ≠ user, not a system / Scout
  // residue line) into ONE block keyed at its first index: a single agent
  // header up top, then the member turns rendered beneath it under one
  // container (each turn's intermediate steps already fold into TurnActivity).
  // A user turn — or any non-turn entry — breaks the run, so a group never
  // spans a back-and-forth. Mirrors the `scoutGroups` start-at/consumed shape.
  // Singleton runs are left alone (no header, no container) so native brains —
  // which already emit one turn per logical reply — render byte-identically to
  // before. `members` is the list of timeline indices folded into each group.
  const turnGroups = useMemo(() => {
    const startAt = new Map<number, number[]>();
    const consumed = new Set<number>();
    const isAssistantTurn = (i: number): boolean => {
      const e = timeline[i];
      if (!e || e.kind !== "turn") return false;
      if (e.turn.role === "user") return false;
      // Scout residue is role "system" and already owned by scoutGroups; the
      // (role as string) cast reads the real wire value (ChatRole omits it).
      if ((e.turn.role as string) === "system") return false;
      if (scoutGroups.consumed.has(i)) return false;
      return true;
    };
    for (let i = 0; i < timeline.length; i++) {
      if (!isAssistantTurn(i)) continue;
      const members: number[] = [i];
      let j = i + 1;
      while (j < timeline.length && isAssistantTurn(j)) {
        members.push(j);
        j++;
      }
      if (members.length >= 2) {
        startAt.set(i, members);
        for (const m of members) consumed.add(m);
      }
      i = j - 1;
    }
    return { startAt, consumed };
  }, [timeline, scoutGroups]);

  // Scrollback-rail anchors — one tick per turn bubble (the `data-rail-id`
  // stamps in the render are `t-<timeline-index>`). System lines are skipped:
  // the rail is for jumping between the conversation's turns, not ribbon
  // noise. Hidden automatically by the rail when there are <2 ticks.
  const railAnchors = useMemo<RailAnchor[]>(() => {
    const anchors: RailAnchor[] = [];
    timeline.forEach((entry, idx) => {
      if (entry.kind !== "turn") return;
      const role = entry.turn.role === "user" ? "user" : "agent";
      const preview = stripModeDirective(entry.turn.text ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      anchors.push({ id: `t-${idx}`, preview: preview || "(empty)", role });
    });
    return anchors;
  }, [timeline]);

  // Re-seed the working indicator from the durable in-flight marker whenever
  // the bound session changes. ManagerSurface reuses ONE ManagerChatView
  // instance and swaps `session.id` in place (it isn't remounted per session),
  // so the constructor seed above only covers the very first mount — this
  // covers an in-place session swap onto a session whose native turn is still
  // streaming server-side (e.g. switching back to a workspace whose chat is
  // mid-turn). `false` for an idle session keeps the old behaviour.
  useEffect(() => {
    // A session swap means any turn this instance previously drove is no
    // longer "ours" — reset so the reconcile below can self-correct an
    // inherited marker for the newly-bound session.
    ownTurnRef.current = false;
    setBusy(isManagerTurnInFlight(session.id));
  }, [session.id]);

  // Self-correct a stale in-flight marker. If a native turn FINISHED while
  // this surface was unmounted (the user switched away mid-turn and it
  // completed before they came back), no mounted chunk listener ever saw the
  // terminal `end` to clear the marker — so a naive re-seed would spin
  // "Working…" forever. `brain_chat_turn` persists the user turn immediately
  // and the manager reply only on completion, so the last persisted turn is
  // the honest tell: still `user` → the reply hasn't landed, keep waiting;
  // already `manager` → the turn settled while away, retire the marker and
  // drop busy. Gated on `streamBlocks.length === 0` so a live stream that has
  // already started painting this turn (its eventual manager turn isn't in the
  // snapshot yet) is never mistaken for "finished".
  useEffect(() => {
    if (ownTurnRef.current) return;
    if (!isManagerTurnInFlight(session.id)) return;
    if (streamBlocks.length > 0) return;
    const chat = session.chat ?? [];
    const last = chat[chat.length - 1];
    if (last && last.role === "manager") {
      clearManagerTurnInFlight(session.id);
      setBusy(false);
    }
  }, [session.id, session.chat, streamBlocks.length]);

  // Drop the slash log when the session changes — it's session-scoped (a fresh
  // conversation starts with no ephemeral slash output shown).
  useEffect(() => {
    setSlashLog([]);
    setVisibleCount(CHAT_WINDOW_INITIAL);
  }, [session.id]);

  useEffect(() => {
    if (!atBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    // Never yank the viewport out from under a live text selection. A
    // streaming reply fires this effect many times a second; re-pinning to the
    // bottom while the user is mid-drag collapses their selection, which is
    // exactly the "can't select text in the chat" complaint. If a non-collapsed
    // selection is anchored inside this pane, the user is actively selecting —
    // hands off until they let go. (Same guard the agent transcript uses.)
    const sel = window.getSelection();
    if (
      sel &&
      !sel.isCollapsed &&
      sel.anchorNode &&
      el.contains(sel.anchorNode)
    ) {
      return;
    }
    // Instant, not smooth: a streaming reply re-triggers this on every
    // chunk, and overlapping smooth animations against growing content is
    // exactly what makes WebKit paint the scroller blank. Jumping the
    // scrollTop is stable and keeps us pinned to the newest line.
    el.scrollTop = el.scrollHeight;
  }, [
    timeline.length,
    busy,
    streamBlocks,
    session.pending_plan?.id,
    session.pending_scout?.id,
  ]);

  // Resolved repo root for everything this chat spawns / scopes against.
  // A Manager session may have NO project bound (`session.projects` empty) —
  // in that case `session.projects[0]?.root` is null/empty, which on the Rust
  // side falls through to an empty cwd and the spawned agent inherits the
  // desktop app's OWN launch directory (Aura's source tree). Fall back to the
  // currently-open workspace root (the one shown in the footer / sidebar) so
  // a project-less chat still runs the agent against the user's actual repo.
  const resolvedRepoRoot =
    session.projects[0]?.root || getActiveWorkspaceRoot() || null;

  const send = useCallback(
    async (
      msg: string,
      attachments: ComposerAttachment[] = [],
      mode: "auto" | "plan" | "build" | "ask" = "build",
      pipeTargetSessionId: string | null = null,
      effort: ReasoningEffort | null = null,
      fast: boolean = false,
      approval: ApprovalPolicy | null = null,
    ) => {
      const trimmed = msg.trim();
      if (busy) return;
      if (!trimmed && attachments.length === 0) return;
      // The user just sent — always re-pin so their message (and the reply)
      // scroll into view, even if they'd scrolled up to read history.
      atBottomRef.current = true;
      // Chat-first sweep — `/search`, `/zones`, `/team` are handled
      // client-side. They run via the Aura CLI and render their output
      // as ephemeral system bubbles; the brain never sees them.
      // Parity W8 — a non-handled result can carry `forwardText`: the verb
      // expanded into a richer prompt (e.g. `/pr describe` → full skill
      // text) that goes to the brain INSTEAD of the raw slash message.
      let outbound = trimmed;
      if (trimmed.startsWith("/") && attachments.length === 0) {
        const root = resolvedRepoRoot;
        if (root) {
          const result = await handleChatSlash(trimmed, {
            repoRoot: root,
            sessionId: session.id,
          });
          if (result?.handled) {
            const output = result.output?.trim() ? result.output : null;
            // An *action* command (`/resume`) returns a live clickable control
            // instead of markdown. It's a transient affordance — render it, echo
            // the typed command, but DON'T persist it (a stale session list
            // frozen into history is noise; the picker is live, like a menu).
            const interactive = result.interactive ?? null;
            setSlashLog((prev) => [
              ...prev,
              {
                at: Date.now() / 1000,
                // Echo the user's typed slash as their own bubble.
                cmd: trimmed,
                // Interactive entries carry no markdown body; a short label is
                // kept only as a non-rendering fallback / de-dupe key.
                text: interactive ? trimmed : (output ?? "(no output)"),
                tone: result.tone ?? "info",
                // Slash outputs render as a plain chat message (markdown), not
                // a bespoke card/box — flag them rich so the timeline renders
                // the real document (lists, bold) instead of a flat italic line.
                rich: interactive ? false : true,
                interactive: interactive ?? undefined,
              },
            ]);
            // Action commands are ephemeral — skip the persist round-trip below.
            if (interactive) return;
            // DURABLE history. A handled slash command used to be ephemeral —
            // gone on reload. Persist it as part of the conversation: the typed
            // command as a `user` turn, its output as a calm `system` turn. The
            // timeline de-dupes the optimistic copy above by the system text
            // once these arrive. Only persist when there's real output (a bare
            // `/brain` picker pop with no body leaves nothing worth keeping).
            // Best-effort and order-preserving: failures fall back to the
            // ephemeral copy, which still renders for this session.
            if (output) {
              void (async () => {
                try {
                  await api.managerAppendChat(session.id, "user", trimmed);
                  await api.managerAppendChat(session.id, "system", output);
                } catch (e) {
                  console.warn("[manager] slash persist failed", e);
                }
              })();
            }
            return;
          }
          if (result?.forwardText) {
            outbound = result.forwardText;
          }
        }
      }
      // Drive-through PTY — if the user picked a pipe target, also push
      // the trimmed text into that agent's PTY (newline-terminated so
      // the agent treats it as a submitted prompt). We still record the
      // turn with the Manager brain so the conversation history stays
      // coherent, but tag it with a marker so the brain knows the user
      // already drove the agent directly (don't re-dispatch the same
      // ask).
      let pipeMarker = "";
      if (pipeTargetSessionId && trimmed) {
        try {
          const bytes = Array.from(
            new TextEncoder().encode(trimmed + "\r"),
          );
          await api.agentPtyWrite(pipeTargetSessionId, bytes);
          pipeMarker =
            "[↪ PIPED — User also wrote this message directly into an open agent PTY tab. Do NOT dispatch a new agent for the same ask; respond conversationally and only act if explicitly asked.]\n\n";
        } catch (e) {
          console.warn("[manager] PTY pipe failed", e);
          // Don't abort the manager send — the chat still goes through,
          // just without the PTY half. Surface as a system line so the
          // user knows the PTY drop didn't land.
          setSlashLog((prev) => [
            ...prev,
            {
              at: Date.now() / 1000,
              text: `Pipe to PTY failed: ${e instanceof Error ? e.message : String(e)}`,
              tone: "warn",
            },
          ]);
        }
      }
      // Auto → Plan auto-switch, PER TURN ONLY. On Auto, a clear "make me a
      // plan" ask should get the plan flow (PlanCard → Build) for THIS turn,
      // not a silent autopilot run. We steer only this one turn to Plan and
      // leave a one-line note — we deliberately do NOT mutate the persistent
      // Auto chip. (The old code dispatched `aura:composer:set-mode` to flip
      // the chip to Plan, but nothing ever flipped it back, so Auto got
      // permanently stuck in Plan — and because the chip persists to
      // localStorage, it even survived reloads. Steering per-turn keeps the
      // user on Auto and re-evaluates the next message fresh.) Slash commands
      // already returned above, so `outbound` here is real prose.
      let effectiveMode = mode;
      if (mode === "auto" && looksLikePlanRequest(outbound)) {
        effectiveMode = "plan";
        setSlashLog((prev) => [
          ...prev,
          {
            at: Date.now() / 1000,
            // `text` is the a11y/de-dupe fallback; the designed PlanModeNotice
            // card (keyed off `notice`) renders the real structured content.
            text: "Planning this first — I'll lay out a plan, then you hit Build to run it. You're still on Auto.",
            tone: "info",
            notice: "plan-mode",
          },
        ]);
      }
      // Steering directive — until the backend grows a real `mode` param we
      // prefix the user turn with an instruction the brain will honor. Build is
      // the default and gets no prefix. It's a STANDING instruction: the brain
      // keeps the whole conversation, so we send it only on the first turn of a
      // session or when the mode changes — never glued onto every message.
      const steeringText = buildSteeringText(effectiveMode);
      const prior = steeringSentRef.current;
      const steeringEstablished =
        prior != null &&
        prior.sessionId === session.id &&
        prior.mode === effectiveMode;
      // Build mode has no directive — track it too so leaving + returning to a
      // non-Build mode re-arms correctly.
      steeringSentRef.current = { sessionId: session.id, mode: effectiveMode };
      const steering = steeringEstablished ? "" : steeringText;
      // Default the turn's exit reason to clean; the terminal handlers
      // (error / question_asked / Stop) overwrite it before their own
      // setBusy(false), so the queue drains only on a genuine clean end.
      lastExitRef.current = "clean";
      setBusy(true);
      setError(null);
      trackFeature("chat_message", { mode: effectiveMode });
      setStreamBlocks([]);
      // #6 — a plan-mode turn drives the "Building your plan…" status.
      // Any other mode clears it (e.g. a follow-up Build/Ask turn).
      if (planBuildingTimer.current) {
        window.clearTimeout(planBuildingTimer.current);
        planBuildingTimer.current = null;
      }
      setPlanBuilding(effectiveMode === "plan");
      const finalText = pipeMarker + steering + outbound;
      try {
        // v0.2.31 LL.0 — Brain-trait stream path for native brains.
        // CLI wrappers stay on the legacy `manager_chat` path because
        // their UX is a terminal (per the agent-view-default rule),
        // not a chat bubble. The path also falls back to legacy when
        // we don't yet know the active brain (first send before
        // `brainActiveInfo` resolves) or when attachments are present
        // — attachments aren't yet plumbed through the Brain trait, so
        // we route them via the legacy multimodal path. Both paths
        // produce identical `setStreamBlocks` updates; the difference
        // is which channel emits the chunks.
        // WW-B3 — when the user picked a brain for THIS turn, route by
        // the OVERRIDDEN brain's kind (cli_wrapper → terminal/legacy
        // path; native → chat-bubble path) and ignore the global active
        // brain. With no override, fall back to the active brain. The
        // legacy path still picks up a cli_wrapper override because the
        // picker persisted it on the session via
        // `manager_set_brain_override`. Attachments force the legacy
        // multimodal path until the Brain trait carries images.
        const overrideNative =
          brainOverride != null && brainOverride.kind !== "cli_wrapper";
        const useBrainTrait =
          attachments.length === 0 &&
          (overrideNative ||
            (brainOverride == null &&
              !!activeBrain &&
              !activeBrain.is_cli_wrapper));
        inflightNativeRef.current = useBrainTrait;
        // Arm the durable in-flight marker for the native path: the spawned
        // turn now outlives this component (a workspace switch unmounts the
        // surface without cancelling), so the marker is what a later remount
        // reads to know the run is still going. The legacy CLI path drives a
        // terminal, not this chat stream, so it doesn't participate.
        if (useBrainTrait) {
          markManagerTurnInFlight(session.id);
          ownTurnRef.current = true;
        }
        if (useBrainTrait) {
          // Flatten persisted chat into a brain-shaped message array.
          // We DON'T append the new user turn here — `brain_chat_turn`
          // does that server-side from its `user_message` arg.
          const priorMessages = (session.chat ?? []).map((t) => ({
            role:
              t.role === "user" ? ("user" as const) : ("assistant" as const),
            content: t.text,
          }));
          await api.brainChatTurn(
            session.id,
            finalText,
            {
              messages: priorMessages,
              effort,
              fast,
              // #251 — per-turn model from the composer picker. snake_case
              // keys match the serde-deserialized `ChatRequest`. Null/false
              // → the brain stays on its configured default (byte-identical
              // to the pre-picker request).
              model: modelOverride?.modelId ?? null,
              long_context: modelOverride?.longContext ?? false,
              // #254 — per-turn permission/autonomy policy. Null → the
              // brain stays on its own ask-flow (byte-identical request).
              // Native brains carry it but run their own tool loop; CLI
              // wrappers map it to a real per-agent permission flag.
              approval,
            },
            // Engine for this turn. `brainOverride` is ephemeral (resets to
            // null on reload/remount) while `modelOverride` is disk-persisted
            // and carries the brain it belongs to — so a reload used to leave
            // the chip showing e.g. "Gemini 3 Flash" while the turn silently
            // ran on the global-active brain (Claude), mislabeled and with no
            // handoff divider. Fall back to the persisted model's `brainId` so
            // the engine always matches the visible chip.
            brainOverride?.id ?? modelOverride?.brainId ?? null,
            // The repo/worktree root this chat is open in. A native chat opened
            // in a worktree workspace must run the agent INSIDE that worktree —
            // otherwise a CLI brain (e.g. "Claude Code") spawns in HOME and
            // reports "not a git repo". The backend prefers this over the
            // session's bound project list (which omits worktree paths).
            resolvedRepoRoot,
          );
        } else {
          await api.managerChat(session.id, finalText, attachments);
        }
      } catch (e) {
        lastExitRef.current = "error";
        // The dispatch threw before any turn started streaming (e.g. the
        // invoke rejected) — no detached run exists, so retire the marker.
        clearManagerTurnInFlight(session.id);
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    },
    [
      busy,
      session.id,
      session.projects,
      session.chat,
      activeBrain,
      brainOverride,
      modelOverride,
      resolvedRepoRoot,
    ],
  );

  // Route a slash-command card's button press. A card only declares intent
  // (it never reaches into the app) so this is the single place that turns a
  // button into an effect:
  //   - "run-slash" → re-enter send() with the command → produces a fresh card
  //   - "mention"   → drive one assistant's own CLI (@<id> /<command>)
  //   - "event"     → open a surface a chat bubble can't host (Crew, picker…)
  // W2 — enqueue a turn while busy (the composer routes here instead of
  // `send` when a turn is in flight). Agent-agnostic: we just park the
  // payload; `send` later replays it through whichever brain/PTY is active.
  const enqueue = useCallback(
    (
      message: string,
      attachments: ComposerAttachment[],
      mode: "auto" | "plan" | "build" | "ask",
      pipeTargetSessionId: string | null,
      effort: ReasoningEffort | null,
      fast: boolean,
      approval: ApprovalPolicy | null,
    ) => {
      setQueue((q) => [
        ...q,
        {
          id: newQueueId(),
          text: message,
          attachments,
          mode,
          pipeTargetSessionId,
          effort,
          fast,
          approval,
        },
      ]);
    },
    [],
  );

  const removeQueued = useCallback(
    (id: string) => setQueue((q) => q.filter((m) => m.id !== id)),
    [],
  );
  const editQueued = useCallback(
    (id: string, text: string) =>
      setQueue((q) => q.map((m) => (m.id === id ? { ...m, text } : m))),
    [],
  );
  const promoteQueued = useCallback(
    (id: string) =>
      setQueue((q) => {
        const i = q.findIndex((m) => m.id === id);
        if (i <= 0) return q;
        const next = [...q];
        const [it] = next.splice(i, 1);
        next.unshift(it);
        return next;
      }),
    [],
  );
  const moveQueued = useCallback(
    (id: string, dir: "up" | "down") =>
      setQueue((q) => {
        const i = q.findIndex((m) => m.id === id);
        if (i < 0) return q;
        const j = dir === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= q.length) return q;
        const next = [...q];
        [next[i], next[j]] = [next[j], next[i]];
        return next;
      }),
    [],
  );
  const clearQueue = useCallback(() => setQueue([]), []);

  // Drain one queued turn each time the brain goes idle on a CLEAN turn-end
  // (busy true→false with lastExitRef "clean"). Sending the head flips `busy`
  // back on, so the next item waits for the following turn-end. Guarding on
  // the transition (not just `!busy`) keeps the whole queue from firing at
  // once; guarding on the exit reason keeps Stop / a pending question / an
  // error from auto-firing the next message (the lastExitRef machinery above).
  const prevBusyRef = useRef(busy);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (wasBusy && !busy && lastExitRef.current === "clean") {
      setQueue((q) => {
        if (q.length === 0) return q;
        const [head, ...rest] = q;
        // Defer the send out of the state updater so we don't dispatch
        // mid-render; by the microtask `busy` is still false so `send`
        // runs (it sets busy true itself).
        queueMicrotask(() => {
          void send(
            head.text,
            head.attachments,
            head.mode,
            head.pipeTargetSessionId,
            head.effort,
            head.fast,
            head.approval,
          );
        });
        return rest;
      });
    }
  }, [busy, send]);

  // Edit-and-resend a previous user turn. `chatIndex` is the index into
  // `session.chat`; the backend truncates from there, optionally reverts
  // file content via snapshots, and re-runs the brain on the new text.
  const onEditResend = useCallback(
    async (chatIndex: number, newText: string, restoreCode: boolean) => {
      if (busy) return;
      lastExitRef.current = "clean";
      setBusy(true);
      setError(null);
      setStreamBlocks([]);
      try {
        await api.managerChatEditResend(
          session.id,
          chatIndex,
          newText,
          restoreCode,
        );
      } catch (e) {
        lastExitRef.current = "error";
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    },
    [busy, session.id],
  );

  // Answering a docked question unblocks the brain, which resumes the SAME
  // turn server-side. Without re-arming the in-flight flags here there's a
  // dead gap between the answer landing and the first resumed delta where
  // the view shows no "working" status at all — the user reads it as "my
  // answer did nothing". Mirror the send path (setBusy + markManagerTurnInFlight)
  // so the status indicator rides straight through; the trailing Done event
  // clears it the same way it clears a normal turn.
  const onQuestionAnswered = useCallback(() => {
    setJustAnswered(true);
    lastExitRef.current = "clean";
    setBusy(true);
    markManagerTurnInFlight(session.id);
  }, [session.id]);

  // Auto-fire the seed objective once on mount so picking "Aura Manager"
  // from the picker drops the user into a live conversation without
  // requiring them to click Send. Skipped if the session already has any
  // chat turns — those came from a previous run and the brain already
  // responded to them.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    const hasChat = (session.chat?.length ?? 0) > 0;
    if (hasChat) {
      seededRef.current = true;
      return;
    }
    if (!session.objective.trim()) return;
    seededRef.current = true;
    void send(session.objective);
  }, [session.id, session.chat, session.objective, send]);

  // Auto-open plan as a full WorkSurface tab the moment a pending_plan
  // arrives (Cursor-parity). The inline PlanCard stays in the chat as a
  // condensed reference, but the rich detail view (mermaid + phases +
  // file refs) lives in the tab. We track which plan ids we've already
  // popped so a re-render of the same plan doesn't re-open the tab.
  const editor = useEditorStore();
  const openedPlanIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const plan = session.pending_plan;
    if (!plan) return;
    if (openedPlanIdsRef.current.has(plan.id)) return;
    openedPlanIdsRef.current.add(plan.id);
    const repoRoot = resolvedRepoRoot;

    // Do NOT auto-open or focus the Plan tab on arrival. Auto-focusing it
    // yanked the user out of the chat — the plan "replaced the whole view"
    // with no easy way back. Instead the plan surfaces as an inline,
    // clickable PlanCard in the chat stream (with VIEW PLAN + Build); the
    // dedicated Plan tab opens on demand only when the user clicks through.
    //
    // We still archive the plan into the Pages library as a real .md Page
    // so it's durable and findable later — silently, without opening or
    // focusing Pages (note id derived from plan.id so re-presenting the
    // same plan updates one page instead of spawning duplicates).
    if (repoRoot) {
      void api
        .notesWrite({
          repoRoot,
          scope: "team",
          bucket: "",
          id: planPageId(plan.id),
          title: plan.title?.trim() || "Plan",
          body: pendingPlanToMarkdown(plan),
          visibility: "shared",
          tags: ["plan"],
        })
        .catch((e) => console.warn("[plan→page] archive failed", e));
    }
  }, [session.pending_plan, session.id, session.projects, editor, resolvedRepoRoot]);

  // Fork the conversation at a turn — clone every turn up to (and
  // including) `chatIndex` into a fresh Manager session, then open it
  // either as a new in-app chat tab or as its own OS window. The original
  // session is untouched, so this is a non-destructive "branch from here".
  const onForkTurn = useCallback(
    async (chatIndex: number, target: "tab" | "workspace") => {
      try {
        const newSid = await api.managerForkSession(session.id, chatIndex);
        const label = session.objective.trim()
          ? `${session.objective.trim().slice(0, 32)} (fork)`
          : "Forked chat";
        if (target === "workspace") {
          const root = resolvedRepoRoot;
          if (root) {
            await openPopout({ kind: "manager", root, sessionId: newSid, label });
            return;
          }
          // No repo root to scope a window to — fall back to an in-app tab.
        }
        editor.openManager(newSid, label);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [session.id, session.objective, session.projects, editor, resolvedRepoRoot],
  );

  // Group consecutive bubbles from the same author — the avatar appears
  // only on the first row of each group, the rest indent under it. Same
  // pattern as Slack / iMessage / Claude. System lines + cards reset the
  // group so the next bubble re-shows its avatar.
  const repoRootForChat = resolvedRepoRoot;
  // Drive-through PTY picker source — only PTY-mode agent tabs in this
  // workspace are valid pipe targets. Stream-mode tabs are managed by
  // the brain itself, so piping into them would race with the
  // streaming connection.
  const pipeTargets = useMemo(
    () =>
      editor.agentTabs
        .filter(
          (t) => t.mode === "pty" && (!repoRootForChat || t.repoRoot === repoRootForChat),
        )
        .map((t) => ({
          sessionId: t.sessionId,
          label: t.agentLabel,
          monogram: t.agentMonogram,
        })),
    [editor.agentTabs, repoRootForChat],
  );
  // Pre-first-message state: a brand-new chat (blank objective, no turns,
  // nothing streaming or pending). The chat view IS the empty state — it
  // shows the Aura wordmark until the user sends, instead of a separate
  // welcome surface. All the timeline siblings below render nothing in
  // this state, so we just overlay the hero as the first child.
  // #3 — the in-flight running tool, if any. A tool block with no `result`
  // yet is currently executing (the stream attaches `result` the moment it
  // returns). We surface the LAST such block — the one running now — as a live
  // "Running …" status row beneath the stream, with its own elapsed timer. The
  // running label comes from the registry so it matches the eventual tool card
  // ("Running `aura propose-plan`"). null when nothing is mid-flight.
  const runningTool = useMemo(() => {
    if (!busy) return null;
    for (let i = streamBlocks.length - 1; i >= 0; i--) {
      const b = streamBlocks[i];
      if (b.kind === "tool" && !b.result) return b;
    }
    return null;
  }, [streamBlocks, busy]);

  const hasLiveContent =
    timeline.length > 0 ||
    streamBlocks.length > 0 ||
    busy ||
    planBuilding ||
    !!session.pending_question ||
    !!session.pending_plan ||
    !!session.pending_scout;
  if (hasLiveContent) hadContentRef.current = true;
  const showEmptyState = !hasLiveContent && !hadContentRef.current && !error;
  // A clubbed set of 1–4 questions (the brain batched them in one `ask_user`).
  // A set always renders as the keyboard/click-driven QuestionCard regardless
  // of its first question's kind — the roomy single-text overlay can't hold a
  // set.
  const questionIsSet =
    !!session.pending_question &&
    (session.pending_question.items?.length ?? 0) > 1;
  // A choice/multi question — or any set — fuses onto the composer as one
  // stacked panel, but only when nothing (a queued message) sits between them
  // in the dock. A lone free-text question uses the roomy overlay and never
  // fuses.
  const fuseQuestion =
    !!session.pending_question &&
    (questionIsSet || session.pending_question.kind !== "text") &&
    queue.length === 0;
  // The plan-paused banner fuses onto the composer the same way a docked
  // question does — one stacked panel, no floating gap. Only when nothing
  // (a queued message) sits between them in the dock.
  const fusePlan =
    !!session.pending_plan &&
    !session.pending_question &&
    queue.length === 0;
  // An action slash command (`/resume`) returns a live picker. It docks to the
  // composer — flush above the input as one compact panel — instead of
  // floating as a bulky card mid-stream. The most recent un-dismissed resume
  // entry in the ephemeral slashLog is the active one (it's removed on pick or
  // dismiss). Fuse only when nothing (a question, plan banner, or queued
  // message) sits between it and the composer.
  const dockedResume = useMemo(() => {
    for (let i = slashLog.length - 1; i >= 0; i--) {
      if (slashLog[i].interactive?.kind === "resume") return slashLog[i];
    }
    return null;
  }, [slashLog]);
  const fuseResume =
    !!dockedResume &&
    !session.pending_question &&
    !session.pending_plan &&
    queue.length === 0;
  // First timeline index we actually mount. Everything before it is rendered
  // as `null` (kept in the map so the absolute index the group/scout lookups
  // depend on stays intact — see renderTimelineEntry). We snap the cut up to a
  // group head so a clustered assistant turn or a Scout block is never sliced
  // through the middle (which would drop its visible tail). `hiddenCount` drives
  // the "Show earlier messages" control.
  let windowStart = Math.max(0, timeline.length - visibleCount);
  while (
    windowStart > 0 &&
    (turnGroups.consumed.has(windowStart) || scoutGroups.consumed.has(windowStart)) &&
    !turnGroups.startAt.has(windowStart) &&
    !scoutGroups.startAt.has(windowStart)
  ) {
    windowStart--;
  }
  const hiddenCount = windowStart;
  return (
    <ChatRepoRootContext.Provider value={repoRootForChat}>
    <div className="flex flex-col h-full min-h-0">
      {/* Scroll region + scrollback rail share ONE positioning context so the
          rail spans only the messages and ends above the composer dock (not
          running to the very bottom of the pane). */}
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="p-scroll flex flex-col"
      >
        {showEmptyState && (
          <ChatEmptyState
            onPick={(prompt) => void send(prompt, [], "ask")}
            projectLabel={session.projects[0]?.label}
            repoRoot={repoRootForChat ?? undefined}
          />
        )}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={revealEarlier}
            className="self-center my-3 px-3 py-1.5 rounded-full text-xs text-[var(--color-text-3)] border border-[var(--color-border)] hover:text-[var(--color-text-1)] hover:bg-[var(--color-muted)] transition-colors"
          >
            Show earlier messages · {hiddenCount} hidden
          </button>
        )}
        {timeline.map((entry, idx) => {
          // Windowed render — older turns stay out of the DOM (returned as
          // null) so a long imported history scrolls smoothly. We keep the map
          // over the FULL timeline so `idx` remains the absolute index the
          // group/scout lookups inside renderTimelineEntry are keyed by.
          if (idx < hiddenCount) return null;
          const prev = timeline[idx - 1];
          // Wall-clock seam — when a conversation is paused (cancelled,
          // closed, walked away from) and picked back up later, the jump in
          // `at` between two adjacent entries marks real elapsed time. Above
          // the threshold we draw a wiggly divider so a turn answered an hour
          // later doesn't read as an immediate reply. Both ends must be real
          // epoch stamps (legacy turns can carry 0 / undefined `at`); cap at
          // 60 days so a bad-data jump from epoch 0 never renders an absurd
          // "20000d later". Suppress it for the first visible entry — there's
          // nothing mounted above it to seam against.
          const gapSec =
            prev && idx > hiddenCount && prev.at > 0 && entry.at > 0
              ? entry.at - prev.at
              : 0;
          const gapDivider =
            gapSec >= TIME_GAP_MIN_SEC && gapSec <= 60 * 86400 ? (
              <TimeGapDivider seconds={gapSec} />
            ) : null;
          const node = renderTimelineEntry();
          return (
            <Fragment key={idx}>
              {gapDivider}
              {node}
            </Fragment>
          );

          function renderTimelineEntry() {
          // Settled-Scout block — the first index of a finalized Scout run
          // renders the regrouped agent block; every other folded-in system
          // line renders nothing (its content lives in the block).
          if (scoutGroups.startAt.has(idx)) {
            const specs = scoutGroups.startAt.get(idx)!;
            return specs.length > 0 ? <SettledScoutBlock specialists={specs} /> : null;
          }
          if (scoutGroups.consumed.has(idx)) return null;
          // #2 — cohesive assistant-turn group. A contiguous run of ≥2
          // assistant turns (the CLI-wrapper "one reply, N scattered bubbles"
          // case) renders as ONE block: a single agent header up top, then the
          // member turns stacked beneath it. The start index owns the whole
          // group; every other member renders nothing here (it's drawn inside
          // the block). A lone assistant turn falls through to the normal
          // single-turn path below, unchanged.
          if (turnGroups.startAt.has(idx)) {
            const members = turnGroups.startAt.get(idx)!;
            // Header brain: the first member that recorded one (a CLI-wrapper
            // run tags its turns, e.g. "cli:claude"); null → the generic Aura
            // header. The group renders ONE header, then each member turn.
            let headerBrain: string | null = null;
            for (const m of members) {
              const me = timeline[m];
              if (me.kind === "turn" && me.turn.brain) {
                headerBrain = me.turn.brain;
                break;
              }
            }
            return (
              <AssistantTurnGroup headerBrain={headerBrain}>
                {members.map((m, i) =>
                  renderAssistantTurn(m, true, i === members.length - 1),
                )}
              </AssistantTurnGroup>
            );
          }
          if (turnGroups.consumed.has(idx)) return null;
          if (entry.kind === "turn") {
            // A persisted `system` turn is a client-handled slash command's
            // output (`/team`, `/loop`, …) appended to session.chat so it
            // survives a reload. It must render as the same calm SystemCard the
            // ephemeral slashLog used — a plain markdown body, never an "Aura"
            // agent bubble. Tone is `info` (the persisted ChatTurn carries no
            // tone field); that's exactly the chrome-free calm markdown render.
            if ((entry.turn.role as string) === "system") {
              return <SystemCard text={entry.turn.text} tone="info" />;
            }
            if (entry.turn.role !== "user") {
              // A lone assistant turn — same node the group renders per member.
              return renderAssistantTurn(idx, false, true);
            }
            const chatIndex = session.chat
              ? session.chat.indexOf(entry.turn)
              : -1;
            return (
              <div key={idx} data-rail-id={`t-${idx}`}>
                <ChatBubble
                  turn={entry.turn}
                  chatIndex={chatIndex >= 0 ? chatIndex : null}
                  busy={busy}
                  durationSec={null}
                  onEditResend={onEditResend}
                  onFork={onForkTurn}
                />
              </div>
            );
          }
          // An action command (`/resume`) returns a live, clickable control
          // instead of a markdown body. It does NOT render inline here — it
          // docks to the composer (see `dockedResume` / `fuseResume` in the
          // dock below) so it reads as a compact action panel pinned to the
          // input, not a bulky card floating mid-stream. Skip it in the flow.
          if (entry.interactive?.kind === "resume") {
            return null;
          }
          // A designed system notice — render the compact card, not a flat
          // markdown run. `plan-mode` = the "Switched to Plan mode" card.
          if (entry.kind === "system" && entry.notice === "plan-mode") {
            return <PlanModeNotice />;
          }
          // A rich slash output (`/help`, `/loop`, `/agents`, …) is a full
          // markdown document — render it as a calm system card so its list,
          // bold and code read properly, instead of collapsing into one
          // italic line (or, for tone "ok", a bare milestone label). The rich
          // check runs FIRST so an "ok" slash result still gets the card.
          if (entry.rich) {
            return <SystemCard text={entry.text} tone={entry.tone} />;
          }
          // A completed-work event (tone "ok" — "Task #N done", a shipped
          // wave) reads as a milestone, not an aside. Antigravity-style: a
          // centered rule with the caption inset, marking a major thing
          // finished, instead of a left-margin system aside.
          if (entry.tone === "ok") {
            return <MilestoneDivider text={entry.text} />;
          }
          return <SystemLine text={entry.text} tone={entry.tone} />;
          }

          // Render one assistant turn (used both standalone and as a group
          // member). Computes the time-taken stat + the cross-brain handoff
          // divider off the timeline, then draws the ChatBubble. Pulled out of
          // the inline branch so the cohesive group can reuse the exact same
          // per-turn rendering for each of its members.
          //
          // `inGroup` — this turn is one segment of a cohesive AssistantTurnGroup
          // (the CLI-wrapper "one reply, N bubbles" case). The group header
          // already carries the brand, so member segments drop the redundant
          // per-message "Claude" model chip. `isLast` — only the final segment
          // draws the action-row footer (copy / model / more), so the whole run
          // reads as ONE message with one footer instead of N stamped bubbles.
          // A lone turn passes inGroup=false, isLast=true (unchanged behaviour).
          function renderAssistantTurn(
            turnIdx: number,
            inGroup = false,
            isLast = true,
          ) {
            const e = timeline[turnIdx];
            if (e.kind !== "turn") return null;
            const turn = e.turn;
            const chatIndex = session.chat ? session.chat.indexOf(turn) : -1;
            // Time-taken — the gap to the nearest prior turn (the prompt it
            // answered). `at` is epoch seconds; clamp out multi-day gaps (a
            // thread resumed days later isn't "thinking").
            let durationSec: number | null = null;
            for (let j = turnIdx - 1; j >= 0; j--) {
              const p = timeline[j];
              if (p.kind === "turn") {
                const d = turn.at - p.turn.at;
                if (d >= 0 && d <= 86400) durationSec = d;
                break;
              }
            }
            // Brain-handoff marker: if this assistant turn ran on a different
            // brain than the nearest prior assistant turn that recorded one,
            // the user swapped models mid-thread — surface a "Continued on X"
            // divider so the seamless cross-agent continuation is visible
            // (the backend already carries the full transcript across).
            let switchedToBrain: string | null = null;
            if (turn.brain) {
              for (let j = turnIdx - 1; j >= 0; j--) {
                const p = timeline[j];
                if (p.kind === "turn" && p.turn.role !== "user" && p.turn.brain) {
                  if (p.turn.brain !== turn.brain) {
                    switchedToBrain = turn.brain;
                  }
                  break;
                }
              }
            }
            return (
              <div key={turnIdx} data-rail-id={`t-${turnIdx}`}>
                {switchedToBrain && (
                  <BrainHandoffDivider
                    brain={switchedToBrain}
                    chat={session.chat ?? []}
                  />
                )}
                <ChatBubble
                  turn={turn}
                  chatIndex={chatIndex >= 0 ? chatIndex : null}
                  busy={busy}
                  durationSec={durationSec}
                  inGroup={inGroup}
                  showActions={isLast}
                  onEditResend={onEditResend}
                  onFork={onForkTurn}
                />
              </div>
            );
          }
        })}
        {streamBlocks.length > 0 && (
          // Polite, non-atomic live region: screen readers announce the
          // assistant's reply as it streams in (WCAG 2.2 § 4.1.3 Status
          // Messages) without re-reading the whole turn on every token.
          <div aria-live="polite" aria-atomic="false" aria-relevant="additions text">
            <StreamingBubble
              blocks={streamBlocks}
              streaming={busy}
              // No "Aura" brand row — kept off the live turn too so the stream
              // reads identically to a settled one (the tab carries the brand).
              identity={false}
            />
          </div>
        )}
        {/* #3 — the live "Running …" status for the in-flight command no
            longer floats loose here in the stream; it's now DOCKED as a slim
            strip flush atop the composer (see <RunningCommandStatus docked />
            just above <ManagerComposer>), so it reads as composer chrome and
            collapses back into the transcript the moment the turn finishes. */}
        {/* Wave timeline — aggregates all "Wave N dispatched/shipped/…"
            events from agent prose into ONE structured block. Each wave
            is one row that progresses through states; per-turn wave
            events are filtered out (AgentMessageBody) to prevent
            duplication. */}
        <WaveTimeline chat={session.chat ?? []} />
        {/* Live dispatch strip — shows per-task agent activity derived
            from the ribbon (task_dispatched → task_completed/failed).
            Auto-hides when nothing is in flight. */}
        <LiveDispatchStrip ribbon={session.ribbon ?? []} />
        {/* ScoutCard precedes PlanCard. While Scout is in flight, the
            brain's plan envelope is parked and we render the live
            specialist card; once Scout finalizes, `pending_scout`
            clears and `pending_plan` populates so PlanCard takes over. */}
        {session.pending_scout && (
          <ScoutCard sessionId={session.id} scout={session.pending_scout} />
        )}
        {/* PlanCard renders INLINE in the timeline (Cursor-parity) — not
            docked at the bottom — so the prepared plan flows as a chat
            element next to the agent's prose, then the user can either
            decide inline or click "Open" to expand it as a full PlanTab. */}
        {session.pending_plan && (
          <PlanCard
            sessionId={session.id}
            plan={session.pending_plan}
            onError={setError}
            onBuildStart={onBuildStart}
            repoRoot={resolvedRepoRoot}
          />
        )}
        {(busy || planBuilding) &&
          !session.pending_question &&
          !session.pending_plan &&
          !session.pending_scout &&
          !error && (
            planBuilding ? (
              <PlanningStatusLine label="Building your plan" startedAt={turnStartRef.current} />
            ) : runningTool ? (
              // A command is running — the docked RunningCommandStatus strip
              // atop the composer already carries the live "Running … · 12s"
              // status, so suppress the generic "Working…" line here to avoid
              // two near-identical in-flight rows stacked on each other.
              null
            ) : streamBlocks.length > 0 ? (
              // The answer is already streaming above — keep a quiet, timed
              // "Working…" line beneath it so the turn never looks finished
              // while the brain is still producing tokens or running tools.
              <ThinkingLine label="Working…" startedAt={turnStartRef.current} />
            ) : justAnswered ? (
              <PlanningStatusLine startedAt={turnStartRef.current} />
            ) : (
              <ThinkingLine startedAt={turnStartRef.current} />
            )
          )}
        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className="text-rose-400 text-xs px-2 py-1 bg-rose-500/10 rounded border border-rose-500/30 mt-2"
          >
            {error}
          </div>
        )}
      </div>
      {/* Scrollback rail — a slim minimap on the right edge for jumping
          between turns in a long conversation. Reads bubble offsets off the
          live scroll DOM (the `data-rail-id` stamps above); self-hides when
          there are fewer than two turns. */}
        <MessageScrollbackRail scrollRef={scrollRef} anchors={railAnchors} />
      </div>
      {/* The composer dock floats seamlessly under the message stream — no
          hard rule between them. The `.p-dock` class still supplies the
          padding/flex rhythm; we only drop its `border-top` hairline so the
          composer reads as part of the conversation surface, not a docked
          panel. */}
      <div
        className="p-dock"
        style={{
          borderTop: "none",
          // A docked choice/multi question — the plan-paused banner — or the
          // `/resume` picker fuses onto the composer as one panel; drop the
          // dock's flex gap so they meet on a single hairline. (A non-empty
          // queue sits between them, so only fuse when it's empty.)
          gap: fuseQuestion || fusePlan || fuseResume ? 0 : undefined,
        }}
      >
        {/* A lone free-text question gets the roomy `QuestionInputOverlay`;
            choice / multi-choice — and any clubbed SET — keep the
            keyboard/click-driven `QuestionCard`. When the queue is empty the
            card fuses onto the composer below it. The `key` is the question's
            tool_use_id so a fresh set after answering one remounts with clean
            per-question state instead of reusing the prior answers. */}
        {session.pending_question &&
          (!questionIsSet && session.pending_question.kind === "text" ? (
            <QuestionInputOverlay
              sessionId={session.id}
              question={session.pending_question}
              onError={setError}
              onAnswered={onQuestionAnswered}
            />
          ) : (
            <QuestionCard
              key={session.pending_question.tool_use_id}
              sessionId={session.id}
              question={session.pending_question}
              docked={fuseQuestion}
              onError={setError}
              onAnswered={onQuestionAnswered}
            />
          ))}
        {/* Brain paused on plan decision. The composer stays interactive
            — sending a message starts a fresh turn — but the user often
            reads "no agent reply" as "input is broken". This hint
            clarifies what's happening and points at the resolution. */}
        {session.pending_plan && !session.pending_question && (
          <div
            className={`flex items-center gap-2 px-3 py-1.5 t-xs ${
              fusePlan ? "" : "mb-1"
            }`}
            style={{
              background:
                "color-mix(in srgb, var(--color-accent) 8%, var(--color-bg-card))",
              border:
                "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)",
              // When fused, the banner becomes the composer's header strip:
              // round only the top, drop the seam border so it meets the
              // composer (which squares its own top via .composer-docked) on
              // one hairline — one stacked panel, no floating gap.
              borderRadius: fusePlan
                ? "var(--radius-sm) var(--radius-sm) 0 0"
                : "var(--radius-sm)",
              borderBottom: fusePlan ? "none" : undefined,
              color: "var(--color-text-2)",
            }}
          >
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: "var(--color-accent)" }}
            />
            <span className="flex-1">
              Brain paused on plan decision. Build or Cancel to continue, or
              send a new message to start a fresh turn.
            </span>
            {/* Always-present escape hatch: even if the inline plan chip
                scrolled out of view, this opens the plan in its own tab so
                the user can never "lose" a proposed plan. */}
            <button
              type="button"
              onClick={() => {
                const plan = session.pending_plan;
                if (!plan) return;
                openPlanWizard(
                  pendingPlanToTabInput(plan),
                  resolvedRepoRoot,
                  session.id,
                );
              }}
              className="shrink-0 t-2xs t-ui px-2 py-0.5 transition-opacity hover:opacity-80"
              style={{
                color: "var(--color-accent)",
                border:
                  "1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)",
                borderRadius: "var(--radius-xs)",
              }}
            >
              Open plan
            </button>
          </div>
        )}
        {/* `/resume` picker — a compact action panel docked flush above the
            composer (fused into one unit when nothing sits between them),
            instead of a bulky card floating mid-stream. */}
        {dockedResume?.interactive?.kind === "resume" && (
          <ResumePicker
            sessions={dockedResume.interactive.sessions}
            docked={fuseResume}
            onPick={(row) => {
              if (row.agentId && row.agentSessionId) {
                // A Claude Code thread — import it into a fresh native Aura
                // chat (transcript and all) before opening, the same path the
                // header history dropdown uses. On failure, fall back to the
                // history dropdown so there's always a way back.
                const root = resolvedRepoRoot;
                if (root) {
                  void api
                    .managerImportAgentSession(row.agentId, root, row.agentSessionId)
                    .then((newSid) => openManagerSession(newSid, row.title))
                    .catch(() =>
                      window.dispatchEvent(
                        new CustomEvent("aura:manager:open-history"),
                      ),
                    );
                }
              } else {
                openManagerSession(row.id, row.title);
              }
              // The picker did its job — drop it so a resumed-away thread
              // doesn't leave a stale list behind in this conversation.
              setSlashLog((prev) =>
                prev.filter((s) => s.at !== dockedResume.at),
              );
            }}
            onDismiss={() =>
              setSlashLog((prev) =>
                prev.filter((s) => s.at !== dockedResume.at),
              )
            }
          />
        )}
        <ManagerQueueStack
          queue={queue}
          busy={busy}
          onRemove={removeQueued}
          onEdit={editQueued}
          onPromote={promoteQueued}
          onMove={moveQueued}
          onClear={clearQueue}
        />
        {/* Live Crew telemetry — a collapsible strip showing the autonomous
            work-loop's agents (working now / just landed + proof / failed),
            the way Claude Code surfaces its sub-agents. Renders nothing when no
            agent is working and nothing is queued, so it never adds chrome. */}
        {crewSpawning && (
          <div className="px-1 pb-1">
            <PlanningStatusLine label="Spinning up the crew" />
          </div>
        )}
        <CrewComposerBlock
          repoRoot={resolvedRepoRoot}
          onActiveChange={onCrewActiveChange}
        />
        {/* Docked in-flight strip — the live "Running … · 12s" status, pinned
            flush atop the composer (squared bottom + negative margin closes the
            dock's 6px gap) so it reads as one unit with the input while the
            turn runs, then collapses away the moment it finishes. */}
        {runningTool && <RunningCommandStatus tool={runningTool} docked />}
        <ManagerComposer
          repoRoot={resolvedRepoRoot}
          workspaceLabel={session.projects[0]?.label}
          // Square the composer's top so the docked running strip (which rounds
          // only its top) meets it on a single hairline — one stacked unit, no
          // floating gap — exactly as the question/plan/resume banners fuse.
          docked={fuseQuestion || fusePlan || fuseResume || !!runningTool}
          busy={busy}
          usage={usage}
          pipeTargets={pipeTargets}
          sessionId={session.id}
          onBrainOverrideChange={setBrainOverride}
          modelOverride={modelOverride}
          onModelOverrideChange={setModelOverride}
          onSend={(msg, attachments, mode, pipeTo, effort, fast, approval) =>
            void send(msg, attachments, mode, pipeTo, effort, fast, approval)
          }
          onQueue={(msg, attachments, mode, pipeTo, effort, fast, approval) =>
            enqueue(msg, attachments, mode, pipeTo, effort, fast, approval)
          }
          onStop={() => {
            // Stop is not a clean turn-end — mark it so the queue does NOT
            // drain the next message (the bug was Stop advancing the queue
            // instead of halting). The queue itself is preserved, not cleared.
            lastExitRef.current = "stop";
            // #294 — preserve what already printed. The native path's
            // backend Drop guard persists the partial turn and emits
            // End{interrupted}, whose handler retires the live blocks AND
            // drops an "Interrupted" marker — so we must NOT wipe
            // streamBlocks here (that's what made printed output vanish).
            // The legacy path has no such guard, so we keep its old reset.
            // Explicit user Stop — retire the in-flight marker on both paths
            // (the interrupted End may arrive after the surface is already
            // gone, so don't rely on the chunk handler alone to clear it).
            clearManagerTurnInFlight(session.id);
            if (inflightNativeRef.current) {
              void api.brainChatCancel(session.id).catch(() => {});
              setBusy(false);
            } else {
              void api.managerCancel(session.id).catch(() => {});
              setBusy(false);
              setStreamBlocks([]);
            }
          }}
        />
      </div>
    </div>
    </ChatRepoRootContext.Provider>
  );
}



// ── Stream-block accumulators ────────────────────────────────────────────

function upsertText(blocks: StreamBlock[], idx: number, text: string): StreamBlock[] {
  const i = blocks.findIndex((b) => b.kind === "text" && b.block_idx === idx);
  if (i >= 0) {
    const next = blocks.slice();
    const cur = next[i]!;
    if (cur.kind === "text") {
      next[i] = { ...cur, text: cur.text + text };
    }
    return next;
  }
  const added: StreamBlock = { kind: "text", block_idx: idx, text };
  return [...blocks, added].sort((a, b) => a.block_idx - b.block_idx);
}

// Reasoning blocks accumulate exactly like text, but keyed to their own
// block_idx so the model's chain-of-thought renders as a separate collapsible
// disclosure above the answer (never interleaved into answer prose).
function upsertReasoning(blocks: StreamBlock[], idx: number, text: string): StreamBlock[] {
  const i = blocks.findIndex((b) => b.kind === "reasoning" && b.block_idx === idx);
  if (i >= 0) {
    const next = blocks.slice();
    const cur = next[i]!;
    if (cur.kind === "reasoning") {
      next[i] = { ...cur, text: cur.text + text };
    }
    return next;
  }
  const added: StreamBlock = { kind: "reasoning", block_idx: idx, text };
  return [...blocks, added].sort((a, b) => a.block_idx - b.block_idx);
}

function upsertTool(blocks: StreamBlock[], tool: StreamBlock & { kind: "tool" }): StreamBlock[] {
  const i = blocks.findIndex((b) => b.kind === "tool" && b.block_idx === tool.block_idx);
  if (i >= 0) {
    const next = blocks.slice();
    next[i] = { ...tool, result: (next[i] as typeof tool).result };
    return next;
  }
  return [...blocks, tool].sort((a, b) => a.block_idx - b.block_idx);
}

function attachResult(
  blocks: StreamBlock[],
  tool_use_id: string,
  result: { is_error: boolean; content: string },
): StreamBlock[] {
  const i = blocks.findIndex((b) => b.kind === "tool" && b.tool_use_id === tool_use_id);
  if (i < 0) return blocks;
  const next = blocks.slice();
  const cur = next[i]!;
  if (cur.kind === "tool") {
    next[i] = { ...cur, result };
  }
  return next;
}



// ── Live running-command status (#3) ─────────────────────────────────────
//
// The in-flight tool card above shows WHICH command is running; this adds the
// live feedback it lacked — a spinner + a 1s-ticking elapsed timer so a slow
// command (e.g. `aura propose-plan`) visibly keeps working instead of sitting
// as a static line that reads as hung. In-flight uses the amber `--color-warn`
// token (green is reserved for the "done" state in this chat scope); the timer
// is a small `setInterval` that resets whenever the running command changes and
// tears down when nothing is in flight.
//
// True live STDOUT is intentionally NOT shown: neither stream channel
// (`manager-stream` / `manager-chat-chunk`) carries incremental tool output —
// the `tool_result` only lands once, AFTER the command finishes — so the front
// end has no partial output to render. Surfacing it would require a backend
// `ToolProgress`/`ChatChunk::ToolStdout` streaming field; until that exists this
// is the honest quick win on the data we already have. Never fake output.

type RunningToolBlock = StreamBlock & { kind: "tool" };

/** Friendly one-line label for the running command — the full shell command
 *  when the registry extracted one (so `Running aura propose-plan` reads as the
 *  real command), else the verb + subject ("Running propose-plan"). Falls back
 *  to a bare "Running" so the row is never blank. */
function runningLabel(tool: RunningToolBlock): { verb: string; detail: string | null; mono: boolean } {
  const view = describeTool(tool.name, tool.input, undefined);
  if (view.command) {
    return { verb: "Running", detail: view.command, mono: true };
  }
  const detail = view.subject ?? null;
  // The registry verb is present-continuous ("Running" / "Reading"); keep it as
  // the live verb so the row reads as in-flight.
  return { verb: view.verb || "Running", detail, mono: !!view.mono };
}

// `docked` mode renders the strip flush atop the composer (squared bottom, no
// bottom seam, negative margin to close the dock's 6px gap) so it reads as part
// of the composer chrome rather than a loose card mid-stream. The default
// (undocked) variant is kept for any in-stream callers and is what the strip
// looked like before it was docked.
function RunningCommandStatus({
  tool,
  docked = false,
}: {
  tool: RunningToolBlock;
  docked?: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);
  // Reset + restart the timer whenever the running command changes (its
  // tool_use_id is the identity). The interval ticks once a second and tears
  // down on unmount / when the running tool swaps — never left dangling.
  useEffect(() => {
    const start = Date.now();
    setElapsed(0);
    const iv = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => window.clearInterval(iv);
  }, [tool.tool_use_id]);

  const { verb, detail, mono } = runningLabel(tool);
  // In-flight amber. `--color-warn` is the warning token; the codebase pairs it
  // with the warm-amber hex fallback (#d9920a — same as the PlanCard "Building…"
  // status) since not every theme defines the var, so the running state always
  // reads amber rather than falling back to ink.
  const warn = "var(--color-warn, #d9920a)";
  return (
    <div
      className={
        docked
          ? // Composer-chrome strip: full reading-column width, squared bottom
            // corners + no bottom border, and a -6px bottom margin so it sits
            // directly on the composer card with no dock gap between them.
            "flex items-center gap-2 px-3 py-1.5 w-full"
          : "flex items-center gap-2 px-2.5 py-1.5 mt-1.5 w-full max-w-[680px]"
      }
      style={
        docked
          ? {
              background: `color-mix(in srgb, ${warn} 8%, var(--color-bg-card))`,
              border: `1px solid color-mix(in srgb, ${warn} 30%, transparent)`,
              borderBottom: "none",
              borderRadius: "var(--radius-sm) var(--radius-sm) 0 0",
              marginBottom: -6,
            }
          : {
              background: `color-mix(in srgb, ${warn} 8%, var(--color-bg-card))`,
              border: `1px solid color-mix(in srgb, ${warn} 30%, transparent)`,
              borderRadius: "var(--radius-sm)",
            }
      }
      role="status"
      aria-live="polite"
    >
      {/* Spinner — a 1.5px ring with a transparent top, the same in-flight
          glyph the WaveStatusPip uses, tinted amber for "running". */}
      <span
        aria-hidden
        className="shrink-0 inline-block"
        style={{
          width: 12,
          height: 12,
          borderRadius: "50%",
          border: `1.5px solid ${warn}`,
          borderTopColor: "transparent",
          animation: "aura-chat-spin 0.9s linear infinite",
        }}
      />
      <span
        className="t-2xs t-ui shrink-0"
        style={{ color: warn, fontWeight: 600 }}
      >
        {verb}
      </span>
      {detail && (
        <span
          className={`t-xs min-w-0 truncate ${mono ? "font-mono" : ""}`}
          style={{ color: "var(--color-text-2)" }}
          title={detail}
        >
          {detail}
        </span>
      )}
      {/* Live elapsed — ticks every second so a long run visibly keeps
          working. Hidden under 1s so it never flashes "0s". */}
      {elapsed >= 1 && (
        <span
          className="ml-auto shrink-0 tabular-nums t-2xs"
          style={{ color: "var(--color-text-3)", fontFamily: "var(--font-mono)" }}
        >
          {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${(elapsed % 60).toString().padStart(2, "0")}s`}
        </span>
      )}
    </div>
  );
}



// ── Interactive plan card ───────────────────────────────────────────────
//
// Rendered whenever `session.pending_plan` is set. Backed by the persisted
// plan on the session so it survives reload mid-decision. Clicking Build
// or Cancel routes to `managerDecidePlan` which resolves the bridge
// waiter — the CLI brain (claude/gemini/etc) that's blocked inside
// `aura propose-plan` wakes up with the verb, then either fans out
// subagents (Build) or backs off and asks the user a follow-up (Cancel).

function PlanCard({
  sessionId,
  plan,
  onError,
  onBuildStart,
  grouped = false,
  repoRoot,
}: {
  sessionId: string;
  plan: PendingPlan;
  onError: (msg: string) => void;
  /** Fires the instant Build is pressed (before the backend round-trip) so the
   *  parent can show an immediate "Spinning up the crew…" line and close the
   *  silent gap before the live crew strip appears. */
  onBuildStart?: () => void;
  /** Inline-in-scroll mode: when prev author was the same agent, hide
   *  the avatar gutter. */
  grouped?: boolean;
  repoRoot?: string | null;
}) {
  const [submitting, setSubmitting] = useState<"build" | "cancel" | null>(null);
  // Bucket N3 — opt-in team broadcast on Build. Default off so the
  // common single-developer case stays quiet. When set, the backend
  // fires `aura msg send "Plan built: <title> (<plan_task_id>)"` after
  // the build kicks off.
  const [notifyTeam, setNotifyTeam] = useState(false);
  // Bucket D — Auto / Parallel / Serial picker. `Auto` (default)
  // honours the existing zone-overlap heuristic. `Parallel` opts the
  // user into concurrent worktrees racing the same files. `Serial`
  // forces strict one-at-a-time even when zones are disjoint.
  const [parallelism, setParallelism] = useState<PlanParallelism>(
    plan.parallelism ?? "auto",
  );
  // Inventory blocker #3 — local approval overlay so the row updates
  // instantly on click. Backend persists + emits a fresh snapshot which
  // will overwrite this, but the optimistic state covers the round-trip
  // window. `null` means "fall back to whatever's on the persisted plan".
  const [approvalOverlay, setApprovalOverlay] = useState<{
    approved_by: string;
    approved_at: number;
  } | null>(null);
  const [approving, setApproving] = useState(false);
  const approvedBy = approvalOverlay?.approved_by ?? plan.approved_by ?? null;
  const approvedAt = approvalOverlay?.approved_at ?? plan.approved_at ?? null;

  const decide = useCallback(
    async (decision: "build" | "cancel") => {
      if (submitting) return;
      setSubmitting(decision);
      // Optimistic hand-off: the moment Build is pressed, ask the parent to
      // show "Spinning up the crew…" so the chat never goes silent during the
      // spawn. Cancel doesn't spawn anything, so it stays quiet.
      if (decision === "build") onBuildStart?.();
      try {
        await api.managerDecidePlan(
          sessionId,
          plan.id,
          decision,
          decision === "build" ? notifyTeam : false,
          decision === "build" ? parallelism : undefined,
        );
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
        setSubmitting(null);
      }
    },
    [submitting, sessionId, plan.id, onError, onBuildStart, notifyTeam, parallelism],
  );

  // "Open plan" → the proper fullscreen wizard overlay (Document / Tasks),
  // not a workpane tab. The user reviews the full design doc + breakdown in
  // focus, then Builds or Cancels from the overlay's top-bar cluster.
  const openAsTab = useCallback(() => {
    openPlanWizard(pendingPlanToTabInput(plan), repoRoot ?? null, sessionId);
  }, [plan, repoRoot, sessionId]);

  // Inventory blocker #3 — Approve handler. Resolves the current user's
  // effective identity (per-repo git identity overlay, fallback to the
  // global device identity), stamps the pending plan, and overlays the
  // result locally so the row updates without waiting for the next
  // session snapshot. Display-name beats email when both are set; if
  // neither is set we fall back to "you" rather than a blank handle so
  // the audit row is never empty.
  const approve = useCallback(async () => {
    if (approving || approvedBy) return;
    setApproving(true);
    try {
      let handle = "you";
      try {
        const identity = repoRoot
          ? await api.deviceIdentityForRepo(repoRoot)
          : await api.deviceIdentity();
        const name = identity.display_name?.trim();
        const email = identity.email?.trim();
        handle = name || email || "you";
      } catch {
        // Fall back to "you" — better than blocking approval if the
        // identity lookup transiently fails (cloud down, repo without
        // a git user.* set, etc).
      }
      const stamp = await api.managerApprovePlan(sessionId, plan.id, handle);
      setApprovalOverlay(stamp);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(false);
    }
  }, [approving, approvedBy, repoRoot, sessionId, plan.id, onError]);

  // Keyboard shortcuts: Enter = Build, Esc = Cancel. Only when focus is
  // not in an input/textarea (so the chat composer keeps its own Enter).
  useEffect(() => {
    if (submitting) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void decide("build");
      } else if (e.key === "Escape") {
        e.preventDefault();
        void decide("cancel");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [plan.id, submitting, decide]);

  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!optionsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (optionsRef.current && !optionsRef.current.contains(e.target as Node)) {
        setOptionsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [optionsOpen]);

  const description = plan.summary?.trim() || plan.objective?.trim() || "";
  const phaseCount = plan.phases?.length ?? 0;
  const stepCount = plan.todos.length;
  // Compact one-line meta: "6 phases · 8 steps". Omit a count when zero so
  // a phases-only or steps-only plan doesn't read "0 phases".
  const metaLine = [
    phaseCount > 0 ? `${phaseCount} phase${phaseCount === 1 ? "" : "s"}` : null,
    stepCount > 0 ? `${stepCount} step${stepCount === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // Live status the inline chip carries (Antigravity-style "waiting for the
  // update"): the plan sits "Awaiting review" until the user acts, flips to
  // "Building…/Cancelling…" the instant they decide, and reads "Approved"
  // once stamped. `amber` = in-flight, `accent` = ready, `muted` = winding
  // down. The chip is the surface; clicking it opens the full Plan tab.
  const status: { label: string; tone: "accent" | "amber" | "muted"; pulse: boolean } =
    submitting === "build"
      ? { label: "Building…", tone: "amber", pulse: true }
      : submitting === "cancel"
        ? { label: "Cancelling…", tone: "muted", pulse: true }
        : approvedBy
          ? { label: "Approved", tone: "accent", pulse: false }
          : { label: "Awaiting review", tone: "accent", pulse: true };
  const statusColor =
    status.tone === "amber"
      ? "var(--color-warn, #d9920a)"
      : status.tone === "muted"
        ? "var(--color-text-3)"
        : "var(--color-accent)";

  // Compact inline plan chip (Antigravity-style). The plan does NOT take
  // over the chat view — it surfaces as a single clickable strip in the
  // stream that carries a live status ("Awaiting review" → "Building…")
  // and, on click, opens the full Plan tab (phases, architecture, file
  // refs, todos). The footer keeps a primary Build + a chevron menu that
  // folds the secondary controls (Approve, parallelism, Notify team,
  // Cancel) so the resting card stays a chip, not a wall. The full
  // decision bar also lives on the Plan tab itself.
  return (
    <div
      className={`aura-block w-full flex flex-col overflow-hidden ${grouped ? "mt-1" : "mt-2"} mb-2`}
    >
      {/* The whole strip is the open-tab affordance. */}
      <button
        type="button"
        onClick={openAsTab}
        className="w-full text-left flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-[color-mix(in_srgb,var(--color-fg-soft)_4%,transparent)]"
        title="Open the full plan — phases, architecture, file refs — in its own tab"
      >
        <span
          className="flex items-center justify-center shrink-0 mt-[1px]"
          style={{
            width: 22,
            height: 22,
            background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
            color: "var(--color-accent)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          <ListTree size={13} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="aura-block-label">PLAN</span>
            <span
              className="inline-flex items-center gap-1 t-2xs t-ui"
              style={{ color: statusColor }}
            >
              <span
                className={`inline-block rounded-full ${status.pulse ? "animate-pulse" : ""}`}
                style={{ width: 5, height: 5, background: statusColor }}
              />
              {status.label}
            </span>
          </div>
          <div
            className="t-sm t-heading mt-0.5 truncate"
            style={{ color: "var(--color-text-1)" }}
          >
            {plan.title}
          </div>
          {description && (
            <div
              className="t-xs mt-0.5 line-clamp-1"
              style={{ color: "var(--color-text-2)" }}
            >
              {description}
            </div>
          )}
          {(metaLine || approvedBy) && (
            <div
              className="t-2xs mt-1 flex items-center gap-1.5 flex-wrap"
              style={{ color: "var(--color-text-3)", fontFamily: "var(--font-mono)" }}
            >
              {metaLine && <span>{metaLine}</span>}
              {metaLine && approvedBy && <span>·</span>}
              {approvedBy && (
                <span>
                  approved by @{approvedBy}
                  {approvedAt ? ` · ${formatRelativeApprovalTime(approvedAt)}` : ""}
                </span>
              )}
            </div>
          )}
        </div>
        <span
          className="shrink-0 self-center inline-flex items-center gap-1 t-2xs t-ui"
          style={{ color: "var(--color-accent)" }}
        >
          View plan
          <SquareArrowOutUpRight size={11} strokeWidth={2} />
        </span>
      </button>
      <div
        className="flex items-center justify-between gap-2 px-3 py-2 border-t"
        style={{ borderColor: "var(--color-line-soft)" }}
      >
        <span
          className="t-2xs"
          style={{
            color: "var(--color-text-3)",
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.04em",
          }}
        >
          ⏎ BUILD · ESC CANCEL
        </span>
        <div className="relative flex items-stretch" ref={optionsRef}>
          <button
            type="button"
            disabled={submitting !== null}
            onClick={() => void decide("build")}
            className="t-sm px-2.5 py-1 flex items-center disabled:opacity-50 transition-opacity"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-bg-0)",
              borderTopLeftRadius: "var(--radius-sm)",
              borderBottomLeftRadius: "var(--radius-sm)",
              fontWeight: 500,
            }}
          >
            {submitting === "build" ? "Building…" : "Build"}
            <kbd
              className="font-mono t-2xs ml-1.5"
              style={{
                background: "rgba(0,0,0,0.18)",
                color: "rgba(0,0,0,0.72)",
                padding: "1px 4px",
                borderRadius: "var(--radius-xs)",
              }}
            >
              ⌘⏎
            </kbd>
          </button>
          <button
            type="button"
            disabled={submitting !== null}
            onClick={() => setOptionsOpen((v) => !v)}
            aria-label="Plan options"
            className="px-1.5 flex items-center disabled:opacity-50 transition-opacity"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-bg-0)",
              borderTopRightRadius: "var(--radius-sm)",
              borderBottomRightRadius: "var(--radius-sm)",
              borderLeft: "1px solid rgba(0,0,0,0.18)",
            }}
          >
            <ChevronDown size={12} strokeWidth={2} />
          </button>
          {optionsOpen && (
            <div
              className="absolute right-0 z-20 flex flex-col py-1"
              style={{
                top: "calc(100% + 4px)",
                minWidth: 220,
                background: "var(--color-bg-1)",
                border: "1px solid var(--color-line)",
                borderRadius: "var(--radius-md)",
                boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
              }}
            >
              {/* Approve — stamp the plan with the user's handle without
                  building. Hidden once stamped so the menu stays tidy. */}
              {!approvedBy && (
                <button
                  type="button"
                  disabled={approving || submitting !== null}
                  onClick={() => {
                    setOptionsOpen(false);
                    void approve();
                  }}
                  className="px-3 py-1.5 t-sm text-left disabled:opacity-50 transition-colors hover:bg-[color-mix(in_srgb,var(--color-fg-soft)_6%,transparent)]"
                  style={{ color: "var(--color-text-2)" }}
                  title="Stamp this plan with your handle + timestamp. Persists across reload; does not Build."
                >
                  {approving ? "Approving…" : "Approve plan"}
                </button>
              )}
              {/* Parallelism — Auto / Parallel / Serial dispatch mode. */}
              <div className="px-3 pt-1.5 pb-1">
                <div
                  className="t-2xs t-ui mb-1"
                  style={{ color: "var(--color-text-3)" }}
                >
                  Parallelism
                </div>
                <ParallelismControl
                  value={parallelism}
                  onChange={setParallelism}
                  disabled={submitting !== null}
                />
              </div>
              <label
                className="px-3 py-1.5 t-sm flex items-center gap-2 select-none cursor-pointer hover:bg-[color-mix(in_srgb,var(--color-fg-soft)_6%,transparent)]"
                style={{ color: "var(--color-text-2)" }}
                title="Send 'Plan built: <title>' to your team via aura msg when this kicks off."
              >
                <input
                  type="checkbox"
                  checked={notifyTeam}
                  onChange={(e) => setNotifyTeam(e.target.checked)}
                  disabled={submitting !== null}
                  className="cursor-pointer"
                />
                Notify team
              </label>
              <div
                className="my-1"
                style={{ borderTop: "1px solid var(--color-line)" }}
              />
              <button
                type="button"
                disabled={submitting !== null}
                onClick={() => {
                  setOptionsOpen(false);
                  void decide("cancel");
                }}
                className="px-3 py-1.5 t-sm text-left disabled:opacity-50 transition-colors hover:bg-[color-mix(in_srgb,var(--color-fg-soft)_6%,transparent)]"
                style={{ color: "var(--color-text-2)" }}
              >
                {submitting === "cancel" ? "Cancelling…" : "Cancel plan"}
                <kbd
                  className="font-mono t-2xs ml-1.5"
                  style={{
                    background: "var(--color-bg-2)",
                    color: "var(--color-text-3)",
                    padding: "1px 4px",
                    borderRadius: "var(--radius-xs)",
                  }}
                >
                  esc
                </kbd>
              </button>
            </div>
          )}
        </div>
      </div>
      {/* v0.2.31 LL.1 — Orchestrator Mode lives inside the PlanCard so the
          user can fan out specialist lanes (one Brain per lane, isolated
          context) without leaving the plan surface. Collapsed by default. */}
      <PlanOrchestratorSection plan={plan} repoRoot={repoRoot ?? null} />
    </div>
  );
}

/// v0.2.31 LL.1 — collapsible Orchestrator section on the PlanCard.
/// Maps the plan's todos to LaneSpec entries (one lane per todo) and
/// delegates to `<WaveDispatchPanel>` for the actual fan-out. Lives
/// alongside the legacy Build button — operators choose Build for the
/// single-agent path or expand Orchestrator for manager-of-managers.
function PlanOrchestratorSection({
  plan,
  repoRoot,
}: {
  plan: PendingPlan;
  repoRoot: string | null;
}) {
  const [open, setOpen] = useState(false);
  const laneCount = plan.todos?.length ?? 0;
  return (
    <div
      className="border-t"
      style={{ borderColor: "var(--color-line-soft)" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-1.5 flex items-center justify-between t-2xs"
        style={{
          color: "var(--color-text-3)",
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.04em",
          background: open ? "var(--color-bg-1)" : "transparent",
        }}
      >
        <span>
          [ ORCHESTRATOR ] {laneCount} LANE{laneCount === 1 ? "" : "S"}
        </span>
        <ChevronDown
          size={12}
          style={{ transform: open ? "rotate(180deg)" : "none" }}
        />
      </button>
      {open && (
        <div className="px-3 py-2">
          <WaveDispatchPanel plan={plan} repoRoot={repoRoot} />
        </div>
      )}
    </div>
  );
}

/// Bucket D — segmented control on the PlanCard footer. Three modes:
/// Auto (current zone-overlap heuristic), Parallel (ignore overlaps,
/// concurrent worktrees), Serial (one task at a time, even disjoint).
/// The brain's per-todo agent picks still apply on top — this is just
/// the dispatch-tick behaviour at the session level.
function ParallelismControl({
  value,
  onChange,
  disabled,
}: {
  value: PlanParallelism;
  onChange: (v: PlanParallelism) => void;
  disabled?: boolean;
}) {
  const options: { id: PlanParallelism; label: string; title: string }[] = [
    { id: "auto", label: "Auto", title: "Skip dispatch when zones overlap (current behaviour)." },
    { id: "parallel", label: "Parallel", title: "Race overlapping zones in concurrent parallel copies — accept merge risk for wall-clock." },
    { id: "serial", label: "Serial", title: "One task at a time, even when zones are disjoint." },
  ];
  return (
    <div
      className="flex items-stretch overflow-hidden text-xs"
      style={{
        border: "1px solid var(--color-line)",
        borderRadius: "var(--radius-sm)",
      }}
      role="group"
      aria-label="Plan parallelism"
    >
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.id)}
            title={opt.title}
            className="px-2 py-0.5 t-2xs t-ui transition-colors disabled:opacity-50"
            style={{
              background: active ? "var(--color-accent)" : "transparent",
              color: active ? "var(--color-bg-0)" : "var(--color-text-2)",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// PendingPlan from the wire is snake_case (mirrors the Rust struct);
// `editor.openPlan` expects camelCase. Centralizing the conversion here
// keeps the auto-open path and the manual "Open" click producing the
// exact same PlanTab shape — Cursor parity stays consistent regardless
// of how the user reached it.
function pendingPlanToTabInput(plan: PendingPlan) {
  return {
    id: plan.id,
    title: plan.title,
    summary: plan.summary,
    objective: plan.objective,
    baseline: plan.baseline,
    architectureMermaid: plan.architecture_mermaid,
    phases: plan.phases?.map((p) => ({
      title: p.title,
      body: p.body,
      fileRefs: p.file_refs ?? [],
    })),
    deliverables: plan.deliverables,
    tests: plan.tests,
    pendingPlanId: plan.id,
    todos: plan.todos.map((t) => ({
      description: t.description,
      agent: t.agent ?? null,
      fileRefs: t.file_refs,
      assignee: t.assignee ?? null,
      suggestedProvider: t.suggested_provider
        ? {
            providerId: t.suggested_provider.provider_id,
            score: t.suggested_provider.score,
            sampleCount: t.suggested_provider.sample_count,
          }
        : null,
      goal: t.goal ?? null,
      acceptance: t.acceptance ?? [],
      subtasks: t.subtasks?.map((s) => ({
        description: s.description,
        agent: s.agent ?? null,
        goal: s.goal ?? null,
        acceptance: s.acceptance ?? [],
      })),
    })),
  };
}


// ── Persisted bubbles + system lines ────────────────────────────────────

function SystemLine({ text, tone }: { text: string; tone: "info" | "warn" | "ok" }) {
  const cls = tone === "warn" ? "system-line warn" : tone === "ok" ? "system-line ok" : "system-line";
  return (
    <div className={cls}>
      <span style={{ opacity: 0.7 }}>— </span>
      {text}
    </div>
  );
}

// A slash-command result (`/help`, `/loop`, `/agents`, …) — a full markdown
// document, rendered through the chat's own MarkdownBody so lists, bold, code
// and clickable file/symbol chips all land. It reads like any normal message:
// NO box, NO border, NO "Aura" masthead — the slash the user typed already
// echoes as their own bubble just above, so the result needs no header. A
// `warn`/`ok` result keeps a single quiet leading glyph in the tone colour as
// a subtle signal; the default `info` tone gets no chrome at all.
function SystemCard({ text, tone }: { text: string; tone: "info" | "warn" | "ok" }) {
  if (tone === "info") {
    return (
      <div className="my-1.5">
        <MarkdownBody source={text} />
      </div>
    );
  }
  const accent =
    tone === "warn"
      ? "var(--color-accent-amber, rgb(251 191 36))"
      : "var(--color-accent-green)";
  const Glyph = tone === "warn" ? AlertTriangle : Check;
  return (
    <div className="my-1.5 flex items-start gap-1.5">
      <Glyph size={13} className="mt-[3px] shrink-0" style={{ color: accent }} />
      <div className="min-w-0 flex-1">
        <MarkdownBody source={text} />
      </div>
    </div>
  );
}

// A designed mode-switch notice (Auto → Plan). It replaces a flat italic
// markdown run that read as one unbroken wall of prose — here it's a compact
// card: an accent glyph, a "Plan mode" headline, a body line that wraps with
// real leading, and a muted footnote. Calm, not bulky. The accent is the
// chat-scoped `--color-accent` (the same green as the Plan mode chip), so the
// notice visually ties to the chip the user flips back from.
function PlanModeNotice() {
  return (
    <div
      className="my-2 flex items-start gap-2.5 rounded-md border px-3 py-2.5"
      style={{
        borderColor: "color-mix(in srgb, var(--color-accent) 26%, transparent)",
        borderLeftColor: "var(--color-accent)",
        borderLeftWidth: "2px",
        background: "color-mix(in srgb, var(--color-accent) 6%, transparent)",
      }}
    >
      <span
        className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded"
        style={{
          background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
          color: "var(--color-accent)",
        }}
      >
        <ListTree size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <div
          className="text-[13px] font-semibold leading-5"
          style={{ color: "var(--color-text-1)" }}
        >
          Plan mode
        </div>
        <p
          className="mt-0.5 text-[12.5px] leading-relaxed"
          style={{ color: "var(--color-text-2)" }}
        >
          You asked for a plan, so I&rsquo;ll lay one out first instead of
          building straight away. Review it, then hit{" "}
          <strong style={{ color: "var(--color-text-1)", fontWeight: 600 }}>
            Build
          </strong>{" "}
          to run it.
        </p>
        <p
          className="mt-1 text-[11.5px] leading-snug"
          style={{ color: "var(--color-text-3)" }}
        >
          Switch back to Auto from the mode chip anytime.
        </p>
      </div>
    </div>
  );
}

// ── Resume picker ───────────────────────────────────────────────────
//
// `/resume` is an ACTION command, not an informational one: instead of
// dumping a markdown list and telling you to "open one from the Sessions
// list", it renders these live, clickable rows. Picking a row actually
// reopens that conversation (openManagerSession), so the command does the
// thing it names. Calm rows in the QuestionCard idiom — bg-1, hover bg-2,
// a quiet subtitle (progress · when) and an arctic-blue chevron that
// brightens on hover. Ephemeral by design: the picker is not persisted to
// chat history (an action, not a record), so it never reappears stale on
// reload.
// Compact, composer-docked picker for an action slash command (`/resume`).
// Renders flush above the composer as one stacked panel (squared bottom, no
// seam) so it reads as composer chrome — not a bulky card floating mid-stream.
// One-line rows: glyph · title · faint timestamp · chevron. `onDismiss` lets
// the user close it without resuming (drops the ephemeral slashLog entry).
function ResumePicker({
  sessions,
  docked,
  onPick,
  onDismiss,
}: {
  sessions: SlashResumeRow[];
  docked?: boolean;
  onPick: (row: SlashResumeRow) => void;
  onDismiss?: () => void;
}) {
  return (
    <div
      className={`w-full flex flex-col overflow-hidden ${docked ? "" : "my-1.5"}`}
      style={{
        background: "var(--color-bg-1)",
        border: "1px solid var(--color-line)",
        // Docked: round only the top + drop the bottom seam so it fuses onto
        // the composer (which squares its own top) as one unit.
        borderRadius: docked
          ? "var(--radius-sm) var(--radius-sm) 0 0"
          : "var(--radius-md)",
        borderBottom: docked ? "none" : undefined,
      }}
    >
      <div
        className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 t-2xs t-ui"
        style={{ color: "var(--color-text-3)" }}
      >
        <Clock size={11} className="shrink-0" />
        <span className="flex-1">Resume a conversation</span>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 -my-0.5 p-0.5 transition-opacity hover:opacity-100 opacity-60"
            style={{ color: "var(--color-text-3)" }}
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div className="px-1.5 pb-1.5 flex flex-col gap-0.5">
        {sessions.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-label={`Resume ${s.title}`}
            onClick={() => onPick(s)}
            className="group flex items-center gap-2 px-2 py-1 text-left transition-colors"
            style={{ borderRadius: "var(--radius-xs)", background: "transparent" }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--color-bg-2)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            {/* A cross-agent row wears its agent's mark (so you can tell a
                Claude Code thread from a native Aura chat at a glance); a
                native chat keeps the neutral message glyph. */}
            {s.agentId ? (
              <AgentIcon agentId={s.agentId} size={13} />
            ) : (
              <MessageSquare
                size={12}
                className="shrink-0"
                style={{ color: "var(--color-text-3)" }}
              />
            )}
            <span
              className="t-sm truncate min-w-0"
              style={{ color: "var(--color-text-1)" }}
            >
              {s.title}
            </span>
            {/* Plain-language origin tag so it's unambiguous which kind of
                conversation each row is — the glyph alone isn't obvious to
                everyone. A quiet hairline badge, not a card. */}
            <span
              className="t-2xs shrink-0 rounded border px-1.5 py-px"
              style={{
                borderColor: "var(--color-line)",
                color: "var(--color-text-3)",
              }}
            >
              {s.kind === "claude-code" ? "Claude Code" : "Aura chat"}
            </span>
            <span className="flex-1 min-w-0" aria-hidden="true" />
            {s.subtitle && (
              <span
                className="t-2xs shrink-0 tabular-nums"
                style={{ color: "var(--color-text-3)" }}
              >
                {s.subtitle}
              </span>
            )}
            <ChevronRight
              size={13}
              className="shrink-0 transition-colors text-[var(--color-text-3)] group-hover:text-[var(--color-accent)]"
            />
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Settled Scout block ─────────────────────────────────────────────
//
// After Aura Scout finalizes, `pending_scout` clears and the live
// ScoutCard (proper Architecture / Security / UX rows) is gone. All the
// backend leaves behind are raw `Scout: spawning…` + `[security]/[arch]/
// [ux] …` system turns. These parsers + block re-present that residue as
// named agents with a status so the finalized review reads cleanly
// instead of as bracketed lowercase text.

type SettledSpecialistKind = "architecture" | "security" | "ux";

interface SettledSpecialist {
  kind: SettledSpecialistKind;
  label: string;
  body: string;
  status: "done" | "failed";
}

const SCOUT_KIND_LABEL: Record<SettledSpecialistKind, string> = {
  architecture: "Architecture",
  security: "Security",
  ux: "UX",
};

function isScoutSpawnLine(text: string): boolean {
  return /^\s*Scout:\s*spawning\b/i.test(text);
}

// Parse a persisted `[kind] body` specialist line. Accepts the backend's
// channel aliases (`arch`/`sec`) as well as full names. Returns null for
// anything that isn't a specialist line so the grouping pass leaves
// unrelated system turns untouched.
function parseScoutSpecialistLine(text: string): SettledSpecialist | null {
  const m = /^\s*\[(architecture|arch|security|sec|ux)\]\s*(.*)$/i.exec(text);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const kind: SettledSpecialistKind = raw.startsWith("arch")
    ? "architecture"
    : raw.startsWith("sec")
      ? "security"
      : "ux";
  const body = (m[2] ?? "").trim();
  // Treat any not-completed signal — timed out, errored, or a calm
  // "skipped" the backend now emits — as the non-done (Skipped) state.
  const status: SettledSpecialist["status"] =
    /time(?:d)?\s*out|timeout|failed|error|skip/i.test(body) ? "failed" : "done";
  return { kind, label: SCOUT_KIND_LABEL[kind], body, status };
}

// Settled plan-review pass — renders as the SAME compact tool-call row as
// the live ScoutCard (collapsed by default, expandable), not a bordered
// card. The collapsed row carries a plain-language summary; expanding it
// shows each reviewer's note. Skipped reviewers (claude missing / timed
// out) degrade quietly — no alarming "N timed out" shout.
function SettledScoutBlock({ specialists }: { specialists: SettledSpecialist[] }) {
  const [open, setOpen] = useState(false);
  const total = specialists.length;
  const reviewed = specialists.filter((s) => s.status === "done").length;
  // Plain-language trailing status. All-good → "N reviewers"; partial →
  // "N of M reviewers"; none → a calm "review skipped" (build proceeded).
  const reviewerStatus =
    reviewed === 0
      ? "review skipped"
      : reviewed === total
        ? `${total} reviewer${total === 1 ? "" : "s"}`
        : `${reviewed} of ${total} reviewers`;

  return (
    <div className="mt-1 mb-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="aura-tool-row"
        title={open ? "Collapse" : "Expand plan review"}
      >
        <span className="aura-tool-glyph">
          <span
            aria-hidden
            className="inline-block rounded-full"
            style={{
              width: 6,
              height: 6,
              background: "var(--color-text-4)",
            }}
          />
        </span>
        <span className="aura-tool-chip-verb">Reviewed the plan</span>
        <span
          className="aura-tool-chip-subject"
          style={{ color: "var(--color-text-3)" }}
        >
          {reviewerStatus}
        </span>
        <span className="ml-auto shrink-0" style={{ color: "var(--color-text-4)" }}>
          <ScoutChevron dir={open ? "up" : "down"} />
        </span>
      </button>
      {open && (
        <div className="aura-tool-substream">
          {specialists.map((s, i) => (
            <div key={`${s.kind}-${i}`} className="flex items-start gap-2.5 py-1">
              <span className="shrink-0 mt-[1px]">
                <AgentIcon agentId="claude" size={13} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className="t-sm font-medium"
                    style={{ color: "var(--color-text-1)" }}
                  >
                    {s.label}
                  </span>
                  <SpecialistStatusChip status={s.status} />
                </div>
                {s.status === "done" && s.body && (
                  <div
                    className="t-xs mt-0.5"
                    style={{ color: "var(--color-text-2)" }}
                  >
                    {s.body}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Inline chevron for the settled scout row — matches the live ScoutCard's.
function ScoutChevron({ dir }: { dir: "up" | "down" }) {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: dir === "up" ? "rotate(180deg)" : undefined,
        transition: "transform var(--motion-fast)",
      }}
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function SpecialistStatusChip({ status }: { status: SettledSpecialist["status"] }) {
  const failed = status === "failed";
  // Status colours only (green = ok, warning-amber = skipped). A skipped
  // reviewer reads as a calm "Skipped", never an alarming failure.
  const tone = failed
    ? "var(--color-warning, #d97706)"
    : "var(--color-success, #16a34a)";
  return (
    <span
      className="t-2xs t-ui px-1.5 py-0.5 shrink-0"
      style={{
        color: tone,
        border: `1px solid color-mix(in srgb, ${tone} 40%, transparent)`,
        borderRadius: "var(--radius-xs)",
      }}
    >
      {failed ? "Skipped" : "Reviewed"}
    </span>
  );
}

// Milestone divider — a centered rule with the caption inset, marking a
// major thing finished (a task done, a wave shipped). Antigravity adds one
// of these between phases of work so the timeline reads as discrete
// completed chapters rather than an unbroken scroll. A small check leads
// the caption to reinforce "this finished".
function MilestoneDivider({ text }: { text: string }) {
  return (
    <div className="aura-milestone" role="separator" aria-label={text}>
      <span className="aura-milestone-rule" aria-hidden />
      <span className="aura-milestone-label">
        <Check size={12} strokeWidth={2.5} />
        {text}
      </span>
      <span className="aura-milestone-rule" aria-hidden />
    </div>
  );
}

// Brain-handoff divider — drawn where the conversation carried over to a
// different brain mid-thread (Claude → Gemini → Kimi …). The backend rebuilds
// the full transcript for whichever brain runs the next turn
// (`chat_to_messages`), so the switch is genuinely seamless — this marker just
// makes that legible: "you swapped models here, and the thread came with it",
// reassuring the user (who switches when a provider's limits hit) that nothing
// was dropped. Carries the new brain's own logo so the handoff is scannable.
function BrainHandoffDivider({ brain, chat }: { brain: string; chat: ChatTurn[] }) {
  const [open, setOpen] = useState(false);
  const label = humanizeBrainId(brain);
  return (
    <>
      <div
        className="aura-milestone"
        role="separator"
        aria-label={`Continued on ${label}`}
      >
        <span className="aura-milestone-rule" aria-hidden />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="aura-milestone-label"
          aria-expanded={open}
          title={`The conversation carried over to ${label} — the full thread came with it. Click for session details.`}
          style={{ background: "transparent", border: 0, cursor: "pointer", font: "inherit" }}
        >
          <AgentIcon agentId={brainAgentId(brain)} size={12} />
          Continued on {label}
          <ChevronGlyph open={open} />
        </button>
        <span className="aura-milestone-rule" aria-hidden />
      </div>
      {open && <SessionBrainsDetail chat={chat} />}
    </>
  );
}

/** Tiny disclosure chevron for the handoff divider — currentColor so it
 *  inherits the divider's green ink; rotates when the session details open. */
function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: open ? "rotate(180deg)" : undefined,
        transition: "transform var(--motion-fast)",
      }}
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

// Time-gap divider — a wiggly rule flanking a relative-time caption, drawn
// where the conversation jumped forward in wall-clock time (a session
// cancelled / closed an hour back, then resumed). The wave (vs. the
// milestone's straight rule) reads as "time passed here", not "a thing
// finished". The rule is a tiling SVG sine wave faded at its inner edges.
function TimeGapDivider({ seconds }: { seconds: number }) {
  const label = humanizeGap(seconds);
  return (
    <div className="aura-timegap" role="separator" aria-label={label}>
      <span className="aura-timegap-rule" aria-hidden />
      <span className="aura-timegap-label">
        <Clock size={11} strokeWidth={2} />
        {label}
      </span>
      <span className="aura-timegap-rule" aria-hidden />
    </div>
  );
}

function ribbonAsSystem(entry: RibbonEntry): { text: string; tone: "info" | "warn" | "ok" } | null {
  const ev = entry.event;
  switch (ev.kind) {
    case "task_dispatched":
      return { text: `Sent task #${ev.task_id} to ${ev.agent_id}`, tone: "info" };
    case "task_completed":
      return ev.exit_code === 0
        ? { text: `Task #${ev.task_id} done`, tone: "ok" }
        : { text: `Task #${ev.task_id} exited with ${ev.exit_code}`, tone: "warn" };
    case "task_failed":
      return { text: `Task #${ev.task_id} failed: ${ev.error}`, tone: "warn" };
    case "zone_collision":
      return { text: `Stuck — zone claimed by ${ev.claimer}`, tone: "warn" };
    case "manual_override":
      return { text: `Override #${ev.task_id}: ${ev.mode}`, tone: "info" };
    case "rebase_conflict": {
      const head = `Task #${ev.task_id} rebase onto ${ev.onto_ref} hit conflicts`;
      const sample = ev.files.slice(0, 3).join(", ");
      const more = ev.files.length > 3 ? ` (+${ev.files.length - 3} more)` : "";
      return {
        text: sample ? `${head}: ${sample}${more}` : head,
        tone: "warn",
      };
    }
    case "semantic_alert": {
      const n = ev.deletions.length;
      const head = `— Aura: task #${ev.task_id} flagged ${n} function deletion${n === 1 ? "" : "s"}`;
      const sample = ev.deletions.slice(0, 3).join(", ");
      const more = ev.deletions.length > 3 ? ` (+${ev.deletions.length - 3} more)` : "";
      const detail = sample ? ` — ${sample}${more}` : "";
      const tail = ev.reason ? ` · ${ev.reason}` : "";
      return { text: `${head}${detail}${tail}. Review the worktree before merging.`, tone: "warn" };
    }
    case "paused":
      return { text: "Paused", tone: "info" };
    case "resumed":
      return { text: "Resumed", tone: "info" };
    case "cancelled":
      return { text: "Cancelled", tone: "warn" };
    case "plan_ready":
    case "manager_speech":
      return null;
  }
}

// #2 — cohesive assistant-turn group. A CLI-wrapper brain persists one
// logical reply as MANY contiguous `manager` turns; left ungrouped they read
// as N scattered "Claude" bubbles. This wraps a contiguous run in ONE block:
// a single agent header (AgentIcon + name) up top, then the member turns
// stacked beneath it. Each member's own answer prose + step roll-up still
// render through ChatBubble/TurnActivity — the group only adds the shared
// header + a quiet left rail so the run reads as one turn, not a pile.
//
// Reuses the existing `.aura-msg-who` header family (avatar + name) so the
// header matches the rest of the chat's tone; the rail is a faint hairline,
// tokens only — never a new color. The header brain is resolved from the
// first member that recorded one (falling back to the generic Aura mark).
function AssistantTurnGroup({
  headerBrain,
  children,
}: {
  headerBrain: string | null;
  children: ReactNode;
}) {
  const iconId = headerBrain ? brainAgentId(headerBrain) : "aura-manager";
  const name = headerBrain ? humanizeBrainId(headerBrain) : "Aura";
  return (
    <div className="mt-2 mb-2">
      <div className="aura-msg-who">
        <span className="aura-msg-av" aria-hidden>
          <AgentIcon agentId={iconId} size={14} />
        </span>
        <span className="name">{name || "Aura"}</span>
      </div>
      {/* Member turns stack flush under the shared header — no left rail.
          The header alone signals the group; a vertical hairline down the
          margin read as clutter (and as a stray "line" users asked to drop). */}
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

// Direct port of the prototype's `.user-bubble` and `.agent-text` —
// no avatars, no right-align, no accent tint. The bubble is a simple
// bordered box; the agent reply is plain prose.
//
// User turns that resolved a QuestionCard render as a paired Q+A block
// (Cursor parity): the originating question sits above the answer in
// the same bordered card, prefixed with a tiny "Q" label so the reader
// sees what the answer was answering even on reload.

// Compact token count for the "Saved ~" chip: one decimal + "k" at ≥1000
// (e.g. "1.2k"), the bare integer below it (e.g. "840").
function formatSavedTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

// User-attached images on a chat turn, rendered as inline thumbnails inside
// the bubble. The bytes are persisted base64 on the turn (the same copy the
// brain receives), so this re-renders correctly on reload. Clicking a
// thumbnail toggles it to full width so a small preview can be read in place.
// Renders nothing when the turn carried no images.
function ChatAttachmentThumbs({
  attachments,
}: {
  attachments?: ChatImageAttachment[] | null;
}) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {attachments.map((a, i) => (
        <AttachmentThumb key={i} att={a} />
      ))}
    </div>
  );
}

function AttachmentThumb({ att }: { att: ChatImageAttachment }) {
  const [full, setFull] = useState(false);
  const src = `data:${att.media_type};base64,${att.data_base64}`;
  return (
    <img
      src={src}
      alt={att.name ?? "attached image"}
      title={att.name ?? undefined}
      onClick={() => setFull((v) => !v)}
      className="rounded cursor-pointer border object-contain"
      style={{
        borderColor: "var(--color-line-soft)",
        maxHeight: full ? "none" : 160,
        maxWidth: "100%",
        width: full ? "100%" : "auto",
      }}
    />
  );
}

function ChatBubble({
  turn,
  chatIndex,
  busy,
  durationSec = null,
  inGroup = false,
  showActions = true,
  onEditResend,
  onFork,
}: {
  turn: ChatTurn;
  chatIndex?: number | null;
  busy?: boolean;
  /** Seconds the brain took to produce this turn (gap to the prompt it
   *  answered), or null when it can't be derived. Drives the persistent
   *  per-message action row's time-taken stat, Conductor-style. */
  durationSec?: number | null;
  /** This bubble is one segment of a cohesive AssistantTurnGroup (CLI-wrapper
   *  "one reply, N bubbles"). The group header already carries the brand, so
   *  drop the redundant per-message model chip from the action row. */
  inGroup?: boolean;
  /** Draw the action-row footer (copy / model / more). False for non-final
   *  segments of a group so the whole run reads as ONE message with one
   *  footer at the bottom, not N stamped bubbles. Defaults true (lone turns). */
  showActions?: boolean;
  onEditResend?: (
    chatIndex: number,
    newText: string,
    restoreCode: boolean,
  ) => Promise<void>;
  /** Branch the conversation from this turn — clone history up to here
   *  into a new session and open it as a tab or its own window. Wired to
   *  the "More" menu. Disabled when `chatIndex` is null (synthetic turns). */
  onFork?: (chatIndex: number, target: "tab" | "workspace") => void;
}) {
  const [editing, setEditing] = useState(false);
  const visibleText = turn.role === "user" ? stripModeDirective(turn.text) : turn.text;
  const [editText, setEditText] = useState(visibleText);
  const [restoreChoice, setRestoreChoice] = useState(false);
  const [copied, setCopied] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Experimental "Saved ~N tokens" chip — gated on the reactive settings flag.
  const { show_token_savings: showSavings } = useFlagPrefs();

  // Close the More menu on any outside click / Escape.
  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  // The seed-objective synthetic bubble has no chat[] entry — passing
  // chatIndex=null disables Edit. Q+A turns from the brain (answered_question)
  // are the resolution of a QuestionCard and should not be re-edited here
  // (re-asking would require resurrecting the card flow); they still get
  // a Copy hover affordance.
  const canEdit =
    turn.role === "user" &&
    chatIndex != null &&
    !turn.answered_question &&
    !busy &&
    !!onEditResend;

  // Fork is available on any turn that maps to a real chat[] entry (the
  // synthetic seed-objective bubble passes chatIndex=null) once a handler
  // is wired.
  const canFork = chatIndex != null && !!onFork;

  function fork(target: "tab" | "workspace") {
    setMoreOpen(false);
    if (chatIndex != null && onFork) onFork(chatIndex, target);
  }

  useEffect(() => {
    if (editing && taRef.current) {
      taRef.current.focus();
      const len = taRef.current.value.length;
      taRef.current.setSelectionRange(len, len);
      // auto-grow
      taRef.current.style.height = "auto";
      taRef.current.style.height = `${taRef.current.scrollHeight}px`;
    }
  }, [editing]);

  async function copyText() {
    try {
      await navigator.clipboard.writeText(visibleText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 900);
    } catch {
      /* clipboard denied */
    }
  }

  function startEdit() {
    setEditText(visibleText);
    setEditing(true);
    setRestoreChoice(false);
  }

  function cancelEdit() {
    setEditing(false);
    setRestoreChoice(false);
  }

  async function commit(restoreCode: boolean) {
    if (chatIndex == null || !onEditResend) return;
    const next = editText.trim();
    if (!next) return;
    setEditing(false);
    setRestoreChoice(false);
    await onEditResend(chatIndex, next, restoreCode);
  }

  // Editing surface — replaces the bubble body with a textarea. Enter
  // (without shift) opens the Restore-code-or-message confirm row; the
  // user picks one and the backend truncates / optionally reverts files
  // before re-running the brain.
  if (editing) {
    return (
      <div className="user-bubble flex flex-col gap-2">
        <textarea
          ref={taRef}
          value={editText}
          onChange={(e) => {
            setEditText(e.target.value);
            const ta = e.currentTarget;
            ta.style.height = "auto";
            ta.style.height = `${ta.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (editText.trim()) setRestoreChoice(true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            }
          }}
          className="w-full bg-transparent t-base outline-none resize-none"
          style={{ color: "var(--color-text-1)", minHeight: "3em" }}
        />
        {restoreChoice ? (
          <div
            className="flex flex-col gap-2 px-2 py-2 rounded"
            style={{
              background: "var(--color-bg-2)",
              border: "1px solid var(--color-line-soft)",
            }}
          >
            <div
              className="t-xs t-ui"
              style={{ color: "var(--color-text-2)" }}
            >
              Resend from this point. Also rewind project files to where
              they were when you sent this?
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancelEdit}
                className="t-xs t-ui px-2 py-1"
                style={{ color: "var(--color-text-3)" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void commit(false)}
                className="t-xs t-ui px-2.5 py-1 border"
                style={{
                  borderColor: "var(--color-line)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--color-text-1)",
                  background: "transparent",
                }}
                title="Drop chat from this point and resend; leave files alone"
              >
                Just message
              </button>
              <button
                type="button"
                onClick={() => void commit(true)}
                className="t-xs t-accent px-2.5 py-1"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-bg-0)",
                  borderRadius: "var(--radius-sm)",
                }}
                title="Drop chat AND revert files to their state at this turn"
              >
                Restore code
              </button>
            </div>
          </div>
        ) : (
          <div
            className="flex items-center justify-end gap-2 t-xs t-ui"
            style={{ color: "var(--color-text-3)" }}
          >
            <span>Enter to resend · Esc to cancel</span>
            <button
              type="button"
              onClick={cancelEdit}
              className="px-1.5 py-0.5 rounded hover:bg-bg-2"
              title="Cancel"
            >
              <X size={12} />
            </button>
            <button
              type="button"
              disabled={!editText.trim()}
              onClick={() => setRestoreChoice(true)}
              className="px-1.5 py-0.5 rounded hover:bg-bg-2 disabled:opacity-40"
              title="Resend"
            >
              <Check size={12} />
            </button>
          </div>
        )}
      </div>
    );
  }

  if (turn.role === "user") {
    // A compaction / handover summary arrives as a user-role turn by
    // transport (the harness injects it as a user message), but it is NOT
    // something the user said — it's carried-over context. Render it as a
    // collapsible contextual card, the same treatment Trace's transcript
    // gives it, instead of a wall-of-text user bubble.
    if (isHandoverSummary(turn.text)) {
      return <ChatHandoverCard text={turn.text} />;
    }
    if (turn.answered_question) {
      // Header (question) + body (answer) card. No "Q" / "A" letter
      // glyphs — the layout itself signals which is which: the muted
      // top strip is the prompt, the body is what the user picked. A
      // tiny accent bar on the left anchors the whole block as one
      // logical unit in the transcript.
      return (
        <div
          className="relative group rounded-md border overflow-hidden"
          style={{
            borderColor: "var(--color-line-soft)",
            background: "var(--color-bg-1)",
          }}
        >
          <div
            className="t-xs t-ui px-3 pt-2 pb-1.5 border-b"
            style={{
              color: "var(--color-text-3)",
              borderColor: "var(--color-line-soft)",
              background: "var(--color-bg-2)",
            }}
          >
            {turn.answered_question}
          </div>
          <div className="t-base px-3 py-2" style={{ color: "var(--color-text-1)" }}>
            {visibleText}
          </div>
          <BubbleActions onCopy={copyText} copied={copied} onEdit={null} />
        </div>
      );
    }
    return (
      <div className="relative group user-bubble w-fit max-w-[85%]">
        <ChatAttachmentThumbs attachments={turn.attachments} />
        {visibleText}
        <BubbleActions
          onCopy={copyText}
          copied={copied}
          onEdit={canEdit ? startEdit : null}
        />
      </div>
    );
  }
  return (
    // Reading-column cap: the answer prose, the rolled-up step summary AND its
    // expand chevron all live in here, so capping the container is what keeps
    // every assistant element off the right edge — they stop "in between"
    // instead of stretching the full pane width (mirrors the user bubble's
    // max-w cap, just a touch wider for prose + code).
    <div className="relative group agent-text max-w-[680px]">
      {/* No per-message "Aura" identity row — the brand is carried by the tab,
          not stamped before every reply. Provenance (which model ran the
          turn) lives quietly in the action row below, beside copy + time. */}
      {/* Settled-turn step-run — rolled up Conductor-style into one quiet
          summary line that expands to a flat list of the same compact step
          rows. The answer prose below stays always-visible; only the steps
          collapse. The LIVE in-flight turn still streams through
          StreamingBubble (with its ExploringGroup/LiveToolStatus batching) —
          this roll-up is the FINISHED-turn treatment only. */}
      {(() => {
        // A settled turn's step-run splits in two: a question the brain asked
        // you or a plan it proposed surfaces as its own PROMINENT card in the
        // main flow (never buried), while reads / edits / commands / reasoning
        // fold into the quiet "Worked through N steps" roll-up.
        const all = persistedTurnBlocks(turn);
        if (all.length === 0) return null;
        const { interactive, rest } = partitionInteractive(all);
        return (
          <>
            {rest.length > 0 && (
              <div className="mb-1.5">
                <TurnActivity blocks={rest} />
              </div>
            )}
            {interactive.length > 0 && (
              <div className="mb-2">
                <InteractiveBlocks blocks={interactive} />
              </div>
            )}
          </>
        );
      })()}
      <AgentMessageBody source={turn.text} />
      {/* Per-round "what changed" receipt (Antigravity-style) — a small block
          at the foot of the turn tallying the files this round actually wrote,
          with a Review that opens the same inline before/after diffs. Derived
          from the turn's persisted tool calls; absent when nothing changed. */}
      {(() => {
        const changes = extractTurnChanges(persistedTurnBlocks(turn));
        return changes ? <TurnChanges summary={changes} /> : null;
      })()}
      {showActions && (
      <div className="aura-msg-actions">
        {durationSec != null && (
          <span className="dur" title="Time the brain took on this turn">
            {formatDuration(durationSec)}
          </span>
        )}
        {showSavings &&
          typeof turn.saved_tokens === "number" &&
          turn.saved_tokens > 0 && (
            <span
              className="saved"
              title="Estimated tokens saved by using Aura's code map and Q&A instead of reading whole files. An estimate, not an exact count."
            >
              Saved ~{formatSavedTokens(turn.saved_tokens)} tokens
            </span>
          )}
        <button
          type="button"
          onClick={copyText}
          title={copied ? "Copied" : "Copy"}
          aria-label={copied ? "Copied message" : "Copy message"}
        >
          {copied ? (
            <Check size={13} aria-hidden="true" />
          ) : (
            <Copy size={13} aria-hidden="true" />
          )}
        </button>
        {/* Model provenance lives here now — small + minimal, kept in the
            same left cluster as the time-taken + copy so it reads as one
            compact group, not a loud suffix on a brand line. Suppressed inside
            a group: the group header already brands the run once, so repeating
            "Claude" on every segment's footer is the noise the user flagged. */}
        {turn.brain && !inGroup && (
          <span className="model" title="Model that ran this turn">
            <AgentIcon agentId={brainAgentId(turn.brain)} size={11} />
            {humanizeBrainId(turn.brain)}
          </span>
        )}
        <div className="aura-more" ref={moreRef}>
          <button
            type="button"
            title="More"
            aria-label="More options"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
          {moreOpen && (
            <div className="aura-more-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                disabled={!canFork}
                onClick={() => fork("tab")}
              >
                <GitBranch size={13} />
                Fork to new tab
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!canFork}
                onClick={() => fork("workspace")}
              >
                <SquareArrowOutUpRight size={13} />
                Fork to new window
              </button>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

/** Format a turn's elapsed seconds for the per-message action row, matching
 *  Conductor's terse stat (`0s` / `8s` / `2m` / `1h`). Sub-second rounds to
 *  `0s`; we never show fractional or zero-padded units. */
function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

// Agent message body — pre-processes the text so structured event lines
// (Wave N dispatched/shipped/waiting, Hook blocked, …) render as compact
// blocks instead of plain prose. Everything else falls through to
// regular markdown rendering. The detection runs paragraph-by-paragraph
// so an event line interleaved with prose still works.
// A compaction / handover summary, drawn as a calm collapsible contextual
// card instead of a user bubble. Collapsed by default (these run thousands
// of characters) with a one-line gist; expanded it renders the full markdown
// through the chat's own MarkdownBody so embedded code + entities read the
// same as any agent turn. Mirrors Trace's `HandoverCard` treatment so the
// "this is carried-over context, not something you typed" signal is
// consistent across the app.
function ChatHandoverCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const gist = useMemo(() => summaryGist(text), [text]);
  const lines = useMemo(() => text.split("\n").length, [text]);
  return (
    <div
      className="overflow-hidden rounded-lg border"
      style={{
        borderColor: "color-mix(in srgb, var(--color-accent) 26%, var(--color-line))",
        background: "color-mix(in srgb, var(--color-accent) 5%, var(--color-bg-1))",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        aria-expanded={open}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-bg-2/40"
      >
        <span
          className="mt-px flex h-4 w-4 shrink-0 items-center justify-center"
          style={{ color: "var(--color-accent)" }}
          aria-hidden
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 2.5l5 2.5-5 2.5-5-2.5 5-2.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M3 8l5 2.5L13 8M3 11l5 2.5L13 11" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="t-sm font-semibold" style={{ color: "var(--color-text-1)" }}>
              Context carried over
            </span>
            <span className="t-xs" style={{ color: "var(--color-text-4)" }}>
              continued from a previous session
            </span>
          </span>
          {!open ? (
            <span className="mt-0.5 block truncate t-sm" style={{ color: "var(--color-text-3)" }}>
              {gist}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="font-mono t-xs" style={{ color: "var(--color-text-4)" }}>
            {lines} lines
          </span>
          <ChevronDown
            size={13}
            style={{
              color: "var(--color-text-4)",
              transform: open ? "rotate(180deg)" : "none",
              transition: "transform 120ms",
            }}
          />
        </span>
      </button>
      {open ? (
        <div
          className="border-t"
          style={{ borderColor: "var(--color-line-soft)", background: "var(--color-bg-0)" }}
        >
          <div className="max-h-[520px] overflow-auto px-3.5 py-3">
            <MarkdownBody source={text} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AgentMessageBody({ source }: { source: string }) {
  const segments = useMemo(
    // Wave events are intentionally filtered — they aggregate into the
    // session-level WaveTimeline so each wave renders as ONE entity that
    // progresses through states, not N separate blocks per status change.
    () => splitAgentSegments(source).filter((s) => s.kind !== "wave"),
    [source],
  );
  if (segments.length === 0) return null;
  if (segments.length === 1 && segments[0].kind === "prose") {
    return <MarkdownBody source={segments[0].text} />;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {segments.map((seg, i) =>
        seg.kind === "hook" ? (
          <HookEventBlock key={i} text={seg.text} />
        ) : seg.kind === "prover" ? (
          <ProverBlock key={i} report={seg.report} />
        ) : seg.kind === "prose" ? (
          <MarkdownBody key={i} source={seg.text} />
        ) : null,
      )}
    </div>
  );
}

type WaveStatus =
  | "dispatched"
  | "shipped"
  | "running"
  | "waiting"
  | "blocked"
  | "firing"
  | "info";

type WaveEvent = {
  wave: number;
  status: WaveStatus;
  detail: string;
  /** Agent attribution parsed from `Wave N (<agent>)`. */
  agent?: string;
  /** Optional commit short-hash extracted from `(commit 775ee7b)`. */
  commit?: string;
  /** Optional next wave reference parsed from "Firing Wave N (...)". */
  next?: { wave: number; note?: string };
};

type AgentSegment =
  | { kind: "prose"; text: string }
  | { kind: "wave"; event: WaveEvent }
  | { kind: "hook"; text: string }
  | { kind: "prover"; report: ProverReport };

// Split an agent message into structured segments. Each non-empty
// paragraph is tested against the wave-event pattern; matching ones
// become structured events. Prose paragraphs are coalesced so the
// renderer doesn't insert extra gaps between successive non-event
// sentences.
function splitAgentSegments(source: string): AgentSegment[] {
  // Aura Prover spans many lines (header + bullets + report). Extract
  // it first as a whole multi-line block so the per-paragraph loop
  // doesn't shred it into prose.
  const { stripped, prover } = extractProverBlock(source);
  const paragraphs = stripped.split(/\n\s*\n/);
  const out: AgentSegment[] = [];
  if (prover) out.push({ kind: "prover", report: prover });
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const wave = parseWaveEvent(trimmed);
    if (wave) {
      out.push({ kind: "wave", event: wave });
      continue;
    }
    if (/^hook\s+blocked\b/i.test(trimmed)) {
      out.push({ kind: "hook", text: trimmed });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.kind === "prose") {
      last.text += `\n\n${trimmed}`;
    } else {
      out.push({ kind: "prose", text: trimmed });
    }
  }
  return out;
}

// ─── Aura Prover formatting ───────────────────────────────────────────
// `aura prove` dumps a colored terminal report — header, analyzing
// bullets, "SEMANTIC PROOF REPORT" section, per-requirement lines.
// When it lands in agent prose it's a wall of mojibake-looking text.
// Parse it into a structured report so we can render a proper card.

type ProverCheckStatus = "passed" | "stub" | "missing" | "unwired";
type ProverCheck = {
  status: ProverCheckStatus;
  node_type: string;
  node_name: string;
  /** Optional wiring detail line, e.g. "Properly wired to bar". */
  wiring?: { status: "passed" | "missing"; target: string };
};
type ProverReport = {
  goal: string;
  checks: ProverCheck[];
  passed: number;
  total: number;
};

/** Pull a contiguous Aura Prover block out of `source`. Returns the
 *  stripped source (with the block removed) plus the parsed report. */
function extractProverBlock(source: string): {
  stripped: string;
  prover: ProverReport | null;
} {
  const headerRe = /(?:🧪|🪄)\s*Aura Prover:\s*Verifying Goal Achievement:\s*(.+)/;
  const hm = source.match(headerRe);
  if (!hm) return { stripped: source, prover: null };
  const startIdx = source.indexOf(hm[0]);
  // Block ends at next blank line *after* we've seen the report
  // section, or at EOF. We greedily consume lines until a blank line
  // following a "SEMANTIC PROOF REPORT" marker is reached.
  const tail = source.slice(startIdx);
  const lines = tail.split("\n");
  let endLine = lines.length;
  let seenReport = false;
  for (let i = 0; i < lines.length; i++) {
    if (/SEMANTIC PROOF REPORT/.test(lines[i])) {
      seenReport = true;
      continue;
    }
    if (seenReport && lines[i].trim() === "") {
      endLine = i;
      break;
    }
  }
  const block = lines.slice(0, endLine).join("\n");
  const stripped = source.slice(0, startIdx) + source.slice(startIdx + block.length);
  const prover = parseProverBlock(block, hm[1].trim());
  return { stripped, prover };
}

function parseProverBlock(block: string, goal: string): ProverReport {
  const checks: ProverCheck[] = [];
  const lines = block.split("\n");
  let last: ProverCheck | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    // Top-level requirement line: "✓ Function 'foo' exists and is substantive."
    const ok = line.match(/^[\s]*✓\s+(\w+)\s+'([^']+)'\s+exists/);
    if (ok) {
      last = { status: "passed", node_type: ok[1], node_name: ok[2] };
      checks.push(last);
      continue;
    }
    const stub = line.match(/^[\s]*(?:⚠️|⚠)\s+(\w+)\s+'([^']+)'\s+exists but is a STUB/i);
    if (stub) {
      last = { status: "stub", node_type: stub[1], node_name: stub[2] };
      checks.push(last);
      continue;
    }
    const missing = line.match(/^[\s]*✗\s+(\w+)\s+'([^']+)'\s+(MISSING|not found)/i);
    if (missing) {
      last = { status: "missing", node_type: missing[1], node_name: missing[2] };
      checks.push(last);
      continue;
    }
    // Wiring sub-line: "  ↳ Properly wired to 'bar'" / "  ↳ ✗ NOT wired to 'bar'"
    const wiredOk = line.match(/↳\s+Properly wired to\s+'?([^'\s]+)'?/);
    if (wiredOk && last) {
      last.wiring = { status: "passed", target: wiredOk[1] };
      continue;
    }
    const wiredBad = line.match(/↳\s+✗?\s*NOT wired to\s+'?([^'\s]+)'?/);
    if (wiredBad && last) {
      last.wiring = { status: "missing", target: wiredBad[1] };
      if (last.status === "passed") last.status = "unwired";
      continue;
    }
  }
  const passed = checks.filter(
    (c) => c.status === "passed" && c.wiring?.status !== "missing",
  ).length;
  return { goal, checks, passed, total: checks.length };
}

function ProverBlock({ report }: { report: ProverReport }) {
  const pct =
    report.total === 0 ? 0 : Math.round((report.passed / report.total) * 100);
  return (
    <div
      className="aura-block flex flex-col"
      style={{ background: "var(--color-bg-1)" }}
    >
      <div
        className="flex items-center justify-between gap-2 px-2.5 py-1.5"
        style={{ borderBottom: "1px solid var(--color-line-soft)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="aura-block-label">AURA PROVER</span>
          <span
            className="truncate text-[12px]"
            style={{ color: "var(--color-text-2)" }}
            title={report.goal}
          >
            {report.goal}
          </span>
        </div>
        <span
          className="shrink-0"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "10.5px",
            color: pct === 100 ? "var(--color-accent-green, rgb(110 231 183))" : "var(--color-text-3)",
            letterSpacing: "0.04em",
          }}
        >
          {report.passed}/{report.total} PASSED · {pct}%
        </span>
      </div>
      <div className="flex flex-col">
        {report.checks.map((c, i) => (
          <ProverCheckRow key={i} check={c} />
        ))}
      </div>
    </div>
  );
}

function ProverCheckRow({ check }: { check: ProverCheck }) {
  const palette: Record<ProverCheckStatus, { color: string; label: string; mark: string }> = {
    passed: { color: "var(--color-accent-green, rgb(110 231 183))", label: "PASS", mark: "✓" },
    stub: { color: "var(--color-amber, rgb(251 191 36))", label: "STUB", mark: "!" },
    missing: { color: "var(--color-red, rgb(244 114 182))", label: "MISSING", mark: "✗" },
    unwired: { color: "var(--color-red, rgb(244 114 182))", label: "UNWIRED", mark: "✗" },
  };
  const p = palette[check.status];
  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5"
      style={{ borderTop: "1px solid var(--color-line-soft)" }}
    >
      <span
        className="shrink-0 inline-flex items-center justify-center"
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          background: accentTint(p.color, 18),
          color: p.color,
          fontFamily: "var(--font-mono)",
          fontSize: "10.5px",
          fontWeight: 600,
        }}
      >
        {p.mark}
      </span>
      <span
        className="shrink-0"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "10.5px",
          letterSpacing: "0.04em",
          color: p.color,
          minWidth: 64,
        }}
      >
        {p.label}
      </span>
      <span
        className="shrink-0 px-1 py-[1px]"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          color: "var(--color-text-3)",
          border: "1px solid var(--color-line-soft)",
          borderRadius: 3,
        }}
      >
        {check.node_type}
      </span>
      <span
        className="min-w-0 truncate"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "12px",
          color: "var(--color-text-1)",
        }}
      >
        {check.node_name}
      </span>
      {check.wiring && (
        <span
          className="ml-auto shrink-0 text-[11px]"
          style={{
            color:
              check.wiring.status === "passed"
                ? "var(--color-text-3)"
                : "var(--color-red, rgb(244 114 182))",
            fontFamily: "var(--font-mono)",
          }}
        >
          {check.wiring.status === "passed" ? "→ " : "⚠ NOT → "}
          {check.wiring.target}
        </span>
      )}
    </div>
  );
}

// Only treat parens-after-Wave-N as an agent attribution when it looks
// like one — short, alphabetic, possibly hyphenated (e.g. "gemini",
// "claude", "cursor-agent"). Pure hex commit hashes and free-form
// descriptors get rejected so they don't leak into the agent column.
function looksLikeAgentToken(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 20) return false;
  if (/^[a-f0-9]+$/i.test(t)) return false; // commit hash
  return /^[a-zA-Z][a-zA-Z0-9-]*$/.test(t);
}

function parseWaveEvent(text: string): WaveEvent | null {
  // Match "Wave N" or "Wave N (gemini)" prefix. Trailing remainder is
  // free-form prose we further mine for status verbs + commits.
  const m = text.match(/^Wave\s+(\d+)\b\s*(?:\(([^)]*)\)\s*)?(.*)$/is);
  if (!m) return null;
  const wave = Number(m[1]);
  const agentCandidate = m[2]?.trim();
  const agent =
    agentCandidate && looksLikeAgentToken(agentCandidate) ? agentCandidate : undefined;
  // If the parens weren't an agent attribution, keep them in the prose
  // (e.g. "Wave 4 (FTS) shipped..." should still read normally).
  const rest = (agent ? m[3] : (agentCandidate ? `(${agentCandidate}) ${m[3]}` : m[3])).trim();
  const lower = rest.toLowerCase();
  let status: WaveStatus = "info";
  if (/\bship(ped|ping)\b/.test(lower)) status = "shipped";
  else if (/\bdispatch(ed|ing)\b/.test(lower)) status = "dispatched";
  else if (/\brunning\b/.test(lower)) status = "running";
  else if (/\bwait(ing)?\b/.test(lower)) status = "waiting";
  else if (/\bblock(ed)?\b/.test(lower)) status = "blocked";
  else if (/\bfir(ed|ing)\b/.test(lower)) status = "firing";
  // Commit hash forms accepted: "commit abc1234", `abc1234`, or a bare
  // 7-12 hex in parens right after a status verb (e.g. "shipped
  // (c0ceddf)"). The bare form lets us pick up commits the brain emits
  // without the "commit" keyword.
  const commit =
    rest.match(/\bcommit\s+`?([a-f0-9]{7,40})`?/i)?.[1] ??
    rest.match(/\b(?:shipped|landed)\s*\(`?([a-f0-9]{7,12})`?\)/i)?.[1] ??
    rest.match(/`([a-f0-9]{7,40})`/)?.[1];
  const nextMatch = rest.match(/Firing\s+Wave\s+(\d+)(?:\s*\(([^)]+)\))?/i);
  const next = nextMatch
    ? { wave: Number(nextMatch[1]), note: nextMatch[2]?.trim() }
    : undefined;
  return { wave, status, detail: rest, agent, commit, next };
}

// ─── Live Dispatch Strip ──────────────────────────────────────────────
// Derives currently-running task dispatches from the ribbon. A task is
// "in flight" once `task_dispatched` fires and stays in flight until
// `task_completed` or `task_failed` arrives for the same id. Renders a
// row of agent chips with a soft pulse; hides itself when nothing is
// active so it doesn't squat at the top of the chat.

type LiveDispatch = {
  task_id: number;
  agent_id: string;
  channel: string;
  at: number;
};

function collectLiveDispatches(ribbon: RibbonEntry[]): LiveDispatch[] {
  const active = new Map<number, LiveDispatch>();
  for (const entry of ribbon) {
    const ev = entry.event;
    if (ev.kind === "task_dispatched") {
      active.set(ev.task_id, {
        task_id: ev.task_id,
        agent_id: ev.agent_id,
        channel: ev.channel,
        at: entry.at,
      });
    } else if (ev.kind === "task_completed" || ev.kind === "task_failed") {
      active.delete(ev.task_id);
    }
  }
  return Array.from(active.values()).sort((a, b) => a.at - b.at);
}

function LiveDispatchStrip({ ribbon }: { ribbon: RibbonEntry[] }) {
  const dispatches = useMemo(() => collectLiveDispatches(ribbon), [ribbon]);
  if (dispatches.length === 0) return null;
  return (
    <div
      className="aura-block flex flex-wrap items-center gap-1.5 px-2.5 py-1.5"
      style={{ background: "var(--color-bg-1)", margin: "8px 0" }}
    >
      <span className="aura-block-label shrink-0">LIVE</span>
      <span
        className="shrink-0"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "10.5px",
          color: "var(--color-text-3)",
          letterSpacing: "0.04em",
        }}
      >
        {dispatches.length} DISPATCHED
      </span>
      <span className="flex flex-wrap items-center gap-1 min-w-0">
        {dispatches.map((d) => (
          <DispatchChip key={d.task_id} dispatch={d} />
        ))}
      </span>
    </div>
  );
}

function DispatchChip({ dispatch }: { dispatch: LiveDispatch }) {
  const identity = getAgentIdentity(dispatch.agent_id);
  return (
    <span
      className="flex items-center gap-1 px-1.5 py-0.5"
      style={{
        background: accentTint(identity.accent, 14),
        border: `1px solid ${accentTint(identity.accent, 38)}`,
        borderRadius: 3,
        fontFamily: "var(--font-mono)",
        fontSize: "10.5px",
        letterSpacing: "0.04em",
        color: "var(--color-text-1)",
      }}
      title={`${identity.label} · task #${dispatch.task_id} · ${dispatch.channel}`}
    >
      <AgentIcon agentId={identity.id} size={11} />
      {identity.tag}
      <span style={{ color: "var(--color-text-3)" }}>#{dispatch.task_id}</span>
      <span
        style={{
          display: "inline-block",
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: identity.accent,
          animation: "aura-pulse 1.4s ease-in-out infinite",
        }}
      />
    </span>
  );
}

// ─── Wave Timeline ────────────────────────────────────────────────────
// All wave events emitted across the session aggregate into ONE
// timeline block. Each wave is a single row that PROGRESSES through
// states (dispatched → running → shipped) — not a stack of duplicate
// blocks. Rendered once at the tail of the chat so it always reflects
// current state. Per-turn wave events are filtered out (see
// AgentMessageBody) to prevent duplication.

type AggregatedWave = {
  wave: number;
  /** Latest status — drives the row color + verb. */
  status: WaveStatus;
  /** Chronological history of statuses this wave has been through. */
  history: WaveStatus[];
  /** Latest agent attribution (most recent event wins). */
  agent?: string;
  /** Commit hash if/when this wave shipped. */
  commit?: string;
  /** Latest free-form detail string for tooltip/secondary line. */
  detail: string;
  /** Timestamp of latest event. */
  at: number;
};

/** Walk chronological chat turns, parse wave events out of agent prose,
 *  and aggregate them into one row per wave number. A wave's `status`
 *  reflects the LATEST event seen; `history` keeps the transition trail
 *  for the timeline dots. */
function collectWaveTimeline(chat: ChatTurn[]): AggregatedWave[] {
  const byWave = new Map<number, AggregatedWave>();
  for (const turn of chat) {
    if (turn.role !== "manager") continue;
    const paragraphs = (turn.text ?? "").split(/\n\s*\n/);
    for (const para of paragraphs) {
      const evt = parseWaveEvent(para.trim());
      if (!evt) continue;
      const existing = byWave.get(evt.wave);
      if (!existing) {
        byWave.set(evt.wave, {
          wave: evt.wave,
          status: evt.status,
          history: [evt.status],
          agent: evt.agent,
          commit: evt.commit,
          detail: evt.detail,
          at: turn.at,
        });
      } else {
        existing.status = evt.status;
        if (existing.history[existing.history.length - 1] !== evt.status) {
          existing.history.push(evt.status);
        }
        if (evt.agent) existing.agent = evt.agent;
        if (evt.commit) existing.commit = evt.commit;
        existing.detail = evt.detail;
        existing.at = turn.at;
      }
    }
  }
  return Array.from(byWave.values()).sort((a, b) => a.wave - b.wave);
}

function WaveTimeline({ chat }: { chat: ChatTurn[] }) {
  const waves = useMemo(() => collectWaveTimeline(chat), [chat]);
  if (waves.length === 0) return null;
  const shipped = waves.filter((w) => w.status === "shipped").length;
  return (
    <div
      className="aura-block flex flex-col"
      style={{ background: "var(--color-bg-1)", margin: "8px 0" }}
    >
      <div
        className="flex items-center justify-between gap-2 px-2.5 py-1.5"
        style={{ borderBottom: "1px solid var(--color-line-soft)" }}
      >
        <span className="aura-block-label">WAVE TIMELINE</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "10.5px",
            color: "var(--color-text-3)",
            letterSpacing: "0.04em",
          }}
        >
          {shipped}/{waves.length} SHIPPED
        </span>
      </div>
      <div className="flex flex-col">
        {waves.map((w) => (
          <WaveTimelineRow key={w.wave} wave={w} />
        ))}
      </div>
    </div>
  );
}

// One compact status indicator per wave — no multi-stop pipeline. The
// row reads at a glance: ring/spinner/check tells you state, the row
// content tells you what landed (commit + agent + detail).

function WaveTimelineRow({ wave }: { wave: AggregatedWave }) {
  // Fall back to the lead-builder identity when the brain didn't tag
  // the wave with an agent — every wave has a runner, the prose just
  // doesn't always say which one. Better to show the lead default than
  // leave the column blank and break row alignment.
  const identity = getAgentIdentity(wave.agent ?? "claude");
  return (
    <div
      data-wave-row={wave.wave}
      className="flex items-center gap-2 px-2.5 py-1.5"
      style={{ borderTop: "1px solid var(--color-line-soft)" }}
    >
      <WaveStatusPip status={wave.status} />
      <span
        className="shrink-0"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "11px",
          fontWeight: 600,
          color: "var(--color-text-1)",
          minWidth: 22,
        }}
      >
        W{wave.wave}
      </span>
      <span
        className="flex items-center gap-1 shrink-0"
        title={identity.blurb}
      >
        <AgentIcon agentId={identity.id} size={11} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "10px",
            letterSpacing: "0.04em",
            color: "var(--color-text-2)",
          }}
        >
          {identity.tag}
        </span>
      </span>
      {wave.commit && (
        <span
          className="shrink-0"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "10.5px",
            color: "var(--color-accent-green, rgb(110 231 183))",
          }}
          title={`Commit ${wave.commit}`}
        >
          {wave.commit.slice(0, 7)}
        </span>
      )}
      <span
        className="text-[11.5px] leading-snug min-w-0 truncate"
        style={{ color: "var(--color-text-3)" }}
        title={wave.detail}
      >
        {wave.detail}
      </span>
    </div>
  );
}

function WaveStatusPip({ status }: { status: WaveStatus }) {
  // Shipped → solid green tick. In-flight (running/firing/dispatched) →
  // spinning ring. Waiting → soft pulsing ring. Blocked → red bang.
  // Anything else → muted hollow ring.
  const SIZE = 14;
  if (status === "shipped") {
    const color = "var(--color-accent-green, rgb(110 231 183))";
    return (
      <span
        title="Shipped"
        className="shrink-0 inline-flex items-center justify-center"
        style={{
          width: SIZE,
          height: SIZE,
          borderRadius: "50%",
          background: color,
        }}
      >
        <PipTick color="var(--color-bg-content)" />
      </span>
    );
  }
  if (status === "blocked") {
    const color = "var(--color-red, rgb(244 114 182))";
    return (
      <span
        title="Blocked"
        className="shrink-0 inline-flex items-center justify-center"
        style={{
          width: SIZE,
          height: SIZE,
          borderRadius: "50%",
          background: color,
        }}
      >
        <PipBang color="var(--color-bg-content)" />
      </span>
    );
  }
  if (status === "running" || status === "firing" || status === "dispatched") {
    const color = "var(--color-accent)";
    return (
      <span
        title={status.charAt(0).toUpperCase() + status.slice(1)}
        className="shrink-0 inline-block"
        style={{
          width: SIZE,
          height: SIZE,
          borderRadius: "50%",
          border: `1.5px solid ${color}`,
          borderTopColor: "transparent",
          animation: "aura-chat-spin 0.9s linear infinite",
        }}
      />
    );
  }
  if (status === "waiting") {
    const color = "var(--color-accent)";
    return (
      <span
        title="Waiting"
        className="shrink-0 inline-block"
        style={{
          width: SIZE,
          height: SIZE,
          borderRadius: "50%",
          border: `1.5px solid ${color}`,
          animation: "aura-pulse 1.6s ease-in-out infinite",
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="shrink-0 inline-block"
      style={{
        width: SIZE,
        height: SIZE,
        borderRadius: "50%",
        border: "1.5px solid var(--color-line)",
      }}
    />
  );
}

function PipTick({ color }: { color: string }) {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden>
      <path
        d="M2.5 6.2L5 8.5L9.5 3.5"
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PipBang({ color }: { color: string }) {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden>
      <path
        d="M6 3v4.5"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="6" cy="9.4" r="0.9" fill={color} />
    </svg>
  );
}

function HookEventBlock({ text }: { text: string }) {
  return (
    <div
      className="aura-block flex items-start gap-2 px-2.5 py-1.5"
      style={{ background: "var(--color-bg-1)" }}
    >
      <span
        className="aura-block-label shrink-0 mt-[2px]"
        style={{ color: "var(--color-red, rgb(244 114 182))" }}
      >
        HOOK
      </span>
      <span className="text-[12px] leading-snug min-w-0" style={{ color: "var(--color-text-2)" }}>
        {text.replace(/^hook\s+/i, "")}
      </span>
    </div>
  );
}

/** Hover-only action row pinned to the bubble's bottom-right. Always
 *  shows Copy; Edit appears only when the parent passes a handler (i.e.
 *  the turn is an editable user message). */
function BubbleActions({
  onCopy,
  copied,
  onEdit,
}: {
  onCopy: () => void;
  copied: boolean;
  onEdit: (() => void) | null;
}) {
  return (
    <div
      className="absolute bottom-1 right-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
      style={{
        background: "color-mix(in srgb, var(--color-bg-1) 85%, transparent)",
        borderRadius: "var(--radius-sm)",
      }}
    >
      <button
        type="button"
        onClick={onCopy}
        title={copied ? "Copied" : "Copy"}
        className="px-1.5 py-1 rounded hover:bg-bg-2 text-text-3 hover:text-text-1"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          title="Edit & resend"
          className="px-1.5 py-1 rounded hover:bg-bg-2 text-text-3 hover:text-text-1"
        >
          <Pencil size={12} />
        </button>
      )}
    </div>
  );
}

