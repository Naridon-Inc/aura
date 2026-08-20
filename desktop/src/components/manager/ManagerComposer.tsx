// Cursor-style chat composer for the Manager tab. Renders the prototype's
// `.composer` block (Stage 11.6 — Forge Chat-States port): a transparent
// textarea sits on top, then a `.composer-bottom` row carries the Plan
// mode chip, the model selector chip, attach/mic icon-buttons, and the
// accent send-btn. The outer `.p-dock` wrapper is the parent's
// responsibility — this component owns only the `.composer` itself, so
// inline cards (Question/Plan) can be docked above it without breaking
// the dock's gap rhythm.
//
// Mode is a visual chip only — the brain decides plan vs build via
// `aura propose-plan` heuristics. We don't mangle the user's text with
// a prefix; the bubble shows exactly what they typed.
//
// Image paste flows through `onPaste` on the textarea AND a window-level
// listener that auto-routes Cmd+V / Ctrl+V to the composer when focus
// isn't inside any input — covers the Tauri WebKit case where the user
// clicks the chat scrollback before pasting and Cmd+V silently no-ops.
//
// Attachments are wired end-to-end: the composer reads each File via
// FileReader.readAsDataURL, strips the `data:<mime>;base64,` prefix,
// and forwards `{media_type, data_base64, name}` triples to onSend.
// The Tauri `manager_chat` cmd persists them on the user ChatTurn and
// the brain emits one `image` content block per attachment to the
// Anthropic Messages API. 20MB cap per file is enforced at ingest.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { BrainPicker } from "./BrainPicker";
import { UsagePopover } from "./chat/UsagePopover";
import { useClaudeUsage } from "./chat/ClaudeUsageRing";
import { type TokenUsage, type TurnSpend } from "./chat/types";
import {
  api,
  type AgentMode,
  type BrainChoice,
  type ReasoningEffort,
  type ApprovalPolicy,
} from "../../lib/api";
import {
  OS_FILE_DROP_COMPOSER,
  OS_FILE_DRAG,
} from "../../lib/osFileDrop";
import { type SelectedModel } from "../../lib/modelCatalog";
import { ModelDefaultsPanel } from "./ModelDefaultsPanel";
import { registerComposerInserter } from "../../lib/composerBridge";
import { useFollowUpBehavior } from "../../lib/followUpBehavior";
import {
  TiptapComposer,
  type SlashItem,
  type TiptapComposerHandle,
} from "./TiptapComposer";
import { ChipButton } from "../ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  CheckMini,
  Sparkles,
  ShieldCheck,
  PencilSquare,
  Eye,
  Bolt,
  RocketLaunch,
  CommandLine,
  Map as MapIcon,
  ChatBubble,
} from "@medusajs/icons";
import { Kbd } from "../ui/kbd";
import { Button } from "../ui/button";
import { readTerminalContext } from "../Terminal";
import { useEditorStore } from "../../lib/editorStore";
import { useDismiss } from "../../lib/useDismiss";
import {
  composerKey,
  pushHistory,
  readDraft,
  readHistory,
  writeDraft,
  writeHistory,
} from "../composer/composerDrafts";

type ComposerImage = {
  id: string;
  /** image | text | path — drives how the preview tile renders + how
   *  the bytes are read at submit. (M.5) */
  kind: "image" | "text" | "path";
  name: string;
  /** Object URL for images, or a short text preview for text/path. */
  preview_url: string;
  /** Held until submit so we can read base64/utf8 lazily. Kept off the
   *  network/IPC path until the user actually presses Send. Null for
   *  kind=path entries — those carry only `pathValue`. */
  file: File | null;
  /** Filesystem path string for kind=path drops (folders or files that
   *  the OS handed us as text instead of as a File handle). */
  pathValue?: string;
};

export type ComposerAttachment = {
  media_type: string;
  data_base64: string;
  name?: string | null;
};

export type ComposerMode = "auto" | "plan" | "build" | "ask";

