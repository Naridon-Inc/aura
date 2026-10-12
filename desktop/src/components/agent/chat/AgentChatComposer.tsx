import { ComposerFrame, ComposerToolbar, ChatModePicker, promptForChatMode, type ChatMode } from "../../chat/ChatComposer";
import { BrainSwitcherModal } from "../../manager/BrainSwitcherModal";
import { ModelCatalogPopover, agentCatalogBrain, useLiveModelCatalog, useModelFavorites } from "../../chat/ModelCatalogPopover";
import { SquareTerminal } from "lucide-react";
//! The CLI agent's composer, built to the same spec as the Aura brain's.
//!
//! What was here before was a bare `<textarea>` and a send button. The brain's
//! composer, sitting one tab away, has a rich editor with `@file` mentions and
//! slash chips, a model picker, per-session drafts, up-arrow recall of what you
//! sent, and a send cluster that knows the difference between "send", "queue"
//! and "stop". Two composers in one app, one of them a decade behind the other,
//! and the poor one is the one you use when you are driving Gemini or Codex.
//! This closes that.
//!
//! It gets there by mounting the SAME input surface the brain mounts —
//! `TiptapComposer` — which is where mentions, slash chips, paste handling and
//! the keyboard contract actually live, and which never knew anything about the
//! brain in the first place. Draft and recall come from the shared
//! `composerDrafts` rules. So this file is only the parts that genuinely differ
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
//! silently the paste says so and points at the thing that does work.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

