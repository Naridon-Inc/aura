//! The CLI agent's composer, built to the same spec as the Aura brain's.
//!
//! What was here before was a bare text field and a send button. The brain's
//! composer, sitting one tab away, has `@file` mentions and `/` commands, a
//! model picker, per-session drafts, up-arrow recall of what you sent, and a
//! send cluster that knows the difference between "send", "queue" and "stop".
//! Two composers in one app, one of them a decade behind the other, and the
//! poor one is the one you use when you are driving Gemini or Codex. This
//! closes that.
//!
//! It gets there by mounting the SAME composer box the brain mounts — the
//! shared `Composer` — with the same `/` and `@` lists
//! (`useComposerSuggestions`), and which never knew anything about the brain in
//! the first place. Draft and recall come from the shared `composerDrafts`
//! rules. So this file is only the parts that genuinely differ
//! for a CLI agent, and there is one real difference: nothing here is a request
//! field. Everything is text typed into a live REPL.
//!
//! That single fact decides the shape of every control:
//!
//!   - **Send** is `agent_pty_send_prompt`, the same bracketed-paste path the
//!     terminal uses. There is no "queue" API to call because the CLI's own
//!     input queue IS the queue — typing mid-turn is exactly what queuing is.
//!   - **Stop** is an Escape byte, which is how every one of these TUIs
//!     interrupts a running turn. Not Ctrl-C: that quits the whole REPL and
//!     would take the conversation with it.
//!   - **Model** writes that CLI's own `/model` line (see `agentCliCommands`),
//!     scoped to the models its provider can actually run, because a model id
//!     from another vendor typed into it is just an error message.
//!
//! Anything we cannot do honestly over a PTY is absent rather than decorative.
//! The clearest case is image attachment: the brain base64s an image into the
//! request, and a PTY has no such channel — a CLI agent reads pictures off
//! disk by path. A pasted screenshot has no path, so instead of dropping it
//! silently the paste says so and points at the thing that does work. A file
//! picked from the add menu does have one, so that path is what gets written.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { SquareSlash } from "lucide-react";

import { api } from "../../../lib/api";
import { readClipboardText } from "../../../lib/clipboard";
import { isEditableTarget } from "../../../lib/keymap";
import { settleAgentTurn } from "../../../lib/agentEventStore";
import { toast } from "../../../lib/toast";
import { pickPath } from "../../../lib/nativeDialog";
import { useComposerSuggestions, type SlashItem } from "../../chat/composer/useComposerSuggestions";
import { promptForChatMode, type ChatMode } from "../../chat/composer/chatMode";
import { useComposerCollapse } from "../../chat/composerCollapse";
import { AgentCliModelPicker } from "../../chat/model/AgentModelPickers";
import { ComposerTurnMenu } from "../../chat/composer/ComposerTurnMenu";
import { Composer, type ComposerSuggestion } from "../../ui/composer";
import "../../chat/ChatComposer.css";
import "../../ui/chat-composer.css";
import { ComposerAddMenu } from "../../ui/composer-tools";
import { TimelineMenuItems, TimelineViewSwitch } from "../normalized/timelineTools";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../../ui/dropdown-menu";

import {
  composerKey,
  pushHistory,
  readDraft,
  readHistory,
  writeDraft,
  writeHistory,
} from "../../composer/composerDrafts";
import {
  agentSlashRows,
  commandsForAgent,
} from "./agentCliCommands";

const DRAFT_PREFIX = "aura.agentchat.draft:";
const HISTORY_PREFIX = "aura.agentchat.history:";

/** ESC. Most agent TUIs treat it as "interrupt the current turn" and leave the
 *  session alive — which is what a Stop button must mean. "Most" is the
 *  problem: every one of these CLIs binds its own keys, several let the user
 *  rebind them, and a TUI that isn't listening for ESC swallows it in silence.
 *  So the button sends ESC and then checks. */
const ESC_BYTE = 0x1b;

