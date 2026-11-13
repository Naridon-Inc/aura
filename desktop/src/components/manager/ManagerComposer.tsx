import { CornerUpLeft } from "lucide-react";
// The chat composer for the Manager tab: the shared composer itself, fed the
// conversation's draft, attachments, `/` and `@` lists, and the model control
// on the left of its footer, with voice, add, stop and send on the right. The outer `.p-dock` wrapper is
// the parent's responsibility — this component owns only the box itself, so
// inline cards (Question/Plan) can be docked above it without breaking the
// dock's gap rhythm.
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
  type KeyboardEvent,
} from "react";
import { ManagerModelPicker } from "../chat/model/ManagerModelPicker";
import { api, type ReasoningEffort, type ApprovalPolicy } from "../../lib/api";
import { OS_FILE_DROP_COMPOSER, OS_FILE_DRAG } from "../../lib/osFileDrop";
import { registerComposerInserter, withLeading, withTrailing, type InsertAt } from "../../lib/composerBridge";
import {
  notifyComposerAttachments,
  registerComposerAttacher,
} from "../../lib/composerAttachments";
import { useFollowUpBehavior } from "../../lib/followUpBehavior";
import { Composer, type ComposerSuggestion } from "../ui/composer";
import { ComposerAddMenu, ContextUsageIndicator } from "../ui/composer-tools";
import { IssueLinkDialog } from "../ui/issue-link-dialog";
import { LinkWorkspacesDialog } from "../ui/link-workspaces-dialog";
import { SnippetFormDialog } from "../ui/snippet-form-dialog";
import { SnippetPickerDialog } from "../ui/snippet-picker-dialog";
import { useIssueLink } from "./useIssueLink";
import { useLinkWorkspaces } from "./useLinkWorkspaces";
import { isInsertSnippetKey, useSnippetInsert } from "./useSnippetInsert";
import { useClaudeUsage } from "./chat/ClaudeUsageRing";
import "../chat/ChatComposer.css";
import "../ui/chat-composer.css";
import { formatCost } from "../../lib/money";
import { useComposerSuggestions } from "../chat/composer/useComposerSuggestions";
import { ComposerTurnMenu } from "../chat/composer/ComposerTurnMenu";

import { Button } from "../ui/button";
import { readTerminalContext } from "../Terminal";
import { useEditorStore } from "../../lib/editorStore";
import {
  composerKey,
  MANAGER_DRAFT_PREFIX,
  MANAGER_HISTORY_PREFIX,
  pushHistory,
  readDraft,
  readHistory,
  writeDraft,
  writeHistory,
} from "../composer/composerDrafts";
// AURA-1296 — ⌘⇧/ effort ladder and the Concise output-style chip.
import {
  CYCLE_EFFORT_EVENT,
  effortLabel,
  nextEffort,
} from "../../lib/effortCycle";
import { TOGGLE_FAST_EVENT, modKeyLabel } from "../../lib/composerChords";
import {
  toggleOutputStyle,
  useOutputStyle,
  writeOutputStyle,
} from "../../lib/outputStyle";
import { toast } from "../../lib/toast";
import { useChatTeammates } from "../../lib/chatTeammates";
import type {
  ComposerImage,
  ComposerAttachment,
  ComposerMode,
  SpeechRecognitionLike,
  SpeechRecognitionCtor,
  SpeechRecognitionEventLike,
  ManagerComposerProps,
} from "./chat/composerTypes";
import { agentModeFor } from "./chat/agentModeFor";

// The composer's public types and its mode narrowing live under chat/ now;
// they are re-exported here so callers keep one import path.
export type { ComposerAttachment, ComposerMode } from "./chat/composerTypes";
export { agentModeFor } from "./chat/agentModeFor";

