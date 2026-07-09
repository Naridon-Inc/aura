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
import { TokenMeterHeader } from "./chat/TokenMeterHeader";
import { type TokenUsage } from "./chat/types";
import { api, type BrainChoice, type ReasoningEffort, type ApprovalPolicy } from "../../lib/api";
import {
  OS_FILE_DROP_COMPOSER,
  OS_FILE_DRAG,
} from "../../lib/osFileDrop";
import { type SelectedModel } from "../../lib/modelCatalog";
import {
  MODEL_OPTIONS,
  TASK_CLASSES,
  setClassModel,
  setDefaultModel,
  useModelPrefs,
  type ModelId,
  type TaskClass,
} from "../../lib/modelStore";
import { registerComposerInserter } from "../../lib/composerBridge";
import { TiptapComposer, type TiptapComposerHandle } from "./TiptapComposer";
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
  stop(): void;
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
  ) => void;
  /** Cancel an in-flight brain turn. When `busy` is true the send button
   *  flips into a Stop button that fires this handler. */
  onStop?: () => void;
  /** Currently-open agent PTYs in this workspace. Powers the "↪ Pipe"
   *  picker — when set, sending also drives the chosen agent's PTY.
   *  Empty list hides the picker entirely. */
  pipeTargets?: { sessionId: string; label: string; monogram: string }[];
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
  ) => void;
  /** Fuse the composer onto a pending-question card docked directly above it:
   *  drop the top border + square the top corners so the question card and the
   *  input read as one stacked panel (the card rounds only its top). False =
   *  the standalone rounded composer. */
  docked?: boolean;
};

// `hint` is the full description (the trigger tooltip); `blurb` is the 1-3 word
// inline note shown on the menu row, kept tight so rows stay single-line.
const MODE_OPTIONS: { value: ComposerMode; label: string; hint: string; blurb: string }[] = [
  { value: "auto", label: "Auto", hint: "Full autopilot — decide, build, and finish without pausing", blurb: "autopilot" },
  { value: "build", label: "Build", hint: "Make the changes end-to-end", blurb: "make changes" },
  { value: "plan", label: "Plan", hint: "Discuss and plan before any edits", blurb: "plan first" },
  { value: "ask", label: "Ask", hint: "Read-only chat — no edits", blurb: "read-only" },
];

const MODE_KEY = "aura.manager.mode";
const PIPE_KEY = "aura.manager.pipeTarget";
const EFFORT_KEY = "aura.manager.effort";
const FAST_KEY = "aura.manager.fast";
const APPROVAL_KEY = "aura.manager.approval";

// Per-session composer draft. Unlike the chips above (global), a half-typed
// message belongs to ONE conversation — switching Manager sessions must not
// bleed drafts across them, so the key carries the session id. A null
// session (picker hidden / pre-session) folds onto one shared slot.
const DRAFT_PREFIX = "aura.manager.draft:";
function draftKey(sessionId?: string | null): string {
  return `${DRAFT_PREFIX}${sessionId ?? "__global"}`;
}
function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
/** Persist a draft, or drop the key when empty so stale empty slots don't
 *  accumulate (also how a successful send clears the draft). */