/** How many times the button presses Escape before it gives up. Two, for the
 *  same reason a person presses it twice: several of these TUIs only act on the
 *  second one (the first closes a popup, dismisses a hint, leaves a mode), and
 *  a repeated Escape is safe in every one of them. What the button will NOT do
 *  is escalate to Ctrl-C on its own — that byte quits some of these CLIs
 *  outright, and a Stop button that sometimes ends the whole conversation is a
 *  worse bug than the one it fixes. When Escape is ignored, say so. */
const INTERRUPT_ATTEMPTS = 2;

/** How long to wait for the agent to actually go quiet after an interrupt
 *  before deciding it was ignored. A file-backed engine's busy flag settles on
 *  its own poll cadence (~3s of silence), so the window has to clear that or a
 *  stopped agent would be reported as still running. */
const INTERRUPT_SETTLE_MS = 4500;
const INTERRUPT_POLL_MS = 150;

/** After an Escape, how long the terminal must draw nothing before the turn
 *  counts as stopped. Measured on Claude Code 2.1 in a PTY: mid-turn — through
 *  a 14s shell command, with the terminal unfocused — it never went more than
 *  2.1s without drawing, and after an Escape it stopped drawing within 0.3s.
 *  So this much silence is a stop, not a pause, and still well inside the
 *  4.5s the button waits. */
const INTERRUPT_QUIET_MS = 2500;