import { api } from "../../../lib/api";
import { settleAgentTurn } from "../../../lib/agentEventStore";
import { toast } from "../../../lib/toast";
import { familyOf, type CatalogModel } from "../../../lib/modelCatalog";
import {
  TiptapComposer,
  type SlashItem,
  type TiptapComposerHandle,
} from "../../manager/TiptapComposer";
import { ChipButton } from "../../ui/chip";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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
  type AgentCliCommands,
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
}) {
  const commands = commandsForAgent(agentId);
  const composerRef = useRef<TiptapComposerHandle | null>(null);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<ChatMode>("build");

  const draftKey = composerKey(DRAFT_PREFIX, ptySessionId);
  const histKey = composerKey(HISTORY_PREFIX, ptySessionId);

  // The recall ring, loaded once per session. Held in a ref rather than state
  // because nothing renders from it — it only answers arrow keys.
  const historyRef = useRef<string[]>([]);
  const historyPosRef = useRef(0);
  const liveDraftRef = useRef("");
  // WHETHER there is anything to recall is rendered (the editor only claims
  // ArrowUp when we say there is), so it cannot live in the ref. Reading
  // `historyRef.current.length` during render meant the load below — which
  // mutates a ref and schedules no re-render — never reached the editor: a
  // freshly opened session had recall switched off, and it only came on after
  // some unrelated state change, i.e. after you typed. Which is exactly when
  // you no longer want it.
  const [hasHistory, setHasHistory] = useState(false);
  const latestText = useRef(text);
  latestText.current = text;
  useEffect(() => () => writeDraft(draftKey, latestText.current), [draftKey]);
  const sending = useRef(false);
  useEffect(() => {
    historyRef.current = readHistory(histKey);
    historyPosRef.current = 0;
    setHasHistory(historyRef.current.length > 0);
  }, [histKey]);

  // An interrupt is in flight. Rendered (the button says so and refuses to
  // stack a second attempt on the first) and read from inside the wait loop,
  // which is why it is both.
  const [interrupting, setInterrupting] = useState(false);
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
    composerRef.current?.clear();
    historyRef.current = pushHistory(historyRef.current, body);
    historyPosRef.current = 0;
    writeHistory(histKey, historyRef.current);
    setHasHistory(true);
    writeDraft(draftKey, "");
    const ok = await sendLine(body.startsWith("/") ? body : promptForChatMode(body, mode));
    if (!ok) {
      setText(body);
      composerRef.current?.setMarkdown(body, "end");
    }
    sending.current = false;
    composerRef.current?.focus();
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
    setInterrupting(true);
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
      setInterrupting(false);
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

  // Up/down arrow recall, driven by the editor's own history events. The editor
  // only claims the key when the caret is at the document edge and no popup is
  // open, so ordinary cursor movement is untouched.
  useEffect(() => {
    function onMove(e: Event) {
      const dir = (e as CustomEvent<{ dir: number }>).detail?.dir;
      if (dir == null) return;
      const ring = historyRef.current;
      if (ring.length === 0) return;
      if (dir < 0) {
        // Stepping back. Snapshot the live draft on the first step so coming
        // forward again returns what was actually being written.
        if (historyPosRef.current === 0) liveDraftRef.current = text;
        if (historyPosRef.current >= ring.length) return;
        historyPosRef.current += 1;
        const msg = ring[ring.length - historyPosRef.current];
        setText(msg);
        // Park the caret at the start so a held ArrowUp keeps walking back
        // rather than sticking one message in.
        composerRef.current?.setMarkdown(msg, "start");
        return;
      }
      if (historyPosRef.current === 0) return;
      historyPosRef.current -= 1;
      const msg =
        historyPosRef.current === 0
          ? liveDraftRef.current
          : ring[ring.length - historyPosRef.current];
      setText(msg);
      composerRef.current?.setMarkdown(msg, "end");
    }
    window.addEventListener("aura:composer:history-move", onMove);
    return () => window.removeEventListener("aura:composer:history-move", onMove);
  }, [text]);

  const canSend = text.trim().length > 0;

  // The `/` menu lists THIS CLI's commands. Everything typed here is typed into
  // the child verbatim, so offering the brain's verbs — which only mean
  // something to the app — would make every pick an unknown command.
  const slashRows = useCallback(
    (query: string): SlashItem[] =>
      agentSlashRows(agentId, query).map((r) => ({ ...r, source: "cli" as const })),
    [agentId],
  );

  return (
    <div className="chat-composer">
      <ComposerFrame
        className={docked ? "composer composer-docked" : "composer"}
        onKeyDownCapture={(e) => {
          // Esc is Stop while the agent is working. Captured at the root
          // because the editor stays editable mid-turn (you can queue into a
          // CLI by typing), so its own handler would never see the key.
          if (e.key === "Escape" && running) {
            e.preventDefault();
            e.stopPropagation();
            void stop();
          }
        }}
      >
        <TiptapComposer
          key={ptySessionId}
          ref={composerRef}
          repoRoot={repoRoot}
          initialMarkdown={readDraft(draftKey)}
          // Never read-only: a CLI REPL accepts input mid-turn and that is how
          // you queue a follow-up, so locking the field would remove a real
          // capability the terminal has.
          busy={false}
          placeholder={
            running
              ? "Queue a follow-up. It lands when the agent finishes"
              : "Ask to make changes, @mention files, run /commands"
          }
          onChange={setText}
          onSubmit={() => void send()}
          onEscapeWhileBusy={() => void stop()}
          onImageFiles={() => {
            // A PTY has no attachment channel — this agent reads pictures off
            // disk. Say so rather than swallow the paste.
            toast.info(
              "Save the image, then drag the file in",
              "A terminal agent reads pictures from disk, so it needs a path rather than pasted bytes.",
            );
          }}
          canRecallHistory={hasHistory}
          slashRows={slashRows}
        />

        <ComposerToolbar mode={<ChatModePicker value={mode} onChange={setMode} modes={["build", "plan", "ask"]} />} model={<>{commands?.model && (
            <AgentModelChip
              agentId={agentId}
              commands={commands}
              onSend={sendLine}
              onSwitchToTerminal={onSwitchToTerminal}
            />
          )}</>} options={<><AgentCommandChip
            agentId={agentId}
            onSend={sendLine}
            onCompose={(line) => {
              // A command that takes arguments must not fire bare — put it in
              // the field with the caret after it so the user finishes the line.
              setText(line);
              composerRef.current?.setMarkdown(line, "end");
              composerRef.current?.focus();
            }}
          /></>} actions={<div className="right justify-end" style={{ minWidth: 96 }}>
            {running ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="font-mono"
                disabled={interrupting}
                aria-label="Stop response"
              onClick={() => void stop()}
                title={
                  interrupting
                    ? "Waiting for the agent to stop"
                    : "Interrupt the running turn (Esc)"
                }
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <rect width="10" height="10" rx="2" fill="currentColor" />
                </svg>
                <span className="send-kbd">{interrupting ? "…" : "Esc"}</span>
              </Button>
            ) : null}
            <Button
              type="button"
              variant={running ? "subtle" : "default"}
              size="sm"
              className={running ? "font-mono text-accent" : "font-mono"}
              aria-label="Send message"
              disabled={!canSend}
              onClick={() => void send()}
              title={running ? "Queue this (↵)" : "Send (↵)"}
            >
              {/* The brain's send button draws this arrow from the chat icon
                  sprite, but that sprite is mounted by ManagerSurface and this
                  composer lives in the agent pane — a `<use href="#i-arrow-up">`
                  here would resolve to nothing whenever the brain panel is
                  closed, i.e. a send button with no glyph on it. Lucide's
                  ArrowUp is the same path the sprite copied, so drawing it
                  directly is pixel-identical and depends on nothing outside
                  this file. */}
              <ArrowUp className="ico-12" strokeWidth={2} aria-hidden />
              <span className="send-kbd">⏎</span>
            </Button>
          </div>} />
      </ComposerFrame>
    </div>
  );
}

// ── Model switching, scoped to this agent's own provider ───────────────────