// `hint` is the full description (the trigger tooltip); `blurb` is the 1-3 word
// inline note shown on the menu row, kept tight so rows stay single-line.
const MODE_KEY = "aura.manager.mode";
const EFFORT_KEY = "aura.manager.effort";
// AURA-1296 — the keypress every mounted composer last answered (see the
// CYCLE_EFFORT_EVENT listener); module-level so they can share it.
let lastEffortCycleAt = -1;
const FAST_KEY = "aura.manager.fast";
/** The ⌘⇧E keypress every mounted composer last answered — same sharing
 *  trick as the effort ladder's, so one chord raises one toast. */
let lastFastToggleAt = -1;
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
// The prefix is exported from composerDrafts now (AURA-1296): the tab strip
// reads the same key to draw a pencil on a tab that holds a draft.
function draftKey(sessionId?: string | null): string {
  return composerKey(MANAGER_DRAFT_PREFIX, sessionId);
}

// We store the RAW text the user typed (`/foo`, not the slash-expanded forward
// text) so recall round-trips byte-identically. Newest message is LAST.
function historyKey(sessionId?: string | null): string {
  return composerKey(MANAGER_HISTORY_PREFIX, sessionId);
}

export function ManagerComposer({
  repoRoot,
  workspaceLabel: _workspaceLabel,
  busy,
  usage,
  spend,
  placeholder,
  planAwaitingReply = false,
  onSend,
  onStop,
  onPlanGoal,
  sessionId,
  onBrainOverrideChange,
  modelOverride = null,
  onModelOverrideChange,
  machineBrain = null,
  onQueue,
  onSteer,
  docked = false,
  agentCommands,
  agentModes,
  agentMode = null,
  onAgentModeChange,
  agentModeError = null,
  history,
  linkAgentId = null,
  linkAgentLabel = null,
}: ManagerComposerProps) {
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
  const [images, setImages] = useState<ComposerImage[]>([]);
  // A file from the desktop is being dragged over this chat.
  const [osDragOver, setOsDragOver] = useState(false);
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
  // The message field. The draft itself is `text`; this is only for moving
  // focus and the caret (⌘L, history recall, dictation).
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // "Link issue": a picked GitHub issue arrives as a markdown attachment.
  const issueLink = useIssueLink({
    repoRoot,
    field: textareaRef,
    onAttach: (file) => ingestFileRef.current(file),
    onClosed: () => textareaRef.current?.focus(),
  });
  const snippet = useSnippetInsert({ field: textareaRef, setText });
  // "Link workspaces": other workspaces and folders this one's agents may read.
  const workspaceLinks = useLinkWorkspaces({
    repoRoot,
    agentId: linkAgentId,
    agentLabel: linkAgentLabel,
    onClosed: () => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    },
  });
  /** Put `next` in the field and park the caret at one end of it. */
  const placeText = useCallback((next: string, caret: "start" | "end" = "end") => {
    setText(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const at = caret === "start" ? 0 : next.length;
      el.setSelectionRange(at, at);
    });
  }, []);
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
  // imperatively from the field's arrow keys — there's no rendered surface
  // that depends on these, so they don't need to trigger re-renders.
  //   `historyRef`   — the ring, newest last (loaded from localStorage).
  //   `historyPosRef`— how many steps back from "newest" we're browsing.
  //                    null = at the live position (not browsing).
  //   `liveDraftRef` — the in-progress text saved on the first Up step, so
  //                    stepping back Down past the newest restores it.
  const historyRef = useRef<string[]>(readHistory(historyKey(sessionId)));
  const historyKeyRef = useRef(historyKey(sessionId));
  const historyPosRef = useRef<number | null>(null);
  const liveDraftRef = useRef<string>("");
  const [effort, setEffort] = useState<ReasoningEffort | null>(() => {
    try {
      const v = localStorage.getItem(EFFORT_KEY);
      return v === "low" || v === "medium" || v === "high" || v === "max"
        ? v
        : null;
    } catch {
      return null;
    }
  });
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
  // Goal mode is for the next message in this chat; another chat starts out
  // of it.
  useEffect(() => setGoalMode(false), [sessionId]);

  // Insert externally-sourced context (today: in-app browser Agentation —
  // clicked page elements) into this composer's draft, then focus it. The next
  // message carries it along with whatever the user types. Registered with the
  // composer bridge on mount and on focus, so the chat the user last touched is
  // the one that receives the attachment (a split view never double-inserts).
  // An @mention goes in front, since it addresses the whole message; anything
  // else follows what is typed.
  const insertExternal = useCallback((incoming: string, at: InsertAt = "end") => {
    if (!incoming.trim()) return;
    setText((prev) => (at === "start" ? withLeading(prev, incoming) : withTrailing(prev, incoming)));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);
  useEffect(() => registerComposerInserter(insertExternal), [insertExternal]);

  // Files handed in from outside the composer — an earlier chat or a saved
  // plan picked on a new chat's opening screen — join the attachments, and
  // the opening screen is told which ones are already here.
  const ingestFileRef = useRef(ingestFile);
  ingestFileRef.current = ingestFile;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => {
    if (!sessionId) return;
    return registerComposerAttacher(sessionId, {
      attach: (file) => {
        ingestFileRef.current(file);
        requestAnimationFrame(() => textareaRef.current?.focus());
      },
      names: () => imagesRef.current.map((i) => i.name),
      remove: (name) => setImages((prev) => prev.filter((i) => i.name !== name)),
    });
  }, [sessionId]);
  useEffect(() => notifyComposerAttachments(), [images]);

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
      if (
        next === "auto" ||
        next === "plan" ||
        next === "build" ||
        next === "ask"
      ) {
        setMode(next);
      }
    };
    window.addEventListener("aura:composer:set-mode", onSetMode);
    return () =>
      window.removeEventListener("aura:composer:set-mode", onSetMode);
  }, []);

  // AURA-1296 — ⌘⇧/ walks the effort ladder without opening the model
  // switcher. Every mounted composer updates its own chip (the level is
  // persisted under one key, so they must agree); only the first to hear a
  // given keypress says so, or two composers on one session toast twice.
  const effortRef = useRef(effort);
  effortRef.current = effort;
  useEffect(() => {
    const onCycle = (e: Event) => {
      const next = nextEffort(effortRef.current);
      setEffort(next);
      if (e.timeStamp !== lastEffortCycleAt) {
        lastEffortCycleAt = e.timeStamp;
        toast.info(`Effort: ${effortLabel(next)}`, undefined, {
          durationMs: 1500,
        });
      }
    };
    window.addEventListener(CYCLE_EFFORT_EVENT, onCycle);
    return () => window.removeEventListener(CYCLE_EFFORT_EVENT, onCycle);
  }, []);

  // ⌘⇧E flips Fast. Same shape as the effort ladder above, for the same
  // reason: Fast is one persisted value, so every mounted composer updates its
  // own chip and only the first to hear a given keypress says so out loud.
  const fastRef = useRef(fast);
  fastRef.current = fast;
  useEffect(() => {
    const onToggle = (e: Event) => {
      const next = !fastRef.current;
      setFast(next);
      if (e.timeStamp !== lastFastToggleAt) {
        lastFastToggleAt = e.timeStamp;
        toast.info(`Fast: ${next ? "on" : "off"}`, undefined, {
          durationMs: 1500,
        });
      }
    };
    window.addEventListener(TOGGLE_FAST_EVENT, onToggle);
    return () => window.removeEventListener(TOGGLE_FAST_EVENT, onToggle);
  }, []);

  // AURA-1296 — "Concise" answers. Read at send time by ManagerChatView and
  // handed to Claude Code as `--output-style`; other brains ignore it.
  // Live: Settings › Default models sets the same value.
  const outputStyle = useOutputStyle();
  const toggleConcise = () => writeOutputStyle(toggleOutputStyle(outputStyle));

  // Draft persistence (per session). Two effects, ordered:
  //   1. On a session swap, point the ref at the new key and load that
  //      session's saved draft into `text`, which the field shows. The OLD
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
      !ae.closest(".ui-composer") &&
      (ae.tagName === "INPUT" ||
        ae.tagName === "TEXTAREA" ||
        ae.isContentEditable);
    if (inOtherField) return;
    textareaRef.current?.focus();
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

  // Cmd/Ctrl+L focuses the composer (the "⌘L to focus"
  // hint). We don't steal focus from another live text field (a code editor,
  // a rename input) so existing in-field shortcuts keep working; from the
  // chat scrollback or loose focus it jumps straight to the field. Our own
  // field is a textarea too, so it is excluded by its box rather than
  // treated as "another field".
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "l" || e.key === "L")) {
        const ae = document.activeElement as HTMLElement | null;
        const inOurEditor = !!ae && !!ae.closest(".ui-composer");
        const inOtherField =
          !!ae &&
          !inOurEditor &&
          (ae.tagName === "INPUT" ||
            ae.tagName === "TEXTAREA" ||
            ae.isContentEditable);
        if (inOtherField) return;
        e.preventDefault();
        textareaRef.current?.focus();
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
      textareaRef.current?.focus();
    }
    window.addEventListener("aura:focus-composer", onFocus);
    return () => window.removeEventListener("aura:focus-composer", onFocus);
  }, []);

  // Message-history recall. A plain Up with the caret at the very start of the
  // field, or Down at the very end, walks the per-session ring (see
  // `onFieldKey`), so ordinary multi-line caret movement keeps working.
  //
  //   pos === null  → live position (whatever the user is typing).
  //   pos === 0     → newest sent message.
  //   pos === N-1   → oldest sent message.
  //
  // "up" steps toward older (pos grows); "down" steps toward newer (pos
  // shrinks) and, past the newest, restores the live draft saved on the first
  // Up step. Stepping up from the live position the FIRST time snapshots the
  // current text so it isn't lost. Returns whether the key was used.
  function moveHistory(dir: "up" | "down"): boolean {
    // Read the ring afresh on the way in. A message can reach this
    // conversation without passing through this box — the workspace home's
    // first prompt, a starter picked from the empty chat — and the copy this
    // composer loaded when it mounted has never heard of those, so the
    // up-arrow in a chat begun that way recalled nothing.
    if (dir === "up" && historyPosRef.current === null) {
      historyRef.current = readHistory(historyKeyRef.current);
    }
    const ring = historyRef.current;
    if (ring.length === 0) return false;
    const pos = historyPosRef.current;
    if (dir === "up") {
      if (pos === null) {
        // Entering history: save the live draft, jump to the newest message.
        liveDraftRef.current = text;
        historyPosRef.current = 0;
      } else if (pos < ring.length - 1) {
        historyPosRef.current = pos + 1;
      } else {
        return true; // already at the oldest — nothing further back.
      }
      // Caret to the START so a held/repeated ArrowUp keeps walking back
      // through EVERY earlier message, not just the newest one.
      placeText(ring[ring.length - 1 - historyPosRef.current], "start");
      return true;
    }
    if (pos === null) return false; // not browsing — Down moves the caret.
    if (pos > 0) {
      historyPosRef.current = pos - 1;
      // Caret to the END so a repeated ArrowDown walks forward toward the
      // newest the same way Up walks back.
      placeText(ring[ring.length - 1 - historyPosRef.current], "end");
    } else {
      // Stepping down past the newest → back to the live in-progress draft.
      historyPosRef.current = null;
      placeText(liveDraftRef.current, "end");
    }
    return true;
  }

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
      // Rewrite the field's tail from the captured base — interim results
      // replace, not append.
      placeText(base + sep + collected);
    };
    rec.onerror = () => stopDictation();
    rec.onend = () => stopDictation();
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
      textareaRef.current?.focus();
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
      {
        id,
        kind: "path",
        name,
        preview_url: "",
        file: null,
        pathValue: trimmed,
      },
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
      // Already consumed by an element handler — in particular the field's
      // own paste, which attaches pasted files. Running again here attached
      // the same screenshot TWICE (once per handler).
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      // A paste inside our own field that got here unconsumed still routes to
      // the attachment tray. Only bail for OTHER editables.
      const inOurEditor = !!target && !!target.closest?.(".ui-composer");
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
        textareaRef.current?.focus();
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
      const detail = (
        e as CustomEvent<{ paths?: string[]; targetId?: string | null }>
      ).detail;
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
        textareaRef.current?.focus();
      })();
    }
    function onDragHint(e: Event) {
      const detail = (
        e as CustomEvent<{ kind?: string | null; targetId?: string | null }>
      ).detail;
      // The box shows its drop mark while a file is over the area that drops
      // into it (the whole conversation, not only the box).
      setOsDragOver(detail?.kind === "composer" && !detail?.targetId);
      if (detail?.targetId) return;
      // Over this composer: give it focus, which is how the box shows it is
      // the one that will take the drop.
      if (detail?.kind === "composer") textareaRef.current?.focus();
    }
    window.addEventListener(OS_FILE_DROP_COMPOSER, onComposerDrop);
    window.addEventListener(OS_FILE_DRAG, onDragHint);
    return () => {
      window.removeEventListener(OS_FILE_DROP_COMPOSER, onComposerDrop);
      window.removeEventListener(OS_FILE_DRAG, onDragHint);
    };
  }, []);

  function onDrop(e: DragEvent<HTMLDivElement>) {
    // The composer box takes dropped files itself; what reaches here is the
    // rest — and files dropped while the box is read-only.
    if (e.defaultPrevented) return;
    e.preventDefault();
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
    // the model picker's listener take over. Zero backend round-trip.
    if (/^\/brain(\s|$)/i.test(trimmed)) {
      window.dispatchEvent(
        new CustomEvent("aura:composer:open-brain-picker", {
          detail: trimmed.replace(/^\/brain\s*/i, "").trim(),
        }),
      );
      setText("");
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
    for (const img of snapshot) {
      if (img.kind === "image" && img.preview_url)
        URL.revokeObjectURL(img.preview_url);
    }
    setImages([]);
    const parts: string[] = [];
    if (textBlocks.length > 0) parts.push(textBlocks.join("\n\n"));
    if (expandedText) parts.push(expandedText);
    if (pathTokens.length > 0) parts.push(pathTokens.join(" "));
    // Route the submit. Idle → send now. Busy → steer (redirect the running
    // turn) when ⌘↵ was held OR the follow-up pref is "steer"; otherwise queue
    // it. Each falls back gracefully if the parent didn't wire that handler.
    const wantSteer =
      busy && (opts?.steer === true || followUpBehavior === "steer");
    const dispatch = !busy
      ? onSend
      : wantSteer && onSteer
        ? onSteer
        : (onQueue ?? onSend);
    dispatch(
      parts.join("\n\n"),
      attachments,
      mode,
      null,
      effort,
      fast,
      approval,
      goalMode,
    );
    // Goal is one-shot — arming tags exactly the message you just sent, then
    // disarms so the following turn is an ordinary send unless you re-arm.
    if (goalMode) setGoalMode(false);
  }

  // The `/` and `@` lists: the composer box draws and filters them; this says
  // which rows exist for the token under the caret.
  const caret = textareaRef.current?.selectionStart ?? text.length;
  const { suggestions, resolvePick } = useComposerSuggestions({
    repoRoot,
    before: text.slice(0, caret),
    agentRows: agentCommands,
    terminalAttaches: true,
  });
  // A chat a cloud workspace runs on one of the org's machines also offers
  // its teammates after an `@`, first: a message opening with one is theirs.
  const teammates = useChatTeammates(sessionId);
  function onSuggestionSelect(pick: ComposerSuggestion) {
    // The box has already put the pick in; a task or a folder means more.
    setText((prev) => resolvePick(pick, prev) ?? prev);
  }

  /** Keys the box leaves to its host: Esc stops a streaming turn, ⌘↵ steers
   *  it, and Up/Down at the field's ends walk this conversation's history. */
  function onFieldKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (isInsertSnippetKey(e)) {
      e.preventDefault();
      snippet.trigger();
      return;
    }
    if (e.key === "Escape" && busy && onStop) {
      e.preventDefault();
      onStop();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit({ steer: true });
      return;
    }
    if (
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      const el = e.currentTarget;
      const collapsed = el.selectionStart === el.selectionEnd;
      const atEdge =
        e.key === "ArrowUp" ? el.selectionStart === 0 : el.selectionEnd === el.value.length;
      if (collapsed && atEdge && moveHistory(e.key === "ArrowUp" ? "up" : "down")) {
        e.preventDefault();
      }
    }
  }

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

  // A SECOND, explicit steer control, shown only when steering isn't already
  // the default (when it is, the primary button steers, so this would be
  // redundant). Lets you fold a message into the running turn without changing
  // the setting — the icon the user asked for. Keyboard equivalent is ⌘↵.
  const canSteerNow =
    busy &&
    !!onSteer &&
    followUpBehavior !== "steer" &&
    (text.trim().length > 0 || images.length > 0);
  // Keep the field LIVE while a turn streams, as long as the parent wired a
  // queue or steer handler — the user must be able to type and press Enter
  // to follow up (W2). Only the legacy no-handler case goes read-only.
  const editorBusy = busy && !onQueue && !onSteer;

  // The last mode that wasn't Plan, so leaving plan mode from the box's own
  // Plan control (⇧Tab, its × pill, the add menu) returns to it.
  const lastActModeRef = useRef<ComposerMode>(mode === "plan" ? "build" : mode);
  // The subscription's own reading — its rolling windows — rides in the
  // context meter beside the tokens. Null off-subscription, so the rows hide.
  const claudeUsage = useClaudeUsage();
  const usageDetails: { label: string; value: string }[] = [];
  if (spend) {
    const cost = (usd: number) => `${spend.estimated ? "~" : ""}${formatCost(usd)}`;
    usageDetails.push({ label: "This response", value: cost(spend.costUsd) });
    usageDetails.push({ label: "All repositories", value: cost(spend.spendUsd) });
  }
  if (claudeUsage?.fresh && typeof claudeUsage.five_h_pct === "number")
    usageDetails.push({ label: "5h window", value: `${Math.round(100 - claudeUsage.five_h_pct)}% left` });
  if (claudeUsage?.fresh && typeof claudeUsage.seven_d_pct === "number")
    usageDetails.push({ label: "7d limit", value: `${Math.round(100 - claudeUsage.seven_d_pct)}% left` });
  if (mode !== "plan") lastActModeRef.current = mode;

  // Fast and effort ride inside the model control's panel (`turnControls`):
  // they are per-turn knobs for whichever agent runs the next turn, the same
  // scope as the model, and its chip says what they currently are.
  const followUpPlaceholder =
    busy && (onQueue || onSteer)
      ? followUpBehavior === "steer" && onSteer
        ? "Steer the running turn. ↵ redirects it now"
        : onSteer
          ? "Queue a follow-up. ⌘↵ to steer now"
          : "Queue a follow-up. Sends when the agent finishes"
      : goalMode
        ? "Set a goal"
        : planAwaitingReply
          ? "Enter your plan adjustments here..."
          : (placeholder ?? "Ask to make changes, @mention files, run /commands");

  return (
    // The OS drop router finds this composer by `data-os-drop`; the wrapper
    // draws nothing, so the box is laid out exactly as the shared part is.
    <div
      style={{ display: "contents" }}
      data-os-drop="composer"
      onDragOver={(e) => {
        // The box accepts dragged files itself. In-app path drags — the file
        // tree and agent-terminal links — carry only text/plain or
        // text/uri-list, and without preventDefault the browser refuses them.
        const t = e.dataTransfer.types;
        if (t.includes("Files") || t.includes("text/uri-list") || t.includes("text/plain")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (document.activeElement !== textareaRef.current) textareaRef.current?.focus();
        }
      }}
      onDrop={onDrop}
    >
      <Composer
        className={docked ? "composer-docked" : ""}
        focusShortcut={`${modKeyLabel()}L`}
        value={text}
        onChange={setText}
        onSend={() => void submit()}
        onStop={onStop}
        running={busy}
        // Queue mode while a turn streams and the follow-up waits for it;
        // when follow-ups steer, Enter and the send button redirect the turn.
        mode={busy && onQueue && !(followUpBehavior === "steer" && onSteer) ? "queue" : "send"}
        disabled={editorBusy}
        placeholder={followUpPlaceholder}
        attachments={images.map((img) => ({
          id: img.id,
          name: img.name,
          kind: img.kind === "image" ? "image" : "file",
          previewUrl: img.preview_url || undefined,
        }))}
        onRemoveAttachment={removeImage}
        onAttach={(files) => files.forEach(ingestFile)}
        attachLongPaste
        dragOver={osDragOver}
        suggestions={[...teammates, ...suggestions, ...snippet.rows]}
        onSuggestionSelect={onSuggestionSelect}
        recording={listening}
        onVoiceToggle={toggleListening}
        planMode={mode === "plan"}
        onPlanModeChange={(on) => chooseMode(on ? "plan" : lastActModeRef.current)}
        textareaRef={textareaRef}
        onKeyDown={onFieldKey}
        context={
          agentModeError ? (
            <span role="alert">Could not switch mode: {agentModeError}</span>
          ) : driftedMode ? (
            <span>Agent mode: {driftedMode}</span>
          ) : undefined
        }
        renderAddMenu={(openFiles) => (
          <ComposerAddMenu
            onAttach={openFiles}
            onIssue={issueLink.toggle}
            onWorkspace={repoRoot ? workspaceLinks.toggle : undefined}
            onSnippet={snippet.trigger}
            onPlan={() => chooseMode(mode === "plan" ? lastActModeRef.current : "plan")}
            planMode={mode === "plan"}
          >
            <ComposerTurnMenu
              mode={mode}
              onModeChange={chooseMode}
              modeDisabled={editorBusy}
              approval={{ value: approval, onChange: setApproval }}
              goal={
                onPlanGoal
                  ? { value: goalMode, onChange: setGoalMode, disabled: !repoRoot }
                  : undefined
              }
              concise={{
                value: outputStyle === "concise",
                onChange: (on) => {
                  if (on !== (outputStyle === "concise")) toggleConcise();
                },
              }}
            />
          </ComposerAddMenu>
        )}
        actions={
          <>
            {history}
            {/* How full the model's window is — present once the brain has
                reported usage for this conversation. */}
            {usage && (
              <ContextUsageIndicator
                usage={{
                  used: usage.inputTokens + usage.outputTokens,
                  total: modelOverride?.longContext ? 1_000_000 : 200_000,
                  input: usage.inputTokens,
                  output: usage.outputTokens,
                }}
                details={usageDetails}
              />
            )}
            {canSteerNow && onStop && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Steer now"
                title="Steer. Fold this into the running turn now (⌘↵)"
                onClick={() => void submit({ steer: true })}
              >
                <CornerUpLeft />
              </Button>
            )}
          </>
        }
        footer={
          sessionId && onBrainOverrideChange && onModelOverrideChange ? (
            <ManagerModelPicker
              sessionId={sessionId}
              value={modelOverride}
              onBrainChange={onBrainOverrideChange}
              onModelChange={onModelOverrideChange}
              machine={machineBrain}
              effort={effort}
              fast={fast}
              onEffortChange={setEffort}
              onFastChange={setFast}
              // Stay switchable while a turn streams: brain/model/effort are
              // all per-NEXT-turn knobs (ManagerChatView reads the override
              // live at send), so changing them mid-stream targets the
              // follow-up being queued.
              disabled={editorBusy}
            />
          ) : undefined
        }
      />
      <IssueLinkDialog {...issueLink.dialog} />
      <LinkWorkspacesDialog {...workspaceLinks.dialog} />
      <SnippetPickerDialog {...snippet.picker} />
      <SnippetFormDialog {...snippet.form} />
    </div>
  );
}