export function AgentChatComposer({
  agentId,
  ptySessionId,
  repoRoot,
  running,
  onSwitchToTerminal,
  docked = false,
  overlay = false,
}: {
  agentId: string;
  /** The live PTY child every control here writes into. */
  ptySessionId: string;
  repoRoot: string;
  /** True while the agent is mid-turn, per the stream store. */
  running: boolean;
  /** Jump to the raw Terminal view. Used by the controls that hand off to the
   *  CLI's own interactive chooser, since that chooser is drawn in the
   *  terminal and pretending otherwise would strand the user. */
  onSwitchToTerminal?: () => void;
  /** A question card sits directly above: fuse onto it as one panel. */
  docked?: boolean;
  /** The pane is showing the terminal, not the conversation, so this composer
   *  is floating over it rather than sitting under a transcript. It collapses
   *  to a strip while empty and declares itself over the native surface while
   *  open — see `composerCollapse` and `composerOverlay`. */
  overlay?: boolean;
}) {
  const commands = commandsForAgent(agentId);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const draftKey = composerKey(DRAFT_PREFIX, ptySessionId);
  const histKey = composerKey(HISTORY_PREFIX, ptySessionId);
  const [text, setText] = useState(() => readDraft(draftKey));
  const [mode, setMode] = useState<ChatMode>("build");

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
  /** Add to the end of the draft, a space after what is already there. */
  const appendText = useCallback((add: string) => {
    setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")} ${add}` : add));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // The recall ring, loaded once per session. Held in a ref rather than state
  // because nothing renders from it — it only answers arrow keys.
  const historyRef = useRef<string[]>([]);
  const historyPosRef = useRef(0);
  const liveDraftRef = useRef("");
  const latestText = useRef(text);
  latestText.current = text;
  useEffect(() => () => writeDraft(draftKey, latestText.current), [draftKey]);
  // A different session: its own draft, its own ring.
  useEffect(() => {
    setText(readDraft(draftKey));
  }, [draftKey]);
  const sending = useRef(false);
  useEffect(() => {
    historyRef.current = readHistory(histKey);
    historyPosRef.current = 0;
  }, [histKey]);

  // An interrupt is in flight: a second Stop press must not stack a second
  // attempt on the first.
  const interruptingRef = useRef(false);

  // `running` as the wait loop needs it: the current value, not the one the
  // closure captured when Stop was clicked.
  const runningRef = useRef(running);
  runningRef.current = running;

  // The wait loop outlives the component if the tab closes mid-interrupt.
  // Resolving "quiet" on unmount is the honest answer: this surface can no
  // longer observe the agent, so it must not claim the agent ignored us.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Persist the draft as it is typed, debounced so a fast typist isn't writing
  // to localStorage on every keystroke. Same 400ms the brain's composer uses.
  useEffect(() => {
    const t = window.setTimeout(() => writeDraft(draftKey, text), 400);
    return () => window.clearTimeout(t);
  }, [draftKey, text]);

  /** Put a literal line into the agent, as if it had been typed. Every control
   *  in this file funnels through here so there is exactly one place that can
   *  fail and exactly one place that reports it. */
  async function sendLine(line: string): Promise<boolean> {
    try {
      await api.agentPtySendPrompt(ptySessionId, line);
      return true;
    } catch (e) {
      toast.danger("That didn't reach the agent", String(e));
      return false;
    }
  }

  async function send() {
    const body = text.trim();
    if (!body || sending.current) return;
    sending.current = true;
    // Optimistic clear, restored on failure — losing what someone typed to a
    // silent error is the one outcome worth extra code to avoid.
    setText("");
    historyRef.current = pushHistory(historyRef.current, body);
    historyPosRef.current = 0;
    writeHistory(histKey, historyRef.current);
    writeDraft(draftKey, "");
    const ok = await sendLine(body.startsWith("/") ? body : promptForChatMode(body, mode));
    sending.current = false;
    if (!ok) placeText(body, "end");
    else textareaRef.current?.focus();
  }

  /** Put files (or a folder) in front of the agent the way a CLI reads them:
   *  by path. There is no upload channel to a terminal agent, so the add menu
   *  writes the absolute path into the draft, quoted when it has a space —
   *  the same text a file dropped on the terminal types. */
  async function attachPaths(directory: boolean) {
    let picked: string | string[] | null;
    try {
      picked = await pickPath({
        directory,
        multiple: !directory,
        title: directory ? "Add a folder for the agent" : "Add files for the agent",
      });
    } catch (e) {
      toast.danger("Couldn't open the file picker", String(e));
      return;
    }
    const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter(Boolean);
    if (paths.length === 0) return;
    appendText(paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" "));
  }

  /** Interrupt the running turn, and confirm it actually stopped.
   *
   *  The old version wrote one Escape and treated the write landing in the PTY
   *  as success — which says the byte was delivered, not that the agent obeyed
   *  it. Every one of these CLIs binds its own keys and several let the user
   *  rebind them, so a TUI that isn't listening swallows Escape in silence: the
   *  button looked like it worked while the agent kept going. That is exactly
   *  what "I clicked stop and it didn't stop" means.
   *
   *  So press Escape, watch whether the agent actually goes quiet, press once
   *  more, watch again — and if it is still producing output after that, say so
   *  and hand over the two controls that genuinely end it. Reporting the
   *  failure is the fix; pretending is the bug. */
  async function stop() {
    if (interruptingRef.current) return;
    interruptingRef.current = true;
    try {
      for (let i = 0; i < INTERRUPT_ATTEMPTS; i++) {
        await api.agentPtyWrite(ptySessionId, [ESC_BYTE]);
        if (await wentQuiet()) return;
      }
      toast.danger(
        "The agent ignored Escape and is still working",
        "This CLI isn’t taking Escape as an interrupt. Its own terminal will have a key that works — or end the agent outright with “Stop session” on the tab.",
        {
          actions: onSwitchToTerminal
            ? [{ label: "Open the terminal", onClick: onSwitchToTerminal }]
            : undefined,
        },
      );
    } catch (e) {
      toast.danger("Couldn't interrupt the agent", String(e));
    } finally {
      interruptingRef.current = false;
    }
  }

  /** Resolve true once the agent stops producing — false if it is still going
   *  when the window runs out. Reads the busy flag through a ref because the
   *  prop this closure captured is from the render that started the wait. */
  function wentQuiet(): Promise<boolean> {
    const deadline = Date.now() + INTERRUPT_SETTLE_MS;
    return new Promise((resolve) => {
      const tick = async () => {
        if (!mountedRef.current) return resolve(true);
        if (!runningRef.current) return resolve(true);
        // A terminal agent's busy flag comes from its hooks, and no hook
        // reports an interrupt — Claude runs no Stop hook for one. So ask the
        // terminal: a TUI that has stopped drawing has stopped working, and
        // the turn it left open is closed here rather than by the slower
        // background watch.
        const pty = await api
          .agentPtyIdleStatus(ptySessionId)
          .catch(() => null);
        if (pty && (!pty.alive || pty.idle_ms >= INTERRUPT_QUIET_MS)) {
          settleAgentTurn(ptySessionId);
          return resolve(true);
        }
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(() => void tick(), INTERRUPT_POLL_MS);
      };
      void tick();
    });
  }

  /** Up/down recall: a plain arrow with the caret at the very start (Up) or
   *  end (Down) of the field walks what was sent in this session, so ordinary
   *  caret movement through a multi-line draft is untouched. Returns whether
   *  the key was used. */
  function moveHistory(up: boolean): boolean {
    const ring = historyRef.current;
    if (ring.length === 0) return false;
    if (up) {
      // Stepping back. Snapshot the live draft on the first step so coming
      // forward again returns what was actually being written.
      if (historyPosRef.current === 0) liveDraftRef.current = text;
      if (historyPosRef.current >= ring.length) return true;
      historyPosRef.current += 1;
      // Caret at the start so a held ArrowUp keeps walking back rather than
      // sticking one message in.
      placeText(ring[ring.length - historyPosRef.current], "start");
      return true;
    }
    if (historyPosRef.current === 0) return false;
    historyPosRef.current -= 1;
    placeText(
      historyPosRef.current === 0
        ? liveDraftRef.current
        : ring[ring.length - historyPosRef.current],
      "end",
    );
    return true;
  }

  const canSend = text.trim().length > 0;

  // Over the terminal this composer is an overlay on something being read, so
  // it folds to a strip until there is a reason to be a box. `docked` is one
  // such reason: a question card above it is waiting on an answer that can
  // only be typed here.
  const collapse = useComposerCollapse({
    overlaying: overlay,
    empty: !canSend,
    blocked: docked,
    field: textareaRef,
  });

  // The `/` list offers THIS CLI's commands. Everything typed here is typed
  // into the child verbatim, so offering the brain's verbs — which only mean
  // something to the app — would make every pick an unknown command.
  const slashRows = useCallback(
    (query: string): SlashItem[] =>
      agentSlashRows(agentId, query).map((r) => ({ ...r, source: "cli" as const })),
    [agentId],
  );
  const caret = textareaRef.current?.selectionStart ?? text.length;
  const { suggestions, resolvePick } = useComposerSuggestions({
    repoRoot,
    before: text.slice(0, caret),
    slashRows,
  });

  // ⌘V pressed anywhere in this conversation, with focus outside a text
  // field, lands in the composer.
  //
  // After clicking in the transcript, focus sits on a non-editable element,
  // and WebKit will not service `paste:` for one — nothing claimed the
  // keystroke and AppKit rang the error bell, which read as "paste is
  // broken". Bound to this conversation's own `.aura-chat` so a split showing
  // two of them each rescues its own, and so a ⌘V in some other pane is none
  // of our business.
  useEffect(() => {
    const host = rootRef.current?.closest(".aura-chat");
    if (!host) return;
    const onKeyDown = (ev: Event) => {
      const e = ev as globalThis.KeyboardEvent;
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() !== "v") return;
      // A real field is pasting into itself; leave it be.
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      void readClipboardText().then((pasted) => {
        if (pasted) appendText(pasted);
      });
    };
    host.addEventListener("keydown", onKeyDown);
    return () => host.removeEventListener("keydown", onKeyDown);
  }, [appendText]);

  /** Keys the box leaves to its host. */
  function onFieldKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Esc is Stop while the agent is working. The field stays editable
    // mid-turn (you queue into a CLI by typing), so this is where it lands.
    if (e.key === "Escape" && running) {
      e.preventDefault();
      void stop();
      return;
    }
    // Opened over the terminal and thought better of it. Dropping focus is
    // what folds it back — there is no "close" to call, because the collapse
    // is a reading of state rather than a thing you toggle. Only when the box
    // is empty: Escape must not hide a draft.
    if (e.key === "Escape" && overlay && !canSend) {
      e.preventDefault();
      e.currentTarget.blur();
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
      if (collapsed && atEdge && moveHistory(e.key === "ArrowUp")) e.preventDefault();
    }
  }

  return (
    <div
      className="agent-chat-composer"
      ref={rootRef}
      {...collapse.handlers}
      onKeyDownCapture={(e) => {
        // ⌘U opens the native file picker, as the add menu says it does: a
        // terminal agent needs a path, which the browser's picker never gives.
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "u") {
          e.preventDefault();
          e.stopPropagation();
          void attachPaths(false);
        }
      }}
    >
      <Composer
        className={docked ? "composer-docked" : ""}
        minimized={collapse.minimized}
        animateResize={collapse.animate}
        value={text}
        onChange={setText}
        onSend={() => void send()}
        onStop={() => void stop()}
        running={running}
        // Mid-turn this is Queue, not Send: the CLI's own input queue takes
        // the line and runs it when the current turn ends. Never read-only.
        mode={running ? "queue" : "send"}
        placeholder={
          running
            ? "Queue a follow-up. It lands when the agent finishes"
            : "Ask to make changes, @mention files, run /commands"
        }
        // A PTY has no attachment channel — this agent reads pictures off
        // disk. Say so rather than swallow a pasted or dropped file.
        onAttach={() =>
          toast.info(
            "Save the image, then drag the file in",
            "A terminal agent reads pictures from disk, so it needs a path rather than pasted bytes.",
          )
        }
        suggestions={suggestions}
        onSuggestionSelect={(pick: ComposerSuggestion) =>
          setText((prev) => resolvePick(pick, prev) ?? prev)
        }
        planMode={mode === "plan"}
        onPlanModeChange={(on) => setMode(on ? "plan" : "build")}
        textareaRef={textareaRef}
        onKeyDown={onFieldKey}
        renderAddMenu={() => (
          <ComposerAddMenu
            onAttach={() => void attachPaths(false)}
            onDirectory={() => void attachPaths(true)}
            onPlan={() => setMode(mode === "plan" ? "build" : "plan")}
            planMode={mode === "plan"}
          >
            <ComposerTurnMenu mode={mode} modes={["build", "plan", "ask"]} onModeChange={setMode} />
            <AgentCommandsMenu
              agentId={agentId}
              onSend={sendLine}
              onCompose={(line) => placeText(line, "end")}
            />
            <TimelineMenuItems />
          </ComposerAddMenu>
        )}
        footer={
          <>
            {commands?.model && (
              <AgentCliModelPicker
                agentId={agentId}
                commands={commands}
                onSend={sendLine}
                onSwitchToTerminal={onSwitchToTerminal}
              />
            )}
            <TimelineViewSwitch />
          </>
        }
      />
    </div>
  );
}

