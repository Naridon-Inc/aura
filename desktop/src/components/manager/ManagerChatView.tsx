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
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ArrowDown, SquareArrowOutUpRight } from "lucide-react";
import {
  api,
  type ActiveBrainInfo,
  type BrainChatChunk,
  type BrainChoice,
  type ChatTurn,
  type ManagerSession,
  type ManagerStreamDelta,
  type ReasoningEffort,
  type ApprovalPolicy,
} from "../../lib/api";
import { trackFeature } from "../../lib/track";
import { markSentComments } from "../../lib/diffReview/commentChat";
import { useMachineName } from "../../lib/machineName";
import { attachSessionGoal } from "../../lib/goalStore";
import {
  markManagerTurnInFlight,
  clearManagerTurnInFlight,
  isManagerTurnInFlight,
  subscribeManagerTurns,
  getManagerTurnStartedAt,
  setManagerTurnStartedAt,
  clearManagerTurnStartedAt,
  getManagerLiveBlocks,
  setManagerLiveBlocks,
} from "../../lib/managerStore";
import { ManagerComposer, type ComposerAttachment } from "./ManagerComposer";
import type { SlashItem } from "../chat/composer/useComposerSuggestions";
import { liveAgentLabel, useAgentSurface } from "../../lib/agentSurface";
import { AgentPlanStrip } from "./chat/AgentPlanStrip";
import type { SelectedModel } from "../../lib/modelCatalog";
import { isMachineBrain, turnModel } from "../../lib/machineBrain";
import {
  loadSessionBrain,
  loadSessionModel,
  saveSessionBrain,
  saveSessionModel,
} from "../../lib/managerSessionPrefs";
import { ManagerQueueStack, type QueuedMessage } from "./ManagerQueueStack";
import { CrewComposerBlock } from "./chat/CrewComposerBlock";
import { ScoutCard } from "./ScoutCard";
import {
  useEditorStore,
  getActiveWorkspaceRoot,
  openManagerSession,
} from "../../lib/editorStore";
import { openPlanWizard } from "../../lib/planWizardStore";
import {
  buildGoalDirective,
  stripSteeringDirective,
} from "../../lib/steeringDirective";
import { openPopout } from "../../lib/popout";
import { pendingPlanToMarkdown, planPageId } from "../../lib/planMarkdown";
import { plainLine } from "../../lib/plainPreview";
import {
  handleChatSlash,
  type SlashInteractive,
} from "../../lib/chatSlashHandler";
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

// Chat-render layer — de-monolithed out of this file into focused modules.
// The registry that *produces* a ToolView (toolDescribe) and the cards that
// *consume* it (ToolCard) evolve independently against chat/types.
import { ChatRepoRootContext } from "./chat/context";
import { ChatSpendContext, useChatSpendValue } from "./chat/spend";
import type { StreamBlock, TurnSpend } from "./chat/types";
import {
  StreamingBlocks,
  createStreamStore,
  useStreamCoarse,
} from "./chat/StreamingBlocks";
import { isAskUserTool, isAuraUxBash } from "./chat/toolDescribe";
import { ChatEmptyState } from "./chat/ChatEmptyState";
import { ChatStarters } from "./chat/ChatStarters";
import { ChatFind } from "./chat/ChatFind";
import { TurnErrorBoundary } from "./chat/TurnErrorBoundary";
import { ChatComposerArea, ChatTranscript } from "../ui/chat-surface";
import { composerKey, MANAGER_HISTORY_PREFIX, rememberSent } from "../composer/composerDrafts";
import { ChatRecovery, HistoryGap } from "../ui/chat-recovery";
import { PlanReview } from "../ui/chat-decisions";
import { ChatHistoryMenu } from "./chat/ChatHistoryMenu";
import {
  ThinkingLine,
  PlanningStatusLine,
  StallNotice,
  humanizeBrainId,
} from "./chat/StatusLine";
import { QuestionCard } from "./chat/QuestionCard";
import {
  MessageScrollbackRail,
  type RailAnchor,
} from "./chat/MessageScrollbackRail";
// AURA-1298
// AURA-1296 — Concise output style on the turn, "finished 3:42 PM" beside the
// duration, and a Restart-and-resend for a message that never got through.
import { outputStyleArg, readOutputStyle } from "../../lib/outputStyle";
import { Button } from "../ui/button";
import { UndeliverableMessage } from "./UndeliverableMessage";
import { loadQueue, saveQueue, newQueueId } from "./chat/managerQueue";
import {
  upsertText,
  upsertReasoning,
  upsertTool,
  attachResult,
} from "./chat/streamBlockEdits";
import { RunningCommandStatus } from "./chat/RunningCommandStatus";
import { PlanCard, pendingPlanToTabInput } from "./chat/PlanCard";
import {
  SystemLine,
  SystemCard,
  PlanModeNotice,
  ribbonAsSystem,
} from "./chat/SystemRows";
import { ResumePicker } from "./chat/ResumePicker";
import {
  type SettledSpecialist,
  isScoutSpawnLine,
  parseScoutSpecialistLine,
  SettledScoutBlock,
} from "./chat/ScoutBlocks";
import {
  MilestoneDivider,
  BrainHandoffDivider,
  TimeGapDivider,
} from "./chat/ChatDividers";
import { AssistantTurnGroup } from "./chat/AssistantTurnGroup";
import { ChatBubble } from "./chat/ChatBubble";
import { TurnProjectChips } from "./chat/TurnProjectChips";
import { useChatHost } from "./chat/chatHost";
import { openChatHistory } from "../../lib/chatHistoryEvent";
import { LiveDispatchStrip } from "./chat/LiveDispatchStrip";
import { WaveTimeline } from "./chat/WaveTimeline";

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

// ── Model + brain override persistence ─────────────────────────────────
// Both live in `lib/managerSessionPrefs` rather than here, because a session
// can be created by a surface that isn't a chat view — launching a workspace
// opens an Aura chat with the objective already in it, and has to set the
// model chip before this component mounts. The picker lifts model AND brain
// together and they are persisted together: restoring only the model used to
// show a chip ("Gemini 3 Flash") while `brainOverride` reset to null, silently
// running the next turn on the globally-active brain — wrong engine, wrong
// author label, no handoff divider.
const loadModel = loadSessionModel;
const saveModel = saveSessionModel;
const loadBrain = loadSessionBrain;
const saveBrain = saveSessionBrain;