function writeDraft(key: string, value: string): void {
  try {
    if (value.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage disabled */
  }
}

// Per-session message-history ring — the shell-style "Up arrow recalls my last
// message" recall. Keyed exactly like drafts (per Manager session) so history
// never bleeds across conversations, and persisted in localStorage so it
// survives a reload. We store the RAW text the user typed (`/foo`, not the
// slash-expanded forward text) so recall round-trips byte-identically. Newest
// message is LAST in the array; consecutive duplicates collapse so spamming the
// same message doesn't bloat the ring, and the ring is capped so it can't grow
// without bound.
const HISTORY_PREFIX = "aura.manager.history:";
const HISTORY_CAP = 50;
function historyKey(sessionId?: string | null): string {
  return `${HISTORY_PREFIX}${sessionId ?? "__global"}`;
}
function readHistory(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}
function writeHistory(key: string, value: string[]): void {
  try {
    if (value.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage disabled */
  }
}
/** Append a sent message to the ring (newest last), collapsing a consecutive
 *  duplicate of the current newest and capping the length. */
function pushHistory(ring: string[], message: string): string[] {
  if (ring.length > 0 && ring[ring.length - 1] === message) return ring;
  const next = [...ring, message];
  return next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next;
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
  { value: null, label: "Auto", hint: "Let the model pick its own reasoning depth", blurb: "model decides" },
  { value: "low", label: "Low", hint: "Quick, shallow reasoning", blurb: "quick" },
  { value: "medium", label: "Medium", hint: "Balanced reasoning", blurb: "balanced" },
  { value: "high", label: "High", hint: "Deep, careful reasoning — slower", blurb: "deep" },
  { value: "max", label: "Max", hint: "Maximum depth — ultrathink, slowest", blurb: "ultrathink" },
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
  { value: null, label: "Default", hint: "Agent's standard flow — asks before risky edits", blurb: "asks first" },
  { value: "accept_edits", label: "Accept Edits", hint: "Auto-accept file edits; still guard shell/destructive actions", blurb: "auto-edits" },
  { value: "plan", label: "Plan", hint: "Read-only — propose a plan, change nothing on disk", blurb: "read-only" },
  { value: "bypass", label: "Bypass", hint: "Full autonomy — skip all permission prompts", blurb: "no prompts" },
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
  placeholder,
  onSend,
  onStop,
  pipeTargets = [],
  sessionId,
  onBrainOverrideChange,
  modelOverride = null,
  onModelOverrideChange,
  onQueue,
  docked = false,
}: Props) {
  // Restore this session's draft on first paint so a reload (or a tab
  // round-trip) never loses a half-typed message.
  const [text, setText] = useState(() => readDraft(draftKey(sessionId)));
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
  const [pipeTarget, setPipeTarget] = useState<string | null>(() => {
    try {
      return localStorage.getItem(PIPE_KEY);
    } catch {
      return null;
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

  // (M.2) One effect persists both mode + pipeTarget and drops stale
  // pipe targets in a single pass. The previous three-effect arrangement
  // wrote pipeTarget in two places (the stale-clear effect set state to
  // null AND fired removeItem, then the persist effect re-fired
  // removeItem on the next tick) which made rapid toggles race.
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

  useEffect(() => {
    writeDraft(draftKeyRef.current, text);
  }, [text]);

  useEffect(() => {
    // Stale-pipe drop: if the selected PTY tab is gone, clear it.
    if (pipeTarget && !pipeTargets.some((t) => t.sessionId === pipeTarget)) {
      setPipeTarget(null);
      return;
    }
    // Persist current selection (or clear key when off).
    try {
      if (pipeTarget == null) localStorage.removeItem(PIPE_KEY);
      else localStorage.setItem(PIPE_KEY, pipeTarget);
    } catch {
      /* storage disabled */
    }
  }, [pipeTargets, pipeTarget]);

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
  useEffect(() => {
    if (!addOpen) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node | null;
      if (addRef.current && t && !addRef.current.contains(t)) {
        setAddOpen(false);
      }
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setAddOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [addOpen]);

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
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore — stop() throws if recognition never started
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
  }

  function toggleListening() {
    if (listening) {
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
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
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
      composerRef.current?.focus();
    } catch (err) {
      console.warn("[composer] recognition.start() failed", err);
      setListening(false);
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
      const target = e.target as HTMLElement | null;
      // Our own ProseMirror surface is contentEditable, but it won't route a
      // pasted image into the attachment tray — so we still want to catch
      // image pastes that land inside it. Only bail for OTHER editables.
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
      const paths = (e as CustomEvent<{ paths?: string[] }>).detail?.paths;
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
      const kind = (e as CustomEvent<{ kind?: string | null }>).detail?.kind;
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
    if (plain) ingestPath(plain);
  }

  async function submit() {
    if (listening) {
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
    }
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
    // queue (W2) and the parent drains it on turn-end. Only no-op if the
    // parent didn't wire a queue handler (preserves the old behavior).
    if (busy && !onQueue) return;
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
    try {
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
    if (trimmed) parts.push(trimmed);
    if (pathTokens.length > 0) parts.push(pathTokens.join(" "));
    const dispatch = busy && onQueue ? onQueue : onSend;
    dispatch(parts.join("\n\n"), attachments, mode, pipeTarget, effort, fast, approval);
  }

  // Slash + `@file` menus are owned by `TiptapComposer` now — it tracks the
  // live token under the caret and drives both popups, completing each into a
  // real inline atom chip. The composer here only owns Enter=submit and the
  // Esc=stop affordance, both forwarded into the editor's key handling below.

  const activeMode = MODE_OPTIONS.find((m) => m.value === mode) ?? MODE_OPTIONS[0];
  const activeEffort =
    EFFORT_OPTIONS.find((e) => e.value === effort) ?? EFFORT_OPTIONS[0];
  // Effort as a signal-strength gauge (Conductor parity): 0 = Auto (faint),
  // 1/2/3/4 = Low/Medium/High/Max bars lit.
  const effortLevel: 0 | 1 | 2 | 3 | 4 =
    effort === "low" ? 1 : effort === "medium" ? 2 : effort === "high" ? 3 : effort === "max" ? 4 : 0;
  const activeApproval =
    APPROVAL_OPTIONS.find((a) => a.value === approval) ?? APPROVAL_OPTIONS[0];
  // Auto and Build are the two "doing" modes — they tint the brighter green;
  // Plan/Ask read as the quieter, read-first modes (the accent tint that
  // `active` gives, which is green inside the chat scope).
  const modeActiveClass =
    mode === "build" || mode === "auto"
      ? "text-[var(--color-accent-green)] hover:text-[var(--color-accent-green)]"
      : undefined;
  const canSend = !busy && (text.trim().length > 0 || images.length > 0);
  // While a turn is in flight, the same content can be parked in the queue
  // (W2) instead of sent — Enter or the queue button enqueues it.
  const canQueue =
    busy && !!onQueue && (text.trim().length > 0 || images.length > 0);
  // Keep the editor itself LIVE while a turn streams, as long as the parent
  // wired a queue handler — the user must be able to type and press Enter to
  // queue a follow-up (W2). TiptapComposer turns its `busy` prop into
  // `setEditable(!busy)`, so we only let it go read-only in the legacy,
  // no-queue case (preserves the old block-on-busy behavior). Esc=Stop while
  // busy is restored below via an onKeyDownCapture on the composer root, since
  // a non-busy editor would otherwise stop forwarding Esc to onStop.
  const editorBusy = busy && !onQueue;

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
        if (e.key === "Escape" && busy && onStop && onQueue) {
          e.preventDefault();
          e.stopPropagation();
          onStop();
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* Conductor-style focus hint — only while the field is empty, so it
          never crowds what the user is typing. */}
      {text.length === 0 && images.length === 0 && !busy && (
        <span className="absolute top-2.5 right-3 text-[10.5px] text-text-4 pointer-events-none select-none">
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
          busy && onQueue
            ? "Queue a follow-up — sends when the agent finishes"
            : (placeholder ?? "Ask to make changes, @mention files, run /commands")
        }
        onChange={setText}
        onSubmit={() => void submit()}
        onEscapeWhileBusy={onStop}
        onImageFiles={(files) => files.forEach(ingestFile)}
        canRecallHistory={canRecall}
      />

      <div className="composer-bottom">
        {/* Model picker — grouped by agent, exact models. Picks both the
            brain the next turn runs through AND its concrete model;
            cross-agent by construction. */}
        {sessionId && onBrainOverrideChange && onModelOverrideChange && (
          <BrainPicker
            sessionId={sessionId}
            value={modelOverride}
            onBrainChange={onBrainOverrideChange}
            onModelChange={onModelOverrideChange}
            disabled={busy}
            variant="modal"
          />
        )}

        {/* Model defaults + auto-routing — a distinct axis from the BrainPicker
            beside it (which picks the model for THIS turn). This sets the model
            new agent sessions start on, and how Auto routes each kind of task.
            Relocated out of the footer status strip so every model control sits
            by the composer. A sliders glyph (not a model name) keeps it from
            reading as a second per-turn picker. */}
        <DefaultModelPicker />

        {/* Fast — latency-first. A standalone bolt that collapses effort to
            the provider minimum for whichever agent runs the turn. */}
        <button
          type="button"
          className="icon-btn-sm"
          title={
            fast
              ? "Fast mode on — minimal reasoning, lowest latency. Click to turn off."
              : "Fast mode — minimal reasoning, lowest latency (overrides Effort)"
          }
          aria-pressed={fast}
          onClick={() => setFast((v) => !v)}
          style={
            fast
              ? { color: "var(--color-accent)", background: "var(--color-bg-2)" }
              : undefined
          }
        >
          <svg className="ico"><use href="#i-zap" /></svg>
        </button>

        {/* Effort — a signal-strength gauge (low → high). Cross-agent: the
            backend maps the level to each provider's own reasoning knob. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ChipButton
              title={
                fast
                  ? "Effort is overridden by Fast — minimal reasoning"
                  : effort
                    ? `Reasoning effort: ${activeEffort.label} — ${activeEffort.hint}`
                    : "Reasoning effort — applies to whichever agent runs this turn"
              }
              active={!!effort && !fast}
              chevron={false}
            >
              <EffortGauge level={effortLevel} dim={fast} />
              <span>{effort ? activeEffort.label : "Effort"}</span>
            </ChipButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            {EFFORT_OPTIONS.map((opt, idx) => {
              const selected = effort === opt.value;
              return (
                <DropdownMenuItem
                  key={opt.label}
                  className="gap-x-2"
                  onSelect={() => setEffort(opt.value)}
                >
                  <span className="flex w-3.5 shrink-0 justify-center">
                    {idx === 0 ? (
                      <Sparkles className="h-3.5 w-3.5" />
                    ) : (
                      <EffortGauge level={idx as 1 | 2 | 3 | 4} />
                    )}
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
                  ? `Approvals: ${activeApproval.label} — ${activeApproval.hint}`
                  : "Approvals — the autonomy the agent runs with this turn"
              }
              active={!!approval && approval !== "bypass"}
              chevron={false}
              // Bypass is the one risky setting — it reads red, not accent, so an
              // agent left running unattended is unmistakable at a glance.
              className={
                approval === "bypass"
                  ? "text-[var(--color-red)] hover:text-[var(--color-red)]"
                  : undefined
              }
            >
              <svg className="ico-12"><use href="#i-shield" /></svg>
              <span>{approval ? activeApproval.label : "Approvals"}</span>
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

        {/* Plan / Build / Ask — the map chip (Conductor's plan-mode glyph).
            A visual hint only; the brain still decides plan-vs-build. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ChipButton
              title={`${activeMode.label} — ${activeMode.hint}`}
              active
              className={modeActiveClass}
              chevron={false}
            >
              <svg className="ico-12"><use href="#i-map" /></svg>
              <span>{activeMode.label}</span>
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
                  onSelect={() => setMode(opt.value)}
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

        {pipeTargets.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ChipButton
                title={
                  pipeTarget
                    ? `Pipe also to ${pipeTargets.find((t) => t.sessionId === pipeTarget)?.label ?? "agent"} PTY`
                    : "Also pipe this message into an open agent PTY"
                }
                active={!!pipeTarget}
              >
                <span aria-hidden>↪</span>
                <span>
                  {pipeTarget
                    ? `Pipe → ${pipeTargets.find((t) => t.sessionId === pipeTarget)?.monogram ?? "·"}`
                    : "Pipe"}
                </span>
              </ChipButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              <DropdownMenuItem
                className="gap-x-2"
                onSelect={() => setPipeTarget(null)}
              >
                <span className="flex w-3.5 shrink-0 justify-center text-[var(--color-text-3)]">–</span>
                <span>Off</span>
                {!pipeTarget && (
                  <CheckMini className="ml-auto h-3.5 w-3.5 text-[var(--color-accent)]" />
                )}
              </DropdownMenuItem>
              {pipeTargets.map((t) => {
                const selected = pipeTarget === t.sessionId;
                return (
                  <DropdownMenuItem
                    key={t.sessionId}
                    className="gap-x-2"
                    onSelect={() => setPipeTarget(t.sessionId)}
                  >
                    <span className="flex w-3.5 shrink-0 justify-center text-[10px] font-semibold text-[var(--color-text-3)]">
                      {t.monogram ?? "·"}
                    </span>
                    <span>{t.label}</span>
                    {selected && (
                      <CheckMini className="ml-auto h-3.5 w-3.5 text-[var(--color-accent)]" />
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <div className="right">
          {/* Live context-fill gauge — hidden until the native brain reports
              usage, then shows how full the model's window is (the Conductor
              parity gap: a peripheral token meter on the composer, not buried
              in a header). */}
          {usage && (
            <div className="mr-0.5">
              <TokenMeterHeader usage={usage} />
            </div>
          )}
          {/* Unified add (+) — attachments and dictation folded into one menu,
              the way Conductor consolidated its composer inserts. */}
          <div className="relative" ref={addRef}>
            <button
              type="button"
              className="icon-btn-sm"
              title="Add — attach an image or dictate"
              aria-expanded={addOpen}
              onClick={() => setAddOpen((v) => !v)}
              style={
                listening
                  ? { color: "var(--color-red, #ef4444)", background: "var(--color-bg-2)" }
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
                  className="w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left text-[12px] text-text-2 hover:bg-bg-2 hover:text-text-1 transition-colors"
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
                  className="w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left text-[12px] text-text-2 hover:bg-bg-2 hover:text-text-1 transition-colors"
                >
                  <svg className="ico-12"><use href="#i-mic" /></svg>
                  <span>{listening ? "Stop dictation" : "Dictate"}</span>
                </button>
              </div>
            )}
          </div>
          {busy && onStop ? (
            <>
              {canQueue && (
                <Button
                  type="button"
                  variant="subtle"
                  size="sm"
                  className="font-mono text-accent"
                  onClick={() => void submit()}
                  title="Queue — sends when the current turn finishes (↵)"
                >
                  <svg className="ico-12"><use href="#i-arrow-up" /></svg>
                  <span className="send-kbd">⏎</span>
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

// Default model + per-task auto-routing. A settings-flavored companion to the
// per-turn BrainPicker: the BrainPicker chooses what runs for the NEXT turn,
// while this sets the model new agent sessions start on and how "Auto" routes
// each task class (simple edit / chat / plan). Was the footer StatusBar's
// ModelPickerItem — the model store's only UI entry point — so it moves here
// intact rather than being stranded. Reads/writes the same `useModelPrefs`
// store, so a change is instantly reflected everywhere the pref is consumed.
function DefaultModelPicker() {
  const prefs = useModelPrefs();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node | null;
      if (wrapRef.current && t && !wrapRef.current.contains(t)) setOpen(false);
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isAuto = prefs.default === "auto";
  const activeOpt = MODEL_OPTIONS.find((m) => m.id === prefs.default);
  // Trim the vendor prefix so the chip stays compact ("Opus 4.7", not the
  // full "Claude Opus 4.7"); the tooltip carries the whole story.
  const chipLabel = isAuto
    ? "Auto route"
    : (activeOpt?.label ?? "Auto route").replace(/^Claude\s+/, "");

  return (
    <div className="relative" ref={wrapRef}>
      <ChipButton
        title="Default model for new agent sessions, and how Auto routes each kind of task"
        onClick={() => setOpen((v) => !v)}
        active={!isAuto}
        chevron={false}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
          <line x1="3" y1="4" x2="13" y2="4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="10" cy="4" r="1.7" fill="var(--color-bg-3)" stroke="currentColor" strokeWidth="1.3" />
          <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="6" cy="8" r="1.7" fill="var(--color-bg-3)" stroke="currentColor" strokeWidth="1.3" />
          <line x1="3" y1="12" x2="13" y2="12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="11" cy="12" r="1.7" fill="var(--color-bg-3)" stroke="currentColor" strokeWidth="1.3" />
        </svg>
        <span>{chipLabel}</span>
      </ChipButton>
      {open && (
        <div
          className="absolute left-0 bottom-7 z-30 min-w-[280px] rounded-md py-1 shadow-lg"
          style={{
            background: "var(--color-bg-3)",
            border: "1px solid var(--color-line-soft)",
          }}
        >
          <div className="px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-wider text-text-4">
            Default model
          </div>
          {MODEL_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setDefaultModel(opt.id)}
              className={`w-full flex items-start gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-bg-2 transition-colors ${
                opt.id === prefs.default ? "text-text-1" : "text-text-2"
              }`}
            >
              <span className="flex flex-col">
                <span className="font-medium">{opt.label}</span>
                <span className="text-[10.5px] text-text-4">{opt.hint}</span>
              </span>
              {opt.id === prefs.default && (
                <span className="ml-auto text-[12px] text-accent">✓</span>
              )}
            </button>
          ))}
          <div className="my-1 border-t border-line-soft" />
          <div className="px-2.5 pt-1 pb-1 text-[10px] uppercase tracking-wider text-text-4">
            Auto routing
          </div>
          {TASK_CLASSES.map((cls) => (
            <ClassRow
              key={cls.id}
              cls={cls.id}
              label={cls.label}
              hint={cls.hint}
              current={prefs.byClass[cls.id]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One auto-routing row — a task class + a native <select> of concrete models
// (Auto excluded, since a class must resolve to a real model). Lives outside a
// Radix menu on purpose: a <select> inside one gets its pointer events eaten.
function ClassRow({
  cls,
  label,
  hint,
  current,
}: {
  cls: TaskClass;
  label: string;
  hint: string;
  current: ModelId;
}) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11.5px]">
      <span className="flex flex-col flex-1 min-w-0">
        <span className="text-text-2 truncate">{label}</span>
        <span className="text-[10px] text-text-4 truncate">{hint}</span>
      </span>
      <select
        value={current}
        onChange={(e) => setClassModel(cls, e.target.value as ModelId)}
        className="text-[11px] bg-bg-2 text-text-2 border border-line-soft rounded h-6 px-1.5 focus:outline-none focus:ring-1 focus:ring-violet-400/40"
      >
        {MODEL_OPTIONS.filter((m) => m.id !== "auto").map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.label}
          </option>
        ))}
      </select>
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
      className="relative group w-14 h-14 rounded border border-line-soft overflow-hidden bg-bg-1 flex items-center justify-center"
      title={`${img.name}${tipExtra}`}
    >
      {img.kind === "image" ? (
        <img
          src={img.preview_url}
          alt={img.name}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="flex flex-col items-center justify-center text-text-3 text-[9px] gap-0.5 px-1">
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
        className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-bg-1/80 text-text-1 text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
      >
        ×
      </button>
    </div>
  );
}
