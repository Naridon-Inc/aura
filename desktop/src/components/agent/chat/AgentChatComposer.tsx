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
import type { BrainChoice, ModelCatalog } from "../../../lib/api";
import { toast } from "../../../lib/toast";
import { catalogFor, type CatalogModel } from "../../../lib/modelCatalog";
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
import { AgentIcon } from "../AgentIcon";
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

/** ESC. Every agent TUI we ship treats it as "interrupt the current turn" and
 *  leaves the session alive — which is what a Stop button must mean. */
const ESC_BYTE = 0x1b;

export function AgentChatComposer({
  agentId,
  ptySessionId,
  repoRoot,
  running,
  onSwitchToTerminal,
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
}) {
  const commands = commandsForAgent(agentId);
  const composerRef = useRef<TiptapComposerHandle | null>(null);
  const [text, setText] = useState("");

  const draftKey = composerKey(DRAFT_PREFIX, ptySessionId);
  const histKey = composerKey(HISTORY_PREFIX, ptySessionId);

  // The recall ring, loaded once per session. Held in a ref rather than state
  // because nothing renders from it — it only answers arrow keys.
  const historyRef = useRef<string[]>([]);
  const historyPosRef = useRef(0);
  const liveDraftRef = useRef("");
  useEffect(() => {
    historyRef.current = readHistory(histKey);
    historyPosRef.current = 0;
  }, [histKey]);

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
    if (!body) return;
    // Optimistic clear, restored on failure — losing what someone typed to a
    // silent error is the one outcome worth extra code to avoid.
    setText("");
    composerRef.current?.clear();
    historyRef.current = pushHistory(historyRef.current, body);
    historyPosRef.current = 0;
    writeHistory(histKey, historyRef.current);
    writeDraft(draftKey, "");
    const ok = await sendLine(body);
    if (!ok) {
      setText(body);
      composerRef.current?.setMarkdown(body, "end");
    }
    composerRef.current?.focus();
  }

  /** Interrupt the running turn. */
  function stop() {
    api.agentPtyWrite(ptySessionId, [ESC_BYTE]).catch((e) => {
      toast.danger("Couldn't interrupt the agent", String(e));
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
    <div className="p-dock">
      <div
        className="composer"
        onKeyDownCapture={(e) => {
          // Esc is Stop while the agent is working. Captured at the root
          // because the editor stays editable mid-turn (you can queue into a
          // CLI by typing), so its own handler would never see the key.
          if (e.key === "Escape" && running) {
            e.preventDefault();
            e.stopPropagation();
            stop();
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
              : "Message the agent. @ for files, / for its commands"
          }
          onChange={setText}
          onSubmit={() => void send()}
          onEscapeWhileBusy={stop}
          onImageFiles={() => {
            // A PTY has no attachment channel — this agent reads pictures off
            // disk. Say so rather than swallow the paste.
            toast.info(
              "Save the image, then drag the file in",
              "A terminal agent reads pictures from disk, so it needs a path rather than pasted bytes.",
            );
          }}
          canRecallHistory={historyRef.current.length > 0}
          slashRows={slashRows}
        />

        <div className="composer-bottom">
          {commands?.model && (
            <AgentModelChip
              agentId={agentId}
              commands={commands}
              onSend={sendLine}
              onSwitchToTerminal={onSwitchToTerminal}
            />
          )}
          <AgentCommandChip
            agentId={agentId}
            onSend={sendLine}
            onCompose={(line) => {
              // A command that takes arguments must not fire bare — put it in
              // the field with the caret after it so the user finishes the line.
              setText(line);
              composerRef.current?.setMarkdown(line, "end");
              composerRef.current?.focus();
            }}
          />

          <div className="right justify-end" style={{ minWidth: 96 }}>
            {running ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="font-mono"
                onClick={stop}
                title="Interrupt the running turn (Esc)"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <rect width="10" height="10" rx="2" fill="currentColor" />
                </svg>
                <span className="send-kbd">Esc</span>
              </Button>
            ) : null}
            <Button
              type="button"
              variant={running ? "subtle" : "default"}
              size="sm"
              className={running ? "font-mono text-accent" : "font-mono"}
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
          </div>
        </div>
      </div>
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
  const [live, setLive] = useState<ModelCatalog | null>(null);

  // The same catalog the native picker reads, so a model that appears for the
  // Aura brain appears here too. Only fetched for the inline case, which is
  // the only one with a list to draw.
  useEffect(() => {
    if (model?.kind !== "inline") return;
    let cancelled = false;
    api
      .agentModelsList()
      .then((cat) => {
        if (!cancelled) setLive(cat);
      })
      .catch(() => {
        // Offline or the provider is down — `catalogFor` falls back to the
        // curated static rows, which is why this is safe to swallow.
      });
    return () => {
      cancelled = true;
    };
  }, [model?.kind]);

  // Provider scoping happens here and nowhere else: describe this CLI as the
  // `cli_wrapper` brain it is, so `familyOf` resolves it to the right vendor,
  // then ask the shared catalog for that one family. A Gemini session therefore
  // lists Gemini models and only Gemini models — the rest of the catalog is not
  // filtered out for tidiness, it is unreachable, because those ids mean
  // nothing to this binary.
  const rows = useMemo<CatalogModel[]>(() => {
    if (model?.kind !== "inline") return [];
    const brain: BrainChoice = {
      id: `cli_wrapper:${agentId}`,
      label: agentId,
      kind: "cli_wrapper",
      active: true,
      // A CLI authenticates out-of-band (its own login), which is exactly what
      // these two flags mean for every other cli_wrapper brain.
      requires_api_key: false,
      has_api_key: true,
    };
    return catalogFor(brain, live);
  }, [agentId, model?.kind, live]);

  if (!model) return null;

  if (model.kind === "picker") {
    return (
      <ChipButton
        chevron={false}
        title={`Open ${agentId}'s own model chooser in the terminal`}
        onClick={() => {
          void onSend(model.line).then((ok) => {
            if (ok) onSwitchToTerminal?.();
          });
        }}
      >
        <AgentIcon agentId={agentId} size={12} />
        <span className="chip-label">{model.label}</span>
      </ChipButton>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ChipButton
          active={!!sent}
          title={`Switch the model this ${agentId} session runs`}
        >
          <AgentIcon agentId={sent?.brand ?? agentId} size={12} />
          <span className="chip-label">{sent ? sent.label : "Model"}</span>
        </ChipButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        {rows.map((row) => (
          <DropdownMenuItem
            key={row.key}
            // A row with no wire id ("Default") has nothing to type, so it
            // can't switch anything — leave it unselectable rather than send a
            // malformed line.
            disabled={!row.id}
            onSelect={() => {
              if (!row.id) return;
              void onSend(model.line(row.id)).then((ok) => {
                if (ok) setSent(row);
              });
            }}
          >
            <AgentIcon agentId={row.brand ?? agentId} size={14} />
            <span className="flex-1">{row.label}</span>
            {row.isNew && <span className="text-xs text-accent">NEW</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