/** Every command this CLI ships, as a submenu of the add menu.
 *
 *  Not a shortlist. The `/` list already offers the same set as you type, but
 *  a "Commands" row that shows four of a hundred teaches exactly the wrong
 *  thing — that the chat is the reduced surface and the terminal is where the
 *  real controls live. It shows what the CLI shows, and if that is long it
 *  scrolls, the way any long menu does.
 *
 *  A row with arguments does NOT fire. `/model set <model>` sent bare would run
 *  the parent command and the user would never see why; instead the line lands
 *  in the composer with the caret after it, ready to finish. Rows without
 *  arguments are complete commands and go straight to the agent. */
function AgentCommandsMenu({
  agentId,
  onSend,
  onCompose,
}: {
  agentId: string;
  onSend: (line: string) => Promise<boolean>;
  onCompose: (line: string) => void;
}) {
  const rows = useMemo(() => agentSlashRows(agentId, ""), [agentId]);
  if (rows.length === 0) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <SquareSlash />
          Commands <span className="ui-menu-value">{rows.length}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent sideOffset={6} className="max-h-[340px] max-w-[420px] overflow-y-auto">
          {rows.map((r) => (
            <DropdownMenuItem
              key={r.name}
              title={r.summary}
              onSelect={() => {
                const line = `/${r.name}`;
                if (r.args) onCompose(`${line} `);
                else void onSend(line);
              }}
            >
              <span className="shrink-0">
                /{r.name}
                {r.args ? ` ${r.args}` : ""}
              </span>
              {r.summary && (
                <span className="ui-menu-value flex-1 min-w-0 truncate">{r.summary}</span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}