/** The model chip.
 *
 *  Two shapes, because the CLIs genuinely differ (see `agentCliCommands`). When
 *  the CLI takes an id inline we show its provider's real model list and
 *  selecting a row types the switch. When the CLI only opens its own chooser we
 *  show one button that opens it and moves the user to the terminal where that
 *  chooser is drawn — listing models we couldn't actually select would be a
 *  menu that lies. */
function AgentModelChip({
  agentId,
  commands,
  onSend,
  onSwitchToTerminal,
}: {
  agentId: string;
  commands: AgentCliCommands;
  onSend: (line: string) => Promise<boolean>;
  onSwitchToTerminal?: () => void;
}) {
  const model = commands.model;
  // The last row picked here, so the chip can name what it put the agent on.
  // Deliberately NOT presented as "the model the agent is running": the user
  // can also change it by typing in the terminal, and this pane would have no
  // way to know. It is a record of what we sent, and the label says so.
  const [sent, setSent] = useState<CatalogModel | null>(null);
  const [open, setOpen] = useState(false);
  // The same catalog the native picker reads, so a model that appears for the
  // Aura brain appears here too. Only the inline case has a list to draw.
  const live = useLiveModelCatalog(model?.kind === "inline");
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const brain = useMemo(() => agentCatalogBrain(agentId), [agentId]);
  const { favorites, toggleFavorite, reorderFavorites } = useModelFavorites();
  if (!model) return null;
  if (model.kind === "picker")
    // A chevron on this button was a lie with a cursor on it. Every other chip
    // in this strip opens a menu under itself; this one types `/model` into the
    // session and moves you to the Terminal tab, because the chooser is drawn
    // by the CLI and lives there. Same click, same reason — it just stops
    // claiming to be a dropdown and says where it goes instead.
    return (
      <button
        type="button"
        className="composer-selector composer-model-selector"
        onClick={() => {
          void onSend(model.line).then((ok) => {
            if (ok) onSwitchToTerminal?.();
          });
        }}
        title={`${brain.label} draws its own model chooser — this types ${model.line} and takes you to the terminal to use it`}
      >
        <SquareTerminal size={12} />
        <span>{model.label}</span>
      </button>
    );
  return (
    <ModelCatalogPopover
      label={sent?.label ?? "Agent default"}
      open={open}
      onOpenChange={setOpen}
    >
      <BrainSwitcherModal
        embedded
        allowDefault={false}
        brains={[brain]}
        liveCatalog={live}
        value={
          sent
            ? {
                brainId: brain.id,
                family: familyOf(brain),
                modelId: sent.id,
                label: sent.label,
                longContext: !!sent.longContext,
              }
            : null
        }
        favorites={favorites}
        activeChoice={brain}
        loading={switching}
        loadError={error}
        onPick={async (_brain, row) => {
          if (!row.id || switching) return;
          setSwitching(true);
          setError(null);
          try {
            if (await onSend(model.line(row.id))) {
              setSent(row);
              setOpen(false);
            } else setError("The model did not change. Try again.");
          } finally {
            setSwitching(false);
          }
        }}
        onPickAuto={() => {}}
        onToggleFav={toggleFavorite}
        onReorderFav={reorderFavorites}
        onClose={() => setOpen(false)}
      />
    </ModelCatalogPopover>
  );
}

/** Every command this CLI ships, as a menu.
 *
 *  Not a shortlist. The `/` popup already offers the same set as you type, but
 *  a chip that says "Commands" and then shows four of a hundred teaches exactly
 *  the wrong thing — that the chat is the reduced surface and the terminal is
 *  where the real controls live. It shows what the CLI shows, and if that is
 *  long it scrolls, the way any long menu does.
 *
 *  A row with arguments does NOT fire. `/model set <model>` sent bare would run
 *  the parent command and the user would never see why; instead the line lands
 *  in the composer with the caret after it, ready to finish. Rows without
 *  arguments are complete commands and go straight to the agent. */
function AgentCommandChip({
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ChipButton title={`Run one of ${agentId}'s own commands`}>
          <span className="chip-label">Commands</span>
        </ChipButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        // Long menus scroll inside themselves. `min-w-0` on the label lets the
        // summary truncate rather than widen the popup off the edge of the pane.
        className="min-w-[280px] max-w-[420px] max-h-[340px] overflow-y-auto"
      >
        {rows.map((r) => (
          <DropdownMenuItem
            key={r.name}
            onSelect={() => {
              const line = `/${r.name}`;
              if (r.args) onCompose(`${line} `);
              else void onSend(line);
            }}
          >
            <span className="font-mono text-xs whitespace-nowrap">
              /{r.name}
              {r.args ? <span className="text-text-4"> {r.args}</span> : null}
            </span>
            <span className="flex-1 min-w-0 truncate text-xs text-text-3">
              {r.summary}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