export function ManagerChatView({ session }: Props) {
  // Where this conversation's hands are. Null for the overwhelming default —
  // a chat about the code on this disk. When it's a machine, the brain still
  // runs here and every tool call lands over there, so the surface is
  // deliberately identical and says so in exactly two places: the opening
  // line and the composer's placeholder.
  const machineName = useMachineName(session.machine_id);
  // Seed from the durable in-flight marker so a surface that REMOUNTS while a
  // native turn is still streaming (the workspace-switch case — AuraRailPanel
  // unmounts then remounts this view per repoRoot) shows "Working…" on the
  // first paint instead of a frozen, idle-looking pre-switch snapshot. The
  // run itself was never cancelled (see the chunk-channel cleanup below), so
  // the live chunk channel re-subscribes and resumes feeding this bubble.
  const [busy, setBusy] = useState(() => isManagerTurnInFlight(session.id));
  const [error, setError] = useState<string | null>(null);
  // AURA-1296 — a message whose dispatch was rejected (the agent behind the
  // chat had stopped). Holds the exact send arguments so "Restart and resend"
  // replays it under the same settings.
  const [undelivered, setUndelivered] = useState<{
    text: string;
    reason: string;
    args: [
      string,
      ComposerAttachment[],
      "auto" | "plan" | "build" | "ask",
      string | null,
      ReasoningEffort | null,
      boolean,
      ApprovalPolicy | null,
      boolean,
    ];
  } | null>(null);
  // Seed from — and write through to — the durable per-session block mirror.
  // `busy` above already survived the workspace-switch unmount, but the turn's
  // actual OUTPUT didn't: streamed prose, tool rows and the live "Running …"
  // row lived only here, so switching away mid-turn and back painted a bare
  // "Thinking…" under the user's message and read as a restart from zero. The
  // backend turn never stopped (the chunk-channel cleanup below refuses to
  // cancel it), so restoring the blocks is all that was missing. Bound to the
  // live session id through a ref — ManagerSurface reuses ONE instance and
  // swaps `session.id` in place, and a stale capture would write one session's
  // blocks into another's slot.
  //
  // They do NOT live in this component's state. A streamed token used to call
  // `setStreamBlocks` here — on a 5,000-line component that also maps the whole
  // settled timeline — so appending two characters re-rendered, and re-parsed
  // the markdown of, every prior turn. The blocks now live in a small external
  // store that only `<StreamingBlocks>` subscribes to; this component watches
  // the coarse summary instead, which moves a handful of times per turn (first
  // block, tool start, tool end, turn end) rather than once per token.
  const [streamStore] = useState(() => {
    const store = createStreamStore();
    const seed = getManagerLiveBlocks(session.id);
    if (seed.length > 0) store.apply(() => seed);
    return store;
  });
  const blocksSidRef = useRef(session.id);
  blocksSidRef.current = session.id;
  const { hasBlocks: hasStreamBlocks, runningTool: liveRunningTool } =
    useStreamCoarse(streamStore);
  const setStreamBlocks = useCallback(
    (update: React.SetStateAction<StreamBlock[]>) => {
      streamStore.apply((prev) => {
        const next = typeof update === "function" ? update(prev) : update;
        if (next === prev) return prev;
        setManagerLiveBlocks(blocksSidRef.current, next);
        // The stall watchdog's input. It used to be an effect keyed on the
        // blocks array; with the blocks out of this component's render there
        // is no such effect to run, and this is the same moment it fired.
        lastActivityRef.current = Date.now();
        return next;
      });
    },
    [streamStore],
  );
  // Last-turn context fill from the native brain's `usage` chunk. Overwritten
  // each turn (the count is the full running context, not a per-turn delta), so
  // the composer meter always reflects how full the window is right now. Stays
  // null for CLI brains that never report usage — the meter hides itself.
  const [usage, setUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
  } | null>(null);
  // What the last turn cost, and what this API key has spent since it was
  // added across every project. Only API-mode brains on a priceable model
  // emit the chunk, so this stays null on subscriptions and CLI wrappers and
  // the meter shows tokens alone.
  const [spend, setSpend] = useState<TurnSpend | null>(null);
  // The same two running totals every per-message cost card wants around it:
  // what this conversation has billed, and what every key has billed since it
  // was added. Re-read when the live meter moves, which is exactly when a turn
  // has just settled and the message you're about to hover was priced.
  const chatSpend = useChatSpendValue(session.chat, spend?.spendUsd ?? null);
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
  // instead of a state that flashes once and
  // vanishes. `null` when idle; the rising edge of busy/planBuilding stamps
  // the start, the falling edge resets it.
  // Seeded at FIRST RENDER, not by the effect below. The status line latches
  // its `startedAt` on first paint and effects run after paint — so a remount
  // mid-turn handed the leaf `startedAt={null}`, it anchored its own ticker to
  // "now", and the elapsed restarted at 0 ("Thinking… 2s" on a turn that was
  // really a minute in). The effect's later write cannot repair that: writing a
  // ref triggers no re-render, and the leaf latches only once.
  const turnStartRef = useRef<number | null>(
    getManagerTurnStartedAt(session.id),
  );
  // Last-activity stamp for the stall watchdog. Distinct from `turnStartRef`:
  // it advances on every streamed delta (see the effect below), so a long but
  // still-producing turn never looks stalled — only genuine silence does. The
  // StallNotice reads it live off this ref each tick. A ref (not state) so the
  // per-token refresh triggers no render.
  const lastActivityRef = useRef<number>(Date.now());
  // Brain of the current + previous turn dispatched from THIS view, used to
  // surface a live brain-handoff divider the instant the user switches models
  // (before any turn on the new brain persists — a stuck CLI wrapper never
  // does). `cur` is the brain `send` will run; `prev` is the one the last turn
  // ran. Set in `send`; a ref so the update piggybacks the send's own render.
  const liveTurnBrainRef = useRef<{ cur: string | null; prev: string | null }>({
    cur: null,
    prev: null,
  });
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
  // True once a stream chunk has actually painted in THIS mounted lifetime.
  // Blocks seeded from the durable mirror on mount are NOT proof of a live
  // stream — they're the pre-switch snapshot of a turn that may well have
  // finished while this view was unmounted, which is exactly what the
  // stale-marker self-correct below exists to notice. Without this the restored
  // blocks would trip that effect's `streamBlocks.length` guard and wedge the
  // working indicator on forever.
  const sawLiveChunkRef = useRef(false);
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
  const [brainOverride, setBrainOverride] = useState<BrainChoice | null>(() =>
    loadBrain(session.id),
  );
  // #251 — the exact model the next turn runs (composer model picker). Set
  // alongside `brainOverride` (the picker lifts both), threaded per-turn as
  // `model` + `long_context` into `brainChatTurn`. Per-session-persisted so
  // a reload restores the chip.
  const [modelOverride, setModelOverride] = useState<SelectedModel | null>(() =>
    loadModel(session.id),
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
  // A chat on one of the org's machines stays on its agent there: the picker
  // offers that machine's models, and a turn carries only one of them.
  const machineBrain = isMachineBrain(brainOverride) ? brainOverride : null;
  // W2 — type-ahead message queue. Populated while a turn is in flight (the
  // composer enqueues instead of dropping), drained one-per-turn-end.
  // Per-session-persisted (text + run-options; attachments are in-memory).
  const [queue, setQueue] = useState<QueuedMessage[]>(() =>
    loadQueue(session.id),
  );
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
  // Steer-in-flight: set when the user redirects a running turn (⌘↵ or the
  // "steer" follow-up pref). The steer message is parked at the FRONT of the
  // queue and the running turn is interrupted; unlike a plain Stop, this exit
  // MUST drain the queue so the redirect fires the moment the interrupt lands.
  // The drain effect reads it alongside `lastExitRef` (the interrupted End
  // clobbers lastExitRef to "stop", so a dedicated ref is what carries intent
  // across the interrupt). Cleared by the drain the instant it re-sends.
  const steerPendingRef = useRef(false);
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
  // Scrolled up from the newest message: the library "Jump to latest" pill
  // sits over the bottom of the transcript until the reader is back down.
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = atBottom;
    setAwayFromLatest(!atBottom);
  }, []);
  const jumpToLatest = useCallback(() => {
    atBottomRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAwayFromLatest(false);
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
  // Find in the conversation. Opening it brings every earlier message into
  // the page, so the search covers the whole conversation and not the window.
  const [findOpen, setFindOpen] = useState(false);
  const openFind = useCallback(() => {
    setVisibleCount(Number.MAX_SAFE_INTEGER);
    setFindOpen(true);
  }, []);
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
      // Anchor the stall clock to the turn's rising edge. On a remount of an
      // already-running (possibly stuck) turn we can't know the real last
      // activity, so start it "now" — the watchdog re-warns 90s later rather
      // than firing instantly on the remount.
      lastActivityRef.current = Date.now();
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
        // Safety net (mirrors the native chunk path): any content delta means a
        // turn is genuinely running — light the working indicator regardless of
        // how it was started. A message injected from Checks / PR surfaces never
        // ran this view's local `send`, so without this the legacy path streamed
        // tokens with no "Working…" status. Terminal kinds (question/done/error)
        // below own turning it back off.
        if (
          d.kind === "text_delta" ||
          d.kind === "tool_use" ||
          d.kind === "tool_result"
        ) {
          sawLiveChunkRef.current = true;
          setBusy(true);
        }
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
        // Safety net: if content is streaming, a turn is genuinely running —
        // light the working indicator regardless of how the turn was started.
        // The mount-seed + adopt-subscription cover the marker paths; this
        // guarantees the indicator for ANY live stream (idempotent when already
        // busy). Excludes the terminal end/error chunks, which own turning it
        // off, so a late content chunk can never resurrect a settled turn.
        if (
          c.kind === "text" ||
          c.kind === "reasoning" ||
          c.kind === "tool_use" ||
          c.kind === "tool_result"
        ) {
          sawLiveChunkRef.current = true;
          setBusy(true);
        }
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
          setUsage({
            inputTokens: c.input_tokens,
            outputTokens: c.output_tokens,
          });
        } else if (c.kind === "cost") {
          // Dollars for the turn that just finished, plus the key's running
          // total. Overwrite: `cost_usd` is this response, `spend_usd` is
          // already the accumulated figure from the ledger.
          setSpend({
            costUsd: c.cost_usd,
            spendUsd: c.spend_usd,
            spendSince: c.spend_since,
            estimated: c.estimated,
          });
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
            // A steer isn't a stop — it's a redirect. Skip the "Interrupted"
            // seam so the new turn reads as a continuation, not a halt. The
            // drain (which keys off steerPendingRef) fires the redirect next.
            if (!steerPendingRef.current) {
              setSlashLog((prev) => [
                ...prev,
                { at: Date.now() / 1000, text: "Interrupted", tone: "info" },
              ]);
            }
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
      if (sys)
        out.push({
          kind: "system",
          at: entry.at,
          text: sys.text,
          tone: sys.tone,
        });
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
      if ((t.role as string) === "system")
        persistedSystemTexts.set(t.text, t.at);
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
      out.push({
        kind: "system",
        at: s.at,
        text: s.text,
        tone: s.tone,
        rich: s.rich,
        interactive: s.interactive,
        notice: s.notice,
      });
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  }, [
    session.chat,
    session.ribbon,
    session.objective,
    session.created_at,
    slashLog,
  ]);

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
      // The body goes across by reference. Flattening it here meant running
      // a markdown strip over every turn in the conversation on every mount,
      // to label the sixty ticks the rail can draw — a month-long session
      // has tens of thousands of turns and the other 99% of that work was
      // sliced to 120 characters and thrown away. `describe` below does it
      // for the ticks that survive the measure.
      anchors.push({ id: `t-${idx}`, source: entry.turn.text ?? "", role });
    });
    return anchors;
  }, [timeline]);

  // How a tick labels itself. Flattened before the slice: an agent opens a
  // turn with a heading more often than not, and 120 characters of
  // `## Fixed the retry` spends the label on syntax.
  const describeTurn = useCallback(
    (source: string) =>
      plainLine(stripModeDirective(source)).slice(0, 120) || "(empty)",
    [],
  );

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
    sawLiveChunkRef.current = false;
    setBusy(isManagerTurnInFlight(session.id));
    // Re-bind the live blocks to the newly-selected session. This both restores
    // the incoming session's in-flight turn and stops the OUTGOING session's
    // blocks bleeding into it — `streamBlocks` was the one piece of transcript
    // state with no session-swap reset, so A's half-streamed reply used to
    // render under B until B's first terminal chunk wiped it.
    setStreamBlocks(getManagerLiveBlocks(session.id));
  }, [session.id, setStreamBlocks]);

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
    // Only blocks a chunk actually painted in THIS lifetime prove the turn is
    // still live. Blocks RESTORED from the durable mirror on mount are the
    // pre-switch snapshot of precisely the turn this reconcile is here to
    // check, so they must not disarm it.
    if (hasStreamBlocks && sawLiveChunkRef.current) return;
    const chat = session.chat ?? [];
    const last = chat[chat.length - 1];
    if (last && last.role === "manager") {
      clearManagerTurnInFlight(session.id);
      // Retire the restored blocks with the marker — the settled turn now owns
      // this prose, and leaving them would paint the same reply twice.
      setStreamBlocks([]);
      setBusy(false);
    }
  }, [session.id, session.chat, hasStreamBlocks]);

  // Self-healing dedupe for the live-stream → persisted-turn handoff. The live
  // `streamBlocks` copy is meant to be wiped the instant the settled turn lands
  // in `session.chat` — the stream's terminal end/done chunk calls
  // `setStreamBlocks([])`. When that chunk is delayed or dropped (a cancelled or
  // interrupted turn, a flaky socket, a brain that closed the stream without a
  // clean terminator) the settled `manager` turn renders in the timeline AND the
  // stale live copy renders right below it — the SAME reply painted twice
  // back-to-back (the reported duplicate). Here we notice that the last persisted
  // manager turn already carries this stream's prose and clear the orphan.
  //
  // Guarded tightly so it can never eat a legitimately-different live turn:
  //   - only fires once a `manager` turn is actually the last entry (during
  //     streaming the last entry is the just-persisted `user` turn, so this
  //     no-ops until the reply settles);
  //   - requires non-empty streamed prose that the persisted text already
  //     contains (equal, or a prefix once the final chunk was folded in
  //     server-side) — an interrupted partial whose text diverges is kept.
  useEffect(() => {
    if (!hasStreamBlocks) return;
    const streamBlocks = streamStore.getBlocks();
    // Compare on whitespace-normalized text. The backend joins a turn's text
    // blocks with "\n\n" when it persists them (and streams paragraph breaks as
    // "\n\n" deltas), while the live buffer concatenates block text directly —
    // so a byte-equality check spuriously failed for any multi-paragraph or
    // multi-block reply, which is exactly when the duplicate showed.
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const streamedText = norm(
      streamBlocks.map((b) => (b.kind === "text" ? b.text : "")).join(" "),
    );
    if (!streamedText) return;
    const chat = session.chat ?? [];
    if (chat[chat.length - 1]?.role !== "manager") return;
    // A reply that ran tools is persisted across several passes — one `manager`
    // turn per pass — so fold the whole trailing manager run, not just the last
    // turn, before checking whether the settled transcript already carries this
    // stream's prose.
    let persisted = "";
    for (let i = chat.length - 1; i >= 0 && chat[i]?.role === "manager"; i--) {
      persisted = `${chat[i]!.text ?? ""} ${persisted}`;
    }
    persisted = norm(persisted);
    if (!persisted) return;
    if (persisted === streamedText || persisted.startsWith(streamedText)) {
      // The settled turn now owns this prose. While the turn is still running
      // (busy) drop ONLY the duplicated text from the live buffer — the live
      // tool cards and reasoning keep streaming and the terminal chunk clears
      // the rest at turn end. If the stream already ended without a clean
      // terminator (cancelled/interrupted/flaky socket), wipe the stale buffer.
      setStreamBlocks((prev) =>
        busy ? prev.filter((b) => b.kind !== "text") : [],
      );
    }
    // Keyed on the SETTLED transcript, not on the live blocks: what this
    // compares against only changes when a turn persists, and re-running it
    // per token was one more reason a token re-rendered this component.
  }, [session.chat, busy, hasStreamBlocks, streamStore]);

  // Adopt a turn started OUTSIDE this view. When a message reaches the brain by
  // any path other than this component's own `send` — the floating HUD or a
  // sidebar composer routing through `sendAmbientManagerTurn` — the turn arms
  // the durable in-flight registry but never flips this view's local `busy`,
  // and because `session.id` is unchanged the re-seed effect above doesn't
  // re-run. The result the user reported: an injected message streams tokens
  // but shows no "Working…" status, and nothing at all in the pre-first-token
  // gap. Subscribe to the registry and mirror the marker for the bound session
  // so every turn — typed here or injected elsewhere — lights the same
  // indicator. We only ever turn it ON here: turning it OFF is owned by the
  // stream's terminal end/error chunk (this view listens to `sid`'s channel)
  // and the local send/stop paths. A marker-driven OFF would wrongly stomp
  // `busy` for turns that run without a registry marker (edit-and-resend).
  useEffect(() => {
    const adopt = () => {
      if (isManagerTurnInFlight(session.id)) setBusy(true);
    };
    const unsub = subscribeManagerTurns(adopt);
    // A turn may have armed between this session binding and the subscribe;
    // reconcile once so we don't miss that edge.
    adopt();
    return unsub;
  }, [session.id]);

  // Drop the slash log when the session changes — it's session-scoped (a fresh
  // conversation starts with no ephemeral slash output shown).
  useEffect(() => {
    setSlashLog([]);
    setVisibleCount(CHAT_WINDOW_INITIAL);
    setFindOpen(false);
  }, [session.id]);

  const pinToBottom = useCallback(() => {
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
  }, []);

  // The live bubble re-pins itself as it grows (see `<StreamingBlocks>` below),
  // so this only has to cover the things THIS component renders.
  useEffect(() => {
    pinToBottom();
  }, [
    pinToBottom,
    timeline.length,
    busy,
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

  // What the running agent is offering here, when the brain for the next
  // turn is one that hosts an agent process (OpenCode over ACP, pi).
  // Same resolution order the turn itself uses, so the composer's commands
  // and mode belong to the engine the next message will actually reach.
  const turnBrainId =
    brainOverride?.id ??
    modelOverride?.brainId ??
    activeBrain?.provider_id ??
    null;
  const agent = useAgentSurface(turnBrainId, resolvedRepoRoot, busy);
  const agentLabel = brainOverride?.label ?? liveAgentLabel(turnBrainId);
  const agentSlashRows = useMemo<SlashItem[]>(
    () =>
      agent.surface.commands.map((c) => ({
        name: c.name.replace(/^\//, ""),
        summary: c.description,
        source: "agent" as const,
        badge: agentLabel ?? undefined,
      })),
    [agent.surface.commands, agentLabel],
  );

  const send = useCallback(
    async (
      msg: string,
      attachments: ComposerAttachment[] = [],
      mode: "auto" | "plan" | "build" | "ask" = "build",
      pipeTargetSessionId: string | null = null,
      effort: ReasoningEffort | null = null,
      fast: boolean = false,
      approval: ApprovalPolicy | null = null,
      goal: boolean = false,
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
      // A non-handled result can carry `forwardText`: the verb
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
          const bytes = Array.from(new TextEncoder().encode(trimmed + "\r"));
          await api.agentPtyWrite(pipeTargetSessionId, bytes);
          pipeMarker =
            "[↪ PIPED. User also wrote this message directly into an open agent PTY tab. Do NOT dispatch a new agent for the same ask; respond conversationally and only act if explicitly asked.]\n\n";
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
            text: "Planning this first. I'll lay out a plan, then you hit Build to run it. You're still on Auto.",
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
      // Record which brain THIS turn runs on (override → picked model's brain →
      // global active), rolling the prior value into `prev`, so the render can
      // show a live "Continued on X" divider the moment a switch goes in-flight
      // — before the new brain has streamed (or persisted) anything.
      liveTurnBrainRef.current = {
        cur:
          brainOverride?.id ??
          modelOverride?.brainId ??
          activeBrain?.provider_id ??
          null,
        prev: liveTurnBrainRef.current.cur,
      };
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
      // Sent as a goal — record it durably (session-tagged, so the Goals
      // workbench sees it) and lead the turn with the goal steering block so
      // the brain treats it as a standing outcome to plan through the crew loop
      // and prove. The block is strippable + drives the "Sent as goal" badge on
      // the bubble; unlike mode steering it's per-message (always sent when
      // armed), never suppressed by the standing-directive de-dupe.
      const goalDirective = goal ? buildGoalDirective() : "";
      if (goal && resolvedRepoRoot && outbound) {
        try {
          attachSessionGoal(resolvedRepoRoot, outbound, session.id);
        } catch (e) {
          console.warn("[goal] attach failed", e);
        }
      }
      const finalText = goalDirective + pipeMarker + steering + outbound;
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
              model: turnModel(machineBrain, modelOverride)?.modelId ?? null,
              long_context: turnModel(machineBrain, modelOverride)?.longContext ?? false,
              // #254 — per-turn permission/autonomy policy. Null → the
              // brain stays on its own ask-flow (byte-identical request).
              // Native brains carry it but run their own tool loop; CLI
              // wrappers map it to a real per-agent permission flag.
              approval,
              // AURA-1296 — the composer's Concise chip. Null → nothing added
              // to the request; "concise" → Claude Code's `--output-style`.
              output_style: outputStyleArg(readOutputStyle()),
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
          // Review comments that rode along are now with the agent.
          markSentComments(attachments.map((a) => a.name));
        }
      } catch (e) {
        lastExitRef.current = "error";
        // The dispatch threw before any turn started streaming (e.g. the
        // invoke rejected) — no detached run exists, so retire the marker.
        clearManagerTurnInFlight(session.id);
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
        // AURA-1296 — nothing was persisted, so the words are only here. Keep
        // them, with the settings they were sent under, for Restart and resend.
        setUndelivered({
          text: trimmed,
          reason: e instanceof Error ? e.message : String(e),
          args: [
            msg,
            attachments,
            mode,
            pipeTargetSessionId,
            effort,
            fast,
            approval,
            goal,
          ],
        });
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
      goal: boolean = false,
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
          goal,
        },
      ]);
    },
    [],
  );

  // Halt the in-flight turn. Shared by the composer's Stop button and the
  // stall watchdog's Stop, so both paths cancel identically.
  const stopTurn = useCallback(() => {
    // Stop is not a clean turn-end — mark it so the queue does NOT drain the
    // next message (the bug was Stop advancing the queue instead of halting).
    // The queue itself is preserved, not cleared.
    lastExitRef.current = "stop";
    // #294 — preserve what already printed. The native path's backend Drop
    // guard persists the partial turn and emits End{interrupted}, whose
    // handler retires the live blocks AND drops an "Interrupted" marker — so we
    // must NOT wipe streamBlocks here (that's what made printed output
    // vanish). The legacy path has no such guard, so we keep its old reset.
    // Explicit Stop — retire the in-flight marker on both paths (the
    // interrupted End may arrive after the surface is already gone, so don't
    // rely on the chunk handler alone to clear it).
    clearManagerTurnInFlight(session.id);
    if (inflightNativeRef.current) {
      void api.brainChatCancel(session.id).catch(() => {});
      setBusy(false);
    } else {
      void api.managerCancel(session.id).catch(() => {});
      setBusy(false);
      setStreamBlocks([]);
    }
  }, [session.id]);

  // Steer — redirect the running turn instead of waiting for it to finish.
  // (⌘↵, or plain ↵ when the follow-up pref is "steer".) Idle steers are just
  // sends. While busy: park the message at the FRONT of the queue, flag the
  // steer, and interrupt the turn. The interrupt persists the partial turn
  // server-side (context is kept) and flips busy→false; the drain effect then
  // fires this head as a fresh turn that picks up right where the agent was.
  // We intentionally do NOT setBusy(false) ourselves on the native path — we
  // let the interrupted End land first so the old turn's listener fully retires
  // before the new turn starts (same safe ordering the clean-end drain gets).
  const steer = useCallback(
    (
      message: string,
      attachments: ComposerAttachment[],
      mode: "auto" | "plan" | "build" | "ask",
      pipeTargetSessionId: string | null,
      effort: ReasoningEffort | null,
      fast: boolean,
      approval: ApprovalPolicy | null,
      goal: boolean = false,
    ) => {
      const payload = {
        id: newQueueId(),
        text: message,
        attachments,
        mode,
        pipeTargetSessionId,
        effort,
        fast,
        approval,
        goal,
      };
      // Nothing to redirect — behave like a normal send.
      if (!busy) {
        void send(
          message,
          attachments,
          mode,
          pipeTargetSessionId,
          effort,
          fast,
          approval,
          goal,
        );
        return;
      }
      steerPendingRef.current = true;
      setQueue((q) => [payload, ...q]);
      // Interrupt the in-flight turn. The partial turn is persisted, so the
      // redirect's fresh turn resumes with full context.
      clearManagerTurnInFlight(session.id);
      if (inflightNativeRef.current) {
        // Native brain: let the interrupted End flip busy→false and trigger the
        // drain (avoids re-sending mid-teardown).
        void api.brainChatCancel(session.id).catch(() => {});
        // Fallback so the redirect can never get stuck. The native path relies
        // on the interrupted `end` chunk arriving to flip busy→false and fire
        // the drain that turns this parked message into a real turn. If the
        // brain closes the stream without a clean terminator — a dropped
        // socket, or a cancel that races the turn's own natural end — that
        // chunk never lands and the steered message sits in the queue forever,
        // invisible as a chat bubble. This was the "steered message doesn't
        // come up in the chat view" report. Arm a short timer: if we're still
        // waiting when it fires (steerPendingRef not yet consumed by the real
        // end/drain), force the busy true→false transition ourselves so the
        // drain runs. `steerPendingRef` is the whole signal: the drain consumes
        // it atomically, so a still-true flag means neither the real end nor a
        // Stop has drained yet — this timer is the only thing left to unstick
        // it. It no-ops the instant the real end lands first.
        window.setTimeout(() => {
          if (!steerPendingRef.current) return; // real end already drained it
          setStreamBlocks([]);
          setBusy(false);
        }, 2000);
      } else {
        // Legacy/PTY path emits no End — flip busy here so the drain fires.
        void api.managerCancel(session.id).catch(() => {});
        setStreamBlocks([]);
        setBusy(false);
      }
    },
    [busy, send, session.id],
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
  // A steer is the one non-clean exit that MUST drain — the interrupt clobbers
  // lastExitRef to "stop", so steerPendingRef carries the "fire now" intent
  // across it; we consume the flag the instant we drain.
  const prevBusyRef = useRef(busy);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    // Only the true busy→idle transition drains — and only then do we consume
    // the steer flag, so intermediate re-renders (e.g. the setQueue that parks
    // the steer message while the interrupt is still in flight) don't clear it
    // early and swallow the redirect.
    if (
      wasBusy &&
      !busy &&
      (lastExitRef.current === "clean" || steerPendingRef.current)
    ) {
      steerPendingRef.current = false;
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
            head.goal ?? false,
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
  // arrives. The inline PlanCard stays in the chat as a
  // condensed reference, but the rich detail view (mermaid + phases +
  // file refs) lives in the tab. We track which plan ids we've already
  // popped so a re-render of the same plan doesn't re-open the tab.
  const editor = useEditorStore();
  // Where conversations this view hands you open: a tab (no host), or Aura's
  // panel on Home, which switches itself instead.
  const host = useChatHost();
  // Which projects a turn acted on is worth a chip only where there is a
  // choice of project — Aura's conversation, bound to several. In a single
  // project's chat every chip would name the project you are already in.
  const showTurnProjects = host?.scope === "aura" || (session.projects?.length ?? 0) > 1;
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
  }, [
    session.pending_plan,
    session.id,
    session.projects,
    editor,
    resolvedRepoRoot,
  ]);

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
            await openPopout({
              kind: "manager",
              root,
              sessionId: newSid,
              label,
            });
            return;
          }
          // No repo root to scope a window to — fall back to an in-app tab.
        }
        if (host) host.openSession(newSid, label);
        else editor.openManager(newSid, label);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [session.id, session.objective, session.projects, editor, resolvedRepoRoot, host],
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
  const runningTool = busy ? liveRunningTool : null;

  // Brain of the most recent PERSISTED assistant turn (nearest-first). Native
  // brain_chat_turn turns don't persist a brain, so this can be null even mid-
  // conversation; the live-handoff fallback below covers that across remounts.
  const lastPersistedBrain = useMemo<string | null>(() => {
    const chat = session.chat ?? [];
    for (let j = chat.length - 1; j >= 0; j--) {
      const t = chat[j];
      if (t.role !== "user" && t.brain) return t.brain;
    }
    return null;
  }, [session.chat]);

  // #1 — live brain-handoff divider. The persisted "Continued on X" divider
  // only lands once a turn on the new brain is SAVED, so switching to a brain
  // that then streams nothing (a stuck CLI wrapper like Kimi) left the switch
  // invisible. This surfaces the handoff the instant the turn goes in-flight.
  // `cur` is the brain this turn runs on; `prev` is the last turn's brain in
  // this view, falling back to the last persisted assistant brain across a
  // remount. Compared by display label so id families (`anthropic` vs
  // `anthropic_native`, `cli:kimi` vs `moonshot`) don't false-trigger. Cleared
  // when the turn settles (busy→false); the persisted divider then takes over.
  const liveHandoffBrain: string | null = (() => {
    if (!busy) return null;
    const cur = liveTurnBrainRef.current.cur;
    if (!cur) return null;
    const prev = liveTurnBrainRef.current.prev ?? lastPersistedBrain;
    if (!prev) return null;
    return humanizeBrainId(cur) !== humanizeBrainId(prev) ? cur : null;
  })();
  // Human label of the in-flight brain, for the stall watchdog's copy.
  const liveBrainLabel = liveTurnBrainRef.current.cur
    ? humanizeBrainId(liveTurnBrainRef.current.cur)
    : undefined;

  const hasLiveContent =
    timeline.length > 0 ||
    hasStreamBlocks ||
    busy ||
    planBuilding ||
    !!session.pending_question ||
    !!session.pending_plan ||
    !!session.pending_scout;
  if (hasLiveContent) hadContentRef.current = true;
  const showEmptyState = !hasLiveContent && !hadContentRef.current && !error;
  // Questions of every kind share one focused flow above the composer.
  const fuseQuestion = !!session.pending_question && queue.length === 0;
  // The plan-paused banner fuses onto the composer the same way a docked
  // question does — one stacked panel, no floating gap. Only when nothing
  // (a queued message) sits between them in the dock.
  const fusePlan =
    !!session.pending_plan && !session.pending_question && queue.length === 0;
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
    (turnGroups.consumed.has(windowStart) ||
      scoutGroups.consumed.has(windowStart)) &&
    !turnGroups.startAt.has(windowStart) &&
    !scoutGroups.startAt.has(windowStart)
  ) {
    windowStart--;
  }
  const hiddenCount = windowStart;
  return (
    <ChatRepoRootContext.Provider value={repoRootForChat}>
      <ChatSpendContext.Provider value={chatSpend}>
        <div
          className="relative flex flex-col h-full min-h-0"
          onKeyDown={(e) => {
            // ⌘F finds in this conversation, from the composer or anywhere
            // else in the pane that holds focus.
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
              e.preventDefault();
              e.stopPropagation();
              openFind();
            }
          }}
        >
          {/* Scroll region + scrollback rail share ONE positioning context so the
          rail spans only the messages and ends above the composer dock (not
          running to the very bottom of the pane). Also an OS-drop zone for
          "composer": a file dragged from Finder onto the conversation (not
          just the tiny input box) routes to the composer as an attachment. */}
          <div
            className="relative flex-1 min-h-0 flex flex-col"
            data-os-drop="composer"
          >
            {findOpen && (
              <ChatFind
                scrollRef={scrollRef}
                revision={timeline}
                onClose={() => setFindOpen(false)}
              />
            )}
            <ChatTranscript ref={scrollRef} onScroll={onScroll}>
              {showEmptyState && (
                <ChatEmptyState
                  projectLabel={session.projects[0]?.label}
                  repoRoot={repoRootForChat ?? undefined}
                  machineName={machineName ?? undefined}
                  sessionId={session.id}
                />
              )}
              {hiddenCount > 0 && <HistoryGap onLoad={revealEarlier} />}
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
                    {node && <TurnErrorBoundary>{node}</TurnErrorBoundary>}
                  </Fragment>
                );

                function renderTimelineEntry() {
                  // Settled-Scout block — the first index of a finalized Scout run
                  // renders the regrouped agent block; every other folded-in system
                  // line renders nothing (its content lives in the block).
                  if (scoutGroups.startAt.has(idx)) {
                    const specs = scoutGroups.startAt.get(idx)!;
                    return specs.length > 0 ? (
                      <SettledScoutBlock specialists={specs} />
                    ) : null;
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
                          renderAssistantTurn(
                            m,
                            true,
                            i === members.length - 1,
                          ),
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
                  const chatIndex = session.chat
                    ? session.chat.indexOf(turn)
                    : -1;
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
                      if (
                        p.kind === "turn" &&
                        p.turn.role !== "user" &&
                        p.turn.brain
                      ) {
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
                      {showTurnProjects && <TurnProjectChips turn={turn} />}
                    </div>
                  );
                }
              })}
              {liveHandoffBrain && (
                // #1 — the switch shows the instant the turn goes in-flight, above
                // the live area, instead of waiting for a turn on the new brain to
                // persist (which never happens when that brain hangs with no output).
                <BrainHandoffDivider
                  brain={liveHandoffBrain}
                  chat={session.chat ?? []}
                />
              )}
              {/* Subscribes to the stream store itself, so a token re-renders this
            subtree alone — the settled timeline above stays mounted and
            untouched. It renders nothing until a block lands, and owns the
            scroll re-pin at the same post-commit moment this component's own
            blocks-keyed effect used to run it. */}
              <StreamingBlocks
                store={streamStore}
                streaming={busy}
                onAdvance={pinToBottom}
              />
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
              {/* The running agent's own plan, when the brain for this turn is
            one that keeps a live agent. Sits with the other live strips
            rather than in the transcript — it is what the agent intends
            *now*, restated in full whenever it changes. */}
              <AgentPlanStrip
                plan={agent.surface.plan}
                agentLabel={agentLabel}
              />
              {/* ScoutCard precedes PlanCard. While Scout is in flight, the
            brain's plan envelope is parked and we render the live
            specialist card; once Scout finalizes, `pending_scout`
            clears and `pending_plan` populates so PlanCard takes over. */}
              {session.pending_scout && (
                <ScoutCard
                  sessionId={session.id}
                  scout={session.pending_scout}
                />
              )}
              {/* PlanCard renders INLINE in the timeline — not docked at the
            bottom — so the prepared plan flows as a chat element next to the
            agent's prose, then the user can either decide inline or click
            its title to open it as a full PlanTab. */}
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
                !error &&
                (planBuilding ? (
                  <PlanningStatusLine
                    label="Building your plan"
                    startedAt={turnStartRef.current}
                  />
                ) : runningTool ? // atop the composer already carries the live "Running … · 12s" // A command is running — the docked RunningCommandStatus strip
                // status, so suppress the generic "Working…" line here to avoid
                // two near-identical in-flight rows stacked on each other.
                null : hasStreamBlocks ? (
                  // The answer is already streaming above — keep a quiet, timed
                  // "Working…" line beneath it so the turn never looks finished
                  // while the brain is still producing tokens or running tools.
                  <ThinkingLine
                    label="Working…"
                    startedAt={turnStartRef.current}
                  />
                ) : justAnswered ? (
                  <PlanningStatusLine startedAt={turnStartRef.current} />
                ) : (
                  <ThinkingLine startedAt={turnStartRef.current} />
                ))}
              {/* #3 — stall watchdog. When a turn is genuinely waiting on the brain
            (not building a plan, not running a tool, no pending question/plan)
            and it has streamed nothing for a while, surface a calm "may be
            stuck" notice with a Stop. Anchored on last-activity, so a turn that
            keeps producing output never trips it — only true silence (a hung
            CLI wrapper) does. Suppressed while a tool runs: that has its own
            live timer and is legitimately long. */}
              {busy &&
                !planBuilding &&
                !runningTool &&
                !session.pending_question &&
                !session.pending_plan &&
                !session.pending_scout &&
                !error && (
                  <StallNotice
                    getIdleSince={() => lastActivityRef.current}
                    brainLabel={liveBrainLabel}
                    onStop={stopTurn}
                  />
                )}
              {/* AURA-1296 — the undeliverable notice carries the error text
            itself, so the plain red line steps aside while it is showing. */}
              {undelivered && (
                <UndeliverableMessage
                  text={undelivered.text}
                  reason={undelivered.reason}
                  onDismiss={() => {
                    setUndelivered(null);
                    setError(null);
                  }}
                  onRestart={async () => {
                    const args = undelivered.args;
                    // Bring the session back first; a session that is already
                    // running answers with an error we don't care about.
                    await api.managerResume(session.id).catch(() => {});
                    setUndelivered(null);
                    setError(null);
                    await send(...args);
                  }}
                />
              )}
              {error && !undelivered && (
                <ChatRecovery
                  kind="generic"
                  detail={error}
                  action={{ label: "Dismiss", onClick: () => setError(null) }}
                />
              )}
            </ChatTranscript>
            {/* Scrollback rail — a slim minimap on the right edge for jumping
          between turns in a long conversation. Reads bubble offsets off the
          live scroll DOM (the `data-rail-id` stamps above); self-hides when
          there are fewer than two turns. */}
            <MessageScrollbackRail
              scrollRef={scrollRef}
              anchors={railAnchors}
              describe={describeTurn}
            />
            {awayFromLatest && !showEmptyState && (
              <Button
                className="ui-conversation-bottom"
                size="sm"
                variant="secondary"
                onClick={jumpToLatest}
              >
                <ArrowDown />
                Jump to latest
              </Button>
            )}
          </div>
          {/* The fixed footer has a shared separator and compact inset composer. */}
          <ChatComposerArea
            data-os-drop="composer"
            style={{
              // A docked choice/multi question — the plan-paused banner — or the
              // `/resume` picker fuses onto the composer as one panel; drop the
              // dock's flex gap so they meet on a single hairline. (A non-empty
              // queue sits between them, so only fuse when it's empty.)
              gap: fuseQuestion || fusePlan || fuseResume ? 0 : undefined,
            }}
          >
            {session.pending_question && (
              <QuestionCard
                key={session.pending_question.tool_use_id}
                sessionId={session.id}
                question={session.pending_question}
                docked={fuseQuestion}
                onError={setError}
                onAnswered={onQuestionAnswered}
              />
            )}
            {/* Brain paused on plan decision. The composer stays interactive
            — sending a message starts a fresh turn — but the user often
            reads "no agent reply" as "input is broken". This hint
            clarifies what's happening and points at the resolution. */}
            {session.pending_plan && !session.pending_question && (
              <PlanReview
                className={`chat-plan-review${fusePlan ? " is-docked" : ""}`}
                title={session.pending_plan.title}
                status="Review the plan before building"
                actions={
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => {
                      const plan = session.pending_plan;
                      if (plan)
                        openPlanWizard(
                          pendingPlanToTabInput(plan),
                          resolvedRepoRoot,
                          session.id,
                        );
                    }}
                  >
                    Review plan <SquareArrowOutUpRight />
                  </Button>
                }
              />
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
                        .managerImportAgentSession(
                          row.agentId,
                          root,
                          row.agentSessionId,
                        )
                        .then((newSid) =>
                          host
                            ? host.openSession(newSid, row.title)
                            : openManagerSession(newSid, row.title),
                        )
                        .catch(() => openChatHistory(session.id));
                    }
                  } else if (host) {
                    host.openSession(row.id, row.title);
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
            flush atop the composer in the queued-messages strip's docked frame
            (rounded top, no bottom seam) so it reads as one unit with the input
            while the turn runs, then collapses away the moment it finishes. */}
            {showEmptyState && (
              <ChatStarters
                repoRoot={repoRootForChat}
                sessionId={session.id}
                onPick={(prompt) => {
                  // A starter is a message the user sent; up-arrow should
                  // find it like one they typed.
                  rememberSent(composerKey(MANAGER_HISTORY_PREFIX, session.id), prompt);
                  void send(prompt, [], "ask");
                }}
              />
            )}
            {runningTool && <RunningCommandStatus tool={runningTool} docked />}
            <ManagerComposer
              repoRoot={resolvedRepoRoot}
              workspaceLabel={session.projects[0]?.label}
              linkAgentId={turnBrainId}
              linkAgentLabel={agentLabel}
              planAwaitingReply={!!session.pending_plan}
              history={
                <ChatHistoryMenu currentSessionId={session.id} repoRoot={resolvedRepoRoot} />
              }
              // Same composer, one changed word. `@mention files` is dropped on a
              // remote conversation because the picker indexes this laptop's
              // checkout — offering it would attach the wrong copy of a file that
              // exists in both places, which is worse than not offering it.
              placeholder={
                machineName
                  ? `Ask about the code on ${machineName}, run /commands`
                  : undefined
              }
              // Square the composer's top so the docked running strip (which rounds
              // only its top) meets it on a single hairline — one stacked unit, no
              // floating gap — exactly as the question/plan/resume banners fuse.
              docked={fuseQuestion || fusePlan || !!runningTool}
              busy={busy}
              usage={usage}
              spend={spend}
              sessionId={session.id}
              // Presence enables the composer's Goal toggle. The toggle no longer
              // fires on click — arming it tags the next Send (the `goal` flag on
              // onSend/onQueue), which routes the message into the chat with a
              // "Sent as goal" badge and steers the brain to plan it via the crew
              // loop. This callback is kept only as the enable-gate.
              onPlanGoal={() => {}}
              onBrainOverrideChange={setBrainOverride}
              modelOverride={modelOverride}
              onModelOverrideChange={setModelOverride}
              machineBrain={machineBrain}
              onSend={(
                msg,
                attachments,
                mode,
                pipeTo,
                effort,
                fast,
                approval,
                goal,
              ) =>
                void send(
                  msg,
                  attachments,
                  mode,
                  pipeTo,
                  effort,
                  fast,
                  approval,
                  goal,
                )
              }
              onQueue={(
                msg,
                attachments,
                mode,
                pipeTo,
                effort,
                fast,
                approval,
                goal,
              ) =>
                enqueue(
                  msg,
                  attachments,
                  mode,
                  pipeTo,
                  effort,
                  fast,
                  approval,
                  goal,
                )
              }
              onSteer={(
                msg,
                attachments,
                mode,
                pipeTo,
                effort,
                fast,
                approval,
                goal,
              ) =>
                steer(
                  msg,
                  attachments,
                  mode,
                  pipeTo,
                  effort,
                  fast,
                  approval,
                  goal,
                )
              }
              onStop={stopTurn}
              agentCommands={agentSlashRows}
              agentModes={agent.surface.modes}
              agentMode={agent.surface.current_mode}
              onAgentModeChange={agent.setMode}
              agentModeError={agent.modeError}
            />
          </ChatComposerArea>
        </div>
      </ChatSpendContext.Provider>
    </ChatRepoRootContext.Provider>
  );
}