// Minimal shape of the Web Speech API. The DOM lib doesn't ship these
// types and we'd rather avoid a separate dependency for one button.
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  /** Graceful: finishes the utterance, then fires `onend`. */
  stop(): void;
  /** Immediate: drops the utterance and releases the input device now.
   *  Optional because the DOM lib doesn't type the Web Speech API at all and
   *  we can't assume every WebView ships it. */
  abort?(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: ((e: unknown) => void) | null;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
type SpeechRecognitionEventLike = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

type Props = {
  /** Working directory shown in the workspace pill + used for git probes. */
  repoRoot: string | null;
  /** Friendly workspace label (folder name). Falls back to last path segment. */
  workspaceLabel?: string;
  /** True while the brain is mid-turn — disables the send button + textarea. */
  busy: boolean;
  /** Last-turn context fill from the native brain. Drives a slim context-window
   *  meter in the composer's bottom row. Null (CLI brains / no report) hides it. */
  usage?: TokenUsage | null;
  spend?: TurnSpend | null;
  /** Optional placeholder override (e.g. "Add more optional details"). */
  placeholder?: string;
  /** Fires on Enter (no shift) or Send click. Receives the trimmed text
   *  and any pasted/dropped image attachments (already base64-encoded).
   *  Caller is responsible for clearing `text` (we don't manage it
   *  externally). */
  /** The composer's current Plan/Build/Ask chip is part of every send so
   *  the chat view can prepend a steering directive to the user message
   *  (the brain has no separate mode parameter). */
  onSend: (
    message: string,
    attachments: ComposerAttachment[],
    mode: ComposerMode,
    /** When non-null, the same trimmed text is also written into the
     *  named agent PTY session — so the Manager can drive an already-
     *  open Claude / Gemini / Codex tab while still recording the
     *  message as a normal Manager turn (the brain stays in the loop).
     *  Null = pure Manager send, no PTY pipe. */
    pipeTargetSessionId: string | null,
    /** Reasoning effort for this turn — null = provider default. Threaded
     *  into `brain_chat_turn`'s context; each brain maps it to its own real
     *  mechanism (Anthropic/Gemini budgets, OpenAI effort, CLI keyword). */
    effort: ReasoningEffort | null,
    /** Latency-first (⚡) — collapse effort to the provider minimum. */
    fast: boolean,
    /** Permission/autonomy policy for this turn — null = the agent's own
     *  default ask-flow. Threaded into `brain_chat_turn`'s context; each
     *  CLI maps it to its real permission flag (Claude `--permission-mode`,
     *  Gemini `--approval-mode`, Codex `--sandbox`), thin CLIs get a
     *  read-only Plan steer. Cross-agent — applies to whichever brain runs. */
    approval: ApprovalPolicy | null,
    /** The Goal toggle was armed for this send — tag the turn as a goal so it
     *  lands in the chat with a "Sent as goal" badge and the brain is steered
     *  to plan it through the crew loop and prove it. */
    goal: boolean,
  ) => void;
  /** Cancel an in-flight brain turn. When `busy` is true the send button
   *  flips into a Stop button that fires this handler. */
  onStop?: () => void;
  /** Presence enables the composer's Goal toggle. The toggle no longer fires
   *  anything on click — it just arms the next send (see the `goal` flag on
   *  `onSend`/`onQueue`); this callback is kept only as the enable-gate so a
   *  composer with no goal wiring hides the chip. */
  onPlanGoal?: (goal: string) => void;
  /** Manager session id — required to wire the BrainPicker (WW-B3) so a
   *  brain swap persists on the right session. Null hides the picker. */
  sessionId?: string | null;
  /** Lifts a BrainPicker brain selection (or null for Auto) to the parent —
   *  the brain the lifted model routes through. Owned by ManagerChatView. */
  onBrainOverrideChange?: (choice: BrainChoice | null) => void;
  /** The exact model the next turn runs (composer model picker, #251).
   *  Owned by ManagerChatView so the send path threads `model` +
   *  `long_context` into `brain_chat_turn`. Null = the brain's default. */
  modelOverride?: SelectedModel | null;
  /** Lifts the per-turn model selection (or null for Auto) to the parent. */
  onModelOverrideChange?: (model: SelectedModel | null) => void;
  /** Type-ahead queue (W2). When `busy`, a submit parks the message here
   *  instead of dropping it — same payload shape as `onSend`. The parent
   *  drains the queue on turn-end. Absent → busy submits are no-ops (the
   *  pre-queue behavior). Agent-agnostic: sits above dispatch, so it works
   *  the same for a native brain and a piped CLI PTY. */
  onQueue?: (
    message: string,
    attachments: ComposerAttachment[],
    mode: ComposerMode,
    pipeTargetSessionId: string | null,
    effort: ReasoningEffort | null,
    fast: boolean,
    approval: ApprovalPolicy | null,
    goal: boolean,
  ) => void;
  /** Steer (redirect) an in-flight turn. Same payload shape as `onQueue`, but
   *  instead of parking for the current turn's end this interrupts it and
   *  immediately re-runs with the new message so the agent changes course
   *  mid-flight (the partial turn is persisted, so context is kept). Fires when
   *  the follow-up-behavior pref is "steer", or on ⌘↵ regardless of the pref.
   *  Absent → steer submits fall back to `onQueue`. */
  onSteer?: (
    message: string,
    attachments: ComposerAttachment[],
    mode: ComposerMode,
    pipeTargetSessionId: string | null,
    effort: ReasoningEffort | null,
    fast: boolean,
    approval: ApprovalPolicy | null,
    goal: boolean,
  ) => void;
  /** Fuse the composer onto a pending-question card docked directly above it:
   *  drop the top border + square the top corners so the question card and the
   *  input read as one stacked panel (the card rounds only its top). False =
   *  the standalone rounded composer. */
  docked?: boolean;
  /** Slash commands the running agent published for itself — merged into
   *  the `/` menu below Aura's verbs and the repo's Claude commands. */
  agentCommands?: SlashItem[];
  /** Modes the running agent can actually be put into, if it has any.
   *  Present → the Mode chip stops being a prompt steer and becomes a real
   *  control on a real process (OpenCode's plan mode refuses every edit
   *  tool), so the chip says which of the two it is. */
  agentModes?: AgentMode[];
  /** The mode the agent reports it is in right now. Diverges from the
   *  chip's own label when the agent switched itself mid-turn, which is
   *  worth showing rather than papering over. */
  agentMode?: string | null;
  /** Push a mode to the agent. Rejects if the agent won't take it — the
   *  caller surfaces that rather than leaving the chip claiming a
   *  read-only mode the agent never entered. */
  onAgentModeChange?: (modeId: string) => Promise<void>;
  /** Last mode switch the agent refused, in its own words. */
  agentModeError?: string | null;
};

/** Which of the agent's own modes an Aura mode means.
 *
 * Aura's chip is four positions and an agent's is usually two, so this is
 * a narrowing, not a mapping: everything that promises not to edit
 * (`plan`, `ask`) asks for the agent's plan mode, and everything that
 * expects work done takes whatever else it offers. Matching on the id
 * rather than a per-agent table means an agent with modes we have never
 * heard of still gets the read-only half right. */
export function agentModeFor(
  mode: ComposerMode,
  modes: AgentMode[],
): string | null {
  if (modes.length === 0) return null;
  const readOnly = mode === "plan" || mode === "ask";
  const planLike = modes.find((m) => /plan/i.test(m.id) || /plan/i.test(m.name));
  if (readOnly) return planLike?.id ?? null;
  return (modes.find((m) => m !== planLike) ?? modes[0]).id;
}

// `hint` is the full description (the trigger tooltip); `blurb` is the 1-3 word
// inline note shown on the menu row, kept tight so rows stay single-line.
const MODE_OPTIONS: { value: ComposerMode; label: string; hint: string; blurb: string }[] = [
  // "Autopilot", not "Auto" — the model chip on this same bar says Auto when
  // nothing is pinned, and the two sit 220px apart meaning different things.
  // The stored value stays "auto" (aura.manager.mode), so nobody's setting moves.
  { value: "auto", label: "Autopilot", hint: "Decides, builds and finishes, never stops to ask", blurb: "no pauses" },
  { value: "build", label: "Build", hint: "Make the changes end-to-end", blurb: "make changes" },
  { value: "plan", label: "Plan", hint: "Discuss and plan before any edits", blurb: "plan first" },
  { value: "ask", label: "Ask", hint: "Read-only chat. No edits", blurb: "read-only" },
];

const MODE_KEY = "aura.manager.mode";
const EFFORT_KEY = "aura.manager.effort";
const FAST_KEY = "aura.manager.fast";
const APPROVAL_KEY = "aura.manager.approval";

// Per-session composer draft and the up-arrow recall ring. Unlike the chips
// above (global), a half-typed message belongs to ONE conversation — switching
// Manager sessions must not bleed drafts across them, so the key carries the
// session id. A null session (picker hidden / pre-session) folds onto one
// shared slot.
//
// The rules themselves now live in `components/composer/composerDrafts`, because
// the agent chat's composer needs byte-identical behaviour for a CLI session and
// a second copy is how the edges drift. This file keeps only the namespace.
const DRAFT_PREFIX = "aura.manager.draft:";
function draftKey(sessionId?: string | null): string {
  return composerKey(DRAFT_PREFIX, sessionId);
}

// We store the RAW text the user typed (`/foo`, not the slash-expanded forward
// text) so recall round-trips byte-identically. Newest message is LAST.
const HISTORY_PREFIX = "aura.manager.history:";
function historyKey(sessionId?: string | null): string {
  return composerKey(HISTORY_PREFIX, sessionId);
}

// The Effort chip is a cross-agent control: whichever brain runs the next
// turn, the backend translates the chosen level into that provider's real
// thinking/reasoning knob. `null` = Auto (leave the model at its default).
const EFFORT_OPTIONS: {
  value: ReasoningEffort | null;
  label: string;
  hint: string;
  blurb: string;
}[] = [
  // "Default", not "Auto" — this strip lives inside the model switcher, where
  // the model row and the routing summary each had an "Auto" of their own.
  { value: null, label: "Default", hint: "Whatever depth the model reasons at on its own", blurb: "model decides" },
  { value: "low", label: "Low", hint: "Quick, shallow reasoning", blurb: "quick" },
  { value: "medium", label: "Medium", hint: "Balanced reasoning", blurb: "balanced" },
  { value: "high", label: "High", hint: "Deep, careful reasoning. Slower", blurb: "deep" },
  { value: "max", label: "Max", hint: "Maximum depth. Ultrathink, slowest", blurb: "ultrathink" },
];

// The Approvals chip is a cross-agent autonomy control (Claude's
// acceptEdits/plan/bypassPermissions, generalized). `null` = the agent's
// own default ask-flow — the backend sends no permission flag, so the
// invocation stays byte-identical. Each level maps to the real per-agent
// flag in `aura-agents` (Claude `--permission-mode`, Gemini
// `--approval-mode`, Codex `--sandbox`); thin CLIs honor Plan via a
// read-only prompt steer.
const APPROVAL_OPTIONS: {
  value: ApprovalPolicy | null;
  label: string;
  hint: string;
  blurb: string;
}[] = [
  { value: null, label: "Default", hint: "Agent's standard flow. Asks before risky edits", blurb: "asks first" },
  { value: "accept_edits", label: "Accept Edits", hint: "Auto-accept file edits; still guard shell/destructive actions", blurb: "auto-edits" },
  { value: "plan", label: "Plan", hint: "Read-only. Propose a plan, change nothing on disk", blurb: "read-only" },
  { value: "bypass", label: "Bypass", hint: "Full autonomy. Skip all permission prompts", blurb: "no prompts" },
];

// Per-row glyphs so the Approvals / Mode menus read like the effort menu:
// an icon-led row + a trailing accent check on the active choice. All icons
// share the Medusa forward-ref component type, so `typeof ShieldCheck` types
// the whole map. Keyed by the option value (Approvals folds `null` → "default").
const APPROVAL_ICONS: Record<string, typeof ShieldCheck> = {
  default: ShieldCheck,
  accept_edits: PencilSquare,
  plan: Eye,
  bypass: Bolt,
};
const MODE_ICONS: Record<ComposerMode, typeof ShieldCheck> = {
  auto: RocketLaunch,
  build: CommandLine,
  plan: MapIcon,
  ask: ChatBubble,
};

export function ManagerComposer({
  repoRoot,
  workspaceLabel: _workspaceLabel,
  busy,
  usage,
  spend,
  placeholder,
  onSend,
  onStop,
  onPlanGoal,
  sessionId,
  onBrainOverrideChange,
  modelOverride = null,
  onModelOverrideChange,
  onQueue,
  onSteer,
  docked = false,
  agentCommands,
  agentModes,
  agentMode = null,
  onAgentModeChange,
  agentModeError = null,
}: Props) {
  // Follow-up behavior while a turn is running: "queue" parks the message for
  // turn-end, "steer" redirects the running turn now. ⌘↵ always steers
  // regardless of this pref (handled in `submit`).
  const followUpBehavior = useFollowUpBehavior();
  // `@terminal` in a message expands to the active terminal's live output —
  // resolve which terminal that is: the panel-focused one, else the editor-area
  // active pane, else the most-recent terminal tab.
  const editorStore = useEditorStore();
  const terminalContextId =
    editorStore.panelActiveTermId ??
    editorStore.activeTermId ??
    editorStore.terminalTabs[editorStore.terminalTabs.length - 1]?.termId ??
    null;
  // Restore this session's draft on first paint so a reload (or a tab
  // round-trip) never loses a half-typed message.
  const [text, setText] = useState(() => readDraft(draftKey(sessionId)));
  // Claude subscription reading (5h/7d window) — feeds the usage popover's
  // limit section. Null off-subscription, so that section just hides.
  const claudeUsage = useClaudeUsage();
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [listening, setListening] = useState(false);
  // Captured at start so onresult appends to the snapshot, not whatever
  // the editor has after the user types mid-listen.
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const dictationBaseRef = useRef<string>("");
  const [mode, setMode] = useState<ComposerMode>(() => {
    // localStorage can throw in private mode / quota-exceeded / disabled
    // storage. Either case used to crash the composer at first paint
    // because the lazy initializer was unwrapped. (M.1)
    try {
      const v = localStorage.getItem(MODE_KEY);
      return v === "build" || v === "ask" || v === "auto" ? v : "plan";
    } catch {
      return "plan";
    }
  });
  // Imperative handle into the Tiptap editor — clear after send, focus on
  // ⌘L, append dictation / external-context. The editor is uncontrolled; we
  // mirror its markdown into `text` via onChange for draft persistence + the
  // send payload.
  const composerRef = useRef<TiptapComposerHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  // Which session the current `text` belongs to — held in a ref so the
  // persist effect writes under the right key even on the render where
  // sessionId is changing out from under us.
  const draftKeyRef = useRef(draftKey(sessionId));

  // Pending trailing write for the debounced draft persistence below. Holds a
  // flush closure that captures the exact (key, value) it will write, or null
  // when nothing is pending. Flushed on session-swap / unmount / reload so no
  // in-progress draft is ever lost.
  const draftFlushRef = useRef<(() => void) | null>(null);

  // ── Message-history recall (shell-style Up/Down) ──────────────────────
  // The per-session ring of the user's own sent messages + a cursor while
  // browsing it. All held in refs (not state) because the recall is driven
  // imperatively via composerRef.setMarkdown — there's no rendered surface
  // that depends on these, so they don't need to trigger re-renders.
  //   `historyRef`   — the ring, newest last (loaded from localStorage).
  //   `historyPosRef`— how many steps back from "newest" we're browsing.
  //                    null = at the live position (not browsing).
  //   `liveDraftRef` — the in-progress text saved on the first Up step, so
  //                    stepping back Down past the newest restores it.
  //   `canRecall`    — gates the editor's Up/Down claim (state so the editor
  //                    re-reads it through its handlersRef on every render).
  const historyRef = useRef<string[]>(readHistory(historyKey(sessionId)));
  const historyKeyRef = useRef(historyKey(sessionId));
  const historyPosRef = useRef<number | null>(null);
  const liveDraftRef = useRef<string>("");
  const [canRecall, setCanRecall] = useState(
    () => historyRef.current.length > 0,
  );
  const [effort, setEffort] = useState<ReasoningEffort | null>(() => {
    try {
      const v = localStorage.getItem(EFFORT_KEY);
      return v === "low" || v === "medium" || v === "high" || v === "max" ? v : null;
    } catch {
      return null;
    }
  });
  const [addOpen, setAddOpen] = useState(false);
  const [fast, setFast] = useState<boolean>(() => {
    try {
      return localStorage.getItem(FAST_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [approval, setApproval] = useState<ApprovalPolicy | null>(() => {
    try {
      const v = localStorage.getItem(APPROVAL_KEY);
      return v === "accept_edits" || v === "plan" || v === "bypass" ? v : null;
    } catch {
      return null;
    }
  });
  // Goal toggle — when armed, the NEXT send is tagged as a goal: it rides the
  // normal send path (so it lands in the chat as your message with a "Sent as
  // goal" badge) and the brain is steered to plan it through the crew loop and
  // prove it. One-shot — reset after each send. Not persisted; arming is a
  // deliberate per-message act, not a sticky mode.
  const [goalMode, setGoalMode] = useState(false);

  // Insert externally-sourced context (today: in-app browser Agentation —
  // clicked page elements) into this composer's draft, then focus it. The next
  // message carries it along with whatever the user types. Registered with the
  // composer bridge on mount and on focus, so the chat the user last touched is
  // the one that receives the attachment (a split view never double-inserts).
  const insertExternal = useCallback((incoming: string) => {
    const add = incoming.trim();
    if (!add) return;
    composerRef.current?.appendText(add);
  }, []);
  useEffect(
    () => registerComposerInserter(insertExternal),
    [insertExternal],
  );

  // Persist the mode chip across reloads.
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* storage disabled */
    }
  }, [mode]);

  // ManagerChatView can flip the mode chip programmatically — e.g. when a user
  // on Auto asks for a plan, the send path switches the turn to Plan and fires
  // this so the visible chip follows. The persist effect above then stores it.
  useEffect(() => {
    const onSetMode = (e: Event) => {
      const next = (e as CustomEvent).detail?.mode;
      if (next === "auto" || next === "plan" || next === "build" || next === "ask") {
        setMode(next);
      }
    };
    window.addEventListener("aura:composer:set-mode", onSetMode);
    return () => window.removeEventListener("aura:composer:set-mode", onSetMode);
  }, []);

  // Draft persistence (per session). Two effects, ordered:
  //   1. On a session swap, point the ref at the new key and load that
  //      session's saved draft into the `text` mirror. The editor itself is
  //      keyed by sessionId (see render) so it REMOUNTS with the new draft as
  //      its `initialMarkdown` — no controlled round-trip needed. The OLD
  //      session's text was already persisted under its own key by effect 2.
  //   2. On every text change, persist under the CURRENT key (empty wipes
  //      the slot — also how a successful send clears the draft).
  useEffect(() => {
    const nextKey = draftKey(sessionId);
    if (nextKey === draftKeyRef.current) return;
    // Persist the outgoing session's draft NOW, before we re-point the key, so
    // a pending debounced write can't land under the new session's slot.
    draftFlushRef.current?.();
    draftKeyRef.current = nextKey;
    setText(readDraft(nextKey));
    // Re-point the history ring at the new session and abandon any in-flight
    // browse, so Up/Down on the swapped-to conversation recalls ITS own sent
    // messages, never the previous session's.
    const nextHistoryKey = historyKey(sessionId);
    historyKeyRef.current = nextHistoryKey;
    historyRef.current = readHistory(nextHistoryKey);
    historyPosRef.current = null;
    liveDraftRef.current = "";
    setCanRecall(historyRef.current.length > 0);
  }, [sessionId]);

  // Debounced draft persistence — coalesce the per-keystroke localStorage
  // write into a single trailing write (~400ms) so fast typing in a long chat
  // doesn't hit synchronous storage on every character. The captured (key,
  // value) is flushed on session-swap (above), unmount, and reload (below), so
  // the final draft is never lost.
  useEffect(() => {
    const key = draftKeyRef.current;
    const value = text;
    const timer = window.setTimeout(() => {
      draftFlushRef.current = null;
      writeDraft(key, value);
    }, 400);
    draftFlushRef.current = () => {
      window.clearTimeout(timer);
      draftFlushRef.current = null;
      writeDraft(key, value);
    };
    return () => window.clearTimeout(timer);
  }, [text]);

  // Flush any pending draft write on unmount and before a page reload/close so
  // the last <400ms of typing survives.
  useEffect(() => {
    const flush = () => draftFlushRef.current?.();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, []);

  // Focus this pane's composer whenever its session changes (open / resume /
  // switch). Beyond readiness this fixes image paste on a RESUMED session:
  // WebKit only dispatches `paste` when an editable element is focused, and a
  // freshly-resumed session leaves the editor blurred (focus was on the resume
  // picker row, now unmounted), so ⌘V silently dropped the image. Guarded like
  // ⌘L so we never steal focus from another live text field (a code editor,
  // a rename input); a background pane whose session id didn't change never
  // runs this, so split views don't fight over focus.
  useEffect(() => {
    const ae = document.activeElement as HTMLElement | null;
    const inOtherField =
      !!ae &&
      !ae.closest(".tiptap-composer-input") &&
      (ae.tagName === "INPUT" ||
        ae.tagName === "TEXTAREA" ||
        ae.isContentEditable);
    if (inOtherField) return;
    composerRef.current?.focus();
  }, [sessionId]);

  // Persist effort + fast. Clear the key at the default (Auto / off) so a
  // fresh install reads the neutral state and existing turns stay
  // byte-identical when no effort is chosen.
  useEffect(() => {
    try {
      if (effort == null) localStorage.removeItem(EFFORT_KEY);
      else localStorage.setItem(EFFORT_KEY, effort);
    } catch {
      /* storage disabled */
    }
  }, [effort]);

  useEffect(() => {
    try {
      if (fast) localStorage.setItem(FAST_KEY, "1");
      else localStorage.removeItem(FAST_KEY);
    } catch {
      /* storage disabled */
    }
  }, [fast]);

  // Persist the approval policy. Clear the key at the default so a fresh
  // install reads the neutral (null) state and turns stay byte-identical
  // when no policy is chosen.
  useEffect(() => {
    try {
      if (approval == null) localStorage.removeItem(APPROVAL_KEY);
      else localStorage.setItem(APPROVAL_KEY, approval);
    } catch {
      /* storage disabled */
    }
  }, [approval]);

  // Click-outside / Esc closes the unified add (+) menu.
  useDismiss(addOpen, () => setAddOpen(false), addRef);

  // Cmd/Ctrl+L focuses the composer (Conductor parity — the "⌘L to focus"
  // hint). We don't steal focus from another live text field (a code editor,
  // a rename input) so existing in-field shortcuts keep working; from the
  // chat scrollback or loose focus it jumps straight to the editor. Our own
  // ProseMirror surface is contentEditable too, so we exclude it by class
  // rather than treating every contentEditable as "another field".
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "l" || e.key === "L")) {
        const ae = document.activeElement as HTMLElement | null;
        const inOurEditor = !!ae && !!ae.closest(".tiptap-composer-input");
        const inOtherField =
          !!ae &&
          !inOurEditor &&
          (ae.tagName === "INPUT" ||
            ae.tagName === "TEXTAREA" ||
            ae.isContentEditable);
        if (inOtherField) return;
        e.preventDefault();
        composerRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Programmatic focus bridge. The Get-started tour's final "Start building"
  // hand-off (App switches to Build, then fires this) drops the cursor straight
  // into the composer so the user can type their first real ask. Any surface
  // that wants to invite input can dispatch it.
  useEffect(() => {
    function onFocus() {
      composerRef.current?.focus();
    }
    window.addEventListener("aura:focus-composer", onFocus);
    return () => window.removeEventListener("aura:focus-composer", onFocus);
  }, []);

  // Message-history recall bridge. The editor (TiptapComposer) claims a plain
  // Up at doc-start / Down at doc-end and fires this event; we walk the
  // per-session ring here and apply the recalled text via the imperative
  // setMarkdown handle (which also keeps the `text` mirror / draft in sync).
  //
  //   pos === null  → live position (whatever the user is typing).
  //   pos === 0     → newest sent message.
  //   pos === N-1   → oldest sent message.
  //
  // "up" steps toward older (pos grows); "down" steps toward newer (pos
  // shrinks) and, past the newest, restores the live draft saved on the first
  // Up step. Stepping up from the live position the FIRST time snapshots the
  // current text so it isn't lost.
  useEffect(() => {
    function onHistoryMove(e: Event) {
      const dir = (e as CustomEvent<{ dir: "up" | "down" }>).detail?.dir;
      const ring = historyRef.current;
      if (ring.length === 0) return;
      const pos = historyPosRef.current;
      if (dir === "up") {
        if (pos === null) {
          // Entering history: save the live draft, jump to the newest message.
          liveDraftRef.current = text;
          historyPosRef.current = 0;
        } else if (pos < ring.length - 1) {
          historyPosRef.current = pos + 1;
        } else {
          return; // already at the oldest — nothing further back.
        }
        const idx = ring.length - 1 - historyPosRef.current;
        // Caret to the START so a held/repeated ArrowUp keeps walking back
        // through EVERY earlier message — not just the newest one. (Parking it
        // at the end left the next Up away from doc-start, so the editor stopped
        // claiming the key and recall got stuck one message in.)
        composerRef.current?.setMarkdown(ring[idx], "start");
      } else {
        if (pos === null) return; // not browsing — Down does nothing here.
        if (pos > 0) {
          historyPosRef.current = pos - 1;
          const idx = ring.length - 1 - historyPosRef.current;
          // Caret to the END so a repeated ArrowDown walks forward toward the
          // newest the same way Up walks back.
          composerRef.current?.setMarkdown(ring[idx], "end");
        } else {
          // Stepping down past the newest → back to the live in-progress draft.
          historyPosRef.current = null;
          composerRef.current?.setMarkdown(liveDraftRef.current, "end");
        }
      }
    }
    window.addEventListener("aura:composer:history-move", onHistoryMove);
    return () =>
      window.removeEventListener("aura:composer:history-move", onHistoryMove);
  }, [text]);

  // Revoke object URLs on unmount so blob refs don't leak.
  useEffect(() => {
    return () => {
      for (const img of images) {
        if (img.kind === "image" && img.preview_url) {
          URL.revokeObjectURL(img.preview_url);
        }
      }
      // Dictation holds the microphone. Unmounting the composer with it still
      // running would leave the input device open behind a surface that no
      // longer exists — `abort()` so it goes back immediately, not after the
      // engine finishes chewing on the last utterance.
      stopDictationRef.current(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every exit from dictation goes through here: the toggle, submit, an
  // engine-side end/error, a start() that throws, and unmount. It owns the
  // ref, so there is never more than one live recognizer and never one that
  // nothing holds a reference to.
  //
  // Why it matters: a running SpeechRecognition holds the audio input exactly
  // like a getUserMedia stream does. On macOS an open input hands the Mac
  // ownership of connected AirPods and drops them out of A2DP, so a recognizer
  // orphaned behind a "not listening" UI leaves the user's headphones stuck on
  // the laptop and fighting their phone for the rest of the session.
  const stopDictation = useCallback((immediate = false) => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      try {
        if (immediate && typeof rec.abort === "function") rec.abort();
        else rec.stop();
      } catch {
        // stop()/abort() throw when recognition never started — in that case
        // there is no device to hand back and nothing to do.
      }
    }
    setListening(false);
  }, []);
  // The unmount effect above runs with render-0's closures; route it through a
  // ref so it always calls the current teardown.
  const stopDictationRef = useRef(stopDictation);
  useEffect(() => {
    stopDictationRef.current = stopDictation;
  }, [stopDictation]);

  function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
  }

  function toggleListening() {
    // `recognitionRef.current` is checked as well as `listening` so a
    // recognizer that survived a UI state we lost track of is still stopped
    // rather than orphaned next to a second one.
    if (listening || recognitionRef.current) {
      stopDictation();
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      console.warn("[composer] Web Speech API not available in this WebView");
      return;
    }
    const rec = new Ctor();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    dictationBaseRef.current = text;
    rec.onresult = (e: SpeechRecognitionEventLike) => {
      let collected = "";
      for (let i = 0; i < e.results.length; i++) {
        collected += e.results[i][0].transcript;
      }
      const base = dictationBaseRef.current;
      const sep = base.length > 0 && !/\s$/.test(base) ? " " : "";
      // Rewrite the editor's tail from the captured base — interim results
      // replace, not append. setMarkdown also pushes the mirror via onChange.
      composerRef.current?.setMarkdown(base + sep + collected);
    };
    rec.onerror = () => stopDictation();
    rec.onend = () => stopDictation();
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
      composerRef.current?.focus();
    } catch (err) {
      console.warn("[composer] recognition.start() failed", err);
      // start() can throw *after* the engine already took the input (a
      // double-start raises InvalidStateError). Tear the recognizer down
      // instead of dropping the reference with the microphone still open.
      stopDictation(true);
    }
  }

  function ingestFile(file: File) {
    // (M.5) Branch on MIME so text files don't silently drop. Images
    // still render as thumbnails; text files get a short preview tile;
    // file-path strings (dropped via the OS, see onDrop) come through
    // ingestPath() instead.
    if (file.size > 20 * 1024 * 1024) return;
    const id = `mci-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const isImage = file.type.startsWith("image/");
    const isText =
      file.type.startsWith("text/") ||
      /\.(md|txt|json|yaml|yml|toml|csv|log|ts|tsx|js|jsx|rs|py|go|sh|sql)$/i.test(
        file.name,
      );
    if (!isImage && !isText) return;
    setImages((prev) => [
      ...prev,
      {
        id,
        kind: isImage ? "image" : "text",
        name: file.name || (isImage ? "pasted-image.png" : "pasted.txt"),
        preview_url: isImage ? URL.createObjectURL(file) : "",
        file,
      },
    ]);
  }

  /** Ingest a raw filesystem path string (from a folder drag or a
   *  text/plain drop). Stored without reading bytes — the backend
   *  resolves it at send-time. (M.5) */
  function ingestPath(p: string) {
    const trimmed = p.trim();
    if (!trimmed) return;
    const id = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const name = trimmed.split("/").filter(Boolean).pop() || trimmed;
    setImages((prev) => [
      ...prev,
      { id, kind: "path", name, preview_url: "", file: null, pathValue: trimmed },
    ]);
  }

  /** Rebuild a real `File` from the base64 bytes Rust read off disk for an
   *  OS-dropped file. We round-trip through bytes (not a `data:` URL) so the
   *  resulting File behaves exactly like a pasted/selected one — `ingestFile`
   *  makes an objectURL preview and `readAsBase64` re-encodes it at send. */
  function fileFromBase64(name: string, mediaType: string, b64: string): File {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mediaType });
  }

  /** Read a File as base64, stripping the `data:<mime>;base64,` prefix
   *  Anthropic's API rejects data-URL prefixes so we always strip. */
  function readAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== "string") {
          reject(new Error("FileReader returned non-string"));
          return;
        }
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  function removeImage(id: string) {
    setImages((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target && target.kind === "image" && target.preview_url) {
        URL.revokeObjectURL(target.preview_url);
      }
      return prev.filter((i) => i.id !== id);
    });
  }

  // Window-level paste handler — routes images to the composer even when
  // focus is in the chat scrollback.
  useEffect(() => {
    function onWindowPaste(e: globalThis.ClipboardEvent) {
      // Already consumed by an element handler — in particular Tiptap's
      // `handlePaste` preventDefaults after ingesting a pasted image. Running
      // again here attached the same screenshot TWICE (once per handler).
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      // Our own ProseMirror surface is contentEditable; if a paste inside it
      // somehow got here unconsumed we still route it to the attachment tray.
      // Only bail for OTHER editables.
      const inOurEditor = !!target && !!target.closest?.(".tiptap-composer-input");
      const inOtherEditable =
        target &&
        !inOurEditor &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (inOtherEditable) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      let consumed = false;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) {
            ingestFile(f);
            consumed = true;
          }
        }
      }
      if (consumed) {
        e.preventDefault();
        composerRef.current?.focus();
      }
    }
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
  }, []);

  // OS file drop (Finder/desktop → composer). The global router
  // (`osFileDrop.ts`) hit-tests the drop and, when it lands on this composer's
  // zone, hands us the absolute paths. WKWebView never exposes real paths to an
  // HTML5 drop, so this Tauri-event path is the only one that actually carries
  // a dropped screenshot. We read each file's bytes (binary-safe, via Rust),
  // rebuild a `File`, and reuse `ingestFile` so images render + deliver exactly
  // like a pasted one; non-images fall back to a path attachment.
  useEffect(() => {
    function onComposerDrop(e: Event) {
      const detail = (e as CustomEvent<{ paths?: string[]; targetId?: string | null }>).detail;
      // Scoped Team composers carry their own target id so a Finder/FileTree
      // drop in a split pane cannot also attach to this global manager input.
      if (detail?.targetId) return;
      const paths = detail?.paths;
      if (!Array.isArray(paths) || paths.length === 0) return;
      void (async () => {
        for (const path of paths) {
          try {
            const f = await api.readFileBase64(path);
            if (f.is_image) {
              ingestFile(fileFromBase64(f.name, f.media_type, f.data_base64));
            } else {
              ingestPath(path);
            }
          } catch {
            // Unreadable / too large — keep the path so it isn't silently lost.
            ingestPath(path);
          }
        }
        composerRef.current?.focus();
      })();
    }
    function onDragHint(e: Event) {
      const detail = (e as CustomEvent<{ kind?: string | null; targetId?: string | null }>).detail;
      if (detail?.targetId) {
        setDragOver(false);
        return;
      }
      const kind = detail?.kind;
      setDragOver(kind === "composer");
    }
    window.addEventListener(OS_FILE_DROP_COMPOSER, onComposerDrop);
    window.addEventListener(OS_FILE_DRAG, onDragHint);
    return () => {
      window.removeEventListener(OS_FILE_DROP_COMPOSER, onComposerDrop);
      window.removeEventListener(OS_FILE_DRAG, onDragHint);
    };
  }, []);

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    // (M.5) Three drop shapes are real on macOS/Tauri:
    //   1) Files[] — handled below via ingestFile.
    //   2) text/uri-list — file:// URLs (folders or files dragged from
    //      Finder when no File handle is exposed).
    //   3) text/plain — bare paths (the agent terminal link drop emits
    //      these, and so does the file-tree drag).
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) ingestFile(files[i]);
      return;
    }
    const uri = e.dataTransfer?.getData("text/uri-list");
    if (uri) {
      for (const line of uri.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const path = trimmed.startsWith("file://")
          ? decodeURIComponent(trimmed.slice("file://".length))
          : trimmed;
        ingestPath(path);
      }
      return;
    }
    const plain = e.dataTransfer?.getData("text/plain");
    if (plain) {
      // The file-tree drag joins a multi-selection with newlines; split so
      // each path becomes its own attachment rather than one bogus glob.
      for (const line of plain.split(/\r?\n/)) {
        const p = line.trim();
        if (p) ingestPath(p);
      }
    }
  }

  async function submit(opts?: { steer?: boolean }) {
    // Sending is the end of dictation — hand the microphone back here rather
    // than leaving it open behind the sent message.
    if (listening || recognitionRef.current) stopDictation();
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    // `/brain [query]` is a client-side affordance, not a message: it opens
    // the model picker so the user can swap the brain for the next turn. We
    // consume it here (clear the draft, don't dispatch to the brain) and let
    // the BrainPicker's listener take over. Zero backend round-trip.
    if (/^\/brain(\s|$)/i.test(trimmed)) {
      window.dispatchEvent(
        new CustomEvent("aura:composer:open-brain-picker", {
          detail: trimmed.replace(/^\/brain\s*/i, "").trim(),
        }),
      );
      setText("");
      composerRef.current?.clear();
      return;
    }
    // While busy we don't drop the turn — we park it in the per-session
    // queue (W2, drained on turn-end) or steer the running turn now. Only
    // no-op if the parent wired neither handler (preserves old behavior).
    if (busy && !onQueue && !onSteer) return;
    // Record the RAW text the user typed onto this session's history ring (the
    // shell-style Up-arrow recall). Stored pre-expansion (`/foo`, not the
    // forward text) so recall round-trips byte-identically, and only when
    // there's actually text — a pure-image send adds nothing to recall. Reset
    // the browse cursor so the next Up starts from this new newest message.
    if (trimmed) {
      const nextRing = pushHistory(historyRef.current, trimmed);
      historyRef.current = nextRing;
      writeHistory(historyKeyRef.current, nextRing);
      setCanRecall(nextRing.length > 0);
    }
    historyPosRef.current = null;
    liveDraftRef.current = "";
    // Snapshot images locally so the async readAsBase64 walk doesn't
    // race with a re-render that clears `images` after setImages([]).
    const snapshot = images;
    let attachments: ComposerAttachment[] = [];
    // (M.5) Fold non-image attachments into the message body since the
    // backend ComposerAttachment shape is image-only. Text files become
    // fenced code blocks at the top; path drops become @path tokens
    // appended to the end. Images still go through the attachments
    // array unchanged.
    const textBlocks: string[] = [];
    const pathTokens: string[] = [];
    const imageItems = snapshot.filter((i) => i.kind === "image" && i.file);
    // `@terminal` mention → attach the live terminal output as a fenced block
    // and rewrite the mention so the model reads it as "the attached context".
    const terminalMention = /(^|\s)@terminal(?=\s|$|[.,;:!?])/gi;
    const wantsTerminal = terminalMention.test(trimmed);
    terminalMention.lastIndex = 0;
    const expandedText = wantsTerminal
      ? trimmed
          .replace(terminalMention, "$1the attached active terminal context")
          .trim()
      : trimmed;
    try {
      if (wantsTerminal) {
        const output = terminalContextId
          ? await readTerminalContext(terminalContextId)
          : "";
        if (output) {
          const longestTicks = Math.max(
            2,
            ...Array.from(output.matchAll(/`+/g), (m) => m[0].length),
          );
          const fence = "`".repeat(longestTicks + 1);
          textBlocks.push(
            `Active terminal context (${terminalContextId}):\n${fence}text\n${output}\n${fence}`,
          );
        } else {
          textBlocks.push(
            "Active terminal context: no live terminal output was available.",
          );
        }
      }
      attachments = await Promise.all(
        imageItems.map(async (img) => ({
          media_type: img.file!.type || "image/png",
          data_base64: await readAsBase64(img.file!),
          name: img.name,
        })),
      );
      for (const item of snapshot) {
        if (item.kind === "text" && item.file) {
          const body = await item.file.text();
          textBlocks.push(`File: ${item.name}\n\`\`\`\n${body}\n\`\`\``);
        } else if (item.kind === "path" && item.pathValue) {
          pathTokens.push(`@${item.pathValue}`);
        }
      }
    } catch (e) {
      console.error("[composer] failed to read attachment(s)", e);
      // Don't silently drop — keep the user's text + images visible so
      // they can retry or remove the bad file.
      return;
    }
    setText("");
    // Reset the editor itself — it's uncontrolled, so clearing the `text`
    // mirror alone wouldn't empty the document.
    composerRef.current?.clear();
    for (const img of snapshot) {
      if (img.kind === "image" && img.preview_url) URL.revokeObjectURL(img.preview_url);
    }
    setImages([]);
    const parts: string[] = [];
    if (textBlocks.length > 0) parts.push(textBlocks.join("\n\n"));
    if (expandedText) parts.push(expandedText);
    if (pathTokens.length > 0) parts.push(pathTokens.join(" "));
    // Route the submit. Idle → send now. Busy → steer (redirect the running
    // turn) when ⌘↵ was held OR the follow-up pref is "steer"; otherwise queue
    // it. Each falls back gracefully if the parent didn't wire that handler.
    const wantSteer = busy && (opts?.steer === true || followUpBehavior === "steer");
    const dispatch = !busy
      ? onSend
      : wantSteer && onSteer
        ? onSteer
        : onQueue ?? onSend;
    dispatch(parts.join("\n\n"), attachments, mode, null, effort, fast, approval, goalMode);
    // Goal is one-shot — arming tags exactly the message you just sent, then
    // disarms so the following turn is an ordinary send unless you re-arm.
    if (goalMode) setGoalMode(false);
  }

  // Slash + `@file` menus are owned by `TiptapComposer` now — it tracks the
  // live token under the caret and drives both popups, completing each into a
  // real inline atom chip. The composer here only owns Enter=submit and the
  // Esc=stop affordance, both forwarded into the editor's key handling below.

  const activeMode = MODE_OPTIONS.find((m) => m.value === mode) ?? MODE_OPTIONS[0];

  // The agent's own mode this chip position asks for, when the running
  // agent has modes at all. Null = the chip is the prompt steer it has
  // always been.
  const enforcedMode = agentModes?.length
    ? agentModeFor(mode, agentModes)
    : null;
  // The agent says it is somewhere else. Agents change mode on their own
  // — OpenCode leaves plan mode when you accept its plan — and a chip
  // that kept saying Plan through that would be the most dangerous kind
  // of wrong.
  const driftedMode =
    enforcedMode && agentMode && agentMode !== enforcedMode ? agentMode : null;

  /** Pick a mode. Beyond moving the chip, this pushes the agent's
   *  equivalent when there is one — the whole point of the control on a
   *  hosted agent. The push is fire-and-forget here because the parent
   *  owns the error: it hands back `agentModeError`, which the chip
   *  shows. */
  function chooseMode(next: ComposerMode) {
    setMode(next);
    if (!onAgentModeChange || !agentModes?.length) return;
    const target = agentModeFor(next, agentModes);
    if (!target || target === agentMode) return;
    void onAgentModeChange(target).catch(() => {
      // Reported through `agentModeError`, not thrown into a click.
    });
  }
  const activeApproval =
    APPROVAL_OPTIONS.find((a) => a.value === approval) ?? APPROVAL_OPTIONS[0];
  const canSend = !busy && (text.trim().length > 0 || images.length > 0);
  // While a turn is in flight, the same content can be parked in the queue
  // (W2) instead of sent — Enter or the queue button enqueues it.
  // The primary busy-state follow-up button. It runs whatever the follow-up
  // pref says — queue (drain on turn-end) or steer (redirect now) — so the
  // label/icon below track `followUpBehavior`, not a fixed "Queue".
  const canFollowUp =
    busy && !!onQueue && (text.trim().length > 0 || images.length > 0);
  // A SECOND, explicit steer control, shown only when steering isn't already
  // the default (when it is, the primary button steers, so this would be
  // redundant). Lets you fold a message into the running turn without changing
  // the setting — the icon the user asked for. Keyboard equivalent is ⌘↵.
  const canSteerNow =
    busy &&
    !!onSteer &&
    followUpBehavior !== "steer" &&
    (text.trim().length > 0 || images.length > 0);
  // Redirect-into-the-stream glyph (a corner-down-right arrow) shared by the
  // primary button when steering is the default and by the explicit steer
  // control. Inlined — the sprite has no steer symbol.
  const steerGlyph = (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 3.5v4a2 2 0 0 0 2 2h5.5" />
      <path d="m9 7 3 2.5-3 2.5" />
    </svg>
  );
  // Keep the editor itself LIVE while a turn streams, as long as the parent
  // wired a queue handler — the user must be able to type and press Enter to
  // queue a follow-up (W2). TiptapComposer turns its `busy` prop into
  // `setEditable(!busy)`, so we only let it go read-only in the legacy,
  // no-queue case (preserves the old block-on-busy behavior). Esc=Stop while
  // busy is restored below via an onKeyDownCapture on the composer root, since
  // a non-busy editor would otherwise stop forwarding Esc to onStop.
  const editorBusy = busy && !onQueue && !onSteer;

  // "This turn" strip folded into the model switcher (#17): Fast + Effort now
  // ride inside the BrainPicker modal instead of sitting as two extra chips on
  // the composer bar. All three are per-turn knobs for whichever agent runs the
  // next turn, so they belong on one surface — the model chip carries them.
  const turnControls = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line-soft px-3 py-2">
      <span className="text-xs font-medium text-text-4">This turn</span>
      <button
        type="button"
        aria-pressed={fast}
        onClick={() => setFast((v) => !v)}
        title={
          fast
            ? "Fast mode on. Minimal reasoning, lowest latency. Click to turn off."
            : "Fast mode. Minimal reasoning, lowest latency (overrides Effort)"
        }
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-sm"
        style={
          fast
            ? {
                color: "var(--color-accent)",
                background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
              }
            : { color: "var(--color-text-3)" }
        }
      >
        {/* Explicit size, not the `.ico` class alone: `.ico` is only sized
            under `.aura-chat`, but these turn-controls render inside the
            model switcher, which portals to <body> — outside that scope. There
            the class-only svg loses its dimensions and balloons to fill the
            row. The hard h/w keeps it 14px everywhere. */}
        <svg className="ico h-3.5 w-3.5 shrink-0"><use href="#i-zap" /></svg>
        Fast
      </button>
      <div className="ml-auto flex items-center gap-0.5" role="group" aria-label="Reasoning effort">
        {EFFORT_OPTIONS.map((opt, idx) => {
          const on = effort === opt.value && !fast;
          return (
            <button
              key={opt.label}
              type="button"
              disabled={fast}
              onClick={() => setEffort(opt.value)}
              title={fast ? "Effort is overridden by Fast" : `${opt.label} · ${opt.hint}`}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-sm ${
                fast ? "cursor-not-allowed" : ""
              }`}
              style={
                on
                  ? {
                      color: "var(--color-accent)",
                      background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
                    }
                  : { color: fast ? "var(--color-text-5)" : "var(--color-text-3)" }
              }
            >
              <span className="flex w-3.5 shrink-0 justify-center">
                {idx === 0 ? (
                  <Sparkles className="h-3.5 w-3.5" />
                ) : (
                  <EffortGauge level={idx as 1 | 2 | 3 | 4} dim={fast} />
                )}
              </span>
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div
      data-os-drop="composer"
      className={`composer relative ${dragOver ? "focus" : ""}${docked ? " composer-docked" : ""}`}
      onKeyDownCapture={(e) => {
        // Esc=Stop while a turn streams. Normally TiptapComposer forwards this
        // (its own busy-gated handler), but we keep the editor editable while
        // busy so follow-ups can be queued — so its `busy` is false and it no
        // longer fires onEscapeWhileBusy. Re-home Stop here, in the capture
        // phase, so Esc still halts the in-flight turn even while typing a
        // queued message. Only when the parent wired Stop AND a queue handler
        // (the live-editor case); otherwise TiptapComposer's own path runs.
        if (e.key === "Escape" && busy && onStop && (onQueue || onSteer)) {
          e.preventDefault();
          e.stopPropagation();
          onStop();
        }
      }}
      onDragOver={(e) => {
        // Accept OS file drags (Files) AND in-app path drags — the file tree
        // and agent-terminal links carry only text/plain (or text/uri-list),
        // no Files. Without preventDefault the browser refuses the drop, so a
        // file-tree drag never lands here. dropEffect=copy pairs with the
        // tree's effectAllowed=copyMove so the drop is permitted.
        const t = e.dataTransfer.types;
        if (
          t.includes("Files") ||
          t.includes("text/uri-list") ||
          t.includes("text/plain")
        ) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* Conductor-style focus hint — only while the field is empty, so it
          never crowds what the user is typing. */}
      {text.length === 0 && images.length === 0 && !busy && (
        <span className="absolute top-2.5 right-3 text-xs text-text-4 pointer-events-none select-none">
          <Kbd>⌘L</Kbd> to focus
        </span>
      )}

      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 pb-1.5">
          {images.map((img) => (
            <ImageThumb key={img.id} img={img} onRemove={() => removeImage(img.id)} />
          ))}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          const files = e.target.files;
          if (files) {
            for (let i = 0; i < files.length; i++) ingestFile(files[i]);
          }
          e.target.value = "";
        }}
      />

      {/* Rich composer — a Tiptap editor that turns `/commands` and
          `@file` mentions into inline atom chips while serializing back to
          plain `/cmd` / `@path` for the brain. Keyed by session so a swap
          remounts with that session's restored draft (uncontrolled past
          mount). Enter submits, Shift+Enter newlines, Esc stops while busy. */}
      <TiptapComposer
        key={sessionId ?? "__global"}
        ref={composerRef}
        repoRoot={repoRoot}
        initialMarkdown={readDraft(draftKey(sessionId))}
        busy={editorBusy}
        placeholder={
          busy && (onQueue || onSteer)
            ? followUpBehavior === "steer" && onSteer
              ? "Steer the running turn. ↵ redirects it now"
              : onSteer
                ? "Queue a follow-up. ⌘↵ to steer now"
                : "Queue a follow-up. Sends when the agent finishes"
            : (placeholder ?? "Ask to make changes, @mention files, run /commands")
        }
        onChange={setText}
        onSubmit={(opts) => void submit(opts)}
        onEscapeWhileBusy={onStop}
        onImageFiles={(files) => files.forEach(ingestFile)}
        canRecallHistory={canRecall}
        agentRows={agentCommands}
      />

      <div className="composer-bottom">
        {/* Model picker — grouped by agent, exact models. Picks both the
            brain the next turn runs through AND its concrete model;
            cross-agent by construction. Defaults + auto-routing (the model new
            sessions start on, which model each task class routes to) fold into
            the bottom of this same switcher (`modalFooter`) — one model chip,
            not two look-alike chips (#17). */}
        {sessionId && onBrainOverrideChange && onModelOverrideChange && (
          <BrainPicker
            sessionId={sessionId}
            value={modelOverride}
            onBrainChange={onBrainOverrideChange}
            onModelChange={onModelOverrideChange}
            // Stay switchable while a turn streams: brain/model/effort are all
            // per-NEXT-turn knobs (ManagerChatView reads the override live at
            // send), so changing them mid-stream simply targets the follow-up
            // you're queueing. Only the legacy no-queue path locks it.
            disabled={editorBusy}
            variant="modal"
            modalFooter={<ModelDefaultsPanel />}
            turnControls={turnControls}
          />
        )}

        {/* Approvals — a shield chip mirroring Claude's permission modes,
            generalized cross-agent. The backend maps the level to each
            agent's real flag (Claude --permission-mode, Gemini
            --approval-mode, Codex --sandbox); thin CLIs honor Plan via a
            read-only prompt steer. Default keeps the agent's own ask-flow. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ChipButton
              title={
                approval
                  ? `Approvals: ${activeApproval.label} · ${activeApproval.hint}`
                  : "Approvals. The autonomy the agent runs with this turn"
              }
              chevron={false}
              // Bypass is the one risky setting — it reads red, not accent, so an
              // agent left running unattended is unmistakable at a glance. Every
              // other active selection lights up with the app accent (chip-on).
              className={
                approval === "bypass"
                  ? "chip-danger"
                  : approval
                    ? "chip-on"
                    : undefined
              }
            >
              <svg className="ico-12"><use href="#i-shield" /></svg>
              <span className="chip-label">{approval ? activeApproval.label : "Approvals"}</span>
            </ChipButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            {APPROVAL_OPTIONS.map((opt) => {
              const selected = (approval ?? null) === (opt.value ?? null);
              const danger = opt.value === "bypass";
              const Icon = APPROVAL_ICONS[opt.value ?? "default"];
              return (
                <DropdownMenuItem
                  key={opt.label}
                  className={`gap-x-2${danger ? " !text-[var(--color-red)]" : ""}`}
                  onSelect={() => setApproval(opt.value)}
                >
                  <span className="flex w-3.5 shrink-0 justify-center">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span>{opt.label}</span>
                  {selected && (
                    <CheckMini className="ml-auto h-3.5 w-3.5 text-[var(--color-accent)]" />
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Goal — a toggle, not an action. Arm it and your next Send lands in
            the chat as your own message tagged "Sent as goal"; the brain is
            steered to treat it as a standing outcome, plan it through the crew
            loop and prove it — surfacing that work as tool calls you can watch.
            Clicking never sends or clears; it only arms/disarms. */}
        {onPlanGoal && (
          <ChipButton
            title={
              goalMode
                ? "Sending as a goal. The brain will plan it through the crew loop. Click to unset."
                : "Send as a goal. The brain plans it through the crew loop and proves it"
            }
            chevron={false}
            className={goalMode ? "chip-on" : undefined}
            aria-pressed={goalMode}
            disabled={!repoRoot}
            onClick={() => setGoalMode((v) => !v)}
          >
            <svg className="ico-12"><use href="#i-target" /></svg>
            <span className="chip-label">Goal</span>
          </ChipButton>
        )}

        {/* Plan / Build / Ask — the map chip (Conductor's plan-mode glyph).
            Normally a steer: the words are prepended to the message and the
            brain still decides plan-vs-build. When the running agent has
            modes of its own, the same chip drives those instead — OpenCode's
            plan mode refuses every edit tool, which is a promise the prompt
            alone can't make — and the tooltip says which of the two you're
            getting. Always lit with the app accent (it always carries a
            mode). */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ChipButton
              title={
                agentModeError
                  ? `${activeMode.label} — the agent refused the switch: ${agentModeError}`
                  : `${activeMode.label} · ${activeMode.hint}${
                      enforcedMode
                        ? `\nEnforced by the agent, not just asked for (${enforcedMode})`
                        : ""
                    }`
              }
              className={agentModeError ? "chip-on chip-danger" : "chip-on"}
              chevron={false}
            >
              <svg className="ico-12"><use href="#i-map" /></svg>
              <span className="chip-label">{activeMode.label}</span>
              {/* The agent is in a different mode than this chip claims —
                  it switched itself mid-turn. Show its word, not ours. */}
              {driftedMode && (
                <span className="chip-label text-text-3">· {driftedMode}</span>
              )}
            </ChipButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            {MODE_OPTIONS.map((opt) => {
              const selected = mode === opt.value;
              const Icon = MODE_ICONS[opt.value];
              return (
                <DropdownMenuItem
                  key={opt.value}
                  className="gap-x-2"
                  onSelect={() => chooseMode(opt.value)}
                >
                  <span className="flex w-3.5 shrink-0 justify-center">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span>{opt.label}</span>
                  {selected && (
                    <CheckMini className="ml-auto h-3.5 w-3.5 text-[var(--color-accent)]" />
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="right justify-end" style={{ minWidth: 96 }}>
          {/* Live context-fill gauge — hidden until the native brain reports
              usage, then shows how full the model's window is (the Conductor
              parity gap: a peripheral token meter on the composer, not buried
              in a header). */}
          {usage && (
            <div className="mr-0.5">
              <UsagePopover
                usage={usage}
                spend={spend}
                contextWindow={modelOverride?.longContext ? 1_000_000 : undefined}
                usageTitle={claudeUsage ? "Claude usage" : undefined}
                limit={
                  claudeUsage?.fresh && claudeUsage.seven_d_pct != null
                    ? { label: "7d limit", pctLeft: 100 - claudeUsage.seven_d_pct }
                    : null
                }
                account={
                  modelOverride?.family ? { provider: modelOverride.family } : null
                }
              />
            </div>
          )}
          {/* Unified add (+) — attachments and dictation folded into one menu,
              the way Conductor consolidated its composer inserts. */}
          <div className="relative" ref={addRef}>
            <button
              type="button"
              className="icon-btn-sm"
              title="Add. Attach an image or dictate"
              aria-expanded={addOpen}
              onClick={() => setAddOpen((v) => !v)}
              style={
                listening
                  ? { color: "var(--color-red)", background: "var(--color-bg-2)" }
                  : undefined
              }
            >
              <svg className="ico"><use href="#i-plus" /></svg>
            </button>
            {addOpen && (
              <div
                className="absolute right-0 bottom-7 z-30 min-w-[184px] rounded-md py-1 shadow-lg"
                style={{
                  background: "var(--color-bg-3)",
                  border: "1px solid var(--color-line-soft)",
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setAddOpen(false);
                    fileInputRef.current?.click();
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left text-sm text-text-2 hover:bg-state-hover hover:text-text-1 transition-colors"
                >
                  <svg className="ico-12"><use href="#i-image" /></svg>
                  <span>Attach image…</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAddOpen(false);
                    toggleListening();
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left text-sm text-text-2 hover:bg-state-hover hover:text-text-1 transition-colors"
                >
                  <svg className="ico-12"><use href="#i-mic" /></svg>
                  <span>{listening ? "Stop dictation" : "Dictate"}</span>
                </button>
              </div>
            )}
          </div>
          {busy && onStop ? (
            <>
              {canFollowUp && (
                <Button
                  type="button"
                  variant="subtle"
                  size="sm"
                  className="font-mono text-accent"
                  onClick={() => void submit()}
                  title={
                    followUpBehavior === "steer"
                      ? "Steer. Redirects the running turn now (↵)"
                      : "Queue. Sends when the current turn finishes (↵)"
                  }
                >
                  {followUpBehavior === "steer" ? (
                    steerGlyph
                  ) : (
                    <svg className="ico-12"><use href="#i-arrow-up" /></svg>
                  )}
                  <span className="send-kbd">⏎</span>
                </Button>
              )}
              {canSteerNow && (
                <Button
                  type="button"
                  variant="subtle"
                  size="sm"
                  className="font-mono text-accent"
                  onClick={() => void submit({ steer: true })}
                  title="Steer. Fold this into the running turn now (⌘↵)"
                >
                  {steerGlyph}
                  <span className="send-kbd">⌘⏎</span>
                </Button>
              )}
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="font-mono"
                onClick={() => onStop()}
                title="Stop (Esc)"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
                  <rect x="2" y="2" width="6" height="6" rx="1" />
                </svg>
                <span className="send-kbd">Esc</span>
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="default"
              size="sm"
              className="font-mono"
              disabled={!canSend}
              onClick={() => void submit()}
              title="Send (↵)"
            >
              <svg className="ico-12"><use href="#i-arrow-up" /></svg>
              <span className="send-kbd">⌘↵</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Reasoning-effort gauge — three ascending bars that light low → high,
 *  mirroring Conductor's signal-strength glyph. Purely presentational; the
 *  cross-agent backend translates the level into each provider's own knob.
 *  `level` 0 = none/unset (all bars dim), 1 = low, 2 = medium, 3 = high.
 *  `dim` renders the whole gauge muted when Fast has overridden effort. */
function EffortGauge({ level, dim }: { level: 0 | 1 | 2 | 3 | 4; dim?: boolean }) {
  // Four ascending bars: Low / Medium / High / Max.
  const bars = [
    { x: 0.5, y: 8, h: 3 },
    { x: 4, y: 5.5, h: 5.5 },
    { x: 7.5, y: 3, h: 8 },
    { x: 11, y: 0.5, h: 10.5 },
  ];
  return (
    <svg
      width="14"
      height="12"
      viewBox="0 0 14 12"
      fill="currentColor"
      aria-hidden
      style={dim ? { opacity: 0.45 } : undefined}
    >
      {bars.map((b, i) => (
        <rect
          key={b.x}
          x={b.x}
          y={b.y}
          width="2.2"
          height={b.h}
          rx="0.8"
          style={{ opacity: !dim && i < level ? 1 : 0.28 }}
        />
      ))}
    </svg>
  );
}

function ImageThumb({
  img,
  onRemove,
}: {
  img: ComposerImage;
  onRemove: () => void;
}) {
  // (M.5) Three tile shapes:
  //   image — thumbnail from the object URL.
  //   text  — filename + a small "TXT" badge.
  //   path  — last segment + a folder icon glyph.
  const tipExtra = img.kind === "path" ? `\n${img.pathValue}` : "";
  return (
    <div
      className="relative group w-14 h-14 rounded border border-line-soft overflow-hidden bg-bg-0 flex items-center justify-center"
      title={`${img.name}${tipExtra}`}
    >
      {img.kind === "image" ? (
        <img
          src={img.preview_url}
          alt={img.name}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="flex flex-col items-center justify-center text-text-3 text-2xs gap-0.5 px-1">
          <svg className="w-[18px] h-[18px]">
            <use href={img.kind === "path" ? "#i-folder" : "#i-file"} />
          </svg>
          <span className="truncate max-w-full">{img.name}</span>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        title="Remove"
        className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-bg-deep/80 text-text-1 text-2xs leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
      >
        ×
      </button>
    </div>
  );
}
