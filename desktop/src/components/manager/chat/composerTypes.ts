import type { ReactNode } from "react";
import type { TokenUsage, TurnSpend } from "./types";
import type {
  AgentMode,
  BrainChoice,
  ReasoningEffort,
  ApprovalPolicy,
} from "../../../lib/api";
import type { SelectedModel } from "../../../lib/modelCatalog";
import type { SlashItem } from "../../chat/composer/useComposerSuggestions";

export type ComposerImage = {
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
export type SpeechRecognitionLike = {
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
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
export type SpeechRecognitionEventLike = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

export type ManagerComposerProps = {
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
  /** A plan is paused waiting for the user's answer; what they type now
   *  adjusts it, and the empty box says so. */
  planAwaitingReply?: boolean;
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
  /** Manager session id — required to wire the model picker (WW-B3) so a
   *  brain swap persists on the right session. Null hides the picker. */
  sessionId?: string | null;
  /** Lifts the model picker's brain selection (or null for Auto) to the parent —
   *  the brain the lifted model routes through. Owned by ManagerChatView. */
  onBrainOverrideChange?: (choice: BrainChoice | null) => void;
  /** The exact model the next turn runs (composer model picker, #251).
   *  Owned by ManagerChatView so the send path threads `model` +
   *  `long_context` into `brain_chat_turn`. Null = the brain's default. */
  modelOverride?: SelectedModel | null;
  /** Lifts the per-turn model selection (or null for Auto) to the parent. */
  onModelOverrideChange?: (model: SelectedModel | null) => void;
  /** The machine's agent, when the chat runs on one of the org's machines:
   *  the picker then offers only that machine's models. */
  machineBrain?: BrainChoice | null;
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
  /** A control for earlier conversations, drawn first in the toolbar's
   *  action cluster (the chat passes its history menu). */
  history?: ReactNode;
  /** The engine the next message goes to (brain id) and its name, so the
   *  "Link workspaces" dialog can say when it can't read linked folders. */
  linkAgentId?: string | null;
  linkAgentLabel?: string | null;
};
